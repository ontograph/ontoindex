import fs from 'fs/promises';
import path from 'path';
import { resolveSymbolCandidates } from './backend-symbol-resolution.js';
import { getOverlaySnapshot, isDirtyPath } from './backend-overlay.js';
import { resolveContainedRealPath } from './path-util.js';

interface MoveSymbolRepoHandle {
  id: string;
  repoPath: string;
  storagePath?: string;
}

interface MoveSymbolDryRunResult {
  success: true;
  dry_run: true;
  uid: string;
  from: string;
  to: string;
  warnings?: string[];
}

interface MoveSymbolApplyResult {
  success: true;
  uid: string;
  from: string;
  to: string;
  movedLines: number;
}

type MoveSymbolResult = MoveSymbolDryRunResult | MoveSymbolApplyResult;

/** Never apply base-graph line ranges to live, dirty source files. */
export async function guardMutationRange(
  repo: MoveSymbolRepoHandle,
  symbol: { filePath: string; source?: 'overlay' },
  dryRun: boolean,
): Promise<string[] | undefined> {
  if (!repo.repoPath || !repo.storagePath || symbol.source === 'overlay') return undefined;
  const snapshot = await getOverlaySnapshot({
    id: repo.id,
    repoPath: repo.repoPath,
    storagePath: repo.storagePath,
  });
  const filePath = path.isAbsolute(symbol.filePath)
    ? path.relative(repo.repoPath, symbol.filePath)
    : symbol.filePath;
  if (!isDirtyPath(snapshot, filePath)) return undefined;
  const warning = `Dirty file ${symbol.filePath}: the symbol line range may be stale. Commit/stash changes or run ontoindex analyze and retry.`;
  if (!dryRun) throw new Error(warning);
  return [warning];
}

function isEnoentError(error: unknown): error is { code: 'ENOENT' } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export async function moveSymbol(
  repo: MoveSymbolRepoHandle,
  params: {
    uid: string;
    target_file: string;
    dry_run?: boolean;
    confirm?: boolean;
  },
): Promise<MoveSymbolResult> {
  const { uid, target_file } = params;
  const dry_run = params.dry_run !== false;

  const outcome = await resolveSymbolCandidates(repo, { uid, include_content: true }, {});
  if (outcome.kind !== 'ok') {
    throw new Error(`Symbol not found: ${uid}`);
  }

  const { filePath, startLine, endLine } = outcome.symbol;
  const warnings = await guardMutationRange(repo, outcome.symbol, dry_run);

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      uid,
      from: filePath,
      to: target_file,
      ...(warnings ? { warnings } : {}),
    };
  }

  if (!params.confirm) {
    throw new Error('Explicit confirmation required (set confirm: true)');
  }

  const [sourceAbsolute, targetAbsolute] = await Promise.all([
    resolveContainedRealPath(repo.repoPath, filePath),
    resolveContainedRealPath(repo.repoPath, target_file),
  ]);

  // Read source, remove symbol lines (startLine..endLine inclusive, 1-indexed)
  const source = await fs.readFile(sourceAbsolute, 'utf-8');
  const lines = source.split('\n');
  const symbolLines = lines.slice(startLine - 1, endLine);
  const symbolText = symbolLines.join('\n');
  const movedLines = endLine - startLine + 1;

  const newSourceLines = [...lines.slice(0, startLine - 1), ...lines.slice(endLine)];
  await fs.writeFile(sourceAbsolute, newSourceLines.join('\n'), 'utf-8');

  // Read target (create if absent), append the symbol
  let targetContent = '';
  try {
    targetContent = await fs.readFile(targetAbsolute, 'utf-8');
  } catch (e: unknown) {
    if (!isEnoentError(e)) throw e;
  }

  const separator = targetContent.length > 0 && !targetContent.endsWith('\n') ? '\n\n' : '\n';
  await fs.writeFile(targetAbsolute, targetContent + separator + symbolText + '\n', 'utf-8');

  return {
    success: true,
    uid,
    from: filePath,
    to: target_file,
    movedLines,
  };
}
