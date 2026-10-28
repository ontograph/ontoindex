# Workspace RSS benchmark validation

Date: 2026-10-25
Outcome: sampled Linux process-tree RSS instrumentation validated.

## Decision and scope

Compared a separate process wrapper, polling the recovery owner marker, and an
optional PID observer in the existing supervisor. Selected the observer: one
owner retains spawn, cancellation, timeout, reaping and artifact cleanup. A
throwing observer is reaped before failure is returned. Marker polling risks
missing short children; a wrapper duplicates lifecycle ownership.

Shared `ontoindex/scripts/benchmark-memory.mjs` now serves both benchmark modes.
It serializes scans, drains outstanding reads, preserves independent component
peaks, distinguishes absent/dead roots from malformed live observations and
records failures. Pair reports include per-leg RSS and retain failed-leg metrics.
Requested ceilings fail closed on unavailable/error observations. No-ceiling
graph runs can succeed with explicitly recorded sampling errors.

Source/test scope: workspace-build-supervisor.ts, large-codebase-benchmark.mjs,
workspace-pair-benchmark.mjs, benchmark-memory.mjs and their five focused suites.
Five Luna/Sol agents supplied discovery, implementation, tests and challenge.
Review corrected lost component peaks, overlapping/error-drain risks and legacy
benchmark unhandled sampling errors before final validation.

## Validation

Package working directory: `/opt/d1/_wrk/ontoindex/ontoindex`.

- `ONTOINDEX_MAX_WORKERS=4 npm run build`: session 78726, exit 0.
- `ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/unit/workspace-build-supervisor.test.ts test/unit/benchmark-memory.test.ts test/unit/large-codebase-benchmark.test.ts test/unit/workspace-pair-benchmark.test.ts test/integration/workspace-pair-benchmark.test.ts --maxWorkers=1`:
  initial session 26021, exit 1, 198 passed/1 failed. Compiled benchmark passed;
  its assertion incorrectly required zero host sampling errors without a ceiling.
  The observed scan-error cause is unknown. Corrected only that assertion to
  validate a nonnegative error count while retaining positive sample/peak and
  persisted-report checks. Final session 46195, exit 0, 199 passed in five suites,
  22.91 seconds. Includes actual compiled full/full/retained-replay and snapshot
  validation, supervisor failure cleanup, synthetic /proc and ceiling failures.
- Scoped `git diff --check`: exit 0.
- OntoIndex `verify_diff`: PASS for nine code/test paths, no unexpected files;
  symbol scope was not asserted and impact output was capped at 25 symbols.

Budget used: one build, two suite invocations (initial plus one evidence-driven
fixture correction). No detached shell jobs, installation, commit or publication.
Build emitted npm configuration warnings; tests emitted bundled sourcemap warnings.
No complete repository suite or representative workload measurement was run.

## Limits and remaining work

RSS is sampled, non-atomic and sums shared pages per process; short-lived or
reparented descendants and between-sample peaks can be missed. A passing ceiling
applies to observed samples, not a hard OS memory bound. No performance claim is
established by the tiny fixture. Representative paired measurements, public
CLI/MCP latency/reuse, availability policy, required-language Linux and isolated
installation qualification remain open. Default replay activation is unchanged.
The historical structured manager remains closed; no task receipts were created.

Committed index and HEAD matched `2623820ec85113c28b238d5f72dde496e27426a1`;
uncommitted source was verified directly. Initial undersized context-response
budget was corrected; explicit committed context succeeded.
