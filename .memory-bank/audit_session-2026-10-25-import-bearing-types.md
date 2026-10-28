# Import-bearing TypeScript declaration capture

Date: 2026-10-25
Status: implemented; focused validation passed.

The next frozen-workload gap is `src/graph/types.ts`: an ordinary named import
followed by exported interfaces and type aliases. The prior compiled result
accepted 12 of 41 TypeScript files. Independent source classification identifies
one additional candidate for this bounded extension; runtime proof is pending.

Compared ordinary import preservation, exported enum semantics, and barrel
reexports. Selected the existing ordinary import emitter alongside the existing
erased declaration grammar. Enums require runtime member/export facts; barrel
reexports require broader cross-module linkage. Both remain separate work.

Second-pass challenge rejected accepting imports while discarding their facts.
Ordinary imports retain ordinary import records, explicit `import type` stays
erased, and duplicate ordinary bindings remain refused. Reuse of the existing
import validator preserves supported default/named/namespace forms without a
second parser. Executable statements, unsupported import forms and malformed
syntax remain refused. This adds a bounded scan and detached import records;
no performance benefit is claimed. Rollback is limited to this slice's emitter
and regression changes, preserving prior dirty work.

Four GPT discovery/review packets preceded two GPT implementation packets with
disjoint source and test ownership. One worker dispatch was rejected before
execution for prompt shape; its corrected dispatch succeeded. The source worker
then requested explicit packet labels, supplied without any code or test retry.

OntoIndex HEAD/index match `2623820ec85113c28b238d5f72dde496e27426a1`.
Emitter context and impact returned not-in-index; risk is UNKNOWN. Uncommitted
source is authority. Historical structured manager remains closed; no receipts
or task completions are inferred from this local evidence record.

Validation allowance: one focused suite, up to two diagnosed correction suites,
one native build, and one compiled frozen-input classification. Children run no
validation. No representative pair, activation, install, or release is in scope.

## Validation

Independent final review caught duplicate locals across explicit type and
ordinary imports. The shared name check now refuses both orders and alias
collisions without emitting type-import value facts. Final source review found
no blocking issue in this bounded slice.

Initial focused suite session 60170 exited 1: 572 passed, two worker parity
failures. Source sequential/recovery accepted the fixture while the compiled
worker still used the previous emitter. Native build session 60974 exited 0;
corrected suite session 73182 exited 0: 574 tests across six suites in 18.22s.
Logs: `/opt/d1/tmp/ontoindex-import-types-tests.log`,
`/opt/d1/tmp/ontoindex-import-types-build.log`, and
`/opt/d1/tmp/ontoindex-import-types-tests-r1.log`.

The suite covers type-only modules, ordinary import captures, general TypeScript
captures, borrowed-root worker recovery, retention coverage and persisted
full/replay parity. The build used `ONTOINDEX_MAX_WORKERS=4 npm run build` from
`ontoindex/`; Vitest used `ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4`, the
six named test files and `--maxWorkers=1`. No containers or detached jobs ran.

Compiled frozen-input classification exited 0, verified per-file SHA-256, and
accepted 13/41 files with 28 refused. Newly accepted `src/graph/types.ts` emits
four captures including one ordinary import. Evidence:
`../eval/results/ontoindex-shared-pair-87x1w40f/capture-classification-03.json`.
This is emitter evidence, not representative replay or performance acceptance.

Budget used: one build, two suite invocations (one correction), one classification;
one correction suite unused. No representative pair or activation performed.
Changed source: `typescript-captures.ts`. Changed tests: type-only-module,
parse-worker-scope-integration, type-only-coverage and replay-parity. Existing
unrelated dirty state remains preserved.
