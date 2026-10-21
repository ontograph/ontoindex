# ADR: Workspace preparation limit diagnostics

Status: Accepted for diagnostic fields; request-level read selection and incremental relationships remain design work
Date: 2026-10-21
Authority: User approval to proceed with the reviewed workspace-preparation solutions

## Decision

Extend the existing preparation error and MCP error formatter. A refused full
workspace graph exposes only `observedIndexedFiles`, `maxIndexedFiles`, and
`requiredCapability: "workspace-graph"` under `diagnostics`. Preserve the existing
error code and retryability. Backend translation projects these fields; MCP
serialization additionally validates safe integer counts and the fixed capability.
Raw preparation messages, causes, paths, and unknown fields remain private.
Admission limits, query behavior, and build ownership remain unchanged.

## Alternatives and second review

Preserving arbitrary error messages would expose useful counts but also private
paths and sensitive backend content. Raising the global file cap permits more
builds but retains their full resource cost. Typed numeric diagnostics explain
the admission failure with bounded, independently testable output. They are the
preferred immediate repair and do not restore blocked navigation by themselves.

The second review identified direct backend consumers as another disclosure
boundary: filtering only in the MCP server leaves extra diagnostic fields visible
to those consumers. Both boundaries therefore project approved fields.

## Remaining design decisions

Request-level committed-index selection must select one graph and source generation
through composed calls, overlays, enrichment and pagination. The existing global
`ONTOINDEX_AUTO_WORKSPACE=0` behavior includes manual overlays; it does not prove
strict committed-only semantics. A request flag that merely skips preparation
cannot satisfy the proposed contract. Compatibility tests and a dedicated decision
must establish scope and evidence labels before adding the public option.

The current automatic-workspace ADR explicitly defers incremental relationship
updates. Such updates require invalidation of incoming relationships, deletions,
renames and resolver configuration effects, followed by same-input parity against
full graph builds. Existing incremental embedding reuse is insufficient evidence
for that change. The full workspace graph remains the relationship-read authority.

Diff verification currently normalizes omitted symbol expectations to an empty
set. Changing omission semantics would change existing acceptance behavior and is
separate from this repair; explicit empty expectations must remain enforceable.

## Validation and rollback

Existing runtime, backend-dispatch and public MCP error suites cover rejected
admission before lock acquisition, field propagation, private-field exclusion,
malformed diagnostics and unchanged error classifications. Native TypeScript
checking and scoped diff verification complete validation. Revert this repair's
source and test hunks to roll back; preserve unrelated worktree changes.
