# Real workspace replay round-trip

Date: 2026-10-25

Added `ontoindex/test/integration/scope-retention-workspace-roundtrip.test.ts`.
The integration test initializes the real parser runtime baseline before dynamic
analyzer imports, then exercises real workspace capture, candidate persistence,
admission, copying, generation pins, pipeline execution and native database writes.

Five published workspace generations establish initial capture, two unchanged
parser bypasses, source invalidation and configuration invalidation. Two independent
fresh parses establish fallback graph parity. Assertions compare complete pipeline
graphs and stored native node IDs/edge tuples, match candidate identities to
published base metadata, and verify reader-pin and temporary-capture cleanup.
The test forwards existing pipeline options and forces sequential parsing.

Validation in `ontoindex/`:

`ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/integration/scope-retention-workspace-roundtrip.test.ts --maxWorkers=1`

Exit 0; one test passed; 19.20 seconds total, 17.99 seconds test time;
command session 25853. This is functional proof, not a performance benchmark.
OntoIndex scoped verify_diff PASS; expected symbol scope was not supplied.
No production source changed, so no new production build was needed. Existing
dirty changes were preserved; no installation, publication or commit was performed.

Four independent Luna/Sol research/review packets examined caller harnesses,
test completeness, activation ownership and rollback/pinning. A fifth Sol packet
implemented the single test file. No concrete production correctness defect was
confirmed. Parent review corrected the test design so an independent fresh parse
does not replace CURRENT and invalidate the subsequent configuration-miss proof.

The committed graph matches HEAD but excludes current dirty changes; source and
executed tests are authority. The test adopts the child's startup ordering inside
the test process; it does not launch the production child or prove its activation.

Next: connect bounded retention to the existing supervised child, using its
existing deadline/process lifecycle; validate compiled-child reuse and recovery,
then measure performance and qualify isolated Linux CLI/MCP installation. Of the
activation alternatives, parent-only retention leaves the child gap, and a separate
post-build process duplicates ownership. A narrow internal child request is the
preferred direction, with budget/protocol decisions still to be finalized.
Default replay remains disabled. The historical manager tracker remains closed;
this checkpoint does not assert authenticated task completion.
