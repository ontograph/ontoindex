# Automatic Workspace Review and Repair Plan

Date: 2026-10-20
Status: Closed — all four repair tasks accepted
Authority: User request to challenge planned/completed work, select robust performance fixes, consolidate and proceed; two Sol medium development agents.

## Goal

Repair demonstrated preparation lifecycle and repeated-work defects, correct current guidance, and validate the combined change without repeating unchanged historical qualification.

## Review and solution comparison

What went well: immutable candidate/build identities, serialized native validation, real CLI/MCP mutations, explicit unsupported capabilities and scoped task acceptance. What went poorly: oversized tracking history and stale root release notes obscured which gates were current. Forgotten: pre-admission expiry regression, concurrent usable-snapshot validation regression, a moved-plan link and self-contained packaged feature guidance.

| Issue | Three materially distinct choices | First and second review; selected result |
| --- | --- | --- |
| Late build admission | Recheck existing deadline/signal; introduce settlement token; cancel shared builds | Existing checks have zero persistent state and negligible cost. Token duplicates lifecycle state. Shared cancellation breaks surviving waiters. Second pass requires checks after snapshot and file-count awaits and before admission, outside shared closure. Select existing-state checks; preserve admitted builds. |
| Duplicate usable validation | Reuse settled TTL answer; replace cache with pending validation; serialize independent probes | TTL is fastest but masks same-metadata byte edits and config/new paths. Serialization retains repeated work and queue latency. Second pass requires pending-only sharing, next settled revalidation, mode/base keys and reset/failure guards. Select pending cache entry in existing owner, no new cache. |
| Stale docs and package gap | Repair current pointers and embed essentials; rewrite old release evidence; reopen all prior plans | Scoped repair preserves provenance and requires no runtime overhead. Rewriting historical evidence loses attribution; reopening all tasks confuses deferred release gates with plan failures. Second pass retains native-error investigation and installed-tarball gate, without claiming package acceptance. Select current pointers and shipped guidance. |
| Native allocation history | Raise buffer limits; change pool-cap model; retain exact separate diagnosis | No current reproducer establishes a causal pool defect. Limits trade RSS for unproved benefit; changing pool semantics risks compatibility. Current RT-5 is DONE. Second pass rejects inferred repair from successful new replay. Retain investigation with old evidence; no speculative pool edit. |

All choices were compared for correctness, cause coverage, robustness, compatibility, complexity, performance, security, testability, rollback and validation. Selected code changes preserve APIs, mutation checks, per-request freshness and shared-build lifetime; regression tests discriminate original defects. No new dependency or runtime owner.

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
  REV-1:
    title: Expired or cancelled preparation cannot admit a new workspace build
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    non_goals:
    - No unrelated dirty work changes, public API, dependency, pool rewrite, provider call, publication, Git mutation or full benchmark matrix.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/local-backend-repo-runtime.test.ts
    - git diff --check
    expected_evidence:
    - Deferred snapshot and file-count probes settle after timeout or cancellation without acquiring a lock or starting a build; previously admitted shared builds still survive an individual waiter.
    rollback:
    - Revert only the new packet delta against recorded pre-edit source; preserve existing uncommitted implementation.
    stop_conditions:
    - Stop for an unresolved ownership decision or write-set expansion.
    - Stop on repeated identical failure or after the one budgeted correction; preserve running job identity.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested robust consolidated fixes and execution with two Sol medium development agents.
        validation_summary: develop_expiry Sol medium implemented original runtime/test pair; sibling Sol medium source challenge PASS. Managed correction job adw-review-repairs-20261020-r1 terminal exit0 in13206ms;390tests6files pass11.72s,TypeScript0,all5input hashes OK,diff0. Four deferred probe timeout/cancel cases pass with strict zero lock/build assertions; existing admitted shared-build lifetime cases pass. Fixture once-queue correction retained; production signature and shared closure unchanged.
    dod_status: pass
  REV-2:
    title: Concurrent warm snapshot callers share one fresh pending validation
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - REV-1
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/mcp/local/backend-overlay.ts
    - ontoindex/test/unit/backend-overlay.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/backend-overlay.ts
    - ontoindex/test/unit/backend-overlay.test.ts
    non_goals:
    - No unrelated dirty work changes, public API, dependency, pool rewrite, provider call, publication, Git mutation or full benchmark matrix.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/backend-overlay.test.ts
    - git diff --check
    expected_evidence:
    - Ten concurrent calls after a settled usable snapshot share one plan/validation promise; later calls revalidate bytes and config; failure, reset, eviction and TTL semantics remain safe.
    rollback:
    - Revert only the new packet delta against recorded pre-edit source; preserve existing uncommitted implementation.
    stop_conditions:
    - Stop for an unresolved ownership decision or write-set expansion.
    - Stop on repeated identical failure or after the one budgeted correction; preserve running job identity.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested robust consolidated fixes and execution with two Sol medium development agents.
        validation_summary: develop_singleflight Sol medium replaced uncached usable refresh branch with existing pending cache replacement; sibling Sol medium source challenge PASS. Managed adw-review-repairs-20261020-r1 exit0;390tests6files andTypeScript pass,input hashes unchanged. Two ten-caller regressions prove single pending planner/config verification then byte/new-dirty revalidation; existing flag/base/reset/failure/TTL checks pass. Scope gn_verify_diff PASS for5explicit source/test files; no wall-clock speedup claimed.
    dod_status: pass
  REV-3:
    title: Packaged guidance and current review accurately distinguish completion from release gates
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - REV-2
    type: documentation
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/test/unit/overlay-symbol-resolution.test.ts
    - ontoindex/README.md
    - RELEASE_READINESS.md
    - RT_OVERLAY_REVIEW.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    - .memory-bank/ADW_REVIEW_REPAIRS_PROJECT_PLAN.md
    allowed_write_set:
    - ontoindex/test/unit/overlay-symbol-resolution.test.ts
    - ontoindex/README.md
    - RELEASE_READINESS.md
    - RT_OVERLAY_REVIEW.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    - .memory-bank/ADW_REVIEW_REPAIRS_PROJECT_PLAN.md
    non_goals:
    - No unrelated dirty work changes, public API, dependency, pool rewrite, provider call, publication, Git mutation or full benchmark matrix.
    required_validation:
    - git diff --check
    expected_evidence:
    - Archived plan link resolves; README contains essential support and recovery guidance independent of memory-bank; dated release measurements and native errors retain attribution; current plan completion and deferred installed-package qualification are explicit.
    rollback:
    - Revert only the new packet delta against recorded pre-edit source; preserve existing uncommitted implementation.
    stop_conditions:
    - Stop for an unresolved ownership decision or write-set expansion.
    - Stop on repeated identical failure or after the one budgeted correction; preserve running job identity.
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested review and correction of forgotten issues.
        validation_summary: README essentials use in-file link and describe capture,pagination,errors,rollback and resource gates; audit archived link fixed; dated release/overlay evidence preserved below current disposition with RT5/RT28 done and native-error/package gates explicit. Changed-guidance local-link check PASS0missing;diff0. Symbol-resolution mock now reuses real activation helper;all19resolver tests included390pass. No speculative memory increase or false historical root-cause claim.
    dod_status: pass
  REV-4:
    title: Validate combined repairs and close the consolidated review with exact evidence
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - REV-3
    type: closeout
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - .memory-bank/ADW_REVIEW_REPAIRS_PROJECT_PLAN.md
    - .memory-bank/MEMORY.md
    - .memory-bank/project_plan-current.md
    - .memory-bank/project_pending-tasks.md
    - .memory-bank/audit_session-2026-10-20-adw-review-repairs.md
    allowed_write_set:
    - .memory-bank/ADW_REVIEW_REPAIRS_PROJECT_PLAN.md
    - .memory-bank/MEMORY.md
    - .memory-bank/project_plan-current.md
    - .memory-bank/project_pending-tasks.md
    - .memory-bank/audit_session-2026-10-20-adw-review-repairs.md
    non_goals:
    - No unrelated dirty work changes, public API, dependency, pool rewrite, provider call, publication, Git mutation or full benchmark matrix.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/backend-overlay.test.ts test/unit/local-backend-repo-runtime.test.ts test/unit/calltool-dispatch.test.ts test/unit/mutation-dirty-guard.test.ts test/unit/overlay-query-merge.test.ts test/unit/overlay-symbol-resolution.test.ts
    - cd ontoindex && node node_modules/typescript/bin/tsc --noEmit -p .
    - git diff --check
    expected_evidence:
    - One assigned managed validation job passes affected units and TypeScript; bounded graph verification and diff checks pass; source hashes and changed scope retained; no unsupported whole-candidate recertification.
    rollback:
    - Revert only the new packet delta against recorded pre-edit source; preserve existing uncommitted implementation.
    stop_conditions:
    - Stop for an unresolved ownership decision or write-set expansion.
    - Stop on repeated identical failure or after the one budgeted correction; preserve running job identity.
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested consolidated plan and autonomous execution.
        validation_summary: Final review audit records exact commands,exits,source identities,alternatives and deferred scope. Managed adw-review-repairs-20261020-r1 terminal0 in13206ms;390tests6files11.72s,tsc0,5hashesOK,diff0. Explicit5file graph verification PASS;guidance links0missing;plan parserPASS. Two Sol medium developers and sibling source challenges reviewed with hashes. Two focused invocations,1tsc,1of1correction,0build/full/matrix. Old frozen evidence preserved;no new installed-binary claim. knowledge_handoff none per existing rules.
    dod_status: pass
```

## Required Traceability

| Requirement ID | User requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REQ-1 | Review and challenge completed work | proof-only | REV-1, REV-2, REV-3 | Four bounded read-only review packets and source citations |
| REQ-2 | Select robust and efficient fixes and proceed | implementation | REV-1, REV-2 | Adversarial deferred-probe and concurrent warm-validation regressions |
| REQ-3 | Consolidate one actionable plan | implementation | REV-3, REV-4 | Parser and final handoff |
| REQ-4 | At least two Sol medium agents during development | implementation | REV-1, REV-2 | Explicit dispatch settings and child file hashes |
| REQ-5 | Use OntoIndex for navigation | proof-only | REV-1, REV-2, REV-4 | Freshness, exploration, per-symbol impact/safety and explicit scoped verify |

## Execution and budgets

First job `adw-review-repairs-20261020` ended exit 1: 371/390 tests passed;
nineteen failed in two files. Seventeen failures are the missing activation
export in the symbol-resolution mock. Two new deferred-snapshot tests postponed
the under-lock recheck because the fixture had two queued initial responses;
resetting that queue selects the intended first probe. Runtime guards are
unchanged. TypeScript did not run. The new snapshot-sharing cases passed.

Correction round 1/1 is consumed. The runtime developer corrects only its test
setup without weakening assertions; main exposes the real activation helper in
the symbol-resolution partial mock. Three alternatives compared twice: reuse
the real helper (selected), duplicate its predicate (reject drift), force a
constant (reject lost flag-on coverage). The initial failure log remains intact.
One correction job `adw-review-repairs-20261020-r1` is assigned after these
changes. It runs the same six files, TypeScript and input hashes. No additional
test runs are authorized afterward. No build or benchmark is added.

Four Sol medium reviewers inspected disjoint evidence families. Two Sol medium developers own exactly one production/test pair each; no child runs validation. Main-session local acceptance uses user-authorized evidence and preserves null role scaffolds; no missing historical receipt is fabricated. Code development may overlap because write sets are disjoint; canonical task acceptance is serial.

One managed job is assigned: `adw-review-repairs-20261020`. Allocate one focused unit invocation (backend-overlay, runtime, dispatch, mutation guard, overlay-query merge and symbol resolution), one TypeScript invocation, zero builds/full suites/matrices. One corrective focused invocation is reserved only after a concrete diagnosed failure; max one corrective implementation round. No tests overlap. Existing frozen evidence remains immutable and applies to its historical inputs; new code changes are certified only by new focused evidence. Runtime launches and benchmarks are not needed for these internal changes.

OntoIndex indexed HEAD matches acbcb638; dirty changes require source verification. getOverlaySnapshot impact MEDIUM six callers; prepareWorkspaceRead LOW one caller. Both exported functions receive DANGEROUS safety flags; signatures remain unchanged. Direct source confirms callers. No reindex for dirty work alone.

## Closeout

The review repaired two source defects, six new regression cases, the legacy
resolver mock and four guidance files. Managed correction exit0;390tests6files,
TypeScript and final hashes pass. No source changes follow validation. Exact
evidence and remaining native-error/release gates are in
[review audit](../audit_session-2026-10-20-adw-review-repairs.md).
