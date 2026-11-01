import fs from 'fs/promises';
import path from 'path';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../core/tree-sitter/parser-loader.js';
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

/** Line-based apply must own one whole declaration, including its export wrapper. */
export async function assertWholeSymbolLines(
  source: string,
  symbol: { filePath: string; name: string; startLine: number; endLine: number },
): Promise<void> {
  const { startLine, endLine } = symbol;
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 0 ||
    endLine < startLine ||
    endLine >= source.split('\n').length
  ) {
    throw new Error('Invalid symbol line range');
  }
  const extension = path.extname(symbol.filePath).toLowerCase();
  const language = ['.ts', '.tsx'].includes(extension)
    ? SupportedLanguages.TypeScript
    : ['.js', '.jsx', '.mjs', '.cjs'].includes(extension)
      ? SupportedLanguages.JavaScript
      : undefined;
  if (!language) return;
  const parser = await createParserForLanguage(language, symbol.filePath);
  const tree = parser.parse(source);
  if (tree.rootNode.hasError) throw new Error('Source has syntax errors');
  const intersecting = tree.rootNode.namedChildren.filter(
    (node) => node.startPosition.row <= endLine && node.endPosition.row >= startLine,
  );
  const declarations = intersecting.filter((node) => node.type !== 'comment');
  let declaration = declarations[0];
  if (
    declarations.length !== 1 ||
    intersecting.some(
      (node) => node.startPosition.row < startLine || node.endPosition.row > endLine,
    ) ||
    declaration.startPosition.row !== startLine ||
    declaration.endPosition.row !== endLine
  ) {
    throw new Error('Line-based mutation requires one complete top-level declaration');
  }
  let previous = declaration.previousNamedSibling;
  while (previous?.type === 'comment') previous = previous.previousNamedSibling;
  // The grammar can parse a separate-line export as an identifier expression.
  if (previous?.type === 'expression_statement' && previous.text.trim() === 'export') {
    throw new Error('Line-based mutation requires one complete top-level declaration');
  }
  while (
    ['export_statement', 'lexical_declaration', 'variable_declaration'].includes(declaration.type)
  ) {
    const children = declaration.namedChildren.filter((node) => node.type !== 'comment');
    if (children.length !== 1) {
      throw new Error('Line-based mutation requires one complete top-level declaration');
    }
    declaration = children[0];
  }
  if (declaration.childForFieldName('name')?.text !== symbol.name) {
    throw new Error('Line-based mutation requires one complete top-level declaration');
  }
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

  const { filePath } = outcome.symbol;
  const startLine = outcome.symbol.startLine + 1;
  const endLine = outcome.symbol.endLine + 1;
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

  if (params.confirm !== true) {
    throw new Error('Explicit confirmation required (set confirm: true)');
  }

  const [sourceAbsolute, targetAbsolute] = await Promise.all([
    resolveContainedRealPath(repo.repoPath, filePath),
    resolveContainedRealPath(repo.repoPath, target_file),
  ]);
  if (sourceAbsolute === targetAbsolute) {
    throw new Error('Source and target resolve to the same file');
  }

  // Read source, remove symbol lines (startLine..endLine inclusive, 1-indexed)
  const source = await fs.readFile(sourceAbsolute, 'utf-8');
  await assertWholeSymbolLines(source, outcome.symbol);
  const lines = source.split('\n');
  const symbolLines = lines.slice(startLine - 1, endLine);
  const symbolText = symbolLines.join('\n');
  const movedLines = endLine - startLine + 1;

  const newSourceLines = [...lines.slice(0, startLine - 1), ...lines.slice(endLine)];

  // Read both files before writing either, so target read failures leave source intact.
  let targetContent = '';
  let targetExisted = true;
  try {
    targetContent = await fs.readFile(targetAbsolute, 'utf-8');
  } catch (e: unknown) {
    if (!isEnoentError(e)) throw e;
    targetExisted = false;
  }

  const separator = targetContent.length > 0 && !targetContent.endsWith('\n') ? '\n\n' : '\n';
  const newTarget = targetContent + separator + symbolText + '\n';
  await fs.writeFile(targetAbsolute, newTarget, 'utf-8');
  try {
    await fs.writeFile(sourceAbsolute, newSourceLines.join('\n'), 'utf-8');
  } catch (sourceError) {
    try {
      // A failed write can truncate the source; retain the destination copy
      // unless the original source has been restored successfully.
      await fs.writeFile(sourceAbsolute, source, 'utf-8');
      if (targetExisted) await fs.writeFile(targetAbsolute, targetContent, 'utf-8');
      else await fs.unlink(targetAbsolute);
    } catch (rollbackError) {
      throw new Error(
        `Failed to update source after writing target, and rollback failed: ${String(rollbackError)}`,
        { cause: sourceError },
      );
    }
    throw sourceError;
  }

  return {
    success: true,
    uid,
    from: filePath,
    to: target_file,
    movedLines,
  };
}
