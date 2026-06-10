# ADR 0018: MCP Audit Trust Contract and Customer Readiness Gates

Status: Implemented (core contract; compatibility migration ongoing)

## Context

Customer-development audits against the `axel` codebase validated OntoIndex' core value: discovery, related-symbol navigation, module distillation, diff impact, cycle detection, and audit session concepts materially reduce senior-engineer audit time. The same sessions also exposed the reliability gap that would prevent teams from treating OntoIndex as an audit source of truth.

The repeated customer complaints were not about one missing graph query. They were about trust:

- A stale graph could still produce convincing audit output.
- `gn_help`, MCP discovery, and actual callable tools could disagree.
- `impact` and `gn_safe_edit_check` could report inconsistent blast-radius counts for the same symbol.
- Systems-audit tools could accept inputs that they could not actually verify.
- Semantic search and enrichment degraded when embeddings or sidecars were unavailable, but result surfaces did not always make the degradation obvious.
- Audit reports still required prompt discipline to enforce freshness, fix-history lookup, duplicate detection, runtime gating, and scope review.
- Large reports lacked pagination, CI export shape, and per-repo policy controls.

ADR 0016 defines the Resource Lifecycle Graph and Systems Auditor overlay. ADR 0017 defines the Audit Lifecycle layer for findings, status transitions, tombstones, dedupe, bundles, and dispatch. This ADR defines the product-facing trust contract that all MCP/frontier tools must obey before OntoIndex can be positioned as a reliable audit manager.

## Challenge Review

The unsafe version of this proposal is to add more top-level `gn_*` tools while leaving evidence semantics optional. That would increase demo surface but reduce customer trust. The hard constraints are:

1. **Freshness is binary for audit status.** If a tool cannot prove that evidence was checked against the target HEAD, it must not produce `OPEN` implementation work.
2. **Tool inventory must be honest.** A function advertised by `gn_help` but not callable through MCP is worse than no function; agents plan around phantom capabilities.
3. **Readiness is part of the answer.** Missing embeddings, missing LSP servers, unavailable sidecars, stale indexes, dirty worktrees, and vendor-heavy results must be visible in every high-level audit/discovery response.
4. **Shared measurements must come from one kernel.** Impact counts, risk levels, changed-symbol detection, and test-gap claims cannot be recomputed differently by sibling tools.
5. **Analyzer confidence is not user trust.** A high-confidence heuristic is still not proof if it lacks positive evidence, negative evidence, verifier capability, and freshness metadata.
6. **Managers need default workflows.** Lower-level tools are useful, but audit customers need one manager loop that refuses stale findings, unverified bundles, and out-of-scope worker patches.
7. **Large-output behavior is product behavior.** Persisting a huge report to a temp file without cursor/pagination makes MCP sessions harder to control and review.

### 6. `Expert-Verified Fact Flagging` (High-Trust Edges)
- **Capability:** A native graph property `isExpertVerified: boolean` for edges and nodes in KuzuDB.
- **Enforcement:** Facts marked as `ExpertVerified` are treated as immutable "Truth" by sub-agents. Any code change that contradicts a verified fact triggers a `HIGH` severity architectural violation.
- **Native Surface:** KuzuDB schema update for `CodeRelation` and `SymbolNode`.

### 7. `MultiModelEnsembleVoter` (Consensus Classification)
- **Capability:** A classification gate that requires agreement from multiple independent lanes (e.g., Lexical BM25, Structural PPR, and Label Diffusion) before assigning a high-confidence "Audit Finding."
- **Purpose:** Reduce false positives in automated systems audits by enforcing diagnostic rigor and consensus before action.

## Decision

Introduce an MCP Audit Trust Contract that every audit, impact, systems-audit, and worker-governance tool must implement.

The contract has five required layers:

1. **Target context:** every high-level tool resolves and reports the repository, target ref, target HEAD, current HEAD, indexed HEAD, worktree dirty state, graph index id, quality mode, embeddings status, LSP readiness, sidecar readiness, and policy profile.
2. **Tool contract:** `gn_help`, MCP discovery, CLI help, and callable tool registration must be generated from a single registry, including availability, capability flags, fallback tools, and deprecation state.
3. **Freshness gate:** stale target/index state blocks audit statuses that imply action. Tools may return context, candidates, and `NEEDS-REVERIFY`, but not dispatchable `OPEN` findings.
4. **Evidence envelope:** every finding or status transition that can drive work must include positive evidence, negative evidence when relevant, provenance, verifier capability, confidence reason codes, and freshness. Impact and discovery tools must include provenance, limits, and freshness, but do not need negative evidence unless they classify audit status.
5. **Governed manager loop:** the default audit path is session start, verify, dedupe, bundle, dispatch, scope review, and redo failed bundles. Lower-level tools remain escape hatches.

This ADR does not replace ADR 0016 or ADR 0017. It constrains their public MCP behavior and acceptance criteria. It is also not a single all-or-nothing release. The rollout is phased:

```text
P0 trust blockers
  fix known wrong answers, shared target context, single tool registry, freshness gate,
  help usability, impact-count consistency

P1 migration hardening
  capability-aware envelope, policy/vendor filtering, dirty-worktree snapshots,
  summary/pagination, backward-compatible response migration

P2 audit operations
  manager-level session APIs, write-through verification, test-gap evidence,
  SARIF/JUnit/JSON CI export
```

## Implementation Status

Implemented for the core public contract. The codebase now has shared target/freshness policy,
single registry-backed tool contracts, capability-aware response metadata, `gn_tool_contract`,
`gn_verify_diff`, worker scope review, audit lifecycle wrappers, and CI export paths. Some surfaces
retain legacy response compatibility while clients migrate to the newer envelopes.

## Algorithm/Technique

### 1. Target context contract

Add a shared target context resolver:

```text
ontoindex/src/mcp/shared/target-context.ts
```

Canonical shape:

```json
{
  "repo": "/home/er77/_wrk/axel",
  "repoKey": "axel",
  "branch": "main",
  "targetRef": "HEAD",
  "targetHead": "43d369bb1b90",
  "currentHead": "43d369bb1b90",
  "indexedHead": "3d0827595baf",
  "graphIndexId": "idx:3d082759:schema:...",
  "dirtyWorktree": true,
  "snapshotMode": "committed-head | dirty-worktree-overlay | diff-ref",
  "diffRef": null,
  "changedSinceIndex": ["wsd/SidecarManager.cpp"],
  "qualityMode": "balanced",
  "embeddings": {
    "status": "missing",
    "populated": false
  },
  "lsp": {
    "typescript": false,
    "python": false,
    "rust": true
  },
  "sidecars": {
    "systemsAudit": "available",
    "enrichment": "missing-store"
  },
  "policy": {
    "profile": "default",
    "ignoreGlobs": [],
    "riskThresholds": {}
  }
}
```

All of these tools must include target context or a compact context hash plus expandable diagnostics when the result depends on a repository:

- `gn_diagnose`
- `gn_explore`
- `gn_find_related`
- `gn_explain_module`
- `impact`
- `gn_safe_edit_check`
- `gn_diff_impact`
- `gn_pre_commit_audit`
- `gn_audit_*`
- systems-audit tools from ADR 0016
- dispatch and scope-review tools from ADR 0017

`gn_help` is global by default and must not require repo selection. If the caller supplies a repo, `gn_help` may add repo-specific readiness diagnostics, but help must still work when no repo is selected or multiple repositories are indexed.

If `targetHead != indexedHead`, action-producing audit tools must return `STALE_INDEX_ERROR` or downgrade candidate statuses to `NEEDS-REVERIFY`.

Dirty worktree audits require explicit evidence source labeling. A finding may be verified against:

```text
committed-head
  source and graph both correspond to targetHead

dirty-worktree-overlay
  graph corresponds to indexedHead, but source evidence is read from the filesystem diff;
  status may be actionable only when changed files and symbols are included in the session snapshot

diff-ref
  evidence is verified against a named diff base and current working tree or commit
```

Tools must say whether evidence came from the graph, filesystem, git object database, sidecar, or runtime artefact. A stale graph plus fresh filesystem read can support source-level evidence, but graph-derived impact and reachability must remain marked stale or partial.

### 2. Single tool registry

Create one registry for public tool metadata:

```text
ontoindex/src/mcp/shared/tool-registry.ts
```

Each tool record includes:

```text
name
namespace
aliases[]
status: callable | unavailable | deprecated | experimental
registered: boolean
reason
fallback
inputSchemaVersion
outputSchemaVersion
capabilities[]
requiresFreshIndex: boolean
requiresEmbeddings: boolean
requiresLsp[]
requiresSidecars[]
minimumQualityMode
```

`gn_help`, `gn_tool_contract`, MCP tool registration, CLI help, and docs must read this registry. A tool must not appear as usable unless `registered: true` and `status: callable`.

Unknown-tool failures should become preflight warnings:

```json
{
  "tool": "gn_resource_trace",
  "status": "unavailable",
  "reason": "not registered in this MCP server",
  "fallback": "gn_audit_logic({category:'resource-leaks'}) plus source verification"
}
```

### 3. Freshness gate policy

Add shared policy evaluation:

```text
ontoindex/src/mcp/shared/freshness-policy.ts
```

Modes:

```text
strict
  stale index blocks action-producing statuses and dispatch prompts

advisory
  stale index returns warnings and downgrades OPEN to NEEDS-REVERIFY

explicit-stale
  user opts into stale analysis; output must be marked non-dispatchable
```

Status behavior:

```text
fresh target evidence -> OPEN is allowed
stale index -> NEEDS-REVERIFY, never OPEN
missing verifier -> NEEDS-VERIFY
runtime-only without artefact -> HOLD
tombstone match with invariant holding -> RESOLVED-ALREADY
tombstone match with changed invariant surface -> NEEDS-REVERIFY
```

The freshness gate applies before bundling, dispatch prompts, scope guards, CI lint, and any tool that labels work as ready.

MCP tools must not auto-run broad reindexing as part of freshness enforcement. Incremental sync or analyze may be suggested, but must be explicit, bounded, and resource-capped by repository policy and agent instructions.

### 4. Shared impact and change kernel

Refactor `impact`, `gn_safe_edit_check`, `gn_diff_impact`, `gn_pre_commit_audit`, `gn_scope_guard`, and future `gn_verify_diff` to consume one shared impact kernel:

```text
ontoindex/src/core/impact/impact-kernel.ts
```

The kernel returns:

```text
targetSymbol
resolvedUid
directUpstreamCount
directDownstreamCount
transitiveUpstreamCount
transitiveDownstreamCount
affectedFiles[]
affectedTests[]
riskLevel
riskReasons[]
confidence
limits
```

Sibling tools may add policy interpretation, but they must not recompute core counts with incompatible traversal defaults. If a tool reports a different number, it must explain the filter difference:

```text
countScope: direct | transitive | exported-api | diff-only | policy-filtered
```

Acceptance gate:

- For the same resolved UID, graph snapshot, direction, traversal depth, relationship set, and filters, `impact` and `gn_safe_edit_check` must agree on raw counts.
- Risk verdicts must cite count scope and non-count policy reasons separately.
- Forward declarations must rank below definitions during symbol disambiguation.

### 5. Capability-aware result envelopes

High-level MCP responses must migrate to a shared envelope:

```json
{
  "envelopeVersion": "1",
  "tool": "gn_audit_verify",
  "version": "1",
  "status": "ok",
  "targetContext": {},
  "capabilitiesUsed": ["symbol-graph", "git-history"],
  "capabilitiesMissing": ["embeddings", "typescript-lsp"],
  "freshness": {
    "status": "stale",
    "actionable": false,
    "reason": "indexedHead != targetHead"
  },
  "results": [],
  "evidence": [],
  "warnings": [],
  "limits": {
    "truncated": false,
    "cursor": null,
    "persistedPath": null
  },
  "nextTools": []
}
```

Rules:

- The envelope is opt-in during P1, default-on in the next minor release, and legacy response shapes remain available behind `legacyResponse: true` until the following major release.
- Tests and clients must assert both the envelope metadata and the legacy compatibility path during migration.
- Missing embeddings must be reported when semantic search falls back to lexical/graph search.
- Missing LSP must be reported when type-aware claims are downgraded.
- Sidecar `unavailable` metadata should be hidden from routine output unless it changes result quality or the caller asks for diagnostics.
- Results over the configured size limit must provide cursor pagination, not only an out-of-band temp file.
- Support `summary: true` / `minimal: true` on verbose tools.

### 6. Repository policy and vendor filtering

Add repo policy:

```text
.ontoindex/policy.json
```

Initial fields:

```json
{
  "schemaVersion": 1,
  "ignoreGlobs": [
    "browser/js/Autolinker.js",
    "vendor/**",
    "third_party/**",
    "dist/**"
  ],
  "generatedGlobs": [],
  "riskThresholds": {},
  "owners": {},
  "audit": {
    "freshnessMode": "strict",
    "maxFindingsPerCategory": 25,
    "runtimeClaimsRequireEvidence": true
  }
}
```

Policy precedence:

```text
CLI/tool args > session policy > repo .ontoindex/policy.json > user defaults > built-in defaults
```

Dead-code, cycles, audit risk, semantic search, and systems-audit tools must report whether vendor/generated filters were applied. Because vendor filters can hide real vulnerabilities, reports must include excluded path counts, representative excluded paths, and an explicit override such as `includeIgnored: true`.

### 7. Audit manager APIs

Implement manager-level workflow wrappers over ADR 0017:

```text
gn_audit_session_start({ repo, targetRef, sourcePath?, pastedText?, strictFresh: true })
gn_audit_session_verify({ sessionId, proofMode })
gn_audit_session_dedupe({ sessionId, strategy: "root-cause" })
gn_audit_session_bundle({ sessionId, maxLoc, maxFiles, parallelism })
gn_audit_session_dispatch({ sessionId, bundleId })
gn_audit_session_review_worker({ sessionId, bundleId, changedFiles, changedSymbols, executedTests })
```

These are orchestration wrappers over the ADR 0017 event store, finding verifier, dedupe, bundle, dispatch, and scope-guard primitives. They must not create a second audit state machine or store conflicting status semantics.

The manager loop is the recommended public path. It must:

- lock target context
- reject stale `OPEN`
- run fix-history checks before repeating old findings
- enforce tombstones
- collapse duplicates before bundling
- block implementation prompts for `NEEDS-VERIFY`, `NEEDS-REVERIFY`, `HOLD`, and duplicate-only children
- require bundle conflict checks before parallel dispatch
- run scope guard and required test checks after worker edits

### 8. Systems-audit readiness gates

Systems-audit tools from ADR 0016 must advertise verifier capability and limitations:

```text
proofMode: heuristic | path-sensitive | resource-ledger | runtime-required
supportedLanguages[]
supportedPatterns[]
unsupportedPatterns[]
falsePositiveRisks[]
```

Specific acceptance fixes from customer reports:

- `gn_resource_trace` must accept repo-relative and absolute paths without path mangling.
- Path/source parameters must either be consumed or rejected with a schema error.
- Concurrency audit must not treat `weak_ptr::lock()` as mutex acquisition without type evidence.
- Dead-code reports must not mark a symbol `unreached` when verified incoming references exist.
- Disambiguation must rank definitions above forward declarations.
- Runtime-only claims must return `HOLD` unless runtime evidence is attached.

### 9. Write-through verification

Add post-edit verification tools:

```text
gn_verify_diff({ expectedSymbols, expectedFiles, expectedTests, diffRef })
gn_test_gap({ diffRef, changedSymbols? })
gn_worker_scope_review({ bundleId, commit?, changedFiles?, changedSymbols?, executedTests? })
```

`gn_verify_diff` replaces any missing or stale `detect_changes` promise. It compares expected scope with actual changed files, changed symbols, impacted symbols, and tests.

`gn_test_gap` reports changed production symbols with no linked tests or executed test evidence. Filename heuristics can seed candidates but must be labeled as heuristic until JUnit/coverage/test-index data is ingested.

### 10. CI and export formats

Add export schemas:

```text
ontoindex audit lint --format json
ontoindex audit lint --format sarif
ontoindex audit lint --format junit
ontoindex audit verify --session ... --format json
ontoindex impact --target ... --format json
```

CI gates start advisory:

- stale `OPEN` findings
- duplicate root-cause findings dispatched separately
- runtime-only claims marked `OPEN` without runtime artefacts
- dispatch prompts with placeholders
- worker changes outside bundle scope
- changed symbols with no test plan

Blocking gates may be enabled per repo policy after the team has baseline metrics.

### 11. Implementation order

P0:

1. Fix known wrong-answer bugs from customer reports: resource path mangling, concurrency false positive, dead-code confidence semantics, definition ranking, and refactor/schema alias drift.
2. Make `gn_help` global by default and repo diagnostics optional.
3. Add shared target context resolver.
4. Add single tool registry and make `gn_help`/MCP registration consume it.
5. Add freshness gate policy and wire it into audit/session tools.
6. Reconcile `impact` and `gn_safe_edit_check` through a shared impact kernel.

P1:

7. Add committed-head, dirty-worktree-overlay, and diff-ref evidence snapshot modes.
8. Add capability-aware response envelope with legacy compatibility.
9. Add missing-capability warnings for embeddings, LSP, and sidecars.
10. Add `.ontoindex/policy.json` support, precedence rules, and vendor/generated filtering.
11. Add pagination/cursor support and minimal/summary modes.

P2:

12. Add manager-level audit session APIs as wrappers over ADR 0017.
13. Add `gn_verify_diff`, `gn_test_gap`, and worker scope review.
14. Add SARIF/JUnit/JSON export.

## Consequences

### Positive

- Agents and humans get one consistent answer about target freshness, tool availability, and capability readiness.
- Stale graph output cannot silently become implementation work.
- Audit reports become safer because lifecycle rules are enforced in tools, not only in prompts.
- Impact and safe-edit verdicts become explainable and consistent.
- Missing embeddings, LSPs, sidecars, and vendor filters are visible product states instead of hidden degradation.
- CI integration becomes possible through stable JSON/SARIF/JUnit outputs.

### Negative

- Adding a shared target context and tool registry touches many MCP surfaces.
- Some previously permissive tools will become stricter and may return fewer `OPEN` findings.
- Existing tests that assert raw response shapes will need migration to the common envelope.
- The policy layer creates another configuration surface that must be documented and versioned.
- Strict freshness can slow audit workflows until incremental indexing improves.
- The envelope migration is a breaking surface unless legacy response compatibility is maintained through at least one release cycle.

### Guardrails

- Do not add more public audit tools until the registry can prove they are callable and capability-gated.
- Do not let stale index output produce dispatchable work.
- Do not require repo selection for global help.
- Do not auto-run broad analyze or reindex work from MCP freshness checks.
- Do not treat dirty-worktree evidence as graph-fresh unless the changed files and symbols are included in the session snapshot.
- Do not hide missing embeddings, LSPs, or sidecars when they affect result quality.
- Do not recompute blast-radius counts independently across sibling tools.
- Do not mark runtime-only claims `OPEN` without runtime evidence.
- Do not treat heuristic test coverage as executed test evidence.
- Do not persist huge MCP output only out-of-band; provide cursor pagination or summary mode.
- Do not use prompt discipline as the only enforcement mechanism for audit lifecycle rules.
