# Candidate resolver edge admission

EDGE-1 completed through runtime complete-local on 2026-10-24.

Changed the candidate reader and its unit test. Reader now rejects CALLS and
ACCESSES with reason write, matching capture; allowed structural and read-access
edges retain existing behavior. Six regressions cover retained/incomplete states.

Four agents participated, including two gpt-6.1-sol medium developers with
disjoint source/test writes. Independent source review passed.

From ontoindex/: focused Vitest candidate-reader and scope-retention suites
passed 416 tests, exit 0, session 35360 terminal 765049. TypeScript noEmit
incremental false passed exit 0, session 57614 terminal 3072ec. Whitespace passed.
One suite and one typecheck used; no retries, build, deployment or activation.
One plan schema correction added tests to owner_files before dispatch.

OntoIndex index matched HEAD but lacked the dirty candidate symbol. Impact
UNKNOWN and safe-edit CAUTION; direct source was authority. Declared-file
verify_diff passed; symbol scope was not checked.

Next prerequisite: review the planner's external admission contract. Descriptive
coverage may include skipped files; no production planner caller was found.
This concern is not evidence of an active runtime failure.
