# Explicit type/value binding namespaces

## Status

Accepted for staged implementation, 2026-10-24. NS-1 establishes lexical lookup
and retention only. Provider capture and production replay remain gated.

## Evidence

`ontoindex-shared/src/scope-resolution/registries/lookup-core.ts` and
`resolve-type-ref.ts` stop at nonempty name buckets before namespace semantics
exist. `types.ts` models binding provenance separately from annotation facts in
`Scope.typeBindings`. The existing legacy test in `resolve-type-ref.test.ts`
requires an inner variable to shadow an outer imported class.

`finalize-algorithm.ts` exports one definition per spelling, while TypeScript
can export distinct type and value definitions under the same spelling.
`parse-scope-codec.ts` rejects unknown fields and validates decoded records
through its encoder. These existing owners govern the extension.

## Alternatives and challenge

| Fix | Correctness and coverage | Compatibility and complexity | Performance, safety, validation and rollback |
| --- | --- | --- | --- |
| Infer namespaces from definition kind | Cannot represent type-only imports of dual-space classes; incomplete | Small patch but makes language semantics implicit | Cheap lookup; false runtime visibility; reject with type-only class counterexample |
| Split type/value binding maps and resolution paths | Can express separation if all import/export owners migrate | Broad migration and duplicate plumbing across languages | Additional maps and reconciliation; larger rollback; requires cross-language equivalence |
| Optional namespace metadata in existing bindings | Expresses per-binding restrictions and dual-space declarations | Untagged records preserve legacy semantics; bounded additive change | Constant work per examined binding; no parallel cache; strict enum validation and local rollback |

Select optional metadata after a second challenge. Filtering by accepted symbol
kind is insufficient: same-namespace noncallable values must still shadow outer
functions, while type-only declarations must not shadow values. Tests require
distinct same-spelling definition IDs; a class alone conceals that distinction.

## Contract

BindingRef gains optional `namespace: 'type' | 'value' | 'both'`. Absence retains
legacy behavior. `LookupParams.lexicalNamespace` optionally selects type or value
for the lexical walk. Filter namespace before deciding hard shadow, then filter
symbol kind. An eligible wrong-kind binding still shadows. An omitted selector
preserves the existing generic lookup contract, including tagged bindings.

`resolveTypeRef` performs a type lookup: explicit value-only bindings do not
shadow its lexical walk. Untagged and dual-space bindings remain eligible.
This does not change qualified-name indexes, receiver dispatch or owner lookup.
The narrow option name makes that boundary explicit. Provider activation must
address those paths before claiming end-to-end namespace correctness.

The strict parsed-file codec preserves the optional enum. Old records remain
readable and omitted fields stay omitted. Unknown values fail closed. Old
readers reject new fields; compatibility is not bidirectional. Existing byte,
depth, property and record limits remain authoritative.

## Follow-on ownership

One-hop namespace type resolution uses an optional finalize-owned `lookupExport`
callback, forwarded through scope indexes and registry/type-resolution contexts.
It accepts module scope, exported name and requested lexical namespace and returns
definition candidates using the existing export-selection algorithm. Only explicit
export surfaces authorize this path; missing metadata returns no candidates and
authoritative empty namespace maps override flat exports. No alias-expanded index
or canonical-name rewriting is introduced.

Strict type resolution preserves exact full-name lexical matches, then resolves
exactly `alias.Member` from the declaration scope. Nearest eligible alias claims
shadow outer claims; resolved namespace edges must agree on their target module.
Duplicate equivalent edges are harmless. Missing or conflicting targets, wrong
type kinds and multiple distinct exported definitions fail closed. Receiver lookup
forwards the same callback. Registry lookup shares this traversal when an explicit
type/value lexical namespace and export callback are supplied. Exact lexical
matches retain precedence. Exported candidates use authoritative definition IDs,
namespace-origin evidence and alias scope depth, then existing kind, arity and
ranking rules. A claimed alias with no accepted export prevents canonical fallback.
Omitted namespace selectors retain legacy behavior. Deeper namespace paths,
transitive re-export closure and provider/replay activation remain separate work.

Public class, method and field registries expose an optional per-query
lexicalNamespace selector and forward it unchanged. Existing calls without the
selector preserve their behavior. Supported reference materialization requests
value-space lookup for free calls, identifier reads and class construction;
class construction does not imply type-space lookup. Unsupported member calls
and explicit receivers remain excluded by the existing reference-site gate.

NS-3A adds conservative admission for source-spelling qualified fallback. Explicit
tagged full names or segment prefixes in lexical bindings prevent fallback to
global definitions. Namespace-origin bindings and namespace-import edges claim
their spelling even without a namespace tag: an alias does not prove that a
colliding canonical definition is exported. This intentionally tightens the
legacy untagged-alias fallback; unclaimed canonical names and untagged bindings
of other origins retain their existing behavior. Matching tags also require refusal
until export-aware traversal proves member visibility. Exact lexical successes
remain valid. Generic registry calls opt in through lexicalNamespace; strict type
resolution guards dotted fallback. Canonical lookupQualified stays unchanged.
Finalized module imports are overlaid in registry contexts so edges without a
synthetic definition remain visible. Missing/cyclic scope chains fail closed.
This safety prerequisite accepts false negatives and does not complete alias,
receiver or owner resolution; those remain prerequisites to provider activation.

NS-2 preserves one draft, bounded SCC obligation and statistics entry per parsed
import even when it yields two meanings. Both meanings of one import are offered
together to mergeBindings; the hook remains authoritative and may discard them.
Provider activation requires a namespace-aware merge policy. Static reexport
surfaces remain static; this extension does not add transitive export closure.

Before capture expansion, finalize and parsed-file owners must support separate
type/value exported identities and intersect imported meaning with exported
meaning. Namespace exports must preserve absent versus authoritative-empty
semantics; a new explicit surface cannot fall back to legacy local definitions.
Same-definition dual meanings may share a binding, while distinct definitions
must remain distinct. Type-only imports of classes must retain their restriction.

Then the TS/TSX producer can classify aliases/interfaces as type-only, ordinary
values as value-only and classes as both. Annotation facts remain separate from
declarations. Qualified namespace access, type-only syntax, aliases and legal
identifiers named `type` require explicit tests. Namespace declarations are a
separate syntax/ownership packet and are not silently included with type aliases.

No producer emits this metadata in NS-1. The staging contract therefore changes
no current capture acceptance or installed runtime. Complete provider coverage,
semantic replay admission, source-owned replacement and runtime acceptance
remain prerequisites to unblocking large-workspace current-source navigation.
