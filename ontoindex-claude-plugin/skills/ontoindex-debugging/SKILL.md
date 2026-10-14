---
name: ontoindex-debugging
description: 'Diagnose failing behavior, trace errors, and locate the source of a reproducible bug.'
---

Read ontoindex-navigation first (freshness gate and failure path).

## Trace the failure

Record the trigger, expected behavior, observed behavior, and available reproduction evidence.
Locate the failing path and inspect its immediate relationships:

```text
search({action: "semantic", repo: "<repo>", query: "<error or failing behavior>", limit: 5})
inspect({action: "context", repo: "<repo>", target: "<symbol>", include_content: true})
gn_find_related({repo: "<repo>", symbol: "<symbol>", includeCallers: true, includeCallees: true})
inspect({action: "evidence", repo: "<repo>", targets: ["<symbol>"], context_lines: 5})
```

Read current source around the evidence; trace inputs, guards, state changes, and error handling.
Distinguish the first incorrect operation from later symptoms and test the hypothesis with a bounded reproduction.
Graph relationships suggest paths; they do not prove a branch executed.
Report missing runtime evidence explicitly rather than claiming reproduction.

Before fixing the cause, follow ontoindex-impact-analysis and warn on tool-reported HIGH or CRITICAL risk.
After the fix, run the smallest regression check covering the original trigger and relevant edge case.
Report the root cause, changed behavior, validation result, and unresolved limitations.
