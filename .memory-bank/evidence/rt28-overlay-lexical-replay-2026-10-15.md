Overlay query replay: OR-of-CONTAINS, no IN/LIMIT
Target: rt28_created_file_symbol
Runs: 20
Matching symbol rows per run: 1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1
Runs with symbol row: 20/20
Stable row counts: true
Stable symbol IDs: true
Sample: {"id":"Function:ontoindex/src/core/contract/rt28-created.ts:rt28_created_file_symbol","name":"rt28_created_file_symbol","type":"","filePath":"ontoindex/src/core/contract/rt28-created.ts","startLine":0,"endLine":2}
Read-only; no reindex performed.

Fix: `query` in backend-search.ts no longer sends `n.filePath IN $paths` or LIMIT to the overlay DB. It filters rows by overlay path in JS and then applies the search limit.
Suite: test:unit, 14 failures in 5 unrelated files on an unbuilt worktree; all 84 tests in those files pass after `node scripts/build.js`.
Residual: the root cause in LadybugDB 0.17.1 is not confirmed. The live RT-28 new-file scenario has not been re-run end to end.
