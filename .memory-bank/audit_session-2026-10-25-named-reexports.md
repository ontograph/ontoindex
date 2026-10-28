# Named TypeScript reexport capture

Date: 2026-10-25
Status: implemented and focused validation passed.

The frozen component now admits 15/41 TypeScript files. Its barrel uses
ordinary named and type-only reexports, represented by existing ParsedImport
reexport facts. No transitive export closure is claimed.

Compared constant modules (require erased/value composition, generic annotations
and object literal support), mixed type imports (seven files still contain
unsupported runtime syntax), and named reexports. Selected named reexports after
independent challenge: reuse existing import facts and preserve explicit local
export maps. Foreign export IDs violate extractor ownership; transitive closure
needs separate cycle, ambiguity and namespace work. No shared schema is added.

Support named/renamed exports and type markers. Reject wildcard, namespace,
default/quoted names, attributes, escaped sources and malformed statements.
Reject duplicate public names conservatively across namespaces, while allowing
a reexport to share a name with a nonexported local. Preserve the existing thin
barrel resolution boundary. Rollback only this slice's edits, preserving prior
dirty state. No installation or default activation.

Four read-only GPT agents compared options; two development agents own disjoint
production/test files. Production owners are the existing TypeScript capture,
export-capture and import-capture modules. Committed OntoIndex HEAD matches
2623820ec85113c28b238d5f72dde496e27426a1; export emitter/import interpreter impacts
LOW. Composer is absent from the index: source inspection is authority.

Validation allowance: one build plus one diagnosed correction build, one focused
suite plus two diagnosed correction suites, one frozen compiled classification.
Parent owns native serial validation, workers capped at four and Vitest at one.
Children run no builds/tests. No background launch or representative benchmark.

## Validation

First build exited 1: TS2339 in export interpreter, ParsedImport union required
explicit reexport narrowing before reading localName. Independent review also
found mixed export-topic captures bypassed validation on the reexport fast path.
Both corrections are assigned to the existing production owner; tests add a
mixed-topic regression. One correction build remains; no tests run yet.
Log: `/opt/d1/tmp/ontoindex-named-reexports-build.log`.

Both corrections landed and independent source review found no remaining blocker.
Correction build `ONTOINDEX_MAX_WORKERS=4 npm run build` from `ontoindex/` exited 0;
log `/opt/d1/tmp/ontoindex-named-reexports-build-correction-1.log`. Both allowed
builds consumed. No further production changes followed that build.

Focused validation exited 0: 726 tests in seven suites, 18.99 seconds.
Command from `ontoindex/`: `ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node
node_modules/vitest/vitest.mjs run test/unit/scope-resolution/typescript-captures.test.ts
test/unit/scope-resolution/typescript-export-captures.test.ts
test/unit/scope-resolution/typescript-import-captures.test.ts
test/unit/scope-resolution/typescript-type-only-module.test.ts
test/unit/scope-resolution/finalize-algorithm.test.ts
test/unit/scope-resolution/finalize-orchestrator.test.ts
test/integration/scope-retention-replay-parity.test.ts --maxWorkers=1`.
Log `/opt/d1/tmp/ontoindex-named-reexports-tests.log`. No correction suite needed.
Checks cover exact detached facts, invalid namespace/mixed-topic captures,
duplicate publication, ordinary import compatibility, existing thin-barrel
resolution boundaries, and sequential/worker/recovery full/replay parity.

Compiled frozen classifier exited 0, verifying all 43 source hashes. Artifact:
`eval/results/ontoindex-shared-pair-87x1w40f/capture-classification-05.json`.
Barrel emits 135 reexport records; TypeScript counts are 15 accepted, 26 refused.
This measures emitter coverage only; representative replay timing/RSS remain open.

Scoped OntoIndex verify_diff passed for three production and five test files;
expectedSymbols omitted and impact scan capped at 25, so only file scope verified.
Scoped git diff --check exited 0; it does not cover untracked source contents.
Required-language Linux/public CLI/MCP/installation qualification remain open.

Historical structured manager remains closed; this bounded continuation
does not reopen historical tasks or modify leases.
