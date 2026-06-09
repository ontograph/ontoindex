# ADR 0079: Smart-Composer-inspired native interactive context staging and hunk editing

**Status:** Proposed
**Source:** Obsidian Smart Composer (GitHub: glowingjade/obsidian-smart-composer) review, 2026-06-01
**External reference:** <https://github.com/glowingjade/obsidian-smart-composer>

## Context

OntoIndex enables high-rigor architectural analysis, semantic validation (ADR 0074), and neural document composition (ADR 0078). However, when it comes to **Codebase Maintenance** and **Active Refactoring**, the interaction loop remains disjointed. Agents currently generate large strings of code that the user must manually copy-paste, or they use basic `replace` tools that fail if the context is even slightly misaligned.

The `obsidian-smart-composer` repository demonstrates a fluid UX for LLM interaction: users explicitly "Stage" context using `@-mentions`, the LLM proposes edits, and the user interactively "Accepts" or "Rejects" changes block-by-block.

By applying these concepts to OntoIndex, we can create a native **Interactive Workspace Orchestrator**. Instead of agents blindly modifying files, they construct a "Proposed Change Set" based on a formally "Staged Context," allowing developers to accept architectural refactors with surgical, hunk-level precision.

This ADR extends:
- [ADR 0017](0017-audit-lifecycle-layer.md), for audit findings and remediation;
- contextual focus;
- neural composition.

## OntoIndex Review Evidence

- OntoIndex allows agents to read files and run `replace`, but there is no native primitive for **Contextual Staging**—where a user or agent explicitly builds a bounded context (e.g., File A + Symbol B + Metric C) that restricts the LLM's focus for a specific task.
- Refactor execution is currently "all or nothing." There is no native core utility for **Interactive Hunk Selection**, where a proposed multi-file refactor is staged as an interactive diff for user review before being written to disk.
- There is no formalization for **Maintenance Recipes**—standardized templates for recurring tasks like "Generate Tests for this Module" or "Fix Lint Errors in Staged Context."

## Pruned Core Recommendations

### 1. `ContextStagingBuffer` (Bounded Working Sets)
- **Capability:** A session-scoped buffer where users or agents can explicitly add or remove symbols, files, and diagnostic reports to create a "Working Context."
- **Native Surface:** `ontoindex/src/core/workspace/staging-buffer.ts`.
- **Purpose:** Prevent context-window bloat by strictly limiting the agent's generative attention to explicitly staged nodes.

### 2. `SymbolAwareMentions` (Graph-Backed @-mentions)
- **Capability:** Allows the CLI or agent prompts to reference graph nodes directly (e.g., `@Symbol:AuthSvc` or `@Community:Database`). The engine intercepts these and injects the corresponding subgraph into the `ContextStagingBuffer`.
- **Native Surface:** `ontoindex/src/core/workspace/mention-resolver.ts`.

### 3. `InteractiveHunkApplicator` (Draft-Review-Commit)
- **Capability:** Instead of immediately rewriting files, `gn_safe_refactor` generates a virtual "Proposed Change Set." An interactive terminal or MCP interface allows the user to review the changes hunk-by-hunk, accepting or discarding them.
- **Native Surface:** `ontoindex/src/mcp/super/hunk-applicator.ts`.
- **Purpose:** Increase developer trust in agentic refactoring by providing granular control over the final write.

### 4. `DeclarativeMaintenanceRecipes` (Template Engine)
- **Capability:** A registry of parameterized templates (`.ontoindex/recipes/`) that combine specific Graph queries, active Lenses (ADR 0064), and LLM prompts for repetitive tasks (e.g., `/recipe generate-tests @Module:Core`).
- **Native Surface:** `ontoindex/src/core/workspace/recipe-runner.ts`.

### 5. `ArchitecturalScaffolding`
- **Capability:** A specialized recipe that, given an intent (e.g., "Add new API endpoint"), uses the graph to determine the required files (Route, Controller, Service, Test) and drafts the boilerplate for all of them into the staging buffer.
- **Native Surface:** `ontoindex/src/core/authoring/architectural-scaffolder.ts`.

### 6. `ContextualEntityFrames` (LLM-Optimized Subject Grouping)
- **Capability:** A viewing layer that pivots raw graph relationships into a structured "Frame" centered on a specific staged symbol. The frame groups all relevant relationships (Callers, Properties, Annotations) into a single, cohesive JSON/Markdown object when injected into the staging buffer.
- **Native Surface:** `ontoindex/src/core/workspace/frame-builder.ts`.
- **Purpose:** Drastically reduce the cognitive load and token count for agents trying to understand a specific architectural component staged in the context buffer.

### 7. `NeuralCompositionEngine` (Active Drafting)
- **Capability:** A specialized orchestration layer for agents tasked with authoring architectural docs. As the agent generates text (e.g., an ADR or Runbook), the engine continuously extracts concepts from the active buffer and queries the graph, injecting relevant citations directly into the agent's context window.
- **Native Surface:** `ontoindex/src/core/authoring/neural-composer.ts`.
- **Purpose:** Eliminate the rigid "Search -> Read -> Write" loop in favor of a fluid "Write-while-Searching" experience.

### 8. `JitContextScaffolder` (Real-Time Feedback)
- **Capability:** A background process that watches a draft buffer and provides "Did you mean to link?" suggestions for `ONTOINDEX.md` files or architectural Markdown, grounding free-text in concrete graph nodes.
- **Native Surface:** `ontoindex/src/core/authoring/jit-scaffolder.ts`.

### 9. `ContextualEntityFrames` (LLM-Optimized Subject Grouping)
- **Capability:** A viewing layer that pivots raw graph relationships into a structured "Frame" centered on a specific staged symbol. The frame groups all relevant relationships (Callers, Properties, Annotations) into a single, cohesive JSON/Markdown object when injected into the staging buffer.
- **Native Surface:** `ontoindex/src/core/workspace/frame-builder.ts`.
- **Purpose:** Drastically reduce the cognitive load and token count for agents trying to understand a specific architectural component staged in the context buffer.

## Decision

Implement the **Interactive Context Staging and Hunk Editing Contract** to orchestrate safe, user-gated code generation.

### Implementation Solution: Pure Contract First

1. **`WorkspaceContext` state**: Expose a managed state object tracking explicitly staged nodes and active recipes for the current session.
2. **`gn_stage_context` tool**: An MCP tool allowing agents to manipulate the staging buffer.
3. **`gn_compose_artifact` tool**: An MCP tool specifically for long-form authoring, which takes a "Goal" and iteratively drafts the document while internally managing JIT context retrieval.
4. **`VirtualDiff` generation**: Ensure `gn_safe_refactor` defaults to producing a standard `Unified Diff` that the `InteractiveHunkApplicator` can parse and present.

## Rejected From Core

- **Full Terminal UI (TUI) Editor**: OntoIndex core generates and manages the diff state and provides basic prompts, but it does not implement a complex curses-like IDE in the terminal. Rich UI integration remains the job of the client (Cursor, VS Code, or dedicated CLI wrapper).
- **Auto-Committing Accepted Hunks**: OntoIndex modifies the working tree; it does not run `git commit` automatically. The user remains responsible for version control.

## Validation Gates

- `npm run build`
- Unit tests verifying that `@Symbol:User` successfully adds the AST node and its 1-hop dependencies to the `ContextStagingBuffer`.
- Assertion that the `InteractiveHunkApplicator` can successfully apply Hunk 1 and discard Hunk 2 from a proposed virtual diff.
- Performance check: Resolving a symbol mention must complete in <100ms.
