# Persisted replay PageRank validation

Date: 2026-10-25

The existing parity suite now captures the real PageRank phase input and output,
then runs the same production phase on the reconstructed persisted graph. All
six fixtures (JS, TS, C++, Rust, supported and mixed Python) run through sequential,
worker and recovery paths. Complete ranked graphs agree exactly, including scores.

The tests explicitly require intermediate route/tool/ORM/cross-file phases to
leave these fixture graphs unchanged. Parse graphs have no importance scores;
PageRank adds nonempty finite positive scores. Removing an importance score is
detected through the snapshot comparator. This proves PageRank parity for these
fixtures, not nontrivial execution of the preceding phases.

One test invocation from `ontoindex/`:

`ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/integration/scope-retention-replay-parity.test.ts --maxWorkers=1`

Exit 0: 30 tests, 11.66 seconds. No build, install, deployment or reindex.
Four research agents plus Sol medium implementation and challenge agents completed.
Bounded OntoIndex verify_diff passed for the test file; symbol scope was omitted.
Navigation/impact failed with workspace_too_large (1832/1600); source inspection
was authoritative. Floating-point ordering was reviewed; no tolerance was needed
for these fixtures, which does not guarantee exact scores for arbitrary graphs.

Remaining inputs: retention has no fetch-call, framework/decorator-route, tool
definition or ORM-query family. Routes/tools also reread source and routes load
model packs; cross-file refinement rereads source. PageRank only consumes the
graph. Consider ORM-query retention as the next bounded schema change, or a
source-pinned cross-file test with nonzero filesReprocessed. Neither should imply
artifact-only full-pipeline replay. Semantic admission, activation and runtime
acceptance remain open; seedReady stays false.
