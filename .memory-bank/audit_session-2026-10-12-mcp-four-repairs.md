# MCP four repairs verification

Date: 2026-10-12
Outcome: accepted repairs implemented and locally validated.
Source HEAD: `7b1494cebd45eada49229ead92aa1920ff0776b0`.

## Changes

- Unknown Git context yields degraded, non-actionable legacy freshness. Existing
  graph-authority decisions, explicit overrides and historical targets retain
  their precedence.
- Stdio detects complete legacy headers in either Content-Type/Content-Length
  order, including fragmented input, using the existing parser.
- Shared database closure fences checkout, waiter handoff and retirement refill
  across aliases. Explicit-close timeouts preserve quarantine and retry ownership;
  ordinary eviction drain timeouts can reopen safe admission. Failed-init cleanup
  rejects waiters and permits surviving aliases to reopen after successful cleanup.
- Pending initialization retains shared close routing through a timeout, allowing
  retry against the same target. Identity checks prevent a completed old close
  from closing a replacement database at the same path.
- The ensure-fresh fixture preserves real target-context helpers and verifies
  dirty result path marking.

Four implementation agents used gpt-6-luna and gpt-6.1-sol. An independent Sol
reviewer challenged the pool and freshness changes and reported no remaining
source blocker within that scope. Its final command receipt did not arrive before
the thread was closed; independent reviewer execution claims remain unaccepted.
The parent verified current source, hashes and executable validation directly.
Three alternatives and a second review
preceded each chosen repair and the additional pending-target/identity corrections.

## Validation

Native working directory: `/opt/d1/_wrk/ontoindex/ontoindex`.

- Final selected MCP run: 87 files and 1,285 tests passed; exit 0. Selection from
  `/opt/d1/tmp/ontoindex-mcp-review-2.2.13/selected-tests.json`, four workers maximum,
  `--dangerouslyIgnoreUnhandledErrors=false`. Terminal receipt and output:
  `/opt/d1/tmp/ontoindex-mcp-four-repairs/broad-tests-final-result.json` and
  `broad-tests-final.log` in the same directory.
- Final pool lifecycle suite: 27 tests passed; exit 0.
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`: exit 0,
  empty diagnostics log.
- Prettier check on the seven owned source/test files: exit 0.
- `git diff --check`: exit 0.
- OntoIndex `gn_verify_diff` with explicit changed/expected seven-file scope:
  PASS. Its empty symbol lists do not establish full graph impact coverage.
- All 2,878 baseline paths remain present; only the seven assigned source/test
  paths changed. Final input hashes remained stable through validation. Baseline,
  final hashes, comparison and logs are retained under
  `/opt/d1/tmp/ontoindex-mcp-four-repairs/`.

## Limits

OntoIndex indexed HEAD matches source HEAD. Dirty changes, incomplete metadata
and scan-capped files limit graph evidence; current source is authority. The
selected 87-file run does not establish full repository test coverage. Selected
close still waits for unrelated initialization, bounded by the existing 10-second
timeout. No compiled distribution or installed binary was changed.

No CodeQL, GitHub CI, release, version bump, commit, push, installation or reindex
ran in this repair task. Other sessions' existing dirty state and active tracking
remain preserved. Knowledge handoff: none; existing validation and receipt rules
already cover the lessons from this repair.
