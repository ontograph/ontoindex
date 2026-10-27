# Named declaration export capture

Date: 2026-10-22
Status: In progress
Authority: User continue; ADR_AUTOMATIC_DIRTY_WORKSPACE.md; completed catch prerequisites

## Goal

Ordinary named function and class exports resolve canonical module-local definitions.

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
        model_candidates:
        - gpt-6-luna
        - gpt-6.1-sol
        reasoning_effort: high
      coder-worker-test-challenger:
        agent_type_candidates:
        - coder-worker-test-challenger
        model: gpt-6.1-sol
        reasoning_effort: xhigh
  last_decision: dispatched
  reopen_gate: null
tasks:
  DECL-EXPORT:
    title: Ordinary named function and class exports resolve their canonical local definitions
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    type: code
    depends_on: []
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/languages/typescript-export-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-export-captures.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/languages/typescript-export-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-export-captures.test.ts
    non_goals:
    - Defaults reexports variable exports abstract declarations shared schema provider activation or runtime graph changes
    required_validation:
    - ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-export-captures.test.ts test/unit/scope-resolution/typescript-declaration-captures.test.ts
    - ./node_modules/.bin/tsc --noEmit --incremental false
    - git diff --check -- ontoindex/src/core/ingestion/languages/typescript-export-captures.ts ontoindex/test/unit/scope-resolution/typescript-export-captures.test.ts
    expected_evidence:
    - Accepted recommendation extends emitTypeScriptExportCaptures for ordinary named function and class exports using existing identifier captures and canonical local interpreter
    - Alternatives synthetic clauses lose native ranges and shared extractor edits unnecessarily expand consumers so both are rejected
    - Second review checks malformed default anonymous abstract generator variable and reexport refusal plus duplicate exports and nested declaration identity
    - Body type syntax remains valid while wrapper type-only syntax refuses and existing clause behavior stays compatible
    - Existing owner reuse avoids new allocation infrastructure or public schema and focused parser tests plus two-file rollback bound correctness security performance and compatibility risks
    - TS TSX JS JSX ordinary named export function and class resolve exact canonical module local IDs
    - Detached captures retain identifier ranges and survive parser reuse
    - Existing ordinary clauses duplicate rejection and unsupported forms remain fail closed
    rollback:
    - Revert only in-scope export helper and test additions
    stop_conditions:
    - Shared extractor changes or unresolved semantics required
    - Two suite invocations or two typechecks exhausted
    known_blockers: []
    dispatch:
      role: coder-worker-test-challenger
      attempts: 0
      dispatch_id: 25afc9d5-650f-46a4-bc6b-bd45bcf1259f
      scope_sha256: 06d5c61d7c4e7e1fa8318204d33ce9dd991d812f8f7e5114ac49e8294bfeec1e
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792697069461'
      assigned_agent: 01a16512-6f35-76c1-a65c-08ef192d71b6
      agent_type_requested: cdr-worker-test-challenger
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: 1e638ad27859c95226e1970e661a1f68bc9bdf15d9572b6e5474949562c19d1b
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-worker
        agent_id: 01a1650f-93dc-7d62-94db-e542c356dd4a
        effective_model: gpt-6-luna
        receipt_id: role-result-e7cf22774874d6095e0ba45bbc5402e5c3aecdf8aa63c84e28bd07552132cef3
        verdict: PASS
      - role: cdr-worker-test-challenger
        agent_id: 01a16512-6f35-76c1-a65c-08ef192d71b6
        effective_model: gpt-6.1-sol
        receipt_id: role-result-c08e9bd9cddf6ffc01454345e86d0ac11a6907a03e17834fcae0e3aafaef4282
        verdict: PASS
    dod_status: pass
```

## Accepted packet

Scenario: Named declarations export canonical local definitions.
Given existing declaration capture and export interpretation,
when the emitter sees a top-level ordinary named function or class export,
then it emits the existing local/name pair at the declaration identifier and
interpretation resolves the completed unique module binding.

Validate wrapper tokens and declaration shape, reject default/abstract/anonymous,
malformed and escaped names, preserve local clause behavior. Inspect type-only
export modifiers at wrapper level; do not reject a valid function body merely
because it contains a type keyword. Preserve existing parse-error refusal.
No new metadata or source-to-source rewriting.

## Decision review

Compare extending existing export emitter, lowering exports into synthetic
clauses, and changing shared extraction. Select the existing emitter: smallest
compatible owner, canonical IDs reused, no extra AST or protocol. Synthetic
clauses lose native ranges; shared changes expand consumers. Second review tests
malformed/default wrappers, duplicate exports, same-name nested declarations and
TS annotations. Keep unsupported forms explicit; no activation claim.

## Budget

At most two focused suite invocations and two typechecks across all roles; one
correction round within those limits. Worker owns edits and whitespace; challenger
owns tests/typecheck. No build/install/reindex. Preserve concurrent changes.

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| DECL | Canonical named declaration exports | implementation | DECL-EXPORT | Real parser tests in four grammars and TypeScript |

## Decisions And Non-Goals

CATCH completion is retained in LUNA_CATCH_IMPLEMENTATION_PLAN.md. Broader
capture, provider, CALLS, SEED and runtime acceptance remain open.

## Closeout

Open.

## Selected continuation after schema acceptance

SCHEMA-1 is DONE with accepted challenger receipt
role-result-0b7db4ecba3a14e52b1d6fa2ccdafc3bd97b69c608f53e54857a3a00dca1b7f7.
The user requested selection and execution after the explicit additional
typecheck requirement. Authorize one additional typecheck only: retain one
consumed of two total suites and one consumed of two total typechecks. Preserve
the prior 199-test result and failed compile receipt; no correction-budget reset.

Compare unchanged adoption plus independent validation, inherited schema compile,
and implementation rewrite. Select unchanged adoption: current emitter and tests
cover ordinary named declarations with canonical identities and native ranges;
the failed compile belonged to the now-repaired schema owner. Inherited evidence
cannot satisfy this challenger's execution contract. Rewriting or synthetic
lowering adds semantic and performance risk without addressing the failure.
Second review retains wrapper refusal, four grammars, detached captures, duplicate
rejection, parser reuse, and body type syntax; provider activation remains gated.

Worker adopts only the existing two-file diff and runs scoped whitespace checking;
it must not run suite/typecheck or edit unrelated files. Fresh worker acceptance
is required because role_results is empty. Challenger owns the remaining exact
two-file suite and one typecheck, serially in a new isolated current-input copy.
Use the proven schema acquisition selection and separate durable pre/post input
manifests; verify selected test dependencies before use. CI=true and
UPDATE_SNAPSHOTS=0 precede the standalone suite command. Supply absolute workdir
separately; no cd, pipelines, export, logging/status/exit wrappers. Preserve exact
runtime command receipts. Stop on failure, input mutation, or exhausted allowance.

### Exact worker receipt correction

Preserve BLOCKED receipt role-result-31296af1bf9c7b2d72a9d35887f0ad94f568d3fe3809bc05ab0a4a84df4a4587.
Its exact original invocation is unavailable. Independent runtime source reviews
confirm native exec_command through functions.exec records receipts, but matching
requires identical command strings from the same child's latest execution turn.
Compare old-invocation recovery (unavailable), fresh exact worker whitespace
execution (selected), and runtime changes (unproven and wider scope). Second
review retains all checks and forbids inherited validation claims.

The user request authorizes one bounded worker adoption/evidence correction:
execute the exact scoped whitespace command declared above through native
exec_command with repository workdir supplied separately, then use the identical
literal command in validation.commands. No compound shell, suite, typecheck,
code rewrite, or runtime patch. Preserve previous receipt and failures. Stop if
this fresh command receipt is rejected; do not repeat or remove the check.
The suite and typecheck allowances remain one each, reserved for challenger.
