# OntoIndex 2.2.0

OntoIndex 2.2.0 strengthens audit-history integrity, managed analysis publication,
and the read-only diagnostics used to decide when those workflows are safe.

## Highlights

- Audit event stores now carry a tamper-evident checksum chain. Trust-sensitive
  dispatch fails closed when that chain is broken or legacy history cannot be
  verified, while read-only investigation remains available.
- `ontoindex audit integrity` verifies the event store without mutation. An
  archive-and-reset recovery path requires explicit data-loss acknowledgement
  and preserves the original bytes.
- Managed analysis jobs now carry exact source and capability identity and emit
  a job-bound publication receipt.
- `gn_ensure_fresh` classifies prerequisites and submits or reuses exact jobs;
  `gn_analyze_job` proves terminal recovery with the publication receipt and a
  final capability-aware freshness check.
- Missing required embeddings can trigger managed recovery even when the graph
  already targets the current HEAD.
- Generation activation, publication commit, and rollback are one serialized
  transaction. Failed commits restore the previous generation or remove the
  first-generation pointer without deleting diagnostic output.
- Read-only freshness probes use a short bounded cache, report tracked versus
  untracked worktree changes, and never cache managed analysis requests.
- Diagnostics no longer advertise managed refresh while the worktree is dirty,
  and unknown symbols return `CAUTION` instead of treating missing graph evidence
  as proof of edit safety.

## Recovery Contract

`gn_ensure_fresh` returns structured submission outcomes. A returned job must
be observed through `gn_analyze_job`, whose recovery disposition is one of:

- `REFRESH_RUNNING` — the exact managed job is still queued or running;
- `REFRESHED` — receipt, active generation, repository, HEAD, graph authority,
  and requested capabilities all match;
- `FAILED` — submission, execution, cancellation, or publication failed;
- `FRESHNESS_UNCONFIRMED` — execution apparently completed, but publication or
  the final freshness postcondition could not be proven.

Clients must not delete analyzer locks and must retry the original graph request
unchanged only after `REFRESHED`.

## Distribution

This release is distributed as the installable GitHub asset
`ontoindex-2.2.0.tgz` under the GitHub-only tag `github-release/2.2.0-r1`. It is
intentionally not published to the public npm registry and does not create 2.2.0
container tags.
