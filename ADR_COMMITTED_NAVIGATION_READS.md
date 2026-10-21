# ADR: Explicit committed navigation reads

Status: Accepted for implementation
Date: 2026-10-21
Authority: User instruction to proceed with explicit committed reads and readiness reporting

## Decision

Add optional `read_mode: "committed"` to MCP explore, context inspection, symbol
impact and semantic search. Omission retains automatic workspace preparation.
Reject unsupported operations, groups and live enrichment requests in this mode.
Pin the selected committed database through existing generation lifetime owners.
Suppress manual and automatic overlays using repository-scoped asynchronous
request state; never mutate process environment to select a read mode.
Use indexed source content and graph skeletons. Exclude live LSP enrichment.
Return indexed commit, generation, mode and explicit dirty-source exclusions.
Pagination remains bound to the complete request arguments, including read mode.

## Alternatives and second review

Raising the global cap retains full-build cost. Reduced dirty-file relationship
graphs require a new invalidation engine and parity evidence. An explicit
committed view reuses the indexed graph without claiming current-source coverage.
The second review requires excluding flag-off source parsing, live LSP results,
manual overlays and shared cache entries, and rejecting unsupported group and
external enrichment paths. Unknown committed identity fails closed.

## Readiness and limits

Dirty coverage describes symbol-overlay eligibility, not graph readiness.
Workspace refusal diagnostics identify the admission file count and configured
limit and recommend explicitly selecting committed evidence when appropriate.
No automatic retries, reindex, global cap increase or incremental relationship
engine is part of this decision.

Eligible public navigation refusals include a bounded `remediation` object with
`read_mode: "committed"` and an explanation of excluded evidence. The hint
requires an explicit single repository, a supported action and no live
enrichment. Unsupported requests and already committed requests receive no hint.
The refusal retains its original code, diagnostics and retryability.

## Validation and rollback

Generated navigation examples preserve an explicit committed mode at their
existing construction owners, including explore UID examples and task packs.
Committed search hints do not offer live enrichment. Default examples retain
their current behavior; no session-wide mode or automatic execution is added.

An explicitly supplied semantic `limit` also bounds emitted definitions, up to
the existing ceiling of 20. Omission retains that ceiling. Both ordinary and
cached responses apply this bound; retrieval cache identity includes result
limits because those limits affect the candidate pool. Process and per-process
symbol limits retain their existing semantics. Structured retrieval candidates
remain a separately bounded evidence surface.

Test mode validation, default compatibility, asynchronous request isolation,
dirty rename/content exclusion and all four public MCP navigation calls against
a preparation refusal. Test cursor binding and source-enrichment exclusion.
Use focused native tests and TypeScript checking. Revert only this change's
hunks to roll back, preserving preceding diagnostic repairs.
