# 2.4.7 qualification follow-up

Date: 2026-11-01
Status: Closed
Authority: User requests robust performant proposals from open tracker work and immediate execution without paperwork blocking tasks.

## Goal

Repair confirmed qualification regressions and preserve actionable evidence for unresolved workspace and buffer contention.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: closed
  selection_policy: active_next_task-first
  active_next_task: null
  max_in_flight: 1
  dispatch_mode: none
  reopen_gate: null
tasks:
  FIX-1:
    title: Ambient exports route bindings wide integer diagnostics and local installation retain correct boundaries
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: integration
    impact_risk: high
    owner_files:
    - ontoindex/src/core/ingestion/export-detection.ts
    - ontoindex/test/integration/parsing.test.ts
    - ontoindex/test/integration/worker-pool.test.ts
    - ontoindex/src/core/ingestion/route-extractors/response-shapes.ts
    - ontoindex/test/unit/shape-check.test.ts
    - ontoindex/src/core/systems-audit/abi-diff.ts
    - ontoindex/test/unit/systems-abi-diff.test.ts
    - scripts/install-ontoindex-latest.sh
    - ontoindex/test/unit/install-local-cleanup.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/export-detection.ts
    - ontoindex/test/integration/parsing.test.ts
    - ontoindex/test/integration/worker-pool.test.ts
    - ontoindex/src/core/ingestion/route-extractors/response-shapes.ts
    - ontoindex/test/unit/shape-check.test.ts
    - ontoindex/src/core/systems-audit/abi-diff.ts
    - ontoindex/test/unit/systems-abi-diff.test.ts
    - scripts/install-ontoindex-latest.sh
    - ontoindex/test/unit/install-local-cleanup.test.ts
    non_goals:
    - Public release or version bump
    - Unrelated GN gates
    - Speculative memory sizing
    required_validation:
    - Focused owner tests and source review
    - Bounded OntoIndex verification
    expected_evidence:
    - Ambient exports route bindings wide integer diagnostics and local installation retain correct boundaries
    rollback:
    - Revert only task owned changes
    stop_conditions:
    - Repeated unchanged failure
    - Exhausted declared execution allowance
    known_blockers: []
    closeout:
      main_session_evidence:
        authorized_by: user
        authorization_ref: 2026-11-01 select robust proposals and proceed request
        validation_summary: Native build1 exit0 (session24734 terminal1945cf); focused suite1 passed226 tests in9 files exit0 (session80867 terminale2da16), including sequential/compiled worker exports, JS/TS route boundaries and replay, ABI and installer cleanup. Bounded OntoIndex verify_diff PASS for exact9 files; independent source challenges corrected JS ambient fixtures and direct Next.js loop mutations before validation. Logs /tmp/ontoindex-247-followup-build1.log and /tmp/ontoindex-247-followup-focused1.log.
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
    dod_status: pass
  DIAG-1:
    title: Workspace failures preserve bounded lock owner evidence without relaxing busy refusal
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - FIX-1
    type: code
    validation_tier: integration
    impact_risk: high
    owner_files:
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    allowed_write_set:
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    non_goals:
    - Public release or version bump
    - Unrelated GN gates
    - Speculative memory sizing
    required_validation:
    - Focused owner tests and source review
    - Bounded OntoIndex verification
    expected_evidence:
    - Workspace failures preserve bounded lock owner evidence without relaxing busy refusal
    rollback:
    - Revert only task owned changes
    stop_conditions:
    - Repeated unchanged failure
    - Exhausted declared execution allowance
    known_blockers: []
    closeout:
      main_session_evidence:
        authorized_by: user
        authorization_ref: 2026-11-01 select robust proposals and proceed request
        validation_summary: 'Diagnostic acceptance met: final workspace run2 preserves missedEvent exit1 workspace_busy with analyze/watch PID2497565 in /tmp/ontoindex-247-followup-workspace2.json, cleanup exit0; suite exit1 with2 passed/1 failed (session82467 terminalcd3ce2). This is retained product failure evidence, not a passing replay. Corrected bounded projection unit passed (session11578 terminald8df95); DIAG ESLint exit0 (session16377 terminal3d4337), bounded OntoIndex verify_diff PASS, git diff check exit0. No retries or product busy semantics changed.'
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
    dod_status: pass
```

## Required Traceability

| Requirement ID | User requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| R1 | Repair four qualification findings and installer follow-up | implementation | FIX-1 | Parser worker route ABI and shell regressions |
| R2 | Diagnose unresolved workspace failure | implementation | DIAG-1 | One instrumented integration run and retained evidence |
| R3 | Use OntoIndex and select robust efficient fixes | proof-only | FIX-1 | Impact and bounded verification |

## Decisions And Non-Goals

| Issue | Three alternatives | Selection and second challenge |
| --- | --- | --- |
| Ambient exports | Restore ancestor scan; explicit ambient wrapper; provider adapter normalization | Explicit wrapper preserves nested ownership and private declare controls; broad walk reintroduces false exports. |
| Loop and shadow mutations | Complete lexical prepass; rescan per route; control-flow engine | Resolve queued writes against completed bindings, preserve cache. Cover loop var hoisting and declaration-node Next.js paths. Per-route scans waste work; control flow exceeds proven need. |
| Wide integers | Normalize bigint with existing mismatch diagnostic; add width schema; raw-type exceptions only | Normalize128 to bigint; high severity for128-to-number with existing BIGINT_NUMBER_MISMATCH and precise message. Preserve64 reason codes. Regex-only warnings leave bigint false positives. No new public schema. |
| Installer | Optional conditional cleanup; force success unconditionally; duplicate local installer | Conditional cleanup succeeds when absent and preserves real cleanup failures. Unconditional success masks errors; duplicate driver creates ownership drift. |
| Workspace busy | Capture owner evidence; bounded product wait; serialize test | Capture bounded synthetic-fixture lock evidence before cleanup. No retry or weakened assertion without cause; isolated pass cannot clear original failure. |
| Buffer exhaustion | Raise memory; serialize queries; reduce query fanout | Read-only owner investigation first. Preserve sampling and generation consistency; measurements must precede behavioral choice. |

The old GN plan remains blocked on substantive client qualification and delivery; closed repair tasks are not reopened. Current qualification findings supply new scope. No publication, live provider use, non-Linux work or installation change is included.

Main session owns acceptance and validation; four bounded helpers supply disjoint implementation/review packets. New allowance under this user instruction: at most2 builds,3 focused suite runs,2 instrumented workspace runs,1 shell regression run; no whole-suite rerun. Helpers run no tests or builds. Source inspections and scope audits are read-only. Do not infer speedup without measurement.

Diagnostic branches: reproduced means preserve the failing invocation and lock
ownership, then select a separate contention correction; not-reproduced means
preserve the passing invocation while leaving the historical failure unresolved.
Neither branch grants another run or closes the product defect automatically.

## Closeout

FIX-1 repaired the qualification findings and installer cleanup. DIAG-1 captured
the unresolved workspace qualification failure on final source. Both tasks are
DONE; manager closed, active task null. The failure is not sufficient evidence
of a product lock defect: later source review establishes a test precondition
error, as detailed below.

Installer regression invocation1 failed before collecting tests because the new
fixture path climbed one directory too far. Corrected to repository scripts;
include its retry in focused suite1. Shell allowance1/1 consumed; no product
failure inferred. Main-session native runner is used because justfile is empty.

Build1 passed in native session24734; log `/tmp/ontoindex-247-followup-build1.log`.
Source review corrected TypeScript-only ambient syntax in JavaScript fixtures and
made Next.js declaration handlers honor loop-var writes. Four helper packets and
independent cross-reviews completed; helpers executed no builds or tests.
Focused suite1 passed226 tests across9 files, exit0. Consumed builds1/2,
focused suites1/3, workspace0/2, shell1/1. No whole-suite or performance claim.

DIAG-1 adds bounded marker projection and a projection regression in the existing
workspace integration file. Instrumented workspace invocation1 started in
session92183; log `/tmp/ontoindex-247-followup-workspace1.log`, evidence
`/tmp/ontoindex-247-followup-workspace1.json`. Bounded OntoIndex file-scope
verification passed; changed-symbol impact was capped at25. FIX-1 scoped ESLint
passed with0 errors/169 warnings (session59361 terminal006258).

Workspace invocation1 reproduced missedEvent workspace_busy:2 tests pass/1 fails,
exit1 (session92183 terminalf62b31). Pre-cleanup evidence shows analyze-lock
owner2485729 matches watch lease2485729; workspace-build marker absent and
cleanup exit0. This supports watcher/foreground contention on this invocation.
Source challenge found reused analyze-lock reader unbounded; all four markers
now use the same bounded4097-byte read and projected fields. Focused suite2
validates the corrected projection, including invalid PIDs and128-character limits.
No diagnostic retries weaken original assertions. Historical full-run remains failed.
Final bounded projection regression passed1 test (2 unrelated cases filtered),
exit0 session11578 terminald8df95. DIAG lint exit0 (1 warning). Workspace run2
checks final corrected capture code using distinct `/tmp/ontoindex-247-followup-workspace2.*`
evidence. This consumes workspace2/2; builds1/2, focused suites2/3, shell1/1.

Workspace run2:2 passed/1 failed, exit1 (session82467 terminalcd3ce2),44.67s.
Final evidence again records missedEvent workspace_busy with matching
analyze/watch PID2497565, absent recovery/build markers and cleanup exit0.
All jobs harvested. No version bump, install, push, full-suite or speedup claim.
Open follow-ups: contention contract/coordination, pinned buffer-query diagnosis,
50,000-row cap regression and broader GN qualification. Stop unchanged reruns.

### Selected next correction

Source review of `local-backend-repo-runtime.ts:633` and its held-lock unit
tests confirms immediate `workspace_busy` with cooldown is the current contract.
The persistent MCP watch callback also calls `prepareWorkspaceRead`; starting a
watcher-free CLI does not stop that peer. The test's `check()` orders the CLI
first without establishing watcher independence. Both retained failure captures
identify the watch owner as the analyze-lock owner.

| Alternative | Correctness and robustness challenge | Performance and compatibility | Decision |
| --- | --- | --- | --- |
| Coordinate the test lifecycle | Gracefully close MCP and prove process exit and lock release before preserved-timestamp mutation; retain prior persistent MCP cases, new symbol/generation and storage integrity assertions | No production latency or public contract change; no request retries or sleeps | Selected next correction in the existing integration test |
| Wait in the native lock owner | Existing attempts/delay facilities lack deadline and cancellation propagation; increasing attempts alone permits work after caller timeout | Changes request latency and exhaustion classification; needs deterministic contention, timeout, cancellation and adoption tests | Defer unless seamless reads during concurrent writes become a requirement |
| Retry the product request | Repeated preparation interacts with the existing busy cooldown and can mask incorrect test preconditions | Extra planning and duplicate retry ownership; broadens failure surface | Reject |

Second challenge preserves the earlier persistent-MCP mutation scenarios and
requires successful single foreground preparation after shutdown, verified new
generation and symbol, and clean ownership markers. Merely accepting busy,
relaxing assertions or retrying until green is rejected. Rollback is confined to
the test lifecycle correction; diagnostic capture must remain intact.

For buffer exhaustion, raising memory is unproven and host-dependent;
serialization reduces concurrent pressure but cannot explain away serial
exhaustion; reducing membership-join fanout may address intermediate allocation
but can change sampling and counts. Select pinned-database measurement first,
then choose between serialization and a semantics-preserving query change.
The current coupling owner runs community and edge queries concurrently and
applies its50,000-row limit after membership joins. A cap-boundary regression
must exercise the pool adapter used by this owner, not only the internal adapter.
No memory or speedup claim is supported yet.

No further code edits were made after final validation. Execution totals remain
builds1/2, focused suites2/3, workspace runs2/2, shell regression1/1. One tracker
validation correction added explicit reproduced/not-reproduced branches before
DIAG-1 acceptance. One diagnostic source correction replaced an unbounded reader
before final validation. No allowance overrun. The selected test correction is
pending an explicit allowance amendment for one additional workspace run;
buffer measurements require their own bounded measurement authorization.
