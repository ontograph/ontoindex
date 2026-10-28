# Replay prerequisite review

Date: 2026-10-24
Outcome: no implementation-ready packet established; architecture dependency identified.

Four read-only agents examined registration budgeting and TypeScript capture.
Two used gpt-6-luna and two used gpt-6.1-sol medium. No production files changed,
no tests or builds started, no limits raised, and no replay activated.

## Registration budget

Compared increasing limits, deduplicating events, and replacing the ordered log
with compact state. Rejected a limit increase without resource evidence and
deduplication without semantic equivalence. Current semantic-model tests require
duplicate class additions to preserve multiple type entries and observer events
to remain ordered. Clears and method ordering matter. Nested mutation capture is
already suppressed. A compact representation requires separate evidence that it
preserves registry state, lookup order and multiplicity.

Evidence: ontoindex/test/unit/model/semantic-model.test.ts:130 and :392;
ontoindex/src/core/ingestion/model/semantic-model.ts:479;
ontoindex/src/core/ingestion/pipeline-phases/scope-retention-stage.ts:1334.
The roadmap's historical 89455-registration measurement was not rerun; current
filtering means it cannot establish today's event distribution or performance.

## Type export capture

Compared widening erased-only mixed-file acceptance, emitting primitive aliases
into existing bindings, and defining type/value namespace semantics first.
Second challenge rejects both immediate capture extensions. Existing whole-file
type aliases emit lexical scope only. Ordinary bindings and exports carry no
type/value namespace distinction. typeBindings stores annotation/receiver facts.
TypeAlias is excluded from callable kinds, but filtering happens after binding
lookup, so a type alias could still incorrectly shadow a value. Primitive RHS
restriction does not solve that issue.

Evidence: ontoindex/src/core/ingestion/languages/typescript-captures.ts:330;
ontoindex/src/core/ingestion/scope-extractor.ts:552;
ontoindex-shared/src/scope-resolution/types.ts:335;
ontoindex-shared/src/scope-resolution/finalize-algorithm.ts:178;
ontoindex-shared/src/scope-resolution/registries/lookup-core.ts:211;
ontoindex-shared/src/scope-resolution/registries/context.ts:100.

The earlier roadmap hypothesis about a missing-export result is unconfirmed and
was superseded by its later checkpoint. Do not cite it as an observed defect.

## Required next design

Define namespace ownership across local bindings, imports, exports and lookup
before adding TypeAlias capture. Acceptance must discriminate same-name type
and value declarations, type-only imports/exports, ordinary value shadowing,
and noncallable aliases; parity with a resolver sharing the same defect is
insufficient. Reuse existing owners and preserve compatibility for other languages.
Freeze the exact source/test packet only after this contract is decided.

OntoIndex HEAD and index matched 2623820; 277 dirty paths were reported. Committed
context located ScopeRetentionStage but excludes current dirty additions.
Relevant capture symbols were absent from committed lookup. Source inspection
was authority for current semantics. No refresh needed for dirty state alone.
Roadmap manager returned no_dispatch, no eligible task, revision
3a75532c49cfd2c64d54ebf683c934c4d3ca3deb83bdaa1a8cfd22620487ac80.
No completed task or tool-owned receipt was reopened or rewritten.
