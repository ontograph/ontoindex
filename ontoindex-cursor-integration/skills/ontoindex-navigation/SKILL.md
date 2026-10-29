---
name: ontoindex-navigation
description: 'Read first for every repository code task to select OntoIndex evidence and handle index freshness.'
---

# OntoIndex Navigation

Always query OntoIndex first using the task-appropriate tool below.
Repo queries schedule one managed background refresh when HEAD differs from the indexed commit, or when a repository without commits has changed files in its recorded indexed scope. The response uses the existing index with a stale/refreshing warning.
Use stale/refreshing results, label claims with that freshness, and verify edited or new code from source. Uncommitted edits use the automatic overlay; check coverage warnings and inspect uncovered source directly.
Never fall back to grep-only just because the index is stale.
Automatic refresh keeps the recorded scope, excludes `huge-repo-symbols` indexes, and is rate-limited by `ONTOINDEX_AUTO_REFRESH_INTERVAL_MS` (default 300000 ms). `ONTOINDEX_AUTO_REFRESH=0` disables it.
Only the coordinating session may run the installed `ontoindex analyze` manually when immediate refresh is required and no refresh job is active; check the returned refresh/job status first.
Sub-agents never start reindex jobs; refresh-on-query covers them.

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
Continue with usable OntoIndex evidence and bounded source inspection; use bounded `rg` and file reads when tools cannot answer. A stale warning alone does not trigger this failure path. Never present `rg` or `git diff` as OntoIndex evidence.
