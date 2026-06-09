import fs from 'fs/promises';
import path from 'path';
import { resolveSymbolCandidates } from './backend-symbol-resolution.js';

interface MoveSymbolRepoHandle {
  id: string;
  repoPath: string;
}

interface MoveSymbolDryRunResult {
  success: true;
  dry_run: true;
  uid: string;
  from: string;
  to: string;
}

interface MoveSymbolApplyResult {
  success: true;
  uid: string;
  from: string;
  to: string;
  movedLines: number;
}

type MoveSymbolResult = MoveSymbolDryRunResult | MoveSymbolApplyResult;

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

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      uid,
      from: filePath,
      to: target_file,
    };
  }

  if (!params.confirm) {
    throw new Error('Explicit confirmation required (set confirm: true)');
  }

  const assertSafePath = (p: string): string => {
    const full = path.resolve(repo.repoPath, p);
    if (!full.startsWith(repo.repoPath + path.sep) && full !== repo.repoPath) {
      throw new Error(`Path traversal blocked: ${p}`);
    }
    return full;
  };

  const sourceAbsolute = assertSafePath(filePath);
  const targetAbsolute = assertSafePath(target_file);

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
