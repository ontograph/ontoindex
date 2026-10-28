# ORM input retention and replay evidence

Date: 2026-10-25

Implemented ORM query retention in the existing stage, parse producer and candidate
writer/reader. Candidate format v3 requires twelve families, including orm-queries;
v1/v2 candidates require regeneration. Descriptor-safe validation, shared byte and
record limits, parsed-file reservations, disposal and bounded replay remain owned
by the existing stage. Reader validation reuses that owner and existing retained-path
checks. All artifacts remain seedReady=false.

Compared retaining ORM inputs, retaining all missing extraction families, and
persisting downstream graph deltas. Chose ORM inputs after a second challenge:
the production ORM phase consumes only these inputs, while the broader alternatives
introduce source/model-pack dependencies or bypass the semantics being tested.

Final capture uses the existing drained producer array. Missing input reads,
worker extraction arrays, parse errors, skipped/degraded work and unavailable or
capped language inputs invalidate completion. Review caught the second sequential
reread missing-file case; a regression now demonstrates its refusal. Successful
empty extraction is distinguished from unobserved output.

Validation from ontoindex/, native Linux, serialized, at most four workers:

- `ONTOINDEX_MAX_WORKERS=4 npm run build`: exit 0 twice; the second build includes
  the final reread guard. No install or deployment.
- `ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/unit/scope-retention.test.ts test/unit/scope-retention-candidate.test.ts test/unit/scope-retention-candidate-reader.test.ts test/unit/scope-retention-candidate-auxiliary-paths.test.ts test/unit/scope-retention-parsed-file-reservation.test.ts --maxWorkers=1`:
  exit 0, 589 tests, 3.68 seconds.
- Initial producer/replay batch: exit 1, 52 passed and 5 failed. Both existing
  replay suites passed all 50 tests; new fixtures incorrectly expected completion
  despite the scope grammar refusing nested ORM calls.
- First corrective producer/ORM run: exit 1, 6 passed and 1 failed. Producer suite
  passed all 3 tests. Each mode independently reproduced its complete live ORM
  graph, but cross-mode comparison exposed existing declare-const metadata differences.
- Final ORM suite: exit 0, 4 tests, 1.85 seconds, after removing unnecessary
  ambient declarations. Complete snapshots, persisted reconstruction, real recovery,
  duplicate queries, omitted/changed-query controls and corrupted bytes are checked.
- Current passing evidence: 646 tests across nine suites. Four suite invocations
  total, including two bounded corrective rounds; no all-tests claim.
- Scoped whitespace check exit 0. Bounded OntoIndex verify_diff PASS; expected
  symbol scope was omitted. Navigation/impact failed workspace_too_large (1832/1600);
  source inspection is authority. Four research and four implementation packets
  used Luna/Sol; two Sol developers also reviewed. Producer packet returned without
  edits and parent implemented it. All child jobs harvested; no detached tasks.

## Remaining limitations

Nonempty Prisma/Supabase fixtures currently hit unsupported-syntax in scope
extraction. They prove partial retained-input ORM replay, not complete producer
or seed admission. Existing ambient `declare const` nodes gain declaredType,
mutability, visibility and scope properties only on the worker path in this
fixture; this independent cross-mode discrepancy remains unresolved.

Fetch calls, framework/decorator routes and tool definitions still lack retained
families. Source-dependent downstream replay, active model-pack identity,
generation/post-edit admission, activation and runtime/performance acceptance
remain open. Closed manager tracking was not reopened or edited.
