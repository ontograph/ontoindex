# Review of External Ontocode/OntoIndex Session Log Report

**Review date:** 2026-08-05
**Reviewed repository:** `/opt/demodb/_workfolder/OntoIndex`
**Current HEAD:** `e5347b084651cceb8ea89eea4fdd047b8373cef0` (`v2.1.4`)
**External evidence host:** `/home/er77`
**External evidence window:** 2026-07-26 21:00:00 through 2026-08-05
06:09:22.999 UTC

## Review Boundary

The supplied report is internally detailed and provides reproducible `jq`,
`awk`, and `rg` procedures, call IDs, timestamps, and selected JSON evidence.
However, `/home/er77/.ontocode/sessions/2026` is not present on this host.
Therefore:

- the reported corpus totals and latency distributions were not independently
  reproduced here;
- quoted external counts remain evidence attributed to the originating host;
- product conclusions below were checked against current OntoIndex source;
- no index refresh was started because the local graph is stale and the
  worktree already contains unrelated changes.

OntoIndex reported an indexed commit of `5ff8f63fc53e0ee83ce172803b5b9c7508b300df`
against current HEAD `e5347b084651cceb8ea89eea4fdd047b8373cef0`.
Graph search was used only to locate owners; exact conclusions use current
source.

## Verdict

The report identifies four actionable product problems, one cross-component
incident whose owner is not yet proven, and one legacy consistency issue that
is partly addressed in current source.

| Reported finding | Review status | Reviewed severity | Primary owner |
|---|---|---:|---|
| Auto-refresh exceeds MCP lifecycle | Confirmed | P1 | OntoIndex MCP refresh orchestration |
| Response cap corrupts structured output | Confirmed incident; ownership incomplete | P0 | Ontocode transport plus OntoIndex response budgeting |
| Dirty-worktree symbol resolution fails | Confirmed | P1 | OntoIndex symbol resolution/impact |
| Freshness status is contradictory | Partly confirmed, partly addressed | P2 | Shared response contract and legacy callers |
| False cross-language call edges | Plausible current root cause; fixture required | P1 | Ingestion call resolution |
| Optional capability diagnostics dominate output | Confirmed | P2 | Local MCP response assembly |

The proposed fix order is broadly correct. Two changes are needed:

1. Reuse the existing asynchronous analysis job machinery instead of creating
   a second lifecycle for `gn_ensure_fresh`.
2. Measure the response at the OntoIndex backend, MCP server boundary, and
   Ontocode client boundary before assigning the 64 KiB corruption to one
   component.

## Findings

### P0: Response corruption is real, but the report does not isolate ownership

The external evidence shows invalid JSON clustered around 65,536 bytes and
records the transport result as `Ok`. That is a structured-evidence integrity
failure and should remain the first incident to fix.

Current OntoIndex behavior does not protect the observed boundary:

- `ontoindex/src/mcp/local/response-guard.ts:1` sets the guard to 512 KiB;
- `ontoindex/src/mcp/local/local-backend.ts:1692` serializes the completed result
  and applies that guard only after tool execution;
- the guard returns a valid small JSON preview only above 512 KiB;
- ordinary semantic search has result limits but no cursor that can reconstruct
  the complete ordered result;
- the response-guard tests cover 512 KiB, not a 64 KiB client/transport limit.

The report attributes the problem to OntoIndex response-size limiting, but the
observed cutoff is far below OntoIndex's current guard. The failure may occur in
Ontocode framing, MCP transport serialization, an older OntoIndex version, or a
combination of these layers.

**Required fix**

Instrument and compare UTF-8 byte counts and hashes at three boundaries:

1. value returned by `LocalBackend.callTool`;
2. MCP server response before transport write;
3. Ontocode `mcp_tool_call_end` payload after receipt.

Then lower or negotiate the OntoIndex response budget below the smallest hard
transport cap. Apply limits before serialization and return a valid envelope
with `truncated`, emitted/total counts, omitted sections, and a stable cursor.
Do not slice serialized JSON.

**Verification**

- exercise payload sizes immediately below, at, and above 64 KiB;
- include multibyte UTF-8 content so character and byte limits cannot diverge;
- parse the outer MCP result and embedded structured result on every page;
- reconstruct all ordered candidates from cursors without duplicates or loss.

### P1: `gn_ensure_fresh(autoAnalyze=true)` is synchronously blocking

Current source directly confirms the lifecycle mismatch:

- `ontoindex/src/mcp/super/ensure-fresh.ts:218` spawns the CLI and returns a
  promise that resolves only when the child exits;
- `ontoindex/src/mcp/super/ensure-fresh.ts:519` awaits that promise inside the
  MCP request;
- the internal timeout defaults to 300 seconds, which exceeds the 120-second
  timeout observed by the external MCP client;
- timeout handling terminates the child and returns only a warning, with no job
  ID, durable status, or log location;
- tests mock immediate process exit and do not cover a client timeout shorter
  than the analysis lifecycle.

The external latency distribution is credible given this implementation.
Severity is P1 rather than P0: the path is explicit opt-in and does not itself
prove data loss, but it is operationally unusable on repositories whose normal
analysis exceeds the client deadline.

The repository already contains the needed lifecycle in
`ontoindex/src/server/analyze-job.ts` and `ontoindex/src/server/api-analyze-routes.ts`:
job IDs, same-repository deduplication, progress, persistence, cancellation,
timeouts, and asynchronous execution.

**Required fix**

Expose or extract that existing job manager for MCP use. `gn_ensure_fresh`
should submit or reuse a repo/target-HEAD job and return immediately. Avoid a
second job store or a detached `spawn` implementation.

**Verification**

- initial request returns within five seconds;
- duplicate requests return the active job ID;
- status exposes target HEAD, phase, timestamps, process state, exit result,
  and bounded logs;
- cancellation and server restart have deterministic terminal states.

### P1: Dirty-worktree symbol resolution is graph-only and untyped

Current source confirms the report's central claim:

- `ontoindex/src/mcp/local/backend-impact.ts:181` resolves impact targets only
  through `resolveSymbolCandidates`;
- `ontoindex/src/mcp/local/backend-symbol-resolution.ts:188` queries the graph
  for UID/name matches;
- `file_path` only narrows graph rows; it does not inspect current source;
- a miss becomes generic `Target '<selector>' not found` with `risk: UNKNOWN`;
- the result does not distinguish invalid input, stale graph, dirty source,
  untracked source, unsupported language, or genuine absence.

Current target-context code already describes dirty and untracked workspace
states, but that evidence is not used to recover or type the symbol-resolution
failure.

**Required fix**

Return a typed resolution failure. At minimum distinguish:
`selector-invalid`, `not-in-index`, `dirty-file-not-indexed`,
`untracked-file-not-indexed`, `ambiguous`, and `unsupported-language`.
When `file_path` is supplied and the file is dirty, run a bounded exact
file-local source lookup and return a retry-ready canonical selector. Do not
claim graph impact for a symbol that exists only in the source overlay.

**Verification**

Cover modified, added, deleted, renamed, and untracked symbols. Each case must
either resolve safely or return a typed reason and exact recovery action, never
an unexplained generic `UNKNOWN`.

### P1: Global call fallback lacks a language boundary

The external report's false edges cannot be replayed without the Axel index,
but current source contains a compatible failure mechanism:

- `ontoindex/src/core/ingestion/model/resolution-context.ts` falls back from
  same-file and import/package scope to a repository-global name lookup;
- the global candidate pool combines classes, impls, free callables, methods,
  and constructors without filtering by source language;
- `resolveFreeCall` accepts the sole callable candidate after filtering;
- ambiguity is rejected, but a single unrelated same-name symbol in another
  language can still win the global fallback;
- the existing precision baseline checks per-language local-shadow cases, not
  mixed-language common-name collisions.

This supports the report's diagnosis, but a current-source fixture is required
before changing resolver behavior because global fallback also recovers valid
cross-file calls when import evidence is incomplete.

**Required fix**

Add a multilingual fixture first. For global fallback, require language
compatibility or explicit cross-language evidence before accepting a sole
candidate. Keep unresolved calls unresolved rather than binding by name alone.

**Verification**

Place `exists`, `insert`, `resize`, `run`, and `main` in C++, TypeScript, and
Python files. Assert no cross-language `CALLS` edge without import, member,
FFI, generated-binding, or other explicit boundary evidence.

### P2: Freshness semantics are inconsistent at legacy surfaces, not absent

The report correctly identifies confusing output, but the representative
`isStale=false` plus `freshnessState=dirty` pair is not inherently
contradictory when `isStale` means commit mismatch and `dirty` means worktree
coverage.

Current source now separates these concepts in the shared capability envelope:

- `ontoindex/src/mcp/shared/response-envelope.ts:22` exposes status,
  `isStale`, dirty workspace details, scope confidence, and runtime health;
- `deriveEnvelopeFreshness` maps a commit-matched dirty worktree to
  `status: degraded` with reason `dirty-worktree-overlay`;
- `ontoindex/src/mcp/shared/target-context.ts:80` tracks staged, unstaged,
  untracked, and unknown graph coverage counts;
- `gn_ensure_fresh` still exposes the older top-level commit-only boolean.

Therefore the issue is a legacy contract and cross-tool consistency problem,
not a missing data model. Replacing the model again would add churn.

**Required fix**

Document `isStale` as commit staleness, preserve the shared envelope as the
canonical contract, and migrate legacy tools to it. Add explicit aliases only
if needed for compatibility, such as `commitFresh` and
`worktreeRepresented`; do not create another parallel freshness model.

**Verification**

Run clean, dirty commit-matched, stale clean, stale dirty, and untracked-source
cases through ensure-fresh, search, inspect, impact, and diff tools. The same
canonical tuple and repair action must be present everywhere.

### P2: Optional enrichment metadata is appended even when unused

Current source confirms the response bloat:

- `ontoindex/src/mcp/local/local-backend.ts:2045` always adds an `enrichment`
  object to object-shaped query, context, and impact results;
- a missing store includes eight zero status counts, two request counts, and a
  null lock;
- this happens even when enrichment fact consumption was not requested.

The report's exact occurrence counts were not reproduced, but the behavior is
deterministic in current source.

**Required fix**

For normal calls, emit a compact state such as
`enrichment: { status: "unavailable", reason: "missing-store" }`. Include
counts, lock state, repair guidance, and vector diagnostics only when requested
or when they materially degrade the requested operation. A new session-level
capability service is unnecessary unless compact per-call flags remain
measurably expensive.

**Verification**

Snapshot query, context, and impact responses with optional capabilities
available and unavailable. Default diagnostic metadata must stay below a fixed
small byte budget and detailed diagnostics must remain available through an
explicit opt-in.

## Recommended Implementation Order

1. Trace and fix the 64 KiB response boundary across Ontocode and OntoIndex.
2. Route MCP refresh through the existing asynchronous analysis job manager.
3. Add typed dirty-source resolution failures and bounded file-local lookup.
4. Add the multilingual common-name fixture, then constrain global fallback.
5. Migrate remaining legacy freshness outputs to the shared envelope.
6. Compact default optional-capability metadata.

## Acceptance Gate

Do not close the external report from unit tests alone. Re-run the original
JSONL classifier on an Ontocode build containing the fixes and attach:

- the frozen file manifest and event timestamp range;
- tool and client versions;
- byte counts at each response boundary;
- refresh job lifecycle events;
- dirty-symbol resolution reason counts;
- multilingual fixture results;
- before/after response-size distributions.

The originating corpus should remain immutable for comparison. A new evidence
window should demonstrate the fix rather than rewriting the original counts.

## 2.1.5 Implementation Status

Prepared on 2026-08-06 against package version `2.1.5`:

| Finding | Current status | Evidence |
|---|---|---|
| Auto-refresh exceeds MCP lifecycle | Fixed in OntoIndex | `gn_ensure_fresh` submits a durable analysis job and `gn_analyze_job` observes it; embedded-repository and symlink regressions pass. |
| Response cap corrupts structured output | Fixed at OntoIndex boundary; Ontocode transport verification remains | MCP server pagination emits request-bound UTF-8 pages with integrity cursors; unit coverage verifies reconstruction and byte limits. |
| Dirty-worktree symbol resolution fails | Fixed for bounded source-only identity | Modified and untracked file paths return typed source-only identity without claiming graph impact; focused impact tests pass. |
| Freshness status is contradictory | Fixed in shared capability envelope | Target context and review surfaces distinguish commit freshness, dirty overlay, scope confidence, and graph authority. |
| False cross-language call edges | Fixed for global fallback | Global call authority now requires language compatibility; mixed-language extraction coverage passes. |
| Optional capability diagnostics dominate output | Fixed for default LocalBackend reads | Default enrichment is compact and fact/detail payloads remain opt-in; LocalBackend focused gate passes. |

Release validation completed: 454 unit files with 6,876 tests passed and 64
skipped; 83 integration files passed and 4 skipped with 2,598 tests passed and
244 skipped; 46 Python tests passed; TypeScript, builds, formatting, lint, and
the `2.1.5` npm publish dry-run passed.

The report cannot be closed solely from repository validation. The Ontocode team
still needs a new immutable JSONL evidence window to verify the client transport
boundary, response reconstruction, and before/after operational distributions.
