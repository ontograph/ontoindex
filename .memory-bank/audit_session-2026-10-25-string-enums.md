# TypeScript string enum capture

Date: 2026-10-25
Status: implemented and focused validation passed.

The frozen `src/languages.ts` contains one exported enum with 16 explicit string
members. Compiled capture coverage is now 14 accepted and 27 refused files.

Compared three fixes: reuse the existing Enum declaration/registration contract,
add enum member scopes and generalized member owners, or implement barrel
reexports first. Selected declaration reuse after independent second-pass review.
Member scopes expand shared resolution semantics; reexports cannot supply a
missing originating enum definition. The selected fix keeps the ordinary
declaration, module binding and export while validating reference-free literals.

Review found the legacy TypeScript query lacks enum definitions. Scope-only
capture would omit graph registration evidence. Add the enum query through the
existing TS query owner (also TSX/Vue); JavaScript retains its separate query.
This intentionally adds Enum nodes to normal graph extraction. Scope definition
IDs and graph IDs remain separate existing identities; registration must match
the graph declaration. No new registry or member-resolution system is needed.

Capture acceptance is restricted to top-level ordinary enums with unique
identifier members and explicit plain string values. Const/ambient/nested enums,
numeric/implicit/computed/escaped values, malformed syntax, and duplicate or
merged declarations remain refused. Member definitions and property-reference
semantics are outside this slice. No runtime execution is introduced. Validation
is linear in member count; no performance gain is claimed. Rollback removes only
this slice's source and test edits, preserving prior dirty state.

Four GPT discovery/review agents and two GPT implementation agents have disjoint
source/test packets. Committed OntoIndex HEAD is current at
`2623820ec85113c28b238d5f72dde496e27426a1`; declaration/export/query impacts LOW.
Dirty composer is unindexed and its impact UNKNOWN; source inspection is
authority. Historical structured manager remains closed.

Validation budget: one build plus one diagnosed correction build if required,
one focused suite plus up to two diagnosed correction suites, one compiled
frozen-file classification. Parent owns all serial native execution. No
representative benchmark, activation, install, or release.

## Validation

Native build completed successfully; retained log:
`/opt/d1/tmp/ontoindex-string-enums-build.log`.

Final focused Vitest run passed all 690 tests in five suites, exit 0, 17.36s.
Command from `ontoindex/`: `ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node
node_modules/vitest/vitest.mjs run test/unit/scope-resolution/typescript-captures.test.ts
test/unit/scope-resolution/typescript-declaration-captures.test.ts
test/unit/scope-resolution/typescript-export-captures.test.ts
test/unit/tree-sitter-queries.test.ts
test/integration/scope-retention-replay-parity.test.ts --maxWorkers=1`.
Log: `/opt/d1/tmp/ontoindex-string-enums-tests-correction-1.log`.
Coverage includes TS/TSX native queries, JavaScript isolation, refusal cases,
and sequential/worker/recovery graph and registration replay parity.

Initial run had 685 passing and five failing tests. Three failures came from
a test selecting both File and Enum nodes by file path; two were cascading.
The correction asserts exactly those two labels and exactly one Enum, preserving
registration identity checks. Production code was unchanged. One correction
suite was consumed; no correction build was required.

Compiled frozen classification exited 0 after verifying all 43 source hashes:
`eval/results/ontoindex-shared-pair-87x1w40f/capture-classification-04.json`.
Of 41 TypeScript files, 14 are accepted and 27 refused. This is emitter coverage;
representative replay timing and RSS remain unqualified.

Final scoped OntoIndex verify_diff passed for the four production and five test
files. Its impact scan was capped at 25 symbols and expectedSymbols was omitted,
so this establishes file scope only. Scoped git diff --check exited 0; untracked
file contents are covered by tests, not by that diff check.

Historical structured manager remains closed with no active selected task.
Remaining work: refused capture families, representative full/replay measurements,
public CLI/MCP behavior, required-language Linux and isolated installation gates.
