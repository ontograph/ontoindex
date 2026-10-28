# Shared component pair: qualification failed

Date: 2026-10-25

One bounded pair used an isolated snapshot of the current `ontoindex-shared`
package: 41 TypeScript files and package/TypeScript configuration, 203,203 bytes.
Per-file SHA-256 identities and the fixture commit are recorded in
`eval/results/ontoindex-shared-pair-87x1w40f/input.json`. The current source
checkout and its index were not used as benchmark storage. The declared pinned
external entire-graph checkout is absent; this component does not replace it.

Compared direct dirty-checkout measurement, the pinned external workload, and
an isolated local snapshot. Selected the snapshot to preserve live index state
and freeze real source inputs. Second review limited interpretation to this
component and fixed-order warm-cache measurements.

## Execution and result

From `ontoindex/`, command:

```sh
ONTOINDEX_HOME=/opt/d1/tmp/ontoindex-shared-pair-87x1w40f/home ONTOINDEX_AUTO_WORKSPACE=1 ONTOINDEX_VECTOR_BACKEND=lbug ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node scripts/large-codebase-benchmark.mjs --mode workspace-pair --cli built --repo /opt/d1/tmp/ontoindex-shared-pair-87x1w40f/repo --pairs 1 --timeout-ms 120000 --sample-ms 100 --output-dir /opt/d1/_wrk/ontoindex/eval/results/ontoindex-shared-pair-87x1w40f --run-id shared-component-01
```

Session 77821 exited 1. All three children completed; acceptance failed. Source,
parser, configuration and commit identities matched. The fixture stayed clean.

| Leg | Seconds | Sampled RSS MiB | Valid samples | Failed scans |
| --- | ---: | ---: | ---: | ---: |
| Full | 4.433 | 955.18 | 37 | 0 |
| Capture | 5.685 | 972.25 | 45 | 1 |
| Intended replay (actually full) | 6.260 | 969.12 | 50 | 0 |

These are failed-run observations, not an accepted speed comparison. Capture RSS
has an incomplete observation. No ceiling was requested. Published-generation
validation was not reached.

## Diagnosed blockers

- Both candidates retained only `src/mro-strategy.ts`; 40 TypeScript files were
  refused as unsupported syntax. `typescript-captures.ts:isTypeOnlyModule`
  excludes exported interfaces, one concrete unsupported construct in the input.
  Individual syntax causes for all 40 files remain unclassified.
- `parse-impl.ts` reconciles all scanned paths against parser outcomes: the two
  JSON files become missing outcomes, independently preventing completeness.
  Parser input evidence contains 41 sources against 43 inventory entries.
- Read-only database comparison by the prerequisite reviewer isolated graph
  differences to community-derived data. Capture has 82 added/82 removed
  MEMBER_OF triples; the third leg also adds `comm_14`, its summary node and two
  SUMMARIZES edges. Extracted triples match. Graph insertion order before seeded
  Leiden in `community-processor.ts` is a hypothesis requiring a regression test.

Do not weaken graph equality or candidate completeness to accept these results.
Options are retaining the failed qualification, measuring a clearly supported
subset, or extending the existing capture/admission and deterministic-community
owners. The next implementation should separate non-parser inventory semantics,
required TypeScript syntax coverage and reproducible community partitions, each
with focused tests, before repeating this frozen workload.

## Evidence and state

JSON/Markdown reports, copied base/candidate manifests and metadata hashes live
under `eval/results/ontoindex-shared-pair-87x1w40f/` (git-ignored local evidence).
The 82 MiB isolated fixture and three databases are deliberately retained at
`/opt/d1/tmp/ontoindex-shared-pair-87x1w40f` for reproducing the failures; no worktree
was created. No benchmark rerun, build, source edit, installation or activation.
Four Luna/Sol research packets reviewed prerequisites and failure evidence.
Budget consumed: one pair, three children; zero corrective runs.
Historical structured manager remains closed. Overall qualification remains open.
