# ADR: MCP scoped observations and query failures

Status: Accepted
Date: 2026-10-12
Authority: User instruction to proceed with the reviewed MCP corrections

## Decision

`gn_path_verify` returns `NEEDS-VERIFY` with bounded C/C++ syntax observations.
The existing parser selects an exact procedure and a unique matching `if`
condition. Observations come from the selected consequence; unsupported,
ambiguous, malformed, or incomplete inputs produce explicit warnings.
Syntax presence does not establish execution, so it cannot produce a definitive
path verdict. Existing inputs, report fields, aliases, and envelope selection
remain available. Inline statement fragments use the C++ subset.

Graph summary helpers propagate query and mapping failures through existing
caller error boundaries. A requested overview section failing rejects the whole
overview. Successful empty queries retain empty lists; disabled sections are
not queried. This prevents unavailable evidence from appearing as an empty graph.

Dynamic YAML strings are encoded by the installed YAML serializer at the
resource rendering boundary. Existing field shapes and Markdown bodies remain.
Manifests retain their accepted character set.

## Alternatives

- Raw brace scanners do not reliably distinguish comments, literals, and scopes.
- AST containment alone does not establish reachability or path execution.
- A control-flow interpreter exceeds this correction's bounded scope.
- Restricting manifest characters rejects valid source data.
- Per-section error variants broaden the public response contract.
- Summary-layer retries duplicate pool policy without evidence of transient faults.

## Compatibility, validation, and rollback

Consumers must handle `NEEDS-VERIFY` instead of relying on textual matches for
`PASS` or `FAIL`. Overview consumers receive failure when a requested query
fails. Successful resource and query shapes remain stable.

Regression checks cover neighboring scopes, symbols, ambiguity, unsupported
inputs, unreachable observations, aliases, envelope parity, YAML round trips,
query rejection identity, genuine empty queries, and disabled overview sections.
The tool description and stable contract snapshot reflect the observation
limits. Revert each correction with its tests and contract documentation to
roll back; preserve unrelated concurrent changes.
