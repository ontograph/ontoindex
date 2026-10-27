# Namespace import and export validation

Date: 2026-10-24
Task: NS-2

## Outcome

Optional namespace metadata now passes through parsed imports, import edges,
explicit export maps, finalization, adapter and strict codec. Distinct type/value
IDs remain separate; shared IDs coalesce. One parsed import remains one counter
and SCC obligation. Both meanings reach the merge hook together. Explicit empty
maps block legacy fallback; absent maps retain legacy behavior.

## Review

Kind inference was rejected because type-only class imports cannot be inferred
from definition kind. Separate pipelines were rejected because they duplicate
linking and storage. Additive metadata in existing owners was selected after a
second challenge of merge policy, counters and static reexports. Lazy indexes
remain in use; no performance benchmark was run.

Two Sol-medium developers owned disjoint four-file packets. Independent Luna
finalizer and Sol codec/adapter reviews found no blockers. Tests cover split and
shared IDs, restrictions, empty and undefined maps, invalid IDs, wildcard ordering,
static reexports, module links, hook ownership, malformed codec records and parity.

## Validation

All commands ran on the native host after source/test writers froze their files.

| Command | Working directory | Result | Runtime evidence |
| --- | --- | --- | --- |
| `../ontoindex/node_modules/.bin/tsc` | `ontoindex-shared` | exit 0 | e86e27 |
| `ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/finalize-algorithm.test.ts test/unit/scope-resolution/finalize-orchestrator.test.ts test/unit/parse-worker-protocol.test.ts test/unit/scope-resolution/registries.test.ts test/unit/scope-resolution/resolve-type-ref.test.ts` | `ontoindex` | 207 tests; five suites; exit 0 | session 26602; terminal 7eb8a3 |
| `./node_modules/.bin/tsc --noEmit --incremental false` | `ontoindex` | exit 0 | session 86368; terminal 22aba4 |
| `git diff --check` scoped to eight declared files | repository | exit 0 | dc6e78 |

Budget consumed: 1/2 shared compilations, 1/2 suites, 1/2 product typechecks.
Children ran no compile or test commands. No retries or execution overruns.
Rust formatting is inapplicable to this TypeScript checkout.

OntoIndex indexed HEAD matches 2623820ec85113c28b238d5f72dde496e27426a1.
The worktree is dirty; its changes are absent from the committed graph. Earlier
workspace preparation failed at 1832 files versus the 1600 limit. Current source
is authority. Declared eight-file verify_diff passed; no symbol scope was checked.

## Remaining scope

Provider namespace capture and qualified lookup remain prerequisites to activation.
Static reexports remain unchanged. Production replay, build/install and runtime
acceptance remain open. This task does not establish that the original workspace
preparation failure is fixed. No deployment or performance improvement is claimed.
