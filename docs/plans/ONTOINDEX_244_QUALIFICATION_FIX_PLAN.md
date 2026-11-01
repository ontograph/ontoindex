# OntoIndex 2.4.4 qualification fixes

Date: 2026-10-31
Status: Closed
Authority: User request to challenge the qualification, consolidate robust proposals, and execute fixes.

## Goal

Reject private namespace members, make release version detection independent of JSON formatting, and prevent stamping persistently changed validation inputs.

## Review and decisions

The prior qualification correctly bound release identity, used a positive namespace control, and reported 115 passing tests separately from failing probes. Its missing-member test did not request the actual private imported name. The hook probe bypassed pre-commit formatting, so it proved the isolated hook defect rather than the complete commit workflow. The verifier also omitted a final tracked-input identity check; that third concern was source evidence, not an executed result.

| Issue | Alternatives reviewed twice | Selected approach and challenge |
| --- | --- | --- |
| Namespace export boundary | Existing export evidence; new symbol export schema; refuse namespace chains | Reuse existing extraction/maps and graph evidence, with bounded traversal. A new shared schema expands replay compatibility work; refusing all chains breaks valid code. Export aliases must remain valid and private imports must never grant export authority. No filesystem reads or full graph scan per lookup. |
| Version detection | Broader regex; gate every manifest change; parse Git versions | Parse HEAD/index JSON using Node stdlib. Regex remains format-dependent; gating all metadata edits adds unnecessary full-suite cost. Git/JSON errors reject, and unstaged bytes cannot control the result. |
| Verification stamp | Final identity recheck; isolated staged worktree; hash all consumed inputs | Recheck tracked worktree equality and staged tree before stamping. This detects persistent drift with small Git-only overhead; it does not prove hermetic validation or detect mutation restored before completion. |

Changes remain in existing owners, add no dependency or public configuration, and preserve existing release-tree matching. Rollback restores only this branch's delta. Native Linux validation uses two test workers. No installation, release publication, unrelated GN tasks, or platform expansion is included.

Second namespace review rejected finalized scope lookup because it is unavailable at early heritage resolution and some namespace syntax lacks scope captures. Boolean graph export flags cannot represent public aliases or default names. The selected implementation extracts local public names once from the existing AST, transports them as tagged local records through the existing worker import stream, and stores reserved export entries in the existing maps. Local records do not create import edges. Source reexports retain ordinary bindings for compatibility while adding explicit public entries. The bounded resolver checks export authority at each module boundary; missing evidence remains unresolved. Snapshot V1 retains these entries without a schema change. This adds linear extraction work and map entries rather than repeated source or graph scans; no measured speedup is claimed.

All alternatives were challenged for correctness, root-cause coverage, malformed inputs, compatibility, complexity, runtime cost, security, testability and rollback. The selected gate parses trusted Git blobs and fails closed on command or JSON errors; the selected namespace design avoids arbitrary cross-module name fallback; final stamp checks use existing Git identity. Broader schema changes, isolated verification checkouts and all-input hashing offer wider guarantees but add owners and cost beyond these defects. Regression tests and branch-local rollback make the chosen changes directly reviewable.

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
  GATE-1:
    title: Semantic version changes require a matching stamp and changed validation inputs cannot be stamped
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - .husky/commit-msg
    - scripts/verify-release.sh
    - ontoindex/test/unit/commit-msg.test.ts
    - ontoindex/test/unit/verify-release-gate.test.ts
    allowed_write_set:
    - .husky/commit-msg
    - scripts/verify-release.sh
    - ontoindex/test/unit/commit-msg.test.ts
    - ontoindex/test/unit/verify-release-gate.test.ts
    non_goals:
    - No CI changes
    - No real release build in shell fixtures
    required_validation:
    - cd ontoindex && ONTOINDEX_SKIP_GLOBAL_SETUP=1 ONTOINDEX_TEST_WORKERS=2 ./node_modules/.bin/vitest run test/unit/commit-msg.test.ts test/unit/verify-release-gate.test.ts
    expected_evidence:
    - Real hook rejects compact bumps without stamp and accepts equal versions independent of format
    - Staged blobs govern detection and Git or JSON failures reject
    - Verifier rejects persistent staged or unstaged mutation and failed commands; generated ignored output is permitted
    rollback:
    - Restore only task-owned files from b7e5a45
    stop_conditions:
    - Unresolved semantics
    - Unrelated write scope
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User request to consolidate and execute robust fixes
        validation_summary: Final formatted gate fixtures passed 19 tests in two files with exit 0 (Vitest session 11409). Independent Sol source challenge found no concrete new defect. Exact staged blobs govern comparison; compact and escaped keys, invalid JSON, alternate index, Git errors, initial manifests, persistent staged and unstaged drift, ignored output and command failure are covered. No real release build ran.
    dod_status: pass
  NS-1:
    title: Namespace traversal requires export evidence while preserving valid aliases and replay
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - GATE-1
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/core/ingestion/model/resolution-context.ts
    - ontoindex/src/core/ingestion/named-bindings/typescript.ts
    - ontoindex/src/core/ingestion/import-processor.ts
    - ontoindex/src/core/ingestion/workers/parse-worker.ts
    - ontoindex/src/core/ingestion/workers/parse-types.ts
    - ontoindex/test/unit/namespace-heritage.test.ts
    - ontoindex/test/unit/model/import-resolution-state.test.ts
    - ontoindex/test/unit/model/resolution-context.test.ts
    - ontoindex/test/unit/import-processor.test.ts
    - ontoindex/test/integration/scope-retention-replay-edit-differential.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/model/resolution-context.ts
    - ontoindex/src/core/ingestion/named-bindings/typescript.ts
    - ontoindex/src/core/ingestion/import-processor.ts
    - ontoindex/src/core/ingestion/workers/parse-worker.ts
    - ontoindex/src/core/ingestion/workers/parse-types.ts
    - ontoindex/test/unit/namespace-heritage.test.ts
    - ontoindex/test/unit/model/import-resolution-state.test.ts
    - ontoindex/test/unit/model/resolution-context.test.ts
    - ontoindex/test/unit/import-processor.test.ts
    - ontoindex/test/integration/scope-retention-replay-edit-differential.test.ts
    non_goals:
    - No general resolver rewrite
    - No dependency or shared snapshot schema change
    required_validation:
    - cd ontoindex && ONTOINDEX_SKIP_GLOBAL_SETUP=1 ONTOINDEX_TEST_WORKERS=2 ./node_modules/.bin/vitest run test/unit/namespace-heritage.test.ts test/unit/model/import-resolution-state.test.ts test/unit/model/resolution-context.test.ts test/unit/import-processor.test.ts test/unit/scope-retention-parse-replay-heritage.test.ts test/integration/scope-retention-replay-edit-differential.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    expected_evidence:
    - Both private-binding fixtures emit zero false EXTENDS and inherited CALLS edges in TS and JS
    - Explicit exports and aliases preserve exact owners; star ambiguity and bounds remain enforced
    - Replay and focused resolver tests pass; typecheck passes
    - OntoIndex verifies changed-file scope and independent review challenges the final delta
    rollback:
    - Restore only task-owned files from b7e5a45
    stop_conditions:
    - Unresolved replay compatibility
    - Unrelated scope expansion
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User request to consolidate and execute robust fixes
        validation_summary: Final runtime delta passed 215 tests in the eight-file suite (session 61854); two added replay fixtures failed the intentional dangling-endpoint guard and were corrected. Both corrected tests passed (session 49643, exit 0; 20 unchanged cases skipped). Production tsc passed after the final runtime change (session 78444, exit 0). Scoped ESLint passed after correction (receipt b1a5dd, exit 0). Independent Sol source review confirmed the import-provenance collision closed and found no new issue. OntoIndex bounded file-scope verify_diff passed; symbol scan capped at 25 and symbol scope not asserted. No full suite, benchmark, installed distribution rebuild or release ran.
    dod_status: pass
```

## Required Traceability

| Requirement ID | User/report requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REQ-1 | Correct false namespace edges | implementation | NS-1 | Exact positive/negative edges and replay |
| REQ-2 | Formatting-independent release gate | implementation | GATE-1 | Real hook fixture tests |
| REQ-3 | Challenge forgotten validation gaps | implementation | GATE-1 | Persistent input-drift controls |
| REQ-4 | Robustness and performance | proof-only | NS-1 | Bounded lookup design, focused tests, independent review; no speedup claim |

## Execution evidence

Correction round 2 (of 2) is a replay-fixture adjustment: session 61854 passed 215 tests and failed two new replay cases (exit 1) because production reconstruction rejects dangling dotted `Class:models.Private` structural endpoints. The positive fixture now reconstructs valid public heritage and checks private-name refusal on the restored context; negative ingestion fixtures still assert no false EXTENDS or CALLS. The existing fail-closed replay admission rule remains unchanged. No runtime defect was attributed to that guard.

Final source challenge found that a source-bearing reexport can overwrite or delete a true local import with the same name. Correction round 1 (of 2) separates `#import:<local>` records from the legacy ordinary keys. Compared twice: provenance tags preserve unqualified compatibility and statement-order independence; shared-map precedence still conflates provenance; a separate map/schema expands replay changes unnecessarily. The selected tag adds one entry per named import and no new lookup scan. Tests cover same-source collision, different-source collision, reversed statements and a reexport that must not become a local binding. Two initial negative-control cases failed before implementation, as expected (session 27106, exit 1). Initial six-file validation passed 194 tests (session 42894, exit 0); production typecheck passed (session 8555, exit 0). Scoped ESLint passed with 56 existing non-null warnings and zero errors (session 78019). These checks precede the provenance correction and will be rerun for its affected scope.

Base: b7e5a4517cab428a47fcd42111d02352b01204ba. Branch: fix/244-qualification. Four independent discovery/challenge packets completed using GPT-6 Luna and GPT-6.1 Sol, followed by bounded implementation and final namespace/replay challenges. OntoIndex initially used 2.4.3 evidence and automatically refreshed to the release commit. Resolver impact is HIGH; source and replay callers received focused validation. The unrelated GN plan remains blocked and is unchanged.

## Closeout

Implemented semantic staged-version detection, persistent validation-input drift rejection, and export-authorized namespace traversal with separate import provenance. The final suite produced 215 passing cases and two fixture failures; the two corrected replay cases then passed. All 217 selected cases therefore have passing evidence for their final relevant inputs across those runs. Typecheck, focused lint and whitespace checks passed. One source correction and one fixture correction consumed the two follow-up rounds; no unresolved blocker remains.

No dependency, snapshot version or public configuration was added. Extraction is once per AST and namespace lookup retains depth-five/work-64 bounds; performance was not benchmarked. Snapshots without new export markers conservatively leave namespace members unresolved. Replay still rejects dangling dotted heritage endpoints; positive persisted reconstruction and private-name resolver refusal are tested separately. The release verifier detects persistent tracked-input drift, not transient restored mutations or untracked inputs. Full suites, CI, installed-client qualification and release publication are outside this fix plan.
