# ADR 0086: CodeGraph-Inspired Agent Runtime Freshness and Budget Controls

**Status:** Implemented - Core Runtime Health and Budget Contract
**Date:** 2026-06-16
**Source:** `./tmp/codegraph` donor review, narrowed against current OntoIndex analyze/status, MCP
runtime, setup/doctor, response-envelope, and output-budget surfaces.

## Context

The donor project `codegraph` contains several useful implementation ideas:

- client installer targets for Claude, Cursor, Codex, opencode, Hermes, Gemini, Antigravity, and
  Kiro;
- MCP daemon registry and liveness management;
- file watcher based sync with degraded-mode reasons;
- bounded MCP output contracts;
- recoverable success-shaped "not indexed" responses;
- query-context extraction that recognizes code-like tokens.

OntoIndex already has:

- a richer graph model and Ladybug-backed index;
- `analyze`, `status`, `setup`, `mcp`, and `mcp-doctor` CLI surfaces;
- shared MCP target-context and response-envelope code;
- diff-impact, review, audit, docs, wiki, and graph export surfaces;
- ADR 0085 for deterministic MCP repo resolution.

So a generic "import CodeGraph ideas" proposal is too broad and mostly not new. The real useful
delta is narrower:

```text
Existing OntoIndex graph + MCP runtime
  -> one shared runtime-health contract
  -> bounded agent response profiles
  -> recoverable runtime states
  -> safer setup/doctor checks
```

## Review and Challenge

Architecture-fit gate:

1. **Real new functionality gate:** partial pass. Storage, graph extraction, MCP querying, and
   client setup already exist. OntoIndex also already has partial analysis checkpoints, response
   freshness envelopes, and `mcp-doctor`. The new functionality is only the missing shared
   runtime-health contract that connects those pieces and makes high-volume MCP output budgeted by
   default.
2. **Core-extension gate:** pass only for changes that extend current OntoIndex analyze/status,
   MCP, setup/doctor, and response-envelope paths. Reject changes that replace LadybugDB, create a
   second graph store, duplicate the MCP frontier, add a watcher service, or add a detached daemon
   product.

Challenge findings:

1. **Do not copy CodeGraph wholesale.**
   OntoIndex has a broader core graph and audit model. CodeGraph is useful as a runtime ergonomics
   donor, not as an architecture replacement.
2. **Freshness must use existing evidence first.**
   `analysis-checkpoint.json`, `analyze.lock`, git dirty state, target-context freshness, and
   `mcp-doctor` already exist. Use them before inventing watcher state.
3. **Liveness must remain attached to `mcp-doctor`.**
   A new daemon family or persistent daemon registry would split the runtime. Process checks should
   be best-effort diagnostics inside existing doctor/setup paths.
4. **Output budgets are core agent safety.**
   Dirty worktrees and broad impact queries already produce large responses. Budgeting belongs in
   shared MCP response helpers, not one tool at a time.
5. **Recoverable failures should not look like crashes.**
   "Repo not indexed", "index stale", "runtime degraded", and "output truncated" should return
   structured states with repair commands.

## Decision

Add one native OntoIndex capability:

**a shared agent runtime-health and budget contract for MCP-backed workflows.**

This includes:

1. one runtime-health shape reused by `status`, `mcp-doctor`, and MCP response metadata;
2. shared adaptive output budgets for high-volume MCP responses;
3. success-shaped recoverable error envelopes with exact repair commands;
4. setup/doctor validation for configured MCP clients.

This ADR does **not** approve:

- replacing LadybugDB with SQLite;
- copying CodeGraph's MCP tools as a parallel frontier;
- always-on background analyze by default;
- a second daemon/runtime command family detached from `ontoindex mcp`;
- a file watcher service or incremental indexing design;
- bundled runtime or installer rewrites unrelated to MCP setup correctness;
- telemetry, hosted service, or external state requirements.

## What Is New

### Runtime Freshness State

New capability:

- expose one shared runtime-health object that says whether the current MCP/runtime view is clean,
  stale, dirty, degraded, or untrusted after a failed analyze.

This extends existing `status`, `mcp-doctor`, and MCP response metadata. It must not require a new
index format or file watcher.

Minimum state fields:

- `repoLabel`
- `repoPath`
- `indexedCommit`
- `currentCommit`
- `dirtyWorktree`
- `freshnessState`
- `degradedReason`
- `repairCommand`

Source evidence should come from existing native paths:

- `analysis-checkpoint.json`;
- `analyze.lock`;
- `meta.json`;
- target-context freshness;
- git dirty worktree checks;
- `mcp-doctor` diagnostics.

### MCP Liveness Check

New capability:

- report active OntoIndex MCP processes by repo binding, PID, command, cwd, package version, and
  liveness state where the platform can discover them.

This extends existing MCP startup and doctor flows. It should not introduce a persistent daemon
registry in phase 1.

### Adaptive Agent Output Budgets

New capability:

- shared response-budget profiles for MCP tools that can emit very large payloads.

Initial profiles:

- `summary` for default agent answers;
- `detailed` for bounded evidence;
- `full` only when explicitly requested and safely capped;
- cursor/token metadata when a response was truncated.

First target surfaces:

- `impact({ action: "diff" })`;
- audit report and audit verify;
- docs/readiness outputs;
- graph/wiki export diagnostics where large lists appear.

### Recoverable Runtime Envelopes

New capability:

- return structured recoverable states instead of ambiguous failures for:
  - repo not indexed;
  - stale index;
  - wrong repo binding;
  - response truncated;
  - analyze failed after partial writes.

The response must include a short human message and an exact retry or repair command.

### Setup and Doctor Client Checks

New capability:

- `setup` and `mcp-doctor` should validate configured MCP clients and report whether their command,
  cwd, repo binding, and package path point at the intended repo.

This extends existing setup/doctor behavior and complements ADR 0085.

## Integration with Current Core Solutions

### Analyze and Status

Extend the current analyze/status path to write and read trustworthy run state:

- last successful analyze metadata;
- last failed analyze metadata;
- crash/unclean lock indicators;
- native writer availability;
- safe repair guidance.

The status command should not mark a repo "up to date" solely because `meta.json` was written if a
later phase crashed before clean completion.

### MCP Runtime

Extend current MCP startup and response-envelope code:

- bind every response to resolved repo identity;
- include freshness/liveness warnings where relevant;
- expose truncation and cursor metadata through one shared helper.

Do not add separate per-tool repo resolution or per-tool truncation logic.

### Installer and Doctor

Reuse current setup/doctor flow to inspect client configs. Approved checks:

- client command exists;
- configured package path exists;
- configured cwd resolves to intended repo;
- configured repo label/path matches registry;
- generated config uses explicit selector or deterministic cwd binding.

## Rejected or Postponed Donor Ideas

| Donor idea                          | Decision | Reason                                                                          |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------- |
| SQLite/FTS replacement store        | Reject   | Parallel storage model; does not extend OntoIndex core.                         |
| Copy CodeGraph MCP tools            | Reject   | Duplicate frontier; OntoIndex already has richer MCP surfaces.                  |
| Always-on auto-indexing by default  | Reject   | Unsafe for large repos and native writer crash recovery.                        |
| File watcher sync service           | Postpone | Not needed for phase 1; git dirty state and checkpoint files are enough.        |
| Bundled no-Node runtime             | Postpone | Packaging issue, not core graph/runtime functionality.                          |
| Hosted telemetry or usage analytics | Reject   | Not required for local-first core.                                              |
| Full framework extractor copy       | Postpone | Must be handled as language/provider-specific ingestion work, not donor import. |
| New daemon command family           | Reject   | Liveness must extend `ontoindex mcp` and doctor, not split runtime.             |

## Implementation Plan

### Phase 1: Diagnostic-Only Runtime State

1. Define one runtime-health type from existing checkpoint, lock, metadata, git, and target-context
   evidence.
2. Teach `status` to report unclean locks, failed phases, and trust state from that type.
3. Reuse the same type in MCP response metadata for repo identity and freshness warnings.
4. Add best-effort `mcp-doctor` liveness checks for active MCP processes where discoverable.
5. Add shared output budget helper and apply it to `impact({ action: "diff" })`.

### Phase 2: Recoverable Response Contracts

1. Normalize "not indexed", "wrong repo", "stale", and "truncated" responses into structured
   recoverable envelopes.
2. Add exact repair commands to all recoverable states.
3. Add regression tests for response shapes.

### Phase 3: Setup and Doctor Client Validation

1. Validate configured MCP client command/cwd/repo bindings.
2. Report exact mismatches and repair commands.
3. Cover common clients already supported by existing setup flow.

## Acceptance Criteria

- `ontoindex status` distinguishes clean, stale, unclean, failed, and unknown trust states.
- MCP responses include repo identity and freshness metadata without bloating small responses.
- `impact({ action: "diff" })` has a summary-first default and cannot flood the agent context.
- Recoverable runtime states return structured JSON with repair commands.
- `mcp-doctor` can identify wrong-repo MCP binding without manual `ps` inspection.
- No new graph store, no file watcher, no duplicate MCP frontier, and no automatic background index
  writes are added.

## Risks

- Process liveness checks can be platform-sensitive and incomplete. They must degrade cleanly.
- Output budgeting can hide useful evidence. Every truncated response must include cursor or retry
  guidance.
- Crash-state hardening must not incorrectly invalidate healthy indexes.

## Status Tracking

Implementation was tracked in `docs/adr/0086-tracking.md`. The shipped slice is intentionally
limited to runtime health, recoverable MCP states, bounded diff output, setup validation, and doctor
liveness checks.
