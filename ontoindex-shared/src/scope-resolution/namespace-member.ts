import type { DefIndex } from './def-index.js';
import type { FinalizeOutput } from './finalize-algorithm.js';
import type { SymbolDefinition } from './symbol-definition.js';
import type { ScopeId, ScopeLookup } from './types.js';

type NamespaceMemberResult =
  | { readonly claimed: false }
  | {
      readonly claimed: true;
      readonly candidates: readonly SymbolDefinition[];
      readonly scopeChainDepth: number;
    };

/** Resolve one explicit namespace-alias hop; a failed claim still shadows fallback. */
export function lookupNamespaceMember(
  name: string,
  startScope: ScopeId,
  namespace: 'type' | 'value',
  scopes: ScopeLookup,
  defs: DefIndex,
  lookupExport: NonNullable<FinalizeOutput['lookupExport']>,
): NamespaceMemberResult {
  const segments = name.split('.');
  if (segments.length !== 2 || segments.some((segment) => segment.length === 0))
    return { claimed: false };
  const [alias, member] = segments;
  const opposite = namespace === 'type' ? 'value' : 'type';
  let currentId: ScopeId | null = startScope;
  let scopeChainDepth = 0;
  const visited = new Set<ScopeId>();
  const failed = (): NamespaceMemberResult => ({ claimed: true, candidates: [], scopeChainDepth });

  while (currentId !== null) {
    if (visited.has(currentId)) return failed();
    visited.add(currentId);
    const scope = scopes.getScope(currentId);
    if (scope === undefined) return failed();

    const bindings = (scope.bindings.get(alias) ?? []).filter(
      (binding) => binding.namespace !== opposite && binding.via?.namespace !== opposite,
    );
    const edges = scope.imports.filter(
      (edge) =>
        edge.localName === alias && edge.kind === 'namespace' && edge.namespace !== opposite,
    );
    if (bindings.length > 0 || edges.length > 0) {
      const targets = new Set<ScopeId>();
      for (const binding of bindings) {
        const edge = binding.via;
        if (
          binding.origin !== 'namespace' ||
          edge?.kind !== 'namespace' ||
          edge.linkStatus === 'unresolved' ||
          edge.targetModuleScope === undefined
        )
          return failed();
        targets.add(edge.targetModuleScope);
      }
      for (const edge of edges) {
        if (edge.linkStatus === 'unresolved' || edge.targetModuleScope === undefined)
          return failed();
        targets.add(edge.targetModuleScope);
      }
      if (targets.size !== 1) return failed();
      const target = targets.values().next().value;
      if (target === undefined || scopes.getScope(target)?.kind !== 'Module') return failed();
      const candidates = new Map<string, SymbolDefinition>();
      for (const exported of lookupExport(target, member, namespace)) {
        const def = defs.get(exported.nodeId);
        if (def !== undefined) candidates.set(def.nodeId, def);
      }
      return { claimed: true, candidates: [...candidates.values()], scopeChainDepth };
    }
    currentId = scope.parent;
    scopeChainDepth++;
  }
  return { claimed: false };
}
