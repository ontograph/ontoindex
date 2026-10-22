# Navigation recovery execution plan

Date: 2026-10-21
Status: Closed
Authority: User review and execution instruction; ADR_CLI_COMMITTED_NAVIGATION.md.

## Goal

Complete CLI committed recovery and retain installed-process regressions against
Ontocode. Keep default workspace navigation explicitly unresolved.

## Review and comparison

Working well: provenance, generation pinning, search bounds, continuation mode,
and optional symbol expectations. Weakest result: several release candidates
still leave default navigation unavailable. Forgotten: CLI fallback parity,
maintained installed-process checks and distinct availability reporting.

Compared twice for correctness, root cause, robustness, compatibility,
complexity, performance, security, testability, rollback and validation:
full incremental relationships need dependency closure and edge invalidation;
partial neighborhoods need consumer-wide coverage semantics; committed parity
reuses tested immutable graph ownership at low runtime cost. Select parity and
retained smoke first. No cap increase, silent fallback or input omission.

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
  NAV-1:
    title: Explicit CLI committed reads and installed smoke retain provenance and separate workspace availability
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/cli/tool.ts
    - ontoindex/src/cli/index.ts
    - ontoindex/scripts/committed-navigation-smoke.mjs
    - ontoindex/test/unit/tool-direct-cli.test.ts
    - ontoindex/test/unit/cli-index-help.test.ts
    - ontoindex/test/unit/committed-navigation-smoke.test.ts
    allowed_write_set:
    - ontoindex/src/cli/tool.ts
    - ontoindex/src/cli/index.ts
    - ontoindex/scripts/committed-navigation-smoke.mjs
    - ontoindex/test/unit/tool-direct-cli.test.ts
    - ontoindex/test/unit/cli-index-help.test.ts
    - ontoindex/test/unit/committed-navigation-smoke.test.ts
    non_goals:
    - Change workspace completeness or limits
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/tool-direct-cli.test.ts test/unit/cli-index-help.test.ts test/unit/committed-navigation-smoke.test.ts test/integration/committed-navigation-sdk.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - cd ontoindex && npm run build
    validation_workspace:
      root: .
      inputs:
      - ontoindex/src/cli/tool.ts
      - ontoindex/src/cli/index.ts
      - ontoindex/scripts/committed-navigation-smoke.mjs
      generated_outputs:
      - ontoindex/dist
    expected_evidence:
    - Default forwarding compatibility and explicit committed UID forwarding
    - Real Ontocode smoke distinguishes contracts from workspace availability
    rollback:
    - Revert only this task CLI and smoke hunks
    stop_conditions:
    - Unknown committed identity
    - Unbounded acquisition
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-auditor: null
      main_session_evidence:
        validation_summary: 63 focused tests passed; TypeScript, build and built CLI checks exited 0; installed smoke passed 22 assertions with workspace availability false.
        authorization_ref: current-user-request-consolidate-and-proceed
        authorized_by: User explicitly requested consolidation and execution with two sol medium development agents.
    dod_status: pass
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REQ-1 | CLI fallback | implementation | NAV-1 | Unit/help and built CLI checks |
| REQ-2 | Durable process regression | implementation | NAV-1 | Fake-client tests and real smoke |
| REQ-3 | Two sol medium development agents | implementation | NAV-1 | develop_cli and develop_smoke receipts |

## Decisions And Non-Goals

No provider execution, retries, reindex loops, global cap changes or silent input
exclusions. Relationship graph work needs clean-symbol/import resolution,
affected dependency closure including new incoming calls, source-owned edge
replacement, rename/deletion handling and derived graph invalidation. Compare
with full analysis before activation. Existing symbols overlays cannot establish
complete current-workspace relationships.

## Closeout

CLI recovery and retained smoke implemented locally. Final focused suite: 63
passed across four files (exit 0); TypeScript exit 0; corrected build exit 0;
git diff --check exit 0. Built query/context/impact succeeded against Ontocode,
reporting committed identity and workingTreeIncluded=false. CLI evidence:
/tmp/ontoindex-navigation-cli-corrected.json.

Installed rc.7 MCP smoke: 16 calls, 22 checks passed, contractPassed=true and
workspaceNavigationAvailable=false. Evidence directory:
/tmp/ontoindex-navigation-review-smoke-20261021/. The supplied-symbol diff cases
check the expectation contract, not automatic symbol-diff precision.

Used: one refresh, two builds, two focused suites, two TypeScript checks, one
installed smoke and one corrected CLI invocation after the first failed. The
first built CLI exposed forwarding without committed scope; correction reused
withPreparedRepoRead with explicit repository and enrichment guards. No unchanged
failing product query was retried. Both development agents used gpt-6.1-sol
medium with disjoint writes. Four independent review agents preceded development.

Default large dirty-workspace navigation remains unresolved. CLI recovery was
validated before the separately authorized rc.8 release step.
knowledge_handoff: none; existing end-to-end validation and no-loop rules cover
the observed missing-scope failure. No skills changed.
