# ADR: MCP service review repairs

Status: Accepted
Date: 2026-10-13
Authority: User approval ("proceed") of the consolidated plan from the 2026-10-13 service review

## Decision

**Diagnostics secrets.** `gn_diagnose` and `mcp-doctor --json` keep report `version: 1` and every
`ONTOINDEX_*` key. Values whose key name contains TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL, COOKIE,
BEARER, PRIVATE, AUTH, or API_KEY (case-insensitive, `_` and `-` separators) are replaced with
`[REDACTED]` at the report boundary using the shared `sanitizeTarget` marker. Setup detection keeps
reading the raw map internally. A key-name rule is the accepted hotfix; an allowlist projection is a
future compatibility change.

**Pool.** A timed-out connection is replaced after its native close succeeds, with or without queued
waiters; retiring slots count as occupied so callers queue and never see an integrity error; a failed
close never produces a replacement. A failed lazy database open is surfaced before the pool is
published, is never classified as an optional-extension failure, and leaves the pool fenced instead of
claiming a retry the driver cannot support. Pool admission is serialized, awaits eviction, and refuses
admission (retryable error) when every entry is busy.

**Reader pins.** Dead-PID `.reader-*` markers are removed from every managed generation including the
retained ones. Live, EPERM, malformed, symlink and non-file markers are kept; no age rule applies.

**Setup and doctor.** TOML section detection accepts trailing comments and treats a commented header as
a boundary; ambiguous structure is refused instead of rewritten. Doctor flags stale bindings only from
parsed JSON binding positions, not from arbitrary slash-prefixed text, and never falls back to a raw
scan when JSON is malformed.

**Repository identity.** One shared registry resolver owns selector-to-entry matching; the server's
trusted selected repository is forwarded through dispatch context where it already exists. `gn_ensure_fresh`
reads the registry through the shared accessor and honors `ONTOINDEX_HOME`.

**Invocation errors.** A handler marks a failed invocation with a reserved typed marker; the server maps
only that marker to MCP `isError: true`. Result payload text is unchanged. Domain findings with
`status: 'error'` or `ok: false` are not reclassified.

**Schema.** Session tools advertise `anyOf` over `session` and `sessionId`; the validator checks array
`items`, `minItems`, `maxItems` for declared schemas. The stable-tools snapshot changes intentionally.

**Clone.** `git clone` of a hostname resolves all addresses, rejects non-public answers, and pins the
vetted address for the request and its redirects while preserving host name and TLS server name.

**Bookkeeping and startup.** Per-repo maps are pruned on registry refresh and cleared on disposal after
drain, never deleting a lock tail with newer queued work. `ONTOINDEX_MCP_STARTUP_TRACE` also logs
`server.connect` start and failure.

## Alternatives and challenge

Each item compared three distinct fixes; rejected options were fixed-key-only masking, value-pattern
detection, TOML parse-and-rewrite (drops comments, adds a dependency), raw-text allowlists, fuzzy or
status-based error detection, lookup-only DNS validation (rebinding gap), unconditional startup
banners, and descriptor-limit hardening without evidence. A second review requires: close failures
never create replacements, explicit close or a new generation wins races, secrets stay raw internally,
and every behavior change below has a test.

## Compatibility

Changed client-visible behavior: redacted env values; `isError` on marked invocation errors; session
schema `anyOf`; refused clone of hostnames resolving to non-public addresses; pool admission can return a
retryable busy error. Report shape, tool names, and the 62 public tool count are unchanged.

## Validation and rollback

Focused regression tests precede each change, including one that runs the real driver lazy-open path
with only the native binding stubbed. Type checking and bounded OntoIndex verification complete the gate.
Revert the branch commit to roll back; removed dead reader markers belonged to dead processes.
