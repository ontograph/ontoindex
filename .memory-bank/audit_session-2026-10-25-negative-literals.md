# Direct negative numeric literal capture

Date: 2026-10-25

Selected exact minus/number AST validation after two comparisons against general
unary traversal and retaining refusal. General traversal expands reference and
operator semantics; refusal preserves a known literal gap. The selected change
reuses the iterative expression owner, adds no dependency or schema, and rejects
unsupported operands atomically. Rollback is confined to this slice's unary
branch, assertion allowlist entry and associated tests, preserving earlier work.

The composer accepts direct negative numeric literals, including BigInt and
comments, and validates them through the existing const-assertion path. Unary
plus, identifier/call operands, nested signs and parenthesized arguments remain
refused. Bare standalone unary statements remain refused. No inference change.

Four Sol/Luna agents handled implementation, tests, independent source review and
classifier discovery. Children ran no validation commands. Production and tests
were frozen for parent validation.
Independent source review found no defect in the exact unary validation,
const-assertion routing or standalone-statement refusal.

## Validation

Native build exited 0. Evidence:
/opt/d1/tmp/ontoindex-negative-literals-build-1.log.
Command from ontoindex/: ONTOINDEX_MAX_WORKERS=4 npm run build.

Focused scope and replay tests exited 0: 1845 tests across 30 suites, 34.25s.
Evidence: /opt/d1/tmp/ontoindex-negative-literals-tests-1.log.
Command from ontoindex/: ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node
node_modules/vitest/vitest.mjs run test/unit/scope-resolution
test/integration/scope-retention-replay-parity.test.ts --maxWorkers=1.

Frozen compiled capture classification exited 0. All 43 source hashes and byte
counts matched; 41 TypeScript files produced 16 accepted and 25 refused outcomes.
Compared with classification09, src/lbug/schema-constants.ts became accepted.
This measures cumulative capture admission after arrays, objects, assertions and
negative literals; it does not isolate the contribution of negative literals.
Artifact: eval/results/ontoindex-shared-pair-87x1w40f/capture-classification-10.json.
Reproducible command: node eval/results/ontoindex-shared-pair-87x1w40f/classify-current.mjs.
The script refuses to overwrite the report. Input, source, test and compiled-owner
hashes are recorded. No replay or performance qualification is claimed.

OntoIndex freshness matched HEAD 2623820ec85113c28b238d5f72dde496e27426a1.
Bounded verify_diff passed the two edited source/test paths, with symbol scope
explicitly unchecked. OntoIndex stale/degraded: untracked composer absent from
committed graph; source inspection is authority. No reindex warranted by dirtiness.

## Remaining work

First refusal categories: 18 unlocated, three method_definition, one each
member_expression, for_statement, template_string and class_declaration.
Localize the unlocated refusals before selecting another syntax extension.
Complete replay, representative time/RSS and native Linux CLI/MCP qualification
for JS/TS/Python/C++/Rust remain open. Kotlin/Dart/Ruby/Windows remain postponed.

Approved budget consumed: 5/5 builds, 8/9 tests, 3/3 measurements. One test run
remains; further builds or measurements need a scoped amendment. Historical
structured manager is closed with no active task selected. This records bounded
slice evidence, not overall manager completion. No install, activation or commit.
