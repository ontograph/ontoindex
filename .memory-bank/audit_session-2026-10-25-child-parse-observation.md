# Compiled-child parse outcome observation

Date: 2026-10-25

Four Luna/Sol discovery/review packets compared progress messages, supervisor
telemetry, and a scalar carried through existing result and generation metadata.
Two Sol implementation packets changed disjoint production and test files.

Selected the scalar after a second challenge: progress can precede publication,
supervisor telemetry needs a new transport, and test-loader instrumentation can
change parser identity. `parseMode` now records `full` or `retained-replay` only
on successful parse return, after replay preservation and graph merge. It follows
the existing pipeline result into `base.json` under `buildTimings`; missing or
unrecognized injected-runtime outcomes are omitted. The test reads the generation
selected by CURRENT only after successful child completion. No callbacks, extra
traversal, default activation or child protocol were added.

Regression coverage asserts full/replay/replay/full/replay across five real child
generations, corroborates metadata with the source-runtime parser spy, retains
preservation/cancellation rejection tests, and checks scalar stability after
disposal. Publication tests reject invented modes and preserve missing evidence.

Validation commands run serially in `ontoindex/`:

- `ONTOINDEX_MAX_WORKERS=4 npm run build`: exit 0, session 37465.
- `ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/unit/parse-phase-lifecycle.test.ts test/unit/workspace-analysis-publication-order.test.ts test/integration/scope-retention-child-roundtrip.test.ts test/integration/scope-retention-workspace-roundtrip.test.ts --maxWorkers=1`: exit 0, 50 tests across four suites, 47.72 seconds, session 99104.
- Scoped `git diff --check`: exit 0.
- OntoIndex scoped verify_diff: PASS for eight files; symbol scope unspecified
  and impact scan capped at 25 changed symbols. Committed graph matches HEAD;
  dirty source remains authority. Depth-one workspace impact LOW; broader worker
  impact HIGH, reinforcing unchanged publication/cancellation gates.

The existing `large-codebase-benchmark.mjs` measures CLI wall time, process-tree
RSS and phase timing but lacks a retained-workspace replay arm. Performance
acceptance still needs paired repeated full/replay builds on identical inputs,
graph parity, actual mode discrimination and a published-workspace reuse baseline.
Tiny fixture elapsed time is functional evidence only. Default activation,
optional-cache availability semantics, required-language Linux qualification and
isolated CLI/MCP installation remain open. Historical structured manager is
closed; this checkpoint does not assert authenticated manager completion.
