# ADR 0023: Serena Follow-Up Memory and Diagnostics Guardrails

Status: Implemented

## Context

ADR 0021 proposed a Serena-inspired agent interface for OntoIndex. The first implementation slices
focused on safer agent workflows, tool guidance, and bounded interface improvements. Several follow-up
areas remained useful but were intentionally not part of the first tracked backlog:

- advisory project memories;
- memory visibility in documentation/context surfaces;
- safe memory authoring and lifecycle rules;
- MCP session diagnostics in the web UI;
- later Serena v2 interface cleanup.

The original follow-up proposal is directionally useful, but it needs narrowing. OntoIndex already has
parts of the memory and diagnostics substrate. The next decision should not re-approve Serena broadly or
create new authority channels. It should harden existing primitives, integrate them selectively, and keep
ADR 0018 trust boundaries intact.

Related decisions:

- ADR 0018: MCP Audit Trust Contract and Customer Readiness Gates
- ADR 0021: Serena-inspired agent interface for OntoIndex
- ADR 0022: QMD-inspired structured retrieval and organic recommendations

Existing OntoIndex anchors:

```text
ontoindex/src/mcp/memory-parser.ts:1
ontoindex/src/mcp/resources.ts:128
ontoindex/src/mcp/resources.ts:855
ontoindex/src/mcp/super/docs.ts
ontoindex/src/mcp/local/tool-params.ts:406
ontoindex/src/mcp/shared/response-envelope.ts
ontoindex/src/mcp/shared/target-context.ts
ontoindex/src/server/api.ts:1075
ontoindex/src/server/mcp-http.ts:19
ontoindex/src/server/mcp-http.ts:90
ontoindex/test/unit/resources.test.ts:607
ontoindex/test/unit/mcp-http-diagnostics.test.ts:1
ontoindex-web/src/
docs/adr/0018-mcp-audit-trust-contract.md
docs/adr/0021-serena-inspired-agent-interface.md
```

Evidence note:

- The local OntoIndex index used during review was stale: indexed `83a0773`, current `9665894`.
  OntoIndex query output was used only for navigation; direct source reads above are the decision
  evidence.

## Challenge Review

The unsafe version of this proposal would treat memories as a soft evidence channel, add a write-capable
MCP surface before validation exists, or expose session diagnostics as an unbounded telemetry product.
Those outcomes conflict with OntoIndex' audit model.

## Implementation Status

Implemented. Advisory memory parsing and resources enforce `not_audit_evidence: true`, path
normalization, freshness validation, and bounded resource output. `gn_docs` supports explicit
`includeMemories` for advisory context/readiness only, and the HTTP server exposes authenticated,
redacted MCP diagnostics.

The current codebase also changes the shape of the work:

1. **Memory parsing already exists.** `memory-parser.ts` parses `.ontoindex/memories/*.md` and requires
   ADR 0021 front matter fields, including `not_audit_evidence`.
2. **Memory resources already exist.** `resources.ts` exposes `ontoindex://repo/{name}/memories`,
   `ontoindex://repo/{name}/memory/{memoryName}`, and `ontoindex://repo/{name}/onboarding`.
3. **The advisory boundary already appears in resource output.** `resources.ts` emits a boundary that
   says memories are advisory only and must not drive audit status decisions.
4. **MCP diagnostics already exist below the UI.** `mcp-http.ts` tracks active sessions, creation time,
   last activity, bounded request/error counters, total sessions created, and eviction counters.
5. **Recent tool history is not equivalent to existing diagnostics.** Adding "recent tools" requires
   retaining tool-call metadata and therefore needs explicit retention and privacy rules.
6. **`gn_docs` is a mixed-authority surface.** Some actions provide context, while other actions support
   trace, drift, or readiness claims. Memory must not be allowed to leak from advisory context into
   evidence-bearing outputs.
7. **`gn_docs` has no memory parameter today.** `DocsMcpParams` and `DocsMcpSchema` currently expose
   `trace`, `drift`, `context`, and `readiness` controls, but no `includeMemories` option. The schema,
   facade definitions, dispatch typing, and tests must be changed together.
8. **The HTTP server currently discards diagnostics exposure.** `mountMCPEndpoints` returns
   `getDiagnostics`, but `server/api.ts` keeps only `cleanup`. A web/API slice must first retain that
   handle and expose a local authenticated read-only route.
9. **The single-memory resource is the sharpest current edge.** List loading reads directory entries, but
   `ontoindex://repo/{name}/memory/{memoryName}` builds a path from user-controlled `memoryName`. The
   first hardening slice must normalize and reject path traversal before expanding consumers.
10. **"Local-only" is not a sufficient diagnostics boundary.** `createServer` defaults to `127.0.0.1`,
    but host binding is configurable; CORS permits loopback/development origins and the deployed web
    client; and non-browser requests have no origin. Diagnostics safety must rely on the existing bearer
    authorization path, redaction, and minimization, not on an assumed network boundary.
11. **Session IDs should be treated as sensitive operational identifiers.** Existing diagnostics expose
    `sessionId`. A web/API surface should prefer stable redacted IDs or short hashes unless a debug flag
    explicitly requests full IDs.
12. **Some tests already exist.** Resource behavior and MCP diagnostics have unit coverage. The gap is
    not "add any tests"; it is to add the missing negative boundary tests for traversal, false
    `not_audit_evidence`, empty sources, oversized files, `gn_docs` evidence exclusion, and API retention.

Therefore the follow-up should be reframed from "add memories and diagnostics" to "harden and selectively
surface existing memory and diagnostic primitives."

## Decision

OntoIndex will implement the Serena follow-up work as four gated bundles:

1. **Memory validation and resource hardening.**
2. **Explicit read-only memory integration into selected documentation/context surfaces.**
3. **Minimal diagnostics API and web UI exposure using bounded existing counters.**
4. **CLI-first memory authoring, only after validation hardening lands.**

The decision does not approve:

- memory-derived audit evidence;
- automatic memory generation from chats, audits, reviews, or refactors;
- memory-driven audit/session status transitions;
- write-capable MCP memory APIs in the first authoring slice;
- unbounded diagnostic retention;
- hosted telemetry or remote analytics;
- dynamic MCP discovery changes as part of this follow-up.

## Algorithm/Technique

### 1. Memory validation and resource hardening

Use the existing memory parser and resource templates as the foundation:

```text
ontoindex/src/mcp/memory-parser.ts
ontoindex/src/mcp/resources.ts
```

Strengthen the parser before adding more consumers:

1. Accept only Markdown files directly under `.ontoindex/memories/`.
2. Introduce one shared memory-name normalization helper and use it from list, single-memory, onboarding,
   and future authoring code.
3. Reject path traversal, nested paths, absolute paths, URL-like names, hidden control names, and
   non-`.md` memory names.
4. Resolve candidate paths and verify they remain inside `.ontoindex/memories/` before reading.
5. Add a bounded max file size.
6. Keep the ADR 0021 required fields:
   - `version`
   - `repo`
   - `created_at`
   - `source_commit`
   - `indexed_commit`
   - `freshness`
   - `kind`
   - `not_audit_evidence`
   - `sources`
7. Treat `not_audit_evidence: true` as a hard validation requirement, not just a present field.
8. Require non-empty `sources`.
9. Use an explicit freshness vocabulary instead of accepting arbitrary text. At minimum preserve ADR
   0021's `stale-index` value and align with existing OntoIndex `freshness: fresh` / stale-index wording;
   if legacy tests use `current`, either migrate them or map `current` to the canonical value in one
   place.
10. Report invalid memories as invalid advisory artifacts without throwing away the whole resource list.
11. Never let invalid memories become evidence, readiness, audit, or gate inputs.

The resource output must continue to include a visible advisory boundary. Every memory-derived structured
field should carry:

```text
source: memory
file: <memory file name>
freshness: <front matter freshness>
source_commit: <front matter source_commit>
indexed_commit: <front matter indexed_commit>
not_audit_evidence: true
```

### 2. Read-only `gn_docs` integration

Integrate memories only into selected `gn_docs` actions and only as advisory context.

Allowed:

- `gn_docs` context-style output may include memories when explicitly requested.
- `gn_docs` readiness-style output may mention memory availability, validity, and freshness as advisory
  metadata.

Disallowed:

- `gn_docs trace` must not use memories as trace evidence.
- `gn_docs drift` must not use memories as drift evidence.
- audit verification, finding verification, replay gates, and recommendation authority must not consume
  memory content as evidence.

Preferred interface:

```text
gn_docs({ action: "context", includeMemories: true })
```

Implementing this requires changes in both public schema and runtime types:

```text
ontoindex/src/mcp/local/tool-params.ts
ontoindex/src/mcp/super/docs.ts
ontoindex/src/mcp/super/tool-definitions.ts
ontoindex/test/unit/mcp-docs-facades.test.ts
```

Default behavior should stay conservative. If `includeMemories` is omitted, existing `gn_docs` behavior
must remain unchanged unless the specific action already describes advisory memory availability.

Memory sections in `gn_docs` responses must be visually and structurally separated from graph/docs
evidence. The response envelope should preserve target context, freshness, warnings, and degraded-output
fields from ADR 0018 instead of inventing a memory-specific response shape.

For trace and drift, add explicit regression tests proving that memories cannot change:

- `primaryGraphFacts`;
- `docsEvidence`;
- trace implementation/test evidence;
- drift route matches;
- readiness pass/fail status.

### 3. Minimal diagnostics API and web UI exposure

Start from the existing `mountMCPEndpoints` diagnostics handle:

```text
ontoindex/src/server/mcp-http.ts
ontoindex/src/server/api.ts
```

V1 diagnostics may expose:

- active MCP session count;
- per-session age;
- per-session last activity;
- bounded request count;
- bounded error count;
- total sessions created;
- total idle evictions;
- total cap evictions;
- captured timestamp;
- index freshness/degraded indicators if already available from existing backend status surfaces.

The first server step is not UI work. It is to keep the returned handle:

```text
const { cleanup: cleanupMcp, getDiagnostics } = mountMCPEndpoints(app, backend);
```

Then expose a local authenticated route such as:

```text
GET /api/mcp/diagnostics
```

The diagnostics route should use the existing API bearer-token protection and should not be public or
static. It must be safe when no MCP sessions exist. It must not rely on the server being bound to
loopback; host binding is operational configuration outside this ADR.

The API response should redact session identifiers by default:

```text
sessionIdHash: <stable short hash>
```

Expose full session IDs only behind an explicit local debug option, and never render full IDs in the
default web UI.

V1 diagnostics must not expose:

- prompts;
- tool arguments;
- raw request bodies;
- client secrets;
- unbounded tool-call history;
- hosted analytics;
- remote telemetry.

"Recent tools" is postponed unless a later ADR defines a bounded ring buffer, retention policy, and
redaction rules. If added later, it should record only tool names and timestamps, not arguments or
responses.

The web UI should be read-only and operational. It should not duplicate authority from audit tools. It
should show diagnostic state as runtime observability, not proof that a repository is safe or ready.

### 4. CLI-first memory authoring

Memory authoring should come after validation and read-only integration.

The first authoring surface should be a bounded local CLI helper or internal command that creates a
validated skeleton file under `.ontoindex/memories/`.

Rules:

1. No MCP write API in the first authoring slice.
2. No automatic synthesis from chat, audit reports, review outputs, or refactors.
3. No implicit updates during rename/refactor flows.
4. The helper must generate required front matter, including `not_audit_evidence: true`.
5. The helper must refuse unsafe names and refuse to overwrite an existing memory without an explicit
   local CLI flag.
6. The helper must run the same validation used by resource loading.

Example skeleton:

```yaml
---
version: 1
repo: OntoIndex
created_at: 2026-05-20
source_commit: <current commit>
indexed_commit: <current indexed commit or unknown>
freshness: <fresh|stale-index|unknown>
kind: advisory
not_audit_evidence: true
sources:
  - <source path or ADR>
---
```

## Recommended Sequence

1. **Memory validation hardening.**
   - Strengthen parser validation.
   - Add path/name/size tests.
   - Add tests proving `not_audit_evidence: true`, not just field presence, is required.
   - Add tests proving empty `sources` is invalid.
   - Normalize or reject non-canonical freshness values in one helper.

2. **Resource behavior tests.**
   - Verify list, single-memory, missing-memory, invalid-memory, and onboarding outputs.
   - Verify invalid memories remain visible as invalid advisory artifacts.

3. **`gn_docs` read-only integration.**
   - Add explicit `includeMemories` support only for context-style output.
   - Ensure trace/drift/audit outputs exclude memory evidence.
   - Preserve ADR 0018 envelope semantics.

4. **Diagnostics API and web UI.**
   - Retain the `getDiagnostics` handle returned by `mountMCPEndpoints`.
   - Expose existing bounded diagnostics through a local authenticated read-only API.
   - Add a restrained web panel for session count, age, last activity, bounded counters, and degraded
     indicators.
   - Do not add recent tool history in v1.

5. **CLI memory authoring skeleton.**
   - Add a local helper after validation hardening.
   - Keep write operations out of MCP until separately approved.

6. **Serena v2 interface cleanup.**
   - Revisit mode labels, help wording, and diagnostics placement after the read-only slices are stable.

## Acceptance Guardrails

The implementation is acceptable only if all of the following remain true:

- Memories are advisory only.
- Every memory-derived output includes provenance, freshness, source filename, and
  `not_audit_evidence: true`.
- Missing or invalid memory fields never fail unrelated docs/resource requests.
- Invalid memories are visible as invalid advisory artifacts, not silently promoted or silently trusted.
- Single-memory reads cannot escape `.ontoindex/memories/`.
- Memory validation rejects false/string-false `not_audit_evidence`, empty `sources`, path traversal,
  absolute paths, and oversized files.
- Memory validation uses one documented freshness vocabulary and does not accept arbitrary freshness text.
- Audit/session/finding/replay status cannot be changed by memory content.
- `gn_docs trace` and `gn_docs drift` do not treat memory content as evidence.
- `gn_docs context` memory inclusion is explicit or clearly marked advisory.
- The diagnostics API is authenticated under the existing server auth model and is not listed as a public
  API route.
- Diagnostics do not store or expose prompts, tool arguments, request bodies, secrets, session payloads, or
  unbounded histories.
- Diagnostics redact full MCP session IDs by default.
- Diagnostics UI is read-only and must not imply audit readiness or repository safety.
- MCP discovery remains stable unless a later compatibility ADR approves a change.
- Tests cover parser validation, resource output, docs integration boundaries, and diagnostics retention
  limits.

## Consequences

Positive:

- OntoIndex gets the onboarding benefit of Serena-style memories without weakening audit authority.
- Existing memory resources become safer and more useful instead of adding a competing memory product.
- Operators get visibility into MCP session health through the web UI using already bounded counters.
- The implementation sequence favors read-only slices before write paths.

Negative:

- Memory authoring is delayed until validation and trust-boundary tests exist.
- Recent tool-call diagnostics are postponed even though they may be useful for debugging.
- `gn_docs` gains another optional context source, which requires disciplined response-envelope handling.
- Parser hardening may reject memory files that a loose initial implementation would have accepted.

## Validation

Initial implementation should include focused tests rather than a broad release gate:

```text
cd ontoindex && npm test -- resources.test.ts
cd ontoindex && npm test -- mcp-http-diagnostics.test.ts
cd ontoindex && npm test -- mcp-docs-facades.test.ts
```

Add or extend focused tests for:

- memory-name normalization and path traversal rejection;
- strict `not_audit_evidence: true` validation;
- non-empty `sources` validation;
- freshness vocabulary validation;
- oversized memory rejection;
- `gn_docs({ action: "context", includeMemories: true })` advisory-only output;
- `gn_docs` trace/drift exclusion of memory evidence;
- authenticated `/api/mcp/diagnostics` behavior;
- diagnostics redaction of full session IDs;
- web diagnostics rendering without tool arguments or payload data.

Before release, run the normal package checks:

```text
cd ontoindex && npm test
cd ontoindex && npx tsc --noEmit
cd ontoindex-web && npm test
cd ontoindex-web && npx tsc -b --noEmit
```

If baseline failures exist, apply the repository baseline-subtraction rule and report pre-existing
failures separately from new regressions.
