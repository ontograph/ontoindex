# Lexical declaration export capture

Date: 2026-10-22
Status: In progress
Authority: User request to select robust fixes and proceed; named declaration exports accepted

## Goal

Ordinary top-level export const and export let resolve canonical module bindings.

## Current validation evidence

2026-10-23 challenger validation allocation: registered challenger requires its
own command execution. Parent authorizes exactly one additional focused
export/declaration suite and one additional TypeScript no-emit run, serial
foreground, as necessary independent validation under the user's stages 1-6
instruction. Parent's one suite/one typecheck remain consumed. Current-scope
allocation totals two suites and two typechecks; challenger owns the remaining
one of each. Export files remain unchanged; disjoint provider test writers have
finished and no competing validation is active. Preserve previous unknown usage.

2026-10-23 real-provider fixture parity: two Sol-medium developers extended only
parse-worker-scope-integration.test.ts and parse-impl-fallback.test.ts. Production
hooks remain absent. Clones exercise current capture/import/export/binding hooks
for TS, TSX, JS and JSX. Sequential and crashed-worker fallback preserve direct
extraction parity, borrowed-root parser counts, detached captures, failure
outcomes and input identity. Retention distinguishes failed files from complete
successful files while seedReady remains false. Foreground suites passed 82
tests, two files, exit 0 (6.58s); TypeScript no-emit exited 0. Dedicated packet
usage: one of two suites and one of one typecheck; children ran none. Explicit
file OntoIndex verification passed with symbol scope skipped. Live impact was
workspace_too_large; current source is authority. This provides fixture parity,
not production provider activation or worker-thread runtime proof.

2026-10-23 current-export baseline validation after scope amendment: coordinator
ran export/declaration suites in the foreground; 240 tests passed, two files,
exit 0 (1.35s). TypeScript no-emit exited 0; scoped whitespace exited 0.
Export source/test SHA256 remained equal to the declared current baseline after
validation. Current-scope allowance consumed one of two suites and one of one
typecheck. This is fresh execution evidence for the manager's accepted
NEEDS_REWORK gate; it does not authenticate the original implementation history.

2026-10-23 braced-conditional packet: selected explicit if shape validation over
arbitrary AST traversal and immediate provider activation after two reviews.
Two Sol-medium developers owned composer and tests separately; independent Luna
and Sol research covered capture gaps and integration owners. Function-body if
statements accept supported literal, identifier and call/constructor conditions,
with braced consequence and optional braced else. Existing iterative traversal
preserves condition/branch preorder, branch lexical scopes and function-wide
canonical var bindings. Unbraced branches, else-if and unsupported conditions or
siblings refuse atomically. Foreground composer/reference validation passed:
256 tests, two files, exit 0 (5.16s); TypeScript no-emit exited 0. Budget used:
one of two suite runs, one of one typecheck; children ran none. Explicit-file
OntoIndex verification passed with symbol scope skipped. Committed impact could
not resolve appendFunctionBodyReferences; source inspection is authority.

The authenticated lexical challenger receipt
role-result-103cc47a38ff63b9e83bda06c8cb7e5707a7dc6b107d29e2cb5ca6d8753e2536
was integrated as NEEDS_REWORK. Its recorded blocker is scope drift between the
original const/let packet and subsequent var/generator/abstract export work.
The runtime classification says compile/test failure; no actual failed compiler
or test output was supplied to this coordinator. Independent current-source
review found no concrete export defect, but does not replace authenticated
acceptance. Preserve current implementation and establish a current baseline
for full review rather than reverting later features or claiming closure.

2026-10-23 identifier-initializer packet: compared direct existing read-helper
dispatch, general expression traversal and blanket identifier scanning twice;
selected direct dispatch for exact syntax classification without another tree
scan. Four agents participated, including two Sol-medium developers with
separate source and test ownership. Direct/grouped identifier initializers now
emit detached read captures across TS, TSX, JS and JSX. Tests cover module and
export declarations, multiple declarators, imported/unresolved/Unicode names,
NaN/Infinity grammar identity, self reads, nested scopes, canonical var bindings
and parser reuse. Undefined and unsupported member expressions still refuse.
Foreground composer/reference suites passed: 236 tests, two files, exit 0
(5.38s); TypeScript no-emit exited 0. Used one of two suite runs and one of one
typecheck; children ran none. Final explicit-file OntoIndex verification passed
with symbol scope skipped. The committed index matches HEAD, but these files
are untracked and validateDeclaration is absent from that index; source
inspection is authority. Provider integration, graph resolution and large
dirty-workspace acceptance remain open. Manager state unchanged.

2026-10-23 identifier-argument packet: selected existing stack traversal over
separate collection/sorting and generic expression traversal after two reviews.
Identifiers are emitted on stack pop, preserving interleaved call/read preorder
without another tree scan. Two Sol-medium developers owned composer and tests;
two read-only agents reviewed design and refusal boundaries. Four-grammar tests
cover free/member/constructor arguments, grouping, Unicode/unresolved names,
arity, scopes, ranges and parser reuse. Unsupported sibling expressions and
standalone identifier initializers were outside that packet. Foreground composer/reference
suites passed: 228 tests, two files, exit 0 (5.28s); TypeScript no-emit exited 0.
Used one of two suite runs and one of one typecheck; children ran none.
Explicit-file OntoIndex verification passed with symbol scope skipped; impact
was UNKNOWN/not-in-index, so current source is authority. Provider integration,
graph resolution and workspace acceptance remain open. Manager state unchanged;
no build, installation or release.

2026-10-23 identifier-return packet: compared return reads, braced conditional
traversal, and dependency-only imports twice; selected existing read semantics
with one detached capture per returned identifier and no additional tree scan.
Two Sol-medium developers owned source and tests; two read-only reviewers
challenged scope and downstream claims. Direct/grouped identifier returns now
preserve exact ranges, innermost scope, and unresolved usage facts without call
metadata. Unicode, shadowing, parser reuse, range isolation and unsupported
expressions are covered across four grammars. Foreground composer/reference
suites passed: 220 tests, two files, exit 0 (3.00s); TypeScript no-emit exited 0.
Validation waited for another session's full suite to finish. Used one of two
suite runs and one of one typecheck; children ran none. Explicit-file OntoIndex
verification passed with symbol scope skipped; committed impact was UNKNOWN,
not-in-index. Source remains authority. Whitespace check exited 0. Capture and
extraction are verified; provider activation and end-to-end graph resolution
remain open. Manager state unchanged; no build, installation or release.

2026-10-23 nested-block packet: selected explicit iterative DFS over recursion
and shared traversal infrastructure after two bounded reviews. Two Sol-medium
developers owned composer and tests separately. Plain blocks inside supported
function bodies retain lexical scope and source order; only the root body is
seeded with parameter names. One function-wide var batch preserves ancestor
collision checks and canonical bindings. Final foreground validation: 314 tests
across composer/declaration suites passed (exit 0, 5.32s); TypeScript no-emit
passed (exit 0). Depth-128 nesting, detached capture reuse, legal shadowing and
invalid ancestor collisions are covered. Used one of two suite runs and one of
one typecheck; children ran none. Committed impact remains UNKNOWN/not-in-index;
current source is authority. Control flow, nested functions, broader capture
completeness and provider/runtime integration remain open. Manager state is
unchanged; no release or install performed.

2026-10-23 direct function-body binding packet: selected composer reuse over
shared binding-selector changes and recursive body traversal after two bounded
reviews. Two Sol-medium developers owned source and tests separately. Direct
let/const/var declarations reuse initializer validation and per-body var batching.
Locals retain body Block ownership; var binds in Function scope and lexical
bindings remain in Block scope. Lexical duplicates and parameter collisions
refuse; parameter/var reuse and module/import shadowing remain valid. Final
foreground validation: composer/declaration suites passed 302 tests (exit 0,
2.97s); TypeScript no-emit check passed (exit 0). Used one of two suite runs and
one of one typecheck; children ran none. OntoIndex supplied-file verification
passed with symbol scope skipped; composer impact was UNKNOWN/not-in-index and
workspace preparation refused 1832 files against a 1600 cap. Nested statements,
broader capture completeness, provider activation and runtime acceptance remain
open. Authenticated manager state is unchanged.

2026-10-23 default-plus-empty import packet: allow an empty named list only
when a preceding default identifier already retains the dependency. Compared
dependency-only schema expansion and body-local declarations; both need broader
consumer or binding contracts. Two read-only reviewers and two Sol-medium
developers covered disjoint scopes. Source change is one existing-owner guard;
four-grammar tests verify exact captures, parser detachment, composer calls,
duplicate imports and declaration collisions. Final validation: 184 tests across
import/composer suites passed (exit 0, 1.90s); TypeScript no-emit check passed
(exit 0). Used one of two suites and one of one typecheck, serial foreground;
children ran none. Committed impact LOW; supplied-file verification passed with
symbol scope skipped. Whitespace checks had no diagnostics; untracked composer
test check returned expected diff exit 1. Standalone empty/side-effect imports
still refuse. Next substantive design: body-local binding/hoisting or a shared
dependency-only import contract. Provider and runtime acceptance remain open.

2026-10-23 optional-parameter packet: selected untyped optional identifiers via
the existing binding helper over typed signatures and body-local declarations.
Two read-only reviewers and two Sol-medium developers covered separate scopes.
Composer accepts exactly one unnamed question mark and preserves annotation,
default, rest, destructuring and duplicate refusal. First suite: 138 passed,
two failed (exit 1) because the complex commented Unicode positive fixture had
a parser error. Simplifying that fixture preserved the strict parser gate.
Final suite: 140 passed (exit 0, 1.69s). TypeScript no-emit check passed (exit 0)
before the final fixture-only correction. Used two of two suites and one of one
typecheck, foreground; children ran none. OntoIndex impact UNKNOWN/not-in-index;
supplied-file verification passed with symbol scope skipped. New-file whitespace
checks emitted no diagnostics (exit 1). Provider integration, broader captures
and runtime workspace acceptance remain open; manager state is unchanged.

2026-10-23 return-statement packet: selected restricted bare/literal/call/new
returns over optional parameters and body declarations after two read-only
reviews. Two Sol-medium developers owned separate source/test files. Existing
call traversal preserves ranges, preorder and body Block ownership. First suite:
132 passed, two failed (exit 1), exposing TS/TSX attachment of return values across
multiline comments. Parent added explicit refusal of that ambiguous AST shape;
test owner covered the grammar difference. Final suite: 138 passed (exit 0,
1.68s); TypeScript no-emit check passed (exit 0). Used two of two focused suites
and one of one typecheck, serial foreground; children ran none. OntoIndex impact
was UNKNOWN/not-in-index; supplied-file verification passed with symbol scope
skipped. New-file whitespace checks had no diagnostics (exit 1 for new files).
General return expressions, provider integration and runtime acceptance remain
open. Authenticated manager state is unchanged.

2026-10-23 function-body call packet: share the existing expression-statement
validator between module and ordinary/generator bodies. Typed parameter expansion
needs type-reference review; general body traversal needs declaration and nested
scope semantics. Selected narrow calls reuse current reference capture and scope
owners with linear traversal, local rollback, and no provider activation.
Second review requires body Block identity, parameter-parent visibility, source
preorder, no duplicate references, and whole-file refusal for unsupported body
syntax. Two read-only reviewers and two Sol-medium developers cover disjoint
scopes. Parent allowance: two focused suites and one typecheck, foreground;
children run none. Impact UNKNOWN/not-in-index. Final validation after both
writers confirmed no further edits: 118 focused composer tests passed (exit 0,
1.49s); TypeScript `--noEmit --incremental false` passed (exit 0). Used one of
two suites and one of one typecheck, serial foreground. OntoIndex supplied-file
scope passed with symbol scope skipped. New-file whitespace checks emitted no
diagnostics (exit 1). Capture completeness, provider integration and runtime
workspace acceptance remain open; authenticated manager state is unchanged.

2026-10-23 parameter-composition packet: reuse the existing parameter helper
with a composer-only identifier gate for empty ordinary functions and generators.
Independent capture construction duplicates validation; broader function-body
activation requires unresolved scope support. Second review requires parameter
captures to enter after module collision checks, preserving legal shadowing and
Function ownership. Two discovery reviewers and two Sol-medium developers cover
disjoint scopes. Parent allowance: two focused suites and one typecheck, serial
foreground; children run none. First suite: 101 passed, nine failed, exit 1.
Failures are test ownership assumptions: existing extraction owns the function
declaration in Function scope while binding its name in Module scope. Test-only
correction round one preserves this contract and filters parameter identity
assertions to variable definitions. Final suite: 110 passed, exit 0, 1.34s;
TypeScript `--noEmit --incremental false`: exit 0. Both writers confirmed no
further edits before validation. Used two of two suites and one of one
typecheck. OntoIndex supplied-file verification passed with symbol scope
skipped. New-file whitespace checks emitted no diagnostics (exit 1).
Authenticated manager state and provider activation remain unchanged.

2026-10-23 parenthesized-expression packet: select local iterative unwrapping
at argument, initializer and top-level expression classification. Duplicated
loops risk validation drift; global AST normalization broadens compatibility
and may alter callee semantics. Second review requires exact wrapper shape,
original node identity for structural checks, inner-call ranges, and unchanged
refusal of wrapped identifiers, sequences, unsupported callees and top-level
literals. Two reviewers and two Sol-medium developers own disjoint scopes.
Parent allowance: two focused suites and one typecheck, foreground; children
run none. Impact UNKNOWN/not-in-index. Authenticated manager state and provider
activation remain unchanged.

Parenthesis validation: 98 focused composer tests passed (exit 0, 1.30s);
TypeScript `--noEmit --incremental false` passed (exit 0). Both developers
confirmed no further writes before validation. Used one of two suites and one
of one typecheck, foreground. Grouped and ungrouped fixtures preserve inner
call ranges, preorder, declaration/export identity, depth-128 traversal and
parser-reuse detachment. Unsupported wrapped expressions still refuse.
OntoIndex supplied-file scope passed with symbol scope skipped; untracked-file
whitespace checks returned exit 1 without diagnostics. Capture completeness,
provider activation and production workspace acceptance remain open.

2026-10-23 call-initializer packet: reuse one local iterative call traversal for
expression statements and direct/exported identifier let/const/var initializers.
Duplicate traversal risks validation drift; whole-file scanning broadens scope
and requires extra filtering. Second review preserves statement/declarator
preorder, every repeated-var initializer, canonical bindings and atomic refusal
of unsupported nested arguments. Two read-only reviewers and two Sol-medium
developers cover disjoint source/test scopes. Parent allowance: two focused
composer suites and one typecheck, serial foreground; children run none.
Impact for composer and declaration validator is UNKNOWN/not-in-index.
Authenticated manager state and provider activation remain unchanged.

Call-initializer validation: 94 focused composer tests passed (exit 0, 1.24s);
TypeScript `--noEmit --incremental false` passed (exit 0). Both developers
confirmed no further writes before validation. Used one of two suites and one
of one typecheck, foreground. Tests cover four grammars, exact reference order
and ranges, direct/exported declarations, canonical repeated-var bindings,
atomic refusals and parser-reuse detachment. OntoIndex supplied-file scope
verification passed with symbol scope skipped. New-file whitespace checks
returned exit 1 with no diagnostics. Capture completeness, provider parity and
large dirty-workspace acceptance remain open.

2026-10-23 nested-call composition packet: explicit stack visits supported
call/new arguments once in parent-first, left-to-right order. Reuse the existing
single-call emitter; leaves remain literals. Recursive traversal adds avoidable
call-stack depth risk; whole-file scanning widens traversal and needs separate
validation. Second review requires unsupported nested arguments to reject the
whole input and preserves statement/declaration restrictions. Two reviewers and
two Sol-medium developers own disjoint source/test scopes. Parent validation:
at most two focused suites and one typecheck, foreground; children run none.
Impact UNKNOWN/not-in-index. Existing authenticated state remains unchanged.

Nested-call validation: 82 focused composer tests passed (exit 0); TypeScript
`--noEmit --incremental false` passed (exit 0). Both workers confirmed no further
writes before validation. Used one of two suites and one of one typecheck,
foreground. Coverage includes exact preorder/ranges across four grammars,
comments, nested constructors, unsupported sibling orders, parser reuse and a
128-level chain. This is structural capture order, not execution order or a
performance benchmark. Bounded OntoIndex file-scope verification passed with
symbol scope skipped. New-file whitespace checks emitted no diagnostics
(no-index exit 1). Capture completeness and provider/runtime gates stay open.

2026-10-23 top-level reference composition packet: reuse selected-node reference
capture for free/member/constructor expression statements with zero or literal
arguments. A whole-file scan widens selection; provider activation requires
capture completeness. Second review requires rejecting nested/nonliteral
arguments to avoid silently omitted references. Two read-only reviewers and
two Sol-medium developers cover disjoint source/test scopes. Allow two focused
composer suite runs and one typecheck, foreground; children run no validation.
Impact UNKNOWN/not-in-index; current source is authority. Authenticated manager
state and provider activation remain unchanged.

Reference composition validation: 68 focused tests passed twice (exit 0 each).
The first launch overlapped the test worker's final generic-call refusal edit;
the second ran after its explicit no-more-writes confirmation. TypeScript
checking ran after that confirmation and passed (exit 0). Used two of two suite
runs and one of one typecheck, all foreground. Exact module reference records,
unchanged bindings/imports/exports, detached parser-reuse captures, and atomic
unsupported-input refusal are covered across four grammars. OntoIndex supplied
file-scope verification passed with symbol scope skipped. No-index whitespace
checks returned 1 for new-file differences with no whitespace diagnostics.
Remaining capture families and production provider/runtime acceptance stay open.

2026-10-23 duplicate-local packet: select a linear composer-local Set check
for non-var declaration names. Shared-selector rejection affects parameter and
merge consumers; full script/module redeclaration semantics expands the strict
module subset. Second review preserves repeated var and existing mixed-var
collision validation. Two read-only reviewers (Luna/Sol) and two Sol-medium
developers cover source and tests with disjoint write sets. Parent allowance:
two focused composer suites and one typecheck, foreground only; child allowance
zero. Impact is UNKNOWN/not-in-index; current source is authority. Existing
authenticated manager state remains unchanged.

Duplicate-local validation: 60 focused composer tests passed (exit 0); TypeScript
`--noEmit --incremental false` passed (exit 0). Used one of two suite invocations
and one of one typecheck, foreground. Tests cover ordered non-var declaration
pairs, export wrappers, lexical duplicates within a statement, an explicit
import module, and repeated-var canonical identity across all four grammars.
Bounded OntoIndex file-scope verification passed; symbol scope was skipped.
Capture completeness, provider parity and large dirty-workspace acceptance
remain open. No production provider was activated by this packet.

2026-10-23 var composition packet: reuse selected-node batch capture in the
composer for direct/exported top-level identifier var declarations with literal
or absent initializers. Shared collision caches avoid per-declaration module
scans. Whole-tree traversal widens selection unnecessarily; composer-owned
canonicalization duplicates existing binding rules. Reviewers confirmed earliest
var binding selection and preservation of every declaration definition.
Keep declaration order, import collisions, duplicate export rejection and strict
initializer validation. No nested syntax, provider or shared helper changes.
Two read-only reviewers and two Sol-medium developers cover this packet.
Parent validation allowance: two focused suite runs and one typecheck, serial
foreground commands; child validation allowance zero. OntoIndex impact is
UNKNOWN/not-in-index. Authenticated manager gates remain unchanged.

Var packet first suite: 48 passed, four failed (exit 1). New duplicate-export
tests asserted rejection at capture emission, but the existing export interpreter
owns this check during extraction (`exports.has`). Correction round one changes
only that test assertion to exercise full extraction. Collision assertions stay
at emission. One of two suites consumed; typecheck remains unconsumed.

Var packet final validation: corrected focused suite passed 52 tests (exit 0),
TypeScript checking passed (exit 0). Total consumption: two of two suites and
one of one typecheck, all foreground. Independent batch review found no defect;
bounded OntoIndex verification passed supplied file scope with symbol scope
skipped. Provider activation and the remaining workspace roadmap stay open.

2026-10-23 import-binding collision packet: the composer validates import and
declaration families separately. Select a linear guard over existing detached
capture names to reject duplicate imported locals and import/declaration
intersections. A shared extractor change risks other language binding policies;
an AST rescan duplicates the import emitter. Both alternatives add scope.
Two discovery reviewers confirmed the gap; two Sol-medium developers own the
composer and tests separately. Preserve the existing syntax subset, including
side-effect import rejection. No provider activation or var syntax expansion.
Validation allowance: two focused suites and one typecheck, foreground only.
OntoIndex impact returned UNKNOWN/not-in-index; source inspection is authority.
This packet does not change authenticated task or receipt state.

Import-collision packet validation: focused composer suite passed 44 tests
(exit 0); TypeScript `--noEmit --incremental false` passed (exit 0).
Consumption: one of two suites and one of one typecheck. New cases cover all
four grammars, both statement orders, exported declarations, default/aliased/
namespace collisions, duplicate imported locals and distinct-alias controls.
Bounded OntoIndex verification passed the supplied two-file scope; symbol scope
was explicitly skipped. Source review found no additional supported-form gap.
Capture completeness, provider parity and production workspace acceptance stay
open; this composer-only repair does not establish them.

2026-10-23 literal-binding integration packet: extend the composer with direct
and exported identifier let/const declarations whose values are number, string,
boolean or null literals; uninitialized let is accepted. Require const values
even when the grammar accepts their absence. Number syntax includes BigInt and
separators; strings are not decoded. Reject annotations, destructuring and
nonliteral expressions before returning captures. Reuse the lexical emitter.
The AST allowlist is selected over text matching or unrestricted initializers;
the latter can omit references. Function bodies and provider activation remain
deferred pending their complete semantics and parity evidence.

Two Sol-medium developers own the composer and its test separately. Validation
allowance for this packet: two focused suite invocations and one TypeScript
check, foreground only. OntoIndex impact for the untracked composer returned
UNKNOWN/not-in-index; direct source found only its unit-test callers.

Literal-binding packet completed: parent foreground focused suite passed 32
tests (exit 0), TypeScript checking passed (exit 0). Consumption: one of two
suites and one of one typecheck. Independent source review found no defect.
Tests cover canonical bindings/export aliases, literal forms, zero references,
detachment and mixed unsupported declarators in both orders. Grammar-valid
const declarations without initializers refuse explicitly. Bounded OntoIndex
verification passed supplied file scope, with symbol scope skipped. New-file
whitespace checks emitted no diagnostics (no-index exit 1). Production provider
activation and large-workspace acceptance remain open.

2026-10-23 composition follow-up: the next integration prerequisite is an
explicit whole-file acceptance boundary. Immediate provider activation can
silently omit syntax; shared completeness metadata would expand the contract.
The selected two-file change composes existing helpers for static imports,
empty named functions/generators/classes and local exports, rejecting all other
syntax atomically. Header and body checks are required because declaration
helpers validate names rather than full declaration semantics. Fixed traversal
passes preserve linear work for the admitted subset. Provider activation remains
gated; this helper does not establish workspace navigation availability.

Source and tests have separate Sol-medium owners. This packet permits two
focused suite invocations and one parent TypeScript check, all foreground.
Authenticated lexical task state below is unchanged.

The composer and four-grammar extraction tests are implemented in
`ontoindex/src/core/ingestion/languages/typescript-captures.ts` and
`ontoindex/test/unit/scope-resolution/typescript-captures.test.ts`.
Parent foreground Vitest passed 20 tests (exit 0); parent TypeScript checking
passed (exit 0). Consumption: one of two focused suites, one of one typecheck.
Independent source review found no blocking defect. Bounded OntoIndex
verification passed supplied file scope; symbol scope was skipped. New-file
whitespace checks emitted no diagnostics (no-index exit 1 denotes new content).
Remaining work: extend the explicit accepted syntax, establish provider path
parity, then CALLS/SEED and large dirty-workspace acceptance. No provider,
shared schema, build, installation, or index mutation accompanied this packet.

Parent foreground validation passed on 2026-10-23: the export/declaration
capture suite passed 211 tests in two files; `tsc --noEmit --incremental false`
and the two-file whitespace check exited 0. Consumption is one of two suite
attempts and one of one typecheck. Validation used the live checkout, without
immutable pre-run input hashes. The unchanged post-run source digest is
`14ed583191ae00f16d82293543e40187c9a85a93e036ce4037d60f9c5172fd9f` and test digest is
`c4ed5c0cc0f317c1aefc9a03fd6b0e2a0532f8506df9d1b0d56c9d31513a8f35`.

Independent source review found no defect in lexical export capture, atomic
refusal, or detached ranges. Authenticated challenger acceptance remains open;
these parent results do not replace its receipt. A separately scoped follow-up
repairs the declaration helper's missed collisions behind export wrappers.
That follow-up changes a consumed dependency and requires its own validation.

The follow-up now unwraps export declaration fields in the existing cached var
collision scan. Alternatives were a duplicate collision pass and rejection only
in shared extraction; both widen ownership or duplicate work. Independent review
confirmed scope boundaries and cache complexity remain unchanged. Four-grammar
regressions failed before the fix (eight failures, 134 passes), then all 142
declaration tests passed. The parent subsequently ran 77 export tests and
`tsc --noEmit --incremental false`; both exited 0. These are separate follow-up
checks on the changed helper, not a repeat of the lexical task's exhausted
typecheck allowance. No background command, build, install or reindex ran.

Ordinary `export var` is implemented in the export helper using the existing var
validator and detached lexical-export mapping. Independent Sol-medium review
selected reuse over duplicate parsing or shared-extractor changes. Four-grammar
tests cover earlier canonical redeclarations, Unicode identifier ranges,
independent mutation, parser reuse, duplicates, malformed declarations,
destructuring and lexical collisions. The baseline run failed eight new tests
with 218 passing; the same focused export/declaration suite then passed all 226.
The parent typecheck and scoped whitespace check exited 0. Commands ran in the
foreground; no builds, installs or reindexing ran. OntoIndex verified the supplied
two-file scope; symbol scope was skipped and live impact remained unavailable.

File-level export batching now shares collision validation across selected var
declarations with invocation-local caches and a same-tree guard. Standalone
emission remains compatible. Whole-file var collection was rejected because it
would validate unrelated nested declarations; persistent caches risk stale tree
identity. Four bounded reviewers included two Sol-medium reviewers. The worker
reported two focused foreground suite runs: nine failures/226 passes before the
implementation, then 235 passes with exit 0. Parent typecheck and scoped whitespace
validation exited 0. Deterministic tests at 16 and 64 exports assert two module
child reads per invocation (enumeration plus collision collection), fresh caches,
detached output and atomic refusal. Independent landed-source review found no
concrete defect. OntoIndex supplied-file verification passed with symbol scope
skipped; live impact refused workspace preparation at 1832 files versus 1600.
The new batch API is not yet connected to the production provider, and individual
calls still repeat validation. No end-to-end speedup is claimed. Remaining capture semantics,
provider parity, CALLS, SEED and large-workspace runtime acceptance remain open.
These follow-up results do not mark the historical authenticated lexical gate DONE.

Named synchronous and asynchronous generator exports now reuse the existing
named-declaration export branch. Existing declaration and scope owners already
represent their canonical module bindings. Routing all exports through the
declaration helper or introducing a shared kind registry would add complexity
without different semantics. Four reviewers examined the bounded choice,
including Sol-medium development and landed-source review. The two-file change
adds four-grammar identity, shadowing, alias, batch parity, detached-range,
duplicate and default/malformed refusal coverage. Worker foreground validation
failed four new cases with 233 passing, then passed all 237 tests; parent
typecheck and scoped whitespace checks exited 0. OntoIndex supplied-file scope
verification passed with symbol checking skipped. No production provider
activation or runtime-navigation claim follows from this capture-layer result.

Named abstract class exports now reuse the named-declaration branch in TS/TSX.
The existing declaration and scope owners supply canonical class identity.
Alternatives were routing through the declaration helper and introducing a
shared declaration-kind registry; both broaden ownership without improving this
bounded case. Second review identified direct class decorators as an unsupported
edge case, retained behind explicit refusal. Default, ambient, anonymous,
malformed and JS/JSX abstract-class exports also remain rejected.

Four bounded agents contributed discovery and review, including two Sol-medium
agents during development. Worker foreground validation first reported two
failures and 238 passes, then 240 passes with exit 0 in the export/declaration
suite. Parent harvested `tsc --noEmit --incremental false` with exit 0 and checked
the restored, tested decorator predicate directly. Independent landed-source
review found no concrete defect; that reviewer did not rerun tests. OntoIndex
verification of the two supplied files returned PASS with symbol checking
explicitly skipped. Live workspace impact remained unavailable at 1832 files
against the 1600 cap; source inspection is authority. These capture-layer checks
do not close provider integration, runtime acceptance or the historical
authenticated challenger gate. No background command, build, install or reindex
was launched for this follow-up.

## Reference capture follow-up

Ordinary identifier-call reference capture is the selected next code packet.
Immediate provider activation risks reporting complete extraction with missing
references. Named reexports require separate cross-file resolution work. A
borrowed-node call helper can reuse the existing reference pass without changing
the shared schema or provider registration. Four bounded reviewers assessed the
choice, with Sol-medium implementation and independent development review.

The write set is the new `typescript-reference-captures.ts` language helper and
its matching scope-resolution unit test. Acceptance covers four grammars,
detached call/name/arity captures, scope placement and parser reuse. Optional,
member, dynamic, generic and spread calls remain explicit refusals when selected;
argument holes must not be confused with valid trailing commas. Validation is
bounded to two focused suite invocations and one parent typecheck, serially in
the foreground. This separate
packet does not modify the historical lexical task's authenticated state.

The helper and tests are implemented. The worker ran the reference/export suite
twice: four fixture failures and 104 passes, then 108 passes (exit 0) after
correcting the malformed-input fixture. The helper was unchanged between runs.
The malformed `local(` input produces an error node rather than a call node;
the final fixture asserts parse error and rejection of that selected error node.
Parent TypeScript validation (`tsc --noEmit --incremental false`) exited 0.
Independent source review found no concrete defect. The helper checks immediate
children without recursively rescanning nested calls; no runtime speedup was
measured. OntoIndex supplied-file verification passed with symbol scope skipped.
Budgets consumed: two of two focused suites and one of one typechecks. No
provider activation, build, install or reindex was performed. Remaining capture
families and provider/worker/fallback parity precede runtime acceptance.

## Constructor reference follow-up

The next bounded packet extends the same reference helper for ordinary
`new Identifier(args)` expressions. Constructor captures reuse argument
validation and the extractor's existing constructor call form. Member calls
require receiver semantics; whole-file composition requires more complete
capture coverage. A separate constructor API would duplicate validation, while
a shared normalizer would add unnecessary scope. Keep the existing helper.

Second review retains explicit parentheses: argumentless `new Identifier` is
valid syntax but has no argument-list range under this capture contract.
Qualified, computed, dynamic, generic and spread constructors remain refused.
Only the reference helper and its matching unit test may change. Validation
allowance is two reference/export suite invocations and one parent typecheck,
all serial foreground commands. Provider registration and historical task gates
remain unchanged.

Constructor captures are implemented in the existing reference helper. Four
discovery reviewers assessed alternatives; Sol-medium implementation and
independent landed-source review completed without concrete findings. The worker
ran the reference/export suite once: 116 tests passed, exit 0. Parent
`tsc --noEmit --incremental false` exited 0. Supplied-file OntoIndex verification
passed with symbol scope explicitly skipped; workspace impact remains unavailable
at the 1600-file cap. Consumption: one of two suites and one of one typechecks.
The constructor branch reuses immediate-child validation without a recursive
subtree scan. Tests cover four grammars, detached ranges, parser reuse, scope,
arity, nested free calls and unsupported forms. Provider integration and runtime
navigation remain open; no build, installation or reindex ran.

## Member reference follow-up

The selected packet captures ordinary `identifier.property(args)` calls in the
existing reference helper and matching tests. Reuse the established member
anchor, explicit receiver and argument validation. Argumentless constructors
need a separate arity-range decision; whole-file composition still needs capture
completeness. A strict member branch avoids a duplicate API or shared normalizer.

Second review requires exact object/property kinds and an ordinary dot, rejects
optional access and optional calls, and preserves qualified-constructor refusal.
Computed/private/chained/dynamic receivers, `this`, `super`, generic calls and
spread arguments remain unsupported. Receiver capture records usage identity;
successful target resolution still depends on type bindings. The allowance is
two focused reference/export suites and one parent typecheck, serial foreground
commands. Provider registration and historical authenticated states stay unchanged.

Implemented and independently reviewed by Sol-medium agents with no concrete
findings. The worker's single focused reference/export suite passed 124 tests
(exit 0); the parent foreground `tsc --noEmit --incremental false` exited 0.
Consumption: one of two suites and one of one typechecks. Tests cover all four
grammars, receiver metadata, detached ranges, parser reuse, scope, arity, nested
calls and unsupported forms. Validation uses immediate children without an
additional recursive scan. OntoIndex supplied-file verification passed for the
two assigned files with symbol scope explicitly skipped. Both untracked files
had no whitespace diagnostics (`git diff --no-index --check`, exit 1 for file
differences). Provider integration and runtime workspace acceptance remain open.

## Argumentless constructor follow-up

Support ordinary identifier constructors without parentheses in the existing
reference helper and its tests. Preserve known zero arity using the constructor
identifier's real range and an independent capture object. Omitting arity loses
known resolution information; extending the shared schema adds unnecessary
compatibility and validation work. Whole-expression metadata ranges are also
valid, but the identifier gives the narrowest existing source anchor.

Second review confirms arity metadata is excluded from anchor selection and its
text supplies the count. Only constructors may omit arguments. Present malformed
lists, generic and qualified targets retain explicit refusal. No provider or
shared schema changes are included. Budget: two focused reference/export suites
and one parent typecheck, all foreground and serial. Historical manager gates
remain unchanged.

Argumentless constructor implementation completed in the reference helper and
its tests. Final worker suite: 128 passed, exit 0; first suite: 126 passed and
two failed due to a malformed parser-recovery fixture, replaced with valid
nested-constructor syntax. Parent foreground typecheck exited 0. Budget consumed:
two of two focused suites and one of one typecheck. Independent Sol-medium
source review found no concrete defects. Whole-file composition must reject root
parse errors; this helper validates only the selected node. Supplied-file
OntoIndex verification passed with symbol scope skipped. Both code files had
no whitespace diagnostics (no-index check exit 1 denotes file differences).
Provider activation, shared schema and authenticated manager state are unchanged.

## File call collection follow-up

Add a file-level call/new collector to the existing reference helper and tests.
Prefer one iterative cursor traversal with existing selected-node validation over
adding syntax first or activating incomplete providers. Keep output local until
all selected nodes pass, reject malformed roots, and traverse nested calls.
Track type-query context so type-only call aliases cannot become runtime calls.
Ordinary type queries without calls remain valid. This collects the supported
call/new subset and does not establish complete reference coverage.

Scope: the reference helper and its unit test only. No shared schema or provider
activation. Budget: at most two focused reference/export suites and one parent
typecheck, serial foreground commands. Historical manager gates remain unchanged.

Implemented the file collector with iterative preorder traversal and balanced
type-query context. Final focused suite: 138 passed, exit 0. First suite:
136 passed and two failed because a generic type-query fixture was malformed;
replaced with a valid type-query call. Parent foreground typecheck exited 0.
Consumed two of two suites and one of one typecheck. Supplied-file OntoIndex
verification passed with symbol scope skipped; both code files had no whitespace
diagnostics (no-index check exit 1 denotes differences). Production integration
and complete reference coverage remain open.
Independent Sol-medium review found no concrete defects in preorder traversal,
type-query context exit, atomic refusal or the four-grammar tests.

## Import boundary regression follow-up

Review found no contextual-name defect: ordinary `type` names are named
identifiers, while modifier tokens are unnamed. Preserve the production owner.
Prefer focused regression coverage over rewriting correct validation or adding
another collector: it strengthens the existing boundary with no runtime cost.
Cover default/local alias names `type` across four grammars and genuine `typeof`
modifier refusals in TS/TSX, distinguishing parser errors from semantic refusal.
Only the existing import test file may change. Budget: two focused import suites
and one parent typecheck, serial foreground. Production changes require a newly
demonstrated defect; provider and authenticated manager states remain unchanged.

Added the boundary regressions in the import unit test; production code needed
no change. One focused suite passed 37 tests, exit 0. Parent foreground typecheck
and scoped whitespace check exited 0. Budget consumed: one of two suites and one
of one typecheck. Valid parser roots are asserted before modifier rejection;
positive cases verify ordered interpreted imports, binding ranges and extractor
results. OntoIndex supplied-file verification passed with symbol scope skipped.
Independent Sol-medium review found no concrete defects in the landed tests.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: closed
  selection_policy: active_next_task-first
  active_next_task: null
  max_in_flight: 1
  dispatch_mode: sub-agent
  dispatch_preflight:
    required_roles:
      coder-worker:
        agent_type_candidates:
        - coder-worker
        model_candidates:
        - gpt-6-luna
        - gpt-6.1-sol
        reasoning_effort: high
      coder-worker-test-challenger:
        agent_type_candidates:
        - coder-worker-test-challenger
        model: gpt-6.1-sol
        reasoning_effort: xhigh
  last_decision: dispatched
  reopen_gate: null
tasks:
  LEX-EXPORT:
    title: Current local named declaration and clause exports resolve canonical module bindings atomically
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    type: code
    depends_on: []
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/languages/typescript-export-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-export-captures.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/languages/typescript-export-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-export-captures.test.ts
    non_goals:
    - Destructuring reexports default declarations provider activation shared schema and runtime navigation
    required_validation:
    - CI=true UPDATE_SNAPSHOTS=0 ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-export-captures.test.ts test/unit/scope-resolution/typescript-declaration-captures.test.ts
    - ./node_modules/.bin/tsc --noEmit --incremental false
    - git diff --check -- ontoindex/src/core/ingestion/languages/typescript-export-captures.ts ontoindex/test/unit/scope-resolution/typescript-export-captures.test.ts
    expected_evidence:
    - Existing lexical emitter validates all declarators before any export records are returned
    - Four grammars preserve exact detached identifier ranges and canonical module IDs
    - Mixed supported and unsupported declarators refuse atomically in either order
    - Initializer type syntax remains valid and duplicate exports still refuse
    - Existing var batching and named function generator class and abstract class exports retain their tested behavior
    rollback:
    - Revert only this packet additions preserving accepted named declaration exports
    stop_conditions:
    - Shared extractor or unresolved semantic change required
    - Two focused suite invocations or one typecheck exhausted
    known_blockers: []
    dispatch:
      role: coder-worker-test-challenger
      attempts: 0
      max_attempts: 5
      dispatch_id: 731977c4-17f2-4d77-b271-717296b93b88
      scope_sha256: ac9e0f09c701c27e9bdcf4da10e136b1efbcf4ebafa1a1d64b5a119de4fdb996
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792739889867'
      assigned_agent: 01a1679f-d29e-7211-91ba-20e9a20bd8a7
      agent_type_requested: cdr-worker-test-challenger
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: e8a65639e5dfccbfc30492cf06d2b51e15bce668675449bfa557149cd3bf5e8c
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-worker
        agent_id: 01a1679d-45f1-7202-9837-b83ebc005b8e
        effective_model: gpt-6-luna
        receipt_id: role-result-71b48f00547938254bb5841b723b4da2b90a621fb90523e7abfffc8fe0044356
        verdict: PASS
      - role: cdr-worker-test-challenger
        agent_id: 01a1679f-d29e-7211-91ba-20e9a20bd8a7
        effective_model: gpt-6.1-sol
        receipt_id: role-result-344211e12a59fda50f5b463355f277178c89f8960af52b283581967bd276e606
        verdict: PASS
    dod_status: pass
```

## Accepted packet

Scenario: Current supported local exports resolve canonical names.
Given the current export and declaration source and tests, review and adopt the
existing const/let/var, ordinary named function/generator/class/abstract-class
and local clause exports. Validate canonical identity, var batching, duplicate
rejection, detached ranges and whole-statement refusal. Correct only a concrete
defect found in those two owner files; no code change is required for adoption.

Write set: the two named export files only. You are not alone in the checkout;
preserve concurrent edits and accepted declaration behavior. No new cache or AST.

Fixtures: all four grammars; multiple declarators; Unicode; uninitialized let;
exact identifier ranges; parser reuse and detached mutation; nested initializer
names; TS annotations and satisfies; initializer bodies containing type aliases;
mixed simple/destructured names in both orders; malformed second declarator;
escaped names; duplicate declaration/clause exports. Preserve existing positive
var/generator/abstract-class coverage and default-declaration, type-only,
destructuring and reexport refusals.

2026-10-23 scope amendment authorized by user selection of stages 1-6: full
current-source review replaces the obsolete const/let-only boundary. No active
lease exists; accepted historical receipts and attempt fields are preserved.
Independent source review found no concrete export defect. Expected source SHA256
eac9e5984e07c83431cfb0ba71eaebaba440ab0a6a75fabc6f8bef37c0815a2f;
test SHA256 6a82479053bb34a877df8681c315253dfb44056eb0b79e8a7b7758f06a19fe5f.
These identify the handoff baseline; stop on unexplained drift. New current-scope
validation allowance is two focused suites and one typecheck, serial foreground,
assigned to coordinator for fresh baseline evidence after manager redispatch
refusal; worker and challenger reuse this evidence and run no suites/typecheck.
Earlier missing
challenger process evidence remains unknown and is not counted as zero.

## Decisions And Non-Goals

Compared three alternatives twice with independent Sol medium review:

| Option | Review and decision |
| --- | --- |
| Reuse lexical validator in existing export emitter | Selected: canonical identity and atomic validation retained; linear local allocations; two-file rollback and parser fixtures bound risk |
| Rewrite source into synthetic export clauses | Rejected: loses original ranges and adds parsing and identity hazards |
| Auto-export in shared extractor | Rejected: expands consumer and scope semantics without benefit |

Second review checks detached Capture versus SyntaxNode types, independent range
objects, all-declarator refusal and initializer syntax. No security boundary or
public schema changes. Performance is a structural expectation, not a benchmark.

Worker owns edits and scoped whitespace. Challenger owns focused suite and one
typecheck serially in a fresh isolated current-input snapshot. Two suite attempts
and one typecheck total, no builds or reindex. Preserve exact command receipts
and pre/post input identity; stop on mutation or exhausted allowance.

## Routing recovery decision

Current source still refuses lexical export declarations. The accepted BLOCKED
worker result ran no validation: zero of two suite invocations and zero of one
typechecks are consumed. Dispatch attempts are separate from validation budgets.

Four bounded reviewers checked routing, source, budget and recovery availability;
at least two ran on gpt-6.1-sol with medium effort. Parent OntoIndex freshness
returned Transport closed; source inspection is authority for this continuation.

| Recovery option | Second review and disposition |
| --- | --- |
| Select approved Sol through authenticated dispatch | Preferred once available; preserves scope, receipts and compatibility, with no product runtime cost. Exposed dispatch schema has no model selector, so this route is presently unavailable. |
| Retry Luna | Retain only after evidence that the failed worker binding is repaired. Successful explorer startup alone does not establish that worker routing changed. Unchanged retry is rejected. |
| Change worker configuration and reload the host | Broader fallback requiring the existing host configuration owner and restart verification. Editing cached role files alone cannot repair the current connection. No configuration edits were made. |

Reopen when the authenticated manager can select the approved Sol worker or
fresh evidence proves the original worker binding repaired. Preserve the accepted
BLOCKED receipt; do not copy receipts, bypass role gates, or reset budgets.
The implementation choice remains reuse of the lexical validator, followed by
independent focused parser tests and TypeScript validation.

## Current recovery evidence

2026-10-23: User accepted the proposed fifth correction attempt with “proceed”
(typed using the Russian keyboard layout). Increase only dispatch allowance to
five; retain four consumed attempts and unchanged validation allowances.
The fourth worker mistook its own reservation for another writer. The next
authenticated assigned agent IS the exclusive owner of both files. This
reservation does not name a competing worker. Parent and reviewers remain
read-only on those files while it works. Repair both lexical range copies and
add lexical-specific mutation isolation; existing named-declaration and clause
tests do not establish lexical isolation. Prior reservations are historical.

User authorization: “unblock tasks and contnineu” accepts the proposed single
additional LEX-EXPORT dispatch. Dispatch allowance increases from three to four;
three consumed attempts and all receipts remain preserved. Test allowances are
unchanged. This amendment authorizes the existing two-file correction only.

Latest accepted receipt cbd0470ddec2293030f398067458e5ccdf7c9b96fbdde5e726cc372d45d71af3
narrows the remaining defect to shared range objects. The worker is terminal and
its lease is accepted. The next packet must repair both mappings with explicit
`range: { ...name.range }` and add an assertion that mutating one export range
does not mutate the other. This is a code correction within the existing owner,
not an external dependency. Direct range cloning is selected over reverting and
rebuilding the patch or changing the shared capture API: both alternatives add
scope without improving isolation. Preserve all other accepted behavior.
Before edits, record current file hashes rather than reuse the pre-worker hashes
below. Worker owns the two files exclusively through handoff; suites and typecheck
remain challenger-owned with the existing total budget.

The latest accepted worker receipt records a concurrent-edit blocker after an
actual source write. The earlier unavailable-binding diagnosis is historical.
The coordinator's current full agent inventory contains no active child writer.
Four Sol-medium reviewers examined this recovery; direct capture construction
remains the selected repair. Reverting lexical additions adds churn; redesigning
the shared capture API expands ownership without improving this fix.

Reserve both owner files exclusively for the next authenticated worker. The
coordinator and review agents remain read-only on those files until handoff.
Before writing, compare these observed SHA-256 inputs and stop on mismatch:

- Export source: fd4f0e3ea4a98e029a2bc27a239cb9cee94f67367494d030adcc29d9b7c8cf69
- Export tests: 4316f435ce2c4d97016cae2737172a8b31aefefee50466cd580a111d7afdcce1

Replace the fabricated SyntaxNode mapping with detached captures, each with its
own copied range. Keep whole-declaration validation before mapping. Complete the
already specified lexical fixtures. Worker runs scoped whitespace only;
challenger owns the fresh isolated snapshot and serial validation. Recorded
consumption remains zero of two suites and zero of one typecheck. Capture final
hashes at handoff and reject subsequent input drift. Registry absence establishes
local child ownership only; any unexpected external edit still stops execution.

OntoIndex freshness returned Transport closed; source inspection is authority.
This evidence addresses the latest conflict blocker without changing role gates,
accepted receipts, dispatch history, or validation budgets.

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| LEX | Canonical simple lexical exports | implementation | LEX-EXPORT | Four-grammar parser tests and typecheck |

## Closeout

Named-export prerequisite completed with authenticated receipt
role-result-c08e9bd9cddf6ffc01454345e86d0ac11a6907a03e17834fcae0e3aafaef4282.
Provider, CALLS, SEED, graph parity and large dirty-workspace acceptance remain open.
