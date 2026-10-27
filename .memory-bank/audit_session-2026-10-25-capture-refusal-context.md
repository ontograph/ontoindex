# TypeScript capture refusal context

Date: 2026-10-25
Status: implemented; focused validation passed.

The frozen corpus has 26 refused TypeScript files with the same generic composer
message. Precise syntax prioritization requires evidence of the first offending
node rather than guesses from filenames. One explorer's initial claim that const
declarations lacked support was rejected: current validateDeclaration already
handles lexical declarations, with restrictions on initializers.

## Compared approaches

| Approach | Benefit | Challenge and decision |
| --- | --- | --- |
| Compose erased declarations with runtime modules | Removes a whole-file restriction | Requires export-owner changes and namespace/collision decisions; defer until actual blockers are located |
| Add a runtime expression family | Could admit more files | Requires complete operand/reference semantics; unsupported family priority is not yet established |
| Add bounded node kind and location to existing refusals | Makes current failures actionable | Selected: one owner, unchanged admission, no dependency or framework, low runtime cost on failure only |

Second review prefers optional node context on the existing unsupported helper.
Per-statement catch/rethrow obscures the offending child and changes error
provenance; root-only wrapping generally reports program at 1:1. Preserve error
identity and message prefix. Emit only bounded grammar-kind text and safe one-based
coordinates; never include source text, names, paths or retained AST objects.
Downstream helper errors retain their original messages. This is location evidence,
not a stable reason code or complete blocker inventory.

Four read-only GPT Luna/Sol agents reviewed frozen inputs, owner, tests and risks;
two Sol development workers own disjoint production and test files. Production:
`ontoindex/src/core/ingestion/languages/typescript-captures.ts`. Tests:
`ontoindex/test/unit/scope-resolution/typescript-captures.test.ts`.

Committed index matches HEAD at 2623820ec85113c28b238d5f72dde496e27426a1, but the
composer is absent from that graph. Impact is UNKNOWN, safe-edit is CAUTION;
current source and focused validation are authority. No refresh for dirty files.

## Validation allowance

Parent owns serial native validation: one build plus one diagnosed correction,
one focused suite plus two diagnosed corrections, one compiled frozen
classification. Children run only scoped whitespace checks. Four ingestion
workers maximum, one Vitest worker; no detached jobs, installs or activation.
Verify original frozen hashes and preserve prior classification artifacts.
Compare accepted/refused sets against classification-06; diagnostics must not
change admission. Regression tests assert kind/location, error identity, bounded
metadata and no source leakage. Rollback only this slice's edits.

## Results

Native build exited 0; log `/opt/d1/tmp/ontoindex-capture-refusal-context-build.log`.
Initial six-suite run exited 1: 653 tests passed and one stale fixture failed.
`scope-unsupported-syntax-reason.test.ts` still expected ordinary methods to be
refused, although current member support accepts them. Diagnostic cases passed.
Selected correction replaces that fixture with an unsupported getter and asserts
the warning context. Reverting method support or deleting the test was rejected.
One of two correction-suite allowances is assigned; production code is unchanged.
Log: `/opt/d1/tmp/ontoindex-capture-refusal-context-tests.log`.

Compiled classification exited 0, verified all 43 original source hashes, and
preserved all accepted/refused file identities and accepted capture counts.
`eval/results/ontoindex-shared-pair-87x1w40f/capture-classification-07.json` records
15 accepted, 26 refused: first refusals are 19 interface declarations, four type
alias declarations, two as-expressions and one array. Every refusal now has a
node/location. This identifies first blockers, not all syntax required per file.

Correction suite exited 0: all 654 tests in six suites passed. Log:
`/opt/d1/tmp/ontoindex-capture-refusal-context-tests-correction-1.log`.
Commands from `ontoindex/`: build `ONTOINDEX_MAX_WORKERS=4 npm run build`;
tests `ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node
node_modules/vitest/vitest.mjs run test/unit/scope-resolution/typescript-captures.test.ts
test/unit/scope-resolution/typescript-type-only-module.test.ts
test/unit/scope-resolution/typescript-import-captures.test.ts
test/unit/scope-resolution/typescript-export-captures.test.ts
test/unit/scope-unsupported-syntax-reason.test.ts
test/integration/scope-retention-replay-parity.test.ts --maxWorkers=1`.

Scoped OntoIndex verify_diff passed for one production and two test files;
symbol scope was not checked. Scoped whitespace check exited 0; two files were
already untracked, so validation and source review supply their content evidence.
Budget used: one build, two suite runs (one stale-fixture correction), one frozen
classification. No further production edits followed the successful build.

Next bounded semantic candidate is mixed erased/runtime declaration composition:
23 first refusals are interfaces/aliases. It requires coordinated export handling
and explicit namespace/collision rules; counts do not predict whole-file admission.
Representative replay/performance, CLI/MCP and Linux qualification remain open.
Historical manager remains closed; no previous task or lease is reopened.
