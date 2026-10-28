# Explicit namespace value-member resolution

The shared resolver now resolves one-hop alias members for explicit type/value
selectors through the existing export callback. Strict type resolution reuses
the same internal traversal. Registry candidates preserve namespace evidence,
scope depth, kind filtering, arity and ranking. Failed alias claims block
canonical fallback; omitted selectors retain legacy behavior.

Two read-only explorers and two gpt-6.1-sol medium developers compared shared
traversal, duplicated traversal and eager export expansion. Shared traversal
won the second review because it keeps shadowing and export authority in one
owner without another index or invalidation mechanism. Independent final source
review found no material defects. Existing unrelated dirty changes remain.

Changed production owners: namespace-member.ts, resolve-type-ref.ts and
registries/lookup-core.ts under ontoindex-shared/src/scope-resolution.
Tests: registries.test.ts and resolve-type-ref.test.ts. The namespace ADR records
the contract. Public registry wrappers still omit the selector; provider
activation, deeper paths and transitive export closure remain separate.

Validation evidence:

- Shared TypeScript compile exit 0: c33143.
- Product TypeScript check exit 0: 8877f9.
- First five-suite run: 351 passed, one invalid fixture failed (97e1eb).
- Second five-suite run: 351 passed, same fixture failed its next tree invariant
  (ad9ce3). The fixture needed a same-file parent and contained range.
- Final registry-only rerun: 114 passed, exit 0 (8cff71). The other four suites
  had 238 passing tests on unchanged inputs: 352 passing tests across final checks.
- Scoped whitespace check exit 0: 570c9d.
- OntoIndex declared-file verify_diff PASS; symbol scope was not checked.

Budget: one of two shared compiles, one of two product checks, two initially
budgeted suite runs plus one targeted correction run. The coordinator extended
the test budget by one after the fixture-only failure under the user's standing
authorization to complete fixes. No detached jobs or runtime benchmark ran.
No Rust workspace exists here, so Rust formatting is inapplicable.

Committed index matched HEAD 2623820. Dirty source is authoritative. Impact
reported MEDIUM for lookupCore and LOW for resolveTypeRef; safe-edit checks
flagged exported APIs. The original 1,600-file workspace-preparation limit and
runtime/provider admission remain unresolved; this change is no runtime-unblock
or performance claim. Existing closed manager-loop state was not modified.
