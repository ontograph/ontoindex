# ADR 0025: Codex-Inspired Tool Contract Registry and Schema Drift Gates

Status: Implemented

## Context

The Codex architecture review highlighted that OntoIndex lacks a single, declarative
source of truth for tool contracts.
Currently, tool counts, capabilities (like structured output), and agent-mode visibility
are scattered across `help.ts`, `tool-contract.ts`, and the CLI. This leads to silent
drift where help advertisements disagree with actual implementation frontiers.

Codex treats tool contracts as first-class objects with versioned snapshots and automated
drift detection. OntoIndex needs a similar substrate to ensure that as the MCP surface
grows, it remains consistent, safe, and easily discoverable for both humans and agents.

## Decision

Implement a **Unified Tool Contract Registry** in `ontoindex/src/mcp/shared/tool-registry.ts`.
This registry will serve as the single authority for:
1. Public MCP tool definitions (super-functions and facades).
2. Contract stability status (stable/experimental/deprecated).
3. Agent-mode discoverability (general/audit/refactor/query-projects).
4. Capability support (e.g., `structuredOutput`, `dispatchCategory`).
5. Implementation parity (ensuring registered definitions match callable handlers).

The registry will be consumed by `gn_help`, `gn_tool_contract`, and the CLI to provide
a unified view of the system.

## Algorithm/Technique

### Phase 1: Registry Normalization

The first phase involves creating the core data structures and migrating metadata.

1.  **Unified Metadata Shape**:
    Define a robust interface for tool metadata that captures all aspects of a tool's contract.
    ```typescript
    export interface ToolContractMetadata {
      name: string;
      kind: 'super' | 'facade';
      modes: readonly AgentMode[];
      category: 'discovery' | 'docs' | 'safety' | 'refactor' | 'lifecycle' | 'audit' | 'systems-audit' | 'pr-review' | 'self-help';
      intent: string;
      whenToUse: string;
      contractStatus: 'stable' | 'experimental';
      visibility: 'public' | 'internal';
      structuredOutput: boolean;
      owner?: string;
      defaultBehavior?: string;
      replacement?: string;
      fallback?: string;
      properties?: PropertyMetadata[];
      actions?: ActionMetadata[];
    }
    ```
2.  **Declarative List**:
    Implement `TOOL_METADATA_LIST` in `tool-registry.ts`. This list becomes the single source
    of truth, replacing hardcoded lists in other modules.
3.  **Registry Construction**:
    Implement `getPublicToolRegistry()` which merges the metadata with actual `ToolDefinition`
    objects, ensuring that every public tool has a corresponding metadata entry.

### Phase 2: Consumer Consolidation

Consolidate all public-facing tool information to derive from the registry.

1.  **`gn_help` Refactoring**:
    Update `gnHelp()` to map over the registry. This ensures that the help report is
    always in sync with the implementation.
2.  **`gn_tool_contract` Refactoring**:
    The contract tool now uses the registry as the baseline for drift detection. It compares:
    - Advertised tools (`gn_help`) vs Registry.
    - Registered definitions (`ONTOINDEX_SUPER_TOOLS`) vs Registry.
    - Actual callable tools in the MCP server vs Registry.
3.  **CLI Discovery**:
    Update `cli/mcp.ts` to use `getPublicToolDefinitions().length` for startup messages,
    ensuring accurate counts.

### Phase 3: Schema Snapshots

To prevent accidental regressions in the public API, implement deterministic snapshots.

1.  **Serialization**:
    Implement `serializeToolContract()` in `tool-contract-schema.ts` to produce a
    minified JSON representation of the stable tool surface.
2.  **Snapshot Test**:
    Create `test/unit/tool-contract-schema.test.ts` which compares the current registry
    output against `test/fixtures/mcp-tool-contract/stable-tools.snapshot.json`.
    Developers must intentionally update the snapshot when changing a stable contract.

### Phase 4: Release Policies

Implement automated quality gates for tool promotion.

1.  **Typed Rules**:
    Create `release-policy.ts` with rules such as `STRUCTURED_OUTPUT_RULE` (enforces that
    stable tools must return machine-readable output).
2.  **Validation**:
    The `gn_tool_contract` structural checks now include policy validation, flagging
    tools that do not meet the release criteria.

### Phase 5: Compatibility Inventory

Improve transparency for ecosystem partners and legacy migrations.

1.  **Deprecation Tracking**:
    Support `replacement` and `fallback` hints in metadata.
2.  **Property-Level Metadata**:
    Track experimental or deprecated input properties (e.g., the `limit` alias in `docs`).
3.  **Ownership**:
    Identify the "owner" of a tool or property to clarify who is responsible for its
    stability or removal.

## Review: Planned vs Done

Reviewed with OntoIndex on 2026-05-22.

OntoIndex evidence:

- `gn_diagnose({repo: "OntoIndex", checkToolContract: true})` reported `status: "degraded"` because the index is stale against `cbd3eb9306130496d571dda2faf61cb2bd6caeb2` and embeddings are unavailable.
- `gn_tool_contract({includeFacades: true})` reported `status: "ok"` with 51 super-tools, 8 facades, no missing advertised tools, and no extra callable tools.
- Direct source review found `ToolContractSchema` and `serializeToolContract`, but semantic quality is limited while embeddings are unavailable.
- Direct source review found `ContractStatus = 'stable' | 'experimental' | 'deprecated'`, so the previous `deprecated` type mismatch is resolved in the current worktree.
- `cd ontoindex && npx tsc --noEmit --pretty false` passed after the `deprecated` status model was aligned.
- `UPDATE_SNAPSHOTS=1 npx vitest run test/unit/tool-contract-schema.test.ts` regenerated the accepted stable contract snapshot.
- `npx vitest run test/unit/tool-contract-schema.test.ts test/unit/release-policy-rules.test.ts test/unit/super/tool-contract-policies.test.ts test/unit/super/tool-contract.test.ts` passed: 4 files, 12 tests.

Review findings:

1. **Contract surface is done:** MCP frontier parity is working; `gn_tool_contract` reports no missing or extra public tools.
2. **Snapshot coverage is expanded:** `serializeToolContract()` now serializes modes, category, intent, ownership, compatibility hints, properties, and actions.
3. **Policy surfacing is verified:** `tool-contract-policies.test.ts` proves `gnToolContract()` exposes release-policy checks in `structuralChecks`.
4. **Snapshot gate is clean:** The expanded serialized schema was accepted and the checked-in stable snapshot was regenerated intentionally.

| Planned item | Done state | Evidence | Challenge |
| --- | --- | --- | --- |
| Unified metadata shape | Done | `ToolContractMetadata` and `PublicToolRegistryEntry` exist in `ontoindex/src/mcp/shared/tool-registry.ts`. | Keep contract-status values aligned across registry, schema, policies, and tests. |
| Declarative registry list | Done | `TOOL_METADATA_LIST` is the public metadata list in `tool-registry.ts`. | The list is large and central; future metadata expansion should avoid making this file the only review surface for every policy dimension. |
| Registry construction | Done | `getPublicToolRegistry()` merges super/facade definitions with metadata and supports mode filtering. | Missing metadata currently makes entries disappear from the public registry rather than fail at declaration time; tests and contract checks are therefore important. |
| `gn_help` consumes registry | Done | `gnHelp()` maps `getPublicToolRegistry({includeFacades: false})` to `superFunctions`. | `gn_help` is still super-function focused; facade discovery remains indirect through contracts and direct MCP surfaces. |
| `gn_tool_contract` drift checks | Done | `gnToolContract()` compares help advertisements, registry entries, callable tools, facade actions, mode frontiers, structural checks, and release policies. | MCP output observed from `gn_tool_contract` emphasizes the high-level frontier; deeper structural fields need to stay visible and tested across legacy/envelope shapes. |
| CLI startup count from registry | Done | `ontoindex/src/cli/mcp.ts` prints `getPublicToolDefinitions().length` for public MCP tools. | This covers startup count drift but not CLI help text for every tool. |
| Stable schema serialization | Done | `serializeToolContract()` emits name, kind, description, input schema, contract status, structured-output flag, modes, category, intent, whenToUse, owner, replacement, fallback, properties, and actions. | Keep future changes snapshot-gated. |
| Snapshot fixture and test | Done | `tool-contract-schema.test.ts` compares serialized output to `ontoindex/fixtures/mcp-tool-contract/stable-tools.snapshot.json`. | Snapshot drift is intentional-gate behavior; regenerate with `UPDATE_SNAPSHOTS=1` only after accepting a contract shape change. |
| Release-policy rules | Done | `release-policy.ts` defines `STRUCTURED_OUTPUT_RULE` and `EXPERIMENTAL_ISOLATION_RULE`; `gnToolContract()` evaluates `RELEASE_POLICIES`. | Rules are intentionally narrow. They catch obvious promotion mistakes, not all public contract compatibility risks. |
| Release-policy tests | Done | `release-policy-rules.test.ts` covers pass/fail cases for rules; `tool-contract-policies.test.ts` proves policy checks are present in `gnToolContract()`. | Keep `gn_safe_refactor` on the allowlist for structured-output policy checks. |
| Compatibility inventory | Done, partial | `gnToolContract()` emits `compatibilityInventory` from replacement, fallback, experimental tool, property, and action metadata. | Inventory currently models compatibility hints, not lifecycle enforcement. Planned removal semantics remain future work. |

Verdict: ADR 0025 is implemented for the core public tool registry and MCP drift-gate workflow. The `deprecated` status model, expanded snapshot schema, release-policy surfacing, and stable snapshot fixture are aligned.

Follow-up recommendations:

1. Keep `ContractStatus`, `ToolContractSchema`, and release-policy rules aligned as the MCP surface evolves.
2. Regenerate `ontoindex/fixtures/mcp-tool-contract/stable-tools.snapshot.json` only through `UPDATE_SNAPSHOTS=1` after accepting future contract shape changes.
3. Preserve the release-policy regression coverage when adding new structured-output or lifecycle rules.


## Consequences

-   **Pros**:
    - Silent drift is eliminated.
    - Release readiness is objectively measured.
    - Discovery is unified and accurate.
    - Breaking changes are caught early by snapshot tests.
-   **Cons**:
    - Adding a new tool requires a registry update (prevents accidental exposure).
    - Slightly higher complexity in `tool-registry.ts`.

## Deferred Work

-   **Runtime Event Streams**: Subscription-based diagnostics for long-running jobs.
-   **Initialization Handshakes**: Formal capability negotiation for clients.
-   **Shared DTO Package**: Standing up a protocol-only package for cross-workspace use.
-   **Advisory Memory Automation**: Automated leases and watermarks for memory staleness.
-   **Permission Profiles**: Implementing enforcement semantics for session-scoped permissions.
