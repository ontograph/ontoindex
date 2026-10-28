# Published-generation validation benchmark

Date: 2026-10-25

The workspace pair benchmark now measures production `getOverlaySnapshot`
validation after each accepted full/capture/replay pair. It retains the analyze
lock, evicts overlay state, times the validator, and requires complete usable
workspace coverage with no parse-error or uncovered paths. Generation, manifest,
HEAD and base-generation identity must match replay; CURRENT must remain unchanged.
The probe starts no child and cannot silently rebuild. Failures invalidate the
pair, persist failure evidence and are excluded from accepted timing summaries.

JSON stores the observation as `pair.reuse` and aggregates
`summary.publishedValidationMs`; Markdown labels it published-generation
validation. This measures admission after overlay-state eviction, excluding lock
wait, CLI/MCP startup and query execution. OS and database-digest caches remain
warm. It is neither cache-hit timing nor full public preparation timing.

Four read-only Luna/Sol packets compared direct production validation, public
preparation and metadata-only reads. Second review rejected nested public
preparation because it acquires the held lock, and metadata-only reads because
they do not validate source/configuration and database integrity. Two Sol
implementation packets owned disjoint helper and test files. An explorer was
mistakenly sent an implementation follow-up, immediately interrupted and confirmed
no writes; implementation was reassigned to the execution agent. Final independent
review found no concrete correctness defect in this scope.

Validation from `ontoindex/` after final source edits:

- `ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/unit/large-codebase-benchmark.test.ts test/unit/workspace-pair-benchmark.test.ts test/integration/workspace-pair-benchmark.test.ts --maxWorkers=1`: exit 0; 115 tests across three suites; 8.03 seconds; session 89149.
- Real compiled smoke validates the published snapshot after three child builds
  on an isolated fixture. Negative tests cover incomplete/mismatched snapshots,
  pointer changes, exceptions, stop/release behavior and dry-run avoidance.
- Scoped OntoIndex verify_diff PASS for helper and two test files; expected
  symbol scope was unspecified. Impact and safe-edit lookup could not resolve
  the uncommitted helper, so source callers and tests supplied scope authority.
- Worker scoped whitespace checks exited 0; these paths are untracked, so their
  diff checks alone do not establish whitespace coverage. Passing tests exercise
  their contents. No production code or compiled artifact was changed.

Budget: one test invocation, one real three-child fixture sample, zero builds,
zero correction retries and zero representative performance runs. Temporary
reports are removed with the owned test fixture. Default retention stays disabled.

Remaining: representative paired performance and RSS, public CLI/MCP reuse
qualification, optional-cache availability policy, required-language Linux and
isolated installation acceptance. The pinned representative checkout remains
unavailable. Historical structured manager remains closed; no authenticated task
completion is asserted by this checkpoint.
