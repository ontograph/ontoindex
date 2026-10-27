# Catch binding implementation

Date: 2026-10-22
Status: Closed
Authority: User proceed; accepted CATCH-DESIGN in LUNA_WORKSPACE_COMPLETION_PLAN.md

## Goal

Implement accepted catch bindings in the existing two-file owner.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: closed
  selection_policy: active_next_task-first
  active_next_task: null
  max_in_flight: 1
  dispatch_mode: sub-agent
  dispatch_preflight:
    required_roles:
      coder-worker:
        agent_type_candidates:
        - coder-worker
        model: gpt-6.1-sol
        reasoning_effort: high
      coder-worker-test-challenger:
        agent_type_candidates:
        - coder-worker-test-challenger
        model: gpt-6.1-sol
        reasoning_effort: xhigh
  last_decision: dispatched
  reopen_gate: null
tasks:
  CATCH-IMPL:
    title: Simple catch identifiers bind inside catch scopes without leaking
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    type: code
    complexity: simple
    depends_on: []
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/languages/typescript-declaration-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-declaration-captures.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/languages/typescript-declaration-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-declaration-captures.test.ts
    non_goals:
    - Destructuring provider activation new schema or changed var collision policy
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-declaration-captures.test.ts test/unit/scope-resolution/scope-extractor.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - TS TSX JS JSX simple catch identifiers remain local to their catch scopes
    - Nested catches preserve distinct canonical identities
    - Optional catch binding emits no declaration
    - Unsupported patterns malformed syntax and unsupported collisions refuse explicitly
    - Existing var catch collision refusal and local definitions remain intact
    rollback:
    - Revert only the new helper and focused tests
    stop_conditions:
    - Unresolved design or changes outside the two named files
    known_blockers: []
    dispatch:
      role: coder-worker-test-challenger
      attempts: 0
      dispatch_id: d92acfeb-92f2-4897-8a7c-a1ddef2850dc
      scope_sha256: 0d6d9ecfd8d0d0647988dd6f95ae34e12f053060b5eccad86d6e9823473aec32
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792658870436'
      assigned_agent: 01a162cb-9059-71f2-86e3-2589f3847a99
      agent_type_requested: cdr-worker-test-challenger
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: f33b73daece36c2c2106065ac375b396e693e49e1d880c7d7b5397386abf8df3
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-worker
        agent_id: 01a162c9-65a0-7452-94af-74bdd167bdbc
        effective_model: gpt-6.1-sol
        receipt_id: role-result-d9a89786f50cefff643e19750bcb08ca20675aa637030132928bf95bf38791c7
        verdict: PASS
      - role: cdr-worker-test-challenger
        agent_id: 01a162cb-9059-71f2-86e3-2589f3847a99
        effective_model: gpt-6.1-sol
        receipt_id: role-result-c613e73b53de5df2f7159d367dc49dfb1ae35e77599702d3206e646748f41027
        verdict: PASS
    dod_status: pass
```

## Catch design decision

Reuse the existing catch-clause Block. Add `emitTypeScriptCatchBindingCaptures`
in the declaration helper and anchor variable/name records at the identifier.
The existing catch body remains a distinct child Block. No shared schema,
binding metadata or provider activation changes are needed.

| Alternative | First review | Second review and decision |
| --- | --- | --- |
| Existing catch scope with identifier anchors | Correct environment identity, compatible extractor, minimum allocation and diff | Select; validate direct-body conflicts before emitting, preserve var refusal, rollback helper/tests |
| Body Block owns the catch parameter | Simple placement but conflates catch and body environments | Reject; loses correct ownership and redeclaration distinction |
| New Catch scope kind and protocol | Supports richer modeling but changes shared types and consumers | Reject; unnecessary compatibility, performance and validation cost for simple identifiers |

Second review challenges same-name outer bindings, nested/sibling catches,
body conflicts, malformed syntax and unsupported patterns. Retain current
parse-error refusal. Check direct body declarations without traversing nested
environments repeatedly; preserve existing var catch-collision behavior.

Frozen parser/extractor fixtures in the two-file implementation write set:

- All four grammars: simple catch owns its binding without outer leakage;
  optional catch emits none; nested/sibling catches have distinct identities.
- Outer lexical/import/parameter bindings and nested-block bindings may shadow.
- Same-name direct body let/const/class/function declarations refuse; unsupported
  direct binding patterns refuse when conflict freedom cannot be proven.
- Destructured, typed, escaped or malformed catch parameters refuse atomically;
  wrong node kinds refuse. Existing var collision tests remain unchanged.
- Unicode identifiers retain native ranges; detached records survive parser
  reuse and independent mutation.

Scope helper changes require a new packet. Correction runs consume the same
two focused-suite and one typecheck slots; no extra invocation is implied.
MODEL is the retained-model prerequisite and SCOPE comprises capture plus
provider acceptance. After CATCH-IMPL, coordinator prepares exact successor tasks
and transfers open gates and evidence; early tasks cannot close the full goal.

## Budget

Two focused suite invocations total, one typecheck total, one correction round.
Worker edits and checks whitespace; challenger owns suite and typecheck. No
build/install/reindex/full suite. Preserve concurrent edits and record commands,
exit codes, input hashes and truncation. Stop on scope expansion.

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| CATCH | Accepted catch-local identifier design | implementation | CATCH-IMPL | Real-parser regressions and TypeScript |

## Decisions And Non-Goals

External design prerequisite is DONE in the parent tracker. Its local acceptance
stays intact. This successor owns implementation dispatch only. Provider and
workspace activation remain gated by the parent roadmap.

## Closeout

CATCH-IMPL is DONE. The strict manager closed this plan after authenticated
worker and independent challenger PASS receipts. Product changes are limited
to the declaration helper and its focused tests; provider activation remains
gated by the workspace roadmap.

Validation and budget: focused invocation 1 exited 1 (181 passed, one failed)
because malformed `catch ()` produced no catch clause for the test collector.
The one correction added parse-error refusal to that collector. Invocation 2
exited 0 with 182 tests passing across both named suites. The single
`tsc --noEmit` invocation and `git diff --check` exited 0. Used: 2/2 focused
invocations, 1/1 typecheck, 1/1 correction. No build, install, full suite or
reindex was run. Bounded OntoIndex file-scope verification passed; the index
is stale and workspace navigation exceeded its limit, so source inspection
and real-parser tests are authority.

Final SHA-256 inputs:

- Declaration helper: `958a61079ed338323f4b1b783df6cf94f17dc3e8fb92a1a789e37d0919bfbf8b`
- Focused tests: `755e04b67d177a145a144d2d9ff050107a7fdc23e444ab0bdcd843a85ea0bd3a`

Routing recovery: the first manager handoff needed one format correction and
remained rejected; parent atomic dispatch preserved the worker/challenger
gates. The first challenger needed one command-format correction, without
rerunning validation. No disk recovery or worktree creation occurred.
Knowledge handoff: existing manager-loop rules cover parent dispatch and
single-command validation receipts; no skill change proposed.

Remaining capture families, provider acceptance, CALLS, SEED, graph, deployment
and lifecycle acceptance remain open in LUNA_WORKSPACE_COMPLETION_PLAN.md.
This helper completion does not close the overall workspace goal.
