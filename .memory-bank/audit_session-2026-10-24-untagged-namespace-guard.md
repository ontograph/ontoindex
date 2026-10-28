# Untagged namespace fallback guard

The shared canonical-fallback guard now refuses namespace-origin bindings and
namespace-import edges regardless of their optional namespace tag. This prevents
an alias from selecting an unrelated canonical definition. Exact lexical matches,
direct canonical lookup, omitted registry selectors and unclaimed dotted names
retain their existing contracts. The namespace ADR records the compatibility change.

Two read-only reviewers compared preserving legacy fallback, full export-aware
traversal and the conservative guard. The guard was selected after challenge:
traversal needs authoritative export surfaces, while legacy fallback returns wrong
targets. Two gpt-6.1-sol medium developers owned disjoint source and test files.

Foreground validation, all exit 0:

- Shared TypeScript compilation: receipt `69f97d`.
- Product TypeScript check: receipt `fd380b`; product configuration excludes tests.
- Four scope-resolution suites: 229 passing tests, receipt `1da5cf`.
- Scoped whitespace check: receipt `5ad9ba`.

Budget used: one of two shared builds, one of two suite runs, one of two
product typechecks. No detached jobs, install, release or benchmark ran.
OntoIndex committed HEAD was current at `2623820`; dirty changes were excluded.
The guard was absent from that graph, so impact was UNKNOWN and source inspection
was authoritative. Declared-file verify_diff passed; symbol scope was not checked.

Export-aware positive alias traversal, full semantic replay admission and runtime
acceptance remain open. The workspace-size ceiling remains unchanged.
