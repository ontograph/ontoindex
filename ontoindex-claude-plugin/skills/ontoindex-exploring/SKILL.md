---
name: ontoindex-exploring
description: 'Understand architecture, find code, and trace callers or execution flows in an unfamiliar repository.'
---

Read ontoindex-navigation first (freshness gate and failure path).

## Find and explain code

Start with a concept, then inspect the returned symbol identity:

```text
search({action: "semantic", repo: "<repo>", query: "<concept>", limit: 5})
gn_explore({repo: "<repo>", query: "<concept>", depth: "balanced"})
inspect({action: "context", repo: "<repo>", target: "<symbol>", include_content: true})
gn_find_related({repo: "<repo>", symbol: "<symbol>", maxItemsPerCategory: 10})
```

Use returned paths and identities to read current source and resolve ambiguous symbols.
Trace the entry point, calls, state changes, and output; cite the evidence for each connection.
Separate graph facts from hypotheses, and verify dirty or unindexed source directly.

For structural queries, use `search` with `action: "cypher"` and `repo: "<repo>"`.
Every Cypher query must include `LIMIT` of at most 5000; avoid variable-length patterns.
Use `impact` with `maxDepth` for bounded dependency traversal.
If exploration leads to edits, read ontoindex-impact-analysis before changing symbols.
