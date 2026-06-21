# ADR 0100 Tracking

Status: Implemented - pending commit
Started: 2026-06-21

## Scope

Implement the narrowed ADR 0100 read-first projection without adding a new graph store, query DSL,
or duplicate tool family.

## Tasks

- [x] T1: Add shared read-first projection types/helper. Owner: worker `019ee8cc-018e-78b1-b46b-63e4cf502c44`.
- [x] T2: Extend `gn_explore(profile: "task-pack")` with read-first files and omitted counts. Owner: worker `019ee8d0-3802-7743-8fee-fe22a99637f3`.
- [x] T3: Extend `gn_find_related` with read-first files, files-only output, and omitted counts. Owner: worker `019ee8d0-6f51-7cb2-b6c0-9990633513ab`.
- [x] T4: Extend `gn_explain_module` with files-only output and read-first file reasons. Owner: worker `019ee8d0-ae52-7c72-bc75-90f865ee15eb`.
- [x] T5: Add focused tests and run targeted validation.
- [x] T6: Refresh the OntoIndex self-index after implementation.
- [x] T7: Add `format: "files"` / read-first projection to `repomap` without changing its storage/query model. Owner: worker `019ee8f0-2b3e-7700-ab18-9a3c862f2c51`.
- [x] T8: Add consistent close-match retry output for failed `gn_find_related` symbol lookups. Owner: worker `019ee8f0-5ed7-7721-9b4c-f5f54f740ed4`.
- [x] T9: Reconcile `gn_explore` with ADR acceptance: either add compact `format: "files"` or narrow the ADR; also fix duplicate accounting so omitted counts mean real omitted context. Owner: worker `019ee8f0-957e-72a2-a94a-444d6ad42216`.
- [x] T10: Reconcile ADR/tracking status and validation after T7-T9.
- [x] T11: Align legacy `repomap` MCP schema with the implemented `format: "files"` option. Owner: worker `019ee8fe-732d-7a41-8537-f118cb13163a`.
- [x] T12: Replace the unsafe `gnExplore` files-format return cast with an explicit typed contract. Owner: worker `019ee8fe-73e8-7703-95c6-50b407d0ca26`.

## Manager Notes

- Sub-agents must not create duplicate tools such as `quick`, `deps`, `rdeps`, or `flow`.
- Prefer options on existing MCP super-functions.
- MCP in this Codex session may still be scoped to another repo; use local CLI/source checks when
  MCP repo discovery is wrong.

## Validation

- `cd ontoindex && npm test -- --run test/unit/mcp-read-first-projection.test.ts test/unit/super/explore.test.ts test/unit/super/find-related.test.ts test/unit/super/explain-module.test.ts`
  - Passed: 4 files, 31 tests.
- `cd ontoindex && npm exec tsc -- --noEmit --pretty false`
  - Passed.
- `cd ontoindex && npm exec prettier -- --check ...`
  - Passed for ADR 0100 touched files.
- `ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js analyze --force`
  - Passed: 38,154 nodes, 56,599 edges, 1,301 clusters, 300 flows.
- Reconciliation validation:
  - `cd ontoindex && npm test -- --run test/unit/mcp-read-first-projection.test.ts test/unit/super/explore.test.ts test/unit/super/find-related.test.ts test/unit/super/explain-module.test.ts test/unit/backend-repomap.test.ts`
    - Passed: 5 files, 36 tests.
  - `cd ontoindex && npm exec tsc -- --noEmit --pretty false`
    - Passed.
  - `cd ontoindex && npm exec prettier -- --check ...`
    - Passed for ADR 0100 touched files.
- Final self-index refresh:
  - `ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js analyze --force`
    - Passed: 38,188 nodes, 56,651 edges, 1,306 clusters, 300 flows.
- Review cleanup validation:
  - `cd ontoindex && npm test -- --run test/unit/tools.test.ts test/unit/super/explore.test.ts test/unit/mcp-read-first-projection.test.ts test/unit/super/find-related.test.ts test/unit/super/explain-module.test.ts test/unit/backend-repomap.test.ts`
    - Passed: 6 files, 57 tests.
  - `cd ontoindex && npm exec tsc -- --noEmit --pretty false`
    - Passed.
  - `cd ontoindex && npm exec prettier -- --check src/mcp/tools.ts src/mcp/super/explore.ts test/unit/tools.test.ts`
    - Passed.
  - `cd ontoindex && npm run build`
    - Passed.
  - `ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js analyze --force`
    - Passed: 38,191 nodes, 56,652 edges, 1,308 clusters, 300 flows.
