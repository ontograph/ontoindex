# Bounded const assertion capture

Date: 2026-10-25

Compared exact const assertions, template substitutions and recursive generic
annotations twice. Const assertions directly wrap frozen schema arrays and reuse
the current expression owner. Templates also need member reads in the frozen
fixture; generic annotations require a separate type-identity decision. Selected
const assertions for correctness, compatibility, bounded complexity and validation.
The change introduces no schema, dependency or recursive traversal.

The composer validates exact operand/as/const children and traverses supported
literal, array and static-object operands after unwrapping parentheses. General
assertions, direct nested assertion operands, identifier/call operands and wrapped
receivers/callees remain refused. Child arrays/objects may contain separate valid
const assertions. No readonly/literal-type inference is claimed.

Changed source/test files:

- ontoindex/src/core/ingestion/languages/typescript-captures.ts
- ontoindex/test/unit/scope-resolution/typescript-captures.test.ts

Four Sol/Luna discovery agents compared options; two Sol workers own disjoint
source/test edits. Independent source review found no defect. Children execute
no builds, tests or measurements. Rollback only this slice, preserving prior work.

## Validation

Native build exited 0: /opt/d1/tmp/ontoindex-const-assertions-build-1.log.
Command from ontoindex/: ONTOINDEX_MAX_WORKERS=4 npm run build.
Final scope/replay tests passed: 1837 tests in 30 suites, exit 0. Evidence:
/opt/d1/tmp/ontoindex-const-assertions-tests-1.log. Command from ontoindex/:
ONTOINDEX_MAX_WORKERS=4 ONTOINDEX_TEST_WORKERS=4 node
node_modules/vitest/vitest.mjs run test/unit/scope-resolution
test/integration/scope-retention-replay-parity.test.ts --maxWorkers=1.
Both edited files were frozen during the test run; production was frozen at build.
Tests assert exact references/ranges/scopes, arity, parser reuse and atomic refusal.
Bounded OntoIndex verify_diff passed file scope; symbol completeness was not checked.
Whitespace checks emitted no diagnostics; no Rust workspace exists for Rust fmt.

OntoIndex freshness matches HEAD 2623820. Committed context/impact cannot find
the untracked composer; workspace impact refuses workspace_too_large, 1832 files
over 1600. Source inspection is authority. No refresh was warranted by dirtiness.

## Remaining work

Frozen classification09 remains historical. Evidence-weights also needs negative
literals and later expression syntax; template/object-method/generic boundaries
remain. No corpus, performance, installation or activation result is claimed.
Complete replay/time/RSS and installed Linux CLI/MCP qualification remain open.

Budget after validation: 4/4 builds, 7/8 tests, 2/2 corpus/performance attempts.
Further builds or measurements require an explicit scoped budget amendment.
Historical structured manager remains closed; this is slice evidence only.

## Follow-up review

Read-only discovery selected direct negative numeric literals as the next bounded
candidate. Frozen evidence-weights.ts contains -0.02 and -0.15 at lines 33 and 58;
later member reads, binary conditions and subscripts remain separate blockers.
General unary traversal broadens semantics unnecessarily; retaining refusal
leaves the observed literal gap. Exact minus/number validation in the existing
walker is preferred, including a validated as-const operand path. Keep unary
plus, identifiers/calls, nested signs and standalone unary statements refused.
Nine negative-test entries need replacement; invalid range-coordinate tests stay.
Four discovery packets completed. One challenge packet inspected the separate
literal-type inference owner instead of capture admission; its implementation
recommendation was rejected as out of scope. Its result does not verify the
selected capture change. Recheck numeric/BigInt cases in focused validation.

No implementation or execution occurred in this follow-up. Proposed amendment:
one additional build, one additional test invocation and one frozen-corpus
classification attempt. Totals would become 5 builds, 9 tests and 3 measurements;
consumed counts remain 4, 7 and 2. Classification is not performance qualification.
The user's subsequent proceed authorizes this explicitly proposed increase.
Amended totals: 5 builds, 9 tests, 3 measurements; consumed before implementation:
4 builds, 7 tests, 2 measurements. Child execution allocations remain zero.
