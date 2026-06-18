# ADR 0095 Tracking

**ADR:** `docs/adr/0095-headroom-inspired-byte-stable-context-contracts-and-expandable-response-anchors.md`
**Manager:** Codex
**Status:** Complete
**Started:** 2026-06-17

## Architecture Gate

- Real new functionality only: response-contract metadata and deterministic expansion anchors.
- Core extension only: reuse existing MCP response, docs, review/diff, audit, and wiki surfaces.
- No proxy, compressor, hidden payload cache, external model, or new storage.

## Completed

- [x] First slice: `gn_docs` non-minimal reports expose `responseContract`.
- [x] First slice tests: deterministic docs anchors, cursor hints, minimal mode unchanged.

## Remaining Tasks

| ID | Status | Owner | Scope | Validation |
| --- | --- | --- | --- | --- |
| 0095-T1 | done | sub-agent `019ed75c-a8ea-7f61-97d8-26f6a03fd748` | Apply response contract to review/diff response surfaces only. | Focused unit tests + `npx tsc --noEmit` |
| 0095-T2 | done | sub-agent `019ed75c-e0ce-7ef1-bb4e-f66eb7718147` | Apply response contract to audit response surfaces only. | Focused unit tests + `npx tsc --noEmit` |
| 0095-T3 | done | sub-agent `019ed75d-0a9e-7751-a3b0-3e592b4f60d5` | Add wiki/export deterministic cleanup for generated wiki metadata only. | Focused wiki/export tests + `npx tsc --noEmit` |
| 0095-T4 | done | manager | Update MCP docs after implemented surfaces are verified. | `docs/reference/mcp.md` updated |

## Deferred

- Dedicated `expandEvidence` tool.
- Tokenizer-accurate accounting.
- Provider prompt-cache integration.
- Cross-call payload retrieval.
- Compression benchmarks.
- UI controls for compact/full response mode.
