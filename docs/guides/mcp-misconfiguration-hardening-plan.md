# MCP Misconfiguration Hardening Plan

Status: Challenged and narrowed
Owner: OntoIndex maintainers
Scope: OntoIndex MCP runtime, target-context resolution, diagnostics, and CLI setup validation
Created: 2026-06-14
Last reviewed: 2026-06-14

## Goal

Prevent OntoIndex MCP sessions from returning graph evidence for the wrong repository. A miswired MCP service must fail early, and repo-scoped object or envelope responses must clearly identify the repository path they used while legacy array/scalar responses preserve compatibility unless callers opt into the explicit repo identity envelope path.

## Architecture Fit Gate

- Real new functionality: yes, but only for the missing deltas. Existing startup mismatch checks, target-context resolution, and response envelopes already cover part of the problem.
- Core-extension fit: yes. This plan extends `cli/mcp.ts`, `mcp/shared/target-context.ts`, `mcp/local/local-backend.ts`, `mcp/super/diagnose.ts`, and the existing CLI command registry. It must not add a second registry, a second repo resolver, a parallel MCP process manager, or a detached diagnostic subsystem.

## Challenge Summary

1. **Do not treat startup mismatch detection as greenfield.** `cli/mcp.ts` already blocks some absolute-path `ONTOINDEX_MCP_REPO` versus `ONTOINDEX_MCP_PROJECT_CWD` mismatches. The remaining work is label resolution, cwd comparison, clearer errors, and tests.
2. **Do not require `repoPath` on truly global tools.** Tools such as `gn_help` and `gn_tool_contract` are global by design. The hard requirement should apply to repo-scoped graph/docs/audit evidence, while global tools should explicitly say `scope: "global"`.
3. **Do not build a new repo resolver for better errors.** `resolveTargetContext` and `LocalBackend.resolveRepo` must share formatting helpers, not diverge.
4. **Do not use `ontoindex mcp doctor` unless the CLI is intentionally restructured.** `ontoindex mcp` currently starts the stdio server. A non-breaking command such as `ontoindex mcp-doctor` is safer for the first release.
5. **Do not make dirty worktrees equivalent to miswire.** Dirty overlays reduce confidence, but repo-target mismatch is a P1 configuration error. Diagnostics must keep those categories separate.

## Selected Fixes

This plan implements the selected options only:

3. Startup hard-fail on env/cwd mismatch.
4. Add repo scope identity to repo-scoped object and envelope MCP responses while preserving legacy array/scalar compatibility.
5. Make multi-repo errors actionable.
6. Add `gn_diagnose` miswire checks.
7. Add an MCP doctor command.

## Current Implementation Seams

- MCP startup guard: `ontoindex/src/cli/mcp.ts`
- Shared target context and freshness envelope: `ontoindex/src/mcp/shared/target-context.ts`
- Runtime repo resolver and current error text: `ontoindex/src/mcp/local/local-backend.ts`
- Diagnostic report assembly: `ontoindex/src/mcp/super/diagnose.ts`
- Response envelope creation: `ontoindex/src/mcp/shared/response-envelope.ts`
- MCP server dispatch and error handling: `ontoindex/src/mcp/server.ts`
- Public tool registration and facade inventory: `ontoindex/src/mcp/shared/tool-registry.ts`
- CLI command registration: `ontoindex/src/cli/index.ts`

## Observed Runtime Evidence

The current session reproduced the failure mode this plan addresses:

- MCP service name: `mcp__ontoindex`
- Actual exposed repo: `codex`
- Actual repo path: `/opt/demodb/_workfolder/ontocode`
- `repo:"ontoindex"` fails with `Repository "ontoindex" not found. Available: codex`
- Local CLI for the OntoIndex repository works and the index is now current:
  - indexed commit `78e4dac`
  - current commit `78e4dac`

This confirms the problem is not only index freshness. It is service target clarity.

## Workstream 1: Complete Startup Mismatch Gate

Problem:

`cli/mcp.ts` already checks some path mismatches, but it does not fully resolve repo labels before comparing targets and it does not fully classify cwd/env/repo-filter conflicts.

Required Delta:

- Keep the existing `ONTOINDEX_MCP_ALLOW_REPO_MISMATCH=1` override.
- Resolve label-based `ONTOINDEX_MCP_REPO` through the registry before comparing paths.
- Compare:
  - executable cwd git root
  - `ONTOINDEX_MCP_PROJECT_CWD`
  - `ONTOINDEX_MCP_REPO` resolved path
  - `--repo` resolved path
  - `preferredProjectPath`
- Fail startup before `startMCPServer` when the resolved target repo and project cwd are different and no override is set.
- When failing, print a copy-paste restart command.

Acceptance Criteria:

- `ONTOINDEX_MCP_REPO=codex` and `ONTOINDEX_MCP_PROJECT_CWD=/opt/demodb/_workfolder/OntoIndex` fails if `codex` resolves to `/opt/demodb/_workfolder/ontocode`.
- Matching label/path combinations succeed.
- `ONTOINDEX_MCP_ALLOW_REPO_MISMATCH=1` downgrades failure to a loud warning.
- Startup logs include resolved `repoLabel`, `repoPath`, `projectCwd`, and executable cwd.

Tests:

- Unit test label and absolute-path mismatch resolution.
- Unit test Windows-style absolute paths.
- Integration-style test with fake registry entries for repo A and repo B.

## Workstream 2: Repo Scope Identity In Repo-Scoped Responses

Problem:

Repo-scoped MCP results can contain graph evidence without a consistent top-level identity. Agents need a stable place to check which repo produced the answer.

Required Delta:

- For envelope-capable tools, require `targetContext.repoLabel` and `targetContext.repoPath` when the tool reads repo graph/docs/audit evidence.
- For legacy object response shapes, add a compact top-level fallback:

```json
{
  "repoLabel": "codex",
  "repoPath": "/path/to/repo"
}
```

- Preserve legacy array/scalar response shapes by default; provide an explicit repo identity envelope path for callers that need repo identity around those shapes.
- For representative global success tools, return explicit global context instead of pretending a repo was used:

```json
{
  "targetContext": {
    "scope": "global",
    "reason": "tool contract is global by default"
  }
}
```

Priority tools:

- Facades: `discover`, `search`, `inspect`, `impact`, `docs`, `audit`, `refactor`, `manage`
- Safety/review: `gn_verify_diff`, `gn_pre_commit_audit`, `gn_diff_impact`, `gn_review_diff`, `gn_safe_edit_check`
- Lifecycle/audit: session start/verify/dedupe/bundle/dispatch/review/export/replay

Acceptance Criteria:

- Repo-scoped object and envelope responses contain `targetContext.repoPath` or top-level `repoPath`.
- Legacy repo-scoped array/scalar responses preserve their original shape by default and can be wrapped explicitly when callers need repo identity.
- Representative global public success responses declare global scope.
- Error responses preserve target identity when repo resolution reached a scoped service.

Tests:

- Representative contract tests for one facade, one `gn_*` compatibility tool, one global success tool, one repo-not-found error, and explicit envelope wrapping for legacy array/scalar shapes.
- Focused response-envelope tests for preserved legacy shapes and explicit wrapper behavior.

## Workstream 3: Actionable Multi-Repo Errors

Problem:

Current errors are too short:

```text
Repository "ontoindex" not found. Available: codex
```

They omit repo paths, active environment, and exact retry/restart commands.

Required Delta:

- Add one shared formatter used by both `LocalBackend.resolveRepo` and `target-context.ts`.
- Include:
  - requested repo
  - available labels and paths
  - active `ONTOINDEX_MCP_REPO`
  - active `ONTOINDEX_MCP_PROJECT_CWD`
  - explicit retry using an available label
  - restart command for the intended absolute path when known
- Keep the message bounded for MCP clients.

Example:

```text
Repository "ontoindex" not found.
Available:
- codex -> /opt/demodb/_workfolder/ontocode

Current MCP scope:
- ONTOINDEX_MCP_REPO=/opt/demodb/_workfolder/ontocode
- ONTOINDEX_MCP_PROJECT_CWD=/opt/demodb/_workfolder/ontocode

Retry:
  repo: "codex"

To use another project, restart MCP with:
  ONTOINDEX_MCP_REPO=/absolute/path/to/project
  ONTOINDEX_MCP_PROJECT_CWD=/absolute/path/to/project
```

Acceptance Criteria:

- Unknown repo errors include labels and paths.
- Ambiguous repo errors include exact retry examples.
- No indexed repo errors still point to `ontoindex analyze`.
- Messages are deterministic enough for tests.

Tests:

- Unit tests for missing repo, multiple repos, no repos, env-scoped repo, path match, label match, and Windows paths.

## Workstream 4: `gn_diagnose` P1 Miswire Detection

Problem:

`gn_diagnose` already reports env vars, target context, freshness, embeddings, LSP, and tool contract. It does not promote repo-target mismatch to a first-class P1 diagnosis.

Required Delta:

- Add a `misconfiguration` section:

```json
{
  "misconfiguration": {
    "status": "fail",
    "severity": "P1",
    "reason": "mcp-service-target-mismatch",
    "activeRepoLabel": "codex",
    "activeRepoPath": "/opt/demodb/_workfolder/ontocode",
    "projectCwd": "/opt/demodb/_workfolder/OntoIndex",
    "recommendedCommand": "..."
  }
}
```

- Detect:
  - `ONTOINDEX_MCP_REPO` path differs from `ONTOINDEX_MCP_PROJECT_CWD`.
  - cwd resolves to a different registry entry than env repo.
  - explicit repo resolves to a different path than env repo.
  - service exposes only repo A while the requested repo is repo B.
- Add recommendation severity `ERROR` with reason `P1`.
- Keep missing embeddings and dirty worktree as degraded, not P1.

Acceptance Criteria:

- Miswire produces `degradedContext.affectedAreas` containing `repo-targeting`.
- Miswire recommendation appears before embeddings/LSP recommendations.
- `gn_diagnose` distinguishes `dirty-worktree-overlay` from `mcp-service-target-mismatch`.

Tests:

- Unit tests with injected env vars and fake registry.
- Regression test for this exact case: service exposes `codex`; request uses `ontoindex`.

## Workstream 5: MCP Doctor CLI

Problem:

Users need a one-shot CLI command for setup validation before starting a long MCP session.

Command Shape Challenge:

`ontoindex mcp` currently starts the stdio server. Do not make `ontoindex mcp doctor` unless the `mcp` command is intentionally converted into a command group. For the first implementation, prefer the non-breaking command:

```bash
ontoindex mcp-doctor
```

Options:

```bash
ontoindex mcp-doctor --repo <label-or-path>
ontoindex mcp-doctor --project-cwd <path>
ontoindex mcp-doctor --symbol <symbol>
ontoindex mcp-doctor --json
```

Checks:

- current cwd git root
- `ONTOINDEX_MCP_REPO`
- `ONTOINDEX_MCP_PROJECT_CWD`
- registry resolution
- `.ontoindex` presence
- `status` freshness
- `discover repos` equivalent
- repo resolver miss/error formatting
- optional `search`, `inspect`, and `impact` smoke checks when `--symbol` is supplied

Verdicts:

- `READY`: repo target is unambiguous and index is usable.
- `DEGRADED`: target is correct but quality is reduced, such as dirty worktree, missing embeddings, or missing docs sidecar.
- `MISCONFIGURED`: target repo cannot be resolved or env/cwd point to different repos.

Acceptance Criteria:

- Exit code `0` for `READY` and `DEGRADED`.
- Exit code non-zero for `MISCONFIGURED`.
- `--json` output is stable enough for issue reports.
- Text output ends with copy-paste setup or restart commands.

Tests:

- CLI tests for ready, dirty/degraded, missing index, unknown repo, env/cwd mismatch, and stale index.
- JSON snapshot for the observed `codex` versus `ontoindex` mismatch.

## Delivery Order

1. Implement shared repo identity and error formatter.
2. Extend startup mismatch gate to resolve labels through the registry.
3. Add repo/global target identity contract tests.
4. Add repo identity to facade responses.
5. Add repo identity to compatibility tools that still return legacy shapes.
6. Add `gn_diagnose` P1 miswire section.
7. Add `ontoindex mcp-doctor`.
8. Update README, MCP README, troubleshooting docs, and release notes.

## Tracking

- MCP-HARDEN-1 - DONE - Shared repo identity/error formatter. Validation: repo resolution, target-context, and repo runtime unit tests passed.
- MCP-HARDEN-2 - DONE - Startup mismatch label resolution. Validation: mcp-command, repo-resolution tests, build, and typecheck passed.
- MCP-HARDEN-3 - DONE - Repo/global response identity contract. Validation: systems-audit contract and typecheck passed.
- MCP-HARDEN-4 - DONE - Response identity for facade tools. Validation: repo identity decorator tests and typecheck passed.
- MCP-HARDEN-5 - DONE - Response identity for legacy compatibility tools. Validation: facade/super dispatch identity path and typecheck passed.
- MCP-HARDEN-6 - DONE - `gn_diagnose` P1 miswire section. Validation: diagnose P1 and non-P1 regression tests plus typecheck passed.
- MCP-HARDEN-7 - DONE - `ontoindex mcp-doctor` command. Validation: mcp-doctor, mcp-command, diagnose tests, and typecheck passed.
- MCP-HARDEN-8 - DONE - Docs and release notes. Validation: docs Prettier check, build, affected runtime tests, and typecheck passed.
- MCP-HARDEN-9 - DONE - Production `mcp-doctor --symbol` smoke checks. Validation: focused mcp-doctor tests and typecheck passed; index refresh reported up to date.
- MCP-HARDEN-10 - DONE - Scoped MCP error identity. Validation: mcp-server-error-path, response-envelope focused tests, and typecheck passed; index refresh reported up to date.
- MCP-HARDEN-11 - DONE - Repo identity without legacy shape breakage. Validation: legacy array/scalar shapes are preserved by default; response-envelope, calltool-dispatch, and typecheck passed; index refresh reported up to date.
- MCP-HARDEN-12 - DONE - Shell-safe repair commands. Validation: repo-resolution-errors and diagnose tests plus typecheck passed; index refresh reported up to date.
- MCP-HARDEN-13 - DONE - Shell-safe `mcp-doctor` fallback restart command. Validation: mcp-doctor regression test covers fallback paths with spaces; typecheck passed; index refresh reported up to date.
- MCP-HARDEN-14 - DONE - Representative global success response scope identity. Validation: `discover/tools` returns global `targetContext`; facade-completeness and typecheck passed; index refresh reported up to date.
- MCP-HARDEN-15 - DONE - Representative public response identity contract coverage. Validation: public-response-identity, facade-completeness, response-envelope tests, and typecheck passed; index refresh reported up to date.
- MCP-HARDEN-16 - DONE - Plan evidence and formatting cleanup. Validation: stale evidence removed; docs Prettier check passed.
- MCP-HARDEN-17 - DONE - Narrow repo identity done criteria. Validation: done criteria now distinguish object/envelope identity from legacy array/scalar compatibility.
- MCP-HARDEN-18 - DONE - Narrow global response scope proof. Validation: plan now states representative global success coverage instead of universal proof.
- MCP-HARDEN-19 - DONE - Stable tracking format. Validation: tracking is a Prettier-stable Markdown bullet ledger.
- MCP-HARDEN-20 - DONE - Current validation wording cleanup. Validation: stale historical wording replaced with current validation summaries.
- MCP-HARDEN-21 - DONE - Narrow top-level goal statement. Validation: goal now matches object/envelope identity plus explicit wrapper path for legacy array/scalar responses.
- MCP-HARDEN-22 - DONE - Align Workstream 2 with final compatibility contract. Validation: required delta, acceptance criteria, and tests now match representative coverage and legacy shape preservation.

## Done Criteria

- A miswired MCP process cannot silently serve a different repo unless the explicit override is set.
- Repo-scoped object and envelope responses identify the repo label and repo path they used.
- Legacy repo-scoped array/scalar responses preserve their original shape by default; callers that need identity for those shapes must use the explicit repo identity envelope path.
- Representative global public success responses declare global scope, with `discover/tools` covered as the current non-repo facade success path.
- Unknown-repo and multi-repo errors tell the user exactly how to retry or restart.
- `gn_diagnose` reports repo miswire as P1, not as generic degraded freshness.
- `ontoindex mcp-doctor --json` can be attached to issue reports.
- Existing CLI/MCP behavior remains backward compatible except for intentionally stricter startup failure on unsafe mismatches.
