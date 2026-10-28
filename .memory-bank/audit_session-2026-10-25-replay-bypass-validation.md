# Replay bypass validation

Date: 2026-10-25

The explicit opt-in replay path now has strict same-source admission, bounded
candidate copying, pinned previous-generation loading, supervised parser identity
checks, and staged parse graph publication. Default activation remains outstanding.

The resumed validation reviewed the final parse implementation and fixed failure
cleanup to preserve cancellation/copy errors while attempting both context and
binding disposal. Disposed reconstruction results are cleared before fallback.
Added cancellation-during-reconstruction/preservation, cleanup-failure,
reconstruction-refusal and invalid/expired-deadline regressions.

Fresh native validation in `ontoindex/`:

- `ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run` with
  `test/unit/parse-phase-lifecycle.test.ts`,
  `test/integration/scope-retention-bypass.test.ts`,
  `test/unit/parse-replay-admission.test.ts`,
  `test/unit/scope-retention-candidate-copy.test.ts`,
  `test/unit/workspace-parser-runtime.test.ts`,
  `test/unit/workspace-analysis-publication-order.test.ts`,
  `test/unit/run-analyze-snapshot.test.ts`,
  `test/unit/workspace-analysis-base-guard.test.ts`,
  `test/unit/workspace-analysis-durability.test.ts`,
  `test/unit/scope-retention-candidate.test.ts`,
  `test/unit/parse-replay.test.ts`, and `--maxWorkers=1`: exit 0,
  193 tests across 11 suites, 21.84 seconds; command session 37299.
- `ONTOINDEX_MAX_WORKERS=4 npm run build`: exit 0; command session 99761.
  npm warns about the existing `onnxruntime-node-install` configuration.
- Scoped `git diff --check`: exit 0.
- OntoIndex scoped `verify_diff`: PASS for parse.ts and its lifecycle test;
  symbol scope unchecked and impact scan capped at 25 symbols.

The index matches HEAD `2623820ec85113c28b238d5f72dde496e27426a1`, but
uncommitted changes are absent. Current source and executed tests are authority
for replay behavior. An audit request with committed mode was rejected; removing
that unsupported audit argument yielded the scoped result above.

Remaining acceptance: real supervised workspace round-trip through the caller,
runtime activation and budgets, recovery/performance measurement, edited-source
composition, complete required-language Linux qualification, and isolated CLI/MCP
installation proof. The real bypass suite covers JS, TS, Python, C++ and Rust;
it does not prove production activation. No installation, commit, release or
external publication was performed. The historical structured manager remains
closed; no task completion or authenticated receipt is inferred from this note.
