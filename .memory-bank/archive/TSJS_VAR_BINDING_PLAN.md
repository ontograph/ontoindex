# TS/JS var binding identity

Date: 2026-10-22
Status: Closed
Authority: User proceed; ADR_AUTOMATIC_DIRTY_WORKSPACE.md local binding refinement

## Goal

Preserve declaration evidence while resolving supported repeated var declarations
and simple parameter overlap to one deterministic local binding.

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
  VAR-1:
    title: Repeated supported var declarations retain all definitions and one binding
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/test/unit/scope-resolution/scope-extractor.test.ts
    - ontoindex/test/unit/scope-resolution/typescript-declaration-captures.test.ts
    - ontoindex/src/core/ingestion/language-provider.ts
    - ontoindex/src/core/ingestion/scope-extractor.ts
    - ontoindex/src/core/ingestion/languages/typescript-declaration-captures.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/language-provider.ts
    - ontoindex/src/core/ingestion/scope-extractor.ts
    - ontoindex/src/core/ingestion/languages/typescript-declaration-captures.ts
    - ontoindex/test/unit/scope-resolution/scope-extractor.test.ts
    - ontoindex/test/unit/scope-resolution/typescript-declaration-captures.test.ts
    non_goals:
    - Provider activation or shared persisted schema changes
    - Full JavaScript environment semantics and workspace navigation claims
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/scope-extractor.test.ts test/unit/scope-resolution/typescript-declaration-captures.test.ts test/unit/scope-resolution/typescript-import-captures.test.ts test/unit/scope-resolution/typescript-scope-captures.test.ts test/unit/scope-resolution/finalize-algorithm.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    expected_evidence:
    - Reordered captures produce the same canonical binding while all definitions survive
    - Parameters win over var and separate environments remain isolated
    - Unsupported syntax and invalid hook output refuse; default providers unchanged
    rollback:
    - Revert only VAR-1 changes preserving pre-existing edits
    stop_conditions:
    - Shared schema or provider activation required
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit review and execute instruction with bounded corrected-suite extension
        validation_summary: Parent verified unchanged five source and test hashes against retained implementation; corrected focused Vitest exit 0 with 232 tests across five files in 1.57 seconds; git diff --check exit 0. Prior production tsc noEmit exit 0 receipt call_H5O7WPACHl0Hkm1qA3wPLeNL retained for unchanged sources. Two Sol medium reviewers found no supported-scope blocker; Luna validation review confirmed permutation coverage. Provider activation and runtime workspace readiness excluded.
    dod_status: pass
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| VAR-ID | Preserve declarations and canonical supported local bindings | implementation | VAR-1 | Focused real-grammar and extractor tests |
| VAR-COMPAT | Preserve existing providers and persisted formats | compatibility-test | VAR-1 | Default extractor and finalize tests |

## Decisions And Non-Goals

Four read-only reviewers compared append-and-hoist, capture deduplication and
post-collection selection. The third preserves declaration evidence and avoids
shared format changes. Parent owns integration; development helpers have disjoint
extractor and TS/JS source/test ownership. Budget: two focused suite invocations
and two typechecks, initially unused; no build, install, release or reindex.
OntoIndex transport failed in the inherited turn; source inspection is authority.
A reviewer additionally reported a stale index; no graph-backed claims are made.

## Closeout

Review continuation: the user's explicit review-and-execute instruction authorizes
one additional focused suite invocation for the corrected fixture. Original
allowances remain recorded below; amended suite allowance is 3, with 2 consumed
before this continuation. No additional typecheck, build or installation is
allocated. Four bounded read-only reviewers inspect the existing implementation;
two use gpt-6.1-sol medium and two use gpt-6-luna medium.

Implementation landed in the five declared source/test files. Four discovery
reviewers and two gpt-6.1-sol medium development helpers participated; an
independent source reviewer found no remaining concrete blocker after corrections.
The optional selector preserves all definitions and validates selected identities.
TS/JS captures select a parameter or earliest var and reject unsupported collisions.

Historical suite allowance consumed: 2/2 (first invocation
returned no receipt and is conservatively reserved; second exit 1, 228 passed and
4 failed because the new test imported unexported makeDefId). Correction round 1
removed that import and compares public extractor output. Corrected test SHA-256:
605ba61e80b3e9c5df3dfab9ccae08b1816f6aeda9f8421090638a78ee9ff835.
The authorized corrected run passed 232 tests across five files, exit 0, in
1.57 seconds; amended suite allowance consumed 3/3. Its 221-byte log is retained
at /tmp/ontoindex-var1-tests-corrected.log; receipt call_lUM7fyZGqUGNZSBhVHmWjpyh.
Retained failure log:
/tmp/ontoindex-var1-tests.log.

Production TypeScript check passed with exit 0 (session 29938); retained output
/tmp/ontoindex-var1-typecheck-final.log. One earlier typecheck call returned no
receipt and produced no log or surviving process; conservatively reserved, so
typecheck allowance consumed 2/2. No build, install, push or reindex occurred.
Rust formatting is inapplicable because this checkout has no ontocode-rs tree.
The per-declaration AST validation cost remains an activation prerequisite.
Knowledge handoff: none; existing receipt and validation-budget rules cover the
missing-output and fixture-failure cases. Manager completion uses the validated
local evidence above through complete-local.

## Review And Consolidated Follow-Up

Second challenge retains post-collection selection: append-and-hoist leaves
ambiguous bindings; dropping captures loses declaration evidence. Selection
preserves compatibility and rollback without a persisted-schema migration.
Its candidate grouping is linear. Existing declarations and unsupported-syntax
refusals remain intact; no dependency or transport changes are required.

Good: preserved declaration evidence, explicit activation boundary and four
real grammars with capture permutations. Weak: failed fixture import and lost
execution receipt consumed validation allowance before useful completion.
Forgotten runtime proof remains explicit: helper success cannot certify dirty
workspace navigation or installed artifact identity.

Next sequence: complete remaining TS/JS binding/import/export/reference capture;
bound environment validation to one traversal before provider activation; prove
real-provider and retained-replay parity; then CALLS and generation publication;
finally test all eight default navigation/safety calls on the large dirty checkout.
Keep committed fallback provenance and capacity refusal throughout. Existing ADR
owns this sequence; each successor requires its own bounded executable packet.
