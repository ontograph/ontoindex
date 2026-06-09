# ADR-0013: LSP bridge integration

**Status:** Accepted (env-gated default-OFF)
**Date:** 2026-04-29 (v8 W1c-pivot)
**Source:** `ontoindex/src/core/lsp/bridge.ts`, `client.ts`; usage in `ontoindex/src/mcp/local/backend-search.ts`.

## Context

OntoIndex's static analysis pipeline (tree-sitter + provider hooks) gives ~95% accurate `find-references` and `find-callers` for most languages. For high-precision use cases (e.g., agent rename refactors), 100% accuracy is required. Language Server Protocol (LSP) servers for TypeScript, Rust, Python, etc., provide language-aware semantic analysis — they're the gold standard for find-references.

The v7+ pivot Pillar 2 ("ground truth") proposed LSP integration. v8 W1c-pivot shipped the `bridge.ts` + `client.ts` infrastructure but did not wire it into the search path. v8 W1c-pivot follow-up (or v9) integrated it via `ONTOINDEX_LSP_REFERENCES=1` env gate — env-gated default-OFF to preserve existing behavior.

## Decision

LSP integration is **enrichment, not replacement** — runs after the normal hybrid retrieval and attaches LSP find-references results to the top-1 result as a side-channel field. Env-gated `ONTOINDEX_LSP_REFERENCES=1` (default OFF). Best-effort: never blocks query, never alters RRF ranking.

## Algorithm / Technique

### Activation gate (`backend-search.ts:361-385`)

```
if (process.env.ONTOINDEX_LSP_REFERENCES === '1') {
  const topResult = mergedRaw[0];
  if (topResult?.data?.filePath && topResult?.data?.startLine) {
    try {
      const refs = await lspBridge.findReferences({
        filePath: topResult.data.filePath,
        line: topResult.data.startLine,
        character: topResult.data.startColumn ?? 0,
      });
      (topResult as any).lspRefs = refs;  // duck-typed side channel
    } catch (err) {
      // Best-effort — log and continue
      console.warn('LSP find-references failed:', err);
    }
  }
}
```

### LSP bridge architecture (`bridge.ts`)

1. **Server discovery:** check `~/.config/lsp-bridge.json` for configured language servers (e.g., `typescript-language-server`, `rust-analyzer`). Fall back to common defaults.
2. **Server lifecycle:** `bridge.ts` manages a pool of long-running LSP server processes (one per language). Servers are spawned on first use and kept warm.
3. **Document sync:** when OntoIndex is asked about a file, send `textDocument/didOpen` to the language server with the current content. Subsequent requests against the same file use the synced state.
4. **Request:** for `find-references`, send `textDocument/references` with the symbol's position. The server returns a list of `Location` objects.

### Client transport (`client.ts`)

LSP uses Content-Length-framed JSON-RPC over stdin/stdout. `client.ts` implements:
- Header parser (`Content-Length: N\r\n\r\n` + N bytes of JSON).
- Request/response correlation via `id` field.
- Timeout per request (default 5s; LSP servers can hang on large files).

### Why "enrichment, not replacement"

Replacing the static-analysis call graph with LSP would:
- Require LSP servers for every language (not all are mature; e.g., COBOL has no LSP).
- Introduce LSP server availability as a hard prerequisite — OntoIndex would refuse to operate without language-specific tools installed.
- Slow query latency by 100-500ms per LSP request.

Enrichment instead:
- Static analysis covers all languages with 95% accuracy.
- LSP fills in the "make this 100% accurate for the top result" use case.
- Default OFF means no impact for users who don't need it.

### Why "side-channel field"

`(topResult as any).lspRefs = refs;` attaches an untyped property to the result object. Downstream callers that don't know about `lspRefs` see no change — the field is silently ignored. Callers that DO know about it (specifically, MCP refactor tools that need 100% accurate find-references) read it.

This is a duck-typed side channel — not in the public schema. The trade-off: low integration cost; no schema migration. Risk: the field could be lost in serialization paths that don't preserve untyped properties (e.g., JSON.stringify with custom replacers).

### Why top-1 only

LSP find-references is expensive (100-500ms per request). Calling it for every result in the top-50 would add 5-25 seconds. Top-1 is the most likely "correct" result for refactor use cases (e.g., the user asked `findUsers` → top-1 is the function `findUsers` → LSP gives 100% accurate callers).

If the top-1 is wrong, the agent can fall back to static-analysis call graph for the broader set.

### Per-language coverage

| Language | LSP Server | Status |
|---|---|---|
| TypeScript / JavaScript | `typescript-language-server` | Available |
| Python | `pyright` or `pylsp` | Available |
| Rust | `rust-analyzer` | Available |
| Go | `gopls` | Available |
| Ruby | `solargraph` | Partial — find-references can be slow |
| Java | `jdtls` | Available — slow startup (~30s) |
| C/C++ | `clangd` | Available — requires `compile_commands.json` |
| COBOL / Swift | none | Not supported (fall back to static analysis) |

### Server lifecycle management

LSP servers are kept warm but bounded:
- Max 5 concurrent servers (one per most-recent language).
- Idle timeout: 5 minutes — server is killed and respawned on next request.
- Crash recovery: on server crash (process exit), respawn on next request.

## Consequences

**Positive:**
- 100%-accurate find-references for top-1 result (when LSP available)
- Default OFF — zero impact on default users
- Best-effort — never blocks the main query
- Server pool keeps LSP responsive (no cold-start per request after warmup)

**Negative:**
- Duck-typed `lspRefs` field is fragile — schema-disconnected
- Top-1 only; can't enrich broader result set without latency hit
- LSP servers require external installation (varies by user environment)
- COBOL / Swift lack LSP support → these languages can't benefit
- Server lifecycle adds operational complexity (pool size, idle timeout, crash recovery)

**Open issues for future work:**
- Promote `lspRefs` to a typed field in the result schema
- LSP-aware refactor tools (rename, move) that use LSP `prepareRename` for higher accuracy
- Caching of find-references per (file, line, version) tuple
- Streaming top-3 LSP enrichment when network is fast enough
