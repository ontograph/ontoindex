# ADR 0017: Audit Lifecycle Layer

Status: Implemented

## Context

OntoIndex can already help auditors navigate code, symbols, processes, and impact paths. The missing layer is audit lifecycle governance. Recent audit cycles showed a repeated failure mode: old findings were re-emitted as still open because the workflow did not force a target HEAD lock, evidence refresh, fix-commit lookup, duplicate detection, status transition rules, or verification timestamp.

Freeform Markdown audit reports are not enough. They are useful for human review, but they do not reliably encode whether a finding was checked against the current source, whether the line number drifted, whether a later commit fixed the issue, whether the claim duplicated a prior root cause, or whether a runtime-only finding has enough evidence to be marked open.

ADR 0016 covers systems-audit evidence extraction: resource lifecycles, boundary tracing, rule engines, and other analyzers. This ADR covers the lifecycle of findings that consume those facts and convert them into verified audit status, deduped root causes, implementation bundles, dispatch prompts, and advisory CI gates.

ADR 0018 defines the customer-facing trust contract for MCP/frontier tools: shared target context, single tool registry, hard freshness gates, capability-aware responses, impact-count consistency, manager-level session APIs, and CI export readiness. This ADR owns finding lifecycle semantics; ADR 0018 owns how those semantics are enforced across the public tool surface.

## Challenge Review

This proposal solves the right failure mode, but the unsafe version would create a false sense of audit certainty. The hard constraints are:

1. **Ingested reports are untrusted input.** Markdown, pasted text, and prior audit IDs can seed candidate findings, but they cannot establish status. `gn_audit_ingest` must default to `NEEDS-VERIFY`.
2. **Verification capability is finite.** A claim kind is not machine-checkable just because it is written in YAML. Every claim kind needs a registered verifier, supported languages, supported evidence modes, and unsupported-case behavior.
3. **Status is a projection, not the source of truth.** Current status should be derived from an append-only event log of ingest, verify, transition, tombstone, and bundle events. Rewriting a finding row destroys the audit trail.
4. **Target HEAD locking must include provenance.** The store needs the resolved commit, dirty-worktree state, source report hash, verifier version, graph index id, and sidecar freshness. Otherwise two reports can claim the same target while using different evidence.
5. **Negative evidence can be stale too.** A `RESOLVED-ALREADY` classification must become `NEEDS-REVERIFY` if the symbol or relevant invariant changed after verification.
6. **Root-cause dedupe must be reversible.** Merging findings into a root cause is a reviewer aid, not deletion. Original findings, source text, and contrary evidence must remain addressable.
7. **Dispatch is high risk.** Worker prompts must not be generated from unverified or runtime-only claims by default, and prompt generation must include the bundle's verification timestamp and stale-state warning.
8. **Audit data may be sensitive.** Finding stores can contain exploit details, private repo paths, and incident context. Export, MCP output, and prompt generation need redaction controls.

## Decision

Introduce an Audit Lifecycle layer on top of the existing symbol/process graph and optional systems-audit sidecars.

The layer will store audits as structured objects, not only Markdown prose. It will enforce that `OPEN` is a verified status, not a copied label. If current evidence cannot be refreshed at the locked target HEAD, a finding must be classified as `NEEDS-VERIFY`, `HOLD`, or another non-open status.

Use an append-only audit event store with explicit status transitions and a derived current-state projection. Markdown reports may be ingested as sources, but the canonical audit state is structured JSON events keyed to a target repository and immutable target HEAD.

Do not add a large set of unrelated top-level MCP primitives first. Start with a small audited workflow surface:

- `gn_audit_verify`
- `gn_fix_history`
- `gn_audit_bundle`
- `gn_audit_lint`
- `gn_audit_ingest`

Later features such as path verification, resource tracing, stale-audit explanation, scope guards, and test suggestions should build on the same finding model.

## Implementation Status

Implemented. The audit lifecycle subsystem exists under `ontoindex/src/core/audit-lifecycle/`, with
finding schema, event store/projection, verify/lint/bundle flows, fix history, scope guard,
tombstones, replay, dispatch prompts, and CI export integration. CLI and MCP wrappers expose the
ingest, verify, lint, bundle, and fix-history workflows.

## Algorithm/Technique

### 1. Storage ownership

Create a new subsystem:

```text
ontoindex/src/core/audit-lifecycle/
  finding-schema.ts
  audit-session.ts
  audit-event-store.ts
  finding-fingerprint.ts
  finding-ingest.ts
  finding-verify.ts
  fix-history.ts
  finding-dedupe.ts
  audit-bundle.ts
  audit-lint.ts
  status-transitions.ts
  tombstones.ts
  invariants.ts
  intent-propagation.ts
```

Audit records are stored separately from the primary graph. The primary graph remains the source of symbol, process, route, test, and impact facts. Audit lifecycle records point to graph identities, commits, source files, and sidecar evidence, but do not mutate graph truth.

The audit event store must be keyed by:

```text
targetRepo
targetHead
auditSessionId
findingId
fingerprint
sourcePath/sourceHash
verifiedAt
verifierVersion
graphIndexId
sidecarStateHash
```

Events are immutable:

```text
AuditIngested
FindingCandidateCreated
FindingVerified
FindingStatusChanged
FindingTombstoned
FindingBundled
BundleDispatched
ScopeGuardEvaluated
AuditLinted
IntentProposed  # Propose bridge or semiotic sign
IntentApplied   # User applies the hypothesis to the primary graph
```

The current finding row is a projection over these events. If the projection is lost, OntoIndex must be able to rebuild it from the event log.

### 2. Canonical finding model

Minimum canonical finding shape:

```json
{
  "findingId": "AUDIT-SIDECAR-FD-001",
  "title": "Direct-spawn pipe CLOEXEC race",
  "severity": "HIGH",
  "status": "NEEDS-VERIFY",
  "source": "audits/comprehensive-architectural-audit-2026-05-17.md",
  "sourceHash": "sha256:...",
  "targetRepo": "axel",
  "targetHead": "2ce931e082ee",
  "targetRef": "main",
  "graphIndexId": "idx:2ce931e:schema:1",
  "workingTreeDirtyAtVerify": false,
  "claimedEvidence": [
    {
      "path": "wsd/SidecarManager.cpp",
      "line": 746,
      "symbol": "SidecarManager::_spawn",
      "claim": "uses pipe() followed by fcntl CLOEXEC"
    }
  ],
  "verifiedEvidence": [],
  "negativeEvidence": [],
  "statusReason": "",
  "fixCommit": null,
  "confidence": 0.0,
  "reasonCodes": [],
  "fingerprint": {
    "location": "semantic-stable-location-hash",
    "claim": "semantic-stable-claim-hash",
    "history": "semantic-stable-history-hash"
  },
  "claimDsl": null,
  "verificationKind": "static",
  "verifiedAt": null,
  "verifiedHead": null,
  "statusChangedAt": null,
  "statusChangedBy": "ontoindex",
  "statusTransitionEvidence": [],
  "reopenTrigger": null,
  "tombstoneMatch": null
}
```

Allowed statuses:

```text
OPEN
RESOLVED-ALREADY
PARTIAL
FALSE-POSITIVE
NEEDS-VERIFY
DECISION-GATED
HOLD
NEEDS-REVERIFY
```

`OPEN` requires fresh positive evidence at `targetHead`. A copied historical `OPEN` label is not valid.

`RESOLVED-ALREADY` and `FALSE-POSITIVE` require negative evidence, a fix commit, an invariant match, or another explicit contradiction of the claim.

`HOLD` requires `verificationKind`, `requiredEnvironment` when applicable, and a `reopenTrigger`.

`PARTIAL` means the verifier found some fresh evidence but could not check every required path or invariant. It is not a synonym for medium confidence.

`DECISION-GATED` means the finding is technically plausible but requires a human product, security, compatibility, or operational decision before implementation. It must include the decision owner and unblock condition.

### 3. Claim DSL and Structural Intents

Findings store machine-checkable claims or **Structural Intents**.

Initial claim kinds:

```text
forbidden-call-pattern
missing-cleanup
unchecked-return
missing-state-transition
missing-guard
missing-test
resource-leak
PROPOSE_BRIDGE    # Proposed cross-module interaction point
PROPOSE_SIGN      # Proposed architectural semiotic label (ADR 0063)
```

Example Intent:

```yaml
id: INTENT-001
claim:
  kind: PROPOSE_SIGN
  symbol: ontoindex/src/core/auth
  value: "Security"
  risk: architectural-drift
```

Structural intents exist in a `PENDING` state until the `IntentApplied` event occurs. Applied intents may be promoted into the primary KuzuDB graph as persistent semiotic signs or bridge edges.

Every claim kind must map to verifier logic. Broad categories without verifier support remain prose hints and should default to `NEEDS-VERIFY`.

Each verifier declares a capability matrix:

```text
claimKind
supportedLanguages[]
supportedEvidenceModes[]
maxInterproceduralDepth
pathSensitive: yes | no
resourceAware: yes | no
runtimeRequired: yes | no
unsupportedBehavior: NEEDS-VERIFY | HOLD
```

If no verifier supports a claim, the claim remains a structured hypothesis, not proof.

### 4. Status transition rules

Status transitions must be validated and recorded:

```text
NEEDS-VERIFY -> OPEN
  requires fresh positive evidence at targetHead

OPEN -> RESOLVED-ALREADY
  requires negative evidence, fix commit, or invariant still holding

OPEN -> FALSE-POSITIVE
  requires contradiction evidence or invalid premise

OPEN -> HOLD
  requires external blocker, verification kind, and reopen trigger

HOLD -> OPEN
  requires reopen trigger satisfied and fresh positive evidence

any -> NEEDS-REVERIFY
  allowed when code changed after verification
```

No report may use `STILL-OPEN` as a status. A report that carries forward old `OPEN` text without `verifiedAt`, `verifiedHead`, and fresh evidence must be downgraded to `NEEDS-VERIFY`.

Each transition records:

```text
statusChangedBy
statusChangedAt
reason
evidence[]
reasonCodes[]
verifiedHead
verifierVersion
```

Transition validation uses the latest event projection and current freshness metadata. If the target symbol, file hash, graph index id, or relevant tombstone invariant changed after verification, `OPEN`, `RESOLVED-ALREADY`, and `FALSE-POSITIVE` downgrade to `NEEDS-REVERIFY` until checked again.

### 5. Fingerprinting and relocation

Line numbers are unstable. Fingerprinting is layered:

```text
locationFingerprint
  path + symbol + AST neighborhood + blame anchors

claimFingerprint
  claim kind + calls/operators + claimed invariant + risk pattern

historyFingerprint
  prior audit id + root cause id + fix commit/tombstone id
```

Relocation order:

1. Prefer exact graph symbol identity.
2. Fall back to symbol name and file path.
3. Fall back to AST neighborhood similarity.
4. Fall back to git blame/history.
5. If confidence is low, mark `NEEDS-VERIFY`.

Relocation must never be enough to mark a finding `OPEN`; it only finds where to verify.

### 6. Verification pipeline

`gn_audit_verify` is the critical path.

For each finding:

1. Resolve `targetRef` to immutable `targetHead`.
2. Reopen the current file at `targetHead`.
3. Relocate the target symbol using fingerprinting.
4. Evaluate the claim DSL if present.
5. Search for current positive evidence.
6. Search for negative evidence that contradicts the claim.
7. Search nearby comments/tests for prior audit IDs or fix notes.
8. Search git history for commits touching the symbol after the source audit date.
9. Check tombstones and fix invariants.
10. Check test evidence.
11. Classify status with reason codes.

Acceptance rule:

```text
If no fresh positive evidence is found, do not return OPEN.
Return NEEDS-VERIFY, RESOLVED-ALREADY, FALSE-POSITIVE, HOLD, or NEEDS-REVERIFY.
```

Verification must preserve evidence provenance:

```text
evidence:
  kind: positive | negative | fix-history | tombstone | test | runtime | telemetry
  source: graph | sidecar | git-history | source-file | test-index | external-runtime
  targetHead
  graphIndexId
  fileHash
  symbolId
  path
  lineSpan
  verifierVersion
  confidence
  reasonCodes[]
```

Evidence without provenance can be displayed as context, but it cannot drive a status transition.

### 7. Fix history and tombstones

`gn_fix_history` searches commits, tests, and comments related to a symbol and claim pattern. It should return commits that:

- touch the symbol or file
- mention the audit ID, root cause, claim pattern, or related risk
- add or modify tests near the target
- introduce code that contradicts the stale finding

When a finding is fixed, create a tombstone:

```json
{
  "findingFingerprint": "fork-failure-fd-leak:SidecarManager::_spawn",
  "status": "RESOLVED",
  "fixedAt": "2ce931e082ee",
  "fixCommit": "abc123",
  "doNotReopenUnless": [
    "fork failure path no longer closes all created pipe fds"
  ]
}
```

Future ingest compares new findings against tombstones. If the invariant still holds, classify as `RESOLVED-ALREADY`.

Tombstones are versioned. If the verifier version, invariant schema, target symbol, or relevant file hash changes, the tombstone match becomes advisory and the finding is `NEEDS-REVERIFY` until the invariant is checked again.

### 8. Negative evidence and fix invariants

Negative evidence explains why a claim is not open:

```json
{
  "findingId": "FD-FORK-LEAK",
  "status": "RESOLVED-ALREADY",
  "negativeEvidence": [
    "SidecarManager.cpp:761 closes stdinPipe[0]",
    "SidecarManager.cpp:762 closes stdoutPipe[1]"
  ]
}
```

Fixed findings should leave invariants:

```yaml
finding: FD-FORK-LEAK
invariant:
  symbol: SidecarManager::_spawn
  on_path: fork_returns_negative
  must_call:
    - close(stdinPipe[0])
    - close(stdinPipe[1])
    - close(stdoutPipe[0])
    - close(stdoutPipe[1])
```

Invariants may be verified statically, through tests, or through runtime evidence depending on `verificationKind`.

### 9. Root-cause dedupe and bundles

Model duplicate findings explicitly:

```json
{
  "rootCauseId": "SIDE-LIFE-SHUTDOWN-001",
  "canonicalTitle": "Sidecar shutdown is abrupt and unbounded",
  "children": [
    "SIGKILL Flush Race",
    "waitpid Shutdown Hang",
    "SIGKILL Child Orphanage"
  ]
}
```

Deduplication modes:

```text
exact
symbol
root-cause
write-set
test-surface
```

Bundles are created from verified, non-excluded findings and root causes. Bundles, not prose findings, are the dispatch unit:

```text
AuditBundle
  bundleId
  title
  status
  findings[]
  rootCauseIds[]
  files[]
  impactTargets[]
  tests[]
  estimatedLoc
  nonScope[]
  stopConditions[]
```

Parallel work is allowed only when bundle write sets and symbols do not conflict.

Bundling is reversible. A root-cause merge never deletes child findings or their source evidence. If later verification splits the root cause, the bundle projection must be regenerated from the underlying findings.

### 10. Dispatch prompts and scope guards

`gn_dispatch_prompt` generates worker prompts from a single bundle. It must:

- assign exactly one bundle
- include no placeholders
- include scope and non-scope
- include impact checks
- include exact tests
- include stop conditions
- forbid unverified findings when configured
- include verification timestamp, target HEAD, and stale-state warning
- redact sensitive evidence unless explicitly disabled

`gn_scope_guard` checks worker output against bundle scope:

- allowed files
- changed symbols
- required tests
- missed findings
- accidental cross-bundle edits

Dispatch prompt generation defaults to rejecting bundles containing `NEEDS-VERIFY`, `NEEDS-REVERIFY`, `HOLD`, or runtime-only findings. A manager may override this only if the prompt is explicitly for verification or reproduction, not implementation.

### 11. Runtime-only findings

Some claims cannot be proven statically:

- cgroup v1/v2 host behavior
- privileged container behavior
- kernel `MSG_CTRUNC` behavior
- production telemetry or saturation
- large-data workload behavior

Represent these as:

```json
{
  "status": "HOLD",
  "verificationKind": "runtime",
  "requiredEnvironment": "privileged container with cgroup-v2",
  "reopenTrigger": "runtime repro confirms leak"
}
```

Audit lint rejects runtime-only claims marked `OPEN` without runtime evidence.

### 12. Diagnostic Saliency and Accuracy (Pathology)

- **`DiagnosticSaliencyMap`**: An extension to Audit Findings that attaches a "Saliency Score" to specific AST nodes within the evidence block, indicating exactly which parts of the function triggered the finding. This guides agent attention instantly to the root cause.
- **`AuditAccuracyDashboard`**: A background metric tracker that records the True Positive / False Positive rate of specific `Systems-Audit` rules based on user/agent `Accept/Reject/Tombstone` feedback.

### 13. MCP and CLI surface

Initial MCP super-functions:

```text
gn_audit_ingest
gn_audit_verify
gn_fix_history
gn_audit_bundle
gn_audit_lint
```

Proposed follow-up tools:

- `gn_propose_intent` - Register structural hypotheses.
- `gn_consolidate_memory` - Consolidate session context into permanent facts.

### 14. Memory and Context Consolidation

To maintain graph integrity and share knowledge across sessions, memory consolidation is gated until audit lifecycle events and docs-sidecar facts have a clear authority boundary:

1. **`MemoryConsolidationTask`**: Proposed pipeline stage that runs at the end of an agent session. It reviews the "Session Memory" (transient findings, navigation steps) and extracts permanent architectural facts (e.g., "Identified a hidden dependency between X and Y") to be merged into the primary Knowledge Graph as verified concepts or edges.
2. **`AgentContextCollisionDetection`**: Proposed graph-native overlap detection for concurrent agent sessions. It identifies when two agents (or one agent in two sessions) are retrieving/modifying overlapping subgraphs, preventing conflicting architectural changes or "Memory Drift."
3. Temporal Invariants: Support for `freshness` and `commitId` on all audit events, ensuring that a "Memory" is only valid for a specific version of the codebase.

### 15. Audit Evidence Delta Tracking

To support regression testing and multi-turn refactor auditing:

1. **`buildAuditSessionDiff`**: Implemented utility that compares two audit session/finding snapshots by fingerprint or ID and reports added, removed, unchanged, and status-changed findings.
2. **`summarizeAuditDelta`**: Proposed facade/export layer over the implemented diff primitive that can add citation-count and capability-availability deltas.
3. **Canonical Canonicalization**: Before diffing, audit findings are normalized by their fingerprint to ensure stable comparison across re-runs.

MCP responses must be bounded and redactable:

```text
maxFindings
maxEvidenceItems
maxHistoryCommits
includeSourceSnippets: false by default
redactionMode: none | paths | snippets | sensitive
```

`gn_audit_ingest` creates candidates only. It must not emit `OPEN` findings.

Later MCP super-functions:

```text
gn_audit_dedupe
gn_dispatch_prompt
gn_audit_tombstone_create
gn_audit_relocate
gn_audit_explain_stale
gn_bundle_conflicts
gn_scope_guard
gn_test_suggestions
```

Analyzer-backed later tools:

```text
gn_resource_trace
gn_path_verify
```

CLI mirrors the same workflow:

```bash
ontoindex audit ingest audits/new-audit.md --target HEAD --json
ontoindex audit verify --session audit-... --json
ontoindex audit lint audits/new-audit.md --target HEAD
ontoindex audit bundle --session audit-... --json
```

### 13. Audit quality gates

`gn_audit_lint` and `ontoindex audit lint` check:

- every `OPEN` finding has fresh evidence at `targetHead`
- no finding uses only stale line numbers
- no duplicate root cause is reported as separate implementation work
- no `STILL-OPEN` label appears
- no claim contradicts current source
- every `HOLD` has `verificationKind` and `reopenTrigger`
- every implementation bundle has tests and impact targets
- no known tombstone is reopened unless its invariant is violated
- no dispatch prompt contains unresolved placeholders
- no runtime-only claim is marked `OPEN` without runtime evidence

Advisory CI comes first. Blocking gates may later reject reports that violate lifecycle rules, but they must not block on vulnerability truth unless the verifier has high-confidence evidence.

### 14. Implementation order

1. Finding schema and status transition validator.
2. Append-only audit event store and current-state projection.
3. Audit ingest with target HEAD lock and candidate-only output.
4. `gn_audit_verify` with symbol relocation and fix-history lookup.
5. Tombstones and negative evidence.
6. `gn_audit_lint`.
7. Dedupe/root-cause model.
8. `gn_audit_bundle`.
9. Dispatch prompt generator.
10. Resource trace and path verifier integration.
11. Scope guard.
12. CI advisory mode.

If only three things ship first, ship:

1. `gn_audit_verify`
2. `gn_fix_history`
3. `gn_audit_bundle`

These directly prevent stale reports and turn noisy audits into actionable work.

## Consequences

### Positive

- Audits become reproducible, structured, and tied to an immutable target HEAD.
- Stale findings cannot be casually carried forward as `OPEN`.
- Fix commits, tests, negative evidence, tombstones, and invariants become part of the audit trail.
- Root-cause dedupe reduces duplicate implementation tasks.
- Bundles become safer dispatch units for external workers.
- Audit reports can be linted in advisory CI before they become blocking gates.

### Negative

- This adds a new persistent audit store and workflow state.
- Event-store plus projection logic is more work than mutable JSON rows.
- Verifier logic will be incomplete at first, so many findings may correctly remain `NEEDS-VERIFY`.
- Claim DSL design can overfit if too many broad claim kinds are accepted before verifier support exists.
- Bundling and dispatch prompts may create false confidence if scope guards are not enforced.
- Redaction and provenance requirements make MCP responses more complex.

### Guardrails

- `OPEN` requires fresh positive evidence at `targetHead`.
- `RESOLVED-ALREADY` and `FALSE-POSITIVE` require negative evidence, a fix commit, or invariant evidence.
- Runtime-only findings cannot be `OPEN` without runtime evidence.
- Status transitions must be recorded and validated.
- Prose-only findings default to `NEEDS-VERIFY` unless the verifier can independently prove the claim.
- Ingest never creates `OPEN`; only verify can.
- Evidence without provenance cannot drive status transitions.
- Root-cause dedupe is reversible and must preserve all child finding evidence.
- Dispatch prompts cannot include unverified findings unless the task is explicitly verification/reproduction.
- Audit lifecycle state must not mutate primary graph truth.
- CI starts advisory and becomes blocking only for lifecycle/process violations.
