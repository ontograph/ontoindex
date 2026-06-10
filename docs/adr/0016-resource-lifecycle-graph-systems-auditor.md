# ADR 0016: Core Systems-Audit Coverage Manifest

Status: Implemented (core coverage manifest)

## Context

OntoIndex already has a substantial systems-audit substrate. The original ADR mixed several things
that now exist or belong elsewhere:

- resource fact contracts and freshness envelopes;
- C/C++ POSIX resource extraction;
- systems rule engine;
- boundary tracing;
- FSM extraction;
- taint tracing;
- ABI diff;
- concurrency audit;
- error topology;
- fault simulation;
- pressure impact;
- graph-promotion review;
- MCP wrappers and tool-registry entries for systems-audit tools.

The remaining OntoIndex-core gap is narrower. Agents can run analyzers, but there is no deterministic
core report that answers:

```text
For this indexed snapshot, which systems-audit evidence families are fresh, missing, partial,
unsupported, stale, or blocked, and what exact evidence gaps prevent relying on them?
```

Without that manifest, manager agents can overtrust one analyzer output, miss stale sidecar records,
or dispatch duplicate systems-audit work that the current repo cannot support.

## Existing Functionality Excluded From This ADR

These are already implemented enough that this ADR must not recreate them:

- `ontoindex/src/core/systems-audit/resource-facts.ts`
- `ontoindex/src/core/systems-audit/systems-audit-contracts.ts`
- `ontoindex/src/core/systems-audit/systems-audit-store.ts`
- `ontoindex/src/core/systems-audit/resource-extractor-cpp.ts`
- `ontoindex/src/core/systems-audit/systems-rule-engine.ts`
- `ontoindex/src/core/systems-audit/boundary-trace.ts`
- `ontoindex/src/core/systems-audit/fsm-extractor.ts`
- `ontoindex/src/core/systems-audit/taint-trace.ts`
- `ontoindex/src/core/systems-audit/abi-diff.ts`
- `ontoindex/src/core/systems-audit/concurrency-audit.ts`
- `ontoindex/src/core/systems-audit/error-topology.ts`
- `ontoindex/src/core/systems-audit/fault-simulation.ts`
- `ontoindex/src/core/systems-audit/pressure-impact.ts`
- `ontoindex/src/core/systems-audit/graph-promotion-review.ts`
- `ontoindex/src/core/systems-audit/additional-analyzers.ts`
- MCP systems-audit dispatch and registry surfaces.

This ADR also does not approve primary graph schema promotion, new top-level MCP tools, automatic
indexing, filesystem scanning, Git access, LLM interpretation, or analyzer execution.

## OntoIndex Evidence Review

This challenge pass used the local OntoIndex CLI and source reads.

- `ontoindex status` reported the local index is up to date at commit `1b0e8ce`.
- `ontoindex/src/core/systems-audit/` contains implemented modules for the analyzer families listed
  above.
- Unit tests already exist for systems-audit contracts, resource extraction, rule engine, boundary
  tracing, FSM, taint, ABI, concurrency, error topology, fault simulation, pressure impact, graph
  promotion, and additional analyzer gates.
- The originally named `metric-layers.ts` file does not exist.
- Search found no dedicated `coverage-manifest.ts` or equivalent core report that summarizes
  analyzer coverage across existing systems-audit records.
- `additional-analyzers.ts` only declares later analyzers such as FSM, taint, ABI, fault simulation,
  concurrency, error topology, and pressure impact. It does not cover base analyzers such as
  `gn_audit_logic` and `gn_trace_boundary`, so the coverage manifest needs its own caller-supplied
  declaration shape instead of mutating that registry.

Conclusion: ADR 0016 should add only a pure core coverage manifest over supplied systems-audit
records and caller-supplied analyzer declarations. It should not add more analyzers or MCP wrappers.

## Challenge Findings

1. **The original ADR is no longer a clean implementation plan.** Most of its analyzer list already
   exists, so treating the whole ADR as undone would create duplicate code.
2. **Analyzer execution is not coverage governance.** Running `gn_audit_logic` or
   `gn_trace_boundary` gives one report; it does not say whether the overall systems-audit evidence
   set is fresh and complete enough for a manager decision.
3. **Graph promotion remains out of scope.** Existing `graph-promotion-review.ts` already protects
   primary graph promotion. This ADR must not add labels or relationships.
4. **MCP expansion is not core functionality.** Tool routing and registry exposure already exist and
   belong to MCP surfaces. This ADR should produce a core value object that adapters may expose later.
5. **Metric layers need a manifest boundary first.** External pressure or ownership data should be
   represented as supplied evidence coverage, not as an implicit graph mutation.

## Decision

Add a pure core systems-audit coverage manifest builder.

The manifest consumes caller-supplied current snapshot metadata, analyzer declarations, expected
coverage scopes, and existing systems-audit records. It emits a deterministic report that classifies
coverage per analyzer and per scope as covered, partial, missing, stale, unsupported, or blocked.

Approved core shape:

```text
SystemsAuditCoverageInput
  -> normalize expected systems-audit scopes
  -> classify supplied records against current snapshot freshness
  -> match analyzer declarations to expected scopes
  -> aggregate coverage by analyzer and scope
  -> emit gaps and summary counts
  -> SystemsAuditCoverageManifest
```

## Core Functionality

### 1. Shared Coverage Model

Add:

```text
ontoindex/src/core/systems-audit/coverage-manifest.ts
```

Core types:

```ts
export interface SystemsAuditCoverageInput {
  snapshot: SystemsAuditCurrentSnapshot;
  analyzerDeclarations: readonly SystemsAuditCoverageAnalyzerDeclaration[];
  scopes: readonly SystemsAuditCoverageScope[];
  records: readonly SystemsAuditRecord[];
}

export interface SystemsAuditCoverageAnalyzerDeclaration {
  analyzerId: string;
  sidecarRecordKind?: string;
  available?: boolean;
  requiredGates?: readonly string[];
  completedGates?: readonly string[];
}

export type SystemsAuditCoverageStatus =
  | 'covered'
  | 'partial'
  | 'missing'
  | 'stale'
  | 'unsupported'
  | 'blocked';

export interface SystemsAuditCoverageScope {
  id: string;
  analyzerId: string;
  filePath?: string;
  symbolName?: string;
  resourceKind?: string;
  category?: string;
  required?: boolean;
}

export interface SystemsAuditCoverageManifest {
  snapshot: SystemsAuditCurrentSnapshot;
  scopes: readonly SystemsAuditCoverageResult[];
  gaps: readonly SystemsAuditCoverageGap[];
  summary: SystemsAuditCoverageSummary;
}
```

Rules:

- Scope ids are caller-provided stable identifiers.
- Analyzer ids must match caller-supplied declarations or be reported as unsupported.
- The builder may accept declarations derived from `additional-analyzers.ts`, MCP registry metadata, or
  test fixtures, but it must not mutate those registries.
- Records are supplied as inputs; the builder must not run analyzers.
- Freshness must use existing systems-audit record freshness decisions.
- The manifest is advisory core data, not an audit lifecycle status and not a recommendation engine.

### 2. Coverage Manifest Builder

Add:

```ts
export function buildSystemsAuditCoverageManifest(
  input: SystemsAuditCoverageInput,
): SystemsAuditCoverageManifest;
```

Builder rules:

- Pure deterministic function over supplied input.
- No filesystem, Git, LadybugDB, MCP, HTTP, embedding, LLM, or analyzer execution.
- A required scope with no matching fresh record becomes `missing`.
- A matching stale record becomes `stale`, not `covered`.
- A matching partial/unresolved record becomes `partial`.
- A matching failed record becomes `partial` with a failed-record reason unless the analyzer itself is
  unavailable or blocked.
- A matching unsupported record becomes `unsupported`.
- A scope whose analyzer is unavailable becomes `unsupported`.
- A scope whose analyzer gate is unmet becomes `blocked`.
- Record matching is limited to explicit record fields and payload metadata: `analyzerId`, optional
  `filePath`, optional finding `category`, and optional resource `resourceKind`.
- Optional scopes contribute to summary counts but do not make the manifest fail.
- Output order is deterministic by scope id and analyzer id.

### 3. Coverage Gap Manifest

Gap kinds:

```ts
export type SystemsAuditCoverageGapKind =
  | 'missing-required-scope'
  | 'stale-record'
  | 'partial-record'
  | 'unsupported-analyzer'
  | 'blocked-analyzer-gate';
```

Rules:

- Gaps identify the scope id and analyzer id.
- Gaps include a concise reason and related record ids when available.
- Gaps do not include recommended tools or mutate audit lifecycle status.
- Gaps may be consumed later by MCP or audit adapters, but this ADR does not add those adapters.

## Rejected From Core

- New resource extractor or systems rule logic.
- New `gn_*` tool.
- MCP registry, dispatch, or help changes.
- Primary graph nodes or relationship types.
- Sidecar storage format migration.
- Automatic analyzer execution.
- Automatic broad re-indexing or file watching.
- LLM/NLI interpretation of systems-audit findings.
- Metric overlay graph promotion.
- Audit lifecycle status transition logic.

## Later Adapters

After the core manifest lands and tests prove the contract, later work may add thin adapters:

1. MCP/readiness adapter that exposes the manifest in an existing systems-audit envelope.
2. Audit-lifecycle adapter that attaches coverage gaps as advisory evidence.
3. Optional metric-layer ingestion that supplies coverage scopes and records to the manifest.

Those adapters must not change the core rules above.

## Implementation Status

Implemented in:

- `ontoindex/src/core/systems-audit/coverage-manifest.ts`
- `ontoindex/src/core/systems-audit/index.ts`
- `ontoindex/test/unit/systems-coverage-manifest.test.ts`

The implementation landed only the approved core slice: caller-supplied analyzer declarations,
explicit coverage scopes, supplied systems-audit records, snapshot freshness checks, per-scope
coverage statuses, coverage gaps, summary counts, deterministic ordering, and barrel export.

No analyzer execution, MCP/CLI wrapper, registry mutation, graph schema, storage migration,
recommendation policy, LLM behavior, or audit lifecycle status transition was added.

## Acceptance Criteria

- `coverage-manifest.ts` exists under `ontoindex/src/core/systems-audit/`.
- The builder accepts explicit scopes, analyzer declarations, current snapshot metadata, and supplied
  systems-audit records.
- The builder does not query graph, MCP, HTTP, Git, filesystem, embeddings, LLMs, or run analyzers.
- The builder does not mutate `additional-analyzers.ts`, MCP registries, or systems-audit record
  storage.
- Fresh matching records produce `covered` results.
- Stale matching records produce `stale` gaps.
- Partial or unresolved matching records produce `partial` gaps.
- Failed matching records produce `partial` gaps with failed-record evidence.
- Missing required scopes produce `missing-required-scope` gaps.
- Unknown analyzer ids produce `unsupported-analyzer` gaps.
- Unmet analyzer gates produce `blocked-analyzer-gate` gaps.
- Optional scopes are reported but do not make required coverage incomplete.
- Output is deterministic.
- Unit tests cover covered, missing, stale, partial, unsupported, blocked, optional, and ordering
  behavior.

## Validation

For implementation work, run focused tests first:

```bash
cd ontoindex && npm test -- --run test/unit/systems-coverage-manifest.test.ts
cd ontoindex && npx tsc --noEmit --pretty false
```

Before editing any existing implementation symbol, rerun fresh OntoIndex impact checks for that
symbol. Adding the new core module does not require impact analysis on existing symbols.

## Consequences

Positive:

- Managers get one deterministic answer about systems-audit evidence coverage before dispatching
  more work.
- Existing systems-audit analyzers remain the source of facts; the new core only judges coverage.
- Future MCP and audit adapters can share one coverage contract.
- The design avoids graph pollution and duplicate analyzer code.

Negative:

- The first slice is not directly user-visible unless called by tests or later adapters.
- Coverage quality depends on caller-supplied scopes and records.
- It does not improve analyzer precision; it only reports evidence readiness.

## Stop Conditions

- Stop if implementation requires a new analyzer.
- Stop if implementation requires MCP registry or dispatch changes.
- Stop if implementation requires primary graph schema changes.
- Stop if the builder needs filesystem, Git, database, HTTP, embedding, or LLM access.
- Stop if coverage gaps become audit lifecycle status transitions or recommendations.
