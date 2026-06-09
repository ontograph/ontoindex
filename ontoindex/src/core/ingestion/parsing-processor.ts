import type { GraphNode, NodeLabel } from 'ontoindex-shared';
import { KnowledgeGraph } from '../graph/types.js';
import Parser from 'tree-sitter';
import path from 'node:path';
import { loadParser, loadLanguage, isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { getProvider } from './languages/index.js';
import { generateId } from '../../lib/utils.js';
import type { SymbolTableReader, SymbolTableWriter, ExtractedHeritage } from './model/index.js';
// SymbolTableReader is used for the FieldExtractorContext stub; the
// parsing functions themselves need Writer because they call .add().
import { ASTCache } from './ast-cache.js';
import { getLanguageFromFilename, SupportedLanguages } from 'ontoindex-shared';
import { extractVueScript, isVueSetupTopLevel } from './vue-sfc-extractor.js';
import { extractLightweight } from './lightweight-extractor.js';
import { yieldToEventLoop } from './utils/event-loop.js';
import {
  getDefinitionNodeFromCaptures,
  findEnclosingClassInfo,
  getLabelFromCaptures,
  CLASS_CONTAINER_TYPES,
  type SyntaxNode,
  type EnclosingClassInfo,
} from './utils/ast-helpers.js';
import { detectFrameworkFromAST } from './framework-detection.js';
import { buildTypeEnv } from './type-env.js';
import type { FieldInfo, FieldExtractorContext } from './field-types.js';
import type { MethodInfo } from './method-types.js';
import {
  buildMethodProps,
  arityForIdFromInfo,
  typeTagForId,
  constTagForId,
  buildCollisionGroups,
} from './utils/method-props.js';
import type { LanguageProvider } from './language-provider.js';
import type { ParsedFile } from 'ontoindex-shared';
import {
  WorkerPool,
  type WorkerResultEvent,
  type WorkerSubBatchStartEvent,
} from './workers/worker-pool.js';
import {
  createEmptyResult,
  type ParseWorkerResult,
  type ParseWorkerInput,
  type ExtractedImport,
  type ExtractedCall,
  type ExtractedAssignment,
  type ExtractedRoute,
  type ExtractedFetchCall,
  type ExtractedDecoratorRoute,
  type ExtractedToolDef,
  type FileConstructorBindings,
  type FileScopeBindings,
  type ExtractedORMQuery,
  type ParseFileTiming,
  type ParseExtractorTiming,
  type CppTypeOwnerHint,
} from './workers/parse-types.js';
import {
  exceedsParseMaxAstDepth,
  getParseMaxAstDepth,
  getParseMaxAstNodes,
  getTreeSitterBufferSize,
  TREE_SITTER_MAX_BUFFER,
} from './constants.js';
import {
  getActiveComponentFilePatterns,
  getActiveORMClientIdentifiers,
  getActiveRouteFilePatterns,
} from '../../analysis-packs/execution.js';

type FileProgressCallback = (current: number, total: number, filePath: string) => void;
type WorkerSubBatchStartCallback = (event: WorkerSubBatchStartEvent) => void;
type WorkerResultCallback = (event: WorkerResultEvent) => void;
export const PARSE_WORKER_RETRY_POLICY_SEQUENTIAL = 'sequential';
export const PARSE_WORKER_RETRY_POLICY_QUARANTINE = 'quarantine';
export type ParseWorkerRetryPolicy =
  | typeof PARSE_WORKER_RETRY_POLICY_SEQUENTIAL
  | typeof PARSE_WORKER_RETRY_POLICY_QUARANTINE;

const parsePositiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const DEFAULT_PARSE_WORKER_RECOVERY_WINDOW_SIZE = 256;
export const PARSE_WORKER_RECOVERY_WINDOW_SIZE = parsePositiveIntEnv(
  'ONTOINDEX_PARSE_RECOVERY_WINDOW_SIZE',
  DEFAULT_PARSE_WORKER_RECOVERY_WINDOW_SIZE,
);
const usePathBasedParseWorkerInput = (): boolean =>
  process.env.ONTOINDEX_PARSE_WORKER_INPUT_MODE !== 'content';

type CppQualifiedOwnerInfo = EnclosingClassInfo & {
  classFilePath?: string;
  declarationStartLine?: number;
  declarationEndLine?: number;
};

const CPP_TYPE_DECL_RE = /\b(class|struct)\b/g;
const CPP_QUALIFIED_DEFINITION_RE =
  /\b([A-Za-z_]\w*(?:(?:\s*::\s*)[A-Za-z_]\w*)*)\s*::\s*~?[A-Za-z_]\w*\s*\(/g;
const CPP_MEMBER_DECL_RE =
  /(?:^|[;{}]\s*|(?:public|private|protected)\s*:\s*)[^;{}()]*?\b(~?[A-Za-z_]\w*|operator\s*[^\s(]+)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:=\s*(?:0|default|delete)\s*)?;/g;

const isCppLanguagePath = (filePath: string): boolean =>
  getLanguageFromFilename(filePath) === SupportedLanguages.CPlusPlus;

const normalizeCppScope = (scopeText: string): string => scopeText.replace(/\s+/g, '');

const cppScopeSimpleName = (scopeText: string): string =>
  normalizeCppScope(scopeText).split('::').filter(Boolean).pop() ?? '';

const cppStem = (filePath: string): string =>
  path.basename(filePath).replace(/\.(?:cxx|cpp|cc|c|hxx|hpp|hh|h)$/i, '');

const stripCppInheritanceClause = (declarationPrefix: string): string => {
  for (let i = 0; i < declarationPrefix.length; i++) {
    if (
      declarationPrefix[i] === ':' &&
      declarationPrefix[i - 1] !== ':' &&
      declarationPrefix[i + 1] !== ':'
    ) {
      return declarationPrefix.slice(0, i);
    }
  }
  return declarationPrefix;
};

const extractCppTypeDeclarationName = (declarationPrefix: string): string | null => {
  const withoutInheritance = stripCppInheritanceClause(declarationPrefix);
  const match = withoutInheritance.match(/((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)\s*$/);
  if (!match?.[1]) return null;
  return cppScopeSimpleName(match[1]);
};

const extractCppTypeDeclarationNameAt = (
  content: string,
  startIndex: number,
  options: { allowForwardDeclaration?: boolean } = {},
): string | null => {
  const declarationMatch = /\b(class|struct)\b/.exec(content.slice(startIndex));
  if (!declarationMatch) return null;
  const declarationStart = startIndex + declarationMatch.index;
  const bodyStart = content.indexOf('{', declarationStart + declarationMatch[0].length);
  const nextSemicolon = content.indexOf(';', declarationStart + declarationMatch[0].length);
  const declarationEnd =
    bodyStart >= 0 && (nextSemicolon < 0 || bodyStart < nextSemicolon)
      ? bodyStart
      : options.allowForwardDeclaration && nextSemicolon >= 0
        ? nextSemicolon
        : -1;
  if (declarationEnd < 0) return null;
  return extractCppTypeDeclarationName(
    content.slice(declarationStart + declarationMatch[0].length, declarationEnd),
  );
};

const lineNumberAtIndex = (content: string, index: number): number => {
  let line = 0;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
};

const findMatchingBraceIndex = (content: string, openBraceIndex: number): number => {
  let depth = 0;
  for (let i = openBraceIndex; i < content.length; i++) {
    const char = content[i];
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

const normalizeCppMemberDeclarationName = (name: string): string =>
  name.startsWith('operator') ? name.replace(/\s+/g, ' ').trim() : name;

const extractCppMemberDeclarationHints = (
  content: string,
  baseLine = 0,
): NonNullable<CppTypeOwnerHint['memberDeclarations']> => {
  const declarations: NonNullable<CppTypeOwnerHint['memberDeclarations']> = [];
  for (const match of content.matchAll(CPP_MEMBER_DECL_RE)) {
    const name = match[1];
    if (!name) continue;
    const matchStartIndex = match.index ?? 0;
    const nameOffset = match[0].lastIndexOf(name);
    const startIndex = matchStartIndex + (nameOffset >= 0 ? nameOffset : 0);
    const endIndex = matchStartIndex + match[0].length;
    declarations.push({
      name: normalizeCppMemberDeclarationName(name),
      startLine: baseLine + lineNumberAtIndex(content, startIndex),
      endLine: baseLine + lineNumberAtIndex(content, endIndex),
    });
  }
  return declarations;
};

const isRelatedCppPath = (sourceFilePath: string, ownerFilePath: string): boolean => {
  const sourceStem = cppStem(sourceFilePath);
  const ownerStem = cppStem(ownerFilePath);
  return (
    sourceStem === ownerStem ||
    sourceStem.startsWith(ownerStem) ||
    ownerStem.startsWith(sourceStem) ||
    path.dirname(sourceFilePath) === path.dirname(ownerFilePath)
  );
};

const uniqueCppHints = (hints: CppTypeOwnerHint[]): CppTypeOwnerHint[] => {
  const seen = new Set<string>();
  const result: CppTypeOwnerHint[] = [];
  for (const hint of hints) {
    const key = `${hint.label}:${hint.filePath}:${hint.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hint);
  }
  return result;
};

const extractCppTypeOwnerHints = (file: { path: string; content: string }): CppTypeOwnerHint[] => {
  if (!isCppLanguagePath(file.path)) return [];
  const hints: CppTypeOwnerHint[] = [];
  for (const match of file.content.matchAll(CPP_TYPE_DECL_RE)) {
    const label = match[1] === 'struct' ? 'Struct' : 'Class';
    const matchIndex = match.index ?? 0;
    const bodyStart = file.content.indexOf('{', matchIndex + match[0].length);
    const nextSemicolon = file.content.indexOf(';', matchIndex + match[0].length);
    if (bodyStart < 0 || (nextSemicolon >= 0 && nextSemicolon < bodyStart)) continue;
    const name = extractCppTypeDeclarationName(
      file.content.slice(matchIndex + match[0].length, bodyStart),
    );
    if (name) {
      const bodyEnd = bodyStart >= 0 ? findMatchingBraceIndex(file.content, bodyStart) : -1;
      const memberDeclarations =
        bodyStart >= 0 && bodyEnd > bodyStart
          ? extractCppMemberDeclarationHints(
              file.content.slice(bodyStart + 1, bodyEnd),
              lineNumberAtIndex(file.content, bodyStart + 1),
            )
          : [];
      hints.push({
        name,
        label,
        filePath: file.path,
        ...(memberDeclarations.length > 0 ? { memberDeclarations } : {}),
      });
    }
  }
  return uniqueCppHints(hints);
};

const findCppMemberDeclarationHint = (
  ownerHint: CppTypeOwnerHint,
  memberName: string,
): NonNullable<CppTypeOwnerHint['memberDeclarations']>[number] | undefined =>
  ownerHint.memberDeclarations?.find((declaration) => declaration.name === memberName);

const extractCppQualifiedOwnerNames = (content: string): Set<string> => {
  const names = new Set<string>();
  for (const match of content.matchAll(CPP_QUALIFIED_DEFINITION_RE)) {
    const simpleName = match[1] ? cppScopeSimpleName(match[1]) : '';
    if (simpleName) names.add(simpleName);
  }
  return names;
};

const buildCppTypeOwnerIndex = (
  files: { path: string; content: string }[],
): Map<string, CppTypeOwnerHint[]> => {
  const index = new Map<string, CppTypeOwnerHint[]>();
  for (const file of files) {
    for (const hint of extractCppTypeOwnerHints(file)) {
      const existing = index.get(hint.name);
      if (existing) existing.push(hint);
      else index.set(hint.name, [hint]);
    }
  }
  for (const [name, hints] of index) index.set(name, uniqueCppHints(hints));
  return index;
};

const selectCppTypeOwnerHintsForFile = (
  file: { path: string; content: string },
  ownerIndex: ReadonlyMap<string, readonly CppTypeOwnerHint[]>,
): CppTypeOwnerHint[] | undefined => {
  if (!isCppLanguagePath(file.path)) return undefined;
  const ownerNames = extractCppQualifiedOwnerNames(file.content);
  if (ownerNames.size === 0) return undefined;

  const selected: CppTypeOwnerHint[] = [];
  for (const ownerName of ownerNames) {
    const hints = ownerIndex.get(ownerName);
    if (hints) selected.push(...hints);
  }
  const unique = uniqueCppHints(selected);
  return unique.length > 0 ? unique : undefined;
};

const resolveCppTypeOwnerHint = (
  scopeText: string,
  filePath: string,
  localHints: readonly CppTypeOwnerHint[],
  externalHints: readonly CppTypeOwnerHint[] = [],
): CppTypeOwnerHint | null => {
  const scopeName = cppScopeSimpleName(scopeText);
  if (!scopeName) return null;

  const localCandidates = localHints.filter((hint) => hint.name === scopeName);
  if (localCandidates.length === 1) return localCandidates[0];

  const candidates = uniqueCppHints([...localCandidates, ...externalHints]).filter(
    (hint) => hint.name === scopeName,
  );
  if (candidates.length === 1) return candidates[0];

  const related = candidates.filter((hint) => isRelatedCppPath(filePath, hint.filePath));
  return related.length === 1 ? related[0] : null;
};

interface WorkerExtractedData {
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  assignments: ExtractedAssignment[];
  heritage: ExtractedHeritage[];
  routes: ExtractedRoute[];
  fetchCalls: ExtractedFetchCall[];
  decoratorRoutes: ExtractedDecoratorRoute[];
  toolDefs: ExtractedToolDef[];
  ormQueries: ExtractedORMQuery[];
  constructorBindings: FileConstructorBindings[];
  fileScopeBindings: FileScopeBindings[];
  fileTimings: ParseFileTiming[];
  extractorTimings: ParseExtractorTiming[];
  degraded?: {
    reason: string;
    filesSkipped: number;
    policy: ParseWorkerRetryPolicy;
    action: 'quarantine-files' | 'skip-remaining';
    recoveryWindowSize: number;
    fatal?: boolean;
  };
  /**
   * Per-file `ParsedFile` artifacts from the new scope-based resolution
   * pipeline (RFC #909 Ring 2). Empty until a provider implements
   * `emitScopeCaptures` — additive to the legacy DAG path. Aggregated
   * from every worker chunk; consumed downstream by #921's
   * finalize-orchestrator.
   */
  parsedFiles: ParsedFile[];
}

interface WorkerGraphMutationBuffer {
  nodes: ParseWorkerResult['nodes'];
  relationships: ParseWorkerResult['relationships'];
  symbols: ParseWorkerResult['symbols'];
}

const createEmptyWorkerExtractedData = (): WorkerExtractedData => ({
  imports: [],
  calls: [],
  assignments: [],
  heritage: [],
  routes: [],
  fetchCalls: [],
  decoratorRoutes: [],
  toolDefs: [],
  ormQueries: [],
  constructorBindings: [],
  fileScopeBindings: [],
  fileTimings: [],
  extractorTimings: [],
  parsedFiles: [],
});

const createEmptyWorkerGraphMutationBuffer = (): WorkerGraphMutationBuffer => ({
  nodes: [],
  relationships: [],
  symbols: [],
});

const createSkippedWorkerExtractedData = (
  files: { path: string; content: string }[],
  reason: string,
  fatal = false,
): WorkerExtractedData => ({
  ...createEmptyWorkerExtractedData(),
  fileTimings: files.map((file) => ({
    filePath: file.path,
    language: getLanguageFromFilename(file.path) ?? undefined,
    durationMs: 0,
    status: 'skipped',
  })),
  degraded: {
    reason,
    filesSkipped: files.length,
    policy: PARSE_WORKER_RETRY_POLICY_QUARANTINE,
    action: fatal ? 'skip-remaining' : 'quarantine-files',
    recoveryWindowSize: PARSE_WORKER_RECOVERY_WINDOW_SIZE,
    fatal,
  },
});

const appendWorkerExtractedData = (
  target: WorkerExtractedData,
  src: WorkerExtractedData,
): WorkerExtractedData => {
  for (const item of src.imports) target.imports.push(item);
  for (const item of src.calls) target.calls.push(item);
  for (const item of src.assignments) target.assignments.push(item);
  for (const item of src.heritage) target.heritage.push(item);
  for (const item of src.routes) target.routes.push(item);
  for (const item of src.fetchCalls) target.fetchCalls.push(item);
  for (const item of src.decoratorRoutes) target.decoratorRoutes.push(item);
  for (const item of src.toolDefs) target.toolDefs.push(item);
  for (const item of src.ormQueries) target.ormQueries.push(item);
  for (const item of src.constructorBindings) target.constructorBindings.push(item);
  for (const item of src.fileScopeBindings) target.fileScopeBindings.push(item);
  for (const item of src.fileTimings) target.fileTimings.push(item);
  for (const item of src.extractorTimings) target.extractorTimings.push(item);
  for (const item of src.parsedFiles) target.parsedFiles.push(item);
  if (src.degraded) {
    const existing = target.degraded;
    target.degraded = {
      reason: existing ? `${existing.reason}; ${src.degraded.reason}` : src.degraded.reason,
      filesSkipped: (existing?.filesSkipped ?? 0) + src.degraded.filesSkipped,
      policy: src.degraded.policy,
      action:
        existing?.action === 'skip-remaining' || src.degraded.action === 'skip-remaining'
          ? 'skip-remaining'
          : 'quarantine-files',
      recoveryWindowSize: src.degraded.recoveryWindowSize,
      fatal: Boolean(existing?.fatal || src.degraded.fatal),
    };
  }
  return target;
};

const collectParseableWorkerInputs = async (
  files: { path: string; content: string }[],
  repoPath: string,
): Promise<ParseWorkerInput[]> => {
  const parseableFiles: ParseWorkerInput[] = [];
  const cppTypeOwnerIndex = buildCppTypeOwnerIndex(files);
  const [routeFilePatterns, componentFilePatterns, ormClientIdentifiers] = await Promise.all([
    getActiveRouteFilePatterns(repoPath),
    getActiveComponentFilePatterns(repoPath),
    getActiveORMClientIdentifiers(repoPath),
  ]);
  for (const file of files) {
    const language = getLanguageFromFilename(file.path);
    if (language) {
      const pathBasedInput = usePathBasedParseWorkerInput();
      const cppTypeOwnerHints = selectCppTypeOwnerHintsForFile(file, cppTypeOwnerIndex);
      parseableFiles.push({
        path: file.path,
        ...(pathBasedInput
          ? { contentSource: 'path' as const, repoPath }
          : { content: file.content }),
        ...(routeFilePatterns.length > 0 ? { routeFilePatterns } : {}),
        ...(componentFilePatterns.length > 0 ? { componentFilePatterns } : {}),
        ...(ormClientIdentifiers.prismaClientIdentifiers.length > 0
          ? { prismaClientIdentifiers: ormClientIdentifiers.prismaClientIdentifiers }
          : {}),
        ...(ormClientIdentifiers.supabaseClientIdentifiers.length > 0
          ? { supabaseClientIdentifiers: ormClientIdentifiers.supabaseClientIdentifiers }
          : {}),
        ...(cppTypeOwnerHints ? { cppTypeOwnerHints } : {}),
      });
    }
  }
  return parseableFiles;
};

const mergeWorkerChunkResults = (
  chunkResults: ParseWorkerResult[],
  mutationBuffer: WorkerGraphMutationBuffer,
): WorkerExtractedData => {
  const extracted = createEmptyWorkerExtractedData();

  for (const result of chunkResults) {
    for (const node of result.nodes) {
      mutationBuffer.nodes.push(node);
    }

    for (const rel of result.relationships) {
      mutationBuffer.relationships.push(rel);
    }

    for (const sym of result.symbols) {
      mutationBuffer.symbols.push(sym);
    }

    for (const item of result.imports) extracted.imports.push(item);
    for (const item of result.calls) extracted.calls.push(item);
    for (const item of result.assignments) extracted.assignments.push(item);
    for (const item of result.heritage) extracted.heritage.push(item);
    for (const item of result.routes) extracted.routes.push(item);
    for (const item of result.fetchCalls) extracted.fetchCalls.push(item);
    for (const item of result.decoratorRoutes) extracted.decoratorRoutes.push(item);
    for (const item of result.toolDefs) extracted.toolDefs.push(item);
    if (result.ormQueries) for (const item of result.ormQueries) extracted.ormQueries.push(item);
    for (const item of result.constructorBindings) extracted.constructorBindings.push(item);
    if (result.fileScopeBindings) {
      for (const item of result.fileScopeBindings) extracted.fileScopeBindings.push(item);
    }
    if (result.parsedFiles) {
      for (const item of result.parsedFiles) extracted.parsedFiles.push(item);
    }
    if (result.fileTimings) {
      for (const item of result.fileTimings) extracted.fileTimings.push(item);
    }
    if (result.extractorTimings) {
      for (const item of result.extractorTimings) extracted.extractorTimings.push(item);
    }
    clearParseWorkerResult(result);
  }

  return extracted;
};

const applyWorkerGraphMutationBuffer = (
  graph: KnowledgeGraph,
  symbolTable: SymbolTableWriter,
  mutationBuffer: WorkerGraphMutationBuffer,
): void => {
  for (const node of mutationBuffer.nodes) {
    addOrMergeGraphNode(graph, {
      id: node.id,
      label: node.label as NodeLabel,
      properties: node.properties,
    });
  }

  for (const rel of mutationBuffer.relationships) {
    graph.addRelationship(rel);
  }

  for (const sym of mutationBuffer.symbols) {
    symbolTable.add(sym.filePath, sym.name, sym.nodeId, sym.type, {
      parameterCount: sym.parameterCount,
      requiredParameterCount: sym.requiredParameterCount,
      parameterTypes: sym.parameterTypes,
      returnType: sym.returnType,
      declaredType: sym.declaredType,
      ownerId: sym.ownerId,
      qualifiedName: sym.qualifiedName,
    });
  }
};

const addOrMergeGraphNode = (graph: KnowledgeGraph, node: GraphNode): void => {
  const existing = graph.getNode(node.id);
  if (!existing) {
    graph.addNode(node);
    return;
  }
  const existingHasDefinition = typeof existing.properties.definitionFilePath === 'string';
  const incomingHasDefinition = typeof node.properties.definitionFilePath === 'string';
  const mergedProperties = {
    ...existing.properties,
    ...node.properties,
  };
  if (existingHasDefinition && !incomingHasDefinition) {
    mergedProperties.filePath = existing.properties.filePath;
    mergedProperties.startLine = existing.properties.startLine;
    mergedProperties.endLine = existing.properties.endLine;
  }
  existing.properties = mergedProperties;
};

const clearParseWorkerResult = (result: ParseWorkerResult): void => {
  result.nodes.length = 0;
  result.relationships.length = 0;
  result.symbols.length = 0;
  result.imports.length = 0;
  result.calls.length = 0;
  result.assignments.length = 0;
  result.heritage.length = 0;
  result.routes.length = 0;
  result.fetchCalls.length = 0;
  result.decoratorRoutes.length = 0;
  result.toolDefs.length = 0;
  result.ormQueries.length = 0;
  result.constructorBindings.length = 0;
  result.fileScopeBindings.length = 0;
  result.parsedFiles.length = 0;
  result.processedPaths.length = 0;
  result.fileTimings.length = 0;
  result.extractorTimings.length = 0;
  result.skippedLanguages = {};
  result.fileCount = 0;
};

const logSkippedLanguages = (skippedLanguages: Map<string, number>): void => {
  if (skippedLanguages.size === 0) return;

  const summary = Array.from(skippedLanguages.entries())
    .map(([lang, count]) => `${lang}: ${count}`)
    .join(', ');
  console.warn(`  Skipped unsupported languages: ${summary}`);
};

const collectWorkerSkippedLanguages = (chunkResults: ParseWorkerResult[]): Map<string, number> => {
  const skippedLanguages = new Map<string, number>();
  for (const result of chunkResults) {
    for (const [lang, count] of Object.entries(result.skippedLanguages)) {
      skippedLanguages.set(lang, (skippedLanguages.get(lang) || 0) + count);
    }
  }
  return skippedLanguages;
};

// ============================================================================
// Worker-based parallel parsing
// ============================================================================

const processParsingWithWorkers = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  repoPath: string,
  symbolTable: SymbolTableWriter,
  astCache: ASTCache,
  workerPool: WorkerPool,
  onFileProgress?: FileProgressCallback,
  onSubBatchStart?: WorkerSubBatchStartCallback,
  onWorkerResult?: WorkerResultCallback,
): Promise<WorkerExtractedData> => {
  const parseableFiles = await collectParseableWorkerInputs(files, repoPath);

  if (parseableFiles.length === 0) return createEmptyWorkerExtractedData();

  const total = files.length;
  const streamedExtracted = createEmptyWorkerExtractedData();
  const streamedSkippedLanguages = new Map<string, number>();
  const streamedMutations = createEmptyWorkerGraphMutationBuffer();

  const consumeResultPart = (result: ParseWorkerResult): void => {
    const partSkipped = collectWorkerSkippedLanguages([result]);
    for (const [lang, count] of partSkipped) {
      streamedSkippedLanguages.set(lang, (streamedSkippedLanguages.get(lang) || 0) + count);
    }

    const partExtracted = mergeWorkerChunkResults([result], streamedMutations);

    appendWorkerExtractedData(streamedExtracted, partExtracted);
  };

  // Dispatch to worker pool — pool handles splitting into chunks and sub-batching
  const chunkResults = await workerPool.dispatch<ParseWorkerInput, ParseWorkerResult>(
    parseableFiles,
    (filesProcessed, filePath) => {
      onFileProgress?.(Math.min(filesProcessed, total), total, filePath ?? 'Parsing...');
    },
    onSubBatchStart,
    onWorkerResult,
    {
      collectResultParts: false,
      createEmptyResult,
      onResultPart: consumeResultPart,
    },
  );

  const skippedLanguages = collectWorkerSkippedLanguages(chunkResults);
  for (const [lang, count] of streamedSkippedLanguages) {
    skippedLanguages.set(lang, (skippedLanguages.get(lang) || 0) + count);
  }

  const finalMutations = createEmptyWorkerGraphMutationBuffer();
  const extracted = appendWorkerExtractedData(
    streamedExtracted,
    mergeWorkerChunkResults(chunkResults, finalMutations),
  );
  applyWorkerGraphMutationBuffer(graph, symbolTable, streamedMutations);
  applyWorkerGraphMutationBuffer(graph, symbolTable, finalMutations);
  logSkippedLanguages(skippedLanguages);

  // Final progress
  onFileProgress?.(total, total, 'done');
  return extracted;
};

const processParsingWithWorkerRecovery = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  repoPath: string,
  symbolTable: SymbolTableWriter,
  astCache: ASTCache,
  workerPool: WorkerPool,
  onFileProgress?: FileProgressCallback,
  onSubBatchStart?: WorkerSubBatchStartCallback,
  onWorkerResult?: WorkerResultCallback,
  depth = 0,
): Promise<WorkerExtractedData> => {
  try {
    return await processParsingWithWorkers(
      graph,
      files,
      repoPath,
      symbolTable,
      astCache,
      workerPool,
      onFileProgress,
      onSubBatchStart,
      onWorkerResult,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (files.length <= 1) {
      const filePath = files[0]?.path ?? '<unknown>';
      console.warn(`Parser worker quarantined ${filePath}: ${reason}`);
      return createSkippedWorkerExtractedData(files, reason);
    }

    const midpoint = Math.ceil(files.length / 2);
    console.warn(
      `Parser worker failed for ${files.length} files; retrying halves to isolate crashing input (depth ${depth}): ${reason}`,
    );
    const left = await processParsingWithWorkerRecovery(
      graph,
      files.slice(0, midpoint),
      repoPath,
      symbolTable,
      astCache,
      workerPool,
      onFileProgress,
      onSubBatchStart,
      onWorkerResult,
      depth + 1,
    );
    const right = await processParsingWithWorkerRecovery(
      graph,
      files.slice(midpoint),
      repoPath,
      symbolTable,
      astCache,
      workerPool,
      onFileProgress,
      onSubBatchStart,
      onWorkerResult,
      depth + 1,
    );
    return appendWorkerExtractedData(
      appendWorkerExtractedData(createEmptyWorkerExtractedData(), left),
      right,
    );
  }
};

const processParsingWithAdaptiveWorkerRecovery = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  repoPath: string,
  symbolTable: SymbolTableWriter,
  astCache: ASTCache,
  workerPool: WorkerPool,
  onFileProgress?: FileProgressCallback,
  onSubBatchStart?: WorkerSubBatchStartCallback,
  onWorkerResult?: WorkerResultCallback,
): Promise<WorkerExtractedData> => {
  try {
    return await processParsingWithWorkers(
      graph,
      files,
      repoPath,
      symbolTable,
      astCache,
      workerPool,
      onFileProgress,
      onSubBatchStart,
      onWorkerResult,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (files.length <= PARSE_WORKER_RECOVERY_WINDOW_SIZE) {
      console.warn(
        `Parser worker failed for ${files.length} files; isolating within current window: ${reason}`,
      );
      return processParsingWithWorkerRecovery(
        graph,
        files,
        repoPath,
        symbolTable,
        astCache,
        workerPool,
        onFileProgress,
        onSubBatchStart,
        onWorkerResult,
      );
    }

    console.warn(
      `Parser worker failed for ${files.length} files; retrying ${PARSE_WORKER_RECOVERY_WINDOW_SIZE}-file windows to limit replay: ${reason}`,
    );
  }

  const combined = createEmptyWorkerExtractedData();
  for (let start = 0; start < files.length; start += PARSE_WORKER_RECOVERY_WINDOW_SIZE) {
    const window = files.slice(start, start + PARSE_WORKER_RECOVERY_WINDOW_SIZE);
    const result = await processParsingWithWorkerRecovery(
      graph,
      window,
      repoPath,
      symbolTable,
      astCache,
      workerPool,
      onFileProgress,
      onSubBatchStart,
      onWorkerResult,
    );
    appendWorkerExtractedData(combined, result);
  }
  return combined;
};

// ============================================================================
// Sequential fallback (original implementation)
// ============================================================================

// Inline caches to avoid repeated parent-walks per node (same pattern as parse-worker.ts).
// Keyed by tree-sitter node reference — cleared at the start of each file.
const classInfoCache = new Map<SyntaxNode, EnclosingClassInfo | null>();
const exportCache = new Map<SyntaxNode, boolean>();

const cachedFindEnclosingClassInfo = (
  node: SyntaxNode,
  filePath: string,
  resolveEnclosingOwner?: (node: SyntaxNode) => SyntaxNode | null,
): EnclosingClassInfo | null => {
  const cached = classInfoCache.get(node);
  if (cached !== undefined) return cached;
  const result = findEnclosingClassInfo(node, filePath, resolveEnclosingOwner);
  classInfoCache.set(node, result);
  return result;
};

const cachedExportCheck = (
  checker: (node: SyntaxNode, name: string) => boolean,
  node: SyntaxNode,
  name: string,
): boolean => {
  const cached = exportCache.get(node);
  if (cached !== undefined) return cached;
  const result = checker(node, name);
  exportCache.set(node, result);
  return result;
};

// FieldExtractor cache for sequential path — same pattern as parse-worker.ts
const seqFieldInfoCache = new Map<number, Map<string, FieldInfo>>();

// MethodExtractor cache for sequential path — avoids re-traversing the same class
// body once per method. Keyed on classNode.id (tree-sitter node identity number).
const seqMethodExtractCache = new Map<
  number,
  { ownerName: string | undefined; methods: MethodInfo[] } | null
>();
// Derived method map + collision groups cache — avoids rebuilding per method.
const seqMethodMapCache = new Map<
  number,
  { map: Map<string, MethodInfo>; groups: Map<string, MethodInfo[]> }
>();

/** Provider-aware enclosing container lookup.
 *  Walks up from `node` until a CLASS_CONTAINER_TYPES node is found.
 *  When `resolveEnclosingOwner` is provided, delegates language-specific
 *  container remapping (e.g., Ruby singleton_class → enclosing class).
 *  Without the hook, returns the first matching container directly (raw lookup). */
function seqFindEnclosingOwnerNode(
  node: SyntaxNode,
  resolveEnclosingOwner?: (node: SyntaxNode) => SyntaxNode | null,
): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      if (resolveEnclosingOwner) {
        const resolved = resolveEnclosingOwner(current);
        if (resolved === null) {
          // Provider says skip this container — keep walking up.
          current = current.parent;
          continue;
        }
        return resolved;
      }
      return current;
    }
    current = current.parent;
  }
  return null;
}

const isCppClassMemberDeclarationNode = (node: SyntaxNode | null | undefined): boolean => {
  let current = node?.parent ?? null;
  while (current) {
    if (current.type === 'class_specifier' || current.type === 'struct_specifier') return true;
    if (current.type === 'function_definition' && /^\s*(class|struct)\b/.test(current.text))
      return true;
    current = current.parent;
  }
  return false;
};

/** Minimal no-op SymbolTable stub for sequential extractor contexts. The real
 *  SymbolTable is not fully populated yet at this stage, so use the stub for safety.
 *  Implements the full {@link SymbolTableReader} surface so future extractor additions
 *  don't silently fall off an `as unknown as` cast. */
const NOOP_SYMBOL_TABLE_SEQ: SymbolTableReader = {
  lookupExact: () => undefined,
  lookupExactFull: () => undefined,
  lookupExactAll: () => [],
  lookupCallableByName: () => [],
  getFiles: () => [][Symbol.iterator](),
  getStats: () => ({ fileCount: 0 }),
};

type SequentialTypeEnv = ReturnType<typeof buildTypeEnv>;

interface PreparedSequentialFile {
  file: { path: string; content: string };
  language: SupportedLanguages;
  lineOffset: number;
  isVueSetup: boolean;
  provider: LanguageProvider;
  matches: Parser.QueryMatch[];
  typeEnv: SequentialTypeEnv | null;
}

const resetSequentialCaches = (): void => {
  classInfoCache.clear();
  exportCache.clear();
  seqFieldInfoCache.clear();
  seqMethodExtractCache.clear();
  seqMethodMapCache.clear();
};

const prepareSequentialFile = async (
  parser: Parser,
  file: { path: string; content: string },
  astCache: ASTCache,
  skippedLanguages: Map<string, number>,
): Promise<PreparedSequentialFile | null> => {
  const language = getLanguageFromFilename(file.path);
  if (!language) return null;

  if (!isLanguageAvailable(language)) {
    skippedLanguages.set(language, (skippedLanguages.get(language) || 0) + 1);
    return null;
  }

  if (file.content.length > TREE_SITTER_MAX_BUFFER) return null;

  let parseContent = file.content;
  let lineOffset = 0;
  let isVueSetup = false;
  if (language === SupportedLanguages.Vue) {
    const extracted = extractVueScript(file.content);
    if (!extracted) return null;
    parseContent = extracted.scriptContent;
    lineOffset = extracted.lineOffset;
    isVueSetup = extracted.isSetup;
  }

  try {
    await loadLanguage(language, file.path);
  } catch {
    return null;
  }

  let tree;
  try {
    tree = parser.parse(parseContent, undefined, {
      bufferSize: getTreeSitterBufferSize(parseContent.length),
    });
  } catch {
    console.warn(`Skipping unparseable file: ${file.path}`);
    return null;
  }

  const maxAstNodes = getParseMaxAstNodes();
  const astNodeCount = tree.rootNode.descendantCount + 1;
  if (maxAstNodes !== null && astNodeCount > maxAstNodes) {
    return null;
  }

  const maxAstDepth = getParseMaxAstDepth();
  if (maxAstDepth !== null && exceedsParseMaxAstDepth(tree.rootNode, maxAstDepth)) {
    return null;
  }

  astCache.set(file.path, tree);

  const provider = getProvider(language);
  if (!provider.treeSitterQueries) return null;

  try {
    const query = new Parser.Query(parser.getLanguage(), provider.treeSitterQueries);
    const matches = query.matches(tree.rootNode);
    const typeEnv = provider.fieldExtractor
      ? buildTypeEnv(tree, language, {
          enclosingFunctionFinder: provider.enclosingFunctionFinder,
          extractFunctionName: provider.methodExtractor?.extractFunctionName,
        })
      : null;

    return {
      file,
      language,
      lineOffset,
      isVueSetup,
      provider,
      matches,
      typeEnv,
    };
  } catch (queryError) {
    console.warn(`Query error for ${file.path}:`, queryError);
    return null;
  }
};

const processSequentialFileMatches = (
  graph: KnowledgeGraph,
  symbolTable: SymbolTableWriter,
  preparedFile: PreparedSequentialFile,
  cppTypeOwnerHints: readonly CppTypeOwnerHint[] = [],
): void => {
  const { file, language, lineOffset, isVueSetup, provider, matches, typeEnv } = preparedFile;
  const knownTypeOwnerHints = collectKnownTypeOwnerHints(matches, provider, file.path);

  matches.forEach((match) => {
    const captureMap: Record<string, SyntaxNode> = {};

    match.captures.forEach((c) => {
      captureMap[c.name] = c.node;
    });

    const definitionNodeForRange = getDefinitionNodeFromCaptures(captureMap);
    const definitionNode = getDefinitionNodeFromCaptures(captureMap);
    const defaultNodeLabel = getLabelFromCaptures(captureMap, provider);
    if (!defaultNodeLabel) return;

    const nameNode = captureMap['name'];
    const extractedClassSymbol =
      definitionNode && provider.classExtractor?.isTypeDeclaration(definitionNode)
        ? provider.classExtractor.extract(definitionNode, {
            name: nameNode?.text,
            type: defaultNodeLabel,
          })
        : null;
    let nodeLabel = extractedClassSymbol?.type ?? defaultNodeLabel;
    if (!nameNode && nodeLabel !== 'Constructor' && !extractedClassSymbol) return;
    const cppTypeDeclarationName =
      language === SupportedLanguages.CPlusPlus &&
      (nodeLabel === 'Class' || nodeLabel === 'Struct') &&
      definitionNode
        ? extractCppTypeDeclarationNameAt(file.content, definitionNode.startIndex, {
            allowForwardDeclaration: true,
          })
        : null;
    const nodeName =
      cppTypeDeclarationName ?? extractedClassSymbol?.name ?? (nameNode ? nameNode.text : 'init');

    const startLine = definitionNodeForRange
      ? definitionNodeForRange.startPosition.row + lineOffset
      : nameNode
        ? nameNode.startPosition.row + lineOffset
        : lineOffset;

    const needsOwner =
      nodeLabel === 'Method' ||
      nodeLabel === 'Constructor' ||
      nodeLabel === 'Property' ||
      nodeLabel === 'Function';
    const qualifiedOwnerInfo = definitionNode
      ? findCppQualifiedOwnerInfo(
          definitionNode,
          file.path,
          language,
          knownTypeOwnerHints,
          cppTypeOwnerHints,
          nodeName,
        )
      : null;
    const enclosingClassInfo =
      qualifiedOwnerInfo ??
      (needsOwner
        ? cachedFindEnclosingClassInfo(
            nameNode || definitionNodeForRange,
            file.path,
            provider.resolveEnclosingOwner,
          )
        : null);
    const enclosingClassId = enclosingClassInfo?.classId ?? null;
    if (
      language === SupportedLanguages.CPlusPlus &&
      nodeLabel === 'Function' &&
      enclosingClassInfo
    ) {
      nodeLabel = 'Method';
    }
    if (
      language === SupportedLanguages.CPlusPlus &&
      nodeLabel === 'Function' &&
      isCppClassMemberDeclarationNode(definitionNode ?? nameNode)
    ) {
      return;
    }

    const qualifiedName = enclosingClassInfo
      ? `${enclosingClassInfo.className}.${nodeName}`
      : nodeName;

    const isMethodLike =
      nodeLabel === 'Function' || nodeLabel === 'Method' || nodeLabel === 'Constructor';
    let methodProps: Record<string, unknown> = {};
    let arityForId: number | undefined;
    let seqDefMethodInfo: MethodInfo | undefined;
    let seqDefMethods: MethodInfo[] | undefined;
    let seqClassNodeId: number | undefined;
    if (isMethodLike && definitionNode) {
      let enriched = false;

      if (provider.methodExtractor) {
        const methodOwnerNode = seqFindEnclosingOwnerNode(definitionNode);
        if (methodOwnerNode) {
          let result: { ownerName: string | undefined; methods: MethodInfo[] } | null | undefined =
            seqMethodExtractCache.get(methodOwnerNode.id);
          if (result === undefined) {
            result =
              provider.methodExtractor.extract(methodOwnerNode, {
                filePath: file.path,
                language,
              }) ?? null;
            seqMethodExtractCache.set(methodOwnerNode.id, result);
          }
          if (result?.methods?.length) {
            const defLine = definitionNode.startPosition.row + 1;
            const info = result.methods.find((m) => m.name === nodeName && m.line === defLine);
            if (info) {
              enriched = true;
              arityForId = arityForIdFromInfo(info);
              methodProps = buildMethodProps(info);
              seqDefMethodInfo = info;
              seqDefMethods = result.methods;
              seqClassNodeId = methodOwnerNode.id;
            }
          }
        }

        if (!enriched && provider.methodExtractor.extractFromNode) {
          const info = provider.methodExtractor.extractFromNode(definitionNode, {
            filePath: file.path,
            language,
          });
          if (info) {
            arityForId = arityForIdFromInfo(info);
            methodProps = buildMethodProps(info);
          }
        }
      }
    }

    const needsAritySuffix =
      nodeLabel === 'Method' ||
      nodeLabel === 'Constructor' ||
      (nodeLabel === 'Function' && language === SupportedLanguages.Swift && !!enclosingClassInfo);
    let arityTag = needsAritySuffix && arityForId !== undefined ? `#${arityForId}` : '';
    if (arityTag && seqDefMethods && seqDefMethodInfo && seqClassNodeId !== undefined) {
      let cached = seqMethodMapCache.get(seqClassNodeId);
      if (!cached) {
        const tempMap = new Map<string, MethodInfo>();
        for (const m of seqDefMethods) tempMap.set(`${m.name}:${m.line}`, m);
        cached = { map: tempMap, groups: buildCollisionGroups(tempMap) };
        seqMethodMapCache.set(seqClassNodeId, cached);
      }
      arityTag += typeTagForId(
        cached.map,
        nodeName,
        arityForId,
        seqDefMethodInfo,
        language,
        cached.groups,
      );
      arityTag += constTagForId(cached.map, nodeName, arityForId, seqDefMethodInfo, cached.groups);
    }
    const nodeIdFilePath =
      qualifiedOwnerInfo?.classFilePath &&
      (nodeLabel === 'Method' || nodeLabel === 'Constructor' || nodeLabel === 'Function')
        ? qualifiedOwnerInfo.classFilePath
        : file.path;
    const nodeId = generateId(nodeLabel, `${nodeIdFilePath}:${qualifiedName}${arityTag}`);
    const isSplitCppDefinition = Boolean(
      qualifiedOwnerInfo?.classFilePath && qualifiedOwnerInfo.classFilePath !== file.path,
    );
    const classNodeForSymbol = definitionNodeForRange || definitionNode || nameNode;
    const qualifiedTypeName =
      cppTypeDeclarationName ??
      extractedClassSymbol?.qualifiedName ??
      (classNodeForSymbol && provider.classExtractor?.isTypeDeclaration(classNodeForSymbol)
        ? (provider.classExtractor.extractQualifiedName(classNodeForSymbol, nodeName) ?? nodeName)
        : undefined);
    const frameworkHint = definitionNode
      ? detectFrameworkFromAST(language, (definitionNode.text || '').slice(0, 300))
      : null;

    const node: GraphNode = {
      id: nodeId,
      label: nodeLabel as NodeLabel,
      properties: {
        name: nodeName,
        filePath: file.path,
        startLine: definitionNodeForRange
          ? definitionNodeForRange.startPosition.row + lineOffset
          : startLine,
        endLine: definitionNodeForRange
          ? definitionNodeForRange.endPosition.row + lineOffset
          : startLine,
        ...(isSplitCppDefinition
          ? {
              declarationFilePath: qualifiedOwnerInfo!.classFilePath,
              ...(typeof qualifiedOwnerInfo!.declarationStartLine === 'number'
                ? { declarationStartLine: qualifiedOwnerInfo!.declarationStartLine }
                : {}),
              ...(typeof qualifiedOwnerInfo!.declarationEndLine === 'number'
                ? { declarationEndLine: qualifiedOwnerInfo!.declarationEndLine }
                : {}),
              definitionFilePath: file.path,
              definitionStartLine: definitionNodeForRange
                ? definitionNodeForRange.startPosition.row + lineOffset
                : startLine,
              definitionEndLine: definitionNodeForRange
                ? definitionNodeForRange.endPosition.row + lineOffset
                : startLine,
            }
          : {}),
        language,
        isExported:
          language === SupportedLanguages.Vue && isVueSetup
            ? isVueSetupTopLevel(nameNode || definitionNodeForRange)
            : cachedExportCheck(
                provider.exportChecker,
                nameNode || definitionNodeForRange,
                nodeName,
              ),
        ...(qualifiedTypeName !== undefined ? { qualifiedName: qualifiedTypeName } : {}),
        ...(frameworkHint
          ? {
              astFrameworkMultiplier: frameworkHint.entryPointMultiplier,
              astFrameworkReason: frameworkHint.reason,
            }
          : {}),
        ...methodProps,
      },
    };

    addOrMergeGraphNode(graph, node);

    let declaredType: string | undefined;
    let seqVisibility: string | undefined;
    let seqIsStatic: boolean | undefined;
    let seqIsReadonly: boolean | undefined;
    if (nodeLabel === 'Property' && definitionNode && provider.fieldExtractor && typeEnv) {
      const classNode = seqFindEnclosingOwnerNode(definitionNode, provider.resolveEnclosingOwner);
      if (classNode) {
        const fieldMap = seqGetFieldInfo(classNode, provider, {
          typeEnv,
          symbolTable: NOOP_SYMBOL_TABLE_SEQ,
          filePath: file.path,
          language,
        });
        const info = fieldMap?.get(nodeName);
        if (info) {
          declaredType = info.type ?? undefined;
          seqVisibility = info.visibility;
          seqIsStatic = info.isStatic;
          seqIsReadonly = info.isReadonly;
        }
      }
    }

    if (seqVisibility !== undefined) node.properties.visibility = seqVisibility;
    if (seqIsStatic !== undefined) node.properties.isStatic = seqIsStatic;
    if (seqIsReadonly !== undefined) node.properties.isReadonly = seqIsReadonly;
    if (declaredType !== undefined) node.properties.declaredType = declaredType;

    symbolTable.add(file.path, nodeName, nodeId, nodeLabel, {
      parameterCount: methodProps.parameterCount as number | undefined,
      requiredParameterCount: methodProps.requiredParameterCount as number | undefined,
      parameterTypes: methodProps.parameterTypes as string[] | undefined,
      returnType: methodProps.returnType as string | undefined,
      declaredType,
      ownerId: enclosingClassId ?? undefined,
      qualifiedName: qualifiedTypeName,
    });

    const fileId = generateId('File', file.path);
    graph.addRelationship({
      id: generateId('DEFINES', `${fileId}->${nodeId}`),
      sourceId: fileId,
      targetId: nodeId,
      type: 'DEFINES',
      confidence: 1.0,
      reason: '',
    });

    if (enclosingClassId) {
      const memberEdgeType = nodeLabel === 'Property' ? 'HAS_PROPERTY' : 'HAS_METHOD';
      graph.addRelationship({
        id: generateId(memberEdgeType, `${enclosingClassId}->${nodeId}`),
        sourceId: enclosingClassId,
        targetId: nodeId,
        type: memberEdgeType,
        confidence: 1.0,
        reason: '',
      });
    }
  });
};

const findFunctionDeclarator = (node: SyntaxNode): SyntaxNode | null => {
  let current = node.childForFieldName?.('declarator') ?? null;
  while (
    current &&
    (current.type === 'pointer_declarator' || current.type === 'reference_declarator')
  ) {
    current = current.childForFieldName?.('declarator') ?? null;
  }
  return current?.type === 'function_declarator' ? current : null;
};

const findCppQualifiedOwnerInfo = (
  node: SyntaxNode,
  filePath: string,
  language: SupportedLanguages,
  knownTypeOwnerHints: readonly CppTypeOwnerHint[],
  cppTypeOwnerHints: readonly CppTypeOwnerHint[] = [],
  memberName?: string,
): CppQualifiedOwnerInfo | null => {
  if (language !== SupportedLanguages.CPlusPlus || node.type !== 'function_definition') return null;

  const functionDeclarator = findFunctionDeclarator(node);
  const qualifiedIdentifier = functionDeclarator?.childForFieldName?.('declarator');
  if (qualifiedIdentifier?.type !== 'qualified_identifier') return null;

  const scopeNode =
    qualifiedIdentifier.childForFieldName?.('scope') ??
    qualifiedIdentifier.children?.find((child) =>
      ['namespace_identifier', 'type_identifier', 'identifier', 'qualified_identifier'].includes(
        child.type,
      ),
    );
  const scopeText = scopeNode?.text;
  if (!scopeText) return null;
  const ownerHint = resolveCppTypeOwnerHint(
    scopeText,
    filePath,
    knownTypeOwnerHints,
    cppTypeOwnerHints,
  );
  if (!ownerHint) return null;
  const declarationHint = memberName
    ? findCppMemberDeclarationHint(ownerHint, memberName)
    : undefined;

  return {
    classId: generateId(ownerHint.label, `${ownerHint.filePath}:${ownerHint.name}`),
    className: ownerHint.name,
    classFilePath: ownerHint.filePath,
    ...(declarationHint
      ? {
          declarationStartLine: declarationHint.startLine,
          declarationEndLine: declarationHint.endLine,
        }
      : {}),
  };
};

const collectKnownTypeOwnerHints = (
  matches: readonly Parser.QueryMatch[],
  provider: LanguageProvider,
  filePath: string,
): CppTypeOwnerHint[] => {
  const knownTypeOwnerHints: CppTypeOwnerHint[] = [];
  for (const match of matches) {
    const captureMap: Record<string, SyntaxNode> = {};
    match.captures.forEach((capture) => {
      captureMap[capture.name] = capture.node;
    });
    const label = getLabelFromCaptures(captureMap, provider);
    const name = captureMap['name']?.text;
    if (name && (label === 'Class' || label === 'Struct')) {
      const definitionNode = getDefinitionNodeFromCaptures(captureMap);
      const memberDeclarations =
        definitionNode?.text && typeof definitionNode.startPosition?.row === 'number'
          ? extractCppMemberDeclarationHints(definitionNode.text, definitionNode.startPosition.row)
          : [];
      knownTypeOwnerHints.push({
        name,
        label,
        filePath,
        ...(memberDeclarations.length > 0 ? { memberDeclarations } : {}),
      });
    }
  }
  return uniqueCppHints(knownTypeOwnerHints);
};

function seqGetFieldInfo(
  classNode: SyntaxNode,
  provider: LanguageProvider,
  context: FieldExtractorContext,
): Map<string, FieldInfo> | undefined {
  if (!provider.fieldExtractor) return undefined;
  const cacheKey = classNode.startIndex;
  let cached = seqFieldInfoCache.get(cacheKey);
  if (cached) return cached;
  const extracted = provider.fieldExtractor.extract(classNode, context);
  if (!extracted?.fields?.length) return undefined;
  cached = new Map<string, FieldInfo>();
  for (const field of extracted.fields) cached.set(field.name, field);
  seqFieldInfoCache.set(cacheKey, cached);
  return cached;
}

const processSequentialFiles = async (
  parser: Parser,
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTableWriter,
  astCache: ASTCache,
  skippedLanguages: Map<string, number>,
  onFileProgress?: FileProgressCallback,
): Promise<WorkerExtractedData> => {
  const total = files.length;
  const combinedData = createEmptyWorkerExtractedData();
  const mutationBuffer = createEmptyWorkerGraphMutationBuffer();
  const cppTypeOwnerIndex = buildCppTypeOwnerIndex(files);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    resetSequentialCaches();

    onFileProgress?.(i + 1, total, file.path);

    if (i % 20 === 0) await yieldToEventLoop();

    const preparedFile = await prepareSequentialFile(parser, file, astCache, skippedLanguages);
    if (!preparedFile) {
      // Lightweight fallback for oversized or unparseable files
      const language = getLanguageFromFilename(file.path);
      if (language && isLanguageAvailable(language)) {
        const lightweightResult = extractLightweight(file.path, file.content, language);
        appendWorkerExtractedData(
          combinedData,
          mergeWorkerChunkResults([lightweightResult], mutationBuffer as any),
        );
      }
      continue;
    }
    processSequentialFileMatches(
      graph,
      symbolTable,
      preparedFile,
      selectCppTypeOwnerHintsForFile(file, cppTypeOwnerIndex),
    );
  }

  applyWorkerGraphMutationBuffer(graph, symbolTable, mutationBuffer);
  return combinedData;
};

const processParsingSequential = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTableWriter,
  astCache: ASTCache,
  onFileProgress?: FileProgressCallback,
): Promise<WorkerExtractedData> => {
  const parser = await loadParser();
  const skippedLanguages = new Map<string, number>();
  const extractedData = await processSequentialFiles(
    parser,
    graph,
    files,
    symbolTable,
    astCache,
    skippedLanguages,
    onFileProgress,
  );

  logSkippedLanguages(skippedLanguages);
  return extractedData;
};

// ============================================================================
// Public API
// ============================================================================

export const processParsing = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  repoPathOrSymbolTable: string | SymbolTableWriter,
  symbolTableOrAstCache: SymbolTableWriter | ASTCache,
  astCacheOrOnFileProgress?: ASTCache | FileProgressCallback,
  onFileProgressOrWorkerPool?: FileProgressCallback | WorkerPool,
  workerPoolOrSubBatchStart?: WorkerPool | WorkerSubBatchStartCallback,
  onSubBatchStart?: WorkerSubBatchStartCallback,
  onWorkerResult?: WorkerResultCallback,
  workerFailureMode: ParseWorkerRetryPolicy = PARSE_WORKER_RETRY_POLICY_SEQUENTIAL,
): Promise<WorkerExtractedData | null> => {
  const legacySignature = typeof repoPathOrSymbolTable !== 'string';
  const repoPath = legacySignature ? '' : repoPathOrSymbolTable;
  const symbolTable = legacySignature
    ? repoPathOrSymbolTable
    : (symbolTableOrAstCache as SymbolTableWriter);
  const astCache = legacySignature
    ? (symbolTableOrAstCache as ASTCache)
    : (astCacheOrOnFileProgress as ASTCache);
  const onFileProgress = legacySignature
    ? (astCacheOrOnFileProgress as FileProgressCallback | undefined)
    : (onFileProgressOrWorkerPool as FileProgressCallback | undefined);
  const workerPool = legacySignature
    ? (onFileProgressOrWorkerPool as WorkerPool | undefined)
    : (workerPoolOrSubBatchStart as WorkerPool | undefined);
  const subBatchStartCallback = legacySignature
    ? (workerPoolOrSubBatchStart as WorkerSubBatchStartCallback | undefined)
    : onSubBatchStart;

  if (workerPool) {
    try {
      if (workerFailureMode === PARSE_WORKER_RETRY_POLICY_QUARANTINE) {
        return await processParsingWithAdaptiveWorkerRecovery(
          graph,
          files,
          repoPath,
          symbolTable,
          astCache,
          workerPool,
          onFileProgress,
          subBatchStartCallback,
          onWorkerResult,
        );
      }
      return await processParsingWithWorkers(
        graph,
        files,
        repoPath,
        symbolTable,
        astCache,
        workerPool,
        onFileProgress,
        subBatchStartCallback,
        onWorkerResult,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (workerFailureMode === PARSE_WORKER_RETRY_POLICY_QUARANTINE) {
        console.warn('Worker pool parsing failed, skipping degraded chunk:', reason);
        return createSkippedWorkerExtractedData(files, reason, true);
      }
      console.warn('Worker pool parsing failed, falling back to sequential:', reason);
    }
  }

  // Fallback: sequential parsing mutates the graph/symbol table directly and
  // intentionally has no worker-extracted data for parse-impl to consume.
  await processParsingSequential(graph, files, symbolTable, astCache, onFileProgress);
  return null;
};
