# ADR: Source-Snapshot-Gated Graph Authority

Status: Accepted, implementation and execution validation complete; release-diff verification pending
Owner: OntoIndex maintainers
Date: 2026-08-05
Revision: 4, after CLI authority and manifest determinism fixes
Amends: `ADR_STRUCTURAL_CONFORMANCE_AND_EVAL_ORACLES.md`

Implementation note: immutable generation publication currently uses same-filesystem
symlink activation. Inactive generation reclamation and a non-symlink platform
fallback remain follow-up operational work; neither is required for authority on
the supported Linux runtime.

## Context

OntoIndex graph tools operate on a persisted repository index. Several review and
evaluation surfaces attach the indexed commit and freshness warnings to their
output, but they do not prove that the graph represents the exact source inputs
being judged.

This creates fail-open behavior in three places:

- The SWE-bench environment indexes `/testbed` before the agent edits it, then
  runs structural oracles against the same warm eval-server after the edit.
- `ontoindex analyze` considers an index current when `meta.lastCommit` equals
  `HEAD`. Dirty worktree changes therefore require `--force`; commit identity
  alone does not trigger a rebuild.
- `gn_pre_commit_audit` can return `READY` while graph evidence is stale or a
  required boundary checklist item has failed.

Commit SHA, index timestamp, and a successful query are insufficient evidence of
source identity. A graph-backed PASS must identify the source scope it analyzed,
prove that the active graph and metadata were published together, and verify that
the same source scope still exists when the decision is made.

The original proposal used a whole-worktree Git tree id as the authority token.
Architecture review found two gaps:

1. A Git tree describes repository content, not OntoIndex coverage. OntoIndex also
   applies include paths, `.gitignore`, `.ontoindexignore`, built-in ignores,
   pipeline profiles, language support, skipped phases, and degraded-file rules.
2. Full analysis currently replaces LadybugDB files in place and writes metadata
   later. A final source recheck can reject metadata after graph files have already
   changed, leaving graph and metadata from different generations.

The authority model must therefore bind source identity, index scope, coverage,
graph data, and metadata as one published generation.

## Decision

Adopt an index-manifest-gated, immutable-generation graph authority model:

> Graph evidence is authoritative only when the active immutable graph generation
> and its index manifest were produced from the same source scope, a freshly
> computed input manifest matches the active manifest at decision time, and the
> requested evidence is covered without relevant degradation.

Graph-backed results with missing, stale, mismatched, unknown, or insufficient
identity or coverage are `DEGRADED` or require `REVIEW`. They must never produce
PASS or `READY` as if the graph were current.

Authority is scoped. A change to a file excluded by the recorded index policy does
not invalidate graph authority for indexed source, but the graph must not claim to
cover that excluded file. A degraded file or skipped capability prevents full
authority for decisions that depend on it.

This decision changes snapshot selection, index publication, and verdict policy at
existing callers. It does not change the shared `runBoundaryViolations` primitive.

## Index Manifest

Persist an additive manifest in `RepoMeta`. The exact schema may evolve, but it
must carry these semantics:

```ts
interface IndexSourceManifest {
  version: 1;
  head: string | null;
  sourceDigest: string;
  sourceEntryCount: number;
  includePaths: string[];
  scopeDigest: string;
  ignorePolicyDigest: string;
  pipelineProfile: string;
  analyzerContractVersion: string;
  coverage: 'complete' | 'degraded' | 'unknown';
  degradedInputsDigest?: string;
}
```

`sourceDigest` is computed from the exact source input set selected for analysis,
not blindly from the whole worktree. The canonical input is a sorted sequence of
repository-relative path, file kind or executable mode where relevant, and byte
content digest. The digest format is versioned and must not depend on traversal
order, timestamps, absolute paths, or platform path separators.

`scopeDigest` binds all settings that decide which inputs and analysis capabilities
participate, including normalized include paths, repository ignore files, built-in
ignore-policy version, pipeline profile, and other source-selection options.
`ignorePolicyDigest` is retained separately for diagnostics.

The analysis result records `coverage`. Unsupported, unreadable, truncated, or
otherwise degraded inputs are represented deterministically. A bounded digest may
identify the affected input set without expanding normal metadata indefinitely.

For Git repositories, Git object ids may optimize content hashing when their
semantics match the selected input, but a whole-worktree tree id is not sufficient
authority by itself. An implementation using `GIT_INDEX_FILE`, `git add`, or
`git write-tree` must also acknowledge that Git can write new blob and tree objects
to the repository object database. It must either accept that documented side
effect or isolate both the temporary index and object directory.

Existing indexes without a manifest remain readable but cannot be authoritative
for strict review or oracle decisions. For non-Git repositories, the same manifest
contract applies using bounded filesystem enumeration and hashing; until that path
is implemented, authority is degraded.

## Immutable Generation Publication

`runFullAnalysis` must build a new generation without mutating the active one:

1. Compute `inputBefore` from the selected source inputs and scope contract.
2. Build graph data and provisional metadata in a new staging generation.
3. Record coverage and compute the final manifest in staging.
4. Recompute the source and scope inputs as `inputAfter`.
5. Require `inputAfter` to match `inputBefore`; otherwise discard staging.
6. Finalize graph metadata inside the staged generation.
7. Promote the completed generation and atomically switch one active-generation
   pointer using a same-filesystem atomic operation.
8. Reclaim older inactive generations only after no reader can still reference
   them.

Readers resolve the active generation once when opening a backend and use graph
data and metadata from that immutable generation. They must not independently open
"latest" graph files and "latest" metadata.

Pointer activation is the publication commit point. Failure or interruption before
or during activation leaves the previous active generation unchanged. After
activation, provenance, registry, and ignore-file bookkeeping failures are
recoverable diagnostics and do not roll back a generation that readers may already
have observed. A staging directory is never queryable and may be cleaned on the
next startup.

The existing in-place LadybugDB deletion and rebuild may remain temporarily for an
explicitly exclusive evaluation-only path. It is transitional, must stop all
readers first, and cannot claim general atomic publication. If complete graph and
metadata correspondence cannot be proven after the rebuild, the result is
`DEGRADED` and the previous authority claim is not reused.

The existing `lastCommit` field remains for compatibility and commit-level
diagnostics. It is no longer sufficient for strict graph authority.

The normal early return is valid only when the current input manifest matches the
active generation manifest and required coverage is complete. Dirty worktrees may
therefore be authoritative when their exact selected inputs were indexed, while a
subsequent edit invalidates that authority even when `HEAD` is unchanged.

## Authority Evaluation

Add authority fields to existing target-context and freshness responses rather
than replacing their current public shapes. This limits migration risk for shared
contracts with broad downstream use.

The authority decision evaluates, in order:

1. an active generation exists and graph data and metadata share its id;
2. the manifest and digest versions are supported;
3. current source and scope digests match the active manifest;
4. required graph capabilities were produced;
5. coverage is complete for the evidence being requested.

Suggested result vocabulary:

```ts
type GraphAuthority =
  | { state: 'authoritative'; generationId: string; manifestDigest: string }
  | { state: 'review'; reason: string }
  | { state: 'degraded'; reason: string };
```

Existing `dirty: boolean` and commit freshness remain useful diagnostics but do
not decide authority alone. The model must distinguish an exactly indexed dirty
snapshot, source changed after indexing, excluded changes, and unknown coverage.

Use the existing strict freshness policy vocabulary where possible. Introduce the
authority result additively, then have strict review and oracle callers consume it.
Do not perform a breaking rewrite of `resolveTargetContext` or create an unrelated
parallel freshness framework.

## Evaluation Lifecycle

Each SWE-bench instance already runs in an isolated Docker container. Do not add a
second graph store solely for the oracle. Refresh the in-container index after the
agent edits `/testbed`:

1. compute the post-edit input manifest as `manifestBefore`;
2. request eval-server shutdown;
3. wait for a bounded shutdown-complete signal or process/PID exit, proving that
   backend and LadybugDB handles were disposed; an HTTP acknowledgement or one
   failed health check is not sufficient;
4. run:

   ```bash
   npx ontoindex analyze . --force --skip-embeddings --skip-agents-md
   ```

5. compute `manifestAfter` and require its source and scope inputs to equal
   `manifestBefore`;
6. restart eval-server and wait for a healthy response;
7. verify that the loaded active generation reports `manifestAfter` and the
   required coverage;
8. run graph-backed structural oracles;
9. record generation id, manifest digest, authority state, and any degradation
   reason with every oracle result.

The edited generation must not be written to the baseline cache keyed only by
repository and commit. That cache remains valid only for its recorded clean source
manifest.

Failure to shut down, analyze, publish, restart, or verify identity produces a
`DEGRADED` oracle result with a stable precondition error code. It never produces
PASS.

`frozen_paths` remains a direct `/testbed` Git-status check and does not require a
graph refresh.

## Pre-Commit Verdict Policy

Build every required check before synthesizing the final verdict. Checklist items
use explicit states:

```ts
type CheckState = 'PASS' | 'FAIL' | 'DEGRADED' | 'SKIPPED';
```

Verdict precedence is deterministic:

| Condition | Verdict |
| --- | --- |
| Git diff unavailable | `DO-NOT-COMMIT` |
| Required configuration malformed or unreadable | `DO-NOT-COMMIT` |
| Direct boundary violation | `DO-NOT-COMMIT` |
| HIGH-risk changed symbol | `DO-NOT-COMMIT` |
| Graph authority is not established for a required check | `REVIEW` |
| Required graph query is unavailable or incomplete | `REVIEW` |
| Unexpected changed symbols or incomplete scan | `REVIEW` |
| Every required check passes with authoritative graph evidence | `READY` |

An absent optional boundary-rules file is `SKIPPED`. Only filesystem `ENOENT`
means absent. Permission, parse, and other read failures are `FAIL`.

The report may keep an overall `status: degraded` envelope for compatibility, but
it cannot pair `verdict: READY` with a failed or degraded required check.

## Branch Comparison Base

Replace hardcoded `main...HEAD` behavior with one shared local resolver used by
`gn_diff_impact`, `gn_review_diff`, and `gn_pre_commit_audit`.

The resolver returns a validated base ref and commit. Callers retain triple-dot
comparison semantics against `HEAD` so Git computes the merge base.

Resolution order:

1. explicit caller-supplied commit range or base;
2. configured repository default branch, including validated `origin/HEAD`;
3. an existing local or remote `main` ref;
4. an existing local or remote `master` ref;
5. the current branch's configured upstream only when it differs from the current
   branch and is explicitly documented as the comparison base;
6. actionable failure requiring an explicit range.

A feature branch's remote-tracking upstream is not assumed to be the integration
base. The resolver must validate refs through argument-safe Git calls. It must not
fetch, mutate refs, or guess another branch name.

## Companion Fixes

The review also found independent correctness gaps. They should be tracked and
implemented separately so they do not block or dilute the graph-authority change:

- The functional-pass-structural-fail metric must divide by resolved instances
  whose structural result is PASS or FAIL. If that denominator is zero, the metric
  is not measured.
- SWE-bench grading should be a pinned optional dependency group and return an
  actionable installation command when unavailable.
- Missing relationship confidence is unknown legacy evidence and must not be
  promoted to `1.0` during cycle aggregation. Preserve unknown or use a documented
  conservative fallback.

## Ownership

- `storage/git.ts`: source input hashing helpers and local branch-base resolution.
- Source selection and ignore-policy modules: canonical input enumeration and scope
  digest inputs.
- `core/run-analyze.ts` and `storage/repo-manager.ts`: staged generation creation,
  manifest persistence, activation, and cleanup.
- Backend and LadybugDB open paths: resolve and retain one immutable generation.
- `mcp/shared/target-context.ts` and `mcp/shared/freshness-policy.ts`: additive
  authority evaluation and diagnostics.
- `eval/environments/ontoindex_docker.py`: eval-server shutdown completion, forced
  refresh, restart, and active-generation verification.
- `eval/run_eval.py`: oracle orchestration and result persistence only.
- `mcp/super/pre-commit-audit.ts`: checklist state and verdict synthesis.
- Diff review surfaces: shared branch resolver consumption.

Do not move snapshot lifecycle logic into `runBoundaryViolations`; it is a shared
analysis primitive used by CLI, local backend, audit reports, and super-functions.

## Rejected Alternatives

- **Commit SHA as graph identity.** It ignores dirty worktree changes.
- **Whole-worktree Git tree as sole authority.** It does not prove OntoIndex input
  scope, capability coverage, or degraded-file handling.
- **Timestamp-based freshness.** Clock order does not prove byte identity.
- **Run `analyze` without `--force`.** The current HEAD-only early return can
  preserve the pre-edit graph.
- **Publish metadata after an in-place graph replacement.** A failure between the
  writes can pair graph data and metadata from different analyses.
- **Treat `/shutdown` acknowledgement as disposal.** The endpoint can acknowledge
  before asynchronous disposal and process exit complete.
- **Analyze while eval-server is running.** Current analysis removes and rebuilds
  LadybugDB files while the server owns read handles.
- **A second graph store per SWE-bench oracle.** Containers already isolate each
  instance; generation-based publication provides the needed consistency.
- **Always materialize a Git temporary index.** It can write repository objects and
  still does not express OntoIndex scope. Git object ids remain an optional hashing
  optimization.
- **Changing `runBoundaryViolations` to understand worktrees.** Snapshot selection
  belongs to callers and index lifecycle, not the rule engine.
- **Automatically fetching a default branch.** Review tools are local and
  read-only; network mutation is outside their contract.

## Consequences

Positive:

- graph-backed PASS and `READY` become claims about exact source scope and graph
  generation, not only commit identity;
- dirty worktrees can be authoritative when indexed exactly;
- excluded changes and degraded coverage are represented instead of collapsed into
  one dirty flag;
- failed or interrupted rebuilds leave the previous generation intact;
- readers cannot combine graph data and metadata from different analyses;
- evaluation oracles can detect dependencies introduced by an agent patch;
- branch review works without assuming `main`.

Negative:

- generation staging temporarily requires space for old and new graph data;
- active-generation activation and reader lifetime need an explicit storage
  protocol;
- canonical source enumeration and hashing add analysis and strict-check cost;
- `RepoMeta`, target context, and diagnostics gain additive authority fields;
- strict callers return `REVIEW` more often for legacy, stale, or degraded indexes.

## Migration

1. Define and test canonical source enumeration, scope normalization, and manifest
   hashing using existing include, ignore, profile, and degraded-file semantics.
2. Persist optional manifests and generation ids while retaining current metadata
   readers and `lastCommit` diagnostics.
3. Add staged generation construction and atomic activation. Keep the old active
   generation queryable until promotion succeeds.
4. Expose additive authority results through target context and freshness policy;
   strict callers degrade legacy indexes without a manifest.
5. Update early-return logic to compare the current input manifest with the active
   generation manifest.
6. Add the post-edit evaluation refresh lifecycle and stop caching edited graphs by
   commit alone.
7. Reorder pre-commit verdict synthesis after all required checks.
8. Introduce the shared branch-base resolver.
9. Deliver companion fixes through separate tasks or ADRs.

No destructive metadata migration is required. Existing indexes remain readable
but are non-authoritative in strict mode until rebuilt into a manifest-bearing
generation.

## Acceptance Criteria

Manifest identity:

- two selected source sets with the same HEAD but different content have different
  source digests;
- selected deletions, executable-mode changes, and non-ignored untracked files
  change the source digest;
- files excluded by the recorded policy do not change the source digest and are
  reported as outside graph coverage;
- include-path, ignore-policy, pipeline-profile, or analyzer-contract changes alter
  the scope identity;
- traversal order, timestamps, absolute checkout path, and path separator do not
  alter identity;
- a legacy index without a manifest is degraded in strict mode.

Publication:

- a source change during analysis discards staging and leaves the active generation
  unchanged;
- interruption before activation leaves the previous graph and metadata paired;
- failures after successful activation are reported as recoverable bookkeeping
  diagnostics and do not roll back the published generation;
- a reader opened before activation continues using its original immutable
  generation;
- a reader opened after activation receives graph and metadata with the same
  generation id;
- staging generations are never returned by repository discovery or query paths.

Authority:

- an exactly indexed dirty worktree can be authoritative;
- a post-analysis edit with unchanged HEAD invalidates authority;
- authority computed from the current checkout cannot make a different or
  unresolved target ref fresh;
- diff review surfaces derive the authority target from the reviewed endpoint
  (`--head` or the right side of an explicit two-dot or three-dot range), rather
  than silently substituting checkout `HEAD`;
- a required query touching degraded or unknown coverage cannot produce PASS or
  `READY`;
- a change outside the index scope does not invalidate scoped authority and is not
  represented as graph-covered evidence.

Evaluation:

- an agent introduces a forbidden dependency after baseline indexing and the
  boundary oracle reports FAIL;
- shutdown waits for process exit or an equivalent completion proof before
  analysis;
- snapshot mismatch, analysis failure, publication failure, or restart failure
  reports `DEGRADED`;
- every oracle result records generation and manifest provenance;
- the edited graph is not stored in the commit-keyed baseline cache.

Pre-commit review:

- a boundary failure cannot coexist with `verdict: READY`;
- non-authoritative required graph evidence produces at least `REVIEW`;
- an absent rules file is skipped, while unreadable or malformed rules fail;
- all required checks passing with authoritative evidence produces `READY`.

Branch review:

- branch scope works with an explicit base, configured default branch, `main`, or
  `master` without network access;
- a feature branch's same-name remote upstream is not silently selected as the
  integration base;
- unresolved branch base returns an actionable error and performs no fetch.

## Implementation Sequence

1. Manifest contract and canonical input identity.
2. Immutable generation staging, activation, and reader binding.
3. Additive authority evaluation and early-return integration.
4. Evaluation shutdown, forced refresh, restart, and provenance verification.
5. Pre-commit checklist states and final verdict synthesis.
6. Shared branch-base resolver.
7. Independent companion fixes.

The first five steps are the release gate for authoritative graph-backed verdicts.
The branch resolver and companion fixes address separate correctness issues.
