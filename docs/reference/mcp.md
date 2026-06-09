# OntoIndex MCP Reference

This file documents the current OntoIndex MCP surface from the codebase:

- Facade tools: `ontoindex/src/mcp/facade/tool-definitions.ts`
- Super-functions: `ontoindex/src/mcp/super/tool-definitions.ts`
- Legacy/internal handlers: `ontoindex/src/mcp/tools.ts`

The recommended public frontier is the 8 action-dispatched facade tools plus the 53 `gn_*` super-functions. Older internal handlers such as `query`, `context`, `impact`, `rename`, and `repomap` still exist in code and are used by facade dispatch, but new agents should prefer the facade and `gn_*` surface unless a client explicitly exposes the legacy names.

All examples below use this repository as the target:

```json
{ "repo": "OntoIndex" }
```

Return examples are abbreviated representative shapes, not full responses.

## Frontier 1: Facade Tools

Use these when the client prefers a small stable tool list. Each facade has an `action` field that routes to a narrower implementation.

### `discover`

- **Use for:** Discovering indexed repos, routes, tools, analysis packs, groups, or sync status.
- **Call:**

```json
{ "action": "repos" }
```

- **Returns:**

```json
{
  "repos": [{ "name": "OntoIndex", "path": "/opt/demodb/_workfolder/OntoIndex" }]
}
```

- **Why use it:** First call in an unfamiliar MCP session; confirms which repo names can be passed to other tools.

### `search`

- **Use for:** Semantic search, raw Cypher, or graph-ranked repomap context.
- **Call:**

```json
{
  "action": "semantic",
  "repo": "OntoIndex",
  "query": "MCP tool dispatch",
  "limit": 3,
  "include_skeleton": true
}
```

- **Returns:**

```json
{
  "processes": [{ "summary": "MCP Server Tool Dispatch", "symbol_count": 5 }],
  "process_symbols": [{ "name": "createMCPServer", "filePath": "ontoindex/src/mcp/server.ts" }]
}
```

- **Why use it:** Use when you know the concept but not the exact symbol or file.

### `inspect`

- **Use for:** Symbol context, evidence packs, API shape checks, and IPC traces.
- **Call:**

```json
{
  "action": "context",
  "repo": "OntoIndex",
  "target": "createMCPServer",
  "include_content": false
}
```

- **Returns:**

```json
{
  "symbol": { "name": "createMCPServer", "kind": "Function", "filePath": "ontoindex/src/mcp/server.ts" },
  "incoming": { "calls": [] },
  "outgoing": { "calls": ["dispatchLazySuper"] }
}
```

- **Why use it:** Use after search to understand callers, callees, file location, and process membership for one symbol.

### `impact`

- **Use for:** Symbol, batch, route, or diff impact analysis.
- **Call:**

```json
{
  "action": "symbol",
  "repo": "OntoIndex",
  "target": "createMCPServer",
  "direction": "upstream",
  "maxDepth": 2
}
```

- **Returns:**

```json
{
  "target": "createMCPServer",
  "risk": "LOW",
  "direct_callers": ["startMCPServer"],
  "affected_processes": ["MCP startup"]
}
```

- **Why use it:** Run before changing a function, class, method, route, or diff surface.

### `audit`

- **Use for:** Architecture reports, dead-code checks, lifecycle audit actions, and systems-audit checks.
- **Call:**

```json
{
  "action": "dead_code",
  "repo": "OntoIndex",
  "limit": 20
}
```

- **Returns:**

```json
{
  "summary": { "unreached": 12, "exported_uncalled": 7 },
  "findings": [{ "symbol": "legacyHelper", "confidence": "medium" }]
}
```

- **Why use it:** Use when you want a broad audit category but do not need the dedicated `gn_*` workflow.

### `refactor`

- **Use for:** Safe rename, body replacement, or sandboxed refactoring through one dispatcher.
- **Call:**

```json
{
  "action": "rename",
  "repo": "OntoIndex",
  "target": "classifyIntent",
  "new_name": "classifySearchIntent",
  "dry_run": true
}
```

- **Returns:**

```json
{
  "success": true,
  "dry_run": true,
  "files_affected": 3,
  "edits": [{ "filePath": "ontoindex/src/core/search/intent-classifier.ts" }]
}
```

- **Why use it:** Use for clients that expose only facades; otherwise prefer `gn_safe_refactor`.

### `manage`

- **Use for:** MCP session state and route-map management.
- **Call:**

```json
{ "action": "route_map" }
```

- **Returns:**

```json
{
  "routes": [{ "facade": "search", "actions": ["semantic", "cypher", "repomap"] }]
}
```

- **Why use it:** Useful for agents that need to introspect how facade actions route internally.

### `docs`

- **Use for:** Documentation trace, drift, context, and readiness reports.
- **Call:**

```json
{
  "action": "readiness",
  "repo": "OntoIndex",
  "summary": true,
  "maxItems": 10
}
```

- **Returns:**

```json
{
  "status": "ready",
  "freshness": { "stale": false },
  "warnings": []
}
```

- **Why use it:** Use when documentation requirements, API docs, or advisory memories must be kept separate from code evidence.

## Frontier 2: Discovery And Exploration Super-Functions

### `gn_explore`

- **Use for:** Concept-level discovery.
- **Call:**

```json
{ "repo": "OntoIndex", "query": "MCP server tool registration", "depth": "balanced" }
```

- **Returns:**

```json
{
  "topProcesses": [{ "name": "MCP startup" }],
  "topSymbols": [{ "name": "createMCPServer", "filePath": "ontoindex/src/mcp/server.ts" }],
  "suggestedEntryPoints": ["ontoindex/src/mcp/server.ts"]
}
```

- **Why use it:** Best first call before reading files; it gives processes, symbols, clusters, and entry points together.

### `gn_explain_module`

- **Use for:** File-level overview.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "filePath": "ontoindex/src/mcp/server.ts",
  "includeSkeleton": true
}
```

- **Returns:**

```json
{
  "filePath": "ontoindex/src/mcp/server.ts",
  "exports": ["createMCPServer", "startMCPServer"],
  "cluster": "MCP Server",
  "coChangedFiles": ["ontoindex/src/mcp/facade/dispatch.ts"]
}
```

- **Why use it:** Use before editing a file to understand its API, cluster, and neighboring files.

### `gn_find_related`

- **Use for:** Symbol neighborhood.
- **Call:**

```json
{ "repo": "OntoIndex", "symbol": "dispatchLazySuper", "maxItemsPerCategory": 5 }
```

- **Returns:**

```json
{
  "callers": ["createMCPServer"],
  "callees": ["handleGnExplore", "handleGnDiagnose"],
  "clusterSiblings": ["getNextStepHint"]
}
```

- **Why use it:** Use when you know one symbol and need callers, callees, co-change partners, and nearby cluster members.

### `gn_help`

- **Use for:** Tool discovery and recommended workflows.
- **Call:**

```json
{ "repo": "OntoIndex", "intent": "release", "topic": "overview" }
```

- **Returns:**

```json
{
  "recommendedFirstCalls": ["gn_diagnose", "gn_pre_commit_audit"],
  "tools": [{ "name": "gn_verify_diff", "stability": "stable" }]
}
```

- **Why use it:** Use when an agent is unsure which OntoIndex tool to call next.

### `gn_diagnose`

- **Use for:** MCP health and readiness checks.
- **Call:**

```json
{ "repo": "OntoIndex", "checkEmbeddings": true, "checkLsp": true }
```

- **Returns:**

```json
{
  "status": "ok",
  "indexFreshness": { "stale": false },
  "embeddings": { "available": true },
  "recommendations": []
}
```

- **Why use it:** Run at session start or when search quality looks wrong.

### `gn_quality_mode`

- **Use for:** Switching search quality presets.
- **Call:**

```json
{ "level": "thorough", "duration": "session" }
```

- **Returns:**

```json
{
  "level": "thorough",
  "enabled": ["ONTOINDEX_INTENT_ENSEMBLE", "ONTOINDEX_CITATIONS", "ONTOINDEX_LSP_REFERENCES"]
}
```

- **Why use it:** Use when moving from fast exploration to high-confidence review/refactor work.

### `gn_propose_location`

- **Use for:** Finding where new code belongs.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "intent": "add a new MCP docs readiness helper",
  "language": "typescript"
}
```

- **Returns:**

```json
{
  "candidates": [
    {
      "directory": "ontoindex/src/mcp/super",
      "suggestedFile": "docs-readiness-helper.ts",
      "rationale": "near existing docs super-functions"
    }
  ]
}
```

- **Why use it:** Use before creating files so new code follows the existing module layout.

### `gn_tool_contract`

- **Use for:** MCP tool contract/schema validation.
- **Call:**

```json
{ "repo": "OntoIndex", "toolName": "gn_docs" }
```

- **Returns:**

```json
{
  "toolName": "gn_docs",
  "registered": true,
  "schemaStatus": "valid"
}
```

- **Why use it:** Use when changing MCP schemas, generated docs, or facade routing.

### `gn_graph_walk`

- **Use for:** Stateful graph traversal from a seed symbol.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "action": "start",
  "seedSymbol": "createMCPServer",
  "navigationPolicy": "follow-calls",
  "maxSteps": 5
}
```

- **Returns:**

```json
{
  "walkId": "walk_123",
  "current": "createMCPServer",
  "frontier": ["dispatchLazySuper", "getNextStepHint"]
}
```

- **Why use it:** Use for controlled multi-step exploration when a single context response is too flat.

## Frontier 3: Safety And Refactoring Super-Functions

### `gn_safe_edit_check`

- **Use for:** Pre-edit risk synthesis.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "symbol": "classifyIntent",
  "intent": "modify-body",
  "docsEvidence": true
}
```

- **Returns:**

```json
{
  "verdict": "CAUTION",
  "risk": "MEDIUM",
  "directCallers": ["query"],
  "recommendedNextTools": ["gn_find_related", "gn_verify_diff"]
}
```

- **Why use it:** Required before changing a symbol when you need blast radius and risk in one response.

### `gn_can_delete`

- **Use for:** Delete safety checks.
- **Call:**

```json
{ "repo": "OntoIndex", "symbol": "legacyRouteHelper", "includeCrossRepo": false }
```

- **Returns:**

```json
{
  "verdict": "DO-NOT-DELETE",
  "callers": ["route"],
  "testImports": ["route.test.ts"]
}
```

- **Why use it:** Use before removing apparently dead code; it checks references and co-change signals.

### `gn_safe_refactor`

- **Use for:** Safe rename, body modification, extract, move, and related refactors.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "intent": "rename",
  "symbol": "classifyIntent",
  "params": { "newName": "classifySearchIntent" },
  "dryRun": true
}
```

- **Returns:**

```json
{
  "dryRun": true,
  "preCheck": { "verdict": "CAUTION" },
  "preview": { "filesAffected": 3, "edits": 8 }
}
```

- **Why use it:** Preferred write dispatcher because it wraps pre-checks and post-write verification guidance.

### `gn_ensure_fresh`

- **Use for:** Index freshness lifecycle.
- **Call:**

```json
{ "repo": "OntoIndex", "withEmbeddings": true, "autoAnalyze": false }
```

- **Returns:**

```json
{
  "fresh": true,
  "indexedHead": "64d357d",
  "currentHead": "64d357d",
  "embeddings": { "present": true }
}
```

- **Why use it:** Use before long work to avoid acting on stale graph evidence.

### `gn_verify_diff`

- **Use for:** Post-edit diff verification.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "scope": "all",
  "expectedFiles": ["README.md", "ontoindex/package.json"],
  "executedTests": ["npm run build"]
}
```

- **Returns:**

```json
{
  "status": "ok",
  "unexpectedFiles": [],
  "missingTests": []
}
```

- **Why use it:** Use after edits to compare intended files/symbols/tests against actual diff evidence.

### `gn_test_gap`

- **Use for:** Missing test evidence after edits.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "scope": "all",
  "executedTests": ["npm run test:unit"]
}
```

- **Returns:**

```json
{
  "status": "covered",
  "changedProductionSymbolsWithoutTests": []
}
```

- **Why use it:** Use before commit to avoid shipping code changes with no test evidence.

### `gn_worker_scope_review`

- **Use for:** Reviewing delegated worker/sub-agent changes.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "session": "audit-2026-06-release",
  "bundleId": "B-MCP-DOCS",
  "changedFiles": ["docs/reference/mcp.md"],
  "executedTests": ["npx prettier --check docs/reference/mcp.md"]
}
```

- **Returns:**

```json
{
  "verdict": "ACCEPT",
  "scopeMatchesBundle": true,
  "missingRequiredTests": []
}
```

- **Why use it:** Use when a manager agent needs to validate sub-agent scope and evidence.

### `gn_scope_guard`

- **Use for:** Bundle scope guard before/after implementation.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "session": "audit-2026-06-release",
  "bundleId": "B-README",
  "changedFiles": ["README.md"],
  "persist": true
}
```

- **Returns:**

```json
{
  "verdict": "IN_SCOPE",
  "overlaps": [],
  "eventPersisted": true
}
```

- **Why use it:** Use to prevent a worker from modifying files outside its assigned bundle.

### `gn_bundle_conflicts`

- **Use for:** Detecting conflicting audit bundles before parallel work.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "session": "audit-2026-06-release",
  "strategy": "write-set",
  "maxConflicts": 20
}
```

- **Returns:**

```json
{
  "conflicts": [{ "bundleA": "B-README", "bundleB": "B-DOCS", "files": ["README.md"] }]
}
```

- **Why use it:** Use before dispatching sub-agents to avoid concurrent edits to the same files or symbols.

## Frontier 4: Review And Diff Super-Functions

### `gn_pre_commit_audit`

- **Use for:** Ship-readiness verdict for staged, unstaged, all, or branch diffs.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "scope": "all",
  "expectedSymbols": ["classifyIntent"],
  "docsEvidence": true
}
```

- **Returns:**

```json
{
  "verdict": "REVIEW",
  "changedFiles": [{ "path": "ontoindex/test/unit/intent-classifier.test.ts" }],
  "recommendations": ["review-unexpected-scope"]
}
```

- **Why use it:** Use before every commit to catch unexpected symbols and high-risk blast radius.

### `gn_diff_impact`

- **Use for:** PR blast-radius report.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "scope": "branch",
  "includeReviewers": true,
  "docsEvidence": false
}
```

- **Returns:**

```json
{
  "summary": { "changedSymbols": 12, "highRiskSymbols": 1 },
  "reviewers": ["maintainer@example.com"]
}
```

- **Why use it:** Use before opening a PR or merging a branch.

### `gn_review_diff`

- **Use for:** Machine-readable graph-aware diff review.
- **Call:**

```json
{ "repo": "OntoIndex", "scope": "staged" }
```

- **Returns:**

```json
{
  "version": 1,
  "capabilities": { "graph": "available" },
  "findings": [{ "severity": "warning", "path": "README.md" }]
}
```

- **Why use it:** Use when you need the same envelope contract as `ontoindex review diff --json`.

## Frontier 5: Docs Super-Functions

### `gn_docs`

- **Use for:** Docs readiness, trace, drift, and context with compact JSON or inline output.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "action": "context",
  "includeMemories": true,
  "format": "both",
  "maxItems": 10
}
```

- **Returns:**

```json
{
  "status": "ok",
  "items": [{ "kind": "requirement", "id": "REQ-MCP-TOOLS" }],
  "inlineContext": "Docs context: 10 items..."
}
```

- **Why use it:** Use for doc evidence without mixing advisory memory into authoritative audit evidence.

## Frontier 6: Audit Lifecycle Super-Functions

### `gn_audit_ingest`

- **Use for:** Importing an audit report into a session.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "session": "audit-2026-06-release",
  "reportPath": "docs/review-diff.md"
}
```

- **Returns:**

```json
{
  "session": "audit-2026-06-release",
  "findingsIngested": 8,
  "candidateBundles": 3
}
```

- **Why use it:** Use to turn human or agent audit output into trackable findings.

### `gn_audit_verify`

- **Use for:** Re-verifying audit findings against fresh code evidence.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release" }
```

- **Returns:**

```json
{
  "verified": 6,
  "rejected": 2,
  "needsHumanReview": 0
}
```

- **Why use it:** Use before bundling work so stale or false findings do not become implementation tasks.

### `gn_fix_history`

- **Use for:** Finding whether a finding or failure pattern was fixed before.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "query": "MCP stdout corruption"
}
```

- **Returns:**

```json
{
  "matches": [{ "commit": "abc123", "summary": "narrow stdout silencing scope" }]
}
```

- **Why use it:** Use when a defect may have prior art in commit history or audit logs.

### `gn_audit_bundle`

- **Use for:** Grouping verified findings into implementation bundles.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release", "strategy": "root-cause" }
```

- **Returns:**

```json
{
  "bundles": [{ "id": "B-001", "findings": ["F-1", "F-3"], "writeSet": ["ontoindex/src/mcp/server.ts"] }]
}
```

- **Why use it:** Use to create coherent work packets for humans or sub-agents.

### `gn_audit_lint`

- **Use for:** CI-style linting of audit findings and bundles.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release" }
```

- **Returns:**

```json
{
  "status": "pass",
  "errors": [],
  "warnings": []
}
```

- **Why use it:** Use before dispatch or commit to enforce audit hygiene.

### `gn_audit_logic`

- **Use for:** Checking audit finding logic and evidence consistency.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "session": "audit-2026-06-release",
  "findingId": "F-001"
}
```

- **Returns:**

```json
{
  "findingId": "F-001",
  "logicStatus": "coherent",
  "missingEvidence": []
}
```

- **Why use it:** Use to challenge weak findings before implementation starts.

### `gn_audit_dedupe`

- **Use for:** Merging duplicate audit findings.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release" }
```

- **Returns:**

```json
{
  "duplicates": [{ "canonical": "F-001", "merged": ["F-004"] }]
}
```

- **Why use it:** Use before bundling to avoid duplicate tasks.

### `gn_dispatch_prompt`

- **Use for:** Generating a worker/sub-agent prompt for a bundle.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "session": "audit-2026-06-release",
  "bundleId": "B-001"
}
```

- **Returns:**

```json
{
  "prompt": "Implement bundle B-001. Scope: ... Tests: ..."
}
```

- **Why use it:** Use when delegating implementation while preserving scope and validation requirements.

### `gn_audit_tombstone_create`

- **Use for:** Marking findings or branches as intentionally closed/obsolete.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "session": "audit-2026-06-release",
  "findingId": "F-009",
  "reason": "subsumed by release cleanup"
}
```

- **Returns:**

```json
{
  "tombstone": { "findingId": "F-009", "status": "created" }
}
```

- **Why use it:** Use to keep audit history honest when a task is intentionally abandoned.

### `gn_audit_session_start`

- **Use for:** Creating an audit lifecycle session.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release", "title": "Release readiness" }
```

- **Returns:**

```json
{
  "session": "audit-2026-06-release",
  "created": true
}
```

- **Why use it:** Use before a multi-step audit or manager/sub-agent workflow.

### `gn_audit_session_verify`

- **Use for:** Session-level finding verification.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release" }
```

- **Returns:**

```json
{
  "session": "audit-2026-06-release",
  "verifiedFindings": 6
}
```

- **Why use it:** Use to refresh evidence for all findings in a session.

### `gn_audit_session_dedupe`

- **Use for:** Session-level duplicate finding cleanup.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release" }
```

- **Returns:**

```json
{
  "session": "audit-2026-06-release",
  "duplicateGroups": 2
}
```

- **Why use it:** Use before session bundling.

### `gn_audit_session_bundle`

- **Use for:** Session-level bundle generation.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release", "strategy": "root-cause" }
```

- **Returns:**

```json
{
  "bundles": [{ "id": "B-README", "status": "ready" }]
}
```

- **Why use it:** Use when converting verified session findings into implementation work.

### `gn_audit_session_dispatch`

- **Use for:** Session-level dispatch prompt generation.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release", "bundleId": "B-README" }
```

- **Returns:**

```json
{
  "bundleId": "B-README",
  "dispatchPrompt": "You are assigned bundle B-README..."
}
```

- **Why use it:** Use when assigning bundles to workers.

### `gn_audit_session_review_worker`

- **Use for:** Reviewing worker output against a session bundle.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "session": "audit-2026-06-release",
  "bundleId": "B-README",
  "changedFiles": ["README.md"]
}
```

- **Returns:**

```json
{
  "verdict": "ACCEPT",
  "scopeViolations": []
}
```

- **Why use it:** Use after sub-agent implementation before merging worker output.

### `gn_audit_session_lock`

- **Use for:** Session/bundle locking.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release", "bundleId": "B-README" }
```

- **Returns:**

```json
{
  "lock": { "bundleId": "B-README", "owner": "current-agent", "status": "acquired" }
}
```

- **Why use it:** Use to prevent two workers from editing the same bundle concurrently.

### `gn_audit_pr_marker_scan`

- **Use for:** Scanning PR markers tied to audit findings or bundles.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release" }
```

- **Returns:**

```json
{
  "markers": [{ "bundleId": "B-README", "status": "found" }]
}
```

- **Why use it:** Use when audit state is encoded in PR descriptions or comments.

### `gn_audit_diff`

- **Use for:** Audit-aware diff summary.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release", "scope": "all" }
```

- **Returns:**

```json
{
  "changedFiles": ["README.md"],
  "relatedFindings": ["F-001"]
}
```

- **Why use it:** Use to connect implementation diffs back to audit findings.

### `gn_audit_replay`

- **Use for:** Replaying an audit session or event stream.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release" }
```

- **Returns:**

```json
{
  "eventsReplayed": 12,
  "finalState": "consistent"
}
```

- **Why use it:** Use to debug audit lifecycle state.

### `gn_audit_export`

- **Use for:** Exporting audit session findings.
- **Call:**

```json
{ "repo": "OntoIndex", "session": "audit-2026-06-release", "format": "json" }
```

- **Returns:**

```json
{
  "format": "json",
  "findingsExported": 6,
  "artifact": "audit-2026-06-release.json"
}
```

- **Why use it:** Use for CI artifacts, handoff, or external reporting.

## Frontier 7: Systems-Audit Super-Functions

### `gn_resource_trace`

- **Use for:** POSIX resource acquire/dup/handoff/release tracing.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "path": "ontoindex/test/fixtures/systems-audit/fork-failure.cpp",
  "maxRecords": 50
}
```

- **Returns:**

```json
{
  "resources": [{ "kind": "pid", "op": "acquire", "line": 12 }],
  "handoffs": []
}
```

- **Why use it:** Use for low-level resource lifecycle reviews.

### `gn_path_verify`

- **Use for:** Checking required/forbidden calls after a trigger branch.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "path": "ontoindex/test/fixtures/systems-audit/fork-failure.cpp",
  "when": "fork() < 0",
  "must": ["close"],
  "mustNot": ["exec"]
}
```

- **Returns:**

```json
{
  "verdict": "PASS",
  "evidence": [{ "line": 18, "matched": "close" }]
}
```

- **Why use it:** Use to verify error-path cleanup without full symbolic execution.

### `gn_test_suggestions`

- **Use for:** Generating focused tests for a finding or risk.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "symbol": "createMCPServer",
  "risk": "tool dispatch regression"
}
```

- **Returns:**

```json
{
  "suggestions": [
    {
      "testFile": "ontoindex/test/unit/mcp-server-lazy-loading.test.ts",
      "case": "dispatches registered facade tools"
    }
  ]
}
```

- **Why use it:** Use when an audit finding is real but the minimal regression test is unclear.

### `gn_trace_boundary`

- **Use for:** Resource boundary handoff tracing.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "resource": "fd",
  "start": "sender",
  "mechanism": "SCM_RIGHTS"
}
```

- **Returns:**

```json
{
  "paths": [{ "from": "sender", "to": "receiver", "mechanism": "SCM_RIGHTS" }]
}
```

- **Why use it:** Use when FD number equality is not enough to prove resource identity.

### `gn_extract_fsm`

- **Use for:** Extracting state machines from source text or files.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "path": "ontoindex/src/core/ingestion/enrichment/sidecar-analyzer-adapter.ts",
  "stateVariable": "state"
}
```

- **Returns:**

```json
{
  "states": ["idle", "running", "failed"],
  "transitions": [{ "from": "idle", "to": "running" }]
}
```

- **Why use it:** Use to audit lifecycle code and missing transition guards.

### `gn_error_topology`

- **Use for:** Error source/check/sink topology.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "path": "ontoindex/src/mcp/server.ts",
  "maxRecords": 50
}
```

- **Returns:**

```json
{
  "sources": [{ "kind": "exception", "line": 120 }],
  "sinks": [{ "kind": "stderr", "line": 500 }],
  "findings": []
}
```

- **Why use it:** Use to find swallowed errors, generic exits, and unchecked error flows.

### `gn_concurrency_audit`

- **Use for:** Lock and blocking-under-lock scans.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "path": "ontoindex/src/core/lbug/pool-adapter.ts",
  "maxFindings": 20
}
```

- **Returns:**

```json
{
  "locks": [{ "name": "poolLock", "scope": "function" }],
  "findings": [{ "severity": "warning", "reason": "blocking work under lock" }]
}
```

- **Why use it:** Use on pooling, worker, queue, or adapter code.

### `gn_pressure_impact`

- **Use for:** Quota and active-count side-effect modeling.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "path": "ontoindex/src/core/ingestion/workers/worker-pool.ts",
  "symbol": "parseFilesWithWorkerPool"
}
```

- **Returns:**

```json
{
  "constraints": [{ "name": "maxWorkers", "scope": "global" }],
  "warnings": [{ "kind": "global-side-effect" }]
}
```

- **Why use it:** Use before changing worker counts, pools, throttles, or global resource controls.

### `gn_taint_trace`

- **Use for:** Bounded source-to-sink taint heuristic.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "path": "ontoindex/src/server/api.ts",
  "source": "req.query",
  "sink": "executeQuery",
  "sanitizers": ["validateQuery"]
}
```

- **Returns:**

```json
{
  "paths": [{ "source": "req.query", "sink": "executeQuery", "sanitized": true }],
  "findings": []
}
```

- **Why use it:** Use for security review where untrusted input might reach a dangerous sink.

### `gn_abi_diff`

- **Use for:** Comparing native/JSON structs to TypeScript/JSON interfaces.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "sourcePath": "ontoindex-native/src/lib.rs",
  "targetPath": "ontoindex/src/native/import-extractor.ts",
  "sourceLanguage": "rust",
  "targetLanguage": "typescript"
}
```

- **Returns:**

```json
{
  "findings": [{ "field": "offset", "kind": "precision-risk" }],
  "status": "review"
}
```

- **Why use it:** Use when native payload shape and TypeScript consumer shape must stay aligned.

### `gn_simulate_fault`

- **Use for:** Static fault injection modeling.
- **Call:**

```json
{
  "repo": "OntoIndex",
  "path": "ontoindex/src/core/lbug/pool-adapter.ts",
  "target": "executeQuery",
  "returnValue": "throw"
}
```

- **Returns:**

```json
{
  "branches": [{ "condition": "catch", "taken": true }],
  "earlyReturns": [],
  "bypassWarnings": []
}
```

- **Why use it:** Use to reason about failure paths before writing fault-injection tests.

## Frontier 8: Legacy/Internal Handler Surface

The following legacy handlers are defined in `ontoindex/src/mcp/tools.ts`. They are not the preferred public surface in compact MCP mode, but they remain important because facade tools dispatch to them and some clients may expose them in full mode.

| Handler | Prefer Public Tool | Example Call | Example Return | Why It Exists |
| --- | --- | --- | --- | --- |
| `list_repos` | `discover({action:"repos"})` | `{"repo":"OntoIndex"}` | `{"repos":[{"name":"OntoIndex"}]}` | Repo discovery |
| `query` | `search({action:"semantic"})` | `{"query":"MCP server","repo":"OntoIndex"}` | `{"processes":[...],"definitions":[...]}` | Hybrid concept search |
| `cypher` | `search({action:"cypher"})` | `{"query":"MATCH (n) RETURN n LIMIT 1"}` | `{"markdown":"| n |","row_count":1}` | Raw graph query |
| `context` | `inspect({action:"context"})` | `{"name":"createMCPServer"}` | `{"symbol":{...},"incoming":{...}}` | Symbol details |
| `detect_changes` | `impact({action:"diff"})` or `gn_pre_commit_audit` | `{"scope":"all"}` | `{"changed_symbols":[...],"risk_level":"medium"}` | Diff impact |
| `cycle_detect` | `audit({action:"cycles"})` | `{"edge_types":["IMPORTS"],"limit":10}` | `{"cycles":[...]}` | Circular dependency checks |
| `coupling_matrix` | `audit({action:"coupling"})` | `{"min_symbols":5}` | `{"communities":[{"instability":0.7}]}` | Module coupling metrics |
| `migration_progress` | `audit({action:"migration"})` | `{"old_pattern":"old-api","new_pattern":"new-api"}` | `{"pct_migrated":98}` | Migration tracking |
| `boundary_violations` | `audit({action:"violations"})` | `{"rules":[{"from":"ontoindex-web/**","to":"ontoindex/src/**"}]}` | `{"violations":[]}` | Architecture boundary checks |
| `type_coverage` | `audit({action:"coverage"})` | `{"patterns":["any","non-null"]}` | `{"findings":[...]}` | Type-safety audit |
| `rename` | `refactor({action:"rename"})` or `gn_safe_refactor` | `{"symbol_name":"classifyIntent","new_name":"classifySearchIntent","dry_run":true}` | `{"files_affected":3}` | Graph-aware rename |
| `impact` | `impact({action:"symbol"})` | `{"target":"classifyIntent","direction":"upstream"}` | `{"risk":"MEDIUM","callers":[...]}` | Symbol blast radius |
| `route_map` | `manage({action:"route_map"})` | `{}` | `{"routes":[...]}` | Internal route inventory |
| `tool_map` | `discover({action:"tools"})` | `{}` | `{"tools":[...]}` | Tool inventory |
| `shape_check` | `inspect({action:"shape"})` | `{"route":"/api/query"}` | `{"shape":"known","warnings":[]}` | API shape verification |
| `analysis_catalog` | `discover({action:"packs"})` | `{}` | `{"packs":[...]}` | Analysis pack listing |
| `api_impact` | `impact({action:"route"})` | `{"route":"/api/query"}` | `{"affectedHandlers":[...]}` | Route blast radius |
| `group_list` | `discover({action:"groups"})` | `{}` | `{"groups":[...]}` | Repo group discovery |
| `group_sync` | `discover({action:"sync"})` | `{"group":"platform"}` | `{"contracts":12}` | Cross-repo group sync |
| `route` | `discover({action:"routes"})` | `{"repo":"OntoIndex"}` | `{"routes":[...]}` | HTTP/MCP route listing |
| `session` | `manage({action:"session"})` | `{"op":"status"}` | `{"sessions":[...]}` | Session state |
| `audit_rerun` | `audit({action:"rerun"})` | `{"session":"audit-1"}` | `{"rerun":true}` | Audit rerun |
| `build_residue_audit` | `audit({action:"build"})` | `{"repo":"OntoIndex"}` | `{"residue":[...]}` | Build artifact cleanup |
| `cross_doc_drift` | `audit({action:"drift"})` | `{"repo":"OntoIndex"}` | `{"drift":[]}` | Docs/code drift |
| `evidence_pack` | `inspect({action:"evidence"})` | `{"targets":["ontoindex/src/mcp/server.ts:1"]}` | `{"evidence":[...]}` | Evidence collection |
| `pattern_audit` | `audit({action:"patterns"})` | `{"repo":"OntoIndex"}` | `{"findings":[...]}` | Risky pattern scan |
| `verification_gap` | `audit({action:"test_gap"})` or `gn_test_gap` | `{"base_ref":"HEAD~1"}` | `{"gaps":[...]}` | Missing test coverage |
| `ipc_trace` | `inspect({action:"ipc"})` | `{"symbol_name":"scanAuditPatterns"}` | `{"flow":[...]}` | JS/native bridge trace |
| `requirements_trace` | `audit({action:"requirements"})` | `{"id_pattern":"REQ-\\d+"}` | `{"requirements":[...]}` | Requirement traceability |
| `impact_batch` | `impact({action:"batch"})` | `{"targets":["query","context"],"direction":"upstream"}` | `{"perSymbol":[...],"union":{...}}` | Batch blast radius |
| `hotspot_analysis` | `audit({action:"hotspots"})` | `{"metric":"churn_x_complexity"}` | `{"hotspots":[...]}` | Churn/complexity risk |
| `graph_diff` | `audit({action:"graph_diff"})` | `{"limit":50}` | `{"addedEdges":[...],"removedEdges":[...]}` | Structural diff |
| `tech_debt` | `audit({action:"tech_debt"})` | `{"limit":20}` | `{"symbols":[{"riskScore":42}]}` | Risky symbol ranking |
| `dead_code` | `audit({action:"dead_code"})` | `{"limit":50}` | `{"unreached":[...]}` | Reachability sweep |
| `sandbox` | `refactor({action:"sandbox"})` | `{"action":"stage","payload":{}}` | `{"staged":true}` | Write gate preview |
| `repomap` | `search({action:"repomap"})` | `{"focus":["ontoindex/src/mcp/server.ts"],"token_budget":2000}` | `{"symbols":[...]}` | Graph-ranked context |
| `replace_symbol` | `refactor({action:"replace"})` | `{"uid":"Function:createMCPServer","new_body":"...","dry_run":true}` | `{"dry_run":true}` | Body replacement |
| `get_symbol_info` | `inspect({action:"context"})` | `{"uid":"Function:createMCPServer"}` | `{"source":"...","metadata":{...}}` | Exact symbol metadata |
| `update_symbol_body` | `refactor({action:"replace"})` | `{"uid":"Function:createMCPServer","new_body":"...","dry_run":true}` | `{"success":true}` | AST body update |
| `rename_symbol` | `gn_safe_refactor` | `{"uid":"Function:classifyIntent","new_name":"classifySearchIntent","dry_run":true}` | `{"files_affected":3}` | UID-anchored rename |
| `extract_function` | `gn_safe_refactor` | `{"uid":"Function:largeHandler","new_name":"parseInput","dry_run":true}` | `{"preview":{...}}` | Helper extraction |
| `move_symbol` | `gn_safe_refactor` | `{"uid":"Function:helper","target_file":"ontoindex/src/mcp/super/helper.ts","dry_run":true}` | `{"preview":{...}}` | Symbol relocation |

## Practical Workflows

### Explore Before Editing

```json
{ "tool": "gn_explore", "args": { "repo": "OntoIndex", "query": "MCP docs readiness" } }
```

Then:

```json
{ "tool": "gn_explain_module", "args": { "repo": "OntoIndex", "filePath": "ontoindex/src/mcp/super/docs.ts" } }
```

### Safe Symbol Change

```json
{ "tool": "gn_safe_edit_check", "args": { "repo": "OntoIndex", "symbol": "createMCPServer", "intent": "modify-body" } }
```

Then after editing:

```json
{ "tool": "gn_verify_diff", "args": { "repo": "OntoIndex", "scope": "all", "executedTests": ["npm run test:unit"] } }
```

### Release Readiness

```json
{ "tool": "gn_diagnose", "args": { "repo": "OntoIndex" } }
```

```json
{ "tool": "gn_pre_commit_audit", "args": { "repo": "OntoIndex", "scope": "all", "docsEvidence": true } }
```

### Manager/Sub-Agent Audit Flow

```json
{ "tool": "gn_audit_session_start", "args": { "repo": "OntoIndex", "session": "audit-release-1" } }
```

```json
{ "tool": "gn_audit_session_bundle", "args": { "repo": "OntoIndex", "session": "audit-release-1" } }
```

```json
{ "tool": "gn_dispatch_prompt", "args": { "repo": "OntoIndex", "session": "audit-release-1", "bundleId": "B-001" } }
```

## Notes For Agents

- Prefer `gn_*` super-functions for human-readable workflows.
- Prefer facade tools when the MCP client wants a compact stable tool list.
- Use `gn_diagnose` if results look stale or incomplete.
- Run `gn_safe_edit_check` before symbol edits.
- Run `gn_verify_diff`, `gn_test_gap`, or `gn_pre_commit_audit` after edits.
- Treat docs/advisory memory as separate from authoritative graph or audit evidence.
- For write tools, default to dry-run and require explicit confirmation.
