import { KnowledgeGraph } from '../../graph/types.js';
import { ResolutionContext } from '../model/resolution-context.js';
import { BindingAccumulator } from '../binding-accumulator.js';
import { ConstructorBinding } from '../type-env.js';
import { CLASS_TYPES, HeritageMap, SymbolTableReader } from '../model/index.js';
import { FileConstructorBindings, ExtractedCall } from '../workers/parse-worker.js';
import { extractReturnTypeName } from '../type-extractors/shared.js';

export const CLASS_LIKE_TYPES = new Set<string>([...CLASS_TYPES, 'Impl']);

export const INSTANTIABLE_CLASS_TYPES = new Set<string>(['Class', 'Struct', 'Record']);

export const MAX_EXPORTS_PER_FILE = 500;
export const MAX_TYPE_NAME_LENGTH = 256;

export type ReceiverTypeEntry =
  | { readonly kind: 'resolved'; readonly value: string }
  | { readonly kind: 'ambiguous' };

export type ReceiverTypeIndex = Map<string, Map<string, ReceiverTypeEntry>>;

export const receiverKey = (scope: string, varName: string): string => `${scope}\0${varName}`;

/** Extract the bare function name from a sourceId.
 *  Handles both unqualified ("Function:filepath:funcName" → "funcName")
 *  and qualified ("Function:filepath:ClassName.funcName" → "funcName").
 *  Strips any trailing #<arity> suffix from Method/Constructor IDs. */
export const extractFuncNameFromSourceId = (sourceId: string): string => {
  const lastColon = sourceId.lastIndexOf(':');
  const segment = lastColon >= 0 ? sourceId.slice(lastColon + 1) : '';
  const dotIdx = segment.lastIndexOf('.');
  const raw = dotIdx >= 0 ? segment.slice(dotIdx + 1) : segment;
  // Strip #<arity> suffix (e.g. "save#2" → "save")
  const hashIdx = raw.indexOf('#');
  return hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
};

export const buildReceiverTypeIndex = (map: Map<string, string>): ReceiverTypeIndex => {
  const index: ReceiverTypeIndex = new Map();
  for (const [key, typeName] of map) {
    const nul = key.indexOf('\0');
    if (nul < 0) continue;
    const scope = key.slice(0, nul);
    const varName = key.slice(nul + 1);
    if (!varName) continue;
    if (scope !== '' && !scope.includes('@')) continue;
    const funcName = scope === '' ? '' : scope.slice(0, scope.indexOf('@'));

    let varMap = index.get(funcName);
    if (!varMap) {
      varMap = new Map();
      index.set(funcName, varMap);
    }

    const existing = varMap.get(varName);
    if (existing === undefined) {
      varMap.set(varName, { kind: 'resolved', value: typeName });
    } else if (existing.kind === 'resolved' && existing.value !== typeName) {
      varMap.set(varName, { kind: 'ambiguous' });
    }
  }
  return index;
};

export const lookupReceiverType = (
  index: ReceiverTypeIndex,
  funcName: string,
  varName: string,
): string | undefined => {
  const scopeMap = index.get(funcName);
  const entry = scopeMap?.get(varName);
  if (entry?.kind === 'resolved') return entry.value;

  // Fallback to top-level (module) scope if function-scope lookup fails
  if (funcName !== '') {
    const globalEntry = index.get('')?.get(varName);
    if (globalEntry?.kind === 'resolved') return globalEntry.value;
  }

  return undefined;
};

export const verifyConstructorBindings = (
  bindings: readonly ConstructorBinding[],
  filePath: string,
  ctx: ResolutionContext,
  graph?: KnowledgeGraph,
  bindingAccumulator?: BindingAccumulator,
): Map<string, string> => {
  const verified = new Map<string, string>();

  for (const { scope, varName, calleeName, receiverClassName } of bindings) {
    const tiered = ctx.resolve(calleeName, filePath);
    const isClass = tiered?.candidates.some((def) => def.type === 'Class') ?? false;

    if (isClass) {
      verified.set(receiverKey(scope, varName), calleeName);
    } else {
      let callableDefs = tiered?.candidates.filter(
        (d) => d.type === 'Function' || d.type === 'Method',
      );

      if (callableDefs && callableDefs.length > 1 && receiverClassName) {
        if (graph) {
          const narrowed = callableDefs.filter((d) => {
            if (!d.ownerId) return false;
            const owner = graph.getNode(d.ownerId);
            return owner?.properties.name === receiverClassName;
          });
          if (narrowed.length > 0) callableDefs = narrowed;
        } else {
          const classResolved = ctx.resolve(receiverClassName, filePath);
          if (classResolved && classResolved.candidates.length > 0) {
            const classNodeIds = new Set(classResolved.candidates.map((c) => c.nodeId));
            const narrowed = callableDefs.filter((d) => d.ownerId && classNodeIds.has(d.ownerId));
            if (narrowed.length > 0) callableDefs = narrowed;
          }
        }
      }

      let typeName: string | undefined;
      if (callableDefs && callableDefs.length === 1 && callableDefs[0].returnType) {
        typeName = extractReturnTypeName(callableDefs[0].returnType);
      }

      const shouldFallback =
        tiered?.tier !== 'same-file' && (!callableDefs || callableDefs.length <= 1);
      if (!typeName && bindingAccumulator && shouldFallback) {
        const namedImports = ctx.namedImportMap.get(filePath);
        const importBinding = namedImports?.get(calleeName);
        if (importBinding) {
          const rawType = bindingAccumulator.fileScopeGet(
            importBinding.sourcePath,
            importBinding.exportedName,
          );
          if (rawType) {
            typeName = extractReturnTypeName(rawType);
          }
        }
      }

      if (typeName) {
        verified.set(receiverKey(scope, varName), typeName);
      }
    }
  }

  return verified;
};

export const buildFileReceiverTypeIndexes = (
  constructorBindings: FileConstructorBindings[] | undefined,
  ctx: ResolutionContext,
  graph: KnowledgeGraph,
  bindingAccumulator?: BindingAccumulator,
): Map<string, ReceiverTypeIndex> => {
  const fileReceiverTypes = new Map<string, ReceiverTypeIndex>();
  if (!constructorBindings) return fileReceiverTypes;

  for (const { filePath, bindings } of constructorBindings) {
    const verified = verifyConstructorBindings(bindings, filePath, ctx, graph, bindingAccumulator);
    if (verified.size > 0) {
      fileReceiverTypes.set(filePath, buildReceiverTypeIndex(verified));
    }
  }

  return fileReceiverTypes;
};

export const resolveFieldOwnership = (
  receiverName: string,
  fieldName: string,
  filePath: string,
  ctx: ResolutionContext,
): { nodeId: string; declaredType?: string } | undefined => {
  const typeResolved = ctx.resolve(receiverName, filePath);
  if (!typeResolved) return undefined;
  const classDef = typeResolved.candidates.find((d) => CLASS_LIKE_TYPES.has(d.type));
  if (!classDef) return undefined;

  return ctx.model.fields.lookupFieldByOwner(classDef.nodeId, fieldName) ?? undefined;
};

export interface ResolveResult {
  nodeId: string;
  confidence: number;
  reason: string;
  returnType?: string;
}

export function findInterfaceDispatchTargets(
  calledName: string,
  receiverTypeName: string,
  currentFile: string,
  ctx: ResolutionContext,
  heritageMap: HeritageMap,
  primaryNodeId: string,
): ResolveResult[] {
  const implFiles = heritageMap.getImplementorFiles(receiverTypeName);
  if (implFiles.size === 0) return [];

  const typeResolved = ctx.resolve(receiverTypeName, currentFile);
  if (!typeResolved) return [];
  if (!typeResolved.candidates.some((c) => c.type === 'Interface')) return [];

  const results: ResolveResult[] = [];
  for (const implFile of implFiles) {
    const methods = ctx.model.symbols.lookupExactAll(implFile, calledName);
    for (const method of methods) {
      if (method.nodeId !== primaryNodeId) {
        results.push({
          nodeId: method.nodeId,
          confidence: 0.7,
          reason: 'interface-dispatch',
        });
      }
    }
  }
  return results;
}

export type ExportedTypeMap = Map<string, Map<string, string>>;

export function buildImportedReturnTypeMaps(
  filePath: string,
  namedImportMap: ReadonlyMap<
    string,
    ReadonlyMap<string, { sourcePath: string; exportedName: string }>
  >,
  symbolTable: {
    lookupExactFull(filePath: string, name: string): { returnType?: string } | undefined;
  },
): {
  importedReturnTypes: ReadonlyMap<string, string>;
  importedRawReturnTypes: ReadonlyMap<string, string>;
} {
  const importedReturnTypes = new Map<string, string>();
  const importedRawReturnTypes = new Map<string, string>();
  const fileImports = namedImportMap.get(filePath);
  if (!fileImports) return { importedReturnTypes, importedRawReturnTypes };

  for (const [localName, binding] of fileImports) {
    const def = symbolTable.lookupExactFull(binding.sourcePath, binding.exportedName);
    if (!def?.returnType) continue;
    const simpleReturn = extractReturnTypeName(def.returnType);
    if (simpleReturn) importedReturnTypes.set(localName, simpleReturn);
    importedRawReturnTypes.set(localName, def.returnType);
  }
  return { importedReturnTypes, importedRawReturnTypes };
}

export function buildExportedTypeMapFromGraph(
  graph: KnowledgeGraph,
  symbolTable: SymbolTableReader,
): ExportedTypeMap {
  const result: ExportedTypeMap = new Map();
  graph.forEachNode((node) => {
    if (!node.properties?.isExported) return;
    if (!node.properties?.filePath || !node.properties?.name) return;
    const filePath = node.properties.filePath as string;
    const name = node.properties.name as string;
    if (!name || name.length > MAX_TYPE_NAME_LENGTH) return;

    const defs = symbolTable.lookupExactAll(filePath, name);
    const def = defs.find((d) => d.nodeId === node.id) ?? defs[0];
    if (!def) return;
    const typeName = def.returnType ?? def.declaredType;
    if (!typeName || typeName.length > MAX_TYPE_NAME_LENGTH) return;

    const simpleType = extractReturnTypeName(typeName) ?? typeName;
    if (!simpleType) return;
    let fileExports = result.get(filePath);
    if (!fileExports) {
      fileExports = new Map();
      result.set(filePath, fileExports);
    }
    if (fileExports.size < MAX_EXPORTS_PER_FILE) {
      fileExports.set(name, simpleType);
    }
  });
  return result;
}

export interface OverloadHints {
  callArity: number;
  [key: string]: unknown;
}

export function seedCrossFileReceiverTypes(
  calls: ExtractedCall[],
  namedImportMap: ReadonlyMap<
    string,
    ReadonlyMap<string, { sourcePath: string; exportedName: string }>
  >,
  exportedTypeMap: ReadonlyMap<string, ReadonlyMap<string, string>>,
): { enrichedCount: number } {
  if (namedImportMap.size === 0 || exportedTypeMap.size === 0) {
    return { enrichedCount: 0 };
  }
  let enrichedCount = 0;
  for (const call of calls) {
    if (call.receiverTypeName || !call.receiverName) continue;
    if (call.callForm !== 'member') continue;

    const fileImports = namedImportMap.get(call.filePath);
    if (!fileImports) continue;

    const binding = fileImports.get(call.receiverName);
    if (!binding) continue;

    const upstream = exportedTypeMap.get(binding.sourcePath);
    if (!upstream) continue;

    const type = upstream.get(binding.exportedName);
    if (type) {
      call.receiverTypeName = type;
      enrichedCount++;
    }
  }
  return { enrichedCount };
}
