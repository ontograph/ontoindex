# `ontoindex review diff` — Local Graph-Aware Diff Review

**ADR:** [0020 — Graph-Aware Diff Review and Review Reports](../adr/0020-graph-aware-review-reports.md)

## What it does

`ontoindex review diff` reports what changed in a local git diff and how that change propagates
through the indexed graph: changed symbols, upstream callers, downstream dependencies, affected
execution flows, and affected code communities.

It works entirely offline. No hosted provider credentials, GitHub/GitLab API tokens, or MCP
session are required.

## Requirements

- A OntoIndex index for the repository (`ontoindex analyze`). Without an index, only changed file
  names are listed; symbol and blast-radius analysis is skipped.
- Git must be available on PATH.

## Quick start

```bash
# Review staged changes (default):
ontoindex review diff

# Review a feature branch against main:
ontoindex review diff --base main

# Review the last 5 commits:
ontoindex review diff --range HEAD~5..HEAD

# Machine-readable JSON output (ADR 0018 envelope):
ontoindex review diff --base main --json
```

## Fresh index workflow

Run `analyze` before reviewing if the repo has changed since the last index run:

```bash
# Index first (use ONTOINDEX_MAX_WORKERS to cap CPU usage):
ONTOINDEX_MAX_WORKERS=7 ontoindex analyze

# Then review:
ontoindex review diff --base main
```

When the index is fresh (`freshness: fresh`), impact counts are authoritative. When stale
(`freshness: stale`), counts are still present but the output warns that `indexedHead` does not
match the current commit.

## Stale index

If the index was built from an earlier commit, the command still runs. The output includes:

```
freshness: stale — indexedHead != targetHead
```

Symbol analysis uses the stale graph. File names are always accurate (from `git diff`). Upstream
counts marked with `~` are heuristic.

## Staged diff

Omit `--base`/`--range` to review only staged (cached) changes:

```bash
git add src/foo.ts
ontoindex review diff
```

Output header: `review diff: --cached`

## Branch diff

```bash
# Two-dot diff: commits reachable from HEAD but not main:
ontoindex review diff --base main --head HEAD

# Three-dot diff: commits on feature not on main:
ontoindex review diff --range main...feature/my-branch
```

## Missing index

If no OntoIndex index is found, the command falls back to a plain file list:

```
freshness: stale — no index
files: 3  symbols: 0
warnings:
  • no OntoIndex index found; symbol analysis unavailable — run `ontoindex analyze` first
```

Run `ontoindex analyze` and re-run the review.

## JSON mode

`--json` emits the ADR 0018 response envelope — suitable for agents and CI pipelines:

```bash
ontoindex review diff --base main --json | jq '.results.highRiskSymbols'
```

Envelope fields include:
- `results.resolvedRange` — the git range used
- `results.reviewedFiles` — per-file changed symbols with impact counts
- `results.highRiskSymbols` — symbols with HIGH blast radius
- `results.affectedProcesses` — execution flows touched by the diff
- `results.affectedCommunities` — code communities touched by the diff
- `freshness.status` — `fresh` | `stale` | `degraded`
- `warnings` — stale-index, dirty-worktree, or capped-paths notices

## Output fields explained

| Field | Meaning |
|---|---|
| `freshness: fresh` | `indexedHead` matches `targetHead` — counts are authoritative |
| `freshness: stale` | Index was built from an earlier commit — counts are graph-accurate but may miss recent changes |
| `freshness: degraded` | Dirty-worktree overlay; actual file state may differ from what the graph knows |
| `[HIGH]` symbol | ≥ 50 upstream callers or HIGH-risk classification from the impact kernel |
| `↑~N callers` | Heuristic upstream count (tilde = not authoritative) |
| `processes (N)` | Execution flows with at least one changed step |
| `communities (N)` | Code clusters with at least one changed symbol |
| `cross-community hints` | Discovery-only ranking aids; do not replace complete impact traversal |

## Relationship to `gn_diff_impact`

`gn_diff_impact` is the MCP super-function equivalent. It accepts the same `commitRange` and
`scope` parameters and returns a structured JSON report. Use `ontoindex review diff` for interactive
or CI workflows; use `gn_diff_impact` when inside an MCP agent session.

## Later phases (ADR 0020 Phase 6 — not yet available)

These features are explicitly deferred until the local CLI contract is stable:

- **Hosted PR adapter** (`ontoindex pr impact 42`): fetches a PR ref and wraps the local report.
  Requires explicit remote and auth configuration. Not part of the current release.
- **Review bundle export** (`ontoindex export review-bundle`): writes a disposable snapshot under
  a gitignored path. Not part of the current release.
- **Hub and surprising-connection reports**: ranking-only discovery views. Will never trim complete
  impact output. Not part of the current release.

Do not assume these features exist. The current command is strictly local-ref-based.
