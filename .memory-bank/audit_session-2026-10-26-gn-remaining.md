# GN remaining execution checkpoint

Date: 2026-10-26
Authority: User authorization for items 1–7.
Tracker: [GN remaining execution](../docs/plans/ONTOINDEX_GN_REMAINING_EXECUTION_PLAN.md).

## Current result

Native Linux producer and clean source installation have terminal exit 0 receipts
in `/opt/d2/.ontocode/artifacts/compiler-lane/ontoindex-gn-next-native-20261026/result.json`
and `ontoindex-gn-next-install-20261026/result.json`. NEXT-1 is complete through
the supported local manager transition.

PR [134](https://github.com/ontograph/ontoindex/pull/134) carries final handler
correction `b64b569bd59a48ba5f52b70c18d06d57b70f6403`. The guard rejects a malformed
registry value before preparation/use tracking and checks it inside the actual
invocation closure. Final command session 66834 completed with exit 0: two files,
148 tests passed (terminal receipt `8f2ddd`). The preceding inner-only guard
attempt, session 44468, failed with 146 passed and two failed; it is preserved.
No source changed after the passing command. Bounded OntoIndex verify_diff passed
the two expected paths; its indexed checkout differs from the isolated branch,
so exact branch source and diff establish the changed behavior.

CodeQL analysis 2025192817 at merge `7d13441a65eecd66c64c89012552c2986fdf4936`
reports zero findings and empty error. That merge has final head b64b569 as its
second parent. Alerts 74–77 are fixed; scan runs 40281178859 and 40281182391 passed.
NEXT-2 completed through complete-local. The final manager state is blocked with
active_next_task null and no leases; no_dispatch requires an unfinished task to
become dependency-ready with its substantive known blockers resolved.

## Execution limits

Dependency installations 2/2, native/package builds 2/2, focused Vitest runs 8/8,
format/lint allowance 4/4 accounted, product typecheck one exit 0, provider turns
zero, benchmark matrix zero. A missing formatter executable was rejected before
execution and is recorded separately. Final tests passed; further corrective
tests/builds need a concrete authorized allowance increase. All local launched
compiler/test/push jobs are harvested. GitHub scan watcher session 71299 completed
with exit 0 and was harvested.

## Remaining gates

PR 129 is mergeable but retains failed title/macOS/CI checks; the title was
corrected without rerunning macOS. PR 130 is draft against the release branch,
with failed check and benchmark jobs. PR 134 remains draft against master and
documents its prerequisite baseline. Previous CI runs report test failure with
no test child jobs/reports; final run 40281182643 reproduces it with gate exit 1.
No demonstrated cause supports a workflow edit. Final-head format, lint, product
and web typechecks, repository check and benchmark checks all passed.

Core/full/core rollback smoke artifacts exist under
`/opt/d1/_wrk/_backups/ontoindex-gn-plan-20261025/rollback-{core,full}*`.
The recorded 8/62/8 advertisement and sampled calls are partial qualification.
All-54 real-handler semantics, packaged paging/cancellation/errors, official-client
permissions/cache and actual eager/deferred payload remain open. Release and
authenticated receiving acceptance depend on that evidence. Alias retirement
also requires the migration interval, subsequent release and explicit approval.

Installation cleanup recovered zero bytes. Current/evidence/rollback copies
remain retained; the batched candidate lacks complete live-use and rollback-pin
proof. No installation deletion or formal acceptance is claimed.
