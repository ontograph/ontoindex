# ADR: Graph-walk integer limits

Status: Accepted
Date: 2026-10-12
Authority: User instruction to proceed with the reviewed MCP repairs

## Decision

The public `gn_graph_walk` schema declares `maxSteps`, `maxFrontier` and
`maxExpansionPerStep` as JSON Schema integers. These fields count discrete
steps, nodes and expansions. The handler already rejects fractional values.
The shared dispatcher enforces the advertised integer type before graph work.

Valid integer calls, defaults, positivity checks and hard-cap behavior remain
compatible. Fractional calls fail at dispatch with its existing argument-error
shape, rather than the handler's `INVALID_PARAMS` envelope.

## Alternatives

- `number` plus `multipleOf: 1` needs additional validator support.
- Rounding fractions changes the existing invalid-input behavior.
- Runtime-only rejection leaves the public schema inconsistent.

## Validation and rollback

Compatibility tests cover all three field types, integer calls, fractional
dispatch rejection, bounds and serialized schema. Review the public contract
fixture if it includes this tool. Rollback reverts the field types and their
assertions together.
