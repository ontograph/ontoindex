# Mixed erased and runtime TypeScript declarations

Date: 2026-10-25

## Decision and implementation

Compared unconditional erasure, full type-binding capture, and conservative
composition through the existing owners. A second review rejected unconditional
erasure because references, receivers, annotations and publication collisions
need semantic protection. Full type bindings require a separate resolution slice.
Selected shared erased-export validation in `typescript-export-captures.ts` and
composition in `typescript-captures.ts`.

Ordinary exported interfaces and aliases can coexist with supported runtime
statements when their names are unique and absent from identifiers, type
identifiers and property identifiers in retained statements. This intentionally
refuses valid shadows and same-name properties. Existing whole-file type-only
behavior stays unchanged; mixed statement-level type imports remain refused.
Export emission reserves erased publication names without emitting value facts.
The additional name-isolation traversal is linear in AST size; no performance
improvement is claimed. Rollback consists of reverting this slice's changes in
the two owners and four tests, preserving earlier dirty work.

Four research agents reviewed ownership, semantics, tests and frozen inputs;
two GPT-6.1-Sol medium agents implemented disjoint production and test packets.
An additional read-only agent reviewed the numeric validation failure.

## Validation evidence

Native build exited 0: `/opt/d1/tmp/ontoindex-mixed-erased-build.log`.
Initial six-suite run exited 1 with 713 passing and one failing test:
`/opt/d1/tmp/ontoindex-mixed-erased-tests.log`. The failed cross-mode ranked
snapshot differed only by about 7e-18 in two importance values. The production
PageRank owner accumulates unsorted floating-point inputs. Selected correction:
cross-mode scores tolerate absolute error at most 1e-14, with exact score
presence, finite values, node properties and relationships. Same-mode replay
remains exact. Sorting production inputs was deferred; removing the call fixture
was rejected as masking the failure. Correction run exited 0: 720 tests passed
in six suites; log `/opt/d1/tmp/ontoindex-mixed-erased-tests-correction-1.log`.
Discrimination tests reject missing/nonfinite scores, a 1e-8 score change and
node/edge changes. No production edits followed the successful build.

Commands from `ontoindex/`: `ONTOINDEX_MAX_WORKERS=4 npm run build` and
`ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs
run test/unit/scope-resolution/typescript-type-only-module.test.ts
test/unit/scope-resolution/typescript-export-captures.test.ts
test/unit/scope-resolution/typescript-captures.test.ts
test/unit/scope-resolution/typescript-import-captures.test.ts
test/unit/scope-unsupported-syntax-reason.test.ts
test/integration/scope-retention-replay-parity.test.ts --maxWorkers=1`.

Compiled classification verified all 43 frozen source hashes and saved
`eval/results/ontoindex-shared-pair-87x1w40f/capture-classification-08.json`.
Acceptance remains 15/41, with 26 refusals and no status changes. First refusals:
21 type identifiers, one type alias, two as-expressions, one array and one
unlocated export/import-owner error. These are first blockers, not a complete
syntax inventory.

OntoIndex committed HEAD matches `2623820`; dirty owners are absent from the
graph. Impact is UNKNOWN and safe-edit is CAUTION. Scoped verify_diff passed
for six source/test files; symbol scope was not checked. An initial verify_diff
with committed mode was rejected as unsupported; corrected invocation passed.
Explicit source whitespace/conflict checks passed, including untracked files.

Budget: one build, initial suite plus up to two diagnosed corrections, one
classification. Used: one build, two suites, one classification. No
background/detached jobs, installations, activation or commits were performed.
Historical structured manager remains closed; no task or lease was reopened.

## Remaining work

Real type binding and annotation semantics are the next prerequisite for the
frozen corpus; mixed statement-level type imports remain separate. Complete
replay admission, representative timing/RSS, CLI/MCP and required-language Linux
qualification remain open. This slice does not resolve large-workspace default
navigation or establish a speedup.
