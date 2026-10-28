# Static object value capture

Date: 2026-10-25

Compared generic descendant traversal, full object support and static pairs in
the existing iterative expression walker. Two reviews selected static pairs:
generic traversal risks key reads and incorrect method ownership; full support
requires separate method, spread and expression semantics. The selected change
uses linear traversal, no dependencies or schema changes, and two source/test
files. Rollback only this slice, preserving previous untracked work.

The composer accepts static identifier/string/number keys and visits values
only, in source order. Empty objects, comments, trailing commas and supported
nested expressions work across all existing expression positions. Shorthand,
computed/private keys, methods/accessors, spreads, escaped keys and bare/quoted
__proto__ remain refused. Escaped ordinary keys are deliberately conservative.

Changed files:

- ontoindex/src/core/ingestion/languages/typescript-captures.ts
- ontoindex/test/unit/scope-resolution/typescript-captures.test.ts

Four read-only Sol/Luna packets and two disjoint Sol implementation packets were
used. Two independent source reviewers found no actionable defect. One worker
initially rejected a packet missing its validation command; the corrected packet
delegated execution to the parent. No child ran builds, tests or measurements.

## Validation

Native build exited 0: /opt/d1/tmp/ontoindex-static-objects-build-1.log.
Command from ontoindex/: ONTOINDEX_MAX_WORKERS=4 npm run build.

First scope/replay run exited 1: 1811 passed, 20 failed in five obsolete
empty-object negative cases across four extensions. All new object tests passed.
Evidence: /opt/d1/tmp/ontoindex-static-objects-tests-1.log. Replaced those five
negative inputs with unsupported shorthand objects; production stayed frozen.
This was correction round one, owned by the same test file. The final full scoped
run passed all 1831 tests across 30 suites, exit 0, in
/opt/d1/tmp/ontoindex-static-objects-tests-final.log. Both source files stayed
frozen during that run. Tests cover exact value references/ranges, lexical
shadowing, receiver ordering, atomic refusal, parser reuse and deep nesting.

Command from ontoindex/: ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node
node_modules/vitest/vitest.mjs run test/unit/scope-resolution
test/integration/scope-retention-replay-parity.test.ts --maxWorkers=1.

OntoIndex safe-edit refused workspace_too_large (1832 > 1600); committed graph
does not contain the untracked composer. Source inspection is authority.
Bounded verify_diff passed file scope; symbol completeness was not checked.
No-index whitespace checks emitted no diagnostics (exit 1 denotes additions).
No ontocode-rs directory exists here, so Rust formatting is inapplicable.

## Remaining work

Static pairs alone do not unblock the three frozen registry fixtures: their
outer objects contain methods and later spread, conditional, member-read and
nullish expressions. No new corpus admission or performance result is claimed.
The earlier 15/41 figure remains historical. Complete syntax, representative
replay/time/RSS and installed Linux CLI/MCP qualification remain open.

Cumulative executions: 3/4 builds, 6/8 tests, 2/2 corpus/performance attempts.
Further measurements require a scoped budget amendment. No installation,
activation or commit occurred. The historical structured manager remains
closed; this document records slice evidence, not authenticated plan completion.
