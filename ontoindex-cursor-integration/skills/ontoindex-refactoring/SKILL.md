---
name: ontoindex-refactoring
description: "Use when changing a symbol's name, body, location, or structure with OntoIndex review and verification."
---

Read ontoindex-navigation first.

# Refactoring with OntoIndex

1. Check `impact({action: 'symbol', repo: '<repo>', target: '<symbol>', direction: 'upstream'})` before editing to map callers.
2. Run `gn_safe_edit_check({repo: '<repo>', symbol: '<symbol>', intent: 'modify-body'})` before making the change; use `intent: 'rename'` for a rename.
3. For a rename, preview candidates with `refactor({action: 'rename', repo: '<repo>', target: '<symbol>', new_name: '<new>', dry_run: true})`. This is preview only (`applied: false`). Review every candidate, then edit the files directly. Graph edits are candidates that need review; dynamic references can be missed.
4. For extract, move, or modify-body operations, use `gn_safe_refactor` with `repo` and the matching `intent`; `dryRun` defaults to `true`. Review the preview before any apply.
5. After edits, call `gn_verify_diff` with explicit `changedFiles` and `expectedFiles`, then use `gn_test_gap` to inspect affected test evidence. Run the focused tests indicated by the change.

Pass `repo` explicitly to each OntoIndex call. When the index is stale or degraded, follow ontoindex-navigation and verify uncommitted source directly.
