# Bounded child retention review and validation

Date: 2026-10-25

Four Luna/Sol read-only reviews and two Sol implementation packets challenged
the current replay work. Existing identity admission, candidate preservation,
publication rollback and source/config invalidation are useful correctness gates.
The prior roundtrip exercised source code in-process; it did not launch the
compiled child. Ordinary matching workspace reads already reuse their published
graph, so replay parity alone does not establish a navigation speed improvement.

## Decision

Compared unconditional strict retention, optional-cache recovery in the pipeline,
and bounded internal opt-in. Unconditional activation adds retention I/O failure
modes to graph availability. Optional-cache recovery needs explicit pipeline
cleanup and rollback semantics; a child-level catch cannot safely resume parsing.
Selected internal opt-in as the smallest compatible proof step. A second review
retained cancellation, identity and preservation gates and rejected performance
claims based only on artifact equality. Rollback is omission of the opt-in.

The existing child accepts private `--scope-retention` JSON with exactly
`timeoutMs` (safe integer 1–120000) and `maxBytes` (safe integer 1–67108864).
The deadline starts before runtime initialization. Invalid input exits 2 before
runtime/analyzer import and emits a fixed diagnostic without echoing the payload.
Default and symbols calls retain their existing three-argument analyzer invocation.
No parent routing, default activation or supervisor lifecycle changed.

## Fresh validation

Commands ran serially in `ontoindex/` with native Linux dependencies.

- `ONTOINDEX_MAX_WORKERS=4 npm run build`: exit 0, final session 79295.
- `ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/unit/workspace-build-child.test.ts test/integration/scope-retention-child-roundtrip.test.ts test/integration/workspace-build-real-child-cancel.test.ts --maxWorkers=1`: exit 0, 40 tests across 3 suites, 37.58 seconds, session 69553.
- Updated `scope-retention-workspace-roundtrip.test.ts` passed in session 80092;
  it now checks parser bypass after source fallback and publishes six generations.
  That combined invocation exited 1 because the new child fixture omitted its
  storage directory; the fixture was corrected before final validation above.
- Initial unit invocation 40413: 34/36 passed; two mock-factory event assumptions
  were corrected. No production defect was inferred from those assertions.
- Scoped `git diff --check`: exit 0. OntoIndex scoped `verify_diff`: PASS;
  expected symbol scope was not supplied. Committed graph matches HEAD
  `2623820ec85113c28b238d5f72dde496e27426a1`; dirty source remains authoritative.
- `safe_edit_check` returned `workspace_too_large` (1832 > 1600). Explicit
  committed impact for `runFullAnalysis` was LOW with three direct callers.

Real child coverage establishes five distinct generations, complete verified
candidates, stable built parser identity, native graph parity, source-change
recovery and cleanup. Artifact equality does not prove compiled-child parser
bypass. The in-process spy establishes bypass separately. No benchmark or broad
language qualification was performed. Existing npm configuration warnings remain.

## Remaining acceptance

Next bounded sequence: observe actual compiled-child parse/replay decisions;
measure rebuild replay against full parsing and existing published-graph reuse;
decide optional-cache availability semantics before default activation; qualify
JavaScript/TypeScript/Python/C++/Rust on Linux; validate isolated CLI/MCP install.
Edited-source composition remains separate from exact-input replay. Default
retention remains disabled. No commit, installation or publication occurred.
Historical structured manager remains closed; no authenticated task completion
is asserted by this review checkpoint.
