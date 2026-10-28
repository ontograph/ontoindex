# Rust capture validation

Date: 2026-10-25

Implemented a bounded Rust capture slice in `ontoindex/src/core/ingestion/languages/rust-captures.ts`, wired through `rust.ts`. Ordinary zero-argument functions support same-file forward, self and prior calls, semicolon statements and an optional final bare return. Exact unrestricted `pub` exports are separate from private module bindings. Other syntax refuses whole-file capture while legacy indexing continues.

Parser identity now includes Rust provider/capture source, the native grammar, wrapper and node types. The vendored wrapper checks native bytes around loading and records immutable loaded identity. Existing identity matrices cover mutation and missing inputs, including Node/Bun wrapper paths.

## Decision and review

Compared identity-only work, strict Rust capture with identity, and broad query/generic capture implementations. Selected strict capture for useful local resolution with explicit refusal boundaries and no new dependency. A second review required forward calls, private exports, documentation-comment refusal, raw/keyword-name refusal and parser-error rejection. Four read-only discovery agents and four implementation agents used Luna/Sol; the capture and test writers used Sol medium.

Review corrected missing source identity entries and conservative reserved names. First validation exposed an incorrect provider hook property and missing import interpreter; corrected the existing provider wrapper. No child ran builds or tests.

## Validation

Package cwd: `/opt/d1/_wrk/ontoindex/ontoindex`.

- `ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/unit/scope-resolution/rust-captures.test.ts test/integration/rust-scope-retention.test.ts test/unit/python-grammar-identity.test.ts test/unit/workspace-input-capture.test.ts test/unit/scope-resolution/cpp-captures.test.ts test/integration/cpp-scope-retention.test.ts test/unit/scope-resolution/python-captures.test.ts test/integration/python-scope-retention.test.ts --maxWorkers=1`: initial run exit 1, 311 passed and 4 failed; corrected run exit 0, 315 passed across 8 suites, 5.66 seconds. Native runner sessions 40726 and 83253 were harvested.
- `ONTOINDEX_MAX_WORKERS=4 npm run build`: exit 0, session 96370 harvested. Compiled TypeScript/shared output and copied the existing native artifact. Existing npm configuration warnings remain.
- Scoped `git diff --check`: clean. Explicit trailing-whitespace search on new/untracked files returned no matches.
- OntoIndex bounded `verify_diff`: PASS for the eight supplied source/test paths; symbol scope was not checked. Its committed-mode invocation was unsupported, then the normal bounded invocation succeeded.

Validation used two suite invocations and one build, serialized on the native host; one test-driven correction round. No detached jobs, reindex, release, installation or commit was performed.

## Limits

Committed graph HEAD matched `2623820ec85113c28b238d5f72dde496e27426a1`; dirty source was not represented. Workspace navigation still reported `workspace_too_large` (1832/1600). Provider impact reported LOW, but safe-edit flagged the exported API DANGEROUS without indexed test coverage; current tests supply local evidence.

The closed structured tracker was not reopened. This conversational successor slice is validated. Broader Rust syntax, production replay admission, rebuilt workspace acceptance and deployment remain outside this slice. `seedReady` stays false. The installed candidate predates these source changes; this report does not establish live MCP acceptance.
