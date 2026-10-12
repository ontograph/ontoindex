# ADR: MCP argument alias validation

Status: Accepted
Date: 2026-10-12
Authority: User instruction to proceed with schema-consistent alias repair

## Decision

The schemas for `gn_taint_trace` and `gn_simulate_fault` express their existing
argument aliases using standard JSON Schema required-field alternatives.
The shared argument validator enforces those alternatives and continues to
validate the types of every supplied property. It does not mutate inputs.

Canonical calls remain accepted. Alias-only and mixed calls become accepted
when each required argument family is present. When both names are supplied,
the existing handler precedence remains unchanged. Invalid supplied values
remain errors even when the other name is valid.

The implementation supports only the required-field composition needed by
these definitions; it does not introduce a general schema engine or dependency.

## Alternatives

- A runtime-only exception leaves advertised schemas inconsistent with calls.
- Removing aliases breaks the existing advertised compatibility contract.
- A general JSON Schema validator adds unnecessary scope and dependencies.

## Validation and rollback

Compatibility tests cover canonical, alias-only, mixed, missing, conflicting,
and incorrectly typed arguments, plus serialized schema alternatives.
The stable contract fixture changes only for the two affected tool schemas.
Rollback reverts the schema and validator changes together.
