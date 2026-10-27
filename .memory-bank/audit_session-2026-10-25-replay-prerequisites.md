# Replay prerequisite validation

Date: 2026-10-25

The replay planner now refuses empty, dot and parent path segments in either
input list. Valid dot-containing Linux names remain accepted. Rejecting aliases
preserves record identity; normalization would silently change it, and caller-only
validation would leave the planner contract inconsistent.

Persisted resolver parity now covers JavaScript, TypeScript, Python, C++ and
Rust fixtures through sequential parsing, the production worker and controlled
worker recovery. The existing comparator checks node IDs and CALLS/write edges;
it does not establish full graph equivalence or semantic admission.

Validation from `ontoindex/` after the edits:

- `ONTOINDEX_MAX_WORKERS=4 npm run build`: exit 0.
- `ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/unit/scope-retention-replay-plan.test.ts test/integration/scope-retention-replay-parity.test.ts test/integration/scope-retention-replay-edit-differential.test.ts --maxWorkers=1`: exit 0, 81 tests across 3 suites, 19.60 seconds.
- OntoIndex planner impact: LOW, zero non-test upstream callers. Safe-edit
  warned about its exported API; malformed-path tightening was intentional.
- Bounded OntoIndex verify_diff: PASS for the three changed source/test paths;
  symbol scope was not checked.

Four read-only Luna/Sol reviews and two Sol medium implementation packets were
harvested. One build and one focused test invocation ran serially; no detached
jobs, deployment, reindex or structured tracker mutation occurred.

Candidates remain `seedReady: false`. Remaining work includes phase-aligned
full-graph parity, generation/post-edit admission evidence, graph activation and
runtime/performance acceptance. Previous runtime measurements do not validate
this edited workspace. The installed CLI/MCP was not upgraded in this slice.
