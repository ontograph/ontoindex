# Isolated cold workspace measurement

Ran the existing automatic overlay benchmark in foreground with sizes 51,
extras none, repetitions 1, ONTOINDEX_MAX_WORKERS=4, and installed candidate
workspace-20261024f. This cloned committed HEAD 2623820, created private index
storage and registry, then measured one cold and one warm request. The original
checkout and index were not changed. The benchmark-owned clone was removed.

Results from /tmp/ontoindex-cold-20261024f.json (receipt 4f84c7):

| Measurement | Cold | Warm |
| --- | ---: | ---: |
| Latency | 37.904 s | 0.564 s |
| Sampled process-tree peak RSS | 2.35 GiB | 0.95 GiB |
| Graph builds | 1 | 0 |
| Cleanup | 94 ms | 100 ms |

Both responses passed workspace-evidence checks, children were reaped, no native
errors or leftover build artifacts were reported. Instrument self-check passed.
Cold budgets passed. Overall command exit was 2 solely for warmCpuAccounting:
sampled CPU cannot certify terminal-interval cgroup accounting. No delegated
cgroup was supplied. This is a measurement-capability limitation, not a proven
runtime regression. No retry was performed.

Corpus: 1766 indexed committed files with 51 synthetic comment edits. The live
checkout has 1832 indexed files and 186 dirty sources, so this is not live-corpus
acceptance. One sample cannot establish p95, and RSS sampling (maximum cold gap
44 ms) can miss peaks. OS caches were not flushed. The benchmark temporarily
raises file admission only for its isolated process. The host limit stayed1600.

Compared options: optimize the existing full-analysis path, explicitly prebuild
and reuse a workspace generation, or raise automatic admission. This result
supports graph reuse but does not establish a general higher limit or identify
a dominant optimization target. Additional source review found no supported CLI
full-workspace prebuild flag: --dirty-overlay is limited to 50 files and is not
equivalent. runFullAnalysis(workspaceGraph:true) is currently an internal path.

Next candidate is an explicit prebuild operation through the existing workspace
owner, preserving the committed base, supervised cancellation, input identity
checks and invalidation. Public-command design/compatibility review is required;
no new CLI surface or runtime limit was added in this measurement task.

Four read-only Luna/Sol reviewers, including two Sol medium reviewers, checked
scope, resource accounting, capacity and evidence. One benchmark invocation
consumed; baseline analysis and cold build occurred only in the disposable clone.
No detached tasks or production code changes.
