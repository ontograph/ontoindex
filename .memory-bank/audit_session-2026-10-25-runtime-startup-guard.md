# Runtime startup identity and candidate configuration validation

Date: 2026-10-25. Authority: user continuation of the five-task scope.

## Implemented

- The supervised workspace child captures a one-shot parser runtime baseline
  before dynamically importing analysis code, then verifies it before analysis.
  Subsequent identity reads compare against that baseline. A failed initializer
  remains failed; concurrent or repeated initialization cannot replace it.
- Workspace publication compares current parser identity with captured identity
  after syncing the staged pointer and immediately before renaming CURRENT.
  Mismatch or unreadable identity preserves the previous CURRENT and removes
  the staged generation and pointer through existing cleanup.
- Candidate readers reuse ScopeRetentionStage configuration validation with an
  independent bounded allowance and guaranteed disposal. Malformed records and
  stale configuration digests are rejected by both verification and hydration.
  Valid incomplete evidence remains readable; cancellation propagates.

The startup guard addresses persistent ordinary concurrent upgrades. It does
not prove hostile change-and-restore resistance or eliminate the final
check-to-rename interval. Unsupervised callers retain disk-only identity.

## Decisions

Startup alternatives: retained child baseline, parent-supplied digest, immutable
runtime deployment. The child baseline reuses existing ownership and catches
load-interval and later persistent changes without a new launch protocol.
Parent digest alone misses load-interval changes; immutable deployment requires
separate lifecycle enforcement. A first-use cache misses earlier loaded code.

Configuration alternatives: duplicate checks, extract a shared validator, reuse
the existing bounded capture validator. Reuse preserves one validation contract
and incomplete-evidence compatibility without broad refactoring.

## Executed evidence

Native commands ran serially in `ontoindex/`, with Vitest `--maxWorkers=1`,
ONTOINDEX_TEST_WORKERS=4 and build ONTOINDEX_MAX_WORKERS=4.

- Unit run: workspace-parser-runtime, workspace-build-child,
  workspace-input-capture, parser-identity, workspace-analysis-publication-order,
  workspace-analysis-durability, workspace-analysis-base-guard,
  dirty-overlay-build: 168 tests passed, exit 0; session 1534.
- Native `npm run build`: exit 0; session 76226.
- Compiled workspace-build-real-child-cancel integration: 1 test passed,
  exit 0; session 46395. Previous CURRENT survived cancellation; recovery built.
- Candidate reader, writer and auxiliary-path suites: 311 tests passed,
  exit 0; session 89580.
- Final native `npm run build` after candidate edits: exit 0; session 67630.
- Final parse-replay and two integration parity suites: 70 tests passed,
  exit 0; session 58086. Required-language fixture coverage is preserved.
- Scoped whitespace checks exited 0. Bounded OntoIndex verify_diff passed for
  startup/publication files; expectedSymbols was absent, so no symbol-scope claim.
  Its initial committed-mode invocation was unsupported; corrected invocation passed.

Four read-only researchers and three disjoint implementation workers used
gpt-6-luna/gpt-6.1-sol. All were harvested and closed. Two builds and four test
invocations completed; no detached commands, containers, install or publication.
No relevant source edits followed final validation.

## Remaining

Runtime replay remains disabled and seedReady remains false. Exact same-source
admission, workspace candidate persistence/pinning, actual parser-bypass proof,
fallback/invalidation/cancellation, edited-source composition, performance,
complete Linux required-language validation and isolated install/CLI/MCP proof
remain open. Coverage.complete alone is insufficient because it permits skipped
and unknown unparsed files. Admission must require exact supported input sets,
all producer flags, retained status, complete evidence and non-null identities.

The existing structured manager remains closed; its state was not modified.
OntoIndex HEAD matches the indexed commit, but dirty source owners are absent
from the graph. Source and executed tests are authority for current changes.
