import {
  getLanguageFromFilename,
  lookupCore,
  SupportedLanguages,
  type BindingRef,
  type DefId,
  type ParsedFile,
  type Range,
  type Reference,
  type NamedReferenceSite,
  type ScopeId,
  type SymbolDefinition,
} from 'ontoindex-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import { emitReferencesToGraph } from './emit-references.js';
import { buildScopeRegistryContext, finalizeScopeModel } from './finalize-orchestrator.js';
import { getProviderForFile } from './languages/index.js';
import { primaryLanguages } from './registry-primary-flag.js';

export interface ScopeCallPublication {
  owns(
    filePath: string,
    name: string,
    range: Range | undefined,
    callForm: string | undefined,
  ): boolean;
  emit(graph: KnowledgeGraph): void;
}

/** Reserve the enabled, bounded free-call slice before legacy lookup can run. */
export function prepareScopeCallPublication(
  files: readonly ParsedFile[],
  enabledLanguages: ReadonlySet<SupportedLanguages> = primaryLanguages(),
): ScopeCallPublication | undefined {
  const enabled = files.filter((file) => {
    const language = getLanguageFromFilename(file.filePath);
    return (
      (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) &&
      enabledLanguages.has(language)
    );
  });
  if (enabled.length === 0) return undefined;

  const scopes = finalizeScopeModel(enabled);
  const context = buildScopeRegistryContext(scopes);
  const owned = new Set<string>();
  const sites = new Map<
    string,
    { file: ParsedFile; site: NamedReferenceSite; conflict: boolean }
  >();
  const definitionNodeIds = new Map<DefId, string>();
  const conflictingMappings = new Set<DefId>();

  for (const file of enabled) {
    for (const mapping of file.definitionNodeIds ?? []) {
      const existing = definitionNodeIds.get(mapping.defId);
      if (existing !== undefined && existing !== mapping.nodeId)
        conflictingMappings.add(mapping.defId);
      definitionNodeIds.set(mapping.defId, mapping.nodeId);
    }
    const importedNames = new Set(
      file.parsedImports.flatMap((entry) => ('localName' in entry ? [entry.localName] : [])),
    );
    for (const site of file.referenceSites) {
      if (
        site.kind !== 'call' ||
        site.callForm !== 'free' ||
        site.explicitReceiver !== undefined ||
        !/^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(site.name) ||
        !validRange(site.atRange)
      )
        continue;
      const key = siteKey(file.filePath, site.name, site.atRange);
      const previous = sites.get(key);
      if (previous !== undefined) {
        if (previous.site.inScope !== site.inScope || previous.site.arity !== site.arity)
          previous.conflict = true;
      } else {
        sites.set(key, { file, site, conflict: false });
      }

      // Inspect the nearest value bucket before lookup, including noncallable shadows.
      let current: ScopeId | null = site.inScope;
      const visited = new Set<ScopeId>();
      let bindings: readonly BindingRef[] = [];
      while (current !== null && !visited.has(current)) {
        visited.add(current);
        const scope = context.scopes.getScope(current);
        if (scope === undefined || scope.filePath !== file.filePath) break;
        bindings = (scope.bindings.get(site.name) ?? []).filter(
          (binding) => binding.namespace !== 'type',
        );
        if (bindings.length > 0) break;
        current = scope.parent;
      }
      if (bindings.length === 0 && importedNames.has(site.name)) continue;
      if (
        bindings.some(
          (binding) =>
            binding.origin !== 'local' ||
            binding.def.filePath !== file.filePath ||
            (binding.def.type === 'Function' && !hasFixedArity(binding.def)),
        )
      )
        continue;
      owned.add(key);
    }
  }
  for (const id of conflictingMappings) definitionNodeIds.delete(id);

  const bySourceScope = new Map<ScopeId, Reference[]>();
  const byTargetDef = new Map<DefId, Reference[]>();
  for (const [key, { file, site, conflict }] of sites) {
    if (!owned.has(key) || conflict) continue;
    const provider = getProviderForFile(file.filePath);
    const candidates = lookupCore(
      site.name,
      site.inScope,
      {
        acceptedKinds: ['Function'],
        lexicalNamespace: 'value',
        useReceiverTypeBinding: false,
        ownerScopedContributor: null,
      },
      context,
    );
    if (candidates.length !== 1) continue;
    const candidate = candidates[0]!;
    if (
      candidate.def.filePath !== file.filePath ||
      candidate.def.type !== 'Function' ||
      !hasFixedArity(candidate.def) ||
      site.arity === undefined ||
      provider?.arityCompatibility?.(candidate.def, { arity: site.arity }) !== 'compatible'
    )
      continue;
    const reference: Reference = {
      fromScope: site.inScope,
      toDef: candidate.def.nodeId,
      atRange: { ...site.atRange },
      kind: 'call',
      confidence: candidate.confidence,
      evidence: candidate.evidence,
    };
    const source = bySourceScope.get(reference.fromScope) ?? [];
    source.push(reference);
    bySourceScope.set(reference.fromScope, source);
    const target = byTargetDef.get(reference.toDef) ?? [];
    target.push(reference);
    byTargetDef.set(reference.toDef, target);
  }

  return {
    owns: (filePath, name, range, callForm) =>
      callForm === 'free' && validRange(range) && owned.has(siteKey(filePath, name, range)),
    emit: (graph) => {
      const validated = new Map<DefId, string>();
      for (const [id, nodeId] of definitionNodeIds) {
        const def = scopes.defs.get(id);
        const node = graph.getNode(nodeId);
        if (
          def !== undefined &&
          node?.label === def.type &&
          node.properties.filePath === def.filePath
        ) {
          validated.set(id, nodeId);
        }
      }
      emitReferencesToGraph({
        graph,
        scopes,
        referenceIndex: { bySourceScope, byTargetDef },
        definitionNodeIds: validated,
      });
    },
  };
}

function hasFixedArity(def: SymbolDefinition): boolean {
  return (
    Number.isSafeInteger(def.parameterCount) &&
    Number.isSafeInteger(def.requiredParameterCount) &&
    def.requiredParameterCount! >= 0 &&
    def.parameterCount! >= def.requiredParameterCount!
  );
}

function validRange(range: Range | undefined): range is Range {
  return (
    range !== undefined &&
    [range.startLine, range.startCol, range.endLine, range.endCol].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0),
    ) &&
    range.startLine >= 1 &&
    range.endLine >= 1 &&
    (range.endLine > range.startLine ||
      (range.endLine === range.startLine && range.endCol > range.startCol))
  );
}

function siteKey(filePath: string, name: string, range: Range): string {
  return JSON.stringify([
    filePath,
    name,
    range.startLine,
    range.startCol,
    range.endLine,
    range.endCol,
    'free',
  ]);
}
