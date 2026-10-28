# Asynchronous phase output lifetime

Date: 2026-10-22
Status: Closed
Authority: User proceed; ADR_AUTOMATIC_DIRTY_WORKSPACE.md SCOPE lifetime prerequisite.

## Goal

Await phase output cleanup and preserve primary failures before durable retention.

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
  ASYNC-1:
    title: Pipeline awaits asynchronous disposal and settles cleanup before rejection
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/pipeline-phases/runner.ts
    - ontoindex/src/core/ingestion/pipeline-phases/types.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse.ts
    - ontoindex/test/unit/pipeline-runner.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/pipeline-phases/runner.ts
    - ontoindex/src/core/ingestion/pipeline-phases/types.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse.ts
    - ontoindex/test/unit/pipeline-runner.test.ts
    non_goals:
    - No retained artifact codec or inventory completeness or runtime activation
    - No disposal of successful terminal outputs transferred to callers
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/pipeline-runner.test.ts test/unit/parse-phase-lifecycle.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Last-consumer disposal settles before the next phase or return
    - Cleanup continues after sync throws and async rejections and runs once per output
    - Phase failure cause including undefined survives cleanup failure
    - Cleanup-only rejection surfaces after remaining completed outputs are cleaned
    - Successful terminal outputs remain readable and undisposed
    rollback:
    - Revert only ASYNC-1 hunks in the four owned files
    stop_conditions:
    - Retention storage or publication changes required
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed with reviewed lifetime prerequisite
        validation_summary: Parent reviewed source and tests from two gpt-6.1-sol medium agents after four read-only discovery packets. Focused Vitest session 50614 exited 0 with 31 tests across two files. TypeScript session 59960 exited 0. git diff --check exited 0. Verified SHA256 runner ed4da4e2b0c4a03773b19dd4cd60180820bde0dd475c9927533a17d0e6b730e5; types 0c0d4921e8945b84d49a4d3592db75da5d63c932c4e7ccae8826e3c96605f220; parse cbaae4c271d28b81a304a63f2f8e8eede26b1519af5c5fb9da2e8345bdc12427; tests fdb73939a95e3847ea2531c91c5402c2e1cda33174bcb9218383308d5bb68463. One initial typecheck launch returned no receipt; no active tsc process was found before second invocation. Budget used one of two suites and two of two typecheck slots with the unknown launch reserved. OntoIndex transport closed; source review is authority. No build or installed runtime validation claimed.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| SCOPE-ASYNC | Await owned resources before completion and preserve failures | implementation | ASYNC-1 | Deferred disposal and mixed failure tests |
| SCOPE-RETENTION | Complete bounded capture and identity | non-goal | ASYNC-1 | Remains successor work |

## Decisions and second challenge

In-memory capture adds heap pressure without durable ownership. Async callback
sinks leave existing runner disposal unawaited. Extend the existing runner's
disposal boundary with void-or-Promise support before durable capture. Preserve
synchronous disposers, deterministic phase order and successful terminal-output
ownership. Cleanup-only errors now reject instead of being silently swallowed;
phase errors retain their wrapper and original cause. Mark outputs before disposal
to prevent duplicate attempts. Cleanup must continue after arbitrary thrown values.
Sequential cleanup avoids added concurrency and preserves existing disposal order.
Rollback is confined to the four owned files; no dependencies or public options.

Four read-only reviewers examined capture, inventory, codec and lifecycle risks.
The codec review was incomplete and is not accepted as implementation authority.
Inventory reconciliation needs scan exclusions and configuration identity;
scope outcomes alone remain insufficient. This task closes only asynchronous
runner cleanup, not immutable handle transfer or complete retention.

## Execution evidence

OntoIndex stale/degraded: Transport closed; source inspection is authority.
Parent validation budget: two focused suite invocations and two typechecks.
Two Sol medium development agents owned production and test files separately.
No builds, installs, reindexing or publication in this task.

## Closeout

Validated asynchronous disposal, complete failure cleanup, original error identity
and successful terminal-output ownership. Durable capture, immutable handle
transfer, inventory/configuration identity and navigation activation remain open.
Knowledge handoff: none; existing unknown-launch accounting rules apply.

