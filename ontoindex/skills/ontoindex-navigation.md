---
name: ontoindex-navigation
description: 'Read first for every repository code task to select OntoIndex evidence and handle index freshness.'
---

# OntoIndex Navigation

Start with `gn_ensure_fresh({repo: '<repo>', autoAnalyze: false})`.
Refresh only when the indexed commit differs from HEAD, the check targets the wrong repository/checkout, or a required graph capability is missing.
Report the condition to the single coordinating session; only that session runs the installed `ontoindex analyze`, makes one refresh attempt, and checks freshness once afterward.
After that confirmation, retry the original request with the same tool and parameters only when the index is fresh enough.
A dirty tree alone is a caveat: uncommitted changes are absent from the graph; verify them from source.
For a tree with no commits, no commit-based staleness check is possible; state that limitation and use the failure path below.
Sub-agents use the index read-only and never reindex.

| Task                   | Tool call (always pass `repo: '<repo>'`)                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Find code              | `search({repo: '<repo>', action: 'semantic', query: '<symbol>'})` or `gn_explore({repo: '<repo>', query: '<symbol>'})`                                 |
| Symbol callers/callees | `inspect({repo: '<repo>', action: 'context', target: '<symbol>'})` or `gn_find_related({repo: '<repo>', symbol: '<symbol>'})`                          |
| Before editing         | `impact({repo: '<repo>', action: 'symbol', target: '<symbol>', direction: 'upstream'})` and `gn_safe_edit_check({repo: '<repo>', symbol: '<symbol>'})` |
| Before committing      | `gn_verify_diff({repo: '<repo>', scope: 'all', changedFiles: ['<path>'], expectedFiles: ['<path>']})`                                                  |
| Review a PR            | `gn_review_diff({repo: '<repo>', scope: 'branch'})`                                                                                                    |
| Test evidence          | `gn_test_gap({repo: '<repo>', symbol: '<symbol>'})`                                                                                                    |
| Delete a symbol        | `gn_can_delete({repo: '<repo>', symbol: '<symbol>'})`                                                                                                  |

Tool risk output (LOW/MEDIUM/HIGH/CRITICAL) is authoritative; warn on HIGH/CRITICAL before editing.
With `impact`, `maxDepth: 1` returns direct dependents to review first; membership alone does not prove breakage.
If tools are missing from the session, search the tool catalog for `ontoindex`.
If still absent, or the index remains stale/degraded or the tree has no commits, say exactly:
`OntoIndex stale/degraded: <reason>; source inspection is authority.`
Continue with bounded `rg` and file reads. Never present `rg` or `git diff` as OntoIndex evidence.
