# Namespace import and export propagation

Date: 2026-10-24
Status: Closed
Authority: User proceed; ../ADR_TYPE_VALUE_NAMESPACES.md.

## Goal

Preserve distinct type/value export identities and import restrictions through
strict retention and the existing finalizer without activating provider capture.

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
  NS-2:
    title: Namespace export selection preserves both meanings and narrowed imports through retained finalization
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    type: code
    depends_on: []
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex-shared/src/scope-resolution/types.ts
    - ontoindex-shared/src/scope-resolution/parsed-file.ts
    - ontoindex-shared/src/scope-resolution/finalize-algorithm.ts
    - ontoindex/src/core/ingestion/finalize-orchestrator.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-scope-codec.ts
    - ontoindex/test/unit/scope-resolution/finalize-algorithm.test.ts
    - ontoindex/test/unit/scope-resolution/finalize-orchestrator.test.ts
    - ontoindex/test/unit/parse-worker-protocol.test.ts
    allowed_write_set:
    - ontoindex-shared/src/scope-resolution/types.ts
    - ontoindex-shared/src/scope-resolution/parsed-file.ts
    - ontoindex-shared/src/scope-resolution/finalize-algorithm.ts
    - ontoindex/src/core/ingestion/finalize-orchestrator.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-scope-codec.ts
    - ontoindex/test/unit/scope-resolution/finalize-algorithm.test.ts
    - ontoindex/test/unit/scope-resolution/finalize-orchestrator.test.ts
    - ontoindex/test/unit/parse-worker-protocol.test.ts
    non_goals:
    - Provider capture activation and qualified lookup
    - Transitive reexport closure or merge-hook policy replacement
    - Production replay activation and preparation limit changes
    required_validation:
    - cd ontoindex-shared && ../ontoindex/node_modules/.bin/tsc
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/finalize-algorithm.test.ts test/unit/scope-resolution/finalize-orchestrator.test.ts test/unit/parse-worker-protocol.test.ts test/unit/scope-resolution/registries.test.ts test/unit/scope-resolution/resolve-type-ref.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit --incremental false
    expected_evidence:
    - Distinct same-name type and value IDs survive one import without changing per-import counters
    - Authoritative empty namespace maps never fall back to legacy exports
    - Namespace intersection survives wildcard and unresolved edge construction
    - Codec roundtrip and adapter preserve maps and explicit import restrictions
    - Legacy hook precedence and static reexport behavior remain unchanged
    rollback:
    - Reverse only NS-2 hunks preserving existing worktree changes
    stop_conditions:
    - Requires provider activation or new transitive reexport semantics
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed with recovered namespace task and two Sol-medium developers
        validation_summary: Two disjoint Sol-medium developers completed core and codec packets; Luna and Sol source reviewers found no blockers. Shared tsc exit 0 receipt e86e27; five focused suites passed 207 tests exit 0 session 26602 receipt 7eb8a3; product tsc exit 0 session 86368 receipt 22aba4. Eight-file whitespace exit 0 receipt dc6e78. Declared-file OntoIndex verify_diff PASS; symbol scope not checked. One of two shared compilations one of two suites and one of two typechecks consumed; children ran no compiles or tests. No provider activation runtime launch deployment or performance claim. See audit_session-2026-10-24-namespace-import-export.md.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| NS2-IDENTITY | Separate export identities and narrowed imports | implementation | NS-2 | Finalizer matrix |
| NS2-RETENTION | Restrictions survive retention and adaptation | compatibility-test | NS-2 | Codec and orchestrator tests |
| NS2-LEGACY | Preserve counters and legacy merge policy | compatibility-test | NS-2 | Existing finalizer suite |
| NS2-ACTIVATION | Complete provider namespaces before activation | non-goal | NS-2 | Provider files unchanged |

## Decisions And Non-Goals

Four reviewers compared twice: kind inference loses type-only class imports;
separate pipelines duplicate linking and storage; optional metadata in existing
owners is selected. Compatibility is additive, rollback local, and strict schema
validation retains resource bounds. Export lookup continues to reuse lazy indexes;
ordinary named imports expand to at most two meanings. No performance measurement
is claimed. Metadata does not imply that arbitrary legacy hooks understand it.

Use exportsByNamespace with required type/value maps. A defined object overrides
legacy exports even when empty; absent/undefined preserves existing behavior.
Import namespace is optional type/value/both; tagged legacy imports narrow unknown
legacy exports without kind inference. Same-ID meanings may coalesce to both;
different IDs remain distinct. Preserve one draft and counter per ParsedImport.

Second challenge retained mergeBindings ownership: its output remains authoritative.
Give both meanings of one import together to the hook so an incoming-replaces-
existing hook can retain both; do not promise safety for callbacks discarding
individual meanings. Provider activation requires namespace-aware precedence.
Keep static reexport behavior and bounded SCC passes unchanged.

Two Sol-medium developer packets own disjoint core/types/tests versus
adapter/codec/tests. Parent validation budget: two shared compilations, two
focused suite runs, two product typechecks; no runtime launch or deployment.
Committed OntoIndex impact LOW for finalize, orchestrator and codec. Workspace
safe-edit fails workspace_too_large at 1832 > 1600; current source is authority.

## Closeout

Implemented in the eight declared source/test files. Shared compilation and
product typecheck passed; 207 tests passed across five focused suites. Explicit
namespace maps, grouped meanings and codec parity are covered. Source reviewers
found no blockers. Existing dirty work was preserved.

Validation budget used: 1/2 shared compilations, 1/2 focused suites, 1/2 product
typechecks, zero runtime launches. No recovery retries or budget overruns.
Declared-file OntoIndex verification passed; symbol scope was not checked.
Provider capture, qualified lookup and runtime acceptance remain separate gates.
