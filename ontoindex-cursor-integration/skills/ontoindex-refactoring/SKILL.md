---
name: ontoindex-refactoring
description: "Use when the user wants to rename, extract, split, move, or restructure code safely. Examples: \"Rename this function\", \"Extract this into a module\", \"Refactor this class\", \"Move this to a separate file\""
---

# Refactoring with OntoIndex

## When to Use

- "Rename this function safely"
- "Extract this into a module"
- "Split this service"
- "Move this to a new file"
- Any task involving renaming, extracting, splitting, or restructuring code

## Workflow

```
1. gn_ensure_fresh({repo})                                          → Check freshness first
2. impact({action: "symbol", repo, target: "X", direction: "upstream"})  → Map all dependents
3. inspect({action: "context", repo, target: "X"})                  → See all incoming/outgoing refs
4. gn_safe_edit_check({repo, symbol: "X"})                          → Pre-edit safety gate
5. Plan update order: interfaces → implementations → callers → tests
```

> If freshness reports stale, refresh with `ontoindex analyze` under the
> single-owner rules in `ontoindex-cli`.

Never rename symbols with find-and-replace. If the rename tooling is not
callable, report it and stop rather than editing blindly.

## Checklists

### Rename Symbol

```
- [ ] refactor({action: "rename", repo, target: "oldName", ..., dry_run: true}) — preview all edits
- [ ] Review graph edits (high confidence) and ast_search edits (review carefully)
- [ ] If satisfied, re-run with dry_run: false — apply edits
- [ ] gn_verify_diff({repo, scope: "all"}) — verify only expected files changed
- [ ] Run tests for affected processes
```

### Extract Module

```
- [ ] inspect({action: "context", target}) — see all incoming/outgoing refs
- [ ] impact({action: "symbol", target, direction: "upstream"}) — find external callers
- [ ] gn_propose_location({repo}) — check the intended destination
- [ ] Define new module interface, extract code, update imports
- [ ] gn_verify_diff({repo, scope: "all"}) — verify affected scope
- [ ] Run tests for affected processes
```

### Split Function/Service

```
- [ ] inspect({action: "context", target}) — understand all callees
- [ ] Group callees by responsibility
- [ ] impact({action: "symbol", target, direction: "upstream"}) — map callers to update
- [ ] Create new functions/services, update callers
- [ ] gn_verify_diff({repo, scope: "all"}) — verify affected scope
- [ ] Run tests for affected processes
```

## Tools

**refactor** — automated multi-file rename (`gn_safe_refactor` is the
compatibility equivalent):

```
refactor({action: "rename", repo: "<repo>", target: "validateUser", dry_run: true})
→ 12 edits across 8 files
→ 10 graph edits (high confidence), 2 ast_search edits (review)
→ Changes: [{file_path, edits: [{line, old_text, new_text, confidence}]}]
```

**impact** — map all dependents first:

```
impact({action: "symbol", repo: "<repo>", target: "validateUser", direction: "upstream"})
→ d=1: loginHandler, apiMiddleware, testUtils
→ Affected Processes: LoginFlow, TokenRefresh
```

**gn_verify_diff** — verify your changes after refactoring:

```
gn_verify_diff({repo: "<repo>", scope: "all"})
→ Changed: 8 files, 12 symbols
→ Affected processes: LoginFlow, TokenRefresh
→ Risk: MEDIUM
```

**gn_graph_walk** — custom reference traversal when the facades are not
specific enough.

## Risk Rules

| Risk Factor         | Mitigation                                |
| ------------------- | ----------------------------------------- |
| Many callers (>5)   | Use `refactor({action: "rename"})` for updates |
| Cross-area refs     | Use `gn_verify_diff` after to verify scope    |
| String/dynamic refs | `search({action: "semantic"})` to find them   |
| External/public API | Version and deprecate properly                |

## Example: Rename `validateUser` to `authenticateUser`

```
1. refactor({action: "rename", repo: "my-app", target: "validateUser", dry_run: true})
   → 12 edits: 10 graph (safe), 2 ast_search (review)
   → Files: validator.ts, login.ts, middleware.ts, config.json...

2. Review ast_search edits (config.json: dynamic reference!)

3. Re-run the same call with dry_run: false
   → Applied 12 edits across 8 files

4. gn_verify_diff({repo: "my-app", scope: "all"})
   → Affected: LoginFlow, TokenRefresh
   → Risk: MEDIUM — run tests for these flows
```
