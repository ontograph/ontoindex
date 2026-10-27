# Explicit workspace graph preparation

Status: Accepted for implementation, 2026-10-24

## Decision

Expose `ontoindex analyze --workspace-graph [path]` as an explicit foreground
preparation operation. Reuse the existing supervised workspace child launcher,
analyze lock, captured-input publication and snapshot verification. Preserve the
committed index and the 1,600-file automatic admission limit. The command uses
the existing build timeout and input/artifact limits; it does not promise an
unbounded build. An unchanged usable full workspace generation can be reused.
A clean tree matching its committed base succeeds without building and reports
that the committed base already covers the workspace.
The supervised child inherits the operator's Node memory configuration; this
command does not apply ordinary analyze's automatic 8 GiB heap re-execution.

Reject options whose semantics conflict with full workspace preparation before
creating artifacts. Require automatic workspace consumption to be enabled and
an existing committed base. Verify coverage and current input identity after
building. Partial coverage must be identified; degraded or stale output is a
failure. Abort on SIGINT/SIGTERM and await supervised cleanup before releasing
the analyze lock. A missing compiled child is an actionable failure for this
command, never an unsupervised in-process fallback.

## Alternatives and challenge

Raising automatic admission preserves request-path cold cost and lacks capacity
evidence. Optimizing analysis lacks a measured bottleneck. Forwarding the new
flag to ordinary in-process analyze loses supervised cancellation and silently
ignores incompatible flags. Extending automatic preparation with a bypass mixes
explicit and automatic admission semantics. Extracting its existing child
launcher and sharing it with the CLI keeps one build owner.

Prebuild does not reduce cold analysis cost; it moves that cost to an explicit
operation. Subsequent edits invalidate reuse, and reader validation remains
authoritative. The isolated 37.904-second cold and 0.564-second warm sample
supports reuse, not a general performance guarantee or higher default cap.

## Compatibility, validation and rollback

Existing analyze and dirty-overlay behavior stays intact. Add command-option
compatibility tests, lock/cancellation ordering, failure and coverage tests.
Reuse workspace publication, invalidation and above-cap ready-generation tests.
Validate the native CLI on a disposable fixture before operational adoption.
Rollback removes the additive option and its handler; published disposable
generations remain readable by the existing runtime.
