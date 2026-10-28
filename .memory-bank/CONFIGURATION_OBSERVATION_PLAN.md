# Configuration loader observations

Date: 2026-10-22
Status: Closed
Authority: User proceed; ADR_AUTOMATIC_DIRTY_WORKSPACE.md SCOPE refinement.

## Goal

Attach bounded actual-read evidence to the effective configuration reused by import resolution.

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
  OBS-1:
    title: Loader observations retain actual bytes identity and ordered discovery with explicit incompleteness
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/language-config.ts
    - ontoindex/src/core/ingestion/import-resolvers/types.ts
    - ontoindex/test/unit/language-config.test.ts
    - ontoindex/test/unit/parse-impl-fallback.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/language-config.ts
    - ontoindex/src/core/ingestion/import-resolvers/types.ts
    - ontoindex/test/unit/language-config.test.ts
    - ontoindex/test/unit/parse-impl-fallback.test.ts
    non_goals:
    - No durable seed publication or complete replay identity
    - No change to resolver precedence or existing filesystem read budgets
    - No navigation activation or build install release
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/language-config.test.ts test/unit/import-processor.test.ts test/unit/parse-impl-fallback.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Present absent failed and malformed reads remain distinct with raw-byte hashes
    - Directory ordering and traversal omissions survive bounded immutable capture
    - Both parse paths reuse the same attached observation after disk changes
    rollback:
    - Revert only OBS-1 hunks in owned files
    stop_conditions:
    - Required changes outside declared owner or public resolver semantics
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed with configuration observation prerequisite
        validation_summary: Parent reviewed source and tests from two Sol medium development agents following two read-only reviews. Vitest session 90473 exited 1 with one missing ENOENT field in expected test data; parent corrected assertion and record-byte budget assertion. Final suite session 58682 exited 0 with 44 tests across three files in 6.28 seconds. TypeScript session 65163 exited 0. Final git diff --check exited 0. Budget used two of two suites and one of two typechecks. Source hashes 73849869f67fb3947374f3fae1a49cb3f35f625215cf1dabf35dc8c93804cb1c and 60fad64adca2ee8c4e268ba46e7e0c26983d5a453994de8edec2dbd194507554; test hashes 61b87cadc562543f32400a1a9e3bc389e783bac7309aa0a436f36d5949819d05 and 9d1644bd592b85572dc6576d59f7f6e4a24b5780a9b1fa15502e3dd1c7d67a15. No build install or release. OntoIndex degraded; source authority. Rust formatting inapplicable because this checkout has no ontocode-rs directory. Durable replay identity and navigation activation remain successor work.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| OBS | Capture observations at effective loader reads | implementation | OBS-1 | Loader tests |
| BIND | Reuse attached evidence across parse paths | compatibility-test | OBS-1 | Parse fallback tests |
| SEED | Durable replay and generation identity | non-goal | OBS-1 | Successor packet |

## Decisions And Second Challenge

Post-load hashing is cheap but misses negative reads and races; reject it.
A captured filesystem offers isolation but expands lifecycle ownership and cost;
defer it to complete replay. Instrumenting existing loader reads preserves API
and precedence with one read per input; select this option. Rollback is confined
to additive metadata and loader instrumentation. Tests cover each outcome.

Second review: hash the actual Buffer before UTF-8 decoding; distinguish malformed
content from missing files. Preserve directory order and duplicate overwrite
behavior. Failed I/O, parse errors, omitted traversal and capture overflow refuse
completeness. Bound retained metadata before copying; never retain raw contents or
raw error messages. Freeze detached records. Completeness concerns observations
only, not atomic filesystem state or complete replay. Existing read allocations
remain unchanged; this slice bounds additional retained metadata.

## Execution Evidence

OntoIndex stale/degraded: Transport closed; source inspection is authority.
Two read-only reviewers inspect design and tests; two Sol medium development
agents own source and tests separately. Parent runs validation serially after
editors stop. Budget: two focused suite invocations and two TypeScript checks;
children have zero build/test allowance. No active validation process observed.
Child freshness probes returned indexed 8939695b versus current ae351d4; no
refresh started. Parent requested no further graph calls after inherited
transport failure. Graph-backed claims remain unavailable. A global agent wait
encountered an unrelated pre-existing manager result rejected for an unknown
summary field; OBS-1 uses direct child completion messages and local acceptance.

## Closeout

Implemented bounded immutable loader observations on reused import configuration.
Focused validation passed after one test-expectation correction. Metadata retains
raw-byte hashes, ordered directory discovery, failures and explicit incomplete
capture. The 1 MiB limit covers serialized records; bounded wrapper overhead is
additional. Existing filesystem-read allocations are unchanged. No complete
workspace snapshot, durable seed or navigation recovery is claimed.
Knowledge handoff: none; existing rules already require persisted-patch checks
and terminal validation evidence before acceptance.
