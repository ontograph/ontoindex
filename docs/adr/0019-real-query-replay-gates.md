# ADR 0019: Core Retrieval Replay Gates

Status: Proposed - Challenged/Core Extension Only

## Context

OntoIndex retrieval has become a core product surface rather than a single fuzzy search path. Changes
to typed queries, RRF, embeddings, skeleton-first output, markdown sidecars, passive facts,
semantic-neighbor expansion, LSP readiness, and quality modes can move results without failing normal
unit tests.

The old version of this ADR was too close to operational query logging:

- `ontoindex/src/mcp/local/query-log.ts` already records lightweight diagnostic query rows.
- `backend-search.ts` already appends query timing and result metadata for diagnostics.
- `bench-gate.mjs` and semantic ANN benchmarks already demonstrate script-level gates.
- Audit replay now exists separately under the audit lifecycle layer.

Those are useful adjacent surfaces, but none of them is the new core feature. This ADR must not
repackage existing query logging, create a broad capture system, or add another MCP product surface.

The missing core functionality is a deterministic retrieval replay kernel that can answer:

```text
Given a fixed replay case and an indexed repo, did a retrieval change move ranked evidence beyond an
accepted threshold?
```

## Review and Challenge

The original proposal mixed new and existing work. The challenged version keeps only the part that
extends OntoIndex core functionality.

Rejected from this ADR:

1. **Default query-log evolution as the primary feature.** Diagnostic logs already exist and are not a
   stable test corpus.
2. **A generic tool-call recorder.** Capturing `context`, `impact`, audit, edit, or MCP HTTP sessions is
   outside retrieval replay.
3. **Replay as audit authority.** Result movement is a regression signal, not proof that a finding is
   open, fixed, or false-positive.
4. **CLI/export-first design.** A command can wrap the kernel later; the first deliverable is a pure
   core module with fixtures and tests.
5. **Raw query text as the contract.** Replay cases must normalize request shape, quality mode,
   capabilities, repo identity, and expected result identities.
6. **Network or hosted-service replay.** Replay must run against local OntoIndex indexes only.
7. **Frozen index snapshots in v1.** The first slice measures current-index behavior and reports
   freshness/capability drift instead of shipping large frozen graph artifacts.

Accepted core extension:

```text
ReplayCase[] + RetrievalExecutor
  -> normalized retrieval run
  -> stable result identities
  -> movement metrics
  -> advisory gate verdict
```

## Decision

Add a new core retrieval replay subsystem for deterministic, advisory regression checks over OntoIndex
search behavior.

The subsystem is not a logging platform. It is a testable core library that:

1. Defines a versioned replay-case schema.
2. Executes cases through the same retrieval kernel used by current search surfaces.
3. Normalizes ranked results to stable identities.
4. Computes movement and capability-drift metrics.
5. Produces an advisory gate result for maintainers and later wrappers.

The first implementation remains search-only and advisory. It may be wrapped by a script or CLI after
the core contract lands, but the core library must not depend on MCP, HTTP sessions, CI runtime
state, or query-log files.

## Core Functionality

### 1. Versioned Replay Case Schema

Add a core schema under:

```text
ontoindex/src/core/search/replay/
  replay-case.ts
```

Shape:

```ts
export interface RetrievalReplayCaseV1 {
  schemaVersion: 1;
  id: string;
  repoHint?: string;
  query: string;
  request: {
    action: 'semantic';
    typedQuery?: boolean;
    retrievalPolicy?: 'graph-only' | 'graph-with-passive-docs' | 'requirement-neighborhood' | 'api-route-neighborhood' | 'process-neighborhood' | 'symbol-neighborhood';
    includeSkeleton?: boolean;
    includeContent?: boolean;
    consumeEnrichmentFacts?: boolean;
    includePassiveRelatedFacts?: boolean;
    includeMarkdownContext?: boolean;
    includeMarkdownPpr?: boolean;
    limit?: number;
    qualityMode?: 'fast' | 'balanced' | 'thorough';
  };
  expected: {
    topK: number;
    identities: RetrievalReplayIdentity[];
    minimumJaccardAtK?: number;
    requireTop1Stable?: boolean;
    allowedCapabilityDrift?: string[];
  };
  notes?: string[];
}
```

Rules:

- Replay cases are checked into fixtures or generated explicitly by maintainers.
- Schema validation rejects unknown `schemaVersion`.
- Request fields mirror existing search concepts but use stable core names, not MCP parameter names.
- No file bodies, source snippets, prompt text, tool arguments, or raw MCP payloads are stored.

### 2. Stable Result Identity

Add:

```text
ontoindex/src/core/search/replay/result-identity.ts
```

Identity must be explicit enough to survive ranking changes and explain drift:

```ts
export interface RetrievalReplayIdentity {
  kind: 'symbol' | 'process' | 'file' | 'doc-section' | 'unknown';
  uid?: string;
  repoPath?: string;
  filePath?: string;
  name?: string;
  signatureHash?: string;
  docPath?: string;
  headingPath?: string[];
}
```

Rules:

- Prefer symbol UID when available.
- Include `filePath` and `name` as fallback explainability fields.
- Include doc-section identity for markdown sidecar results.
- Unknown identities are allowed only with a warning and cannot satisfy strict top-1 gates.

### 3. Retrieval Replay Executor

Add:

```text
ontoindex/src/core/search/replay/replay-runner.ts
```

Core API:

```ts
export interface RetrievalReplayExecutor {
  run(caseInput: RetrievalReplayCaseV1): Promise<RetrievalReplayRun>;
}

export async function replayRetrievalCases(input: {
  cases: readonly RetrievalReplayCaseV1[];
  executor: RetrievalReplayExecutor;
  now?: () => number;
}): Promise<RetrievalReplayReport>;
```

Implementation constraints:

- The executor calls the existing backend search/retrieval path through an adapter.
- The runner does not import MCP server, HTTP server, or query-log modules.
- The runner does not run `analyze`, refresh sidecars, write indexes, or mutate repositories.
- Capability state and freshness state are captured from existing target/retrieval diagnostics.

### 4. Metrics and Advisory Gate

Add:

```text
ontoindex/src/core/search/replay/replay-metrics.ts
ontoindex/src/core/search/replay/replay-gate.ts
```

Metrics:

- `jaccardAtK`
- `top1Stable`
- `rankDelta`
- `missingExpected`
- `newUnexpected`
- `capabilityDrift`
- `freshnessDrift`
- `latencyDeltaMs`
- `warnings`

Gate verdict:

```ts
export type RetrievalReplayVerdict = 'PASS' | 'WARN' | 'FAIL';
```

Rules:

- `FAIL` means the replay contract moved beyond explicit thresholds.
- `WARN` means replay ran but capability/freshness drift makes the result advisory.
- Infrastructure errors are reported separately from retrieval movement.
- The library returns structured output; process exit codes belong to a later CLI/script adapter.

### 5. Fixture Corpus

Add focused fixtures under:

```text
ontoindex/test/fixtures/retrieval-replay/
```

Initial cases should cover new core retrieval behavior:

- plain semantic search;
- typed-query search;
- graph-only vs passive-docs retrieval policy;
- markdown context/PPR opt-in;
- symbol-neighborhood retrieval policy from ADR 0082;
- missing embeddings or sidecar degraded behavior.

Fixtures should be small and deterministic. They must not require network access or private repo
state.

### 6. Baseline and Drift Contract

Replay cannot claim a retrieval regression if the corpus, index, or capabilities changed underneath
the test. The core report must therefore separate **result movement** from **baseline invalidation**.

Each replay report must include:

- `caseSchemaVersion`
- `repoPath`
- `indexedHead`
- `currentHead`
- `indexFreshness`
- `qualityMode`
- enabled retrieval capabilities
- missing retrieval capabilities
- sidecar/embedding freshness where relevant

Rules:

- If the index is stale or the repo/capability assumptions do not match the case, the verdict may be
  `WARN`, but not `PASS`.
- If required capabilities are missing, the case is skipped or downgraded with a structured reason.
- If expected identities cannot be resolved because the fixture corpus changed, report
  `baseline_invalid` separately from retrieval movement.
- v1 may use checked-in miniature fixture repositories or synthetic indexed rows, but it must not
  require large frozen `.ontoindex` snapshots.

## Rejected From Core

- Default-on capture of real user queries.
- Query-log export as the primary feature.
- HTTP/MCP session replay.
- Audit lifecycle replay; that belongs to ADR 0017/0018.
- CI blocking before replay fixtures are stable.
- LLM judging of result quality.
- Storing source snippets or file contents in replay cases.
- Frozen `.ontoindex` graph snapshots for v1.
- Hosted PR or GitHub Actions-specific behavior in the core library.

## Acceptance Criteria

- A versioned `RetrievalReplayCaseV1` schema exists in core.
- Replay runner is a pure core module with dependency-injected executor.
- Stable identity extraction covers symbols, files, processes, and markdown doc sections.
- Metrics report movement, freshness drift, capability drift, and warnings separately.
- Baseline invalidation is distinct from retrieval movement.
- Fixtures cover at least typed search, passive-docs, markdown context, and symbol-neighborhood policy.
- Unit tests prove replay does not import MCP server, HTTP server, or query-log modules.
- Unit tests prove unknown identities cannot satisfy strict top-1 gates.
- Unit tests prove stale index or missing required capability cannot produce `PASS`.
- The first public wrapper, if added, is thin and delegates to the core replay library.

## Validation

For implementation work, run focused tests first:

```bash
cd ontoindex && npm test -- --run test/unit/retrieval-replay*.test.ts test/unit/backend-search-typed.test.ts test/unit/hybrid-search.test.ts
cd ontoindex && npx tsc --noEmit --pretty false
```

If the implementation adds a script or CLI wrapper, also run its dry-run/help test and prove the
wrapper delegates to the core replay API.

## Consequences

Positive:

- Retrieval changes get a deterministic regression signal before they ship.
- The feature extends OntoIndex core search quality infrastructure instead of growing MCP/tool sprawl.
- Replay can cover new retrieval policies such as `symbol-neighborhood`.
- Privacy risk is lower because v1 uses explicit fixtures, not default real-query capture.
- The output can later feed CI adapters once fixtures and thresholds stabilize.

Negative:

- Replay measures movement, not semantic correctness.
- Fixture maintenance becomes part of retrieval work.
- Stable identities require careful fallback behavior across index rebuilds.
- Current-index replay cannot fully isolate code changes from corpus/index drift unless the baseline
  contract is satisfied.

## Relationship to Existing ADRs

- ADR 0011: skeleton-first output can be included as a replay request dimension.
- ADR 0012: intent classification changes should add or update replay cases.
- ADR 0015/0029: sidecar and markdown context are replay capabilities, not replay authority.
- ADR 0022: structured retrieval supplies typed request shape and RRF diagnostics.
- ADR 0028: evidence expansion and `basedOnReads` can be checked as result metadata.
- ADR 0082: `symbol-neighborhood` policy must be replayable as a core retrieval extension.

## Open Questions

- Should a future capture tool generate fixture candidates from diagnostic query logs, with explicit
  maintainer approval?
- What minimum fixture set is required before replay can become CI-blocking?
- Should replay compare exact result scores or only rank/identity movement?
- Should a future replay fixture include expected diagnostics, not only expected identities?
