# Nested ORM receiver boundary

Date: 2026-10-25

Current scope capture requires identifier receivers. Prisma supplies a property
chain; Supabase supplies a call-result receiver. The shared ReferenceSite stores
only a receiver name, registry lookup treats that name as a lexical type binding,
and the current reference resolver skips member calls. The composed capture walker
visits arguments but does not visit receiver expressions.

Compared preserving refusal, accepting receiver text with traversal, and introducing
structured property/call-result receivers through capture, resolution and persistence.
Second review rejected a parser-only relaxation: string spelling does not establish
receiver semantics, and root-name substitution could misattribute calls. Separating
ORM completion from shared issues would change the existing completeness contract
without solving missing scope evidence. Preserved current behavior in this slice.

Added exact ORM refusal tests across TS/TSX/JS/JSX, with a supported prefix, typed
ScopeUnsupportedSyntaxError for selected and whole-file capture, and same-parser
recovery. Producer tests now cover Prisma, Supabase and mixed input, asserting exact
partial ORM records and zero-based lines while completeness and seedReady stay false.
Successful empty input and missing-final-read behavior remain covered.

Validation from ontoindex/:

`ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/unit/scope-resolution/typescript-reference-captures.test.ts test/unit/parse-phase-orm-retention.test.ts test/integration/scope-retention-orm-replay-parity.test.ts --maxWorkers=1`

Exit 0: 61 tests across three suites, 3.26 seconds. One test invocation; no build
needed for test-only edits. Six Luna/Sol agents participated, including two Sol
developers and independent source review. No detached jobs or deployment.

OntoIndex committed navigation succeeded but the capture owner was absent from
the committed index; source inspection is authority. Bounded verify_diff passed
the supplied two-file scope; symbol scope was not checked.

This closes a regression-coverage gap, not nested-call support. The next semantic
change must define structured receiver observation, nested traversal exactly once,
unresolved-receiver behavior, shadowing, and persistence compatibility before
claiming complete scope evidence. Replay admission, missing retained families,
source/model-pack identity and runtime/performance acceptance remain open.
Structured manager tracking remains closed and unchanged.
