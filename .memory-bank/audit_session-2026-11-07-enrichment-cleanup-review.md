# Search enrichment and fixture cleanup review

Scope: qualification at commit `12c2107`; code and focused validation only.

Four independent GPT reviews confirmed useful prior changes: serialized native
enrichment and fixture-local diagnostics. Remaining gaps are repeated optional
work after resource failure and unbounded fixture cleanup in installed Vitest.

## Decisions

| Issue | Alternatives reviewed | Selected approach |
| --- | --- | --- |
| Repeated enrichment waits | Shared deadline; request-local stop after resource/timeout failure; parallel enrichment | Stop later optional families, retain completed results and existing warnings. |
| Fixture cleanup | Suite hooks with per-test state; test-context completion hook; custom timeout race | Use Vitest's bounded completion hook with a per-test closure. |

Second challenge: a deadline wrapper cannot cancel native work. Parallelism
reintroduces overlapping memory demand. A custom cleanup race risks deleting
files while close remains active. The existing completion hook preserves
test-local ownership without adding a state registry. Neither choice establishes
a whole-request latency bound or guarantees native operation cancellation.

Implementation order: repair enrichment with regression coverage; move fixture
cleanup to the bounded hook; run focused tests and typechecks serially; verify
the final diff. No build, installation or release is part of this work.

## Evidence corrections

The external qualification report's claim that the failure command and log were
never captured is inaccurate. `/tmp/ontoindex-259-release-gate.log:331` records
`vitest run test/integration`; lines 337–406 show native buffer exhaustion and
the failing deep exploration test. The exact original staged tree remains
unproven. The final gate log identifies passing tree
`22539d94a2e351190791963349292cd1e07e290b`, matching `12c2107^{tree}`.
This is evidence of a passing rerun, not proof of the native failure's cause.

The report lists one production latency finding, one harness finding and a
coverage gap, despite its opening count of two production findings. Kotlin,
Dart and Ruby coverage remains deferred by user scope. Environment matrix
expansion and a native stress benchmark are separate qualification work.

## Validation

Implemented request-local stopping across the four lookup families and later
optional graph-path and skeleton queries. Ordinary errors retain compatibility
fallbacks. Cleanup uses test-context `onTestFinished`, keeping close-before-delete
ordering and per-test diagnostics.

Fresh focused tests passed: 59 search lookup tests and 15 native overlay tests
(exit 0). Production and test TypeScript checks passed (exit 0). The bounded
OntoIndex diff audit passed; it executed no tests. No build was run.

The native suite exercises ordinary cleanup. Deliberately never-settling native
close and cleanup-hook failure-report wiring were not injected; hook timeout
behavior is supported by installed Vitest source inspection. Native timeout
cancellation and a total search deadline remain outside this fix.

## Hook regression follow-up

Added `ontoindex/test/unit/overlay-generations-hooks.test.ts` to execute the
actual extracted fixture callback through installed Vitest with native-free
dependencies. Success, reader rejection, database rejection and a blocked
database close run in one bounded child. The parent verifies closure ordering,
no premature deletion, per-test outcomes and owning diagnostic phases.

Before the final correction, three focused invocations exited 1. The first hit the
20-second child timeout because Vitest's named project did not inherit the CLI
hook-timeout override. A standalone temporary config fixed this. The second
exposed JSON reporter suppression of console output; direct console output
fixed that. The third reached the final timeout-message assertion: the JSON
report serialized `Error: STACK_TRACE_ERROR`, while the test expected
`Hook timed out in 100ms`. Earlier ordering and owning-phase assertions passed.
Test TypeScript validation exited 0. These failed attempts remain historical
evidence and are not counted as passing checks.

Completed the authorized correction: the child captures structured error messages
through `onTestFailed` in task metadata, which the existing JSON reporter emits.
This avoids a custom reporter or console-text dependency while preserving timeout
identity, process safety limits and cleanup ordering checks.

Final focused invocation passed (1 parent test, exit 0, 1.05 seconds). Its child
intentionally reports one success and three failures, all checked by the parent.
Test TypeScript validation passed (exit 0). Scoped ESLint passed with zero errors
and two non-null-assertion warnings. This proves asynchronous hook timeout and
failure-report wiring; it does not prove cancellation of a synchronous native hang.
Prettier completed for the new regression and `git diff --check` passed (exit 0).
Bounded OntoIndex `verify_diff` passed for all six expected files, including the
two untracked files; it executed no tests and did not check symbol scope.
No production changes or builds were made in this follow-up.
