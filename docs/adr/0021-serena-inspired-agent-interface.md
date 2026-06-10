# ADR 0021: Core symbol-first agent workflow plan contract

**Status:** Implemented (core symbol-first workflow plan contract)
**Source:** Serena architecture review; narrowed 2026-06-10
**External reference:** <https://github.com/oraios/serena>

## Context

Serena is useful as a reference because it treats code intelligence as an agent-facing workflow, not only as a data model. The original ADR mixed several different product layers: mode-scoped MCP help, symbol-first edits, optional LSP precision, project memories, session diagnostics, and cross-repo query modes.

That scope is too broad for a core ADR. OntoIndex must not copy Serena as a second semantic engine or build a second authority graph. OntoIndex already has persistent graph storage, impact analysis, execution flows, target context, audit lifecycle, and graph-aware review surfaces.

Current codebase evidence:

- MCP mode metadata already exists in `ontoindex/src/mcp/shared/tool-registry.ts`.
- `gn_help({ mode })` and `gn_tool_contract({ mode })` behavior is already covered by `ontoindex/test/unit/super/help.test.ts` and `ontoindex/test/unit/super/tool-registry-modes.test.ts`.
- `gn_safe_edit_check` already exists in `ontoindex/src/mcp/super/safe-edit-check.ts` and uses graph, test, and LSP helper evidence.
- Core organic recommendation validation already exists in `ontoindex/src/core/recommendations/organic.ts`.
- ADR 0023 already owns advisory memory and diagnostics guardrails.
- There is no `ontoindex/src/core/agent-workflow/` module, `SymbolFirstWorkflowPlan`, or equivalent pure core workflow-plan contract.
- The local OntoIndex index is up to date at commit `1b0e8ce`.

## Challenge Findings

The previous ADR should not be implemented as written.

1. Mode-aware MCP registry/help is already implemented and is not new core functionality.
2. `gn_help`, `gn_tool_contract`, and MCP discovery behavior are adapter surfaces, not core.
3. LSP precision expansion belongs to ADR 0013 and remains optional enrichment.
4. Advisory memories and session diagnostics belong to ADR 0023.
5. Cross-repo read-only query mode is an MCP/resource policy problem, not a core workflow primitive.
6. Dynamic MCP tool hiding remains rejected because many clients cache tool lists for a session.
7. Vendoring Serena or adding a parallel Serena runtime would duplicate OntoIndex authority.
8. A safe-edit MCP response shape is too coupled to graph queries, LSP, and tool names to be the core contract.

## Decision

Add only one new core capability: a pure symbol-first agent workflow plan contract.

The contract converts already-supplied evidence into a deterministic workflow plan for an agent-facing adapter. It does not query the graph, call LSP, inspect files, call MCP tools, mutate the repository, or depend on the MCP tool registry.

## Core Functionality

Create `ontoindex/src/core/agent-workflow/symbol-first-plan.ts`.

The module should expose deterministic data structures and pure functions for composing an agent workflow plan from supplied target, evidence, and readiness facts.

Minimum API:

- `SymbolFirstWorkflowIntent`: `read`, `modify`, `rename`, `delete`, `review`, or `audit`.
- `SymbolFirstWorkflowVerdict`: `SAFE`, `CAUTION`, `DANGEROUS`, or `BLOCKED`.
- `SymbolFirstWorkflowTarget`: target kind, name, optional file path, optional symbol UID, optional line.
- `SymbolFirstWorkflowEvidence`: supplied facts such as upstream caller count, downstream dependency count, process count, exported status, co-change count, test coverage likelihood, stale index flag, dirty worktree flag, and optional LSP readiness.
- `SymbolFirstWorkflowStep`: normalized required-read, action, verification, or blocker step.
- `SymbolFirstWorkflowPlan`: verdict, target, intent, required reads, recommended action, verification steps, blockers, warnings, and score trace.
- `buildSymbolFirstWorkflowPlan(input)`: pure report builder.

## Algorithm/Technique

1. Validate input:
   - target name and kind must be non-empty strings;
   - intent must be one of the supported workflow intents;
   - numeric evidence values must be finite non-negative integers;
   - optional tool/action names are opaque strings supplied by the adapter.
2. Normalize evidence:
   - trim target strings;
   - default missing numeric evidence to zero;
   - default unknown booleans to false;
   - preserve adapter metadata as opaque values.
3. Compute risk signals:
   - stale index or dirty worktree adds a blocker unless the adapter marks the plan as advisory-only;
   - exported symbol, high upstream count, high process count, or high co-change count increases risk;
   - missing test coverage for modify/rename/delete adds warning or blocker depending on risk.
4. Compute verdict:
   - `BLOCKED` when mandatory freshness or target facts are missing;
   - `DANGEROUS` for broad blast radius or destructive intent without enough evidence;
   - `CAUTION` for moderate blast radius, weak tests, or missing optional LSP readiness;
   - `SAFE` only when required evidence is present and risk is low.
5. Build required reads:
   - always include target symbol context;
   - include upstream impact for modify/rename/delete;
   - include downstream impact for delete and review;
   - include process/context reads when process count is non-zero.
6. Build recommended action:
   - emit an opaque action name such as `manual_patch_with_guard`, `rename`, or `review_only`;
   - do not validate against MCP callable tools in core.
7. Build verification:
   - include changed-scope detection for edit intents;
   - include diff verification for modify/rename/delete;
   - include test-gap review when supplied coverage is weak.
8. Return a plain object with deterministic step ordering and a score trace explaining each verdict contribution.

## Required Behavior

- Pure TypeScript only.
- No imports from `ontoindex/src/mcp/**`.
- No graph, Kuzu, LSP, file-system, web, sidecar, or LLM access.
- No dependency on Serena packages or language-server packages.
- No repository mutation.
- Deterministic output for identical input.
- Safe defaults when optional evidence is missing.
- Explicit blockers and warnings instead of hidden policy decisions.

## Rejected From This ADR

- Dynamic MCP tool exposure or hiding.
- More MCP tools.
- `gn_help` or `gn_tool_contract` changes.
- `gn_safe_edit_check` graph query changes.
- LSP bridge expansion.
- Project memories or onboarding resources.
- MCP session dashboard.
- Cross-repo query mode.
- Audit finding schema changes.
- Vendoring Serena.

## Later Adapter Opportunities

Future MCP, CLI, or web adapters may call `buildSymbolFirstWorkflowPlan` and map its opaque steps to actual tools. Those adapters must provide the evidence and tool/action names; the core module must remain unaware of MCP registration.

Possible later integrations:

- `gn_safe_edit_check` can use the core plan builder after it collects graph and LSP facts.
- CLI review can render the same plan for local workflows.
- Web UI can show the plan without re-implementing risk scoring.
- Mode-aware `gn_help` can reference the plan type without owning its scoring logic.

## Acceptance Criteria

- New module exists at `ontoindex/src/core/agent-workflow/symbol-first-plan.ts`.
- Focused unit tests exist at `ontoindex/test/unit/symbol-first-workflow-plan.test.ts`.
- Tests cover input validation, deterministic ordering, verdict escalation, stale/dirty blockers, edit verification steps, delete-specific reads, advisory-only behavior, and absence of MCP imports.
- Existing MCP mode registry/help tests remain unchanged.
- No package dependencies are added.

## Validation Gates

- `cd ontoindex && npm test -- --run test/unit/symbol-first-workflow-plan.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`
- `git diff --check -- docs/adr/0021-serena-inspired-agent-interface.md docs/adr/0000-index.md ontoindex/src/core/agent-workflow/symbol-first-plan.ts ontoindex/test/unit/symbol-first-workflow-plan.test.ts`

## Consequences

Positive:

- Agent-facing workflows get a reusable core plan contract instead of being embedded in MCP code.
- Existing MCP mode/help behavior remains intact and is not reopened.
- Future adapters can share one deterministic risk and workflow vocabulary.

Negative:

- This does not add new user-visible MCP behavior by itself.
- Adapters still need to collect graph, LSP, test, and freshness evidence before using the plan builder.
- Existing `gn_safe_edit_check` remains the production surface until a later integration pass wires it to the core contract.

## Stop Conditions

Stop and write a separate ADR if implementation requires:

- importing from `ontoindex/src/mcp/**`;
- querying LadybugDB or Kuzu;
- starting or calling LSP;
- reading or writing repository files;
- changing MCP discovery/help behavior;
- changing audit lifecycle schema;
- adding dependencies;
- calling an LLM.
