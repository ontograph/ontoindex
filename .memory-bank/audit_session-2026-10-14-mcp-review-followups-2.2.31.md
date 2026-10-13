# MCP review follow-ups 2.2.31 (2026-10-14)

Source: read-only review of installed 2.2.30 (four reviewers, gpt-6.1-sol and gpt-6-luna) plus memory and process measurements.

Measurements (installed 2.2.30, codex index 274 MB): a server is ~140 MB idle; the first graph query adds ~200 MB anon (`db.init()` alone, ~190 MB, independent of database size, connection count, thread count, buffer size and every Database constructor option tried; `db.close()` does not return it); a semantic search adds ~65 MB. Settled ~340-410 MB per server that has opened a graph.

Host: one ontocode session owned 21 ontoindex servers (plus 21 lean-ctx and 21 uv ghidra bridges) started in groups of three. Host source creates an MCP manager per spawned thread and shuts it down on `close_agent`; finished but unclosed agents keep their servers. Host-side fix, not OntoIndex.

Real driver facts: a WAL seeded and closed in the same process is consumed by the driver's asynchronous teardown (the WAL file disappears and the open succeeds); the gated real-WAL test seeds in a child process for that reason.

Fixed in 2.2.31: WAL-recovery classifier, doctor explicit-project verdict, setup sweep owner fencing, async git in diff tools, opt-in idle exit.

Still open: `.retention-managed` marker ordering; doctor reports ambiguous at the 256-process cap; embeddings need URL, MODEL and MODEL_HASH in the client config then one `analyze --embeddings` on a clean checkout (the 22:09 config rewrite dropped the embedding variables); MCP preflight refuses an index with a non-empty lbug.wal or lbug.shadow (policy unchanged); `clean --generations --force`, release 2.2.24+ await the user.
