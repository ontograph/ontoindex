# Parse stage lifetime

Date: 2026-10-22
Status: Closed
Authority: User proceed; ADR_AUTOMATIC_DIRTY_WORKSPACE.md asynchronous lifetime prerequisite.

## Goal

Settle existing stage I/O before cleanup and preserve primary parse errors.

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
  LIFE-1:
    title: Stage cleanup waits for all I/O and preserves primary failures
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
    - ontoindex/test/unit/parse-impl-fallback.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
    - ontoindex/test/unit/parse-impl-fallback.test.ts
    non_goals:
    - No retention codec or identity completeness or navigation activation
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/parse-impl-fallback.test.ts test/unit/parse-phase-lifecycle.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Delayed sibling I/O settles before disposal begins
    - All cleanup settles even when one removal fails
    - Primary failure including undefined survives cleanup errors
    - Worker termination and sequential cache cleanup still run
    rollback:
    - Revert LIFE-1 hunks only
    stop_conditions:
    - Storage protocol or public API expansion required
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on reviewed retention prerequisite
        validation_summary: Two Sol medium agents implemented source and tests separately. Independent review accepted ORM-loader cleanup protection and safe unknown-error logging. Parent reviewed final source and tests. Vitest session 14141 exited 0 with 16 tests across two files in 4.62 seconds. TypeScript session 73942 exited 0. git diff --check exited 0. Source hash 3f8dd84a8a2cf4dd62aee64ab3d6881a8c29a5f9ed92c8ceef5370ee9ac0313f and test hash 269942dc63bebaa4867c0f2b0416107b72a3e9e7a15c38467714da601105ac4d identify validated files. One initial typecheck launch returned no receipt and no live compiler was observed afterward; its slot remains reserved. Budget used one of two suites and two of two typecheck slots. No retention or navigation completeness claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| SCOPE-LIFETIME | Settle I/O and preserve errors before durable capture | implementation | LIFE-1 | Deferred I/O and cleanup failure fixtures |

## Decisions and second challenge

Serial I/O avoids sibling races but loses existing concurrency. Per-stage pending
operation registries solve broader lifetime ownership at added state complexity.
Select settled existing batches plus one outer stage cleanup boundary: preserves
concurrency and current storage format, adds no dependency or public API, and
rolls back within two files. Independent review confirms append and drain both
need settling; cleanup-only failures must surface and thrown undefined must stay
distinct from absence of error. Worker termination and sequential cache cleanup
must precede outer stage disposal and preserve primary errors. Retention limits,
immutable handles and identity remain separate successor work.

## Execution evidence

OntoIndex stale/degraded: Transport closed; source inspection is authority.
Four read-only packets traced lifetime, tests, identity and alternatives.
Two Sol medium implementation packets own disjoint production and test files.
Parent budget: two focused suites and two typechecks, initially zero used.
No builds, installs, reindex, publication or runtime activation.

## Closeout

LIFE-1 completed through the manager complete-local transition.
Existing stage batches settle before disposal, all disposal attempts settle,
and primary failures survive cleanup failures. Durable retention, immutable
handle transfer, inventory/configuration identity and navigation remain open.
Knowledge handoff: none; existing rules cover unknown launch accounting.
