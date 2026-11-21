---
name: ontoindex-navigation
description: 'Read before using OntoIndex graph evidence or operating index freshness.'
---

# OntoIndex Navigation

Use OntoIndex when the task needs graph evidence. If graph evidence is not needed, use lean-ctx or source inspection directly.
Resolve this checkout's absolute worktree root and pass it as `repo` on every call. Before graph-dependent work, call `gn_ensure_fresh({repo: "<absolute worktree path>", autoAnalyze: true})`, including first-time indexing. If `analysisSubmission.status` is `queued` or `reused`, poll `gn_analyze_job({repo: "<same absolute path>", jobId: "<returned id>"})` until terminal; only `complete` with `exitCode: 0` passes.
Check freshness again. `blocked`, job failure, or `needsAnalysis: true` stops graph work; reuse running jobs and diagnose before retrying. Recheck after HEAD changes. Verify uncommitted changes against source and diff.
Do not run `reindex.sh`, project wrappers, or local `ontoindex analyze` for this gate. MCP resolves its own installation and providers.

| Task                   | Tool call (always pass `repo: '<repo>'`)                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find code              | `search({repo: '<repo>', action: 'semantic', query: '<symbol>'})` or `inspect({action: "explore", repo: '<repo>', query: '<symbol>'})`                               |
| Symbol callers/callees | `inspect({repo: '<repo>', action: 'context', target: '<symbol>'})` or `inspect({action: "related", repo: '<repo>', symbol: '<symbol>'})`                             |
| Before editing         | `impact({repo: '<repo>', action: 'symbol', target: '<symbol>', direction: 'upstream'})` and `audit({action: "safe_edit_check", repo: '<repo>', symbol: '<symbol>'})` |
| Before committing      | `audit({action: "verify_diff", repo: '<repo>', scope: 'all', changedFiles: ['<path>'], expectedFiles: ['<path>']})`                                                  |
| Review a PR            | `audit({action: "review_diff", repo: '<repo>', scope: 'branch'})`                                                                                                    |
| Test evidence          | `audit({action: "test_gap", repo: '<repo>', symbol: '<symbol>'})`                                                                                                    |
| Delete a symbol        | `audit({action: "can_delete", repo: '<repo>', symbol: '<symbol>'})`                                                                                                  |

Tool risk output (LOW/MEDIUM/HIGH/CRITICAL) is authoritative; warn on HIGH/CRITICAL before editing.
With `impact`, `maxDepth: 1` returns direct dependents to review first; membership alone does not prove breakage.
If tools are missing from the session, search the tool catalog for `ontoindex`.
If tools remain unavailable, a call fails, or a result reports degraded/untrusted evidence, say exactly:
`OntoIndex stale/degraded: <reason>; source inspection is authority.`
Do not use stale graph results or make graph claims. Continue only with bounded source inspection where graph evidence is not required; report the blocked graph-dependent portion. Never present `rg` or `git diff` as OntoIndex evidence.
