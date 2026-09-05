---
name: ontoindex-impact-analysis
description: "Use when the user wants to know what will break if they change something, or needs safety analysis before editing code. Examples: \"Is it safe to change X?\", \"What depends on this?\", \"What will break?\""
---

# Impact Analysis with OntoIndex

## When to Use

- "Is it safe to change this function?"
- "What will break if I modify X?"
- "Show me the blast radius"
- "Who uses this code?"
- Before making non-trivial code changes
- Before committing — to understand what your changes affect

## Workflow

```
1. gn_ensure_fresh({repo})                                       → Confirm freshness first
2. impact({action: "symbol", repo, target: "X", direction: "upstream"})  → What depends on this
3. gn_safe_edit_check({repo, symbol: "X"})                       → Pre-edit safety gate
4. gn_verify_diff({repo, scope: "all"})                          → Map current changes to affected flows
5. Assess risk and report to user
```

> If freshness reports stale, refresh with `ontoindex analyze` under the
> single-owner lock rules in `ontoindex-cli`.

If no OntoIndex tool is callable, report the missing tool and stop the
impact-gated edit. Reading source alone does not satisfy this gate.

## Checklist

```
- [ ] gn_ensure_fresh({repo}) and record the freshness state
- [ ] impact({action: "symbol", target, direction: "upstream"}) to find dependents
- [ ] Review d=1 items first (highest review priority)
- [ ] Check high-confidence (>0.8) dependencies
- [ ] gn_verify_diff for the pre-commit check
- [ ] Assess risk level and report to user
```

## Understanding Output

Depth measures dependency distance, not certainty of breakage. A direct
dependent breaks only if the change alters behavior it relies on. Report
dependents as review scope and confirm actual breakage by reading the call site
or running its tests.

| Depth | Review priority | Meaning                                      |
| ----- | --------------- | -------------------------------------------- |
| d=1   | HIGHEST         | Direct callers/importers; inspect every one   |
| d=2   | LIKELY AFFECTED | Indirect dependencies                         |
| d=3   | MAY NEED TESTING| Transitive effects                            |

A dirty worktree lowers scope confidence: uncommitted edits are not in the
graph. Verify those against current source or the diff.

## Risk Assessment

| Affected                       | Risk     |
| ------------------------------ | -------- |
| <5 symbols, few processes      | LOW      |
| 5-15 symbols, 2-5 processes    | MEDIUM   |
| >15 symbols or many processes  | HIGH     |
| Critical path (auth, payments) | CRITICAL |

## Tools

**impact** — the primary tool for symbol blast radius:

```
impact({
  action: "symbol",
  repo: "<repo>",
  target: "validateUser",
  direction: "upstream",
  depth: 3
})

→ d=1 (INSPECT EACH):
  - loginHandler (src/auth/login.ts:42) [CALLS, 100%]
  - apiMiddleware (src/api/middleware.ts:15) [CALLS, 100%]

→ d=2 (LIKELY AFFECTED):
  - authRouter (src/routes/auth.ts:22) [CALLS, 95%]
```

**gn_verify_diff** — git-diff based impact analysis:

```
gn_verify_diff({repo: "<repo>", scope: "all"})

→ Changed: 5 symbols in 3 files
→ Affected: LoginFlow, TokenRefresh, APIMiddlewarePipeline
→ Risk: MEDIUM
```

## Example: "What is affected if I change validateUser?"

```
1. gn_ensure_fresh({repo: "my-app"})
   → fresh, clean worktree

2. impact({action: "symbol", repo: "my-app", target: "validateUser", direction: "upstream"})
   → d=1: loginHandler, apiMiddleware (inspect both)
   → d=2: authRouter, sessionManager (likely affected)

3. Risk: 2 direct callers, 2 processes = MEDIUM
   Report the blast radius and warn before editing on HIGH or CRITICAL.
```
