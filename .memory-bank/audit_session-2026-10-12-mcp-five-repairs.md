# MCP five-repair closeout

Date: 2026-10-12
Authority: User instruction to proceed with the five reviewed fixes.
Outcome: Implementation and local validation complete.

## Changes

- The native database adapter retains timeout-retired handles, path aliases and generation pins until confirmed closure. Matching initialization and strict removal reject pending or failed teardown. Successful cleanup removes only its own retirement record. Older timeouts cannot reset a replacement session.
- API shutdown closes analyze/embed progress responses and their timers/subscriptions. Late stream registration closes immediately; late heartbeat admission receives 503.
- JobManager sets cancellation intent before callbacks and signals, preserves escalation and ownership, suppresses revival during disposal, and drains tracked work and child cleanup. Reentrant disposal shares one promise. Child-group and ledger waits have ten-second bounds; incomplete cleanup rejects.
- The API-impact integration fixture uses a partial module mock preserving the real generation-pin implementation.
- Graph-walk count fields advertise integer types. Compatibility assertions cover all three fields and fractional dispatch rejection. Decision: `ADR_MCP_GRAPH_WALK_INTEGER_LIMITS.md`.

## Validation

Working directory: `ontoindex/`.

- Expanded selection: `node node_modules/vitest/vitest.mjs run <97 paths in selected-tests.json> --maxWorkers=4 --fileParallelism=false`: exit 0; 97 files and 1,377 tests passed; no skipped tests; 36.93 seconds.
- Final `node node_modules/typescript/bin/tsc --noEmit --incremental false`: exit 0, no diagnostics.
- `git diff --check`: exit 0.
- Bounded OntoIndex `gn_verify_diff`, explicitly listing fourteen changed source/test paths: PASS. This checks supplied scope and test evidence; it does not independently establish runtime correctness.
- Source/test validation inputs were hashed before and after the expanded run: no drift. Comparing 2,878 baseline inputs identified twelve modified existing source/test files, with two new regression files and one ADR. Other sessions' source changes were preserved.
- Four implementation/research packets used gpt-6.1-sol and gpt-6-luna; two additional independent challenges found the late-heartbeat and ledger-deadline cases. Parent executed validation serially. Child source claims were checked directly; unsupported child execution claims were not accepted.

Evidence directory: `/opt/d1/tmp/ontoindex-mcp-repair-20261012/`. It contains `selected-tests.json`, `tests-result.json`, `tests.log`, `validation-inputs.json`, `changed-files.json`, `baseline.json` and `final-hashes.json`.

## Limits

OntoIndex indexed HEAD equals checkout HEAD, but dirty paths and scan-cap omissions limit graph evidence; current source is authoritative. No exhaustive repository or performance result is claimed. No CodeQL, GitHub CI, release, package build, installation or live-service restart occurred. Product changes remain uncommitted in the existing checkout. Unrelated active project trackers were not changed.

Knowledge handoff: none; existing child-receipt and validation rules already require checking written source and terminal command evidence.
