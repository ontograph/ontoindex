# ADR 0087 Tracking

**Plan:** `docs/guides/adr-0087-pre-junior-project-plan.md`
**Status:** complete
**Manager:** Codex

## Evidence

- MCP `mcp__ontoindex` is scoped to `ontoindex` for current follow-up checks.
- Local index was refreshed after each landed task with `ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js analyze`.

## Tasks

| Task | Status | Owner | Notes |
| --- | --- | --- | --- |
| P1 provenance helper | done | worker `019ed608-0567-7d30-b4fc-b024802aeb2f` | Test and typecheck passed. |
| P2 impact node provenance | done | worker `019ed60a-74fa-7782-9804-a07f0eea7e80` | Test and typecheck passed; no DB fixture added. |
| P3 passive needs-update marker | done | worker `019ed608-4c1a-7b61-8334-521b732b17bb` | Test and typecheck passed. |
| P4 wiki navigation helper | done | worker `019ed60a-a9a0-7f93-bd4a-4773a5202fa3` | Test and typecheck passed; no wiki pipeline wiring. |
| P5 graph HTML metadata only | done | worker `019ed608-7ec3-7ea1-b090-9d383d71ba79` | Serializer needed a small allowlist; test and typecheck passed. |
