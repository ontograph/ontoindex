# Inline TypeScript type-import capture

Date: 2026-10-25
Status: implemented; focused validation passed.

Selected scope: retain inline named and aliased type imports through the existing
TypeScript import emitter/interpreter with `namespace: 'type'`. Ordinary imports
retain their previous facts. Statement-level type-import erasure stays unchanged.

## Decision and challenge

Three alternatives were reviewed before editing:

| Option | Correctness and robustness | Cost, compatibility and validation |
| --- | --- | --- |
| Extend shared emitter/interpreter | Preserves type bindings and uses existing namespace filtering | One production file, no dependency/schema change; exact capture and resolution tests |
| Drop inline type specifiers | Loses binding and collision evidence; rejected | Less capture work but incomplete semantics; rollback would restore refusals |
| Separate type-import parser | Duplicates AST validation and permits call-path divergence; rejected | Additional traversal and maintenance; needs duplicate compatibility coverage |

Second review selected the shared owner. Recognize the unnamed leading `type`
token structurally, preserving identifiers named `type`. Refuse typed default or
quoted imports, `typeof`, attributes and malformed statements atomically. Validate
detached namespace metadata and positive ranges. Preserve conservative collision
handling and existing reexport semantics. No new execution, network or credential
surface is introduced. Rollback only this slice's edits; preserve prior dirty work.

At least four agents supplied bounded research, implementation, tests and challenge
using GPT Luna/Sol. Two development workers have disjoint production/test ownership.
The first implementation packet was rejected for missing a focused validation
command; the corrected packet assigns whitespace checking to the child and all
build/test execution to the parent. Rejection produced no code or test evidence.

Committed OntoIndex and HEAD match `2623820ec85113c28b238d5f72dde496e27426a1`.
The index excludes 442 dirty files. Committed import-interpreter impact is LOW;
source inspection supplies current-worktree evidence. Earlier emitter safety
review identified an exported API, requiring compatibility checks.

## Validation contract

Parent runs serial native commands: one build plus one diagnosed correction,
one focused suite plus two diagnosed corrections, and one frozen compiled
classification. Four ingestion workers maximum; Vitest has one test worker.
No detached jobs, containers, installation, release or default activation.

Focused suites cover import/composer/type-only/export captures, finalization,
reference resolution and retained replay parity. The frozen classification must
verify all source hashes and write a new artifact without replacing prior evidence.
Acceptance requires exact type facts and exclusion from runtime value resolution;
file acceptance may remain unchanged when later syntax is still unsupported.

## Results

Build `ONTOINDEX_MAX_WORKERS=4 npm run build` from `ontoindex/` exited 0.
Log: `/opt/d1/tmp/ontoindex-mixed-type-imports-build.log`.
Seven focused suites passed, 760 tests, exit 0, 27.66 seconds. Command from
`ontoindex/`: `ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node
node_modules/vitest/vitest.mjs run test/unit/scope-resolution/typescript-import-captures.test.ts
test/unit/scope-resolution/typescript-captures.test.ts
test/unit/scope-resolution/typescript-type-only-module.test.ts
test/unit/scope-resolution/typescript-export-captures.test.ts
test/unit/scope-resolution/finalize-algorithm.test.ts
test/unit/scope-resolution/resolve-references.test.ts
test/integration/scope-retention-replay-parity.test.ts --maxWorkers=1`.
Log: `/opt/d1/tmp/ontoindex-mixed-type-imports-tests.log`.

Independent final source review found no implementation blocker. It identified
coverage gaps in exact modifier ranges, all-inline imports and malformed detached
namespace metadata on named/alias imports. One bounded test-only correction is
completed by the existing test owner. The targeted rerun of
`test/unit/scope-resolution/typescript-import-captures.test.ts` using the same
Vitest command/options passed 47 tests, exit 0, 2.00 seconds. Log:
`/opt/d1/tmp/ontoindex-mixed-type-imports-tests-correction-1.log`.
No production edits followed the successful build or seven-suite run.

Scoped OntoIndex `verify_diff` passed for the one production and five test files.
Expected symbols were omitted, so this verifies file scope only. Scoped
`git diff --check` exited 0; untracked contents are covered by the executed tests.
Budget consumed: one build, initial seven-suite run, one targeted coverage
correction run, one classification. No correction build was needed.

Compiled frozen classification exited 0, verifying all 43 original source hashes.
Artifact: `eval/results/ontoindex-shared-pair-87x1w40f/capture-classification-06.json`.
Counts remain 15 accepted and 26 refused TypeScript files. Seven previously
import-blocked files now reach later unsupported module syntax. This slice removes
an import prerequisite without establishing full representative replay acceptance.

Historical structured manager remains closed; no historical task or lease is
reopened by this bounded continuation. Representative replay timing/RSS, public
CLI/MCP, required-language Linux installation and default activation remain open.
