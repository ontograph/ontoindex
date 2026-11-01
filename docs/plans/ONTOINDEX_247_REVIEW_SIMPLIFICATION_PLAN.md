# 2.4.7 review and simplification

Date: 2026-11-01
Status: Closed
Authority: User requests a second challenge, robust proposals, simplification and execution.

## Goal

Correct watcher-independent replay preconditions and close deterministic coverage
gaps without speculative production retry or memory machinery.

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
  WS-1:
    title: Preserved timestamp mutation is prepared once after verified MCP shutdown
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: test
    validation_tier: integration
    impact_risk: low
    owner_files:
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    allowed_write_set:
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    non_goals:
    - Production lock retries or waiting semantics
    - MCP restart to claim parity for the watcher-independent case
    - Public release or installation
    required_validation:
    - One native workspace integration invocation with distinct evidence file
    - Scoped lint and OntoIndex verify_diff
    expected_evidence:
    - Existing persistent MCP mutation parity remains covered
    - Shutdown and analyze/recovery/watch/build marker absence precede mutation
    - Single foreground read finds missedEvent in a new generation without changing source or committed storage
    rollback:
    - Revert only lifecycle correction and retain diagnostic capture
    stop_conditions:
    - Additional workspace run required after the one authorized amendment
    - Production behavior change required
    known_blockers: []
    closeout:
      main_session_evidence:
        authorized_by: user
        authorization_ref: 2026-11-01 review simplify and proceed after requested one-run amendment
        validation_summary: Workspace invocation3 passed3 tests exit0 session1752 terminalba2763; /tmp/ontoindex-247-review-workspace3.log and .json show MCP cleanup142.75ms exit0 before missedEvent foreground exit0 and old-symbol lookup exit0. Independent source review accepted lifecycle; scoped ESLint exit0 terminalc33f33 and OntoIndex four-file verify_diff PASS with25-symbol cap. Production lock contract unchanged.
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
    dod_status: pass
  CAP-1:
    title: Coupling scan stays below adapter rejection boundary and warns about incomplete metrics
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    depends_on:
    - WS-1
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/mcp/local/backend-coupling-matrix.ts
    - ontoindex/test/integration/backend-coupling-boundary.test.ts
    - ontoindex/test/unit/pool-lifecycle-regressions.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/backend-coupling-matrix.ts
    - ontoindex/test/integration/backend-coupling-boundary.test.ts
    - ontoindex/test/unit/pool-lifecycle-regressions.test.ts
    non_goals:
    - Shared adapter safety threshold changes
    - Buffer sizing or query redesign
    required_validation:
    - Focused coupling boundary and existing pool suite
    - Scoped lint and OntoIndex verify_diff
    expected_evidence:
    - Default and oversized override queries remain below50000 rows
    - At cap successful results explicitly warn metrics may be incomplete
    - Below cap has no warning and adapter errors remain invocation failures
    rollback:
    - Revert coupling cap and its regression tests
    stop_conditions:
    - Shared adapter behavior must change
    known_blockers: []
    closeout:
      main_session_evidence:
        authorized_by: user
        authorization_ref: 2026-11-01 review simplify fix issues and proceed
        validation_summary: Focused coupling and real pool-adapter suites passed47 tests exit0 session61798 terminal8c35d6; /tmp/ontoindex-247-review-cap.log. Actual parameterized adapter accepts49999 and refuses50000/50001 with result closure and connection reuse. Owner tests cover default invalid oversized and small overrides, warning at cap, peer deduplication, bounded details and error propagation. Scoped lint exit0 and bounded OntoIndex verify_diff PASS. No memory/performance claim.
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
    dod_status: pass
```

## Required Traceability

| Requirement ID | User requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| R1 | Challenge and simplify before executing | implementation | WS-1 | Independent source review and native replay |
| R2 | Use OntoIndex | proof-only | WS-1 | Impact LOW; dirty-source verification; bounded scope audit |
| R3 | Preserve completed fixes | compatibility-test | WS-1 | Review existing diff and retained226-test evidence |
| R4 | Fix next deterministic issue | implementation | CAP-1 | Default override exact-cap and adapter-error regressions |

## Decisions And Non-Goals

| Issue | Alternatives | Second challenge and selection |
| --- | --- | --- |
| Watcher-independent replay races MCP | Coordinate test shutdown; add native lock waiting; retry requests | Reuse one shutdown helper before mutation and in finally. Waiting needs cancellation/deadline propagation; retries mask the invalid precondition and repeat work. Preserve persistent cases and all integrity checks. |
| Buffer exhaustion | Raise memory; serialize queries; reduce join fanout | Memory has no measured basis; serialization cannot resolve known serial exhaustion; fanout changes need sampling/count equivalence. Keep product unchanged pending pinned database evidence. |
| Cap boundary coverage | Exercise real pool adapter with mocked native rows; mock coupling owner only; run a large live database | Prefer existing pool harness for deterministic49,999/50,000/50,001 behavior. Owner-only mocks miss the guard; a live workload adds cost without improving this boundary proof. Final scope follows independent review. |
| Coupling cap mismatch | Clamp owner below guard; relax shared guard; aggregate or paginate | Select local49,999 default and maximum, matching existing internal-adapter precedent. Relaxing the guard broadens every consumer and leaves large overrides broken. Aggregation/pagination needs semantic and engine measurements. Guard-aware owner tests prove query sizing; existing pool tests retain adapter validation. |

Four read-only Luna/Sol reviewers cover bindings/exports, ABI/installer,
workspace lifecycle and coupling boundaries. No helper builds or tests.
The user's proceed instruction accepts the preceding request for one additional
workspace run: original allowance2/2 remains recorded, amendment+1, total cap3.
Prior totals remain builds1/2, focused suites2/3, shell1/1. No full suite or
performance claim. Source review, lint and scope checks remain bounded.

## Closeout

The initial repairs reused existing owners and preserve the lexical prepass/cache,
explicit ambient wrapper and existing ABI reason codes. Independent review found
no confirmed export/route regression; a proposed lexical-hoisting defect was
withdrawn after checking variable_declaration versus lexical_declaration.

The weakest earlier decision was rerunning the timestamp scenario before checking
its persistent watcher precondition. WS-1 fixes that precondition with one shared
shutdown helper; five earlier persistent MCP/CLI parity cases remain. The final
case deliberately proves foreground independence and old-symbol absence. Optional
cgroup cleanup is retained but this invocation proves root-process cleanup only.

CAP-1 fixes an overlooked exclusive-limit mismatch. Local clamping is preferable
to exporting a new shared configuration abstraction or relaxing the adapter guard.
The test uses the actual parameterized pool path at49999/50000/50001; adapter
closure and reuse are checked. At-cap warnings disclose potentially incomplete
metrics; arbitrary bounded prefixes cannot support exact whole-graph rankings.

The alternatives were challenged for correctness, root cause, compatibility,
security, complexity, performance, testability and rollback. Neither selected
change introduces a dependency, public schema, retry owner or increased memory
limit. Each rolls back in its existing owner. Claimed speedup requires measurement.

Validation: workspace3 passed3 tests; cap suite passed47 tests; scoped ESLint
exit0; git diff check exit0; bounded OntoIndex verify_diff PASS for four files,
with changed-symbol impact capped25. The committed index is current but dirty
source is authoritative. Original226-test and build evidence remains valid for
unchanged earlier repair owners. No full-suite rerun or new native build needed
for the test lifecycle and bounded constant/warning changes.

Budget: builds1/2 unchanged; focused suites3/3; workspace3/3 including the explicit
one-run amendment accepted by the user's proceed. Reviewer review_small_fixes
additionally ran an old/new Bash EXIT-trap comparison despite the no-tests packet.
Count it as a shell regression invocation, not ordinary source inspection:
shell2/1, overrun1. The child reports old=1/new=0 and outer exit0 but did not supply
the requested exact command or terminal receipt; it is not acceptance evidence.
Other reviewers performed source-only work. No further shell regression is allowed.
One plan-parser correction replaced unsupported complexity medium with complex
before execution. Manager acceptance rests on retained parent validation only.

Remaining: pinned-database measurements for buffer exhaustion, then choose a
semantics-preserving fanout reduction only if evidence supports it. Broader GN
qualification remains separate. No commit, push, install or release in this scope.
