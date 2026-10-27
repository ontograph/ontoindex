# Dirty-overlay search review

## Current disposition — 2026-10-20

The [archived real-time plan](.memory-bank/archive/REALTIME_DIRTY_WORKTREE_SUPPORT_PROJECT_PLAN.md)
records all 37 tasks DONE, including RT-5 and RT-28. The
[automatic-workspace closeout](.memory-bank/audit_session-2026-10-20-automatic-workspace-closeout.md)
records the subsequent correctness, performance and default-activation gates.
The dated review below retains its original candidate, worktree and error
attribution. Its OPEN tracker claims describe October 16. Historical buffer-pool
allocation errors remain a separate diagnosis; newer successful replay does not
prove their cause or repair. Pool limits should change only after a reproducible
failing query and resource owner are established.

## Historical verified state — 2026-10-16

The authoritative tracker records 35 tasks DONE and RT-5 and RT-28 OPEN. Its manager remains blocked with no active task. These counts do not independently recertify earlier completion evidence.

The saved RT-28 v5 run passes all five edit visibility checks after rebuilding the patched CLI. Both search and context return positive matches with overlay provenance; rename removes the old symbol and deletion removes the successfully created symbol. Database buffer-pool errors remain unresolved.

## Decision

Three candidate fixes were compared twice:

| Choice | Robustness and compatibility | Cost and performance | Decision |
| --- | --- | --- | --- |
| Prepend every overlay candidate | Prevents base-only starvation but places all overlay matches before clean matches | Small linear merge | Rejected for blanket ordering bias |
| Interleave overlay and clean candidates | Preserves order within each source and gives overlay-only matches early slots without needing an old base slot | Linear time and bounded candidate memory; existing ranking and output caps retained | Selected |
| Introduce a separate ranking lane or overlay FTS | Can support independent relevance scoring, but expands ranking contracts and index requirements | More implementation, maintenance and validation work | Deferred |

Replacing candidates only in old dirty-path positions cannot cover newly created files. Promoting approximate matches through the existing exact-match lane would change its semantics. Interleaving is a bounded correction, not a guarantee that every exact match survives all retrieval and output caps.

## Implementation evidence

Changes are in `/opt/d1/tmp/wt_ovl` and remain uncommitted. The existing scalar-path predicate patch was preserved.

- `ontoindex/src/mcp/local/backend-search.ts`: interleave overlay and clean BM25 candidates before existing RRF ranking. SHA-256: `54933f5cdb591476c9d5799a8d27e4502e1c7a41529e8dd4e6468d9cd4b57712`.
- `ontoindex/test/unit/overlay-query-merge.test.ts`: four regressions cover a full clean candidate pool across ensemble and structured-output modes. SHA-256: `d0b59f98a407c35d9254cfcb3bb55ed2075f2b064b6a04618001bc35f998ead4`.
- Sol reported the four new regressions failing before the merge change and passing afterward. Final focused Vitest: 16 tests passed, exit 0.
- Coordinator TypeScript check (`node node_modules/typescript/bin/tsc --noEmit`): exit 0. `git diff --check`: exit 0.
- OntoIndex freshness matches main HEAD. Impact/navigation used that graph; the dirty fix worktree requires source verification. Bounded diff verification for the fix worktree failed because it is not registered in the MCP server. No graph-backed verification or live acceptance pass is claimed.

## Remaining execution order

1. Finish scoped review of the combined scalar-query and merge patch.
2. Strengthen harness evidence handling: fail on raw-log write errors, verify watcher ownership at acceptance boundaries, and assert MCP termination. The v5 post-run checks independently confirmed complete raw records and process termination, but did not continuously verify watcher ownership.
3. If allocation errors recur, diagnose their exact query and pool owner; do not assume that changing memory limits repairs the search defect.
4. Update RT-28 evidence through a writable tracker owner and retain OPEN until acceptance passes. RT-5 needs disposition of its obsolete RT-2 dependency blocker and valid closeout evidence through the manager tools.

The current persistent manager is explicitly read-only. It cannot repair evidence or projections. Manager status, role results, receipts and leases were not changed by this review.

## Live validation evidence, 2026-10-16

`node scripts/build.js` in `/opt/d1/tmp/wt_ovl/ontoindex` exited 0. The v5 harness self-check passed 10 fixtures, exit 0. `node /tmp/rt28_work/measure-mcp-v5.mjs` exited 0. Its only changes from the prior harness are separate v5 output filenames; v4 evidence was preserved.

| Edit | Visibility result | Elapsed milliseconds |
| --- | --- | --- |
| Append | PASS | 4876 |
| Rename | PASS; old symbol absent in a separate 1677 ms check | 3482 |
| Create | PASS | 5969 |
| Delete | PASS | 3856 |
| Atomic save | PASS | 2925 |

All 1489 frozen input files retained their hashes. Raw evidence contains 44 valid JSON records, matching all 22 query/context attempts. MCP PID 1476494 and watcher PID 1476480 were absent after completion; the scratch repository was clean. Watcher stop exited 0. This run exercised BM25 fallback with no embeddings.

Evidence directory: `/tmp/rt28_work`.

- `inputs-v5.json`: SHA-256 `c75b6955f0e7f0e3a9c0a6b3cc431110de829f288f24b04010d99918ceb9e450`.
- `measure-mcp-v5.mjs`: SHA-256 `aac3086d329628ffc5629df055def8562f3220c0cf81b355e9ede8b73273444b`.
- `mcp-result-v5.json`: SHA-256 `178ffa8b1f987b93212b8b77af1d63e4cb626139005da210d48c5bd544a9e953`.
- `mcp-raw-v5.jsonl`: SHA-256 `9435879626b95823c9420f96398d96886e7205bd458819a8db9b7a4ea43e3cb0`.
- `watch-mcp-v5.log`: SHA-256 `f373dd13ddc6dd96d21f7134d140a0ecc9de9d14a906f101d5a587a59d0ad530`.

The retained MCP stderr contains repeated `query:process-lookup` buffer-pool allocation errors. Visibility success does not resolve these errors or prove CPU performance; the harness retains only the final 2000 stderr characters and endpoint CPU samples. RT-28 remains OPEN pending operational diagnosis and accepted closeout. The authoritative plan validator passed for 37 tasks; manager routing remains blocked with no active task and the reopen gate naming RT-28 and RT-5.
