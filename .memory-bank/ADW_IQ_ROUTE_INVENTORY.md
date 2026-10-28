# Automatic Workspace Route Inventory

Date: 2026-10-18
Evidence baseline: acbcb63830cf51a8fc0537a76f4267e5be758167 plus inspected dirty source.
Authority: IQ-8I preparation in archive/ADW_IQ5_FIXTURE_COMPLETION_PLAN.md.

This report records source-supported behavior. No new SDK, correctness or
performance qualification ran. Canonical IQ-8 source inventory is accepted in this direct-session iteration; IQ-5 remains unresolved.
The source report SHA-256 is
c238923de23c727316f27b0f66cdafa8cc9dd192232eef540ec33ad49b000e44.

## Route behavior

Paths below are relative to `ontoindex/src/mcp/`. Flag means
`ONTOINDEX_AUTO_WORKSPACE`. Source presence is implemented-unqualified;
unproven means evidence is incomplete, rather than necessarily absent code.

| Route | Flag off | Flag on | Owner and qualification limit |
| --- | --- | --- | --- |
| Backend context, impact and relationship tools | Existing snapshot | Preparation requires relationships and pins the selected snapshot | local/local-backend.ts:1241,2159; local/local-backend-repo-runtime.ts:188; SDK coverage unproven |
| Backend query and repomap | Existing snapshot | Workspace graph requested; selected failures allow labeled committed fallback | local/local-backend.ts:1259; local/local-backend-repo-runtime.ts:227 |
| Normal facade actions | Backend dispatch | Backend preparation policy applies | facade/dispatch.ts:83; action-by-action SDK parity unproven |
| Lazy graph-backed super tools | Committed graph | Committed graph with explicit notice | server.ts:549; workspace relationship coverage is not established |
| Audit facade super-tool aliases | Committed graph | Committed graph with notice | facade/dispatch.ts:67; differs from ordinary backend actions |
| Graph resources | Committed graph | Committed graph with notice | resources.ts:617; same-preparation requirement needs IQ-9 disposition |
| Group query/context/impact | Existing member handlers | Member calls pass through backend preparation | local/local-backend.ts:1524,2142; per-member output provenance and mixed-state proof unproven |
| Lexical dirty search | Existing committed behavior | Workspace search tests located | test/integration/workspace-graph-search.test.ts; runtime qualification not rerun |
| Workspace vector/neighborhood | No workspace completeness claim | Explicit unavailable cases exist in search tests | test/integration/workspace-graph-search.test.ts:170; no broader route-wide completeness claim |
| Diagnostics/history/mutation exclusions | Ungated | Ungated | local/local-backend.ts:1225; enumerate each action before public capability claims |
| Public byte pagination | Immutable stored-response replay | Same replay preserves stored result across later edits | shared/response-pages.ts:46,62,80; request hash excludes cursor; logical/docs cursors require separate review |

## Report priority mapping

The eleven rows correspond to source report lines 229–239. ADW references identify
existing task owners, not acceptance of those tasks.

| Requirement | Existing owner or schema | Located tests | ADW owner and disposition |
| --- | --- | --- | --- |
| P0 capability discovery | local/backend-overlay.ts:37; shared/response-envelope.ts:59; facade/dispatch.ts:34 | workspace-graph-search.test.ts; calltool-dispatch.test.ts | ADW-4a/5a/6b; machinery exists, complete public discovery unqualified |
| P0 provenance | shared/response-envelope.ts:23; local/backend-overlay.ts:41,398; shared/target-context.ts | calltool-dispatch.test.ts; overlay-context-impact.test.ts | ADW-2b/2c/5/6b; route completeness unproven |
| P0 failures and retry | local/local-backend-repo-runtime.ts:32; local/local-backend.ts:1261; server.ts:130 | calltool-dispatch.test.ts:273; local-backend-repo-runtime.test.ts:403 | ADW-3b/5a/6b; internal typed errors exist, public preservation gap |
| P0 generation consistency | local/backend-overlay.ts:153; local/local-backend.ts:2186 | calltool-dispatch.test.ts:301,336; runtime lifetime tests | ADW-5/5a/5b; request pin exists, edit-between-reads/cancellation SDK proof missing |
| P1 coalescing and progress | local/local-backend-repo-runtime.ts:270,338 | local-backend-repo-runtime.test.ts:377,625 | ADW-3/3b/6; coalescing tests exist, public progress unproven |
| P1 read preference | local/local-backend-repo-runtime.ts:227 | local-backend-repo-runtime.test.ts:570 | ADW-4a/5a/5e; internal fallback policy, explicit public preference unproven |
| P1 search/context/impact parity | local/local-backend.ts tool sets and dispatch | overlay-context-impact.test.ts; workspace-graph-search.test.ts | ADW-5d/5e/7e; same-byte full-analysis SDK parity unqualified |
| P1 group provenance | local/local-backend.ts:1524 | No complete mixed-member provenance test established by this inventory | Dedicated group acceptance task unmapped; IQ-9 must adjudicate |
| P1 pagination/cache identity | shared/response-pages.ts:62,80,277 | response-pages.test.ts:32,231 | ADW-5c/5h/5i; immutable byte replay implemented, semantic cache and other cursors unproven |
| P2 diagnostics | local/local-backend.ts:2056; shared/target-context.ts | No complete public phase/privacy fixture established here | ADW-6c/7c; metadata exists, boundaries and privacy qualification missing |
| P2 offline qualification | Existing fixture and benchmark owners | IQ-3 evidence; IQ-10/11/12 gates | ADW-7d/7e/7f; correctness and repeated performance remain pending |

Lazy tools and resources additionally map to ADW-5f and ADW-5g. Their intended
same-preparation behavior and present committed notices require an explicit
compatibility decision; this inventory does not infer completion.

## Gaps and next decisions

1. `formatToolCallErrorMessage` at server.ts:130 serializes bounded message and
   optional repository identity. It omits internal error code/retry fields.
   Preserve the existing typed error owner in any correction; verify public SDK
   behavior before declaring its complete contract repaired.
2. `dispatchTrackedRepoTool` at local/local-backend.ts:2174 passes repo, relationship
   need, workspace-graph preference and deadline to preparation, without a signal.
   Public SDK cancellation/progress propagation is unproved. Internal waiter tests
   alone cannot establish public cancellation.
3. Group member generation/coverage, diagnostic privacy, logical/docs cursors and
   explicit read preference need bounded follow-up evidence. Do not duplicate
   envelopes, pin owners or pagination storage to fill these gaps.

For public error preservation, compare additive serialization of existing typed
fields (preferred pending IQ-9), prose matching (fragile), and a parallel error
protocol (unnecessary compatibility cost). A second review must test unknown
errors, bounded diagnostics and legacy callers before implementation.

For cancellation, compare propagation through existing request context (preferred
pending ownership trace), runtime-wide cancellation (could cancel other waiters),
and a second cancellation coordinator (duplicate ownership). Verify independent
waiter cancellation and pin release before claiming support.

Run a discriminating pilot and terminal process-tree CPU proof before repeated
performance work. Preserve original ADW-2 receipt provenance and all default/release
gates. Static IQ-5F2 acceptance supplies no real ABA evidence.

## Evidence limits

Source and test locations were inspected; tests named here were not executed for
this report. Existing 87-test static acceptance remains attributed to its own
worker/challenger receipts. No new production edits, dependencies or services.
This report prepares canonical IQ-8 adjudication and IQ-9 corrective decisions.


## Verified identity and lifecycle fields

TargetContext (shared/target-context.ts:114) includes repoKey, repoLabel, repoPath, targetHead, currentHead, indexedHead and generationId. graphAuthority (:62) includes state, reason, generationId, manifestDigest and coverage. The capability envelope (shared/response-envelope.ts:55) includes capabilitiesUsed/Missing, freshness, warnings and limits. Overlay coverage can include partial; cross-route representation remains unknown.

withPinnedOverlay (local/backend-overlay.ts:153-187) owns pin release in finally. Wrapper bookkeeping release does not release the actual pin. response-pages.ts:62,80 hashes tool and arguments except cursor and stores immutable resultHash, expiry and identity; semantic cache keys remain unproven. Runtime test :625 covers independent workspace waiters; :968/:981 cover generic repository initialization.

## Explicit backend membership

Relationship methods: context, impact, impact_batch, api_impact, cycle_detect, coupling_matrix, boundary_violations, hotspot_analysis, dead_code, tech_debt, audit_report, ipc_trace, evidence_pack. Source: local-backend.ts RELATIONSHIP_TOOLS. query and repomap request workspace graphs with labeled committed fallback.

Excluded methods: gn_diagnose, analysis_catalog, session, detect_changes, graph_diff, audit_rerun, rename, rename_symbol, sandbox, replace_symbol, update_symbol_body, extract_function, move_symbol. Source: UNGATED_REPO_TOOLS. Existing diagnosis/history/mutation guards apply under both flags.

Review correction: workspacePreparationError already adds code/retryable; busy and timeout are retryable. Public server serialization drops those fields. SDK request context and preparation signal propagation remain missing at the dispatch boundary.

Canonical IQ-8 still needs complete facade action attribution, lazy/resource enumeration, per-route serialized identity fields, group query/context/impact provenance, logical/docs cursor distinctions and diagnostic/privacy test/task mappings. The grouped matrix cannot be accepted unchanged.

## Complete facade action attribution

Extracted from current facade/dispatch.ts:getInternalMethod. Each mapping uses
the backend policy above. discover/tools without codebase:true returns global
frontier metadata directly. Unrecognized actions fail in the existing owner.

| Facade | Actions | Backend method |
| --- | --- | --- |
| discover | repos | list_repos |
| discover | routes | route_map |
| discover | tools | tool_map |
| discover | packs | analysis_catalog |
| discover | groups | group_list |
| discover | sync | group_sync |
| search | semantic | query |
| search | cypher | cypher |
| search | repomap | repomap |
| inspect | context | context |
| inspect | evidence | evidence_pack |
| inspect | shape | shape_check |
| inspect | ipc | ipc_trace |
| impact | symbol | impact |
| impact | batch | impact_batch |
| impact | route | api_impact |
| impact | diff | detect_changes |
| audit | report | audit_report |
| audit | dead_code | dead_code |
| audit | tech_debt | tech_debt |
| audit | hotspots | hotspot_analysis |
| audit | cycles | cycle_detect |
| audit | coupling | coupling_matrix |
| audit | violations | boundary_violations |
| audit | coverage | verification_gap |
| audit | migration | migration_progress |
| audit | drift | cross_doc_drift |
| audit | build | build_residue_audit |
| audit | graph_diff | graph_diff |
| audit | requirements | requirements_trace |
| audit | patterns | pattern_audit |
| audit | rerun | audit_rerun |
| refactor | rename | rename |
| refactor | replace | replace_symbol |
| refactor | sandbox | sandbox |
| manage | session | session |
| manage | route_map | route_map |
| docs | trace, drift, context, readiness | docs |

## Resource membership

Source: resources.ts resource definitions. Each listed URI uses its existing
resource handler under both flags. Graph reads have committed notices; metadata
and advisory resources do not thereby acquire workspace completeness. ADW-5g
owns compatibility; complete resource parity tests remain unmapped.

- `ontoindex://repos`
- `ontoindex://setup`
- `ontoindex://repo/{name}/context`
- `ontoindex://repo/{name}/clusters`
- `ontoindex://repo/{name}/processes`
- `ontoindex://repo/{name}/schema`
- `ontoindex://repo/{name}/analysis-packs`
- `ontoindex://repo/{name}/analysis-suites`
- `ontoindex://repo/{name}/analysis-plan/{targetId}`
- `ontoindex://repo/{name}/cluster/{clusterName}`
- `ontoindex://repo/{name}/process/{processName}`
- `ontoindex://group/{name}/contracts`
- `ontoindex://group/{name}/status`
- `ontoindex://repo/{name}/memories`
- `ontoindex://repo/{name}/memory/{memoryName}`
- `ontoindex://repo/{name}/onboarding`

## Lazy graph and audit aliases

server.ts applies initialization and committed notices according to
GRAPH_BACKED_SUPER_TOOLS. Exact membership must be resolved from its existing
declaration before per-super parity claims; per-super workspace generation,
cache and cancellation evidence remains unproven. This is an explicit unmapped
sub-inventory, not a claim of full lazy-tool enumeration.

Audit aliases from getAuditFacadeSuperTool:

| Action | Super owner |
| --- | --- |
| session_start | gn_audit_session_start |
| session_verify | gn_audit_session_verify |
| session_dedupe | gn_audit_session_dedupe |
| session_bundle | gn_audit_session_bundle |
| session_dispatch | gn_audit_session_dispatch |
| session_review_worker | gn_audit_session_review_worker |
| verify_diff | gn_verify_diff |
| test_gap | gn_test_gap |
| worker_scope_review | gn_worker_scope_review |
| logic | gn_audit_logic |
| trace_boundary | gn_trace_boundary |
| resource_trace | gn_resource_trace |
| path_verify | gn_path_verify |
| test_suggestions | gn_test_suggestions |
| extract_fsm | gn_extract_fsm |
| error_topology | gn_error_topology |
| concurrency | gn_concurrency_audit |
| pressure | gn_pressure_impact |
| taint | gn_taint_trace |
| abi | gn_abi_diff |
| simulate_fault | gn_simulate_fault |

## Per-family metadata and lifecycle disposition

| Route family | Identity/errors/cache | Lifecycle and test/task attribution |
| --- | --- | --- |
| Each relationship method | Snapshot in ReadRequestContext; TargetContext/graphAuthority schemas hold repository/base/digest/generation/coverage. Per-handler serialized presence unproven. Internal typed failures exist; public formatter drops code/retry. Semantic shaping keys unproven. | withPinnedOverlay finally owns pin release; public SDK cancellation unproven. calltool-dispatch.test.ts; ADW-5/5a/5b/6b |
| query | Same generic preparation fields; lexical coverage located, vector/neighborhood unavailable. Per-mode provenance and cache identity unproven. | workspace-graph-search.test.ts; ADW-4a/5d/5e |
| repomap | Same context; per-result generation/coverage serialization and cache identity unproven. | calltool-dispatch.test.ts; ADW-5/5a |
| Group query | Member query policy; per-member base/digest/generation/coverage and mixed-state output unproven. Atomic group snapshot unsupported by evidence. | Dedicated mixed-member fixture/task unmapped; IQ-9 must assign |
| Group context | Member relationship policy; per-member identity and mixed-state provenance unproven. | Dedicated fixture/task unmapped; IQ-9 must assign |
| Group impact | Member relationship policy; per-member identity and mixed-state provenance unproven. | Dedicated fixture/task unmapped; IQ-9 must assign |
| Each facade mapping | Inherits the actual backend owner, not support inferred from facade name. Handler-specific serialized fields/caches unproven. | facade dispatch and calltool-dispatch tests; ADW-5/6b |
| Lazy supers and audit aliases | Repository identity and committed notice; workspace base/digest/generation/coverage and handler cache identity unproven. | SDK pin/cancellation parity unproven; ADW-5f |
| Each resource URI | Existing committed/metadata handler; per-resource workspace identity and cache-generation binding unproven. | Resource parity and SDK cancellation fixtures unmapped; ADW-5g |
| Byte response_cursor | Tool+args excluding cursor hash; stored resultHash/expiry/identity supports immutable replay under both flags. | response-pages.test.ts; ADW-5c/5h/5i; replay is not evidence of preparation cancellation |
| Logical/docs cursors | Cross-edit generation binding, shaping keys and expiry unproven by byte-pagination tests. | Dedicated cursor qualification/task unmapped; IQ-9 decision |
| Diagnosis/history/mutation exclusions | Existing guards; complete public phase/privacy/workspace identity fields unproven. | Complete phase/privacy fixture unmapped; ADW-6c/7c candidates |

Missing runtime proof remains explicitly unproven. Missing inventory enumeration
remains a documentation gap, and canonical adjudication must distinguish the two.

## Verified lazy graph membership

Source server.ts GRAPH_BACKED_SUPER_TOOLS: `gn_explore`, `gn_explain_module`, `gn_find_related`, `gn_graph_walk`, `gn_safe_edit_check`, `gn_can_delete`, `gn_pre_commit_audit`, `gn_safe_refactor`, `gn_diff_impact`, `gn_review_diff`, `gn_propose_location`, `gn_docs`. Each follows the existing initialization and committed notice branch. Per-super workspace generation and SDK parity remain unproven.

## Boundary correction validation

Public workspace code/retryable serialization and SDK signal propagation were repaired in existing owners. A serial focused run passed 351 tests across eight files; native offline build passed. These are bounded boundary/lifecycle results, not route-wide SDK or performance qualification.
