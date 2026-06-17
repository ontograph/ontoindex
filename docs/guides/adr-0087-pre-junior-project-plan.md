# ADR 0087 Pre-Junior Project Plan

**ADR:** [0087 Graphify-Inspired Core Provenance and Agent Wiki Navigation](../adr/0087-graphify-inspired-core-freshness-provenance-and-agent-wiki-navigation.md)
**Status:** Ready for small-task dispatch after challenge review
**Audience:** pre-junior implementation agents

## Goal

Expose graph-fact provenance and agent navigation metadata through existing OntoIndex outputs.

This plan is deliberately small. Pre-junior workers must not design new runtime surfaces.

## Non-Goals

- No `ontoindex watch`.
- No `ontoindex hook`.
- No automatic analyze on save, status, wiki, export, MCP, or commit.
- No new MCP tools.
- No new graph database or NetworkX dependency.
- No audit authority changes.
- No LLM wiki generation changes.
- No `ontoindex-web` changes.

## Challenge Review

The first draft was too broad for pre-juniors:

1. P2 said “likely consumers”, which invites repo-wide hunting.
2. P3 risked touching the LLM wiki generator instead of adding deterministic helper output.
3. P4 mixed metadata generation with UI filtering.
4. P6 duplicated existing truncation systems and had no crisp first file.
5. Hook/watch wording was still too tempting, despite ADR 0087 rejecting those commands.

This revision narrows each task to one small owner and one checkable output.

Second challenge pass:

1. P2 must not make `provenance` a required contract for every current impact caller. Add it as an
   optional field and populate it only in the impact kernel output path touched by this task.
2. P5 must verify current serialization first. If metadata is already preserved, the task is a
   regression test only.
3. Workers must not treat this plan as permission to refresh or redesign the wiki pipeline. P4 is a
   pure markdown helper; P5 is export payload preservation only.
4. The MCP server is now scoped to `ontoindex`. Earlier review evidence came from the local CLI
   while MCP was mis-scoped to `codex`; current follow-up checks can use MCP directly.

Local OntoIndex evidence from this review:

- `classifyGraphFactProvenance` is not present in the current graph, so P1 is real new core
  functionality.
- `createGraphOverviewHtml` resolves to
  `ontoindex/src/core/graph/graph-html-export.ts` and has low upstream risk: one direct test file.
- MCP `impact({ action: "symbol", repo: "ontoindex", target: "createGraphOverviewHtml" })`
  reports LOW risk with one direct test dependency and now includes impact-node provenance.

## Owner Map

| Task | Owner file(s) | Test file |
| --- | --- | --- |
| P1 provenance helper | `ontoindex/src/core/graph/fact-provenance.ts` | `ontoindex/test/unit/graph-fact-provenance.test.ts` |
| P2 impact node provenance | `ontoindex/src/core/impact/impact-kernel.ts` | `ontoindex/test/unit/impact-confidence.test.ts` |
| P3 passive needs-update marker | `ontoindex/src/cli/status.ts` | `ontoindex/test/unit/status.test.ts` |
| P4 wiki navigation helper | `ontoindex/src/core/wiki/navigation-pages.ts` | `ontoindex/test/unit/wiki-navigation-pages.test.ts` |
| P5 graph HTML metadata only | `ontoindex/src/core/graph/graph-html-export.ts` | `ontoindex/test/unit/graph-html-export.test.ts` |

P6 from the first draft is postponed. Existing truncation systems already exist under
`ontoindex/src/core/runtime/query-budget.ts`, `anytime-result-envelope.ts`,
`semantic-contracts.ts`, and multiple report helpers. Do not create a new truncation layer.

## Task P1: Pure Graph-Fact Provenance Helper

### Objective

Add a dependency-free helper that classifies graph facts for display only.

### Files

- Create `ontoindex/src/core/graph/fact-provenance.ts`
- Create `ontoindex/test/unit/graph-fact-provenance.test.ts`

### Required API

```ts
export type GraphFactProvenance = 'extracted' | 'inferred' | 'ambiguous';

export interface GraphFactProvenanceInput {
  relationType?: string;
  confidence?: number;
  evidenceClass?: string;
  authority?: string;
  freshness?: string;
}

export function classifyGraphFactProvenance(input: GraphFactProvenanceInput): GraphFactProvenance;
```

### Mapping

- `freshness` containing `stale`, `dirty`, `unknown`, or `degraded` -> `ambiguous`
- `authority` or `evidenceClass` containing `advisory` or `runtime_diagnostic` -> `ambiguous`
- `confidence < 0.5` or missing confidence -> `ambiguous`
- structural relations with confidence `>= 0.85` -> `extracted`
- confidence `>= 0.5` -> `inferred`

Structural relations:

```text
CALLS, IMPORTS, CONTAINS, DEFINES, EXTENDS, IMPLEMENTS,
HAS_METHOD, HAS_PROPERTY, METHOD_OVERRIDES, METHOD_IMPLEMENTS
```

### Tests

Must cover:

- high-confidence `CALLS` -> `extracted`
- high-confidence unknown relation -> `inferred`
- low confidence -> `ambiguous`
- stale freshness -> `ambiguous`
- advisory evidence -> `ambiguous`

Run:

```bash
cd ontoindex
npx vitest run test/unit/graph-fact-provenance.test.ts
npx tsc --noEmit
```

### Stop Conditions

- If graph DB access seems needed, stop.
- If audit status logic seems needed, stop.

## Task P2: Add Provenance to Impact Kernel Nodes Only

### Objective

Add optional `provenance` metadata to `ImpactKernelNode` values constructed by the impact kernel. Do
not touch MCP facades, CLI review, or risk scoring in this task.

### Files

- `ontoindex/src/core/impact/impact-kernel.ts`
- `ontoindex/test/unit/impact-confidence.test.ts`

### Required Change

Extend:

```ts
export interface ImpactKernelNode {
  ...
  confidence: number;
  provenance?: GraphFactProvenance;
}
```

When constructing an `ImpactKernelNode`, call:

```ts
classifyGraphFactProvenance({ relationType, confidence })
```

### Non-Goals

- Do not change counts.
- Do not change filters.
- Do not change risk reasons.
- Do not add provenance to every MCP response.
- Do not update broad snapshots just because the optional field appears in a serialized object.

### Tests

Add only impact-kernel-level assertions if an existing focused fixture already constructs impact
kernel nodes. If no focused fixture exists, add the smallest pure assertion around the construction
path and stop before adding a database integration test.

- known structural relation with high confidence has `provenance: 'extracted'`;
- unknown relation with fallback confidence has `provenance: 'inferred'` or `ambiguous`, matching P1.

Run:

```bash
cd ontoindex
npx vitest run test/unit/impact-confidence.test.ts
npx tsc --noEmit
```

### Stop Conditions

- If a caller snapshot test needs broad update, stop and report.
- If the only apparent test path requires building a real LadybugDB fixture, stop and report.

## Task P3: Passive `.ontoindex/needs_update` Status Reporting

### Objective

Teach `ontoindex status` to report an existing marker. Do not create the marker.

### Files

- `ontoindex/src/cli/status.ts`
- `ontoindex/test/unit/status.test.ts`

### Marker Formats

Plain:

```text
1
```

JSON:

```json
{
  "reason": "docs changed",
  "createdAt": "2026-06-17T00:00:00.000Z"
}
```

### Output

Add these lines when the marker exists:

```text
Needs update: docs changed
Repair: ontoindex analyze
```

For plain marker:

```text
Needs update: marker present
Repair: ontoindex analyze
```

### Non-Goals

- Do not add marker writers.
- Do not add watcher/hook commands.
- Do not change freshness state calculation.

### Tests

Add status tests for:

- no marker: no output line;
- plain marker;
- JSON marker with reason.

Run:

```bash
cd ontoindex
npx vitest run test/unit/status.test.ts
npx tsc --noEmit
```

## Task P4: Deterministic Wiki Navigation Helper

### Objective

Add a pure markdown-rendering helper for future wiki integration. Do not wire it into `WikiGenerator`
yet.

### Files

- Create `ontoindex/src/core/wiki/navigation-pages.ts`
- Create `ontoindex/test/unit/wiki-navigation-pages.test.ts`

### Required API

```ts
export interface WikiNavigationCommunity {
  id: string;
  label: string;
  symbolCount: number;
  fileCount?: number;
  topSymbols?: string[];
  relatedCommunities?: Array<{ label: string; count: number }>;
  provenanceCounts?: Partial<Record<'extracted' | 'inferred' | 'ambiguous', number>>;
  omittedSymbolCount?: number;
}

export function renderWikiNavigationIndex(input: {
  projectName: string;
  communities: WikiNavigationCommunity[];
}): string;

export function renderWikiCommunityPage(input: WikiNavigationCommunity): string;
```

### Output Requirements

- Index lists communities sorted by `symbolCount` descending.
- Community page includes top symbols when present.
- Community page includes provenance counts when present.
- Community page includes omitted-symbol notice when `omittedSymbolCount > 0`.

### Non-Goals

- Do not query LadybugDB.
- Do not call an LLM.
- Do not write files.
- Do not modify `WikiGenerator`.

### Tests

```bash
cd ontoindex
npx vitest run test/unit/wiki-navigation-pages.test.ts
npx tsc --noEmit
```

## Task P5: Graph HTML Export Metadata Only

### Objective

Make graph HTML export data preserve optional provenance and truncation fields when already present
on graph nodes/edges. Do not add UI filters yet. First inspect whether the serializer already keeps
unknown metadata fields; if it does, implement this task as a regression test only.

### Files

- `ontoindex/src/core/graph/graph-html-export.ts`
- `ontoindex/test/unit/graph-html-export.test.ts`

### Required Behavior

If source graph records include:

```ts
provenance
truncated
omittedCount
community
```

the generated HTML data payload must preserve those fields so later UI filters can use them.

If those fields are already preserved today, do not refactor the serializer. Add only the focused
test that proves the behavior.

### Non-Goals

- Do not add visible filter controls.
- Do not touch `ontoindex-web`.
- Do not change export command names.

### Tests

Add a focused assertion that the generated HTML contains serialized provenance/truncation metadata.

Run:

```bash
cd ontoindex
npx vitest run test/unit/graph-html-export.test.ts
npx tsc --noEmit
```

## Dispatch Order

1. P1
2. P2
3. P3
4. P4
5. P5

Do not run P2 before P1. P4 and P5 are independent after P1.

## Worker Prompt Template

```text
You are working in /opt/demodb/_workfolder/OntoIndex.
Use model gpt-5.4-mini when selectable.

Task: <P-task id and title from docs/guides/adr-0087-pre-junior-project-plan.md>

Rules:
- Implement only the named task.
- Keep the diff minimal.
- Do not add dependencies.
- Do not add watchers, hook installers, new MCP tools, auto-analyze behavior, or audit authority changes.
- Do not edit unrelated docs.
- Run the task-specific test and npx tsc --noEmit.
- If broad snapshot churn appears, stop and report it.

Before editing:
- Read docs/adr/0087-graphify-inspired-core-freshness-provenance-and-agent-wiki-navigation.md.
- Read this task section.
- Inspect the listed owner files.

Deliver:
- Changed files.
- Tests run and results.
- Any stop condition hit.
```

## Final Validation Bundle

After all tasks land:

```bash
cd ontoindex
npx vitest run \
  test/unit/graph-fact-provenance.test.ts \
  test/unit/impact-confidence.test.ts \
  test/unit/status.test.ts \
  test/unit/wiki-navigation-pages.test.ts \
  test/unit/graph-html-export.test.ts
npx tsc --noEmit
npm run build
```
