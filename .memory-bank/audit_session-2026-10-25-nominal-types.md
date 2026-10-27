# Nominal TypeScript bindings and statement type imports

Date: 2026-10-25

## Decision and scope

Compared retaining erasure, adding one optional provider namespace hook, and
extending the export interpreter for same-name type/value coexistence. Selected
the hook: existing resolution receives real nominal identity without a parallel
export pipeline. Erasure loses identity; same-name coexistence requires separate
semantics and remains refused. A second source review found no defect in alias
projection, undefined-hook compatibility, or nominal binding placement.

Interfaces and type aliases emit nominal definitions in the type namespace.
Classes/enums occupy both namespaces; runtime declarations occupy value.
Type bodies remain opaque: alias evaluation, generic inference, heritage and
interface member dispatch are outside this slice. Named statement-level type
imports use the existing importer. Default/namespace type imports remain refused.

Owners: language-provider.ts, scope-extractor.ts, and languages/typescript*.ts
under ontoindex/src/core/ingestion/. Tests assert annotation identity, runtime
isolation, provider compatibility, worker extraction and retained replay.
No installation, activation or commit was performed. Preserve unrelated dirty
changes if rolling back; revert only this slice in these owners and tests.

## Validation

Native build: exit 0, /opt/d1/tmp/ontoindex-nominal-types-build-1.log.
First 33-suite invocation: exit 1, 1726 passed and 76 failed; obsolete erased
declaration/namespace expectations across six suites were corrected without
weakening parity comparisons. Annotation checks now require exactly two Port
references and one Alias reference before resolving their identities.

Final invocation: exit 0, all 1802 tests in 33 suites passed in 82.43 seconds.
Log: /opt/d1/tmp/ontoindex-nominal-types-tests-2.log. From ontoindex/:

```sh
ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/unit/scope-resolution test/integration/scope-retention-replay-parity.test.ts test/integration/scope-retention-child-roundtrip.test.ts test/integration/scope-retention-workspace-roundtrip.test.ts test/integration/workspace-build-real-child-cancel.test.ts --maxWorkers=1
```

Production code was unchanged after the successful build. Final scoped whitespace
check passed. OntoIndex verify_diff passed for seven production paths, with impact
capped at 25 symbols and exact symbol scope unchecked. Committed mode is not
supported for verify_diff; the corrected ordinary invocation passed. Index HEAD
matches 2623820ec85113c28b238d5f72dde496e27426a1; dirty source is authoritative.

## Frozen coverage and remaining qualification

All 43 source hashes match input.json. Compiled emitter classification09 retains
15 accepted and 26 refused TypeScript files. No file changed admission status.
Later blockers include arrays, objects, casts, templates, declarations and calls.
Artifact: eval/results/ontoindex-shared-pair-87x1w40f/capture-classification-09.json.
This measures emitter admission only, not full replay or performance.

The first classification attempt failed because native trees lack tree.delete;
the corrected invocation omitted that unsupported cleanup and succeeded.
Budget consumed: 1/4 builds, 2/8 test invocations, 2/2 corpus/performance attempts.
Further measured attempts need a scoped budget amendment. Test fixture replay
covers JS, TS, Python, C++ and Rust; public CLI/MCP qualification remains open.
Complete frozen syntax, complete replay and representative time/RSS remain open.
No performance gain or default large-workspace unblock is claimed.

The historical structured tracker remains closed; this is validation evidence,
not a fabricated manager-loop completion. Multiple Sol and Luna research/review
packets and Sol implementation packets were used with disjoint writes.
