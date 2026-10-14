---
name: ontoindex-impact-analysis
description: 'Assess blast radius before editing a symbol and identify dependencies that need review or validation.'
---

Read ontoindex-navigation first (freshness gate and failure path).

## Before editing

```text
impact({action: "symbol", repo: "<repo>", target: "<symbol>", direction: "upstream", maxDepth: 3, includeTests: true})
gn_safe_edit_check({repo: "<repo>", symbol: "<symbol>", intent: "modify-body"})
```

Use the tool's LOW, MEDIUM, HIGH, or CRITICAL risk output; warn on HIGH or CRITICAL before editing.
Review direct dependents first: depth 1 identifies direct dependencies, not proof of breakage.
Inspect returned callers and current source to assess contracts, public surfaces, and tests.
Treat deeper dependents as additional review scope, not confirmed failures.
Resolve blocked safety checks and missing evidence before proceeding; do not force a verdict without justification.

Prefer the smallest change in the existing owner and validate the affected behavior.

## Before committing

```text
gn_verify_diff({repo: "<repo>", scope: "all", changedFiles: ["<changed-file>"], expectedFiles: ["<expected-file>"], expectedSymbols: ["<symbol>"], executedTests: ["<executed-test>"]})
```

Supply actual paths and only tests that ran. Investigate unexpected files or symbols.
Report the risk verdict, affected contracts, validation evidence, and remaining uncertainty.
