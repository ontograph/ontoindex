# ADR 0100: Codespaces-inspired Boundary-first Context and Query Ergonomics

Status: Implemented - pending commit
Date: 2026-06-21
Source: Donor review of `tmp/codespace`

## Context

The donor project builds a small `.belief_map.sexp` from source and infra files, then exposes
compact commands such as `quick`, `analyze`, `boundary`, `deps`, `rdeps`, `flow`, and simple
Scheme-like set queries. OntoIndex already has the durable graph, MCP frontier, wiki/export paths,
impact analysis, docs reports, and richer schema. Rebuilding the donor's S-expression store would
be duplicate infrastructure.

The useful delta is narrower: make existing OntoIndex graph results easier for agents to use before
they read source or edit code. Current OntoIndex already has `gn_explore`, `gn_explain_module`,
`gn_find_related`, `gn_graph_walk`, `repomap`, target-context retry hints, and Mermaid wiki helpers.
This ADR must not re-create those surfaces under donor names.

## Architecture Fit Gate

### Real New Functionality

Passes only for one missing behavior: a bounded, copy-pasteable "what should the agent read first?"
projection across existing context tools. This ADR is not a new graph store, parser, query engine,
diagram engine, or replacement wiki.

### Core Extension

Passes. The work extends current CLI/MCP/wiki surfaces over the existing OntoIndex graph. It must
reuse current symbol, impact, process, docs, target-context, and diff data instead of introducing a
parallel `.belief_map` artifact.

## Challenge Findings

- `gn_explore(profile: "task-pack")` already returns top files, top symbols, and next calls. A new
  `quick` tool is only justified if it adds module-boundary and read-first ordering that `task-pack`
  does not provide.
- `gn_explain_module` already gives a file/module overview. The ADR should extend it with boundary
  neighbors and read-first output instead of inventing a second module card.
- `gn_find_related`, `impact`, and `gn_graph_walk` already cover dependencies and traversal. This ADR
  should not add `deps`, `rdeps`, or `flow` aliases.
- Mermaid generation already exists in wiki utilities. Donor diagram ideas are not new core
  functionality unless they expose an existing path in a missing CLI/MCP format.
- Target-context resolution already returns structured not-found/ambiguous statuses in several MCP
  paths. The useful gap is consistent close-match suggestions at symbol/module lookup sites, not a
  separate suggestion system.

## Decision

Add a small boundary-first projection across existing core surfaces.

Approved scope:

1. **Read-first projection.** Add a reusable projection that returns the smallest useful file set for
   an agent: primary definition file, direct caller/callee files, owning cluster/module files, and
   relevant docs when already available.
2. **Extend existing context tools.** Add the projection to `gn_explore(profile: "task-pack")`,
   `gn_explain_module`, `gn_find_related`, and `repomap` where each tool already has the required
   graph facts.
3. **Files-only output.** Add a `format: "files"` or equivalent compact option to the above tools so
   agents can request only ordered file paths plus short reasons.
4. **Bounded counts.** Include counts for hidden/omitted neighbors so compact outputs stay honest
   without dumping full result sets.
5. **Consistent close matches.** Reuse target-context resolution patterns so failed symbol/module
   lookups return close matches and one copy-pasteable retry.

Not approved:

- adding `.belief_map.sexp` or another persisted graph representation;
- adding a Scheme interpreter or broad custom query language;
- replacing LadybugDB/OntoIndex graph queries with text-fact grep;
- adding a second infra topology system before current wiki/graph export paths need it;
- duplicating `impact`, `inspect`, `search`, or docs tools under new names;
- adding `deps`, `rdeps`, `flow`, or `quick` aliases unless an existing tool cannot carry the
  projection cleanly;
- adding generic set algebra (`intersect`, `union`, `diff`) before a concrete core workflow needs it;
- adding new Mermaid generators while existing wiki diagram helpers cover the path;
- adding model-memory or agent-session state unrelated to graph context.

## Implementation Notes

Keep this boring:

1. Put the projection in one shared helper close to existing MCP super-function context code.
2. Prefer options on existing tools before adding a new tool. A new `gn_quick_context` is acceptable
   only if it is a thin orchestrator over existing helpers.
3. Keep outputs bounded and summary-first by default.
4. Use stable file paths, node identifiers, and retry examples that users can paste back into CLI/MCP
   calls.
5. Do not make the wiki the first implementation target; prove the projection in MCP/CLI output
   first, then reuse it in wiki pages if it is still useful.

## Acceptance

- Implemented: a user can ask for context for a symbol, module, or concept and receive a bounded
  read-first file list with reasons.
- Implemented: users can request compact ordered file paths from `gn_explore`,
  `gn_explain_module`, `gn_find_related`, and `repomap`.
- Implemented: failed `gn_find_related` symbol lookups return close matches with copy-pasteable
  retry calls. Other lookup surfaces should reuse the same pattern when they are touched.
- Implemented: compact outputs include omitted counts so agents understand when the result was
  capped.
- Implemented: no new persistent graph store, parser stack, detached query runtime, duplicate tool
  alias, or Mermaid generator was added.

## Implementation Summary

- Added shared `projectReadFirstFiles` projection helper.
- Extended `gn_explore(profile: "task-pack")` with `readFirstFiles` and `omittedCounts`.
- Added `format: "files"` compact output to `gn_explore`, `gn_explain_module`, `gn_find_related`,
  and `repomap`.
- Added close-match retry output to `gn_find_related` not-found responses.
- Kept all work on existing graph/MCP surfaces.

## Deferred

Infrastructure topology import may be valuable later, but only after it can be attached to the
existing OntoIndex graph and wiki export without creating a parallel deployment graph.
