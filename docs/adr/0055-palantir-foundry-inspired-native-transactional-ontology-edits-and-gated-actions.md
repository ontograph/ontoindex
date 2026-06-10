# Palantir-Foundry-inspired native transactional ontology edits and gated actions

**Status:** Postponed
**Source:** Palantir Foundry OSDK Ontology Edits review, 2026-05-31
**External reference:** <https://www.palantir.com/docs/foundry/functions/python-ontology-edits>

## Context

Palantir Foundry uses a "Unit of Work" pattern for modifying its Ontology. Changes are staged in an `ontology_edits` container, validated against business logic and "Action Types," and then applied atomically. Objects are read-only by default and must be explicitly transitioned to an "editable" state.

OntoIndex currently implements WRITE operations (rename, modify-body, extract, move) as isolated, atomic calls via `gn_safe_refactor`. While these include pre-edit safety checks and post-edit change detection, they lack a generalized transaction layer that allows an agent or user to stage multiple disparate refactors across the graph and commit them as a single, validated unit.

This ADR extends:
- [ADR 0017](0017-audit-lifecycle-layer.md), for lifecycle management;
- [ADR 0027](0027-mcp-startup-surface-profiles.md), for WRITE super-function classification;
- semantic contract checks;
- DB operation diagnostics;
- conceptual mapping.

## OntoIndex Review Evidence

- OntoIndex `gn_safe_refactor` is a "Pure facade" that delegates to single-operation tools (rename, move, etc.).
- There is no native `Transaction` or `ChangeSet` primitive in the OntoIndex core that persists across multiple tool calls in a single session.
- Symbols in the graph do not have an "Editable" vs "Read-Only" state; any WRITE tool can attempt to modify any resolved symbol.

## Pruned Core Recommendations

These recommendations focus on adding a **Transactional Layer** and **Gated Write Path** to the OntoIndex core.

### 1. `NexusTransaction` (Unit of Work) Container
- **Capability:** A session-scoped container that tracks a sequence of intended graph and file mutations.
- **Native Surface:** `ontoindex/src/core/refactor/transaction-manager.ts`.
- **Logic:** `startTransaction()` -> `stageEdit(operation)` -> `commitTransaction()`.
- **Atomic Rollback:** If the final `commit` fails (e.g., due to a failed linter or test), OntoIndex automatically applies the inverse operations (e.g., `git restore`) to all affected files.

### 2. Editable Proxy Symbols (State Lock)
- **Capability:** Symbols must be explicitly marked as "Editable" before a WRITE tool can modify them.
- **Native Surface:** `EditLock` state in the graph or sidecar.
- **Purpose:** Prevent accidental side-effects during speculative refactoring. An agent must call `gn_open_for_edit({symbol})` which runs a pre-check and returns a "Transaction Handle."

### 3. Logic-Gated Graph Mutations (Submission Criteria)
- **Capability:** Architectural "Submission Criteria" that are enforced at the transaction boundary.
- **Native Surface:** `ontoindex/src/core/refactor/submission-rules.ts`.
- **Purpose:** Block a transaction if it violates "Graph Invariants" (e.g., "Circular dependency detected," "Interface mismatch," or "Security-sensitive module edit without high-confidence audit").

### 4. Transactional Mutation Log (Audit Trail)
- **Capability:** A persistent, searchable log of every graph mutation, including the intent, the symbols involved, and the agent identity.
- **Native Surface:** KuzuDB node `MutationEvent`.
- **Purpose:** Provide visibility into the "History of the Graph" independently of the Git history.

### 5. Asynchronous Index Sync (Read-after-Write Consistency)
- **Capability:** A consistency gate that ensures the OntoIndex index is updated or invalidated immediately following a transaction commit.
- **Native Surface:** Post-commit hook in `TransactionManager`.

### 6. `SnapshotIsolatedAuditing` (Stable Reads)
- **Capability:** A core capability that allows an agent or audit process to request a read-only, point-in-time snapshot of the graph. The snapshot remains stable even if concurrent background tasks modify the primary graph.
- **Native Surface:** `ontoindex/src/core/storage/snapshot-manager.ts`.
- **Purpose:** Prevent phantom reads during deep, multi-turn systems audits.

## Decision

Implement the **Transactional Ontology Edit Contract** to move OntoIndex from "Atomic Edits" to "Validated Transactions."

### Implementation Solution: Pure Contract First

1. **`TransactionManager`**: A class that manages the `NexusEdit` lifecycle, acting as the foundation for **Agentic ACID Transactions**.
2. **`EditableSymbol`**: A wrapper type for `EnrichedSymbolRow` that carries a transaction handle.
3. **`RefactorTransactionReport`**: A structured report showing the "Planned vs Actual" state of a multi-step refactor.
4. **`gn_snapshot_begin`**: A new MCP tool allowing agents to lock their view of the graph for the duration of a complex reasoning task.

## Rejected From Core

- **User UI for configuring Actions:** This is a frontend concern.
- **Manual "Undo" UI:** This belongs in the IDE/CLI layer, although the core must support the inverse operation.
- **Batch Code-Mod Engine:** While useful, the first slice should focus on the transaction safety layer rather than the execution engine.

## Validation Gates

- `npm run build`
- Unit tests for `Atomic Rollback` using a mock filesystem.
- Benchmarking the overhead of `Submission Rules` on transactions with 10+ affected files.
- Assertion that `gn_safe_refactor` can be refactored to use the `TransactionManager` as a single-step transaction.
