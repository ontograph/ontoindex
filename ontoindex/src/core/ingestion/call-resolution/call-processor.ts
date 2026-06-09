import Parser from 'tree-sitter';
import { KnowledgeGraph } from '../../graph/types.js';
import { ResolutionContext, TIER_CONFIDENCE } from '../model/resolution-context.js';
import { HeritageMap, lookupMethodByOwnerWithMRO } from '../model/index.js';
import { generateId } from '../../../lib/utils.js';
import { yieldToEventLoop } from '../utils/event-loop.js';
import {
  ExtractedCall,
  FileConstructorBindings,
  ExtractedFetchCall,
} from '../workers/parse-worker.js';
import { extractReturnTypeName } from '../type-extractors/shared.js';
import {
  CLASS_LIKE_TYPES,
  INSTANTIABLE_CLASS_TYPES,
  ReceiverTypeIndex,
  extractFuncNameFromSourceId,
  lookupReceiverType,
  buildFileReceiverTypeIndexes,
  resolveFieldOwnership,
  ResolveResult,
  findInterfaceDispatchTargets,
  buildReceiverTypeIndex,
  verifyConstructorBindings,
} from './utils.js';
import { inferCallForm } from '../utils/call-analysis.js';
import {
  SymbolDefinition,
  getLanguageFromFilename,
  SupportedLanguages,
  MroStrategy,
} from 'ontoindex-shared';
import { ASTCache } from '../ast-cache.js';
import { buildTypeEnv, TypeEnvironment } from '../type-env.js';
import { getProvider } from '../languages/index.js';
import { isLanguageAvailable, loadParser, loadLanguage } from '../../tree-sitter/parser-loader.js';
import { getTreeSitterBufferSize } from '../constants.js';
import { BindingAccumulator } from '../binding-accumulator.js';

const buildCaptureMap = (match: Parser.QueryMatch): Record<string, any> => {
  const map: Record<string, any> = {};
  for (const c of match.captures) {
    map[c.name] = c.node;
  }
  return map;
};

export type WidenCache = Map<string, string>;

/** Shorthand for method lookup result */
interface MethodLookupResult {
  def: SymbolDefinition;
  tier: string;
}

/**
 * Field resolution result
 */
export interface FieldResolution {
  fieldNodeId: string;
  typeName?: string;
}

const TYPE_PRESERVING_METHODS = new Set(['unwrap', 'clone', 'as_ref', 'as_mut', 'to_owned']);

/**
 * Resolve a field access to its type.
 * Returns { fieldNodeId, typeName } if found.
 */
const resolveFieldAccessType = (
  receiverTypeName: string,
  fieldName: string,
  filePath: string,
  ctx: ResolutionContext,
): FieldResolution | undefined => {
  const fieldDef = resolveFieldOwnership(receiverTypeName, fieldName, filePath, ctx);
  if (!fieldDef) return undefined;

  return {
    fieldNodeId: fieldDef.nodeId,
    typeName: fieldDef.declaredType ? extractReturnTypeName(fieldDef.declaredType) : undefined,
  };
};

/**
 * Resolve a method by owner type name using the eagerly-populated methodByOwner index.
 */
const resolveMethodByOwner = (
  ownerTypeName: string,
  methodName: string,
  filePath: string,
  ctx: ResolutionContext,
  heritageMap?: HeritageMap,
  argCount?: number,
): MethodLookupResult | undefined => {
  const typeResolved = ctx.resolve(ownerTypeName, filePath);
  if (!typeResolved) return undefined;

  const classCandidates = typeResolved.candidates.filter((c) => CLASS_LIKE_TYPES.has(c.type));
  if (classCandidates.length === 0) return undefined;

  const lang = getLanguageFromFilename(filePath);
  const strategy: MroStrategy = lang === 'ruby' ? 'ruby-mixin' : 'first-wins';

  const uniqueHits = new Map<string, MethodLookupResult>();
  for (const candidate of classCandidates) {
    if (!heritageMap) continue;
    const hit = lookupMethodByOwnerWithMRO(
      candidate.nodeId,
      methodName,
      heritageMap,
      ctx.model,
      strategy,
      argCount,
    );
    if (hit) {
      uniqueHits.set(hit.nodeId, { def: hit, tier: typeResolved.tier });
    }
  }

  if (uniqueHits.size === 1) {
    return Array.from(uniqueHits.values())[0];
  }
  return undefined;
};

const toResolveResult = (def: SymbolDefinition, tier: string): ResolveResult => ({
  nodeId: def.nodeId,
  confidence: TIER_CONFIDENCE[tier as keyof typeof TIER_CONFIDENCE] || 0.5,
  reason: tier,
  returnType: def.returnType,
});

/**
 * Resolve a member call (obj.method()).
 */
export const resolveMemberCall = (
  receiverTypeName: string,
  methodName: string,
  filePath: string,
  ctx: ResolutionContext,
  argCount?: number,
  heritageMap?: HeritageMap,
): ResolveResult | null => {
  const owned = resolveMethodByOwner(
    receiverTypeName,
    methodName,
    filePath,
    ctx,
    heritageMap,
    argCount,
  );
  if (owned) {
    return toResolveResult(owned.def, owned.tier);
  }
  return null;
};

/**
 * Resolve a free call (func()).
 */
export const resolveFreeCall = (
  funcName: string,
  filePath: string,
  ctx: ResolutionContext,
  argCount?: number,
): ResolveResult | null => {
  const resolved = ctx.resolve(funcName, filePath);
  if (!resolved || resolved.candidates.length === 0) return null;

  const callable = resolved.candidates.filter(
    (c) => c.type === 'Function' || c.type === 'Method' || c.type === 'Constructor',
  );

  if (callable.length === 1) {
    return toResolveResult(callable[0], resolved.tier);
  }

  // Swift/Kotlin fast path: if it's a class/struct/enum, treat as implicit constructor
  const typeNode = resolved.candidates.find(
    (c) => c.type === 'Class' || c.type === 'Struct' || c.type === 'Enum',
  );
  if (typeNode) {
    return toResolveResult(typeNode, resolved.tier);
  }

  return null;
};

/**
 * Resolve a static call (Class.method() or new Class()).
 */
export const resolveStaticCall = (
  className: string,
  methodName: string,
  filePath: string,
  ctx: ResolutionContext,
  argCount?: number,
): ResolveResult | null => {
  const typeResolved = ctx.resolve(className, filePath);
  if (!typeResolved) return null;

  const classCandidates = typeResolved.candidates.filter((c) => CLASS_LIKE_TYPES.has(c.type));
  if (classCandidates.length === 0) return null;

  // Constructor check
  if (methodName === className) {
    const instantiable = classCandidates.filter((c) => INSTANTIABLE_CLASS_TYPES.has(c.type));
    if (instantiable.length === 1) {
      return toResolveResult(instantiable[0], typeResolved.tier);
    }
  }

  return resolveMemberCall(className, methodName, filePath, ctx, argCount);
};

/**
 * Main call resolution dispatcher.
 */
export const resolveCallTarget = (
  call: { calledName: string; callForm: string; receiverTypeName?: string; receiverName?: string },
  filePath: string,
  ctx: ResolutionContext,
  argCount?: number,
  heritageMap?: HeritageMap,
): ResolveResult | null => {
  if (call.callForm === 'constructor') {
    return resolveStaticCall(call.calledName, call.calledName, filePath, ctx, argCount);
  }

  if (call.callForm === 'member' && call.receiverTypeName) {
    return resolveMemberCall(
      call.receiverTypeName,
      call.calledName,
      filePath,
      ctx,
      argCount,
      heritageMap,
    );
  }

  if (call.callForm === 'free') {
    return resolveFreeCall(call.calledName, filePath, ctx, argCount);
  }

  return null;
};

/**
 * Create a deduplicated ACCESSES edge emitter for a single source node.
 */
export const makeAccessEmitter = (
  graph: KnowledgeGraph,
  sourceId: string,
): ((fieldNodeId: string) => void) => {
  const emitted = new Set<string>();
  return (fieldNodeId: string): void => {
    const key = `${sourceId}\0${fieldNodeId}`;
    if (emitted.has(key)) return;
    emitted.add(key);

    graph.addRelationship({
      id: generateId('ACCESSES', `${sourceId}:${fieldNodeId}:read`),
      sourceId,
      targetId: fieldNodeId,
      type: 'ACCESSES',
      confidence: 1.0,
      reason: 'read',
    });
  };
};

export const walkMixedChain = (
  chain: any[],
  startType: string,
  filePath: string,
  ctx: ResolutionContext,
  onFieldResolved?: (fieldNodeId: string) => void,
  heritageMap?: HeritageMap,
): string | undefined => {
  let currentType: string | undefined = startType;
  for (const step of chain) {
    if (!currentType) break;
    if (step.kind === 'field') {
      const resolved = resolveFieldAccessType(currentType, step.name, filePath, ctx);
      if (!resolved) {
        currentType = undefined;
        break;
      }
      onFieldResolved?.(resolved.fieldNodeId);
      currentType = resolved.typeName;
    } else {
      const owned = resolveMethodByOwner(currentType, step.name, filePath, ctx, heritageMap);
      if (owned?.def.returnType) {
        const fastRetType = extractReturnTypeName(owned.def.returnType);
        if (fastRetType) {
          currentType = fastRetType;
          continue;
        }
      }
      const resolved = resolveCallTarget(
        { calledName: step.name, callForm: 'member', receiverTypeName: currentType },
        filePath,
        ctx,
        undefined,
        heritageMap,
      );
      if (!resolved || !resolved.returnType) {
        currentType = undefined;
        break;
      }
      currentType = extractReturnTypeName(resolved.returnType);
    }
  }
  return currentType;
};

const findImportedComponentTargetPath = (
  filePath: string,
  calledName: string,
  ctx: ResolutionContext,
  allowedExtensions: readonly string[],
): string | undefined => {
  const importedFiles = ctx.importMap.get(filePath);
  if (!importedFiles) return undefined;

  for (const importedPath of importedFiles) {
    if (!allowedExtensions.some((extension) => importedPath.endsWith(extension))) continue;
    const basename = importedPath.slice(
      importedPath.lastIndexOf('/') + 1,
      importedPath.lastIndexOf('.'),
    );
    if (basename === calledName) return importedPath;
  }

  return undefined;
};

const emitVueTemplateComponentFallback = (
  graph: KnowledgeGraph,
  effectiveCall: ExtractedCall,
  ctx: ResolutionContext,
): void => {
  if (!effectiveCall.filePath.endsWith('.vue') || !effectiveCall.sourceId.startsWith('File:')) {
    return;
  }

  const targetPath = findImportedComponentTargetPath(
    effectiveCall.filePath,
    effectiveCall.calledName,
    ctx,
    ['.vue'],
  );
  if (!targetPath) return;

  const targetFileId = generateId('File', targetPath);
  if (!graph.getNode(targetFileId)) return;

  graph.addRelationship({
    id: generateId(
      'CALLS',
      `${effectiveCall.sourceId}:${effectiveCall.calledName}->${targetFileId}`,
    ),
    sourceId: effectiveCall.sourceId,
    targetId: targetFileId,
    type: 'CALLS',
    confidence: 0.9,
    reason: 'vue-template-component',
  });
};

const emitJsxComponentFallback = (
  graph: KnowledgeGraph,
  effectiveCall: ExtractedCall,
  ctx: ResolutionContext,
): void => {
  if (
    (!effectiveCall.filePath.endsWith('.tsx') && !effectiveCall.filePath.endsWith('.jsx')) ||
    !effectiveCall.sourceId.startsWith('File:')
  ) {
    return;
  }

  const targetPath = findImportedComponentTargetPath(
    effectiveCall.filePath,
    effectiveCall.calledName,
    ctx,
    ['.tsx', '.jsx', '.ts', '.js'],
  );
  if (!targetPath) return;

  const targetFileId = generateId('File', targetPath);
  if (!graph.getNode(targetFileId)) return;

  graph.addRelationship({
    id: generateId(
      'CALLS',
      `${effectiveCall.sourceId}:jsx-${effectiveCall.calledName}->${targetFileId}`,
    ),
    sourceId: effectiveCall.sourceId,
    targetId: targetFileId,
    type: 'CALLS',
    confidence: 0.85,
    reason: 'jsx-component',
  });
};

const emitResolvedCallEdges = (
  graph: KnowledgeGraph,
  effectiveCall: ExtractedCall,
  resolved: ResolveResult,
  ctx: ResolutionContext,
  heritageMap?: HeritageMap,
): void => {
  const relId = generateId(
    'CALLS',
    `${effectiveCall.sourceId}:${effectiveCall.calledName}->${resolved.nodeId}`,
  );
  graph.addRelationship({
    id: relId,
    sourceId: effectiveCall.sourceId,
    targetId: resolved.nodeId,
    type: 'CALLS',
    confidence: resolved.confidence,
    reason: resolved.reason,
  });

  if (heritageMap && effectiveCall.callForm === 'member' && effectiveCall.receiverTypeName) {
    const implTargets = findInterfaceDispatchTargets(
      effectiveCall.calledName,
      effectiveCall.receiverTypeName,
      effectiveCall.filePath,
      ctx,
      heritageMap,
      resolved.nodeId,
    );
    for (const impl of implTargets) {
      graph.addRelationship({
        id: generateId(
          'CALLS',
          `${effectiveCall.sourceId}:${effectiveCall.calledName}->${impl.nodeId}`,
        ),
        sourceId: effectiveCall.sourceId,
        targetId: impl.nodeId,
        type: 'CALLS',
        confidence: impl.confidence,
        reason: impl.reason,
      });
    }
  }
};

const resolveEffectiveExtractedCall = (
  call: ExtractedCall,
  receiverMap: ReceiverTypeIndex | undefined,
  ctx: ResolutionContext,
  graph: KnowledgeGraph,
  heritageMap?: HeritageMap,
): ExtractedCall => {
  let effectiveCall = call;

  if (!call.receiverTypeName && call.receiverName && receiverMap) {
    const callFuncName = extractFuncNameFromSourceId(call.sourceId);
    const resolvedType = lookupReceiverType(receiverMap, callFuncName, call.receiverName);
    if (resolvedType) {
      effectiveCall = { ...call, receiverTypeName: resolvedType };
    }
  }

  if (effectiveCall.receiverMixedChain?.length) {
    let currentType: string | undefined = effectiveCall.receiverTypeName;
    if (!currentType && effectiveCall.receiverName && receiverMap) {
      const callFuncName = extractFuncNameFromSourceId(effectiveCall.sourceId);
      currentType = lookupReceiverType(receiverMap, callFuncName, effectiveCall.receiverName);
    }
    if (currentType) {
      const walkedType = walkMixedChain(
        effectiveCall.receiverMixedChain,
        currentType,
        effectiveCall.filePath,
        ctx,
        makeAccessEmitter(graph, effectiveCall.sourceId),
        heritageMap,
      );
      if (walkedType) {
        effectiveCall = { ...effectiveCall, receiverTypeName: walkedType };
      }
    }
  }

  return effectiveCall;
};

export const processExtractedCallsForFile = (
  graph: KnowledgeGraph,
  filePath: string,
  calls: ExtractedCall[],
  ctx: ResolutionContext,
  receiverMap: ReceiverTypeIndex | undefined,
  heritageMap?: HeritageMap,
): void => {
  ctx.enableCache(filePath);
  try {
    for (const call of calls) {
      const effectiveCall = resolveEffectiveExtractedCall(
        call,
        receiverMap,
        ctx,
        graph,
        heritageMap,
      );
      const effectiveForm = effectiveCall.callForm || 'free';
      const callArgs = {
        calledName: effectiveCall.calledName,
        callForm: effectiveForm,
        receiverTypeName: effectiveCall.receiverTypeName,
        receiverName: effectiveCall.receiverName,
      };
      const resolved = resolveCallTarget(
        callArgs,
        effectiveCall.filePath,
        ctx,
        effectiveCall.argTypes?.length,
        heritageMap,
      );

      if (!resolved) {
        emitVueTemplateComponentFallback(graph, effectiveCall, ctx);
        emitJsxComponentFallback(graph, effectiveCall, ctx);
        continue;
      }

      emitResolvedCallEdges(graph, effectiveCall, resolved, ctx, heritageMap);
    }
  } finally {
    ctx.clearCache();
  }
};

const groupExtractedCallsByFile = (
  extractedCalls: ExtractedCall[],
): Map<string, ExtractedCall[]> => {
  const byFile = new Map<string, ExtractedCall[]>();
  for (const call of extractedCalls) {
    let list = byFile.get(call.filePath);
    if (!list) {
      list = [];
      byFile.set(call.filePath, list);
    }
    list.push(call);
  }
  return byFile;
};

export const processCallsFromExtracted = async (
  graph: KnowledgeGraph,
  extractedCalls: ExtractedCall[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
  constructorBindings?: FileConstructorBindings[],
  heritageMap?: HeritageMap,
  bindingAccumulator?: BindingAccumulator,
) => {
  const fileReceiverTypes = buildFileReceiverTypeIndexes(
    constructorBindings,
    ctx,
    graph,
    bindingAccumulator,
  );
  const byFile = groupExtractedCallsByFile(extractedCalls);
  const totalFiles = byFile.size;
  let filesProcessed = 0;

  for (const [filePath, calls] of byFile) {
    filesProcessed++;
    if (filesProcessed % 100 === 0) {
      onProgress?.(filesProcessed, totalFiles);
      await yieldToEventLoop();
    }

    const receiverMap = fileReceiverTypes.get(filePath);
    processExtractedCallsForFile(graph, filePath, calls, ctx, receiverMap, heritageMap);
  }

  onProgress?.(totalFiles, totalFiles);
};

type SequentialCallInput = { path: string; content: string };

interface PreparedSequentialFile {
  file: SequentialCallInput;
  language: SupportedLanguages;
  provider: any;
  tree: Parser.Tree;
  matches: Parser.QueryMatch[];
  parentMap: ReadonlyMap<string, readonly string[]>;
  typeEnv: TypeEnvironment;
}

const buildSequentialReceiverIndex = (
  typeEnv: TypeEnvironment,
  filePath: string,
  ctx: ResolutionContext,
  bindingAccumulator?: BindingAccumulator,
): ReceiverTypeIndex => {
  const verifiedReceivers = verifyConstructorBindings(
    typeEnv.constructorBindings,
    filePath,
    ctx,
    undefined,
    bindingAccumulator,
  );
  return buildReceiverTypeIndex(verifiedReceivers);
};

const resolvePreparedSequentialFile = (
  preparedFile: PreparedSequentialFile,
  ctx: ResolutionContext,
  graph: KnowledgeGraph,
  heritageMap: HeritageMap,
  bindingAccumulator?: BindingAccumulator,
): void => {
  const { file, typeEnv } = preparedFile;
  const receiverIndex = buildSequentialReceiverIndex(typeEnv, file.path, ctx, bindingAccumulator);

  ctx.enableCache(file.path);
  try {
    for (const match of preparedFile.matches) {
      const callNode = match.captures.find((c) => c.name === 'call')?.node;
      const nameNode = match.captures.find((c) => c.name === 'call.name')?.node;
      if (!callNode || !nameNode) continue;
      const callForm = inferCallForm(callNode, nameNode);

      const calledName = match.captures.find((c) => c.name === 'call.name')?.node.text;
      if (!calledName) continue;

      const receiverNode = match.captures.find((c) => c.name === 'call.receiver')?.node;
      const receiverName = receiverNode?.text;

      let receiverTypeName: string | undefined;
      if (receiverName) {
        const funcName = ''; // Sequential path doesn't currently carry scope info for receiver lookup
        receiverTypeName = lookupReceiverType(receiverIndex, funcName, receiverName);
      }

      const effectiveCall = {
        calledName,
        callForm,
        receiverTypeName,
        receiverName,
        sourceId: generateId('File', file.path),
        filePath: file.path,
      };

      const resolved = resolveCallTarget(effectiveCall, file.path, ctx, undefined, heritageMap);
      if (resolved) {
        emitResolvedCallEdges(graph, effectiveCall as any, resolved, ctx, heritageMap);
      }
    }
  } finally {
    ctx.clearCache();
  }
};

export const processCalls = async (
  graph: KnowledgeGraph,
  files: SequentialCallInput[],
  ctx: ResolutionContext,
  heritageMap: HeritageMap,
  onProgress?: (current: number, total: number) => void,
  bindingAccumulator?: BindingAccumulator,
): Promise<void> => {
  const parser = await loadParser();
  const prepared: PreparedSequentialFile[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 20 === 0) {
      onProgress?.(i, files.length * 2);
      await yieldToEventLoop();
    }

    const language = getLanguageFromFilename(file.path);
    if (!language || !isLanguageAvailable(language)) continue;

    const provider = getProvider(language);
    if (!provider.treeSitterQueries) continue;

    await loadLanguage(language, file.path);
    const tree = parser.parse(file.content);
    const query = new Parser.Query(parser.getLanguage(), provider.treeSitterQueries);
    const matches = query.matches(tree.rootNode);

    const typeEnv = buildTypeEnv(tree, language);

    prepared.push({
      file,
      language,
      provider,
      tree,
      matches,
      parentMap: new Map(),
      typeEnv,
    });
  }

  for (let i = 0; i < prepared.length; i++) {
    if (i % 20 === 0) {
      onProgress?.(files.length + i, files.length * 2);
      await yieldToEventLoop();
    }
    resolvePreparedSequentialFile(prepared[i], ctx, graph, heritageMap, bindingAccumulator);
  }

  onProgress?.(files.length * 2, files.length * 2);
};

/**
 * Extract fetch() calls from source files (sequential path).
 */
export const extractFetchCallsFromFiles = async (
  files: { path: string; content: string }[],
  astCache: ASTCache,
): Promise<ExtractedFetchCall[]> => {
  const parser = await loadParser();
  const result: ExtractedFetchCall[] = [];

  for (const file of files) {
    const language = getLanguageFromFilename(file.path);
    if (!language) continue;
    if (!isLanguageAvailable(language)) continue;

    const provider = getProvider(language);
    if (!provider.treeSitterQueries) continue;

    await loadLanguage(language, file.path);

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, {
          bufferSize: getTreeSitterBufferSize(file.content.length),
        });
      } catch {
        continue;
      }
      astCache.set(file.path, tree);
    }

    let matches;
    try {
      const lang = parser.getLanguage();
      const query = new Parser.Query(lang, provider.treeSitterQueries);
      matches = query.matches(tree.rootNode);
    } catch {
      continue;
    }

    for (const match of matches) {
      const captureMap: any = {};
      match.captures.forEach((c) => {
        captureMap[c.name] = c.node;
      });

      if (captureMap['route.fetch']) {
        const urlNode = captureMap['route.url'] ?? captureMap['route.template_url'];
        if (urlNode) {
          result.push({
            filePath: file.path,
            fetchURL: urlNode.text,
            lineNumber: captureMap['route.fetch'].startPosition.row,
          });
        }
      } else if (captureMap['http_client'] && captureMap['http_client.url']) {
        const method = captureMap['http_client.method']?.text;
        const url = captureMap['http_client.url'].text;
        const HTTP_CLIENT_ONLY = new Set(['head', 'options', 'request', 'ajax']);
        if (method && HTTP_CLIENT_ONLY.has(method) && url.startsWith('/')) {
          result.push({
            filePath: file.path,
            fetchURL: url,
            lineNumber: captureMap['http_client'].startPosition.row,
          });
        }
      }
    }
  }

  return result;
};
