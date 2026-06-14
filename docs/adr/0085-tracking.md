# ADR 0085 Tracking

**ADR:** [0085-mcp-repo-resolution-without-env-harness.md](./0085-mcp-repo-resolution-without-env-harness.md)
**Status:** In progress
**Updated:** 2026-06-14

## Reconciled Baseline

- Existing dirty worktree is one dominant MCP hardening stream plus release/doc updates.
- No active `bundle/*`, `refactor/*`, `split/*`, or `feature/*` branches.
- Pre-existing MCP hardening work already covers:
  - startup mismatch blocking;
  - repo-resolution error formatting;
  - `mcp-doctor` introduction;
  - repo identity on structured scoped responses;
  - `gn_diagnose` misconfiguration reporting.

## Task Ledger

| ID | Task | Owner | Status | Notes |
|---|---|---|---|---|
| T1 | Reconcile current MCP hardening work against ADR 0085 and keep only the core-extension delta | manager | completed | Current stream already aligns with diagnostics/error surfacing; tracker opened from reconciled baseline |
| T2 | Add first-class MCP startup selectors so repo binding does not require env-only harness | manager | completed | Added `ontoindex mcp --project <path>` and covered CLI startup expectations with focused tests |
| T3 | Change shared resolution order to explicit args -> cwd/registry -> env fallback -> single-repo fallback | manager | completed | `resolveTargetContext` now supports explicit `projectPath` and prefers explicit project/cwd before env fallback; MCP startup accepts `--project` |
| T4 | Move setup/repair messaging from env-first guidance to arg-first guidance while keeping env compatibility | manager | completed | Setup now emits `mcp --project <path>` entries; repo-resolution errors, `mcp-doctor`, and `gn_diagnose` now prefer arg-first restart commands |
| T5 | Add focused regression coverage for no-arg cwd binding, explicit selector mismatch, ambiguity, and env fallback compatibility | manager | completed | Focused tests cover `mcpCommand`, `target-context`, `setup`, `mcp-doctor`, repo-resolution formatting, and `gn_diagnose` |
| T6 | Refresh OntoIndex index after each completed task and run focused validation | manager | completed | Targeted vitest: 77 passed; `npx tsc --noEmit` passed; analyze/status refresh confirmed `78e4dac` up to date |

## Constraints

- Must extend current `cli/mcp.ts`, `mcp/shared/target-context.ts`, and current diagnostics surfaces.
- Must not introduce a new MCP config database or separate daemon family.
- Must not silently choose the first repo in the registry.
- Must fail loudly on ambiguous or mismatched repo targeting unless explicit override is present.
- Sub-agent preference remains `gpt-5.4-mini`; if worker dispatch is unavailable, manager completes locally as senior.
