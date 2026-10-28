import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type Parser from 'tree-sitter';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../core/tree-sitter/parser-loader.js';
import { resolveSymbolCandidates } from './backend-symbol-resolution.js';
import { extractFunction } from './backend-extract-function.js';
import { guardMutationRange, moveSymbol } from './backend-move-symbol.js';
import { resolveContainedRealPath } from './path-util.js';

interface MutationRepoHandle {
  id: string;
  repoPath: string;
  storagePath?: string;
}

interface ResolvedSymbolInfo {
  id: string;
  name: string;
  type: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content?: string;
}

type SymbolInfoResult = ResolvedSymbolInfo | { error: 'not found' };

type UpdateSymbolBodyResult =
  | { success: true; dry_run: true; uid: string; warnings?: string[] }
  | { success: true; uid: string; filePath: string; startLine: number; endLine: number };

type ExtractFunctionResult = Awaited<ReturnType<typeof extractFunction>>;
type MoveSymbolResult = Awaited<ReturnType<typeof moveSymbol>>;

/**
 * Sandbox tool — stage/apply mutations inside a write transaction.
 *
 * Staging is idempotent and gate-free. Applying staged edits is unavailable
 * until this server has a real write path.
 */
export async function sandbox(
  _repo: MutationRepoHandle,
  params: { action?: string; confirm?: boolean; payload?: unknown },
): Promise<{ success: true; action: string; payload?: unknown }> {
  const action = params?.action ?? 'stage';
  if (action === 'apply' && params?.confirm !== true) {
    throw new Error(
      'Explicit confirmation required: call sandbox with { action: "apply", confirm: true } to proceed.',
    );
  }
  if (action === 'apply') {
    throw new Error(
      'Sandbox apply is unavailable: staged edits are not applied by this server. Edit files directly, then verify.',
    );
  }
  return { success: true, action, payload: params?.payload };
}

/**
 * Replace-symbol tool — structured rewrite of a symbol's body.
 *
 * Two-layer gate:
 *   1. `dry_run: true` validates the replacement without writing.
 *   2. Otherwise the write path requires BOTH `confirm: true` on the
 *      call AND `confirmWrites: true` on the backend. A missing call
 *      confirm throws "Explicit confirmation required"; a backend
 *      with writes disabled throws "Write operations are disabled"
 *      even when the caller confirmed.
 *
 * Only a uniquely identified callable body is replaced; its declaration and
 * surrounding source are preserved.
 */
export async function replaceSymbol(
  repo: MutationRepoHandle,
  params: { uid?: string; new_body?: string; dry_run?: boolean; confirm?: boolean },
  confirmWrites: boolean,
): Promise<{ success: true; dry_run: boolean; uid?: string; warnings?: string[] }> {
  const dryRun = params?.dry_run === true;
  if (!dryRun) {
    if (params?.confirm !== true) {
      throw new Error(
        'Explicit confirmation required: call replace_symbol with { dry_run: false, confirm: true } to proceed.',
      );
    }
    if (!confirmWrites) {
      throw new Error(
        'Write operations are disabled on this backend — restart with --confirm-writes to enable.',
      );
    }
  }
  if (!params?.uid || typeof params.new_body !== 'string') {
    throw new Error('replace_symbol requires uid and new_body');
  }
  const outcome = await resolveSymbolCandidates(repo, { uid: params.uid }, {});
  if (outcome.kind !== 'ok') throw new Error(`Symbol not found or ambiguous: ${params.uid}`);
  const symbol = outcome.symbol;
  const warnings = await guardMutationRange(repo, symbol, dryRun);
  const languages: Record<string, SupportedLanguages> = {
    '.ts': SupportedLanguages.TypeScript,
    '.tsx': SupportedLanguages.TypeScript,
    '.js': SupportedLanguages.JavaScript,
    '.jsx': SupportedLanguages.JavaScript,
    '.mjs': SupportedLanguages.JavaScript,
    '.cjs': SupportedLanguages.JavaScript,
    '.cpp': SupportedLanguages.CPlusPlus,
    '.cc': SupportedLanguages.CPlusPlus,
    '.cxx': SupportedLanguages.CPlusPlus,
    '.rs': SupportedLanguages.Rust,
    '.py': SupportedLanguages.Python,
  };
  const language = languages[path.extname(symbol.filePath).toLowerCase()];
  if (!language) throw new Error('Unsupported replacement language');
  const sourcePath = await resolveContainedRealPath(repo.repoPath, symbol.filePath);
  const source = await fs.readFile(sourcePath, 'utf8');
  const parser = await createParserForLanguage(language, symbol.filePath);
  const tree = parser.parse(source);
  if (tree.rootNode.hasError) throw new Error('Source has syntax errors');
  const callableTypes = new Set([
    'function_declaration',
    'generator_function_declaration',
    'function_expression',
    'generator_function',
    'arrow_function',
    'method_definition',
    'function_definition',
    'function_item',
  ]);
  const symbolName = (node: Parser.SyntaxNode): string | undefined => {
    if (node.type === 'arrow_function' || node.type === 'function_expression') {
      if (node.parent?.type === 'variable_declarator') {
        return node.parent.childForFieldName('name')?.text;
      }
    }
    const name = node.childForFieldName('name');
    if (name) return name.text;
    let declarator = node.childForFieldName('declarator');
    while (declarator?.childForFieldName('declarator')) {
      declarator = declarator.childForFieldName('declarator');
    }
    return declarator?.text;
  };
  const candidates: Parser.SyntaxNode[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (
      callableTypes.has(node.type) &&
      symbolName(node) === symbol.name &&
      node.childForFieldName('body')
    ) {
      candidates.push(node);
    }
    node.namedChildren.forEach(visit);
  };
  visit(tree.rootNode);
  const matchesRange = (node: Parser.SyntaxNode): boolean => {
    let container: Parser.SyntaxNode | null = node;
    while (container) {
      if (
        container.startPosition.row + 1 === symbol.startLine &&
        container.endPosition.row + 1 === symbol.endLine
      )
        return true;
      const parent: Parser.SyntaxNode | null = container.parent;
      if (
        !parent ||
        ![
          'export_statement',
          'variable_declarator',
          'lexical_declaration',
          'variable_declaration',
          'decorated_definition',
        ].includes(parent.type)
      )
        break;
      container = parent;
    }
    return false;
  };
  const matching = candidates.filter(matchesRange);
  // A dirty preview may recover a shifted declaration only when its identity is unique.
  const declaration =
    matching.length === 1
      ? matching[0]
      : matching.length === 0 && dryRun && warnings && candidates.length === 1
        ? candidates[0]
        : undefined;
  if (!declaration) throw new Error('Stale range or ambiguous/unsupported callable declaration');
  const body = declaration.childForFieldName('body')!;
  const python = language === SupportedLanguages.Python;
  if (
    !(python
      ? body.type === 'block'
      : ['statement_block', 'compound_statement', 'block'].includes(body.type))
  ) {
    throw new Error('Unsupported callable body');
  }
  for (const node of [declaration, body]) {
    if (source.slice(node.startIndex, node.endIndex) !== node.text) {
      throw new Error('Unsupported parser source offsets');
    }
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const linePrefix = source.slice(
    source.lastIndexOf('\n', declaration.startIndex - 1) + 1,
    declaration.startIndex,
  );
  const baseIndent = linePrefix.match(/^[\t ]*/)?.[0] ?? '';
  const existingIndent = source.slice(
    source.lastIndexOf('\n', body.startIndex - 1) + 1,
    body.startIndex,
  );
  if (python && !/^[\t ]+$/.test(existingIndent)) {
    throw new Error('Inline Python suites are unsupported');
  }
  const indent = python
    ? existingIndent
    : (body.text.match(/\r?\n([\t ]+)\S/)?.[1] ?? baseIndent + '  ');
  const lines = params.new_body.replace(/\r\n/g, '\n').trim().split('\n');
  const replacement = python
    ? lines.map((line, index) => (index === 0 ? '' : indent) + line).join(newline)
    : `{${newline}${lines.map((line) => indent + line).join(newline)}${newline}${baseIndent}}`;
  const newSource = source.slice(0, body.startIndex) + replacement + source.slice(body.endIndex);
  const updated = parser.parse(newSource);
  if (updated.rootNode.hasError) throw new Error('Replacement source has syntax errors');
  // Parsing alone is insufficient: injected closing delimiters must not escape
  // the intended body and create additional declarations.
  const updatedBody = updated.rootNode.descendantForIndex(
    body.startIndex,
    body.startIndex + replacement.length - 1,
  );
  if (
    updatedBody.type !== body.type ||
    updatedBody.startIndex !== body.startIndex ||
    updatedBody.endIndex !== body.startIndex + replacement.length ||
    updatedBody.parent?.type !== declaration.type
  ) {
    throw new Error('Replacement escapes the callable body');
  }
  // Prefixing indentation inside a multiline literal would change its value.
  // Keep those replacements unsupported until formatting can preserve literals.
  const multilineLiteral = (node: Parser.SyntaxNode): boolean =>
    ((node.type.includes('string') || node.type === 'char_literal') && node.text.includes('\n')) ||
    node.namedChildren.some(multilineLiteral);
  if (multilineLiteral(updatedBody)) {
    throw new Error('Multiline string literals in replacement bodies are unsupported');
  }
  if (!dryRun) {
    // Keep validation and writing on one descriptor: a path swap must not redirect
    // the write to a symlink target between the final read and write.
    const handle = await fs.open(sourcePath, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      const currentPath = await resolveContainedRealPath(repo.repoPath, symbol.filePath);
      const current = await fs.lstat(sourcePath);
      if (
        !opened.isFile() ||
        currentPath !== sourcePath ||
        current.isSymbolicLink() ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino ||
        (await handle.readFile('utf8')) !== source
      ) {
        throw new Error('Source changed during replacement');
      }
      const bytes = Buffer.from(newSource, 'utf8');
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (bytesWritten === 0) throw new Error('Replacement write made no progress');
        offset += bytesWritten;
      }
      await handle.truncate(bytes.length);
    } finally {
      await handle.close();
    }
  }
  return { success: true, dry_run: dryRun, uid: params?.uid, ...(warnings ? { warnings } : {}) };
}

export async function getSymbolInfo(
  repo: MutationRepoHandle,
  params: { uid: string },
  ensureInitialized: (repoId: string) => Promise<void>,
): Promise<SymbolInfoResult> {
  await ensureInitialized(repo.id);
  const outcome = await resolveSymbolCandidates(
    repo,
    { uid: params.uid, include_content: true },
    {},
  );
  if (outcome.kind === 'ok') {
    return outcome.symbol;
  }
  return { error: 'not found' };
}

export async function updateSymbolBody(
  repo: MutationRepoHandle,
  params: { uid: string; new_body: string; dry_run?: boolean; confirm?: boolean },
  confirmWrites: boolean,
  ensureInitialized: (repoId: string) => Promise<void>,
): Promise<UpdateSymbolBodyResult> {
  await ensureInitialized(repo.id);

  if (params.dry_run !== false) {
    let warnings: string[] | undefined;
    if (repo.repoPath && repo.storagePath) {
      const outcome = await resolveSymbolCandidates(repo, { uid: params.uid }, {});
      if (outcome.kind === 'ok') {
        warnings = await guardMutationRange(repo, outcome.symbol, true);
      }
    }
    return { success: true, dry_run: true, uid: params.uid, ...(warnings ? { warnings } : {}) };
  }

  if (!confirmWrites) {
    throw new Error('Write operations are disabled (start server with --confirm-writes)');
  }

  if (params.confirm !== true) {
    throw new Error('Explicit confirmation required (set confirm: true)');
  }

  const outcome = await resolveSymbolCandidates(
    repo,
    { uid: params.uid, include_content: true },
    {},
  );
  if (outcome.kind !== 'ok') {
    throw new Error(`Symbol not found: ${params.uid}`);
  }

  const { filePath, startLine, endLine } = outcome.symbol;
  await guardMutationRange(repo, outcome.symbol, false);
  const fs = await import('fs/promises');
  const sourcePath = await resolveContainedRealPath(repo.repoPath, filePath);
  const source = await fs.readFile(sourcePath, 'utf-8');
  const lines = source.split('\n');
  // startLine and endLine are 1-indexed inclusive
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine);
  const newSource = [...before, params.new_body, ...after].join('\n');
  await fs.writeFile(sourcePath, newSource, 'utf-8');

  return {
    success: true,
    uid: params.uid,
    filePath: filePath.replaceAll('\\', '/'),
    startLine,
    endLine,
  };
}

export async function extractFunctionByUid(
  repo: MutationRepoHandle,
  params: {
    uid: string;
    new_name: string;
    target_file?: string;
    dry_run?: boolean;
    confirm?: boolean;
  },
  confirmWrites: boolean,
  ensureInitialized: (repoId: string) => Promise<void>,
): Promise<ExtractFunctionResult> {
  await ensureInitialized(repo.id);

  if (params.dry_run !== false) {
    return extractFunction(repo, { ...params, dry_run: true });
  }

  if (!confirmWrites) {
    throw new Error('Write operations are disabled (start server with --confirm-writes)');
  }

  return extractFunction(repo, params);
}

export async function moveSymbolByUid(
  repo: MutationRepoHandle,
  params: {
    uid: string;
    target_file: string;
    dry_run?: boolean;
    confirm?: boolean;
  },
  confirmWrites: boolean,
  ensureInitialized: (repoId: string) => Promise<void>,
): Promise<MoveSymbolResult> {
  await ensureInitialized(repo.id);

  if (params.dry_run !== false) {
    return moveSymbol(repo, { ...params, dry_run: true });
  }

  if (!confirmWrites) {
    throw new Error('Write operations are disabled (start server with --confirm-writes)');
  }

  return moveSymbol(repo, params);
}
