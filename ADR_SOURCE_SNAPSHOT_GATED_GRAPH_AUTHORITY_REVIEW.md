# Review: Source-Snapshot-Gated Graph Authority ADR

Date: 2026-08-05
Reviewed ADR: `ADR_SOURCE_SNAPSHOT_GATED_GRAPH_AUTHORITY.md`
Review revision: 5, CLI authority and manifest determinism fixes applied
Recommendation: Accepted design, implementation and execution validation complete; release-diff verification pending

## Evidence Limits

OntoIndex was used for semantic navigation, source-backed path verification, and
impact analysis. Its graph index was stale during this review:

- indexed commit: `5ff8f63fc53e0ee83ce172803b5b9c7508b300df`
- current HEAD: `e5347b084651cceb8ea89eea4fdd047b8373cef0`
- final dirty-worktree verification: 66 files, including 15 untracked source
  files

Graph topology and impact results are therefore advisory. Current behavior claims
were verified through current source reads and OntoIndex `gn_path_verify`, which
reads the current filesystem source. Product code and focused regression tests
were updated after the challenge findings below.

## Challenged Decision

The architecture is sound. The review identified four defects that prevented
strict graph-backed review authority:

1. Git and graph evidence are not bound to one resolved repository.
2. Diff review surfaces do not request or consume manifest authority.
3. Dirty-worktree diagnostics still override an authoritative source manifest.
4. Bootstrap hydration can replace generation aliases with legacy root files.

The source remedies are now present, but the ADR must not claim validated
implementation until the focused tests and build pass. Use this status meanwhile:

> Status: Accepted, implementation and execution validation complete; release-diff verification pending

## Implementation Update

The four release-gate tasks are implemented in current source:

- review Git operations use the strictly resolved target-context `repoPath`;
- CLI review authority uses the reviewed range endpoint, not implicit checkout
  `HEAD`;
- diff reviews require source-manifest authority for graph evidence;
- authoritative dirty source snapshots remain actionable without hiding dirty
  diagnostics;
- authority for a current checkout cannot make a different target ref fresh;
- bootstrap hydration stages, validates, and publishes one immutable generation;
- pointer activation is the commit point, and post-activation bookkeeping failures
  are reported without unsafe rollback.

Revision 5 closes the remaining CLI fail-open path. `reviewDiffCommand` now opens
LadybugDB only when strict target resolution is successful, the resolved repository
matches the Git repository, and `graphAuthority.state` is `authoritative`. File-list
fallbacks report only `git-diff`, unknown freshness degrades the response, and source
manifest entries use locale-independent code-unit ordering.

Focused regression tests now cover explicit cross-repository CLI selection,
historical CLI range endpoint binding,
authoritative and non-authoritative manifest states, historical target refs, dirty
snapshot semantics, generation aliases, forced replacement, activation failure
with the prior generation preserved, and recoverable post-activation failure.

The lean-ctx command transport recovered on 2026-08-06. Full unit and integration
suites, focused release and LocalBackend gates, TypeScript checking, package
builds, Python evaluation tests, formatting, lint, `git diff --check`, and npm
publish dry-run all completed successfully. Clean staged-diff verification remains
pending because the release candidate is still broad and unstaged.

The previous review overstated several secondary observations. Empty diffs do not
need graph work, the analyzer contract already has a version token, and registry
metadata drift plus inactive-generation cleanup do not block graph authority.
Those points are narrowed below.

## Release-Gate Findings

### RG-1 Critical: Git and graph evidence can target different repositories

`gnPreCommitAudit`, `gnDiffImpact`, and `gnReviewDiff` resolve the Git root from
the process working directory while graph operations use the requested `repoId`.
A request for repository B while the MCP process runs in repository A can diff A
and query B.

`gnPreCommitAudit` and `gnReviewDiff` also retry target-context resolution without
the explicit repository selector. An invalid explicit selector can therefore bind
another repository silently.

Evidence:

- `ontoindex/src/mcp/super/pre-commit-audit.ts:396`
- `ontoindex/src/mcp/super/pre-commit-audit.ts:418`
- `ontoindex/src/mcp/super/diff-impact.ts:836`
- `ontoindex/src/mcp/super/diff-impact.ts:1443`
- `ontoindex/src/mcp/super/diff-impact.ts:1524`

Decision: resolve the explicit target context first, require its `repoPath`, and
use that path for all Git operations. Never fall back after an explicit repository
resolution failure.

### RG-2 High: Diff review surfaces do not enforce manifest authority

`gnDiffImpact` and `gnReviewDiff` call `resolveTargetContext({ repo: repoId })`
without `verifyGraphAuthority: true`. `buildReviewDiffDiagnostics` then labels
graph evidence authoritative when generic freshness is actionable, rather than
when `graphAuthority.state === 'authoritative'`.

A clean legacy index with no source manifest can therefore be presented as
authoritative graph evidence.

Evidence:

- `ontoindex/src/mcp/super/diff-impact.ts:541`
- `ontoindex/src/mcp/super/diff-impact.ts:988`
- `ontoindex/src/mcp/super/diff-impact.ts:1524`

Decision: request graph authority with the capabilities used by each review and
derive graph evidence authority only from `graphAuthority.state`. Freshness remains
diagnostic.

### RG-3 High: Exactly indexed dirty snapshots remain non-actionable

`deriveEnvelopeFreshness` maps every dirty worktree to `degraded` and
`actionable: false`. An authoritative manifest only adds provenance; it does not
override that base result. `gnPreCommitAudit` independently records
`clean-worktree` as missing whenever the worktree is dirty.

This contradicts the ADR acceptance criterion that an exactly indexed dirty
worktree can be authoritative.

Evidence:

- `ontoindex/src/mcp/shared/response-envelope.ts:196`
- `ontoindex/src/mcp/shared/response-envelope.ts:235`
- `ontoindex/src/mcp/super/pre-commit-audit.ts:436`

Decision: when graph authority is authoritative, dirty state remains visible but
must not make graph evidence non-actionable. Do not globally erase dirty warnings;
only remove dirty state as an authority veto.

OntoIndex impact warning: `deriveEnvelopeFreshness` has CRITICAL upstream impact
across review, search, audit, CLI, and local backend surfaces. This change requires
focused shared-envelope tests plus review-surface tests.

### RG-4 High: Bootstrap hydration can break generation publication

Generation storage exposes root `lbug`, `meta.json`, and snapshot paths as aliases
to the active generation. Bootstrap hydration writes directly to root `lbug` and
calls `saveMeta(storagePath, meta)`. Renaming the new root `meta.json` over the
alias replaces the symlink and can leave mixed legacy and generation state.

Evidence:

- `ontoindex/src/storage/repo-manager.ts:235`
- `ontoindex/src/storage/repo-manager.ts:376`
- `ontoindex/src/cli/export.ts:1882`
- `ontoindex/src/cli/export.ts:1884`

Decision: fix the concrete bootstrap path, not every `saveMeta` caller. Hydration
must stage the restored graph, metadata, and optional snapshot as one generation
and activate it through the existing generation publication helpers. `--force`
must replace authority atomically rather than writing through aliases.

## Required Action Tasks

### TASK-RG-1: Bind review Git operations to the requested repository

- [x] Resolve strict target context before constructing Git arguments in
  `gnPreCommitAudit`, `gnDiffImpact`, and `gnReviewDiff`.
- [x] Require `targetContext.repoPath`; return an explicit degraded or error result
  when the requested repository cannot be resolved.
- [x] Remove fallback calls that omit the explicit repository selector.
- [x] Use the resolved path for branch-base resolution, diff collection, hunk
  collection, reviewer history, and every other Git command in those surfaces.
- [x] Add tests where process cwd is repository A and requested `repoId` is
  repository B, plus an explicit unknown-repository test.

Done when: each report's Git paths, target context, and graph repository identify
the same repository, and explicit resolution failure cannot silently select
another repository.

Revision 4 challenge found one additional endpoint-binding defect in the CLI
surface: `reviewDiffCommand` correctly selected the requested repository, but its
authority recheck still defaulted to checkout `HEAD` for `--head` and `--range`
reviews. `buildReviewDiffArgs` now exposes the reviewed endpoint and both
target-context resolutions consume it. A regression test reviews an older range
endpoint while checkout `HEAD` is newer and requires stale, non-actionable graph
authority.

### TASK-RG-2: Enforce source-manifest authority on diff reviews

- [x] Request `verifyGraphAuthority: true` with the actual graph capabilities used
  by `gnDiffImpact` and `gnReviewDiff`.
- [x] Pass authority state into review diagnostics instead of deriving it from
  `freshness.actionable`.
- [x] Ensure legacy, mismatched, degraded-coverage, or insufficient-capability
  indexes produce advisory graph evidence and a degraded/review outcome.
- [x] Add tests for authoritative manifest, missing manifest, source mismatch, and
  missing required capability.
- [x] Gate the CLI review path before LadybugDB is opened; non-authoritative,
  unresolved, or cross-repository contexts use file-list fallback.
- [x] Report graph capabilities only after graph review succeeds and degrade unknown
  freshness.

Done when: no strict diff surface can label graph evidence authoritative without
`graphAuthority.state === 'authoritative'`.

### TASK-RG-3: Let authoritative dirty snapshots remain actionable

- [x] Update shared freshness derivation so authoritative graph identity overrides
  dirty-only degradation while retaining dirty diagnostics and provenance.
- [x] Remove `clean-worktree` as a required graph capability in pre-commit audit.
- [x] Preserve non-authoritative behavior for dirty snapshots that do not match the
  active manifest.
- [x] Add shared-envelope and pre-commit tests for exact dirty snapshot, post-index
  edit, excluded dirty change, and legacy dirty index.

Done when: an exact dirty manifest can support authoritative graph evidence, while
a subsequent source change remains non-authoritative.

### TASK-RG-4: Publish hydrated bootstraps as generations

- [x] Build bootstrap output in a staging generation using existing generation
  helpers.
- [x] Write restored LadybugDB, metadata, and optional snapshot inside staging.
- [x] Validate the staged artifact before activation.
- [x] Atomically activate the staged generation and leave the prior generation
  active on failure.
- [x] Add tests for legacy empty storage, replacement of generation storage with
  `--force`, activation failure, and preserved prior authority.

Done when: bootstrap hydration never replaces a generation alias with a regular
root file and cannot expose graph and metadata from different restores.

## Follow-Up Findings

These issues are real but do not block the source-snapshot authority release gate.

### FU-1 Medium: Branch comparison fails on the integration branch itself

`resolveBranchComparisonBase` skips a candidate equal to the current branch. A
local-only `main` or `master` checkout can therefore fail to resolve its only
valid comparison base.

Evidence: `ontoindex/src/storage/git.ts:164`

Minimal action: allow same-branch triple-dot comparison and test local-only
`main` and `master`. No additional branch-discovery abstraction is needed.

### FU-2 Resolved: Source-entry ordering is locale-independent

`computeSourceManifest` now uses direct code-unit comparison instead of
`localeCompare`, matching the ordering promised by the ADR.

Evidence: `ontoindex/src/core/indexing/source-manifest.ts:81`

Regression coverage fails if manifest generation calls `localeCompare`.

### FU-3 Medium: Empty-diff behavior needs an explicit contract, not graph work

`gnPreCommitAudit` returns `READY` when there are no in-scope changes. The previous
review treated this as a required authority bypass. That is too broad: with no
changed input, graph and boundary checks are not required to establish that there
is nothing to audit.

Evidence: `ontoindex/src/mcp/super/pre-commit-audit.ts:586`

Minimal action: retain the early return, but make the checklist explicit:

- Git diff collection: `PASS`;
- changed-input audit: `SKIPPED`, no in-scope changes;
- graph authority: `SKIPPED`, no graph evidence consumed;
- boundary rules: `SKIPPED`, no changed paths to evaluate.

The early return must still occur after strict repository resolution from
TASK-RG-1. Do not force a graph query or boundary configuration read for an empty
diff.

### FU-4 Medium/Low: Eval recovery can attempt a duplicate server start

After any refresh exception, `refresh_graph_for_oracles` attempts
`_start_eval_server()` even when `_stop_eval_server()` timed out and the old
process may still be alive. Oracle authority remains fail-closed, but process
recovery is unsafe.

Evidence: `eval/environments/ontoindex_docker.py:344`

Minimal action: before restart, verify the recorded PID is gone and the port is
not owned by the old process. Otherwise retain degraded provenance and skip spawn.

### FU-5 Low: Analyzer contract version governance is undocumented

The previous review claimed the scope digest lacked a complete analyzer contract.
That was overstated. `SOURCE_MANIFEST_CONTRACT` is already included in
`scopeDigest` and is persisted as `analyzerContractVersion`.

Evidence: `ontoindex/src/core/indexing/source-manifest.ts:11` and
`ontoindex/src/core/indexing/source-manifest.ts:108`

Minimal action: document and test the rule that any compatibility-breaking change
to source selection or authority-bearing analysis semantics must increment the
contract version. Do not enumerate every internal option into the digest.

## Deferred Risks

### D-1 Registry metadata can lag the bound generation

`LocalBackend` correctly binds the concrete active-generation LadybugDB path, but
uses registry-derived indexed time, commit, and statistics. Those diagnostics can
lag if registry publication fails.

This does not mix graph data or grant authority because strict authority reads the
active generation metadata. Defer until stale registry diagnostics are observed
or registry publication is redesigned.

### D-2 Failed pointer activation can leave an inactive generation

If the staging directory is renamed to its final generation name and pointer
activation then fails, the inactive generation remains on disk. `current` stays
unchanged, so authority remains safe.

This is bounded disk cleanup already covered by the ADR's generation reclamation
follow-up. Do not expand the release gate for it.

## What Is Sound

- `runFullAnalysis` builds graph data, snapshot, and metadata in staging.
- Source identity is recomputed before publication and mutation rejects staging.
- LadybugDB is closed before active-generation activation.
- Active pointer replacement is atomic on the supported Linux runtime.
- Unsupported manifest and analyzer versions degrade authority.
- Evaluation oracles cannot report PASS when graph provenance is degraded.
- `LocalBackend` binds a concrete generation database path instead of a dynamic
  alias.

## Implementation Order

1. TASK-RG-1 repository binding.
2. TASK-RG-2 strict authority consumption.
3. TASK-RG-3 dirty authoritative snapshot semantics.
4. TASK-RG-4 generation-safe bootstrap hydration.
5. FU-1 and FU-2 deterministic correctness fixes.
6. FU-3 checklist clarification and FU-4 eval recovery guard.
7. FU-5 contract governance documentation.

Do not change the shared `resolveTargetContext` contract merely to fix the three
review callers. OntoIndex reports CRITICAL upstream impact for that shared symbol.
Resolve it strictly in the affected callers and reuse its existing `repoPath`.

## Validation

Execution validation completed on 2026-08-06:

- [x] focused target-context, response-envelope, pre-commit, and diff-impact tests;
- [x] bootstrap export/hydration generation tests;
- [x] branch-base and source-manifest determinism tests;
- [x] `npm run build`;
- [x] full unit and integration Vitest suites;
- [x] affected Python eval-environment tests;
- [x] `git diff --check`;
- [ ] clean staged `gn_verify_diff` with the accepted release file and symbol set.

Previous implementation validation recorded before this challenge:

- `npm run build` passed;
- 143 focused Vitest tests passed;
- 36 Python tests passed;
- Python `py_compile` passed;
- `git diff --check` passed.

Those earlier results did not close the new release-gate tasks because they
predated the remedies recorded in this implementation update.

Current implementation validation status:

- full unit suite: 454 files passed, 64 tests skipped;
- full integration suite: 83 files passed, 4 skipped; 2,598 tests passed and 244
  skipped;
- Python evaluation suite: 46 tests passed;
- `npx tsc --noEmit`, `ontoindex-shared` build, `ontoindex` build, root formatting,
  root lint, and `git diff --check`: passed;
- npm `2.1.5` publish dry-run: passed, 29.5 MB and 2,004 files;
- focused `LocalBackend` review gate: 3 files and 56 tests passed, including direct
  coverage that initialization opens the active immutable generation path;
- OntoIndex pre-commit audit: `DO-NOT-COMMIT` because `LocalBackend` is a
  HIGH-impact shared class. Manual source review and direct regression coverage
  are complete, but the final staged diff still requires owner acceptance;
- `gn_verify_diff`: `FAIL` because no expected staged file/symbol set exists yet;
  executed-test evidence is present and no required test is missing;
- OntoIndex graph-backed impact remains review-only for modified and untracked
  source until the accepted release commit is clean and reindexed.
