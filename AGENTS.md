<!-- version: 1.7.4 -->
<!-- Last updated: 2026-06-08 -->

Last reviewed: 2026-04-21

**Project:** OntoIndex · **Environment:** dev · **Maintainer:** repository maintainers (see GitHub)

## Scope

| Boundary | Rule |
|----------|------|
| **Reads** | `ontoindex/`, `ontoindex-web/`, `eval/`, plugin packages, `.github/`, `.ontoindex/`, docs. |
| **Writes** | Only paths required for the change; keep diffs minimal. Update lockfiles when deps change. |
| **Executes** | `npm`, `npx`, `node` under `ontoindex/` and `ontoindex-web/`; `uv run` for Python under `eval/`; documented CI/dev workflows. |
| **Off-limits** | Real `.env` / secrets, production credentials, unrelated repos, destructive git ops without confirmation. |

## Model Configuration

- **Primary:** Use a named model (e.g. Claude Sonnet 4.x). Avoid `Auto` or unversioned `latest` when reproducibility matters.
- **Sub-agents:** Prefer `gpt-5.3-codex-spark` for delegated sub-agent work when the sub-agent surface can enforce it. If the tool cannot select or verify the model, state the preference in the worker prompt, record the actual UI/runtime model when visible, and continue unless the user explicitly asks to block on exact model compliance.
- **Notes:** The OntoIndex CLI indexer does not call an LLM.

## Resource Budget

- **CPU cap:** OntoIndex commands started by agents must target at most 25% of host CPU capacity. For worker-based analyze/index runs, set `ONTOINDEX_MAX_WORKERS` to no more than 25% of logical CPUs before starting the process; on this 28-logical-CPU host, use `ONTOINDEX_MAX_WORKERS=7` or lower.
- **Local CLI only:** Never run `npx ontoindex`. For OntoIndex CLI commands, use the local fork: `node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js ...`. If local source may be newer than `dist`, run `cd /home/er77/_wrk/OntoIndex/ontoindex && npm run build` first.
- **MCP discipline:** MCP sessions must not auto-analyze or start broad refresh/index work unless explicitly requested. Prefer one scoped MCP process per repo with `ONTOINDEX_MCP_REPO` and `ONTOINDEX_LBUG_POOL_SIZE=1`.
- **Long runs:** For sustained analyze/benchmark work, prefer OS-level throttling such as `nice`/`cpulimit` when available in addition to OntoIndex worker limits.

## Execution Sequence (complex tasks)

For multi-step work, state up front:
1. Which rules in this file and **[GUARDRAILS.md](GUARDRAILS.md)** apply (and any relevant Signs).
2. Current **Scope** boundaries.
3. Which **validation commands** you will run (`cd ontoindex && npm test`, `npx tsc --noEmit`).

On long threads, *"Remember: apply all AGENTS.md rules"* re-weights these instructions against context dilution.

## Branch & Artifact Hygiene (hard rules)

These rules prevent the "bundle branch write-amplification" failure mode: parallel refactors of the same file, planning-doc sprawl, test cargo, and decayed branches that cannot be re-integrated. Violations are not style issues — they compound and cost future sessions.

**H0 — Audit first on a bloated surface.** If session-start `git status` shows ≥ 10 untracked files OR `git branch --list 'bundle/*' 'refactor/*' 'split/*'` returns ≥ 10, your first task is triage, not implementation. Report the mess, classify keep/delete/reconcile, and get user confirmation before adding to it.

**H1 — Pre-creation branch reuse check.** Before creating any `bundle/*`, `refactor/*`, `split/*`, or `feature/*` branch, run `git branch --list '<prefix>/*'` and scan for existing branches overlapping by a meaningful token (file name, directory, subject keyword). If a match exists, rebase onto it or abandon. Do not create `-v2`, `-rN`, `-split-again` variants unless the user explicitly tells you the prior attempt is dead.

**H2 — Concurrent-refactor cap.** Before starting a new refactor branch, if `git branch --list 'bundle/*' 'refactor/*' 'split/*' 'feature/*' | wc -l` is ≥ 10, halt and ask the user whether to close existing branches first. Opening an 11th is almost never right.

**H3 — Drift gate.** Before adding a commit to an existing bundle branch, check `git rev-list --count HEAD..<base>`. If ≥ 50 commits behind, stop and either rebase or raise with the user. Do not pile commits onto a decayed branch.

**H4 — Single planning doc.** Do not create a new `*_PLAN.md`, `*_TASKS.md`, `*_AUDIT*.md`, `*_ANALYSIS.md`, `*_ROADMAP.md` without first globbing for existing ones. If any exist, edit one of them; if stale, delete them in the same commit as the new doc. Two competing planning docs is always a bug. Prefer in-chat plans; persist only when the user asks or work spans multiple sessions AND no existing file covers it.

**H5 — Cleanup is part of done.** A task is incomplete until its residue is gone. After a branch's intent lands on the canonical branch, in the same session: (a) `git branch -d` the redundant branch, (b) remove planning docs describing the completed work, (c) remove untracked test files / audit reports / scratch artifacts that only made sense in support of the now-landed change. Report branch-count, untracked-count, and planning-doc-count at session end.

**H6 — Numbering is not ordering.** Numeric task identifiers (T-AUD.X.Y, T-PERF.N, RFC-NNN ring-M) are semantic category labels, not chronological order. Never cherry-pick in number order. Use `git log --reverse <branch> ^<base>` to get actual build order.

**H7 — No partial picks on interdependent chains.** If a target branch has > 5 commits that build on each other (later commits depend on APIs / tests / state added by earlier commits), do not cherry-pick a subset. Merge the whole chain, rebase it, or abandon. Partial application produces a state nobody wants.

**H8 — Subsumption requires multiple signals.** Do not call a branch "subsumed by main" on `git cherry` / patch-id alone. Also require at least one of: (a) the branch introduces a file that now exists on main, (b) deletes a file that main has since deleted by other means, (c) a commit on main in the same file set expresses the same intent. Single-signal cases are "possible — human review needed," not "delete."

**H9 — Baseline-subtract test results.** Before running a test suite to validate a change, capture a pre-change baseline on the same suite. Claim "tests pass" only if the post-change failure set ⊆ pre-change failure set. When the baseline is dirty, list pre-existing failures explicitly. Never say "all tests pass" without baseline-subtraction when failures pre-existed.

**H10 — Remote/auth sanity before first push.** At session start (when any push is plausible), confirm `git remote get-url origin` points to a repo the current user can push to — e.g. `gh api repos/<owner>/<repo> --jq '.permissions.push'`. If false, raise the configuration issue before doing work that assumes a push will succeed.

## Claude Code hooks

**PreToolUse** hooks can block tools (e.g. `git_commit`) until checks pass. Adapt to this repo: `cd ontoindex && npm test` before commit.

## Context budget

Commands and gotchas live under **Repo reference** below and in **[CONTRIBUTING.md](CONTRIBUTING.md)**. If always-on rules grow, split into **`.cursor/rules/*.mdc`** (globs). **Cursor:** project-wide rules in `.cursor/index.mdc`. **Claude Code:** load `STANDARDS.md` only when needed.

## Reference docs

- **[ARCHITECTURE.md](ARCHITECTURE.md)**, **[CONTRIBUTING.md](CONTRIBUTING.md)**, **[GUARDRAILS.md](GUARDRAILS.md)**
- **Call-resolution DAG:** See ARCHITECTURE.md § Call-Resolution DAG. Typed 6-stage DAG inside the `parse` phase; language-specific behavior behind `inferImplicitReceiver` / `selectDispatch` hooks on `LanguageProvider`. Shared code in `ontoindex/src/core/ingestion/` must not name languages. Types: `ontoindex/src/core/ingestion/call-types.ts`.
- **Cursor:** `.cursor/index.mdc` (always-on); `.cursor/rules/*.mdc` (glob-scoped). Legacy `.cursorrules` deprecated.
- **OntoIndex:** skills in `.claude/skills/ontoindex/`; MCP rules in `ontoindex:start` block below.

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-06-08 | 1.7.4 | Relaxed delegated sub-agent model handling: prefer `gpt-5.3-codex-spark`, but continue with actual-runtime recording when exact model selection is unavailable unless the user explicitly requires blocking. |
| 2026-06-08 | 1.7.3 | Added hard rule that delegated sub-agents must use `gpt-5.3-codex-spark`; prompts must state this explicitly when the tool cannot set the model directly. |
| 2026-05-12 | 1.7.2 | Added hard rule to use the local OntoIndex fork for OntoIndex CLI commands; agents must never run `npx ontoindex`. |
| 2026-05-05 | 1.7.1 | Added agent resource budget: OntoIndex processes should use at most 25% CPU capacity; cap analyze workers accordingly. |
| 2026-05-01 | 1.7.0 | SF-Phase-5 W5b — added § Recommended workflow (super-functions); updated Always Do + Never Do to recommend `gn_safe_edit_check`, `gn_pre_commit_audit`, `gn_explore`, `gn_quality_mode`, `gn_help`; primitives demoted to escape hatch. |
| 2026-04-21 | 1.6.0 | Added **Branch & Artifact Hygiene** hard rules (H0–H10) — prevents bundle-branch write amplification, planning-doc sprawl, decayed-branch conflict bombs, false "tests pass" claims, and push against unauthorized remotes. |
| 2026-04-19 | 1.5.0 | Cross-repo impact (#794): `impact`/`query`/`context` accept `repo: "@<group>"` + `service`. Removed `group_query`/`group_contracts`/`group_status` MCP tools; added `ontoindex://group/{name}/contracts` and `ontoindex://group/{name}/status` resources. |
| 2026-04-16 | 1.4.0 | Fixed: web UI description, pre-commit behavior, MCP tools (7->16), added ontoindex-shared, removed stale vite-plugin-wasm gotcha. |
| 2026-04-13 | 1.3.0 | Updated OntoIndex index stats after DAG refactor. |
| 2026-03-24 | 1.2.0 | Fixed ontoindex:start block duplication. |
| 2026-03-23 | 1.1.0 | Updated agent instructions, references, Cursor layout. |
| 2026-03-22 | 1.0.0 | Initial structured header and changelog. |

---

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

## Repo reference

### Packages

| Package | Path | Purpose |
|---------|------|---------|
| **CLI/Core** | `ontoindex/` | TypeScript CLI, indexing pipeline, MCP server. Published to npm. |
| **Web UI** | `ontoindex-web/` | React/Vite thin client. All queries via `ontoindex serve` HTTP API. |
| **Shared** | `ontoindex-shared/` | Shared TypeScript types and constants. |
| Claude Plugin | `ontoindex-claude-plugin/` | Static config for Claude marketplace. |
| Cursor Integration | `ontoindex-cursor-integration/` | Static config for Cursor editor. |
| Eval | `eval/` | Python evaluation harness (Docker + LLM API keys). |

### Running services

```bash
cd ontoindex && npm run dev                 # CLI: tsx watch mode
cd ontoindex-web && npm run dev             # Web UI: Vite on port 5173
node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js serve  # HTTP API on port 4747 (from any indexed repo)
```

### Testing

**CLI / Core (`ontoindex/`)**
- `npm test` — full vitest suite (~2000 tests)
- `npm run test:unit` — unit tests only
- `npm run test:integration` — integration (~1850 tests). LadybugDB file-locking tests may fail in containers (known env issue).
- `npx tsc --noEmit` — typecheck

**Web UI (`ontoindex-web/`)**
- `npm test` — vitest (~200 tests)
- `npm run test:e2e` — Playwright (7 spec files; requires `ontoindex serve` + `npm run dev`)
- `npx tsc -b --noEmit` — typecheck

**Pre-commit hook** (`.husky/pre-commit`): formatting (prettier via lint-staged) + typecheck for staged packages. Tests do **not** run in pre-commit — CI only.

### Gotchas

- `npm install` in `ontoindex/` triggers `prepare` (builds via `tsc`) and `postinstall` (patches tree-sitter-swift, builds tree-sitter-proto). Native bindings need `python3`, `make`, `g++`.
- `tree-sitter-kotlin` and `tree-sitter-swift` are optional — install warnings expected.
- ESLint configured via `eslint.config.mjs` (TS, React Hooks, unused-imports). No `npm run lint` script; use `npx eslint .`. Prettier runs via lint-staged. CI checks both in `ci-quality.yml`.
