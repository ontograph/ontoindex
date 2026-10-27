# Dense array capture

Date: 2026-10-25

Compared empty-only arrays, literal-only arrays and reuse of the iterative
expression walker for arrays containing supported expressions. Selected the
shared walker after a second review of reference completeness, ordering and
arity. No new schema, dependencies or traversal owner were introduced.

The composer now accepts dense arrays in initializers, arguments, return/throw,
expression statements and conditions. Elements may contain existing literals,
identifier reads, calls, constructors, parentheses and nested arrays. Empty
arrays, comments and trailing commas are supported. Holes, spread, objects,
casts, templates, unsupported calls and array receivers remain refused.
Validation and reference traversal use an explicit worklist. Call arity remains
owned by the existing reference emitter; array contents count as one argument.

Changed files:
- ontoindex/src/core/ingestion/languages/typescript-captures.ts
- ontoindex/test/unit/scope-resolution/typescript-captures.test.ts

Four read-only Sol/Luna packets preceded two disjoint Sol implementation packets.
Independent source review found no actionable defect. Generic annotation work
was deferred because its discovery packet did not establish the actual owner.

## Validation

Native build exited 0: /opt/d1/tmp/ontoindex-dense-arrays-build-1.log.
From ontoindex/, ONTOINDEX_MAX_WORKERS=4 npm run build.

Scope unit suites plus scope-retention-replay-parity passed: 1815 tests in 30
suites, exit 0, /opt/d1/tmp/ontoindex-dense-arrays-tests-1.log. Command from
ontoindex/: ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node
node_modules/vitest/vitest.mjs run test/unit/scope-resolution
test/integration/scope-retention-replay-parity.test.ts --maxWorkers=1.

A test-only as-const edit landed four seconds after this invocation began.
The affected file was frozen and rerun using the same command with only
test/unit/scope-resolution/typescript-captures.test.ts selected: all 379 tests
passed, exit 0, /opt/d1/tmp/ontoindex-dense-arrays-tests-final.log. Production
was unchanged after build. Tests cover exact reference facts, shadowing, receiver
ordering, arity, atomic refusal, parser reuse and 128-level mixed nesting.

OntoIndex index HEAD remains current at 2623820; composer is untracked and
absent from committed graph. Workspace safe-edit refused 1832 files over 1600.
Source is authoritative. Bounded verify_diff passed file scope; no symbol scope
was asserted. Both edited files are untracked; no-index whitespace checks emitted
no diagnostics (exit 1 represents the file-addition difference).

## Remaining work

No corpus or performance attempt was made; the prior 15/41 admission figure
is historical and must not be applied to this new build. Remaining runtime
syntax, complete-workload replay/time/RSS and installed Linux CLI/MCP
qualification for JS/TS/Python/C++/Rust remain open. No installation, activation
or commit occurred. Rollback only this array slice, preserving prior dirty work.

Cumulative budget: 2/4 builds, 4/8 test invocations, 2/2 corpus/performance
attempts. Further measurements require an explicit scoped budget amendment.
Historical structured manager remains closed; this records slice evidence only.
