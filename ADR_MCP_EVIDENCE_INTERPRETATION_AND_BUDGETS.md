# ADR: MCP evidence interpretation and response budgets

Status: Accepted
Date: 2026-10-19
Authority: User instruction to proceed with the reviewed integration report

## Decision

Extend existing evidence, audit, diagnostics and response owners. Classify
original MCP results before preview truncation. Supported structured responses
must establish execution, target identity and usable graph coverage separately.
Partial, advisory and legacy responses retain availability evidence. Unknown
formats cannot establish graph authority. Keep existing protocol evidence enums.

Audit evaluation metadata distinguishes skipped, incomplete and completed
evaluation, scope, evaluated-path counts and graph validation. Empty scope keeps
READY and its skipped checklist with graphValidated false. Reuse existing scoped
workspace summaries while preserving global freshness. Returned file membership
alone cannot establish dependency coverage.

Diagnostics trust successful backend repository resolution. Startup directory
differences alone cannot invalidate it. Backend repository filters still enforce
selection. Thread-scoped MCP status uses active connections and handshake
metadata without creating or cancelling another manager. Threadless status
continues loading current configuration. Config changes after thread startup
affect threadless status until the existing manager refreshes normally.

Add optional response_budget_bytes to existing MCP object schemas, limiting the
complete successful logical response in serialized MCP text-result bytes.
Omission preserves behavior. Keep the 48 KiB transport page cap, family limits
and immutable continuation. Omit recognized detail conservatively with explicit
metadata, preserving identity, warnings, errors, freshness and ambiguity. If
required diagnostics cannot fit, use the existing bounded error path. Errors
remain subject to the transport cap because tiny budgets cannot contain a valid
error. Never silently raise a successful logical budget. Store only the selected
projection and bind budget through existing request identity. Suppress optional
next-step hints on budgeted calls.

## Alternatives and second review

Configuration guidance cannot enforce evidence validity. A separate integration
service duplicates existing ownership. Extend current contracts with additive
metadata and conservative evidence levels instead of changing verdict enums.
Per-family budget plumbing duplicates policy. Existing page size cannot limit
the whole answer. Recursive truncation can erase warnings and ambiguity, so
preserve required metadata or fail explicitly. Preserve useful partial evidence.

## Validation and rollback

Cover fresh, stale, partial, advisory, ambiguous, malformed, unknown-version,
wrong-target and paginated evidence; empty degraded audits; relevant, unrelated
and untracked source; selected-repository diagnostics; active connection reuse;
omitted-option compatibility; Unicode byte accounting; diagnostic overflow; and
continuation identity. Use focused native checks. Roll back bounded changes with
their tests while preserving concurrent work and existing evidence. No release
or index refresh is authorized by this change.
