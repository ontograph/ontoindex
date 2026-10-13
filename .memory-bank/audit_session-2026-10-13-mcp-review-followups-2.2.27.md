# MCP review follow-ups 2.2.27 (2026-10-13)

Source: read-only review of installed 2.2.26 with four reviewers (gpt-6.1-sol, gpt-6-luna).

Fixed in 2.2.27:
- LBUG buffer default 64 MB (unset/0/invalid), env override kept.
- Host/Origin guard for eval-server and REST API (`src/server/request-guard.ts`); `/api/mcp` already had SDK rebinding protection.
- Facade schema-derived numeric clamps; array and aggregate caps in `shared/arg-limits.ts`.
- Shutdown handlers before connect plus stdin `close`; reader-pin PID-reuse detection via /proc starttime.

Still open: failed native opens stay pooled until exit; hand-edited `.retention-managed` marker can reorder rollback candidates; response-page custom maxBytes can throw; no shutdown unit test seam; `clean --generations --force`, release 2.2.24+, `ontoindex setup`, config edits (remove `ONTOINDEX_MCP_REPO`) await the user.
