import type Parser from 'tree-sitter';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SupportedLanguages, type NodeLabel, type ParsedFile } from 'ontoindex-shared';
import type { MixedChainStep } from '../utils/call-analysis.js';
import type { ConstructorBinding } from '../type-env.js';
import type { NamedBinding } from '../named-bindings/types.js';
import type { ExtractedHeritage } from '../model/heritage-map.js';
import { buildTypeEnv } from '../type-env.js';
import type { LanguageProvider } from '../language-provider.js';
import type { MethodInfo } from '../method-types.js';
import type { FieldInfo } from '../field-types.js';

export { type LanguageProvider, type MethodInfo, type FieldInfo };

/** Stable serialized parse-worker protocol version for TS and future native workers. */
export const PARSE_WORKER_PROTOCOL_VERSION = 2;

/** Language grammar type accepted by Parser.setLanguage(). */
export type TreeSitterLanguage = Parameters<typeof Parser.prototype.setLanguage>[0];

export interface ParsedNode {
  id: string;
  label: string;
  properties: {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: SupportedLanguages;
    isExported: boolean;
    astFrameworkMultiplier?: number;
    astFrameworkReason?: string;
    description?: string;
    declarationFilePath?: string;
    declarationStartLine?: number;
    declarationEndLine?: number;
    definitionFilePath?: string;
    definitionStartLine?: number;
    definitionEndLine?: number;
    // Method/field metadata — extensible via buildMethodProps spread
    [key: string]: unknown;
  };
}

export interface ParsedRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'DEFINES' | 'HAS_METHOD' | 'HAS_PROPERTY';
  confidence: number;
  reason: string;
}

export interface ParsedSymbol {
  filePath: string;
  name: string;
  nodeId: string;
  type: NodeLabel;
  qualifiedName?: string;
  parameterCount?: number;
  requiredParameterCount?: number;
  parameterTypes?: string[];
  returnType?: string;
  declaredType?: string;
  ownerId?: string;
  visibility?: string;
  isStatic?: boolean;
  isReadonly?: boolean;
  isAbstract?: boolean;
  isFinal?: boolean;
  annotations?: string[];
  declarationFilePath?: string;
  declarationStartLine?: number;
  declarationEndLine?: number;
  definitionFilePath?: string;
  definitionStartLine?: number;
  definitionEndLine?: number;
}

export interface ExtractedImport {
  filePath: string;
  rawImportPath: string;
  language: SupportedLanguages;
  /** Named bindings from the import (e.g., import {User as U} → [{local:'U', exported:'User'}]) */
  namedBindings?: NamedBinding[];
}

export interface ExtractedCall {
  filePath: string;
  calledName: string;
  /** generateId of enclosing function, or generateId('File', filePath) for top-level */
  sourceId: string;
  /** From call AST; omitted for some seeds (e.g. Java `::`) so arity filter is skipped */
  argCount?: number;
  /** Discriminates free function calls from member/constructor calls */
  callForm?: 'free' | 'member' | 'constructor';
  /** Simple identifier of the receiver for member calls (e.g., 'user' in user.save()) */
  receiverName?: string;
  /** Resolved type name of the receiver (e.g., 'User' for user.save() when user: User) */
  receiverTypeName?: string;
  /**
   * Unified mixed chain when the receiver is a chain of field accesses and/or method calls.
   * Steps are ordered base-first (innermost to outermost). Examples:
   *   `svc.getUser().save()`        → chain=[{kind:'call',name:'getUser'}], receiverName='svc'
   *   `user.address.save()`         → chain=[{kind:'field',name:'address'}], receiverName='user'
   *   `svc.getUser().address.save()` → chain=[{kind:'call',name:'getUser'},{kind:'field',name:'address'}]
   * Length is capped at MAX_CHAIN_DEPTH (3).
   */
  receiverMixedChain?: MixedChainStep[];
  argTypes?: (string | undefined)[];
}

export interface CppTypeOwnerHint {
  name: string;
  label: 'Class' | 'Struct';
  filePath: string;
  memberDeclarations?: CppMemberDeclarationHint[];
}

export interface CppMemberDeclarationHint {
  name: string;
  startLine: number;
  endLine: number;
}

export interface ExtractedAssignment {
  filePath: string;
  /** generateId of enclosing function, or generateId('File', filePath) for top-level */
  sourceId: string;
  /** Receiver text (e.g., 'user' from user.address = value) */
  receiverText: string;
  /** Property name being written (e.g., 'address') */
  propertyName: string;
  /** Resolved type name of the receiver if available from TypeEnv */
  receiverTypeName?: string;
}

export interface ExtractedRoute {
  filePath: string;
  httpMethod: string;
  routePath: string | null;
  controllerName: string | null;
  methodName: string | null;
  middleware: string[];
  prefix: string | null;
  lineNumber: number;
}

export interface ExtractedFetchCall {
  filePath: string;
  fetchURL: string;
  lineNumber: number;
}

export interface ExtractedDecoratorRoute {
  filePath: string;
  routePath: string | null;
  httpMethod: string;
  decoratorName: string;
  lineNumber: number;
}

export interface ExtractedToolDef {
  filePath: string;
  toolName: string;
  description: string;
  lineNumber: number;
}

export interface ExtractedORMQuery {
  filePath: string;
  orm: 'prisma' | 'supabase';
  model: string;
  method: string;
  lineNumber: number;
}

/** Constructor bindings keyed by filePath for cross-file type resolution */
export interface FileConstructorBindings {
  filePath: string;
  bindings: ConstructorBinding[];
}

/** All-scope type bindings from TypeEnv — includes function-local scopes.
 *  Used by BindingAccumulator for cross-file type propagation (Phase 9+). */
export interface FileScopeBindings {
  filePath: string;
  /** [varName, typeName] pairs from the file scope only. */
  bindings: [string, string][];
}

export interface ParseFileTiming {
  filePath: string;
  language?: SupportedLanguages;
  durationMs: number;
  status: 'processed' | 'skipped' | 'error';
}

export interface ParseExtractorTiming {
  family: string;
  filePath?: string;
  language?: SupportedLanguages;
  durationMs: number;
  count?: number;
}

export interface ParseWorkerResult {
  nodes: ParsedNode[];
  relationships: ParsedRelationship[];
  symbols: ParsedSymbol[];
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
  /** All-scope type bindings from TypeEnv for BindingAccumulator (includes function-local). */
  fileScopeBindings: FileScopeBindings[];
  /**
   * Per-file `ParsedFile` artifacts from the new scope-based resolution
   * pipeline (RFC #909 Ring 2).
   */
  parsedFiles: ParsedFile[];
  /** Paths of every file successfully processed by this worker, populated unconditionally. */
  processedPaths: string[];
  /** Per-file worker timing for large-repo failure and hotspot localization. */
  fileTimings: ParseFileTiming[];
  /** Per-extractor-family timing for large-repo hotspot localization. */
  extractorTimings: ParseExtractorTiming[];
  skippedLanguages: Record<string, number>;
  fileCount: number;
}

export interface ParseWorkerInput {
  path: string;
  content?: string;
  contentSource?: 'content' | 'path';
  repoPath?: string;
  routeFilePatterns?: string[];
  componentFilePatterns?: string[];
  prismaClientIdentifiers?: string[];
  supabaseClientIdentifiers?: string[];
  cppTypeOwnerHints?: CppTypeOwnerHint[];
}

export interface HydratedParseWorkerInput extends ParseWorkerInput {
  content: string;
}

export const isPathBasedParseWorkerInput = (input: ParseWorkerInput): boolean =>
  input.contentSource === 'path';

export const resolveParseWorkerInputPath = (repoPath: string, filePath: string): string => {
  if (path.isAbsolute(filePath)) {
    throw new Error(`Path-based parse worker input must be repo-relative: ${filePath}`);
  }

  const repoRoot = path.resolve(repoPath);
  const absolutePath = path.resolve(repoRoot, filePath);
  const relativeToRoot = path.relative(repoRoot, absolutePath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Path-based parse worker input escapes repo root: ${filePath}`);
  }
  return absolutePath;
};

export const hydrateParseWorkerInput = async (
  input: ParseWorkerInput,
): Promise<HydratedParseWorkerInput> => {
  if (isPathBasedParseWorkerInput(input)) {
    if (!input.repoPath) {
      throw new Error(`Path-based parse worker input missing repoPath for ${input.path}`);
    }
    const content = await fs.readFile(
      resolveParseWorkerInputPath(input.repoPath, input.path),
      'utf8',
    );
    return { ...input, content };
  }

  if (typeof input.content !== 'string') {
    throw new Error(`Content-based parse worker input missing content for ${input.path}`);
  }
  return input as HydratedParseWorkerInput;
};

export const hydrateParseWorkerInputs = async (
  inputs: ParseWorkerInput[],
): Promise<HydratedParseWorkerInput[]> => Promise.all(inputs.map(hydrateParseWorkerInput));

export interface PreparedFileContext {
  parseContent: string;
  lineOffset: number;
  isVueSetup: boolean;
  tree: Parser.Tree;
  matches: Parser.QueryMatch[];
  provider: LanguageProvider;
}

export interface FileProcessingState extends PreparedFileContext {
  file: ParseWorkerInput;
  language: SupportedLanguages;
  typeEnv: ReturnType<typeof buildTypeEnv>;
  callRouter: LanguageProvider['callRouter'];
}

export interface ParseWorkerDiagnostics {
  workerIndex?: number;
  workerIsolation?: 'thread' | 'process';
  subBatchIndex?: number;
  subBatchSize?: number;
  workerChunkSize?: number;
  firstFilePath?: string;
  lastFilePath?: string;
  currentFilePath?: string;
  lastProcessedFilePath?: string;
  filesProcessed?: number;
  phase?: string;
}

export type WorkerIncomingMessage =
  | { type: 'sub-batch'; files: ParseWorkerInput[]; diagnostics?: ParseWorkerDiagnostics }
  | { type: 'flush'; diagnostics?: ParseWorkerDiagnostics }
  | ParseWorkerInput[];

export type WorkerOutgoingMessage =
  | { type: 'progress'; filesProcessed: number; filePath?: string }
  | { type: 'diagnostic'; diagnostics: ParseWorkerDiagnostics }
  | { type: 'warning'; message: string; diagnostics?: ParseWorkerDiagnostics }
  | { type: 'result-part'; data: ParseWorkerResult }
  | { type: 'sub-batch-done' }
  | { type: 'error'; error: string; diagnostics?: ParseWorkerDiagnostics }
  | { type: 'result'; data?: ParseWorkerResult };

/**
 * Use a loop instead of push(...spread) to avoid hitting V8's argument limit
 * when merging large result sets (push(...arr) calls apply() under the hood
 * and blows the stack when arr has >~65k elements).
 */
export const appendAll = <T>(target: T[], src: T[]) => {
  if (!src) return;
  for (let i = 0; i < src.length; i++) target.push(src[i]);
};

export const mergeParseWorkerResult = (target: ParseWorkerResult, src: ParseWorkerResult): void => {
  appendAll(target.nodes, src.nodes);
  appendAll(target.relationships, src.relationships);
  appendAll(target.symbols, src.symbols);
  appendAll(target.imports, src.imports);
  appendAll(target.calls, src.calls);
  appendAll(target.assignments, src.assignments);
  appendAll(target.heritage, src.heritage);
  appendAll(target.routes, src.routes);
  appendAll(target.fetchCalls, src.fetchCalls);
  appendAll(target.decoratorRoutes, src.decoratorRoutes);
  appendAll(target.toolDefs, src.toolDefs);
  appendAll(target.ormQueries, src.ormQueries);
  appendAll(target.constructorBindings, src.constructorBindings);
  appendAll(target.fileScopeBindings, src.fileScopeBindings);
  appendAll(target.parsedFiles, src.parsedFiles);
  appendAll(target.processedPaths, src.processedPaths);
  appendAll(target.fileTimings, src.fileTimings);
  appendAll(target.extractorTimings, src.extractorTimings);
  for (const [lang, count] of Object.entries(src.skippedLanguages)) {
    target.skippedLanguages[lang] = (target.skippedLanguages[lang] || 0) + count;
  }
  target.fileCount += src.fileCount;
};

/**
 * Empty ParseWorkerResult template.
 */
export const createEmptyResult = (): ParseWorkerResult => ({
  nodes: [],
  relationships: [],
  symbols: [],
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
  parsedFiles: [],
  processedPaths: [],
  fileTimings: [],
  extractorTimings: [],
  skippedLanguages: {},
  fileCount: 0,
});
