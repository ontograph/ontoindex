# ADR 0079: Core interactive context staging and virtual diff selection

**Status:** Implemented (core workspace contracts)
**Source:** Obsidian Smart Composer review; narrowed 2026-06-10
**External reference:** <https://github.com/glowingjade/obsidian-smart-composer>

## Context

Smart Composer is useful as a reference because it makes context selection and edit review explicit:
users stage the material that should guide a generation, then accept or reject proposed changes in
small units.

OntoIndex should not copy Smart Composer as an editor, chat UI, prompt system, or LLM composition
layer. OntoIndex already has graph-backed symbol lookup, safe refactor previews, hunk-aware change
detection, markdown code mentions, audit reports, and agent workflow planning. The useful remaining
gap is a small core contract that lets OntoIndex describe:

- a bounded staged context;
- graph-backed mention resolution as structured inputs/outputs;
- virtual diff hunks and selection decisions before anything writes to disk.

## Current OntoIndex Evidence

Existing code already covers several parts of the original proposal:

- `gn_safe_refactor` exists as the write dispatcher and defaults to dry-run previews.
- OntoIndex context shows `gnSafeRefactor` is called from `dispatchSuper` and delegates to
  `detectChanges`, `resolveSymbol`, `dispatchDryRun`, `dispatchApply`, and `gnSafeEditCheck`.
- `gn_safe_edit_check`, `gn_verify_diff`, and `detect_changes` already provide safety and
  post-change verification guidance.
- `parseDiffHunks()` already extracts changed file/hunk spans from unified diffs for audit flows.
- OntoIndex context shows `parseDiffHunks()` is currently consumed by `detectChanges` and
  `parse-diff-hunks.test.ts`; it does not model user hunk decisions.
- Markdown sidecar enrichment already extracts code mentions from docs.
- OntoIndex context shows `extractCodeMentions()` belongs to markdown sidecar production, not an
  interactive workspace mention-resolution contract.
- ADR 0021 already defines a symbol-first workflow plan contract.
- ADR 0031, ADR 0059, ADR 0065, ADR 0067, ADR 0074, and ADR 0076 already added core evidence,
  grounding, subgraph packaging, retrieval composition, ontology validation, and schema-guided
  extraction contracts.
- Source tree review found no existing `ontoindex/src/core/workspace/` or
  `ontoindex/src/core/authoring/` package.

Those surfaces must be reused instead of replanned.

### OntoIndex Evidence Check

This ADR was challenged with local OntoIndex and source reads:

```bash
ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js status
ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js query "context staging virtual diff hunk selection mention resolution safe refactor parseDiffHunks detect_changes" --repo OntoIndex --limit 10
ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js context gnSafeRefactor --repo OntoIndex
ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js context parseDiffHunks --repo OntoIndex
ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js context extractCodeMentions --repo OntoIndex
```

## Challenge Findings

1. A new interactive editor or TUI is not core OntoIndex functionality.
2. A neural composer that writes documents while searching would introduce LLM orchestration, not a
   graph-core primitive.
3. Maintenance recipes and architectural scaffolding are workflow products; they should not land
   before the staged-context and virtual-diff contracts exist.
4. Adding public MCP tools first would duplicate existing super-functions and freeze an unstable
   contract too early.
5. `ContextualEntityFrames` was duplicated in the original ADR and overlaps ADR 0065/0067 context
   packaging.
6. `@`-mention parsing should not directly query storage in the core module. The core should accept
   supplied graph candidates or resolver results so it remains deterministic and testable.
7. Hunk selection should not apply patches, run git, or mutate files in core. It should produce a
   deterministic selection plan that adapters can apply later.

## Decision

Add one core extension: a pure interactive workspace contract for staged context and virtual diff
selection.

This extension is new because OntoIndex currently has safety checks and diff audits, but not a
reusable data contract that binds "the context used to draft this change" to "the exact hunks a user
accepted or rejected".

## Core Functionality

Create pure modules:

- `ontoindex/src/core/workspace/context-staging.ts`
- `ontoindex/src/core/workspace/mention-resolution.ts`
- `ontoindex/src/core/workspace/virtual-diff-selection.ts`

The modules should expose types and builders similar to:

- `StagedContext`
- `StagedContextEntry`
- `StagedContextEntryKind`
- `StagedContextDiagnostic`
- `MentionResolutionRequest`
- `MentionResolutionCandidate`
- `MentionResolutionResult`
- `VirtualDiff`
- `VirtualDiffFile`
- `VirtualDiffHunk`
- `VirtualDiffSelection`
- `VirtualDiffSelectionPlan`

## Required Behavior

The implementation must:

1. Build a deterministic staged context from supplied entries.
2. Support entry kinds for symbol, file, process, diagnostic, ADR, retrieval result, and freeform
   note.
3. Preserve provenance for every staged entry: source tool, graph UID when available, file path when
   available, line span when available, and confidence when supplied.
4. Deduplicate entries by stable identity while preserving deterministic ordering.
5. Enforce configurable limits for max entries and max estimated bytes, returning warnings instead
   of silently dropping context.
6. Resolve mention strings such as `@Symbol:AuthService`, `@File:src/auth.ts`, and
   `@Process:login` against supplied candidates or resolver output.
7. Report ambiguous, unresolved, unsupported, and truncated mentions as structured diagnostics.
8. Parse or accept a supplied virtual unified diff into files and hunks with stable hunk IDs.
9. Build a hunk selection plan from accept/reject/defer decisions without applying the patch.
10. Link each selected hunk to staged context entries and diagnostics when supplied.
11. Return summary counts: accepted hunks, rejected hunks, deferred hunks, affected files, and
    warnings.
12. Stay pure: no filesystem writes, no git commands, no MCP transport calls, no database access, no
    environment reads, no timers, no random values, and no LLM calls.

## Algorithm/Technique

Use pure normalization and stable identity:

1. Normalize entry IDs from explicit IDs first, then graph UID, then path/line span, then content
   hash supplied by the caller.
2. Sort staged entries by kind, stable identity, and insertion order.
3. Parse mentions into `{ kind, query }` pairs with explicit validation.
4. Rank supplied mention candidates by exact kind match, exact name/path match, confidence, and
   stable ID.
5. Preserve ambiguity when multiple candidates remain equivalent.
6. Parse virtual diff file headers and hunk headers into stable IDs such as
   `path@@oldStart,oldCount+newStart,newCount#index`.
7. Validate hunk decisions against known hunk IDs and return diagnostics for unknown or duplicate
   decisions.
8. Produce a selection plan only; adapters may later render it, ask the user, or apply accepted
   hunks.

## Rejected From Core

- Terminal UI, curses UI, VS Code UI, Cursor UI, or any interactive editor implementation.
- Public MCP tools such as `gn_stage_context` or `gn_compose_artifact` before the pure contracts
  exist.
- LLM prompt templates, neural writing loops, or automatic document composition.
- Recipe registries under `.ontoindex/recipes/`.
- Architectural scaffolding or boilerplate generation.
- Background JIT watchers for markdown drafts.
- Changing `gn_safe_refactor` write behavior or defaulting it to apply edits.
- Auto-committing accepted hunks.
- Applying patches inside the core module.
- Replacing ADR 0065/0067 context packaging with another frame abstraction.

## Later Adapter Opportunities

After the pure modules land, later work may:

- expose staged-context manipulation through MCP;
- let `gn_safe_refactor` return a `VirtualDiffSelectionPlan` in dry-run mode;
- render hunk decisions in a CLI or editor client;
- persist session-scoped staged context outside the pure module;
- connect mention resolution to graph queries through an adapter;
- add workflow recipes once the staged context contract is stable.

## Acceptance Criteria

1. The three core modules exist and export the public contracts above.
2. Unit tests cover deterministic staged-context ordering and deduplication.
3. Unit tests cover entry limits, byte limits, and warning diagnostics.
4. Unit tests cover exact, ambiguous, unresolved, and unsupported mention resolution.
5. Unit tests cover virtual diff parsing, stable hunk IDs, and selection summaries.
6. Unit tests prove unknown and duplicate hunk decisions are reported as diagnostics.
7. The implementation has no filesystem, git, MCP, DB, environment, timer, random, or LLM dependency.

## Validation Gates

- `cd ontoindex && npm test -- --run test/unit/workspace-context-staging.test.ts`
- `cd ontoindex && npm test -- --run test/unit/workspace-mention-resolution.test.ts`
- `cd ontoindex && npm test -- --run test/unit/workspace-virtual-diff-selection.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`

## Stop Conditions

Stop and re-review the ADR if implementation requires:

- adding an editor UI;
- adding an LLM dependency;
- changing `gn_safe_refactor` apply semantics;
- writing files from the core modules;
- starting an MCP server;
- querying LadybugDB/KuzuDB directly from these modules;
- introducing a persistent recipe system before the pure workspace contracts exist.

## Implementation Status

Implemented for the pure core workspace contract.

Implemented in:

- `ontoindex/src/core/workspace/context-staging.ts`
- `ontoindex/src/core/workspace/mention-resolution.ts`
- `ontoindex/src/core/workspace/virtual-diff-selection.ts`
- `ontoindex/test/unit/workspace-context-staging.test.ts`
- `ontoindex/test/unit/workspace-mention-resolution.test.ts`
- `ontoindex/test/unit/workspace-virtual-diff-selection.test.ts`

The implementation remains deliberately adapter-free: it does not add UI, MCP tools, LLM calls,
recipe registries, patch application, filesystem writes, git commands, database access, timers,
environment reads, or random values.
