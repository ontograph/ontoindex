# ADR 0021: Serena-Inspired Agent Interface for OntoIndex

Status: Proposed

## Context

Serena is useful as a reference because it treats code intelligence as an agent-facing
workflow, not only as a data model. Its strongest ideas are mode-scoped tool exposure,
symbol-first code reading and editing, optional language-server precision, project memories,
and MCP/session observability.

OntoIndex should not copy Serena as a second semantic engine. OntoIndex already has the deeper
authority layer: persistent LadybugDB graph storage, impact analysis, execution flows,
freshness policy, audit lifecycle, target context, sidecar enrichment, and graph-aware review
reports. The useful direction is to make OntoIndex feel more like an IDE-grade agent interface
while keeping OntoIndex' graph and audit contracts as the source of truth.

Related decisions:

- ADR 0013: LSP bridge integration
- ADR 0015: Post-index enrichment sidecar
- ADR 0018: MCP Audit Trust Contract and Customer Readiness Gates
- ADR 0020: Graph-aware diff review and review reports

Reviewed reference:

- <https://github.com/oraios/serena>

## Challenge Review

The unsafe implementation would vendor Serena, expose another large tool surface, let
agent-written memories become audit evidence, or try to make MCP tools appear and disappear at
runtime based on an "active mode". That would fight OntoIndex' trust model and the reality that many
MCP clients treat the tool list as a static session contract.

The constraints are:

1. **Do not add a second authority graph.** Serena-style LSP and symbolic operations may enrich
   high-risk workflows, but OntoIndex' indexed graph remains the primary source for impact,
   process, community, and audit answers.
2. **Do not grow unbounded MCP tools.** Serena's context/mode idea should reduce tool overload by
   filtering and explaining existing tools through a single registry.
3. **Memories are advisory only.** Project memories may speed onboarding, but they must not
   produce `OPEN` findings, verification status, or audit recommendations without ADR 0018
   evidence and freshness metadata.
4. **LSP remains optional.** Language servers are valuable for rename/reference precision, but
   they must not become required for normal analyze/query/review operation.
5. **Readiness must be visible.** Any mode, memory, LSP, sidecar, dashboard, or cross-repo
   workflow must report stale index, dirty worktree, missing sidecar, missing LSP, and repo
   selection state.
6. **Integrate with existing paths.** The implementation must extend `gn_safe_edit_check`,
   `target-context`, the MCP tool registry, HTTP MCP sessions, and repo resources rather than
   creating parallel workflows.
7. **Do not make modes a hidden permission system.** For v1, modes are guidance and filtering in
   `gn_help`, diagnostics, and response hints. The registered MCP frontier should remain stable
   unless a later compatibility review proves dynamic tool exposure is safe for supported clients.
8. **Do not approve five products at once.** Tool modes, safe-edit plans, LSP expansion, memories,
   session dashboards, and cross-repo query mode have different owners and risks. The first
   accepted deliverable must be one narrow contract: mode-aware guidance generated from the single
   public tool registry.

## OntoIndex Evidence Check

This ADR was prepared with the local OntoIndex CLI:

```bash
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js status
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js query "MCP tool registry help target context mode safe edit LSP review diff" --repo /home/er77/_wrk/OntoIndex --limit 10
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js query "memory onboarding project notes dashboard MCP session diagnostics" --repo /home/er77/_wrk/OntoIndex --limit 8
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js context gnSafeEditCheck --repo /home/er77/_wrk/OntoIndex
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js context LSPBridge --repo /home/er77/_wrk/OntoIndex
```

Findings:

- The OntoIndex index was stale during review: indexed commit `83a0773`, current commit
  `17a9ef7`. Therefore these results are architecture navigation, not fresh implementation
  acceptance evidence.
- `gnSafeEditCheck` already participates in safe-edit and safe-refactor flows, calls upstream,
  downstream, process, cluster, co-change, test-coverage, and LSP helpers, and is the right entry
  point for a symbol-first edit workflow.
- `LSPBridge` exists but is currently narrow: TypeScript/JavaScript and Python defaults, plus a
  definition lookup surface. It is the right place to expand optional precision rather than adding
  a separate Serena runtime.
- `target-context` already models `embeddings`, `lsp`, `sidecar`, policy, stale index, dirty
  worktree, and repo resolution. Serena-inspired readiness should flow through that shape.
- `mcp-http` already tracks HTTP MCP sessions with TTL and caps. It is the natural anchor for a
  session diagnostics surface.
- `resources.ts` already exposes repo setup/context resources. A project-memory surface can build
  there without changing the graph store.
- `update_symbol_body`, `gn_verify_diff`, and `gn_test_gap` are already registered callable
  surfaces. Safe-edit recommendations should be validated against the public registry rather than
  maintained as a separate enum.

## Decision

Adopt Serena-inspired capabilities as a OntoIndex-native agent interface layer, but narrow v1 to
mode-aware guidance generated from the public tool registry.

The accepted v1 direction is:

1. Add mode metadata to the public tool registry.
2. Expose `gn_help({ mode })` and `gn_tool_contract({ mode })` views that filter and explain the
   stable registered tool frontier.
3. Add mode-aware next-step hints and readiness warnings without hiding registered tools from MCP
   clients.
4. Validate `gn_safe_edit_check` recommendations against the same registry.

The following are recorded as follow-up work, not bundled into the first implementation gate:

- richer symbol-first safe-edit plan shape;
- LSP precision expansion;
- advisory project memories;
- MCP/session diagnostics dashboard;
- explicit read-only cross-repo query mode.

Detailed memory and diagnostics follow-up now lives in
[ADR 0023](./0023-serena-follow-up-memory-diagnostics-guardrails.md).

This ADR does not approve vendoring Serena, replacing the OntoIndex graph, or treating memories as
audit evidence. It also does not approve dynamic runtime MCP tool hiding.

## Algorithm/Technique

### 1. Mode-aware MCP tool registry

Extend:

```text
ontoindex/src/mcp/shared/tool-registry.ts
ontoindex/src/mcp/server.ts
ontoindex/src/mcp/super/help.ts
```

Add metadata to each public tool:

```ts
type AgentMode = 'explore' | 'plan' | 'edit' | 'review' | 'audit' | 'release' | 'query-projects';

interface PublicToolRegistryEntry {
  kind: PublicToolKind;
  name: string;
  callable: true;
  definition: ToolDefinition;
  modes: AgentMode[];
  capabilities: string[];
  requiresFreshIndex?: boolean;
  mutatesRepo?: boolean;
  fallbackTools?: string[];
}
```

Use this metadata to:

- Filter `gn_help` by mode.
- Append mode-specific next-step hints from `getNextStepHint`.
- Make MCP discovery, CLI help, and help text agree.
- Mark unavailable/degraded tools when `targetContext` says the index, LSP, embeddings, or sidecar
  is stale or missing.

Do not remove tools from MCP discovery in v1. Clients may cache the tool list for the whole session,
and hiding tools based on a mutable mode risks "unknown tool" failures. Mode filtering is a
presentation and recommendation layer until a compatibility test matrix proves dynamic exposure is
safe.

The first mode set should be conservative:

- `explore`: `query`, `context`, `gn_explore`, resources.
- `plan`: read-only graph/context tools plus `gn_safe_edit_check`.
- `edit`: `gn_safe_edit_check`, `gn_safe_refactor`, `rename`, `gn_can_delete`, `detect_changes`.
- `review`: `gn_review_diff`, `gn_diff_impact`, `detect_changes`, `impact`, `context`.
- `audit`: audit lifecycle, systems audit, freshness-aware report tools.
- `release`: `detect_changes`, `gn_pre_commit_audit`, `gn_test_gap`, `gn_verify_diff`.
- `query-projects`: read-only repo/group query tools only.

### 2. Symbol-first safe edit workflow

Extend:

```text
ontoindex/src/mcp/super/safe-edit-check.ts
ontoindex/src/mcp/super/safe-refactor.ts
ontoindex/src/mcp/local/backend-rename.ts
```

`gn_safe_edit_check` should return a structured edit plan:

```json
{
  "workflow": "symbol-first-edit",
  "symbol": "...",
  "verdict": "SAFE|CAUTION|DANGEROUS|BLOCKED",
  "requiredReads": [
    { "tool": "context", "params": { "name": "..." }, "reason": "target symbol body" },
    { "tool": "impact", "params": { "target": "...", "direction": "upstream" }, "reason": "caller blast radius" }
  ],
  "recommendedAction": {
    "tool": "rename|gn_safe_refactor|manual_patch_with_guard",
    "reason": "..."
  },
  "verification": [
    "detect_changes",
    "gn_verify_diff",
    "gn_test_gap"
  ]
}
```

Also reconcile the recommendation vocabulary against the public registry. `computeRecommendedTool`
should return only callable tool names from `getCallableToolNames()` or a clearly non-tool action
such as `manual_patch_with_guard`. Because `update_symbol_body` is callable, it should remain a
valid recommendation only if `gn_safe_edit_check` can supply the UID/body-read preconditions the
tool needs.

### 3. Optional LSP precision for high-risk operations

Extend:

```text
ontoindex/src/core/lsp/bridge.ts
ontoindex/src/core/lsp/client.ts
ontoindex/src/mcp/shared/target-context.ts
```

Keep ADR 0013's rule: LSP is enrichment, not replacement.

Add:

- Configured language-server discovery instead of hard-coded TypeScript/Python only defaults.
- `findReferences` readiness by file extension/language.
- `prepareRename` or equivalent rename validation where the server supports it.
- Per-language readiness in `targetContext.lsp`.
- Timeouts and bounded process lifecycle as currently done by `LSPClient`.

This is follow-up work after v1. Use LSP only when:

- `gn_safe_edit_check` classifies a change as high-risk.
- `gn_safe_refactor` or `rename` needs higher precision.
- `review diff` wants optional extra confidence on changed exported symbols.

### 4. Advisory project memories

This is follow-up work after v1. Detailed guardrails, rollout slices, and validation now live in
[ADR 0023](./0023-serena-follow-up-memory-diagnostics-guardrails.md).

The high-level direction remains: add a small OntoIndex-native memory layer:

```text
.ontoindex/memories/
ontoindex/src/mcp/resources.ts
ontoindex/src/mcp/super/docs.ts
```

Initial resources:

```text
ontoindex://repo/{name}/memories
ontoindex://repo/{name}/memory/{memoryName}
ontoindex://repo/{name}/onboarding
```

Memory files should be Markdown with front matter:

```yaml
---
version: 1
repo: OntoIndex
created_at: 2026-05-19
source_commit: 17a9ef7
indexed_commit: 83a0773
freshness: stale-index
kind: advisory
not_audit_evidence: true
sources:
  - docs/adr/0018-mcp-audit-trust-contract.md
  - ontoindex/src/mcp/shared/target-context.ts
---
```

Rules:

- Memories may guide onboarding and repeated agent work.
- Memories must be excluded from audit status decisions unless separately verified.
- Renames may update internal memory links later, but v1 should keep the format simple.

### 5. MCP session diagnostics dashboard

Extend:

```text
ontoindex/src/server/mcp-http.ts
ontoindex-web/src/
```

This is follow-up work after v1. Detailed guardrails, rollout slices, and validation now live in
[ADR 0023](./0023-serena-follow-up-memory-diagnostics-guardrails.md).

The high-level direction remains: expose a local diagnostics endpoint or web view with:

- Active MCP session count.
- Session age and last activity.
- Last called tools.
- Active repo and target context.
- Index freshness.
- LSP/embedding/sidecar readiness.
- Active mode.
- Response-limit/degraded-output warnings.

The current `mcp-http.ts` session map already tracks session identity and last activity. Add a
bounded ring buffer for tool calls and diagnostics instead of logging unbounded data.

### 6. Explicit read-only cross-repo query mode

Use existing repo/group support. Do not create a Serena-style project activation system.

This is follow-up work after v1. Add `query-projects` as a mode that exposes only read-only tools
in help/recommendation surfaces:

- `list_repos`
- `query`
- `context`
- `impact`
- repo/group resources

Every response in this mode must include or point to `targetContext`, because wrong-repo answers
are worse than missing answers.

## Consequences

Positive:

- Agents get a clearer workflow with fewer accidental tool choices.
- OntoIndex reuses existing graph, impact, target-context, and review surfaces.
- LSP precision improves high-risk edits without becoming a hard dependency.
- Project memories reduce repeated onboarding cost without weakening audit evidence.
- Session diagnostics make stale, degraded, or wrong-repo behavior visible.

Negative:

- Mode metadata requires disciplined registry maintenance.
- If modes are treated as runtime authorization, agents can hit cached-tool or unknown-tool
  failures. V1 must keep them advisory.
- Project memories can become stale unless every memory carries provenance and freshness.
- LSP support increases operational complexity and varies by language.
- Dashboard/session diagnostics can accidentally become an unbounded telemetry sink if not capped.

## Rollout

P0:

- Add mode metadata to the public MCP registry.
- Update `gn_help` to filter by mode.
- Add `gn_tool_contract({ mode })` to verify that mode-filtered advertised tools are callable.
- Add `targetContext` readiness to mode-aware help output.
- Add tests proving v1 does not remove tools from MCP discovery.

P1:

- Extend `gn_safe_edit_check` with a symbol-first edit plan.
- Reconcile `recommendedTool` names with actual callable tools via the public registry.
- Add unit tests for mode filtering and safe-edit plan shape.

P2:

- Expand `LSPBridge` readiness and optional reference/rename checks.
- Add diagnostics endpoint with bounded session/tool-call history.

P3:

- Add advisory project memories and onboarding resources.
- Add `query-projects` mode for cross-repo read-only workflows.

P4:

- Wire the web UI to MCP/session diagnostics.
- Feed mode-aware guidance into review diff and release workflows.

## Acceptance Gates

V1 is complete only when:

1. `gn_help({ mode: "edit" })` and `gn_help({ mode: "review" })` return different, registry-backed
   recommendations without changing the MCP tool list.
2. `gn_tool_contract({ mode })` proves every advertised tool is callable.
3. `gn_safe_edit_check` recommendations are validated against the public registry.
4. Stale index and missing-readiness states appear in mode-aware help output.
5. Unit tests cover registry mode metadata, mode-filtered help, static MCP discovery, and safe-edit
   recommendation validation.
