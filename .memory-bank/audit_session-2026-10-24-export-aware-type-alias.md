# Export-aware one-hop type aliases

Strict type resolution now resolves `alias.Member` through linked namespace
imports and explicit target exports. Receiver lookup forwards the same optional
callback. Finalize owns export selection; no alias-expanded index or duplicate
export algorithm was added. Missing callbacks preserve existing behavior.

Two reviewers compared callback reuse, another export index and canonical-name
rewriting. Callback reuse was selected after shadowing, absent/empty exports,
namespace intersection and ambiguity review. Two gpt-6.1-sol medium developers
owned disjoint source and test files; independent source review found no material
defects. Existing dirty edits were preserved.

Foreground validation, all exit 0:

- Shared TypeScript compile: `5d628c`.
- Five scope-resolution suites, 324 tests: `3110e9`.
- Product TypeScript check: `a3115c` (source only; tests exercised by Vitest).
- Scoped whitespace check: `39fd68`.

Budget used: one of two shared builds, one of two suite runs, one of two product
typechecks. No detached jobs, installation, release or benchmark ran.
OntoIndex committed index matched HEAD `2623820`; dirty source was authoritative.
Committed symbol impact was LOW; safe-edit review flagged the exported resolver
API. Context-builder impact was unavailable because the symbol was absent from
the graph. Declared-file verify_diff passed with symbol scope unchecked.

General value-member lookup, deeper namespace traversal, transitive re-export
closure, provider/replay admission and runtime acceptance remain open. The
workspace-size ceiling is unchanged.
