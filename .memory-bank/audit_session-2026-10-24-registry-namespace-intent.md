# Registry namespace selection and reference intent

Class, method and field registry lookups now expose optional lexicalNamespace
selection. Omission preserves legacy behavior. Existing supported reference
materialization explicitly selects value for free calls, reads and constructors,
preserving arity and unsupported member/receiver gates. ClassLookupOptions is
exported alongside existing public option types.

Two explorers compared optional forwarding, registry-kind defaults and provider
inference. The second review selected forwarding with explicit consumer intent:
class construction is a value query, so symbol kind cannot choose namespace.
One explorer initially missed the ingestion caller; direct source verification
corrected that finding before dispatch. Two Sol-medium developers owned disjoint
production and test files. Independent final source review found no defects.

Foreground validation, all exit 0:

- Shared TypeScript compile: d4ecf5.
- Product TypeScript check: 775af9.
- Five scope-resolution suites: 370 tests, 73e547.
- Scoped whitespace check: 788f65; test author also checked final test edits.
- OntoIndex declared-file verify_diff PASS; symbol scope unchecked.

Budget consumed: one of two shared compiles, one of three suite runs, one of two
product checks. No detached jobs, provider activation, install or benchmark.
The closed roadmap returned no eligible task and was left intact. This bounded
continuation was tracked in conversation under the user's proceed instruction.

Committed graph matches HEAD 2623820; dirty source remains authoritative. Builder
impact was LOW; safe-edit checks flag exported APIs. resolveReferenceSites was
absent from the committed graph, giving UNKNOWN impact. Its two source callers
were checked directly. Live workspace navigation still refuses 1832 files above
the 1600 ceiling. Remaining work includes provider capture and merge semantics,
member-reference support, replay admission and runtime/performance acceptance.
