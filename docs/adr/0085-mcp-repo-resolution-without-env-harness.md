# ADR 0085: MCP Repo Resolution Without Environment Harness

**Status:** Proposed - Challenged/Core Extension Only
**Date:** 2026-06-14
**Source:** MCP misconfiguration audit and repo-scope defect review; narrowed against current MCP startup, shared target-context resolution, and diagnostics surfaces.

## Context

OntoIndex already has:

- an MCP startup command in [ontoindex/src/cli/mcp.ts](/opt/demodb/_workfolder/OntoIndex/ontoindex/src/cli/mcp.ts:78);
- shared repo resolution and target context logic in [ontoindex/src/mcp/shared/target-context.ts](/opt/demodb/_workfolder/OntoIndex/ontoindex/src/mcp/shared/target-context.ts:116);
- startup mismatch and retry diagnostics in [ontoindex/src/mcp/shared/repo-resolution-errors.ts](/opt/demodb/_workfolder/OntoIndex/ontoindex/src/mcp/shared/repo-resolution-errors.ts:63);
- setup and doctor surfaces that currently teach or inspect MCP env wiring.

So "support MCP repo selection" is not new functionality.

The real missing capability is narrower:

```text
MCP startup + shared repo resolver
  -> deterministic repo binding without mandatory env harness
  -> cwd/registry based auto-resolution
  -> first-class explicit override flags
  -> loud mismatch failure instead of misleading cross-repo results
```

This matters because current behavior still depends too heavily on ambient
`ONTOINDEX_MCP_REPO` and `ONTOINDEX_MCP_PROJECT_CWD`, which makes cross-repo
miswiring easy and difficult to detect early.

## Review and Challenge

Architecture-fit gate:

1. **Real new functionality gate:** passes. This is not a rename or doc-only reframing; it changes how MCP binds a target repo without external harness requirements.
2. **Core-extension gate:** passes. The work extends existing MCP startup, target-context resolution, and diagnostics. It does not require a new server class, storage model, or detached workflow.

Challenge findings:

1. **The real defect is resolver fragility, not missing env vars.**
   OntoIndex already has repo selectors, cwd detection, and diagnostics, but the startup and request paths still let env wiring dominate too much.
2. **The fix must be centralized.**
   Ad hoc resolution in individual MCP tools will keep drifting. The binding policy has to live in one shared resolver used by startup and tool responses.
3. **The default must become cwd/registry driven.**
   `cd <repo> && ontoindex mcp` should work without extra harness variables in the common single-repo case.
4. **Explicit overrides still matter.**
   Multi-repo and automation scenarios need first-class `--repo` or `--project` flags.
5. **Mismatch must fail before serving data.**
   Wrong-repo answers are worse than startup failure.

## Decision

Add only one new core capability:

1. **deterministic MCP repo resolution without mandatory environment harness**, implemented as:
   - first-class explicit CLI selectors;
   - automatic cwd-to-registry resolution when selectors are absent;
   - env vars retained only as fallback/legacy override;
   - startup and request-time mismatch detection.

This ADR does **not** approve:

- a new standalone MCP config database;
- a separate daemon family per repo as the primary solution;
- silent fallback to "first repo in registry";
- per-tool custom repo resolution logic;
- keeping env vars as the primary generated setup path long-term.

## New Functionality Only

### First-class MCP target selectors

New capability:

- support explicit MCP startup selectors:
  - `ontoindex mcp --repo <label>`
  - `ontoindex mcp --project <absolute-path>`

This turns repo binding into visible startup contract instead of invisible shell state.

### Automatic cwd/registry binding

New capability:

- when no explicit selector is supplied, OntoIndex resolves the target repo from the current working directory and the shared registry.

Expected behavior:

1. if cwd is inside exactly one indexed repo path, bind to that repo;
2. if multiple indexed repos match, fail with exact retry examples;
3. if no indexed repo matches, fail with repair guidance.

### Shared resolution contract

New capability:

- MCP startup and MCP tool response identity must use the same shared repo-resolution contract.

That contract must return at least:

- `repoLabel`
- `repoPath`
- `resolutionSource`
- `warnings`
- mismatch/ambiguity state

## Integration with Current Core Solutions

### MCP startup

The implementation must extend [ontoindex/src/cli/mcp.ts](/opt/demodb/_workfolder/OntoIndex/ontoindex/src/cli/mcp.ts:78), not create a new startup command family.

Preferred command shape:

```bash
ontoindex mcp --project /abs/path/to/repo
ontoindex mcp --repo codex
```

Acceptable no-arg behavior:

```bash
cd /abs/path/to/repo
ontoindex mcp
```

### Shared target context

The implementation must extend [ontoindex/src/mcp/shared/target-context.ts](/opt/demodb/_workfolder/OntoIndex/ontoindex/src/mcp/shared/target-context.ts:116) so startup and runtime response identity share one resolution policy.

This means:

- no separate resolver for `gn_ensure_fresh`;
- no separate resolver for `gn_propose_location`;
- no separate resolver for audit/impact/inspect facades.

### Setup and diagnostics

The implementation should extend existing setup and diagnostics surfaces:

1. `setup` should generate first-class `--project` or `--repo` startup config;
2. `mcp-doctor` should report the resolution source and exact repair commands;
3. mismatch error formatting should stay in the existing repo-resolution diagnostics family.

## Algorithm / Technique

### Resolution order

Approved resolution order:

1. explicit `--project`
2. explicit `--repo`
3. cwd/registry longest-parent match
4. legacy env fallback:
   - `ONTOINDEX_MCP_REPO`
   - `ONTOINDEX_MCP_PROJECT_CWD`
5. single indexed repo fallback only when the registry contains exactly one repo

Anything ambiguous must fail, not guess.

### Shared resolver contract

Add or refactor toward one shared resolver with a shape equivalent to:

```ts
resolveMcpRepoContext({
  explicitProject,
  explicitRepo,
  cwd,
  registry,
  env,
})
```

Required result fields:

- resolved repo entry
- resolved repo path
- resolution source
- candidate list
- ambiguity state
- mismatch state
- repair suggestions

### Cwd-to-registry match

Approved matching rule:

1. normalize cwd to absolute path;
2. normalize every registry repo path to absolute path;
3. collect repo entries whose `repoPath` is a parent of cwd;
4. choose the longest matching parent path;
5. if multiple equal candidates remain, fail as ambiguous.

This extends the current direction in [target-context.ts](/opt/demodb/_workfolder/OntoIndex/ontoindex/src/mcp/shared/target-context.ts:125) but removes env-first dependence as the default path.

### Mismatch policy

If an explicit selector resolves to repo A while cwd resolves to repo B:

- fail startup by default;
- emit exact retry commands;
- require a deliberate override flag for cross-repo startup.

Cross-repo binding must be deliberate, never silent.

### Response identity

Structured MCP responses should continue to expose resolved repo identity using the same shared context:

- `repoLabel`
- `repoPath`
- `targetContext`
- `resolutionSource`

Legacy array/scalar response compatibility is preserved; identity for those continues through explicit envelope/structured modes rather than forced shape changes.

## Consequences

### Positive

- `cd repo && ontoindex mcp` works in the common case without env harness;
- repo selection behavior becomes deterministic and explainable;
- startup fails before misleading cross-repo answers are served;
- tool-specific resolver drift is reduced by centralizing policy.

### Negative

- startup logic becomes stricter and may reject previously tolerated ambiguous setups;
- setup/docs need coordinated updates because env-first examples become legacy guidance;
- a shared resolver refactor touches several existing MCP seams.

### Follow-up work

1. add `--project` to the MCP CLI;
2. centralize repo resolution contract;
3. switch setup output from env-first to arg-first;
4. update `mcp-doctor` and startup diagnostics;
5. add regression tests for:
   - single-repo cwd binding;
   - multi-repo ambiguity;
   - explicit selector mismatch;
   - env fallback compatibility.
