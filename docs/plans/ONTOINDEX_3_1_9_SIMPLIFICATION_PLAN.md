# OntoIndex 3.1.9 Challenge Review and Simplification Plan

- **Date:** 2026-11-16
- **Base:** `fix/ontoindex-318-qualification` at `bf1de90` (PR #227, not merged)
- **Scope:** The 3.1.7, 3.1.8 and `bf1de90` fixes for symlink planning,
  capture, impact completeness, CSV content and telemetry
- **Evidence:** Four read-only reviews (OntoIndex index at `60df8f6`, with
  `bf1de90` edits checked from source) and local source checks

## Review

### What worked

- Dirty intermediate links are detected even when resolution fails. Failed
  captures are cleaned up, and descriptor checks (`O_NOFOLLOW`, regular file,
  inode) protect the overlay reader.
- Batch impact no longer reports `NONE` or `LOW` for failed or incomplete
  targets.
- `getPrefix` keeps large File rows from being read in full, and surrogate
  pairs survive sanitizing.
- The native CSV writer stays failed after its first error, so a retry cannot
  append duplicate rows.

### What went worst

- Each fix closed the case named in the report, and the sibling case stayed
  open. The config-link walker follows terminal links and ignores directory
  components, so retargeting `alias` in `tsconfig.json -> alias/x.json` still
  leaves the committed graph in use.
- The completeness work added a batch predicate, but the producers still
  swallow failures. `runImpact` enrichment queries use `.catch(() => [])`, and
  a failed class seed expansion yields `risk: LOW, partial: true` for a single
  target while the batch reports `UNKNOWN`.
- The `||` row fallback was fixed in one file. `backend-resources.ts`,
  `backend-context.ts`, `backend-impact.ts` and `impact-kernel.ts` keep the
  same lossy pattern, and `toProcessStep` drops `step: 0`.
- The 3.1.7 and 3.1.8 changelogs make overly broad claims and then correct
  them in three separate "Correction to" bullets.

### What was forgotten

- Hidden (assume-unchanged or skip-worktree) paths are added after symlink
  dependency detection, so they never mark a config link as changed.
- Capture refuses a transient `EISDIR`/`ENOTDIR`/`ENXIO` on the first attempt.
  Only `ENOENT` and `changed-input` get the second attempt.
- `getScanMaxFileSizeBytes()` always returns `null`, but the overlay
  size-exclusion loop, the replay `Math.min`, a walker re-export and the
  `ONTOINDEX_SCAN_MAX_FILE_KB` advice in `scan.ts` remain.
- Safe-edit upstream and downstream probes swallow database resource errors,
  while the other safe-edit probes rethrow them.

## Over-engineering and simplification

| Area              | Finding                                                                                                                 | Decision                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Planner git calls | `dirtyConfigurationSymlinks` runs `git ls-files -s -z`, and `hiddenIndexPaths` runs `git ls-files -v -z`, on every plan | Use one `git ls-files -s -v -z` read for both                                                                          |
| Size cap          | About 25 lines of unreachable code depend on a constant `null`                                                          | Delete it and keep `uncoveredPaths: []`                                                                                |
| Row helpers       | Four copies of `rowValueOr` with `\|\|` semantics                                                                       | Use `??` semantics in place, without a new shared module                                                               |
| Completeness      | A new per-result `completeness` field was proposed                                                                      | Rejected: the predicate is correct once producers report failures                                                      |
| Telemetry         | Restoring an async completion write was proposed                                                                        | Rejected: the sync append costs microseconds per call and keeps late CLI failures recorded                             |
| File cache        | Dropping the large-file slot was proposed                                                                               | Rejected: the slot stops a big file with many symbols from being re-read for each symbol. The doc comment is corrected |
| Tests             | Full-analysis fixtures in `workspace-graph-snapshot` are slow                                                           | Put new cases in unit suites, and use `npm test -- <files>` before running the full gate                               |

## Options per issue

### I1. Config-link dependency coverage

1. Add every ancestor directory of each visited hop to the dependency set, and
   read hidden index entries before matching. **Chosen:** a few lines in the
   existing walker, with no new git calls.
2. Treat every tracked config link as changed whenever any path is dirty.
   Rejected because ordinary source edits would force full workspace graphs.
3. Record resolved chains in analysis metadata and compare them. Rejected
   because it needs schema, versioning and migration with no workload
   evidence.

### I2. Transient capture errno

1. Retry the listed errnos once, like `ENOENT`, and refuse only on the second
   attempt. **Chosen:** one condition, no new state.
2. Never refuse errnos and always exit 1. Rejected because watch would retry a
   stable FIFO or loop eight times.
3. Make watch drop its refusal signature after a timeout. Rejected for now
   because it adds watch state for a case that option 1 mostly removes.

### I3. Impact completeness

1. Treat a failed seed expansion and failed enrichment queries as failures in
   the producers: set `risk: UNKNOWN`, `partial: true` and a warning, and
   rethrow resource errors. Caps keep a lower-bound risk. **Chosen:** one rule
   applies to every result, and the batch predicate stays unchanged.
2. Add an explicit `completeness` field on every result. Rejected: the same
   producer fixes are needed anyway, and the field adds public surface.
3. Throw on any incomplete analysis. Rejected because it loses partial
   evidence and changes error behavior.

### I4. Falsy row fallbacks

1. Use `??` in place in each module. **Chosen.**
2. Add one shared row helper module. Deferred: it touches six modules for no
   behavior gain.
3. Leave them. Rejected because `step: 0` is a confirmed defect.

### I5. Dead size-cap code

1. Delete the function, its call sites and the stale advice, and keep the
   result shapes. **Chosen.**
2. Also remove the never-called `onSkippedLargeFile` hook and the
   `skippedLargeFiles` results. Deferred: these are public result shapes.
3. Keep everything. Rejected because it misleads readers.

## Work packets

| Packet | Write set                                                                                                                                                                                                                                                                       | Content                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| W1     | `src/core/analyze-delta.ts`, `test/unit/dirty-overlay-plan.test.ts`, `test/unit/workspace-input-capture.test.ts`                                                                                                                                                                | I1, I2, the I5 overlay block, and the single index read   |
| W2     | `src/core/impact/impact-kernel.ts`, `src/mcp/local/backend-impact.ts`, `src/mcp/super/safe-edit-check.ts` and their unit tests                                                                                                                                                  | I3, plus `??` in the impact modules                       |
| W3     | `src/core/ingestion/scan-config.ts` (delete), `test/unit/scan-config.test.ts` (delete), `filesystem-walker.ts`, `pipeline-phases/parse-replay.ts`, `pipeline-phases/scan.ts`, `src/mcp/local/backend-resources.ts`, `src/mcp/local/backend-context.ts`, plus one `step: 0` test | I4 outside the impact modules, and I5 outside the planner |
| Local  | `CHANGELOG.md`, the `csv-generator.ts` doc comment, the debug stack in the `cli/index.ts` catch                                                                                                                                                                                 | Changelog cleanup and small fixes                         |
| R1     | read-only                                                                                                                                                                                                                                                                       | Review of the combined diff                               |

## Validation

- Run the focused vitest files of each packet with `npm test -- <files>`.
- Run both `tsc --noEmit` projects, eslint with 0 errors, prettier, and
  `git diff --check`.
- Run `scripts/verify-release.sh` on the staged tree before committing.

## Deferred

- The `onSkippedLargeFile` hook and `skippedLargeFiles` result shapes.
- A shared row-value helper.
- A root-cause investigation of the LadybugDB "buffer pool is full" flake in
  `committed-read-small-buffer`.
- Moving full-analysis symlink cases from `workspace-graph-snapshot` to unit
  tests.
- `~/.codex/config.toml` still launches 3.1.4. This is a user-owned config and
  is reported only.
