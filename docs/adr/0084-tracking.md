# ADR 0084 Tracking

**ADR:** [0084-html-first-visual-wiki-and-architecture-export-surfaces.md](./0084-html-first-visual-wiki-and-architecture-export-surfaces.md)
**Status:** In progress
**Updated:** 2026-06-13

## Task Ledger

| ID | Task | Owner | Status | Notes |
|---|---|---|---|---|
| T1 | Define export shape and reusable core graph data sources for `export graph-html` | manager | completed | Reuse current graph API/build path semantics; source of truth is core graph/process/community data |
| T2 | Implement self-contained `graph-overview.html` export with embedded payload and slice controls | manager | completed | Added reusable static graph artifact renderer and `export graph-html` command output |
| T3 | Add functional slice filters for process/community/module/type/depth in exported HTML | manager | completed | Derived slices from current graph/process/community evidence; anchor-depth filtering included |
| T4 | Link exported graph artifact from wiki/export surfaces | manager | completed | Export command refreshes wiki viewer when the artifact lands in a wiki directory; viewer shows a graph link when present |
| T5 | Add focused tests and refresh index after each completed task | manager | completed | `npx tsc --noEmit`, focused vitest green, repo analyze refresh confirmed up to date |

## Constraints

- Must use current export/wiki families; no new top-level HTML subsystem.
- Must use OntoIndex core graph/process/community data, not markdown summaries as primary input.
- Must keep output self-contained and static.
- Must refresh OntoIndex index after each completed task.
- Sub-agents must use `gpt-5.4-mini`.
