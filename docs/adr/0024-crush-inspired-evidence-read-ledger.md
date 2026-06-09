# ADR 0024: Crush-Inspired Evidence Read Ledger and Local Control Plane

Status: Implemented

## Context

Crush is useful as a reference because it treats an agent runtime as a local control plane with explicit
workspaces, sessions, messages, permissions, file-read tracking, LSP state, skills, hooks, and MCP state.
Its strongest transferable ideas are not the coding-agent loop itself, but the runtime accountability
around what a session read, what tool needed permission, which workspace owned state, and which local
diagnostics are safe to expose.

OntoIndex already has a different source of authority: LadybugDB graph storage, symbols, execution flows,
impact analysis, freshness policy, audit lifecycle, target context, MCP super-functions, docs sidecars,
review reports, and advisory memories. OntoIndex should not become a terminal coding agent. The useful
direction is to add a small evidence/read ledger and runtime diagnostics control plane so high-level
answers can show which evidence was actually consulted and which context was only advisory.

Related decisions:

- ADR 0018: MCP Audit Trust Contract and Customer Readiness Gates
- ADR 0020: Graph-aware diff review and review reports
- ADR 0022: QMD-inspired structured retrieval and organic recommendations
- ADR 0023: Serena follow-up memory and diagnostics guardrails

Reviewed reference:

- <https://github.com/charmbracelet/crush>

Crush reference anchors:

```text
internal/app/app.go
internal/backend/backend.go
internal/server/server.go
internal/session/session.go
internal/filetracker/service.go
internal/permission/permission.go
internal/hooks/runner.go
internal/lsp/manager.go
internal/skills/manager.go
```

Existing OntoIndex anchors:

```text
ontoindex/src/mcp/shared/response-envelope.ts
ontoindex/src/mcp/shared/target-context.ts
ontoindex/src/mcp/resources.ts
ontoindex/src/mcp/memory-parser.ts
ontoindex/src/server/mcp-http.ts
ontoindex/src/server/api.ts
ontoindex/src/mcp/super/docs.ts
ontoindex/src/mcp/super/diff-impact.ts
ontoindex/src/mcp/super/pre-commit-audit.ts
ontoindex/src/mcp/super/safe-edit-check.ts
ontoindex/src/core/audit-lifecycle/
ontoindex/src/cli/memory.ts
```

OntoIndex review evidence:

- `ontoindex status` on 2026-05-21 reports the index is up to date at commit `9665894`.
- `response-envelope.ts` defines freshness as `fresh | stale | degraded | unknown | not-applicable`.
- `target-context.ts` already carries `indexedHead`, `currentHead`, dirty-worktree state, and readiness metadata.
- `mcp-http.ts` has an internal diagnostics handle, but its raw snapshot includes full session IDs.
- `resources.ts` and `docs.ts` already include advisory memory boundaries and `stale-index` memory freshness counts.
- `backend-search.ts` already builds structured retrieval evidence and freshness, making it a hot path that should
  not be instrumented first without a measured performance gate.

## Challenge Review

The unsafe version of this idea would copy Crush's coding-agent runtime, persist prompts/tool arguments
inside OntoIndex diagnostics, or let a read ledger become a second source of audit truth. That would
conflict with OntoIndex' safety model.

The constraints are:

1. **Graph evidence remains primary.** A ledger can record that a symbol/resource/doc was read, but it
   cannot create graph facts or audit findings.
2. **Reads are not proof.** A record that an agent read a file or memory proves exposure, not correctness.
   Audit claims still require ADR 0018 evidence and verification gates.
3. **Advisory memory must stay advisory.** Ledger records for `.ontoindex/memories/` must carry
   `evidenceClass: advisory_memory` and `not_audit_evidence: true`.
4. **Diagnostics must stay minimized.** A runtime diagnostics API may summarize ledger counts and recent
   resource types, but must not expose prompts, tool arguments, raw responses, file contents, or secrets.
5. **Do not add dynamic MCP discovery.** The ledger should be an internal/runtime facility surfaced through
   existing tools and diagnostics, not a reason to hide or reveal MCP tools dynamically.
6. **Do not add shell hook trust by default.** Crush's hook model is powerful, but OntoIndex should first
   implement typed policy decisions and only later consider local hooks around specific lifecycle events.
7. **Control plane should be shared, not duplicated.** MCP, CLI, and web diagnostics should call the same
   internal runtime operations instead of each surface maintaining its own session facts.
8. **Existing work already covers adjacent slices.** ADR 0023 owns advisory memory hardening and
   diagnostics redaction; `ontoindex/src/cli/memory.ts` already shows memory authoring work. ADR 0024 should
   not re-approve those features. It should add the read/evidence accountability layer beneath them.
9. **Do not assume request/session context exists everywhere.** Current facade dispatch only passes
   `tool`, `action`, `args`, and `backend`; many local backend calls do not have a request ID or session ID.
   V1 events must accept absent request/session identity and still be useful.
10. **Do not invent a second freshness vocabulary.** The ledger should reuse envelope freshness
    (`fresh | stale | degraded | unknown | not-applicable`) and map memory-only `stale-index` separately.
11. **Do not instrument hot retrieval paths first.** `backend-search.ts` and broad context reads can emit many
    candidates per query. V1 should start at explicit boundary reads, then add hot-path instrumentation only
    after latency and event-volume caps are proven.
12. **Target names can be sensitive even without contents.** A path, symbol, memory name, or report ID may
    reveal private design intent. Ledger summaries must truncate or hash targets before web/API exposure.
13. **Ledger writes must fail open.** Recording a read event must never break the primary MCP, CLI, or web
    response. Ledger failures become bounded internal diagnostics only.
14. **One wrapper beats scattered side effects.** Implementation should centralize redaction and recording in a
    small helper such as `recordEvidenceReadSafe` instead of sprinkling ad hoc ledger calls through every tool.
15. **Runtime diagnostics must compose existing MCP diagnostics.** The control plane should wrap
    `MCPEndpointHandle.getDiagnostics()` and redact it for API/web use, not fork a second session tracker.

## Decision

OntoIndex will adopt the useful Crush patterns as a OntoIndex-native **Evidence Read Ledger** and a small
**Runtime Diagnostics Control Plane**.

The first accepted direction is:

1. Record bounded, redacted read events for MCP resources, docs reports, bounded review/audit report
   summaries, and advisory memories. Add broad symbol/context/search reads only after the measured
   performance gate in P3.
2. Classify every read by evidence authority:
   - `graph_evidence`
   - `docs_evidence`
   - `audit_evidence`
   - `advisory_memory`
   - `runtime_diagnostic`
   - `unknown`
3. Attach target context and freshness metadata to each read event when available.
4. Expose ledger summaries through authenticated diagnostics and selected high-level reports.
5. Keep ledger content out of audit status decisions unless a later ADR explicitly defines a verification
   gate that consumes ledger metadata.
6. **Diagnostics Minimization**: Omit detailed event logs (`recentTargets`) from public diagnostics APIs. Expose only aggregate counts and surface-level freshness to ensure target-name privacy.

This ADR does not approve:

- copying Crush's full coding-agent loop;
- storing prompts, tool arguments, tool responses, or file contents in diagnostics;
- making reads equal to evidence validity;
- memory-derived audit status;
- dynamic MCP discovery;
- generic shell hooks as a default OntoIndex extension mechanism;
- hosted telemetry or remote analytics.

## Algorithm/Technique

### 1. Evidence Read Ledger

Add a small internal ledger module:

```text
ontoindex/src/core/runtime/evidence-read-ledger.ts
```

Initial record shape:

```ts
export type EvidenceReadClass =
  | 'graph_evidence'
  | 'docs_evidence'
  | 'audit_evidence'
  | 'advisory_memory'
  | 'runtime_diagnostic'
  | 'unknown';

export interface EvidenceReadEvent {
  version: 1;
  id: string;
  repo: string;
  sessionIdHash?: string;
  requestId?: string;
  surface: 'mcp' | 'cli' | 'web-api' | 'internal';
  tool?: string;
  action?: string;
  evidenceClass: EvidenceReadClass;
  targetType: 'symbol' | 'file' | 'resource' | 'docs-report' | 'memory' | 'review-report' | 'diagnostic';
  target: string;
  targetContext?: {
    repo?: string;
    repoPath?: string;
    indexedCommit?: string;
    currentCommit?: string;
    freshness?: 'fresh' | 'stale' | 'degraded' | 'unknown' | 'not-applicable';
    memoryFreshness?: 'fresh' | 'stale-index' | 'unknown';
  };
  targetRedacted?: boolean;
  targetHash?: string;
  notAuditEvidence?: boolean;
  createdAt: string;
}
```

The ledger must not store:

- prompts;
- tool arguments;
- tool responses;
- file contents;
- memory body text;
- raw resource contents;
- secrets or credentials.

It also must bound and sanitize target identifiers:

- store full targets only in the in-process ledger when needed for local debugging;
- expose truncated or hashed targets in web/API diagnostics by default;
- cap target length before storage;
- never store absolute paths outside the resolved repository root;
- mark redacted targets with `targetRedacted: true`.

Storage options:

1. **V1 in-memory ring buffer.** Lowest risk. Good enough for diagnostics and current session visibility.
   The buffer must have a global cap and per-repo/session summary counts to avoid cross-repo leakage and
   reconnect storms.
2. **Optional local file under `.ontoindex/runtime/`.** Follow-up only after retention policy exists.
3. **Audit-session attachment.** Follow-up only if ADR 0018 verification semantics are extended.

V1 should use the in-memory ring buffer only.

### 1.1 Instrumentation Contract

Add one small recording boundary:

```ts
export function recordEvidenceReadSafe(event: EvidenceReadEventInput): void;
```

Contract:

- synchronous in-memory append only;
- no disk I/O, network I/O, graph writes, or audit writes;
- catches and suppresses recorder errors;
- applies target truncation/redaction before storage;
- fills missing request/session identity with `undefined`, not placeholder IDs;
- emits optional debug counters, not user-facing failures.

### 2. Read Event Producers

Start with read events from surfaces where provenance is explicit and volume is naturally bounded:

```text
ontoindex/src/mcp/resources.ts
ontoindex/src/mcp/super/docs.ts
ontoindex/src/mcp/super/diff-impact.ts
ontoindex/src/mcp/super/pre-commit-audit.ts
ontoindex/src/mcp/super/safe-edit-check.ts
```

Defer hot or broad producers until after P0/P1 performance evidence exists:

```text
ontoindex/src/mcp/local/backend-context.ts
ontoindex/src/mcp/local/backend-search.ts
```

Initial classification rules:

| Surface | Evidence class | Notes |
|---|---|---|
| Symbol context / impact reads | `graph_evidence` | Include freshness and target context |
| Docs trace/drift/context reports | `docs_evidence` | Preserve sidecar freshness/degraded state |
| Audit lifecycle reads | `audit_evidence` | Ledger is metadata only; audit state remains authoritative elsewhere |
| `.ontoindex/memories/` resources | `advisory_memory` | Always `notAuditEvidence: true` |
| MCP/session diagnostics | `runtime_diagnostic` | Redacted summary only |

If target context cannot be resolved, record `freshness: unknown` and add a diagnostic warning in the
calling response envelope when appropriate.

For advisory memories, map freshness as:

| Memory front matter | Ledger envelope freshness | Ledger memory freshness |
|---|---|---|
| `fresh` | `fresh` | `fresh` |
| `stale-index` | `stale` | `stale-index` |
| `unknown` | `unknown` | `unknown` |
| invalid memory | `degraded` | `unknown` |

### 3. Runtime Diagnostics Control Plane

Add a shared internal operation rather than duplicating diagnostics in MCP, CLI, and web:

```text
ontoindex/src/core/runtime/runtime-diagnostics.ts
```

Initial API:

```ts
export interface RuntimeDiagnosticsSnapshot {
  version: 1;
  capturedAt: string;
  repo?: string;
  sessionIdHash?: string;
  mcp?: {
    activeSessionCount: number;
    totalSessionsCreated: number;
    totalEvictions: number;
    totalCapEvictions: number;
  };
  evidenceReads: {
    total: number;
    byClass: Record<EvidenceReadClass, number>;
    bySurface: Record<string, number>;
    recentTargets: Array<{
      evidenceClass: EvidenceReadClass;
      targetType: EvidenceReadEvent['targetType'];
      target: string;
      targetRedacted?: boolean;
      freshness?: string;
      notAuditEvidence?: boolean;
    }>;
  };
}
```

The web/API diagnostics surface approved in ADR 0023 may use this snapshot, but it must preserve ADR 0023
redaction:

- no full session IDs by default;
- no raw memory names, absolute paths, or long symbol names by default;
- no prompts;
- no tool args;
- no raw payloads;
- no file or memory content;
- no unbounded histories.

The implementation should adapt the existing `MCPEndpointHandle.getDiagnostics()` snapshot instead of
adding another MCP session registry. Internal raw session IDs may remain internal, but API/web projections
must expose `sessionIdHash` or aggregate counts only.

### 4. Organic Recommendations

Use the ledger to strengthen ADR 0022 organic recommendations.

A recommendation in review/audit surfaces may include a `basedOnReads` block:

```text
basedOnReads:
  graph_evidence: 3
  docs_evidence: 1
  advisory_memory: 0
  stale: true
  advisory_memory_stale_index: false
```

Rules:

1. Recommendations must still be derived from returned evidence, not from the mere existence of ledger
   entries.
2. If `advisory_memory > 0`, the recommendation must explicitly say memory was advisory and not audit
   evidence.
3. If no graph/docs/audit evidence was read, safety recommendations must not claim authority.

### 5. Session-Scoped Permission Decisions

Record the Crush-inspired permission idea as a follow-up, not v1.

Future shape:

```ts
export interface PermissionDecision {
  version: 1;
  repo: string;
  sessionIdHash?: string;
  tool: string;
  action: string;
  path?: string;
  decision: 'allow' | 'deny' | 'needs_review';
  reason: string;
  expiresAt?: string;
  createdAt: string;
}
```

Potential consumers:

- memory authoring;
- safe refactors;
- write-through verification;
- release preparation;
- destructive CLI operations.

V1 does not add permission prompts or a new user-interaction model.

### 6. Pre-Action Policy Hooks

Record Crush's pre-tool hook model as a later extension only.

Potential OntoIndex events:

```text
pre_analyze
pre_memory_write
pre_safe_edit
pre_commit_audit
pre_release
```

Constraints:

- hook output is advisory unless independently verified;
- no shell hooks by default;
- typed policy decisions should come first;
- hooks must not be able to mark audit findings verified.

## Rollout

P0:

- Add in-memory `EvidenceReadLedger` with bounded capacity.
- Add redaction/truncation helpers for targets and session IDs.
- Add `recordEvidenceReadSafe` and unit tests for fail-open behavior, redaction, capacity, class counts, and
  target-context metadata.

P1:

- Instrument memory/resource reads and docs context reads.
- Ensure advisory memories always record `notAuditEvidence: true`.
- Keep `backend-search.ts` and broad context instrumentation deferred.
- Add tests proving trace/drift/audit status does not change because a memory read exists.

P2:

- Add runtime diagnostics snapshot that joins MCP diagnostics and ledger summaries.
- Expose only through authenticated diagnostics surfaces approved by ADR 0023.
- Prove API/web snapshots redact full session IDs and sensitive targets.

P3:

- Add ledger summaries to review/report outputs where they improve explainability.
- Keep recommendations tied to returned graph/docs/audit evidence.
- Measure event volume and latency before adding ledger events to `backend-search.ts` or broad context reads.

P4:

- Evaluate session-scoped permission decisions for write surfaces.

P5:

- Evaluate typed pre-action policy hooks after permission decisions exist.

## Consequences

Positive:

- OntoIndex can explain what evidence was actually consulted before a report or recommendation.
- Advisory memories become safer because their reads are visible and classified as non-evidence.
- Diagnostics become more useful without storing sensitive prompts or payloads.
- Organic recommendations get stronger provenance.
- Future write surfaces get a clearer path toward permission/policy records.

Negative:

- Every high-level read surface needs disciplined instrumentation.
- A ledger can create false confidence if users confuse "read" with "verified".
- In-memory v1 diagnostics disappear when the process restarts.
- Adding persistent retention later will require a separate retention/security decision.
- Even redacted target summaries can leak workflow shape; web/API diagnostics need conservative defaults.
- Hot-path instrumentation can add latency or memory pressure if introduced before measurement.

## Validation

Focused implementation tests should cover:

```text
cd ontoindex && npm test -- evidence-read-ledger
cd ontoindex && npm test -- response-envelope
cd ontoindex && npm test -- resources.test.ts
cd ontoindex && npm test -- mcp-http-diagnostics.test.ts
cd ontoindex && npm test -- api-guards.test.ts
cd ontoindex && npm test -- mcp-docs-facades.test.ts
```

Acceptance checks:

- ledger capacity is bounded;
- event IDs do not expose full session IDs;
- API/web diagnostics do not expose full session IDs;
- target identifiers are bounded and redacted or hashed where required;
- advisory memory reads are always `notAuditEvidence: true`;
- memory `stale-index` maps to ledger `stale` plus `memoryFreshness: stale-index`;
- ledger recording failures do not fail primary tool responses;
- diagnostics summaries do not include prompts, tool args, responses, file contents, or memory bodies;
- `gn_docs trace` and `gn_docs drift` outputs do not change authority because a memory read exists;
- review recommendations remain derived from returned evidence;
- stale index and unknown freshness are visible in summaries when applicable.
