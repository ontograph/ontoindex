# Automatic workspace reference draft

Date: 2026-10-20
State: Prepared for ADW-8; apply only after current matrix acceptance.
Authority: Existing ADW-8 documentation scope. This draft changes no runtime
default and supplies no additional qualification.

## README environment entries

Before ADW-8a, retain the current explicit opt-in activation wording. After the
shared predicate change and its tests pass, replace that wording with:

`ONTOINDEX_AUTO_WORKSPACE` controls automatic preparation of current workspace
reads. An absent setting or `1` enables it; `0`, an empty setting, or another
value disables it. Supported CLI and MCP reads prepare an immutable workspace
generation when eligible source, configuration or base identity changes. A
matching clean index is reused without a workspace build. Relationship reads
use a full supported workspace graph; fresh lexical search has no new semantic
vectors. Graph resources, lazy read tools, docs code facts and group read
operations use the same preparation boundary. Diagnostics and explicitly
selected historical references retain their own scope. See the workspace
reference for coverage, failure and cursor semantics.

`ONTOINDEX_WORKSPACE_BUILD_TIMEOUT_MS` limits one supervised workspace build;
the default is 120000ms. The request preparation deadline is 60000ms and covers
capture and waiting. Cancelling one waiter does not cancel a shared build still
needed by another waiter. Failed preparation returns its typed error; retry
only where the response says the error is retryable.

`ONTOINDEX_WORKSPACE_MAX_FILES` limits the indexed file count admitted to a full
workspace build; the default is1600. A required graph above the limit returns
`workspace_too_large`. Refresh the committed index with `ontoindex analyze`,
reduce the input scope, or deliberately adjust the limit for available resources.
The ordinary read does not substitute a stale committed success for failed
required preparation. Benchmark runs that raise this gate must say so.

## Working with uncommitted code

### Request preparation

Automatic workspace reads verify the eligible source/configuration inputs,
parser identity, HEAD and committed base before using a disposable generation.
Source bytes are materialized into an owned private capture tree and verified
again against both the live tree and copied inputs. The bounded verification
establishes a captured input set; it does not make the filesystem atomic.

Matching generations are reused. Clean matching inputs reuse the committed
index. Relationship requests, resolver/configuration changes, changed base
identity, and more than50eligible changes require a full supported workspace
graph. The50-file limit of manual symbol overlays does not truncate automatic
full-graph relationship analysis.

A request pins its admitted generation for graph queries and captured source
enrichment. Later edits create a successor for later requests. Generation and
manifest identities also bind caches and logical pagination. Saved byte-page
continuations replay the original bytes; logical continuations whose binding
changed require a restart.

### Routes and limits

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

### Failure and recovery

Required preparation can return `workspace_busy`, `workspace_timeout`,
`workspace_cancelled`, `workspace_too_large` or `workspace_build_failed` through
the existing invocation-error format. Busy and timeout responses can be
retryable. Inspect the error and retained diagnostic output before retrying.
Automatic-current reads do not silently replace required preparation with a
stale base answer. Disabling the setting selects the legacy committed/manual
overlay behavior for subsequent processes and requests.

Failed owned captures and unpublished generations are cleaned up. Published
generations are immutable and live readers keep pins. Cleanup preserves
borrowed watcher ownership and existing pinned data. Short-lived CLI reads use
foreground preparation without requiring an operator-started watcher.

Persistent MCP servers can retain the existing callback watcher to refresh
after saves; request preparation remains the correctness boundary. Runtime
eviction considers repositories idle after60seconds and retains at most eight
idle repository entries. Active requests prevent idle eviction.

### Manual commands

`ontoindex analyze --dirty-overlay` and `ontoindex watch` remain available for
the explicit manual overlay workflow. Manual bounded symbol overlays expose
identity/location coverage and must not be presented as complete relationship
proof. Ordinary automatic CLI and MCP reads do not require either command as
a prerequisite.

### Qualification and costs

The current frozen build passed both full suites with11973tests in662files,
one expected failure and311declared skips each. Compiled replay passed23tests
across four files, TypeScript passed, and native SDK fixtures checked changed
imports, config, parse metadata, added/deleted edges, cancellation, reader pins,
resources, docs and vector fallback. Skipped and unsupported cases remain
outside those claims.

The single-run pilot took26.03seconds for one cold dirty read. The functional
sweep's worst warm read was333.75ms; worst dirty cold read25.89seconds; maximum
sampled process-tree RSS2504855552bytes; maximum warm CPU0.490976seconds.
These one-repetition measurements establish functional instrument behavior.
Replace or supplement them with the accepted20-repetition matrix results
before publishing readiness or percentile claims.

Warm CPU acceptance uses terminal cgroup counters from the post-preparation
baseline through the empty-scope final snapshot, including shutdown. RSS is
sampled and can miss peaks. Cold means a fresh server and no matching workspace
generation; OS caches are not flushed. Contention checks one generated result
per round; it does not directly observe lock exclusivity. Matrix workloads raise
the build-file gate for their corpus. Retain machine/load and sampling-gap data.

### Source owners

- `ontoindex/src/core/analyze-delta.ts`: capture, manifests and finite verification.
- `ontoindex/src/core/run-analyze.ts`: captured analysis and generation publication.
- `ontoindex/src/mcp/local/backend-overlay.ts`: admitted snapshot identity and pins.
- `ontoindex/src/mcp/local/local-backend-repo-runtime.ts`: preparation and typed errors.
- `ontoindex/src/mcp/local/local-backend.ts`: route admission, watcher/idle ownership.
- `ontoindex/src/mcp/local/backend-{search,context,impact,symbol-resolution}.ts`: results.
- `ontoindex/src/mcp/{server,resources}.ts`: SDK dispatch and resource boundaries.
- `ontoindex/src/mcp/super/{docs,graph-walk}.ts`: bound logical continuation.
- `ontoindex/scripts/overlay-benchmark{,-automatic,-stats}.mjs`: retained measurements.

This reference does not close the separate RT-5 or buffer-pool investigations.
