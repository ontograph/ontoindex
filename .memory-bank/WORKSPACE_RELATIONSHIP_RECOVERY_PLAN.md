# Workspace relationship recovery

Date: 2026-10-21
Status: Closed (regression and design scope)
Authority: User instruction to proceed with deployment identity, regression fixtures and bounded incremental relationships

## Goal

Enable bounded current-worktree relationship navigation without losing clean callers or presenting partial graphs as complete.

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
  REG-1:
    title: Populated-baseline dirty retargeting, deletion and rename match independent full graph analysis
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: test
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/test/integration/workspace-graph-snapshot.test.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    allowed_write_set:
    - ontoindex/test/integration/workspace-graph-snapshot.test.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    non_goals:
    - No production graph patching, cap increases or silent fallback
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/local-backend-repo-runtime.test.ts test/integration/workspace-graph-snapshot.test.ts
    expected_evidence:
    - Dirty graph node and relationship identity parity with independent full analysis
    - Exact-limit admission and above-limit refusal before lock or build
    rollback:
    - Revert only newly added test hunks
    stop_conditions:
    - A fixture requires changing production semantics
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed following deployment identity and relationship recovery proposal
        validation_summary: Final focused vitest run passed 76 tests across two files after formatting; tsc --noEmit --incremental false and git diff --check exit 0. Read-only challenger found no mandatory corrections; bounded OntoIndex diff PASS is file-scope evidence under stale index.
    dod_status: pass
  GRAPH-1:
    title: Dirty relationship updates preserve resolution ownership and match full graph analysis within budgets
    status: DONE
    classification: docs/design-only
    assurance_profile: full
    complexity: complex
    depends_on:
    - REG-1
    type: design-gate
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - .memory-bank/WORKSPACE_RELATIONSHIP_RECOVERY_PLAN.md
    - .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md
    - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
    - ontoindex/src/core/run-analyze.ts
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    allowed_write_set:
    - .memory-bank/WORKSPACE_RELATIONSHIP_RECOVERY_PLAN.md
    non_goals:
    - No unsafe DETACH merge or symbols-only relationship authority
    required_validation:
    - project_plan_validate .memory-bank/WORKSPACE_RELATIONSHIP_RECOVERY_PLAN.md
    expected_evidence:
    - Reviewed resolution seed, source-owned edge replacement and affected closure design
    - Separate implementation packets for derived graph invalidation and full graph parity
    rollback:
    - Retain existing complete full-workspace preparation and explicit committed mode
    stop_conditions:
    - Missing complete resolution or source ownership evidence
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested critical review and consolidated design execution
        validation_summary: Reviewed complete resolution seed, source ownership, dependency closure, coherent captured inputs, derived invalidation and atomic publication; independent parity and resource gates specified. Source confirmed resolution context and DETACH behavior. Production implementation requires ADR amendment and separately scoped packets.
    dod_status: pass
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REC-001 | Preserve clean incoming callers, deletions and tracked renames | implementation | REG-1 | Independent graph identity parity |
| REC-002 | Resource-limit regressions without raising caps | implementation | REG-1 | Exact boundary and early refusal |
| REC-003 | Bounded incremental relationship navigation | architecture-gate | GRAPH-1 | Complete resolution and ownership design |

## Decisions And Non-Goals

- Host configuration pinned MCP to rc.3 despite an installed rc.8 CLI. Only the OntoIndex script argument in `/home/er77/.ontocode/config.toml` was changed to the installed rc.8 path. The original config is retained as an owner-only rollback copy. Existing processes were not signalled; reconnect remains necessary to load the new artifact.
- Compared twice: a higher cap retains full-build cost; scoped partial graphs cannot establish complete impact; incremental relationship updates are preferred after resolution and edge ownership prerequisites are explicit.
- The current `deleteNodesForFile` DETACH operation drops incoming clean edges and suppresses table errors. It is insufficient as an incremental publication primitive.
- Limits: three focused test runs, one build and one post-change installed smoke. No automatic retry/reindex loops. One refresh attempt encountered an existing analyzer and skipped duplicate execution.

## Closeout

## Reviewed Relationship Design

GRAPH-1 is a design deliverable. Engine absence gates implementation acceptance,
while source evidence below permits completing the design. No relationship engine
is enabled by this document. The accepted ADR currently defers that engine; an
explicit ADR amendment must precede its production implementation.

Three alternatives were compared twice across correctness, compatibility, resource
bounds, security, testability and rollback: increasing the full-build cap retains
whole-repository cost; scoped partial graphs lose authoritative incoming callers;
persisted resolution state with bounded dependency closure addresses both costs and
correctness, at higher implementation complexity. Select the third behind staged
parity gates. Unsupported languages or budget overflow retain typed refusal and the
explicit committed fallback. Never silently promote a partial graph.

1. Persist a versioned resolution seed beside the committed generation: importMap,
   namedImportMap, packageMap, moduleAliasMap, model bindings, exported types and
   unresolved callsites. Bind source/base generation, parser and configuration
   identities. Refuse incompatible or unsupported seeds. The current parse owner
   creates its context at parse-impl.ts:348 and retains ephemeral maps at 1157.
2. Replace source-owned extraction units, including empty replacements on deletion.
   Expand clean dependency closure for renames, export changes, newly resolvable
   calls and configuration changes. Preserve unaffected incoming edges. The current
   lbug-adapter.ts deleteNodesForFile uses DETACH DELETE and is unsuitable for this
   replacement because it removes clean incoming relationships.
3. Invalidate and recompute derived processes, communities and ranking affected by
   that closure. Publish a complete immutable generation atomically. Honor request
   pins and cancellation; cancellation cannot advance CURRENT. Negative impact
   answers require complete supported closure.
4. Reuse the existing captured-input owner for coherent content identities. Bind
   the closure to one captured input manifest and base generation; verify those
   identities before publication. A changed base or source input invalidates the
   candidate. Never combine live reads from different workspace states. Any fresh
   capture is explicitly budgeted and must not become an automatic retry loop.

Ordered implementation packets, requiring separate authorization-ready tracking:

| Packet | Existing owner / write boundary | Acceptance and stop condition |
| --- | --- | --- |
| Seed contract | ADR amendment, parse-impl and resolution persistence owner | Versioned round trip includes unresolved calls; stop on unsupported resolver |
| Edge replacement | Graph storage and ingestion owners | Add, retarget, delete, rename and export-change parity; stop on missing source ownership |
| Derived data | Existing process/community/ranking owners | Full derived parity and atomic cancellation; stop on incomplete invalidation |
| Request integration | local-backend-repo-runtime preparation owner | Reuse immutable generation; bounded closure; preserve committed provenance |
| Independent validation | Existing populated-baseline integration fixtures | Full node/edge parity against independent full pipeline; memory/work limits, formerly unresolved clean caller, parser/config mismatch |

Keep production behavior gated until all packets pass. Do not convert this design
into a symbols-only merge or raise global caps. Rollback selects the existing full
preparation owner and explicit committed reads.

## Validation history

Regression validation passed. Two focused suite invocations consumed two of
three permitted test runs; the second followed formatting. TypeScript passed.
No build ran. One fresh rc.8 SDK connection advertised server version
`2.3.5-rc.8` and closed cleanly with zero tool calls; existing host-managed
connections were not restarted. The host configuration change does not fix
default workspace preparation.

GRAPH-1 design is complete. Production implementation requires the staged
packets and ADR amendment above. A full pipeline currently
creates a fresh resolution context; its import/export and binding inputs are
not persisted in the committed graph. A node-only seed cannot reconstruct
previously unresolved callsites. Existing DETACH deletion also removes valid
clean incoming relationships. These are source-confirmed prerequisites rather
than a transient limit that a retry could repair.

Knowledge handoff: none; existing navigation and anti-loop skills already
require source authority on stale indexes and prohibit unchanged retries.
