# MCP review follow-ups 2.2.30 (2026-10-14)

Source: read-only review of installed 2.2.29 (four reviewers, gpt-6.1-sol and gpt-6-luna) plus a real-driver probe.

Real driver facts (installed @ladybugdb/core): a bad `<db>.wal` fails in `await db.init()`, never in the constructor. 4096 bytes of 0xff gives "Storage exception: Checksum verification failed, the WAL file is corrupted."; a 1-byte wal gives "Reading past the end of the file". Garbage text bytes were accepted. `close()` rejects with the init error until `_initPromise` is cleared. Opening with throwOnWalReplayFailure=false recovers and returns the checkpointed rows.

Fixed in 2.2.30: unreachable WAL recovery (also present in 2.2.26 and 2.2.28), per-entry cleanup of expired failed opens, shutdown drain of failed opens, atomic skill install, exact maxBytes in the pager.

Resolved: `isManagedClone` and `cloneFresh` are missing from the index only because they were added after the indexed commit 7b1494c (2.2.22 and 2.2.21).

Live check on installed 2.2.30 (throwaway copy of the rt2probe index, 4096 bytes of 0xff in lbug.wal): the pool opened it, returned 4 nodes and logged the WAL-discard warning; through the MCP server the same copy is refused earlier by assertIndexCanOpenReadOnly in src/mcp/local/local-backend-repo-runtime.ts (non-empty lbug.wal or lbug.shadow means run one coordinated analyze). Policy left as is; revisit only if automatic WAL-tail discard is wanted.

Still open: `.retention-managed` marker ordering; setup `.ontoindex-managed` marker can be copied by a user; doctor reports ambiguous at the 256-process cap; embeddings need ONTOINDEX_EMBEDDING_MODEL_HASH for managed repair, then one `analyze --embeddings` on a clean checkout; `clean --generations --force`, release 2.2.24+, removal of `ONTOINDEX_MCP_REPO` from the ontocode configs await the user.
