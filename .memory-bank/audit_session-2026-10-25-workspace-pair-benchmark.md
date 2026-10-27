# Compiled workspace pair benchmark

Date: 2026-10-25

The existing large-codebase benchmark now accepts `--mode workspace-pair
--cli built --pairs 1` (one through five pairs). Each pair runs plain full,
retention capture, then retained replay through the existing compiled child,
supervisor and analyze lock. Retention remains opt-in. Reports require an output
directory outside the measured repository and refuse existing artifact names.

Four discovery packets compared custom process management, public CLI retention
flags and reuse of the existing supervisor. Two implementation packets changed
disjoint script and test files; an independent reviewer found no remaining
correctness defect in this scope. Supervisor reuse preserves lifecycle ownership.
Second review corrected fixed-order candidate reseeding, output symlink containment,
cross-pair identity drift and recorded worker concurrency.

Acceptance checks actual full/full/retained-replay outcomes, complete coverage,
zero parse errors, candidate completeness, source/config/parser/commit/base
identity and sorted node-ID/edge-tuple parity. Reports preserve phase metadata,
whole-child elapsed time, capture overhead and compact graph fingerprints.
The supervisor receives cancellation; the lock and signal listeners are released.
Failures stop the sequence and produce failed reports where filesystem writes
remain possible. Report-write errors may leave reserved partial evidence files.

Validation from `ontoindex/`, after final source edits:

- `ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/unit/large-codebase-benchmark.test.ts test/unit/workspace-pair-benchmark.test.ts test/integration/workspace-pair-benchmark.test.ts --maxWorkers=1`: exit 0, 98 tests, three suites, 17.33 seconds, session 79046.
- Includes one real compiled three-child smoke on an isolated TS fixture,
  report/parity checks, cleanup, deterministic negative gates and existing
  benchmark regressions. Temporary fixture reports are deleted by test cleanup.
- Scoped OntoIndex `verify_diff`: PASS for the two scripts and two new tests;
  expected symbol scope was not specified. Initial committed-mode audit was
  rejected because that option is navigation-only; corrected ordinary scoped
  audit succeeded. Committed index matches HEAD, dirty source remains authority.
- Scoped tracked-file whitespace check: exit 0. New files were exercised by
  the passing suite. No build was needed: only scripts/tests changed and the
  existing compiled child was exercised successfully.

Budget used: one test invocation, one synthetic three-child sample, zero builds,
zero representative measurements; no corrective test retry needed.

Remaining: representative repeated measurements (the pinned sibling
`entire-graph` checkout is absent), published-generation reuse latency, RSS,
optional-cache availability policy, required-language Linux qualification and
isolated CLI/MCP installation. Fixed order and warm caches limit interpretation;
no performance improvement is claimed from the smoke. The separate legacy
benchmark timeout-escalation concern discovered during review remains outside
this patch. Historical structured manager stays closed; this evidence does not
assert authenticated manager completion or authorize default activation.
