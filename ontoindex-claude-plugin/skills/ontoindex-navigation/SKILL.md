---
name: ontoindex-navigation
description: 'Read first for every repository code task to select OntoIndex evidence and handle index freshness.'
---

# OntoIndex Navigation

Before any graph-dependent work, resolve the absolute Git root of the exact checkout or linked worktree being edited. Pass that root as `repo` on every OntoIndex call. Never use a project label, a parent checkout, or a sibling worktree as `repo`. If the active checkout root cannot be established, do not make graph claims.

Run this freshness gate before graph evidence, including first-time indexing:

1. Call `manage({action: "ensure_fresh", repo: "<absolute exact current worktree root>", autoAnalyze: true})`.
2. If `analysisSubmission.status` is `queued` or `reused`, poll `manage({action: "analyze_job", repo: "<same exact root>", jobId: "<returned job id>"})` until the job is terminal. Only `status: "complete"` with `exitCode: 0` passes.
3. Call `manage({action: "ensure_fresh", repo: "<same exact root>", autoAnalyze: true})` again.
4. Use graph evidence only when the final freshness call succeeds and confirms an index exists whose `indexedCommit` equals the reported current HEAD (`currentCommit`; use `headCommit` if that is the response field). `isStale` must not be `true`; runtime evidence must not be degraded or untrusted; `needsAnalysis`, when present, must be `false`. If a job was queued or reused, its terminal status must be `complete` with `exitCode: 0`. A blocked/failed status or unresolved queued/running job fails the gate. Missing or conflicting required identity/status fails closed. If no job was submitted or reused, a successful final freshness call meeting these checks is sufficient.

Blocked/failed gate status, failed tool call, final `needsAnalysis: true`, missing index, stale/mismatched HEAD, degraded/untrusted runtime, or unresolved job status blocks graph-dependent work. Never use stale or refreshing graph results as evidence. Dirty or uncovered changes must be checked from source even after the committed index passes. Continue only with source inspection for work that does not depend on graph evidence, and report the blocked graph-dependent portion.

Do not run local `reindex.sh`, project wrappers, or `ontoindex analyze` to satisfy this gate. MCP owns freshness and job submission. A separately requested CLI maintenance operation is covered by ontoindex-cli. Sub-agents use the same gate and exact worktree root; they do not start local analysis.

| Task                   | Tool call (always pass `repo` as the absolute exact current worktree root)                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Freshness gate         | `manage({action: "ensure_fresh", repo: "<absolute exact current worktree root>", autoAnalyze: true})`; poll queued/reused jobs with `manage({action: "analyze_job", ...})` and recheck freshness |
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
Continue with bounded source inspection only where graph evidence is not required; report blocked graph-dependent work. Never use stale graph results or present `rg` or `git diff` as OntoIndex evidence.
