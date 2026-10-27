# Workspace repair input identity

Source implementation and focused validation completed on 2026-10-24.

Review confirmed that typed preparation diagnostics and committed-mode recovery
already exist in source. The 1,600-file preparation ceiling remains; the running
MCP service has not been rebuilt or switched by this task.

Selected reuse of validated source hashes over raising limits, extending
cooldowns, or adding another filesystem hashing pass. Snapshot validation now
supplies an internal repair digest after validating source, configuration and
parser identity. Repair admission uses the locked unreadable snapshot. Changed
validated bytes can earn a repair; publication-only churn cannot. Stale locked
snapshots use normal rebuilding without spending quarantine repair allowance.

Changed owners: `ontoindex/src/mcp/local/backend-overlay.ts` and
`ontoindex/src/mcp/local/local-backend-repo-runtime.ts`. Regression coverage is
in `local-backend-repo-runtime.test.ts` and
`overlay-read-failure-quarantine.test.ts` under `ontoindex/test/unit/`.
Existing unrelated working-tree changes were preserved.

Four agents participated: two read-only Luna/Sol reviewers and two
`gpt-6.1-sol` medium developers with disjoint writes. Independent source review
found no actionable issue. The snapshot owner has critical transitive impact;
the additive identity field is internal and only populated after validation.

Validation ran serially in the foreground from `ontoindex/`:

- Five focused Vitest suites: runtime, backend overlay, quarantine, dispatch,
  and MCP error path. First run: 432 passed, one fixture capability mismatch,
  exit 1. Corrected the fixture to publish a complete workspace graph.
  Final run: 433 passed, exit 0; terminal receipt `cca166`.
- `./node_modules/.bin/tsc --noEmit --incremental false`: exit 0, receipt
  `0b12a1`. Subsequent correction changed only the test fixture.
- Scoped whitespace check passed. OntoIndex declared-file `verify_diff` passed;
  symbol scope was skipped. Committed navigation excludes dirty source changes.

Execution allowance used: two of two focused suite invocations, one of two
typechecks, no product build, deployment, or detached job. No latency or memory
improvement is claimed. Remaining large-workspace work requires complete replay
admission and runtime acceptance; this change does not establish those gates.
