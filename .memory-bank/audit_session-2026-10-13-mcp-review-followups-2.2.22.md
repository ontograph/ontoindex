# MCP review follow-ups (2.2.22)

Date: 2026-10-13. Findings came from a read-only review of 2.2.21 (four reviewers plus black-box probes). Several were regressions from the 2.2.21 fixes themselves. No separate ADR; decisions are recorded here.

## Changes
- Clone ownership (2.2.21 regression, data loss): repo delete removed any directory directly under `~/.ontoindex/repos`. A clone now carries `.git/ontoindex-managed-clone.json` (credential-free URL). Delete removes a directory only when it is a real directory under the clone root and is a managed clone, or the exact legacy `<name>` clone with a `.git`. Otherwise the index and registry entry are removed, the source stays, and the response includes `keptSource: true` and a reason. `cloneFresh` refuses to replace a directory ontoindex did not create. `sweepStaleCloneStaging` (once per process, from the analyze route) removes `.tmp-`/`.old-` leftovers older than 24 h and restores an orphaned managed `.old-` when its target is missing.
- Canonical ids: audit tools, `gn_explore`, `gn_propose_location` and docs evidence resolve through the shared registry resolver, so `foo-<hash>` ids work, and ambiguous names list candidate ids and paths. The backend assigns ids from the full registry, so a filtered server uses the same ids as the global resolver.
- Retired-repo pruning no longer closes a pool that a live alias shares by database path (new read-only `getLbugDbPath`).
- Ambiguous-repo hint lists real candidate paths.
- `gn_safe_edit_check`: when graph authority is not `authoritative` (stale index, uncommitted source changes, review state), a SAFE verdict becomes CAUTION. BLOCKED and DANGEROUS are unchanged. The report gains `freshness` and a warning, in both the legacy and envelope responses. Authority is verified the same way as in `gn_pre_commit_audit`.
- Setup: a config file that is not valid JSON is reported and left unchanged (other clients still configure). Writes are atomic, keep the file mode (0600 for new files), and make a one-time `.ontoindex-backup`. A UTF-8 BOM is handled.
- `mcp-doctor`: missing embeddings and optional language servers are listed in `capabilityGaps` and no longer set DEGRADED. Required reasons still do.
- Claude hook: no `npx -y`; uses an installed `ontoindex`, `timeout 2`, and fails open.

## Client-visible changes
- Delete response may include `keptSource` and `reason`.
- Safe-edit `freshness` field; CAUTION on a non-authoritative graph.
- Doctor JSON `capabilityGaps`.
- Setup refuses invalid-JSON configs and writes `.ontoindex-backup`.
- Canonical ids accepted by audit, explore, propose-location, docs evidence.

## Not done
- Argument validator `minimum`/`maximum` enforcement.
- The long-lived process at ~604 MB RSS is mostly native anonymous memory (JS heap about 38 MB). Needs a restart or native heap profile.
- Clone-directory disk quota.
- Native postinstall on an offline host without a toolchain is untested.
- Unmarked error returns in handlers beyond the reviewed list.
- Other sessions' lean-ctx and Ghidra bridge processes were not touched.

## Validation
- `tsc --noEmit` exit 0; `git diff --check` exit 0; build exit 0 with both bundled LadybugDB extension files.
- Test run of 121 files: 1,708 tests. The one failure (`api-repo-removal` mock lacked the new `canRemoveClone`) was fixed and re-run green.
- Artifacts: `/opt/d1/tmp/ontoindex-2.2.22-artifacts/`. Rollback: `rollback-installed-2.2.21.tar.gz`.
