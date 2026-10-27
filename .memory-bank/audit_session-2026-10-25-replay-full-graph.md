# Complete parse-boundary replay comparisons

Date: 2026-10-25

Both persisted replay integration suites now compare complete cloned node and
relationship records sorted by ID. A test-only wrapper awaits the real
`parsePhase.execute`, captures the live producer graph immediately, and returns
the original output. The wrapper runs exactly once and is restored in `finally`.
This aligns expected evidence with retention before downstream enrichment.

The unchanged-input suite covers bounded JS/TS/Python/C++/Rust fixtures and mixed
Python refusal through sequential, worker and recovery paths. Negative controls
pass changed node properties, removed structural edges and changed edge properties
through the snapshot function. Call-target assertions still require CALLS edges.
The edit suite preserves its existing match/diverge matrix and composition logic;
redundant JSON-string equality was removed in favor of deep object assertions.

Alternatives reviewed: phase interception uses the existing owner and preserves
the execution profile; graph-factory interception is more brittle; symbols-only
execution changes the tested profile. No production hook or admission change.

Validation from `ontoindex/`:

`ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/integration/scope-retention-replay-parity.test.ts test/integration/scope-retention-replay-edit-differential.test.ts --maxWorkers=1`

Exit 0: 50 tests, 2 suites, 19.68 seconds. One test invocation, no build or
deployment; existing production worker dist was reused for this test-only change.
Four review agents and two Sol medium implementation agents completed.

OntoIndex live context and impact requests failed `workspace_too_large`
(1832 files, limit 1600); source inspection was authoritative. Bounded
verify_diff passed for the two test paths; symbol scope was not checked.

Candidates remain `seedReady: false`. These fixtures establish full graph parity
at the parse boundary only. Downstream-phase replay, generation/post-edit
admission, activation and runtime/performance acceptance remain open.
