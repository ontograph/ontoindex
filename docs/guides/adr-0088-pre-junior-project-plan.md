# ADR 0088 Pre-Junior Project Plan: Agent-Ready Context and Symbol Ergonomics

**Status:** Ready for implementation
**ADR:** `docs/adr/0088-codegraph-inspired-agent-ready-context-and-symbol-ergonomics.md`
**Date:** 2026-06-17

## Challenge Result

This plan is intentionally smaller than the ADR. OntoIndex already has candidate ranking, ambiguity
responses, UID-based lookup, response guards, and some next-step hints. Pre-juniors should normalize
those existing pieces, not invent source readers, graph provenance rules, or new tool behavior.

## Goal

Make existing OntoIndex MCP answers easier for agents to reuse:

- symbols returned by `gn_explore` can be passed into `impact` without guessing;
- ambiguous lookups return ranked candidates and exact retry calls;
- optional agent-source context includes bounded source lines;
- outputs say when source/context is incomplete.

Do not add new MCP tools. Extend existing code.

## Hard Scope

Allowed files:

- `ontoindex/src/mcp/local/backend-symbol-resolution.ts`
- `ontoindex/src/mcp/local/backend-context.ts`
- `ontoindex/src/mcp/local/backend-impact.ts`
- `ontoindex/src/mcp/super/explore.ts`
- existing nearby MCP type/schema files only if needed
- focused unit tests under `ontoindex/test/unit/`

Not allowed:

- watcher/index sync work;
- daemon changes;
- storage backend changes;
- new MCP frontier tools;
- LLM summaries;
- broad installer work.

## Existing Owner Map

Use these existing owners. Do not create replacements.

| Area | Existing owner | What to extend |
| --- | --- | --- |
| Candidate ranking and ambiguity | `backend-symbol-resolution.ts` | Add shared identity/candidate output helpers |
| Context response | `backend-context.ts` | Use shared candidate shape and optional completeness metadata |
| Impact response | `backend-impact.ts` | Accept `nodeId` alias and use shared candidate shape |
| Explore response | `gn_explore` in `super/explore.ts` | Add retry examples only |
| Runtime budgets | ADR 0086 helpers / response guards | Reuse only; do not build another budget system |
| Provenance | ADR 0087 helpers | Senior-only follow-up; do not assign to pre-juniors |

## Task List

### T1: Standardize Symbol Identity Shape

**Owner files:**

- `ontoindex/src/mcp/local/backend-symbol-resolution.ts`

**Change:**

Add one exported helper that maps a resolved symbol or ambiguous candidate to a stable identity
object. Keep the helper pure; no database calls.

```ts
{
  nodeId: string;
  uid: string;
  displayName: string;
  filePath: string;
  kind: string;
  startLine?: number;
  endLine?: number;
}
```

`uid` and `nodeId` should be the same value for now. This is compatibility, not a new identity
system. Do not add `qualifiedName` until an existing field reliably provides it.

**Tests:**

- candidate with id/name/type/filePath maps to both `nodeId` and `uid`;
- missing label stays stable and does not throw.

**Done when:**

- no existing context/impact caller breaks;
- helper is used by at least one response path.

### T2: Normalize Ambiguous Responses

**Owner files:**

- `ontoindex/src/mcp/local/backend-context.ts`
- `ontoindex/src/mcp/local/backend-impact.ts`
- helper from T1

**Change:**

Use the shared identity shape for ambiguous candidates in both context and impact.

Add `suggestedNextCalls` with exact examples:

```ts
[
  'inspect({ action: "context", repo: "<repo>", uid: "<nodeId>" })',
  'impact({ action: "symbol", repo: "<repo>", target_uid: "<nodeId>", target: "<name>" })'
]
```

Keep the response successful. Do not turn ambiguity into a hard error.

Use strings only for now. Do not add a new command builder abstraction.

**Tests:**

- ambiguous context response includes `nodeId`, `uid`, and `suggestedNextCalls`;
- ambiguous impact response includes `nodeId`, `uid`, and `suggestedNextCalls`;
- old fields (`uid`, `name`, `kind`, `filePath`) remain present.

**Done when:**

- agents have an exact retry call from either ambiguous response.

### T3: Accept `nodeId` Alias at MCP Boundaries

**Owner files:**

- `ontoindex/src/mcp/local/tool-params.ts`
- `ontoindex/src/mcp/local/backend-impact.ts`
- `ontoindex/src/mcp/super/dispatch.ts` or the narrowest existing dispatch boundary if aliasing
  belongs there

**Change:**

Allow `nodeId` as an alias for existing `uid` / `target_uid` at the MCP boundary.

Do not change the internal resolver API. Normalize params near the boundary:

- `nodeId` -> `uid` for context/refactor-style calls;
- `nodeId` -> `target_uid` for impact-style calls.

If supporting refactor aliases touches more than two files, skip refactor for this task and keep the
first slice to context + impact.

**Tests:**

- `impact` accepts `nodeId` and resolves the same target as `target_uid`;
- existing `target_uid` still works;
- existing `uid` still works.

**Done when:**

- a `gn_explore.topSymbols[0].nodeId` value can be passed to impact unchanged.

### T4: Add Retry Examples to `gn_explore`

**Owner files:**

- `ontoindex/src/mcp/super/explore.ts`

**Change:**

For each `topSymbols[]` item, add bounded retry examples:

```ts
retryExamples: {
  inspect: 'inspect({ action: "context", repo: "...", uid: "..." })',
  impact: 'impact({ action: "symbol", repo: "...", target_uid: "...", target: "..." })'
}
```

Do not add large prose. Keep it machine-readable.

Use the existing `repoId` input string in the examples. Do not do another repo-resolution pass just
for display.

**Tests:**

- explore result includes retry examples for symbols with `nodeId`;
- no retry example is emitted when `nodeId` is empty.

**Done when:**

- the next tool call can be copied from `gn_explore`.

### T5: Add Context Completeness Metadata

**Owner files:**

- `ontoindex/src/mcp/local/backend-context.ts`
- `ontoindex/src/mcp/super/explore.ts` if useful

**Change:**

Add small metadata only where useful:

```ts
contextCompleteness: {
  sourceIncluded: boolean;
  truncated: boolean;
  missingReasons: string[];
  suggestedNextCalls?: string[];
}
```

Start simple:

- `sourceIncluded: true` when `include_content` returned content;
- `sourceIncluded: false` when no content;
- `missingReasons: ["source-not-requested"]` when `include_content` is false;
- `missingReasons: ["ambiguous-symbol"]` for ambiguous responses.

Do not implement a full budget engine here.

**Tests:**

- context without `include_content` reports source not requested;
- context with `include_content` and content reports source included;
- ambiguous context reports ambiguous-symbol.

**Done when:**

- callers can tell if another source-read may be needed.

### T6: Add Minimal Agent-Source Profile

**Owner files:**

- none in the first pre-junior pass unless T1-T5 are merged and tests are green

**Change:**

Postpone source inclusion for pre-juniors.

Reason: `gn_explore` currently uses `getFileSkeleton`, not exact symbol source extraction. Adding a
new source reader risks unbounded output and duplicate file-read logic. The lazy version is to ship
identity, retry calls, and context completeness first.

Senior follow-up can add `profile: "agent-source"` only if it can reuse existing symbol `content`
from the graph or an already-bounded source helper.

**Done when:**

- T1-T5 are complete and no source-reader work was added.

### T7: Mark Dynamic Boundary Metadata Only If Already Available

**Owner files:**

- none for pre-juniors

**Change:**

Do not assign this to pre-juniors. `computeGraphPath` currently returns graph-path edges; deciding
how to preserve provenance on those edges is a core design change and belongs to a senior follow-up.

**Done when:**

- no dynamic-boundary code is added in the pre-junior pass.

## Recommended Order

1. T1
2. T2
3. T3
4. T4
5. T5
6. Stop and ask for senior review

Do not start T6/T7 as pre-junior work. Source-backed context and dynamic-boundary metadata are useful
but too easy to overbuild.

## Validation Commands

Run from `ontoindex/`:

```bash
npm run test:unit -- backend-symbol-resolution
npm run test:unit -- backend-context
npm run test:unit -- backend-impact
npm run test:unit -- explore
npx tsc --noEmit
```

If test names differ, run the closest focused unit files. Do not run full integration for each
pre-junior task.

## Definition of Done

- ADR 0088 acceptance criteria are covered by focused tests.
- No new MCP tools were added.
- Existing `uid` / `target_uid` inputs still work.
- New `nodeId` aliases work where documented.
- Default outputs do not grow significantly.
- No `agent-source` profile is added unless a senior explicitly approves the source extraction path.
