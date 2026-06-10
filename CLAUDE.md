<!-- version: 1.7.2 -->
<!--
  Metadata: version, last reviewed, scope, model policy, reference docs, changelog.
  Last updated: 2026-05-06
-->

Last reviewed: 2026-04-27

**Project:** OntoIndex · **Environment:** dev · **Maintainer:** repository maintainers (see GitHub)

Follow **AGENTS.md** for the canonical rules; this file adds Claude Code–specific deltas. Cursor-specific notes live only in `AGENTS.md`.

## Scope

See the **Scope** table in [AGENTS.md](AGENTS.md) for read/write/execute/off-limits boundaries. Cursor-specific workflow notes also live only in AGENTS.md.

## Model Configuration

- **Primary:** Pin per **Claude Code** / Anthropic org policy (explicit model id). Do not rely on an unversioned `latest` alias for governed workflows.
- **Fallback:** As configured in Claude Code (organization default or user override).
- **Notes:** The OntoIndex CLI analyzer does not call an LLM.

## Communication Style

For Claude Code chat in this repository, talk like a caveman: short, blunt sentences with simple words. Keep code, commands, file paths, API names, and technical facts exact.

## Resource Budget

Follow [AGENTS.md](AGENTS.md#resource-budget): OntoIndex processes started by Claude Code must target at most 25% of host CPU capacity. On this 28-logical-CPU host, use `ONTOINDEX_MAX_WORKERS=7` or lower for analyze/index work, keep MCP scoped to one repo, and do not auto-analyze from MCP unless explicitly requested.

## Execution Sequence (complex tasks)

Same discipline as [AGENTS.md](AGENTS.md): before large multi-step work, state which **AGENTS.md** / **GUARDRAILS.md** rules apply, current **Scope**, and planned validation commands (`npm test`, `tsc`, etc.). When pausing, summarize progress in the chat or a **local** scratch file (do not add `HANDOFF.md` to the repo), then `/clear` and resume with that summary.

## Code change discipline

**IMPORTANT:** Try to preserve the original code and the logic of the original code as much as possible.

- Make the *minimum* edit that satisfies the task. Do not rewrite working code that happens to be on screen.
- Do not refactor adjacent untouched code as a "while you're there" cleanup unless the task explicitly asks for it.
- Do not change identifier names, control-flow shape, or error-handling structure unless the task requires it.
- Do not "improve" code style, formatting, or import order in files you are otherwise not editing.
- When the original code has a non-obvious shape (defensive guards, redundant checks, ordered imports, unusual control flow), assume there is a reason and preserve it unless the task explicitly removes it.
- If you believe a refactor is warranted, propose it as a separate bundle and ask before executing.

This applies to bug fixes, feature additions, and refactors alike. Smaller diffs are easier to review, easier to revert, and less likely to introduce regressions in unrelated code paths.

## Branch & Artifact Hygiene (H0–H10)

Apply the hard rules in [AGENTS.md § Branch & Artifact Hygiene](AGENTS.md#branch--artifact-hygiene-hard-rules). Key triggers for Claude Code specifically:

- **H0** — at session start, if `git status` shows ≥ 10 untracked files or there are ≥ 10 open `bundle/*` branches, your first turn is triage, not new work.
- **H1, H2** — before `git checkout -b bundle/...` scan for overlapping existing branches; if ≥ 10 refactor branches already exist, halt and ask.
- **H4** — do not write a new `*_PLAN.md` / `*_TASKS.md` / `*_AUDIT*.md` when ones already exist; edit the existing one or delete the stale ones in the same commit.
- **H5** — cleanup (delete merged branch, remove planning-doc residue, remove untracked scratch tests) is part of "done," not a future session's problem.
- **H9** — never claim "tests pass" without a pre-change baseline when the suite had pre-existing failures.
- **H10** — verify push access to `origin` before attempting a push.

## Claude Code hooks

Prefer **PreToolUse** hooks for hard gates (e.g. tests before `git_commit`). Adapt hook commands to `ontoindex/` npm scripts.

## Context budget

If always-on instructions grow, load deep conventions via conditional reads (e.g. *“When writing new code, read STANDARDS.md”*) instead of pasting long blocks here. In Cursor, prefer `.cursor/index.mdc` plus optional `.cursor/rules/*.mdc` globs (see [AGENTS.md](AGENTS.md) § Context budget).

## Reference Documentation

- **This repository:** [AGENTS.md](AGENTS.md) (Cursor + monorepo notes), [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), [GUARDRAILS.md](GUARDRAILS.md).
- **Call-resolution DAG:** See ARCHITECTURE.md § Call-Resolution DAG. Shared pipeline code in `ontoindex/src/core/ingestion/` must not name languages — use `LanguageProvider` hooks instead (see AGENTS.md).
- **OntoIndex:** `.claude/skills/ontoindex/`; MCP and indexed-repo rules live only in [AGENTS.md](AGENTS.md) (`ontoindex:start` … `ontoindex:end`). See **OntoIndex rules** below.

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-05-06 | 1.7.2 | Added Claude Code communication style: short caveman-style chat while preserving exact technical terms. |
| 2026-05-05 | 1.7.1 | Added resource budget pointer: OntoIndex processes should use at most 25% CPU capacity. |
| 2026-05-01 | 1.7.0 | SF-Phase-5 W5b — added § Recommended workflow (super-functions) to OntoIndex rules block; updated Always Do + Never Do to recommend `gn_safe_edit_check`, `gn_pre_commit_audit`, `gn_explore`, `gn_quality_mode`, `gn_help`; primitives demoted to escape hatch. |
| 2026-04-29 | 1.6.0 | Updated OntoIndex index stats (20074→20379 symbols, 28582→28937 relationships); added drift warning note per H-4 option (c). |
| 2026-04-27 | 1.5.0 | Added § Code change discipline — preserve original code and logic; minimum-edit rule; no opportunistic refactors. |
| 2026-04-21 | 1.4.0 | Referenced AGENTS.md § Branch & Artifact Hygiene (H0–H10); session-start triage gate, branch-reuse check, cleanup-is-done rule. |
| 2026-04-13 | 1.3.0 | Updated OntoIndex index stats after DAG refactor. |
| 2026-03-24 | 1.2.0 | Removed duplicated ontoindex:start block and scope table; replaced with pointers to AGENTS.md. |
| 2026-03-23 | 1.1.0 | Updated agent instructions to match AGENTS.md. |
| 2026-03-22 | 1.0.0 | Added structured header and changelog. |

---

## OntoIndex rules

See the generated OntoIndex block in **[AGENTS.md](AGENTS.md)** for the canonical MCP tools, impact analysis rules, and index instructions.

<!-- ontoindex:start -->
# OntoIndex — Code Intelligence

This project is indexed by OntoIndex as **OntoIndex** (34983 symbols, 52219 relationships, 300 execution flows). Use the OntoIndex MCP tools to understand code, assess impact, and navigate safely.

> If any OntoIndex tool warns the index is stale, coordinate first; exactly one process should run `ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js analyze`.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `ontoindex_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `ontoindex_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `ontoindex_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `ontoindex_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `ontoindex_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `ontoindex_rename` which understands the call graph.
- NEVER commit changes without running `ontoindex_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `ontoindex://repo/OntoIndex/context` | Codebase overview, check index freshness |
| `ontoindex://repo/OntoIndex/clusters` | All functional areas |
| `ontoindex://repo/OntoIndex/processes` | All execution flows |
| `ontoindex://repo/OntoIndex/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/ontoindex/ontoindex-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/ontoindex/ontoindex-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/ontoindex/ontoindex-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/ontoindex/ontoindex-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/ontoindex/ontoindex-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/ontoindex/ontoindex-cli/SKILL.md` |

<!-- ontoindex:end -->
