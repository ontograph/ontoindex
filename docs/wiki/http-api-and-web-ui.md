# HTTP API And Web UI

## HTTP API

The HTTP server is implemented primarily in `ontoindex/src/server/api.ts`, with additional route modules for analyze, embeddings, MCP-over-HTTP, and server jobs.

Indexed routes discovered for the current repo include:

| Route | Handler |
| --- | --- |
| `/api/heartbeat` | `ontoindex/src/server/api.ts` |
| `/api/info` | `ontoindex/src/server/api.ts` |
| `/api/repos` | `ontoindex/src/server/api.ts` |
| `/api/repo` | `ontoindex/src/server/api.ts` |
| `/api/graph` | `ontoindex/src/server/api.ts` |
| `/api/query` | `ontoindex/src/server/api.ts` |
| `/api/search` | `ontoindex/src/server/api.ts` |
| `/api/file` | `ontoindex/src/server/api.ts` |
| `/api/grep` | `ontoindex/src/server/api.ts` |
| `/api/processes` | `ontoindex/src/server/api.ts` |
| `/api/process` | `ontoindex/src/server/api.ts` |
| `/api/clusters` | `ontoindex/src/server/api.ts` |
| `/api/cluster` | `ontoindex/src/server/api.ts` |
| `/api/embed` | `ontoindex/src/server/api-embed-routes.ts` |
| `/api/embed/:jobId` | `ontoindex/src/server/api-embed-routes.ts` |
| `/api/embed/:jobId/progress` | `ontoindex/src/server/api-embed-routes.ts` |
| `/api/analyze` | `ontoindex/src/server/api-analyze-routes.ts` |
| `/api/analyze/:jobId` | `ontoindex/src/server/api-analyze-routes.ts` |
| `/api/analyze/:jobId/progress` | `ontoindex/src/server/api-analyze-routes.ts` |
| `/api/mcp` | `ontoindex/src/server/mcp-http.ts` |
| `/api/mcp/diagnostics` | `ontoindex/test/unit/api-guards.test.ts` |

## Web UI

The web UI lives in `ontoindex-web/` and uses React 19, Vite 8, Sigma, Graphology, D3, Mermaid, and Tailwind 4.

Important directories:

| Path | Responsibility |
| --- | --- |
| `ontoindex-web/src/components/` | UI components and graph panels. |
| `ontoindex-web/src/hooks/` | React state and behavior hooks. |
| `ontoindex-web/src/services/` | API access layer. |
| `ontoindex-web/src/core/graph/` | Graph-specific frontend logic. |
| `ontoindex-web/e2e/` | Playwright tests. |
| `ontoindex-web/test/` | Vitest unit tests. |

## Local Commands

```bash
cd ontoindex && npm run serve
cd ontoindex-web && npm run dev
```

The web UI talks to the OntoIndex HTTP API rather than reading the graph store directly.
