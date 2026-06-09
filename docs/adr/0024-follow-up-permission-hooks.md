# ADR 0024 Follow-up: Deferred Permission and Hook Design

Status: Proposed / Deferred

## Context

During the implementation of ADR 0024 (Evidence Read Ledger), several Crush-inspired policy ideas were identified but deferred to ensure a narrow and stable v1 release. This document tracks those ideas for future consideration.

## Proposed Extensions

### 1. Session-Scoped Permission Decisions

- Implement a mechanism for agents to request permission for specific "write" or "high-impact" actions.
- Permissions should be session-scoped and visible in the diagnostics ledger.

### 2. Candidate Write Surfaces

The following surfaces are candidates for permission-gated access:
- **Memory Authoring**: Creating or updating advisory memories.
- **Safe Refactors**: Performing `gn_safe_refactor` operations.
- **Write-Through Verification**: Direct edits to production code.
- **Release Prep**: Any action that modifies repository-level release metadata.

### 3. Typed Pre-Action Hooks

- Defer implementation of typed hooks (e.g., `before_edit`, `before_refactor`) until a robust permission decision model exists.
- These hooks would allow for custom validation or security checks before an action is executed.

### 4. Shell Hooks

- Shell hooks should remains out of default behavior to maintain security boundaries.
- If implemented, they should be strictly opt-in and restricted to verified environments.

## Decisions

- **V1 Scope**: Keep v1 focused strictly on read accountability and diagnostics.
- **Follow-up**: Re-evaluate these extensions once the core ledger has sufficient production telemetry.
