# Structured receiver capture and persistence

Date: 2026-10-25
Status: Implemented and validated; member resolution and seed admission remain open.

Ordinary TS/JS property and call-result receivers now retain a detached identifier
root and ordered member/call steps, bounded to 64 steps. Existing `{name}`
receivers and codec envelope version 1 remain compatible. The candidate manifest
stays at version 3; older readers reject the new shape rather than drop it.
Capture traversal visits inner receiver calls before outer arguments exactly once.
The existing resolver counts member receivers as unsupported before registry lookup.
No receiver type or CALLS target is inferred from chain spelling.

Four discovery agents compared flat chains, recursive expression unions and opaque
receiver text. Flat chains preserve call boundaries with bounded iterative work;
recursive trees add unnecessary structure, and opaque text loses those boundaries.
The second review checked duplicate traversal, malformed syntax, compatibility and
unresolved-member behavior. Four Sol implementation agents owned disjoint files.

## Validation

Commands ran natively from `/opt/d1/_wrk/ontoindex/ontoindex`, serialized with
four-worker environment limits and Vitest `--maxWorkers=1`:

- `ONTOINDEX_MAX_WORKERS=4 npm run build`: exit 0.
- `ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/unit/scope-resolution test/unit/scope-retention.test.ts test/unit/parse-phase-orm-retention.test.ts test/integration/scope-retention-orm-replay-parity.test.ts --maxWorkers=1`: exit 0; 1,893 tests, 32 files, 12.19s.
- `ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/integration/scope-retention-replay-parity.test.ts test/integration/scope-retention-replay-edit-differential.test.ts test/integration/parse-fallback.test.ts test/unit/parse-worker-protocol.test.ts --maxWorkers=1`: exit 0; 103 tests, four files, 20.79s.
- Scoped `git diff --check`: exit 0.
- Bounded OntoIndex `verify_diff`: PASS for 13 supplied files. Symbol scope was
  not checked; impact scan capped at 25 symbols. This is file-scope evidence only.

The build and two test invocations passed without correction runs. Full repository
tests and installation were outside this slice. No background jobs were launched.
Independent Luna review found no material blocker after tracing the explicit
unsupported boundary in `resolve-references.ts`; its initial resolution concern
was withdrawn. Two review follow-ups sent to implementation-only worker roles
were rejected without changes; the review was then routed to the explorer role.

Ordinary Prisma/Supabase fixtures now complete the ORM producer in sequential,
worker and controlled recovery modes, preserving exact persisted receiver records
and ORM replay parity. Ambient declarations still trigger their independent
unsupported-syntax boundary. Optional/computed/spread syntax, malformed codec
payloads, proxies/accessors, oversized chains and missing final reads fail closed.
Shadowing and same-name decoy tests establish that complex members do not become
free-call edges. `seedReady` remains false throughout.

## Evidence limits and remaining work

Committed OntoIndex HEAD was current at `2623820ec85113c28b238d5f72dde496e27426a1`;
dirty source is authoritative for these additions. Workspace preparation remains
over its 1,600-file limit. Capture impact was HIGH (22 module imports), reviewed
with the additive optional field, compilation and scope-resolution regressions.
Other indexed edited owners reported LOW; new capture owners were absent from
the committed graph. No reindex or deployment was performed.

Member/type resolution, ambient declaration scope support, other missing replay
families, cross-record admission, runtime activation and performance acceptance
remain separate tasks. The structured manager remains closed; no lease or tracker
state was changed for this conversational successor.
