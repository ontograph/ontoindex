# Working with uncommitted code

## Activation and request preparation

Automatic workspace reads are enabled when `ONTOINDEX_AUTO_WORKSPACE` is absent
or exactly `1`. Set it to `0` to disable automatic preparation; an empty or other
value also disables it. The setting is checked for each request.

Supported CLI and MCP reads verify eligible source/configuration inputs,
parser identity, HEAD and the committed base before using a disposable
generation. Source bytes are materialized into an owned private capture tree
and verified again against both the live tree and copied inputs. Bounded
verification establishes a captured input set; it does not make the filesystem
atomic.

Matching generations are reused. Clean matching inputs reuse the committed
index without a workspace build. Relationship requests, resolver/configuration
changes, changed base identity, and more than 50 eligible changes require a
full supported workspace graph. The 50-file limit of manual symbol overlays
does not truncate automatic full-graph relationship analysis.

A request pins its admitted generation for graph queries and captured source
enrichment. Later edits create a successor for later requests. Generation and
manifest identities also bind caches and logical pagination. Saved byte-page
continuations replay the original bytes; logical continuations whose binding
changed require a restart.

## Routes and limits

| Read | Workspace behavior |
| --- | --- |
| Context, impact and evidence | Prepared supported relationships and captured source |
| Search and query | Fresh supported lexical candidates; explicit vector limitations |
| Graph walks, repomap, processes, clusters and lazy graph tools | Same prepared repository context |
| Graph resources and docs code facts | Same preparation boundary with existing evidence limits |
| Group reads | Each repository prepares independently; no atomic cross-repository snapshot |
| Status, setup, diagnostics and repository listings | Retain diagnostic/registry scope |
| Explicit commit/history reads | Retain the selected historical reference |

`source: "workspace-graph"` identifies a supported graph answer. Parse-error
paths and incomplete capabilities remain explicit. A bounded partial graph can
answer healthy targets while reporting parse-error metadata. A failed target
parse cannot support authoritative empty relationships or zero impact.

Workspace generations do not add semantic embeddings. Dynamic dependencies and
external resolver inputs outside the capture are outside completeness claims.
Existing mutation guards remain in force; read admission grants no write
permission and does not make stored line ranges safe for concurrent edits.

## Failure and recovery

Required preparation can return `workspace_busy`, `workspace_timeout`,
`workspace_cancelled`, `workspace_too_large` or `workspace_build_failed` through
the existing invocation-error format. Busy and timeout responses can be
retryable. Inspect the error and retained diagnostic output before retrying.
Automatic-current reads do not silently replace required preparation with a
stale base answer. Disabling the setting selects committed/manual-overlay
behavior for subsequent processes and requests.

`ONTOINDEX_WORKSPACE_BUILD_TIMEOUT_MS` limits one supervised build to 120000 ms
by default. The request preparation deadline is 60000 ms, including capture and
waiting. Cancelling one waiter does not cancel a shared build that another
waiter still needs. `ONTOINDEX_WORKSPACE_MAX_FILES` defaults to 1600 indexed
files. Required graphs above that gate fail with `workspace_too_large`; refresh
the committed index, reduce input scope, or deliberately raise the gate for
available resources.

Failed owned captures and unpublished generations are cleaned up. Published
generations are immutable and live readers keep pins. Cleanup preserves
borrowed watcher ownership and existing pinned data. Supported short-lived CLI
reads use foreground preparation without requiring an operator-started watcher.

Persistent MCP servers can retain the existing callback watcher to refresh
after saves; request preparation remains the correctness boundary. Runtime
eviction considers repositories idle after 60 seconds and retains at most eight
idle repository entries. Active requests prevent idle eviction.

## Manual overlay workflow

`ontoindex analyze --dirty-overlay` and `ontoindex watch [path]` remain available
for explicit manual overlay use. The watcher resolves the Git root from the
supplied path or current directory and refreshes after changes. Supported
automatic CLI and MCP reads require neither command as a prerequisite.

Manual bounded symbol overlays cover at most 50 eligible source paths. Above
that limit, they cover the 50 most recently modified files, retain deletion and
rename tombstones, and report uncovered paths. A usable overlay must match its
recorded base and pass the existing timestamp freshness checks; snapshot checks
are cached for two seconds. Manual overlays expose identity/location coverage
with `source: "overlay"` and `graphImpactAvailable: false`. Empty relationship
collections mean unavailable evidence. Impact returns `risk: "UNKNOWN"`; a
zero impacted count means impact was not computed. These results do not
establish complete relationship coverage.

Manual overlays provide lexical/name lookup without new semantic vectors.
Mutation guards still require a usable overlay range for a dirty file and do
not protect against concurrent edits. A successful automatic read does not
relax those guards.

## Qualification and costs

The frozen candidate passed both full flag-off and flag-on suites: 11973 tests
in 662 files, one expected failure and 311 declared skips each. Compiled SDK
replay passed 23 tests across four files, and TypeScript checking passed. Native
SDK fixtures checked changed imports, configuration, parse metadata,
added/deleted edges, cancellation, reader pins, resources, docs and vector
fallback. Skipped and unsupported cases remain outside those claims.

The accepted native matrix contains 12 workload groups with 20 repetitions
each, including 40 clean baseline samples: 300 samples total. Contention uses
40 clients across 20 rounds. All declared budgets passed.

| Measurement | Accepted result |
| --- | --- |
| Maximum warm p95 | 583.290 ms |
| Maximum dirty cold p95 | 29285.484 ms |
| Maximum sampled process-tree RSS | 2608205824 bytes |
| Maximum cold CPU | 45.17 seconds |
| Maximum warm CPU | 0.676260 seconds |
| Maximum generation artifact size | 96782044 bytes |
| Maximum cleanup time | 268.854 ms |
| Clean cold p95 overhead | 76.312 ms |
| Clean warm p95 overhead | 57.136 ms |

Clean and warm reads built zero generations. Each contention round produced
one generation. The selected-probe parity checks found zero differences across
20 rounds; they do not establish full-graph parity. Generation counts do not
directly observe lock exclusivity.

Warm CPU uses terminal cgroup counters from the post-preparation baseline
through the empty-scope final snapshot, including shutdown. RSS is sampled and
can miss peaks; the maximum recorded sampling gap was 49 ms. Cold means a fresh
server and no matching workspace generation; OS caches were not flushed.
Matrix workloads raised the build-file gate for their corpus. These results
describe the retained run and its host/load conditions, not a scaling guarantee.

The accepted artifact is
`.ontoindex/adw-validation/qualification-20261020-r4/matrix.json`, SHA-256
`4c39bb02fdb9606bc3641c47edc5f3f4b5eefb0fc0a40a103a6f2a63e38fad33`.
The [independent review audit](../ADW_INDEPENDENT_REVIEW_AUDIT.md) records matrix
acceptance and retained validation evidence. The default-enabled candidate has
separate focused and compiled-startup validation. Release and the separate RT-5
and buffer-pool investigations retain their own gates.

## Source owners

- `ontoindex/src/core/analyze-delta.ts`: capture, manifests and finite verification.
- `ontoindex/src/core/run-analyze.ts`: captured analysis and generation publication.
- `ontoindex/src/mcp/local/backend-overlay.ts`: admitted snapshot identity and pins.
- `ontoindex/src/mcp/local/local-backend-repo-runtime.ts`: preparation and typed errors.
- `ontoindex/src/mcp/local/local-backend.ts`: route admission, watcher/idle ownership.
- `ontoindex/src/mcp/local/backend-{search,context,impact,symbol-resolution}.ts`: results.
- `ontoindex/src/mcp/{server,resources}.ts`: SDK dispatch and resource boundaries.
- `ontoindex/src/mcp/super/{docs,graph-walk}.ts`: bound logical continuation.
- `ontoindex/scripts/overlay-benchmark{,-automatic,-stats}.mjs`: retained measurements.
