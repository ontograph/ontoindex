/**
 * `lookupCore` — the shared 7-step canonical resolution algorithm
 * (RFC §4.2; Ring 2 SHARED #917).
 *
 * Pure function. Given a name, a starting scope, and per-kind parameters,
 * walks lexical scopes + optional type-binding MRO + optional owner
 * contributor + global qualified-name fallback, and returns a ranked
 * `Resolution[]` with per-candidate evidence.
 *
 * All three public registries (`ClassRegistry` / `MethodRegistry` /
 * `FieldRegistry`) dispatch into this function, differing only in the
 * parameters they pass. The CHOICE of which steps fire is expressed
 * through `LookupParams`, not through different algorithms per kind.
 *
 * ## Algorithm (RFC §4.2, verbatim names)
 *
 * **Step 1 — Lexical scope-chain walk.** From `startScope`, walk
 *   parent-ward. At each scope, consult `scope.bindings.get(name)`:
 *     - If requested, filter bindings by lexical namespace before shadowing.
 *     - Filter candidates whose `def.type ∈ acceptedKinds`.
 *     - For each surviving candidate, record a raw signal with the
 *       binding's origin + the current scope-chain depth.
 *     - **Hard shadow.** If eligible bindings are non-empty (including
 *       non-kind-matching candidates), stop walking. The name is
 *       lexically bound here; outer scopes are not consulted.
 *
 * **Step 2 — Type-binding resolution.** When `useReceiverTypeBinding`
 *   is true, resolve the receiver's type at `startScope` (from
 *   `scope.typeBindings`), then walk the MRO via
 *   `MethodDispatchIndex.mroFor(ownerDefId)`. Membership per owner comes
 *   through `RegistryContext.methodDispatch` + owner lookups into
 *   `scope.ownedDefs`; each hit records a raw signal with the owner's
 *   MRO depth.
 *
 * **Step 3 — Owner-scoped contributor.** When
 *   `params.ownerScopedContributor` is present, merge its `byName(name)`
 *   hits with `origin: 'local'` (they are declared directly on the
 *   receiver). Distinct from Step 2 — Step 2 walks the MRO; Step 3 only
 *   looks at the directly-declared owner members.
 *
 * **Step 4 — Kind filter (emit `kind-match` evidence).** Already
 *   applied during Steps 1-3; this step just adds a `kind-match` signal
 *   at weight 0 to every candidate for debuggability (so the evidence
 *   array is self-describing).
 *
 * **Step 5 — Arity filter.** Call `providers.arityCompatibility(callsite,
 *   def)` per surviving candidate. Verdicts: `compatible` / `unknown` /
 *   `incompatible`. If at least one candidate is `compatible`, drop
 *   `incompatible` ones. Otherwise keep all (the penalty weight alone
 *   will rank them lower but they remain in the result).
 *
 * **Step 6 — Global fallback.** When Steps 1-3 produced **no**
 *   candidates and the name contains a `.`, consult the
 *   `QualifiedNameIndex` via `lookupQualified` — see §4.5. With an explicit
 *   lexical namespace, tagged source prefixes must first admit this fallback.
 *
 * **Step 7 — Rank + tie-break.** Compose evidence, compute confidence
 *   (sum capped at 1.0), sort by the RFC Appendix B cascade.
 *
 * ## What this module does NOT do
 *
 *   - No AST reads (pure data in, pure data out).
 *   - No `ontoindex/` imports.
 *   - No language switches. Language-specific behavior flows exclusively
 *     through `providers.*` and the `params` object.
 *   - No caching. Callers that want memoization can wrap this function.
 */

import type { NodeLabel } from '../../graph/types.js';
import type { SymbolDefinition } from '../symbol-definition.js';
import { resolveTypeRef } from '../resolve-type-ref.js';
import { lookupNamespaceMember } from '../namespace-member.js';
import type {
  BindingRef,
  Callsite,
  DefId,
  LookupParams,
  Resolution,
  Scope,
  ScopeId,
} from '../types.js';
import type { OriginForTieBreak } from '../origin-priority.js';
import { composeEvidence, confidenceFromEvidence, type RawSignals } from './evidence.js';
import { compareByConfidenceWithTiebreaks, type TieBreakKey } from './tie-breaks.js';
import { canUseCanonicalFallback, lookupQualified } from './lookup-qualified.js';
import {
  FIELD_KINDS,
  METHOD_KINDS,
  type ArityVerdict,
  type OwnerScopedContributor,
  type RegistryContext,
} from './context.js';

// ─── Public entry point ─────────────────────────────────────────────────────

/** Extended `LookupParams` narrowing `ownerScopedContributor` to the concrete shape. */
export interface CoreLookupParams extends Omit<LookupParams, 'ownerScopedContributor'> {
  readonly ownerScopedContributor: OwnerScopedContributor | null;
  /** Call-site description forwarded to `arityCompatibility`. Optional — for non-call lookups. */
  readonly callsite?: Callsite;
}

/**
 * Run the 7-step lookup. Returns a non-empty `Resolution[]` when any
 * candidate was found; an empty array otherwise. Callers consume `[0]`
 * for the best answer and optionally inspect the rest for alternates.
 */
export function lookupCore(
  name: string,
  startScope: ScopeId,
  params: CoreLookupParams,
  ctx: RegistryContext,
): readonly Resolution[] {
  if (params.explicitReceiver !== undefined)
    return lookupExplicitReceiver(name, startScope, params, ctx);
  const acceptedKinds = new Set<NodeLabel>(params.acceptedKinds);
  const perCandidate = new Map<DefId, CandidateState>();

  // ── Step 1: lexical scope-chain walk ──────────────────────────────────
  const lexicalShadowed = walkLexicalChain(
    name,
    startScope,
    acceptedKinds,
    params.lexicalNamespace,
    ctx,
    perCandidate,
  );
  let namespaceClaimed = false;
  if (!lexicalShadowed && params.lexicalNamespace !== undefined && ctx.lookupExport !== undefined) {
    const member = lookupNamespaceMember(
      name,
      startScope,
      params.lexicalNamespace,
      ctx.scopes,
      ctx.defs,
      ctx.lookupExport,
    );
    namespaceClaimed = member.claimed;
    if (member.claimed) {
      for (const def of member.candidates) {
        if (!acceptedKinds.has(def.type)) continue;
        recordLexicalHit(perCandidate, { def, origin: 'namespace' }, member.scopeChainDepth);
      }
    }
  }

  // ── Step 2: type-binding / MRO walk (methods/fields) ──────────────────
  if (params.useReceiverTypeBinding && ctx.methodDispatch !== undefined) {
    walkReceiverTypeBinding(name, startScope, acceptedKinds, params, ctx, perCandidate);
  }

  // ── Step 3: owner-scoped contributor ──────────────────────────────────
  if (params.ownerScopedContributor !== null) {
    seedFromOwnerScopedContributor(
      name,
      params.ownerScopedContributor,
      acceptedKinds,
      perCandidate,
    );
  }

  // ── Step 4: kind-match evidence (emitted by composeEvidence directly) ──
  // Handled inside `composeEvidence`.

  // ── Step 5: arity filter ──────────────────────────────────────────────
  if (params.callsite !== undefined) {
    applyArityFilter(params.callsite, perCandidate, ctx);
  }

  // ── Step 6: global fallback (only when Steps 1-3 produced nothing) ──
  if (
    perCandidate.size === 0 &&
    !lexicalShadowed &&
    !namespaceClaimed &&
    name.includes('.') &&
    (params.lexicalNamespace === undefined || canUseCanonicalFallback(name, startScope, ctx.scopes))
  ) {
    const globals = lookupQualified(name, { acceptedKinds: params.acceptedKinds }, ctx);
    if (globals.length > 0) return globals;
  }

  if (perCandidate.size === 0) return EMPTY;

  // ── Step 7: compose evidence + rank ──────────────────────────────────
  return rankCandidates(perCandidate);
}

// ─── Internal state ────────────────────────────────────────────────────────

interface CandidateState {
  readonly def: SymbolDefinition;
  readonly signals: MutableRawSignals;
  readonly tieBreakKey: MutableTieBreakKey;
}

interface MutableRawSignals {
  origin?: BindingRef['origin'] | 'global-qualified' | 'global-name';
  scopeChainDepth?: number;
  viaUnlinkedImport?: boolean;
  typeBindingMroDepth?: number;
  ownerMatch?: boolean;
  kindMatch: true;
  arityVerdict?: ArityVerdict;
  dynamicUnresolved?: boolean;
}

interface MutableTieBreakKey {
  scopeDepth: number;
  mroDepth: number;
  origin: OriginForTieBreak;
}

function ensureCandidate(
  perCandidate: Map<DefId, CandidateState>,
  def: SymbolDefinition,
): CandidateState {
  const existing = perCandidate.get(def.nodeId);
  if (existing !== undefined) return existing;
  const fresh: CandidateState = {
    def,
    signals: { kindMatch: true },
    tieBreakKey: { scopeDepth: 0, mroDepth: 0, origin: 'local' },
  };
  perCandidate.set(def.nodeId, fresh);
  return fresh;
}

// ─── Step 1 implementation ─────────────────────────────────────────────────

/**
 * Walk the lexical scope chain from `startScope` upward. Returns `true`
 * iff a scope with namespace-eligible `bindings.get(name)` entries was found — the
 * caller uses this to decide whether to run the global fallback.
 */
function walkLexicalChain(
  name: string,
  startScope: ScopeId,
  acceptedKinds: ReadonlySet<NodeLabel>,
  lexicalNamespace: LookupParams['lexicalNamespace'],
  ctx: RegistryContext,
  perCandidate: Map<DefId, CandidateState>,
): boolean {
  let currentId: ScopeId | null = startScope;
  let depth = 0;
  const visited = new Set<ScopeId>();

  while (currentId !== null) {
    if (visited.has(currentId)) return false;
    visited.add(currentId);

    const scope: Scope | undefined = ctx.scopes.getScope(currentId);
    if (scope === undefined) return false;

    const bindings = scope.bindings.get(name);
    if (bindings !== undefined && bindings.length > 0) {
      let hasEligibleBinding = false;
      for (const binding of bindings) {
        if (
          lexicalNamespace !== undefined &&
          binding.namespace !== undefined &&
          binding.namespace !== 'both' &&
          binding.namespace !== lexicalNamespace
        )
          continue;
        hasEligibleBinding = true;
        if (!acceptedKinds.has(binding.def.type)) continue;
        recordLexicalHit(perCandidate, binding, depth);
      }
      if (hasEligibleBinding) return true; // hard shadow regardless of kind-filter survivorship
    }

    currentId = scope.parent;
    depth++;
  }

  return false;
}

function recordLexicalHit(
  perCandidate: Map<DefId, CandidateState>,
  binding: BindingRef,
  scopeChainDepth: number,
): void {
  const state = ensureCandidate(perCandidate, binding.def);
  state.signals.origin = binding.origin;
  state.signals.scopeChainDepth = scopeChainDepth;
  if (binding.via?.linkStatus === 'unresolved') {
    state.signals.viaUnlinkedImport = true;
  }
  if (binding.via?.kind === 'dynamic-unresolved') {
    state.signals.dynamicUnresolved = true;
  }
  state.tieBreakKey.scopeDepth = scopeChainDepth;
  state.tieBreakKey.origin = binding.origin as OriginForTieBreak;
}

// ─── Step 2 implementation ─────────────────────────────────────────────────

function walkReceiverTypeBinding(
  name: string,
  startScope: ScopeId,
  acceptedKinds: ReadonlySet<NodeLabel>,
  params: CoreLookupParams,
  ctx: RegistryContext,
  perCandidate: Map<DefId, CandidateState>,
): void {
  const ownerDefId = resolveReceiverOwner(startScope, params, ctx);
  if (ownerDefId === undefined) return;

  if (ctx.methodDispatch === undefined) return;

  const ownerDef = ctx.defs.get(ownerDefId);
  if (ownerDef === undefined) return;

  // Walk the owner itself at depth 0, then its MRO chain.
  const walk: DefId[] = [ownerDefId, ...ctx.methodDispatch.mroFor(ownerDefId)];

  for (let mroDepth = 0; mroDepth < walk.length; mroDepth++) {
    const currentOwnerId = walk[mroDepth]!;
    const members = collectOwnedMembers(currentOwnerId, name, ctx);
    for (const def of members) {
      if (!acceptedKinds.has(def.type)) continue;
      recordTypeBindingHit(perCandidate, def, mroDepth, ownerDefId);
    }
  }
}

function resolveReceiverOwner(
  startScope: ScopeId,
  params: CoreLookupParams,
  ctx: RegistryContext,
): DefId | undefined {
  // Implicit `self` / `this` — the scope's typeBindings should carry it.
  for (const implicitName of IMPLICIT_RECEIVERS) {
    const owner = lookupReceiverType(startScope, implicitName, ctx);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

const IMPLICIT_RECEIVERS: readonly string[] = Object.freeze(['self', 'this']);

/** Explicit syntax never falls back to an unrelated lexical leaf or implicit receiver. */
function lookupExplicitReceiver(
  name: string,
  startScope: ScopeId,
  params: CoreLookupParams,
  ctx: RegistryContext,
): readonly Resolution[] {
  const receiver = params.explicitReceiver!;
  if ('kind' in receiver && receiver.kind === 'unknown') return EMPTY;
  const chain = 'kind' in receiver ? receiver : undefined;
  if (chain !== undefined && (chain.steps.length === 0 || chain.steps.length > 64)) return EMPTY;
  const rootName =
    chain === undefined ? (receiver as { readonly name: string }).name : chain.root.name;
  if (!rootName || rootName.includes('.')) return EMPTY;

  // Build each derived membership view once per lookup, never once per hop.
  const declarationScopes = new Map<DefId, ScopeId | null>();
  for (const scope of ctx.scopes.byId.values()) {
    for (const def of scope.ownedDefs) {
      const previous = declarationScopes.get(def.nodeId);
      declarationScopes.set(
        def.nodeId,
        previous === undefined || previous === scope.id ? scope.id : null,
      );
    }
  }
  const membersByOwner = new Map<DefId, Map<string, SymbolDefinition[]>>();
  for (const def of ctx.defs.byId.values()) {
    const memberName = simpleNameOf(def);
    if (def.ownerId === undefined || memberName === undefined) continue;
    let members = membersByOwner.get(def.ownerId);
    if (members === undefined) membersByOwner.set(def.ownerId, (members = new Map()));
    const bucket = members.get(memberName);
    if (bucket === undefined) members.set(memberName, [def]);
    else bucket.push(def);
  }
  const resolveAnnotation = (
    def: SymbolDefinition,
    rawName: string | undefined,
  ): DefId | undefined => {
    const declaredAtScope = declarationScopes.get(def.nodeId);
    if (!rawName || declaredAtScope == null) return undefined;
    return resolveTypeRef(
      { rawName, declaredAtScope, source: 'annotation' },
      {
        scopes: ctx.scopes,
        defIndex: ctx.defs,
        qualifiedNameIndex: ctx.qualifiedNames,
        lookupExport: ctx.lookupExport,
      },
    )?.nodeId;
  };
  let currentDef: SymbolDefinition | undefined;
  let owner: DefId | undefined;
  let rootShadowed = false;
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return EMPTY;
    visited.add(currentId);
    const scope = ctx.scopes.getScope(currentId);
    if (scope === undefined) return EMPTY;
    const bindings = (scope.bindings.get(rootName) ?? []).filter(
      (binding) => binding.namespace !== 'type' && binding.via?.namespace !== 'type',
    );
    const candidates = new Map(bindings.map((binding) => [binding.def.nodeId, binding.def]));
    if (candidates.size > 1) return EMPTY;
    if (bindings.length > 0 && bindings.every((binding) => binding.origin === 'namespace')) break;
    currentDef = candidates.values().next().value;
    const ref = scope.typeBindings.get(rootName);
    if (ref !== undefined) {
      rootShadowed = true;
      owner = resolveTypeRef(ref, {
        scopes: ctx.scopes,
        defIndex: ctx.defs,
        qualifiedNameIndex: ctx.qualifiedNames,
        lookupExport: ctx.lookupExport,
      })?.nodeId;
      break;
    }
    if (currentDef !== undefined) {
      rootShadowed = true;
      owner = resolveAnnotation(currentDef, currentDef.declaredType);
      break; // Even an untyped value shadows every outer receiver fact.
    }
    currentId = scope.parent;
  }

  let namespaceRoot = !rootShadowed && owner === undefined && currentDef === undefined;
  const selectMember = (memberName: string): SymbolDefinition | undefined => {
    if (namespaceRoot && ctx.lookupExport !== undefined) {
      namespaceRoot = false;
      const result = lookupNamespaceMember(
        `${rootName}.${memberName}`,
        startScope,
        'value',
        ctx.scopes,
        ctx.defs,
        ctx.lookupExport,
      );
      return result.claimed && result.candidates.length === 1 ? result.candidates[0] : undefined;
    }
    namespaceRoot = false;
    if (owner === undefined) return undefined;
    const members = collectOwnedMembers(owner, memberName, ctx, membersByOwner);
    return members.length === 1 ? members[0] : undefined;
  };
  for (const step of chain?.steps ?? []) {
    if (step.kind === 'member') {
      currentDef = selectMember(step.name);
      if (currentDef === undefined) return EMPTY;
      owner = FIELD_KINDS.includes(currentDef.type)
        ? resolveAnnotation(currentDef, currentDef.declaredType)
        : undefined;
    } else {
      if (
        !Number.isInteger(step.arity) ||
        step.arity < 0 ||
        currentDef === undefined ||
        !METHOD_KINDS.includes(currentDef.type) ||
        ctx.providers.arityCompatibility?.({ arity: step.arity }, currentDef) !== 'compatible'
      )
        return EMPTY;
      owner = resolveAnnotation(currentDef, currentDef.returnType);
      currentDef = undefined;
      namespaceRoot = false;
      if (owner === undefined) return EMPTY;
    }
  }
  const candidates = new Map<DefId, CandidateState>();
  if (namespaceRoot && ctx.lookupExport !== undefined) {
    const result = lookupNamespaceMember(
      `${rootName}.${name}`,
      startScope,
      'value',
      ctx.scopes,
      ctx.defs,
      ctx.lookupExport,
    );
    if (!result.claimed) return EMPTY;
    for (const def of result.candidates) {
      if (params.acceptedKinds.includes(def.type))
        recordLexicalHit(candidates, { def, origin: 'namespace' }, result.scopeChainDepth);
    }
  } else if (owner !== undefined) {
    const owners = [owner, ...(ctx.methodDispatch?.mroFor(owner) ?? [])];
    for (let depth = 0; depth < owners.length; depth++) {
      for (const def of collectOwnedMembers(owners[depth]!, name, ctx, membersByOwner)) {
        if (params.acceptedKinds.includes(def.type))
          recordTypeBindingHit(candidates, def, depth, owner);
      }
    }
  }
  if (candidates.size === 0) return EMPTY;
  if (params.callsite !== undefined) applyArityFilter(params.callsite, candidates, ctx);
  return rankCandidates(candidates);
}

function lookupReceiverType(
  startScope: ScopeId,
  receiverName: string,
  ctx: RegistryContext,
): DefId | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);

    const scope = ctx.scopes.getScope(currentId);
    if (scope === undefined) return undefined;

    const typeRef = scope.typeBindings.get(receiverName);
    if (typeRef !== undefined) {
      // The nearest receiver binding shadows outer bindings even when its
      // TypeRef cannot resolve under the strict declaration-site policy.
      return resolveTypeRef(typeRef, {
        scopes: ctx.scopes,
        defIndex: ctx.defs,
        qualifiedNameIndex: ctx.qualifiedNames,
        lookupExport: ctx.lookupExport,
      })?.nodeId;
    }
    currentId = scope.parent;
  }
  return undefined;
}

function collectOwnedMembers(
  ownerDefId: DefId,
  memberName: string,
  ctx: RegistryContext,
  byOwner?: ReadonlyMap<DefId, ReadonlyMap<string, readonly SymbolDefinition[]>>,
): readonly SymbolDefinition[] {
  if (byOwner !== undefined) return byOwner.get(ownerDefId)?.get(memberName) ?? [];
  // An owner's members are defs whose `ownerId === ownerDefId` and whose
  // simple name matches `memberName`. We iterate `defs.byId` — O(D) per
  // call today. A future by-owner index would make this O(K); tracked as
  // a follow-up optimization before Ring 3 flips go production.
  const out: SymbolDefinition[] = [];
  for (const def of ctx.defs.byId.values()) {
    if (def.ownerId !== ownerDefId) continue;
    if (simpleNameOf(def) !== memberName) continue;
    out.push(def);
  }
  return out;
}

function simpleNameOf(def: SymbolDefinition): string | undefined {
  if (def.qualifiedName === undefined || def.qualifiedName.length === 0) return undefined;
  const dot = def.qualifiedName.lastIndexOf('.');
  return dot === -1 ? def.qualifiedName : def.qualifiedName.slice(dot + 1);
}

function recordTypeBindingHit(
  perCandidate: Map<DefId, CandidateState>,
  def: SymbolDefinition,
  mroDepth: number,
  receiverOwner: DefId,
): void {
  const state = ensureCandidate(perCandidate, def);
  const existingMroDepth = state.signals.typeBindingMroDepth;
  const firstHit = existingMroDepth === undefined;
  // Only replace if this hit is shallower (smaller MRO depth). The local
  // const lets TS narrow to `number` in the `else` branch so no `!`
  // assertion is needed.
  if (firstHit || mroDepth < existingMroDepth) {
    state.signals.typeBindingMroDepth = mroDepth;
    state.tieBreakKey.mroDepth = mroDepth;
  }
  if (def.ownerId === receiverOwner) {
    state.signals.ownerMatch = true;
  }
  // Pure type-binding candidates (no lexical hit) would otherwise keep the
  // `ensureCandidate` default `tieBreakKey.origin === 'local'`, making the
  // Appendix B cascade lump them with local-origin candidates. Demote them
  // to `'import'` — the strongest non-local origin — only when no earlier
  // phase set an origin for this candidate. Lexical hits from Step 1 set
  // `signals.origin` before Step 2 runs, so the guard skips them; Step 3
  // (`seedFromOwnerScopedContributor`) runs AFTER Step 2 and unconditionally
  // overrides `tieBreakKey.origin` back to `'local'` for direct-owner
  // members, so any same-def overlap still ends up ranked correctly.
  if (firstHit && state.signals.origin === undefined) {
    state.tieBreakKey.origin = 'import';
  }
}

// ─── Step 3 implementation ─────────────────────────────────────────────────

function seedFromOwnerScopedContributor(
  name: string,
  contributor: OwnerScopedContributor,
  acceptedKinds: ReadonlySet<NodeLabel>,
  perCandidate: Map<DefId, CandidateState>,
): void {
  for (const def of contributor.byName(name)) {
    if (!acceptedKinds.has(def.type)) continue;
    const state = ensureCandidate(perCandidate, def);
    // Treat the contributor's direct membership as `origin: 'local'` —
    // strongest visibility, no scope-chain penalty.
    state.signals.origin = 'local';
    state.signals.scopeChainDepth = 0;
    state.signals.ownerMatch = def.ownerId === contributor.ownerDefId;
    state.tieBreakKey.origin = 'local';
  }
}

// ─── Step 5 implementation ─────────────────────────────────────────────────

function applyArityFilter(
  callsite: Callsite,
  perCandidate: Map<DefId, CandidateState>,
  ctx: RegistryContext,
): void {
  const arityFn = ctx.providers.arityCompatibility;
  if (arityFn === undefined) {
    // No provider → record 'unknown' for every candidate; keeps signal
    // shape uniform for composeEvidence.
    for (const state of perCandidate.values()) {
      state.signals.arityVerdict = 'unknown';
    }
    return;
  }

  let anyCompatible = false;
  for (const state of perCandidate.values()) {
    const verdict = arityFn(callsite, state.def);
    state.signals.arityVerdict = verdict;
    if (verdict === 'compatible') anyCompatible = true;
  }

  if (!anyCompatible) return;

  // Filter: when at least one compatible candidate exists, drop incompatibles.
  for (const [defId, state] of perCandidate) {
    if (state.signals.arityVerdict === 'incompatible') {
      perCandidate.delete(defId);
    }
  }
}

// ─── Step 7 implementation ─────────────────────────────────────────────────

function rankCandidates(perCandidate: Map<DefId, CandidateState>): readonly Resolution[] {
  const resolutions: Resolution[] = [];
  const tieKeys = new Map<string, TieBreakKey>();

  for (const state of perCandidate.values()) {
    const evidence = composeEvidence(state.signals as RawSignals);
    const confidence = confidenceFromEvidence(evidence);
    resolutions.push({ def: state.def, confidence, evidence });
    tieKeys.set(state.def.nodeId, { ...state.tieBreakKey });
  }

  resolutions.sort((a, b) => compareByConfidenceWithTiebreaks(a, b, tieKeys));
  return Object.freeze(resolutions);
}

// ─── Constants ──────────────────────────────────────────────────────────────

const EMPTY: readonly Resolution[] = Object.freeze([]);
