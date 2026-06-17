# ADR 0088: CodeGraph-Inspired Agent-Ready Context and Symbol Ergonomics

**Status:** Proposed - Narrowed After Review
**Date:** 2026-06-17
**Source:** `./tmp/codegraph` donor review, challenged with OntoIndex MCP against ADR 0085, ADR
0086, ADR 0087, current MCP local backend, `backend-symbol-resolution.ts`,
`backend-context.ts`, `backend-impact.ts`, `gn_explore`, and context-neighborhood surfaces.

## Context

The CodeGraph donor contains many useful ideas, but most are already covered by OntoIndex or would
create a parallel runtime:

- ADR 0085 owns repo resolution without an environment harness.
- ADR 0086 owns runtime freshness, output budgets, recoverable errors, setup validation, and MCP
  liveness.
- ADR 0087 owns graph-fact provenance and agent wiki navigation.
- OntoIndex already has richer graph storage, MCP super-functions, docs evidence, impact analysis,
  audit flows, wiki generation, and graph HTML export.

The remaining useful donor lesson is smaller:

```text
Agents stop reading files only when the graph answer is source-backed, compact, unambiguous, and
copy-pasteable into the next graph call.
```

Today OntoIndex often returns good graph neighborhoods, and several primitives already exist:

- `backend-symbol-resolution.ts` centralizes candidate ranking, `uid` lookup, and ambiguity
  detection;
- `backend-context.ts` and `backend-impact.ts` already return ambiguous candidates in some paths;
- `impact` already accepts `target_uid`;
- MCP server next-step hints already teach some UID-based follow-up calls;
- ADR 0086 already owns output budgets and recoverable envelopes;
- ADR 0087 already owns graph-fact provenance.

The remaining gap is not a new resolver. It is that these pieces are not exposed as one consistent
agent contract:

- symbol names returned by query/context are not always accepted by impact/refactor;
- `uid`, `target_uid`, and `nodeId` naming differs by tool;
- ambiguous names do not always provide one exact next call;
- source snippets are not consistently available when they would replace a file read;
- dynamic or heuristic boundaries are not always surfaced as "partial coverage" warnings;
- compact agent profiles exist in places, but source-backed context is not a shared contract.

## Review and Challenge

Architecture-fit gate:

1. **Real new functionality gate:** pass only for source-backed agent context, symbol identity
   ergonomics, and dynamic-boundary disclosure. Reject runtime freshness, watcher, installer,
   daemon, storage, and generic ambiguity handling already covered or outside core.
2. **Core-extension gate:** pass only if implemented by standardizing existing
   `resolveSymbolCandidates`, `gn_explore`, `inspect`, `impact`, `refactor`, MCP local backend, and
   shared response-envelope helpers. Reject a new MCP frontier, new graph store, new daemon, or
   donor-specific query language.

Challenge findings:

1. **Do not add 50 tools.**
   Tool sprawl is the current failure mode. Add modes and response fields to existing tools.
2. **Do not copy CodeGraph's watcher model.**
   ADR 0086 already rejected automatic background analyze for phase 1.
3. **Do not replace LadybugDB or introduce SQLite/FTS as a second store.**
   This ADR is about output and identity contracts, not storage.
4. **Do not make agent behavior depend on prompt steering.**
   The durable fix is making tools the agent already calls return sufficient information.
5. **Do not hide uncertainty.**
   If OntoIndex only has heuristic or partial dynamic edges, outputs must say so.
6. **Do not rebuild ambiguity handling.**
   Candidate scoring and many ambiguous responses already exist. The work is to normalize output
   fields and retry examples.

## Decision

Approve one native capability:

**Agent-ready graph context: existing OntoIndex tools should return compact, source-backed,
identity-stable answers that can be reused directly by the next OntoIndex call.**

Approved scope:

1. source-backed context profiles for `gn_explore` and `inspect`;
2. copy-pasteable symbol identity fields across query/context/impact/refactor;
3. normalized ambiguity responses with ranked candidates and exact retry examples;
4. dynamic-boundary and partial-coverage markers on graph paths;
5. shared "context completeness" metadata that tells agents whether extra file reads are likely
   needed.

Not approved:

- new CodeGraph-style MCP tool family;
- file watcher sync;
- daemon registry rewrite;
- bundled no-Node runtime;
- SQLite/FTS replacement store;
- telemetry;
- broad multi-agent installer rewrite;
- new source-code summarization store;
- LLM-generated context.

## What Is New

### 1. Source-Backed Agent Context Profile

Add an optional response profile to existing exploration/context surfaces:

- MCP: `gn_explore({ profile: "agent-source" })`
- MCP: `inspect({ action: "context", include_content: true, profile: "agent-source" })`
- CLI follow-up can be added later only if the MCP shape proves useful.

Behavior:

- include source lines for the top exact symbols when under budget;
- include file path, start/end lines, node id, and stable UID;
- trim by a shared budget helper;
- include truncation metadata and a retry hint;
- never instruct the agent to perform an unrelated file read when the returned source is sufficient.

This extends existing output budget work from ADR 0086. It does not add a new content store.

### 2. Stable Symbol Identity Contract

Standardize existing symbol identity fields. Every graph-facing answer that returns symbols should
include:

- `nodeId`;
- `uid` as an alias only when needed for existing local tool compatibility;
- `displayName`;
- `qualifiedName` where available;
- `filePath`;
- `kind`;
- exact retry example for `impact`, `inspect`, or `refactor`.

Existing tools should accept their own returned `nodeId` values. For compatibility, tools may keep
their current parameter names (`uid`, `target_uid`) but must accept `nodeId` as an alias at the
MCP/super-function boundary. A user or agent should be able to copy a symbol from `gn_explore` into
`impact` without guessing syntax.

### 3. Ambiguity As Data, Not Failure

When a symbol lookup is ambiguous:

- return a successful response with ranked candidates;
- reuse `resolveSymbolCandidates` scoring;
- include bounded source/context per candidate only when the agent-source profile asks for it;
- include exact retry calls using `nodeId`;
- reserve hard errors for malformed input, unsafe paths, or real runtime failures.

This reuses ADR 0086 recoverable response envelopes.

### 4. Dynamic Boundary Markers

When graph paths cross heuristic or partial-resolution boundaries, mark them inline:

- `extracted`: structural AST or direct graph evidence;
- `inferred`: heuristic or framework-derived edge;
- `partial`: known dynamic boundary with incomplete static coverage.

This reuses ADR 0087 provenance. If ADR 0087's final vocabulary does not include `partial`, map it
to the existing `ambiguous`/`inferred` metadata plus a `boundary: "partial"` detail. Do not create a
second evidence vocabulary.

### 5. Context Completeness Metadata

Add a small response metadata field to agent-facing context results:

```ts
type ContextCompleteness = {
  sourceIncluded: boolean;
  truncated: boolean;
  missingReasons: string[];
  suggestedNextCalls?: string[];
};
```

Examples of `missingReasons`:

- `source-over-budget`;
- `ambiguous-symbol`;
- `stale-index`;
- `dynamic-boundary`;
- `not-indexed`;
- `unsupported-language`;
- `generated-file-skipped`.

## Integration with Current Core Solutions

### MCP Local Backend

Extend existing `LocalBackend.context`, `backend-context.ts`, `gn_explore`, and
context-neighborhood code. Do not add a new backend or routing layer.

### Symbol Resolution

Extend `backend-symbol-resolution.ts`; do not create a second resolver. The current candidate
ranking, Class/Constructor preference, `uid` lookup, and ambiguity result are the base.

### Impact and Refactor

Teach impact/refactor MCP boundaries to accept `nodeId` aliases for existing `target_uid`/`uid`
parameters. When resolution fails, return close candidates and exact retry examples.

### Response Envelope

Reuse existing budget, freshness, provenance, and recoverable-state metadata. Add only the small
context-completeness field where useful.

### Wiki and Graph HTML

No new wiki system. If source-backed context metadata is useful for generated wiki/HTML details
panels, expose the same identity and provenance fields there.

## Implementation Plan

### Phase 1: Identity Contract

1. Extend `backend-symbol-resolution.ts` with one shared candidate/identity output shape.
2. Ensure `gn_explore`, `inspect`, and semantic search include stable `nodeId` and retry examples.
3. Add `nodeId` aliases at MCP/super-function boundaries for existing `uid` and `target_uid`
   parameters.
4. Add tests for copy-paste flow: `gn_explore` result -> `impact`.

### Phase 2: Source-Backed Context Profile

1. Add `agent-source` profile behind existing include-content/budget helpers.
2. Include bounded source lines for top exact symbols only.
3. Emit context-completeness metadata.
4. Add tests for truncation and no unbounded file dumps.

### Phase 3: Ambiguity and Dynamic Boundaries

1. Normalize ambiguous lookup response shape across inspect/impact/refactor without changing the
   resolver algorithm.
2. Add dynamic-boundary markers using existing provenance helpers.
3. Add tests proving ambiguous and partial results are non-fatal and non-authoritative.

## Acceptance Criteria

- A symbol returned by `gn_explore` can be passed unchanged to `impact`.
- Ambiguous symbol lookup returns ranked candidates and exact retry calls, not a dead-end error.
- Agent-source context includes bounded source lines with line numbers and truncation metadata.
- Dynamic or heuristic edges are visibly marked without creating a new evidence model.
- Existing `uid` and `target_uid` callers continue to work.
- No watcher, new MCP tool family, new graph store, daemon rewrite, or telemetry is added.

## Rejected Donor Ideas

| Donor idea                         | Decision | Reason                                                             |
| ---------------------------------- | -------- | ------------------------------------------------------------------ |
| Add 50 new MCP tools               | Reject   | Tool sprawl; extend existing tools instead.                        |
| SQLite/FTS replacement             | Reject   | Parallel store; not an OntoIndex core extension.                   |
| Always-on watcher sync             | Reject   | ADR 0086 already rejects background writes for phase 1.             |
| Persistent daemon registry rewrite | Reject   | Existing MCP/doctor paths own liveness.                            |
| Multi-agent installer rewrite      | Postpone | Setup validation exists; broaden only after concrete client gaps.   |
| Prompt-steering-first behavior     | Reject   | Agents may ignore guidance; tool output must be sufficient itself.  |
| Hosted telemetry                   | Reject   | Not needed for local-first core.                                   |
| LLM source summaries               | Reject   | Context must be current graph/source evidence, not generated prose. |

## Related Decisions

- ADR 0085: MCP repo resolution without env harness
- ADR 0086: agent runtime freshness and budget controls
- ADR 0087: graph-fact provenance and agent wiki navigation
