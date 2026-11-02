# 2.4.12 qualification repair

Reviewed the qualification report in
`../ontocode/docs/review/ONTOINDEX_2_4_12_QUALIFICATION_2026_11_02.md`
against HEAD `fff535ca0033c66cb83306847be09db08fde233c` and current source.
Repairs are local and uncommitted. Version and installation remain 2.4.12.

## Review and decisions

The report retains pinned source identity, explicit skipped coverage and targeted
reproductions. Configured-suite success did not disprove its three defects.
Previous gaps were tests endorsing outage success, missing receiver syntax
normalization, and field metadata tests that did not prove graph publication.
Scope extraction also rejected the constructor bindings in the retained probe.

Three alternatives were compared per defect before editing:

| Issue | Selected | Alternatives rejected |
| --- | --- | --- |
| Audit false success | Reuse invocation-error contract after compatibility fallback fails; disclose optional caller-count loss | Fail every optional query, which discards useful rows; add another staged error framework, which duplicates ownership |
| False call edges | Normalize transparent parentheses in shared receiver analysis | Reject all incomplete receivers, which changes compatibility broadly; rewrite name resolution, which exceeds the demonstrated cause |
| Missing constructor properties | Extend existing constructor queries and binding validator | Add an AST promotion pass, which duplicates traversal; publish declarations from field enrichment, which mixes owners |
| Formatting | Format the six reported files | Rewrite repository formatting wholesale; weaken the gate |

Second review checked compatibility fallback, legitimate empty results, sanitized
optional warnings, malformed/nonconstructor inputs, typed positive controls,
unknown receivers, and actual worker transport. No new dependency, retry loop,
query, AST pass or parallel error infrastructure was added. No performance gain
is claimed without measurements. Four initial reviewers and three implementation
workers participated; final independent source review found no introduced defect.

## Implemented

- Required structural-query failure now marks tech-debt unavailable in aggregate
  audits. Optional caller-count failure retains rows with a fixed warning.
- Shared receiver extraction recognizes transparent parentheses and preserves
  unknown bases in over-depth field chains.
- TypeScript constructor captures include readonly-only and optional properties;
  scope bindings support visibility modifiers and optional readonly parameters.
- Regression tests cover sequential processing, extracted replay, actual compiled
  worker IPC, positive controls, ordinary parameter negatives and scope retention.
- The six reported formatting failures are corrected.

## Validation

Evidence directory: `/opt/d2/ontoindex-2412-repair-VxJyw1gW`.

| Check | Result |
| --- | --- |
| Native Linux `CARGO_BUILD_JOBS=4 JOBS=4 ONTOINDEX_SKIP_EXT_FETCH=1 npm run build` in `ontoindex/` | Exit 0; compiled artifact `ontoindex/dist/core/ingestion/workers/parse-worker.js`; existing warnings |
| Affected Vitest files, including complete worker-pool and hook suites | Exit 0; 682 tests across 12 files; `focused.log` |
| Retained qualification probes, changing only dist root in copied runner | Exit 0; 10/10 pass; `probes.log` |
| ESLint on changed source/tests | Exit 0; zero errors, 574 warnings; `lint.log` |
| Backend `tsc --noEmit` | Exit 0; `typecheck.log` |
| Prettier on tracked files plus new regression file | Exit 0; `format-tracked.log` |
| Root `prettier --check .` | Exit 1 only for eight ignored evaluation artifacts; `format.log`; original evidence preserved |
| Bounded OntoIndex verify_diff with explicit expected/changed files | PASS, no unexpected files; `scope.log`; impact capped at 25 symbols, symbol expectations omitted, no executed-test evidence |

Initial validation found incorrect expectations in new tests: constructor scopes
also retain their Method, and optional property types include `undefined`.
Assertions were corrected to the existing contracts before the final passing run.

## Limits and next work

The full qualification matrix was not repeated. Historical postponed-language,
native-latency and frozen-evidence gaps remain outside this repair. Receivers
beyond 32 transparent wrappers or with unsupported syntax remain unresolved;
the follow-up below verifies abstention when both receiver name and type are absent.
Optional caller-count degradation is indicated by warnings, not an incomplete
section, so useful risk rows remain visible.

OntoIndex committed navigation excludes dirty edits; source was authoritative
for patch review. No manual reindex, CI, commit, version bump, release or local
installation was performed. GN manager leases and status were not changed.

## Follow-up challenge and repair

Four read-only Luna/Sol reviewers challenged the current patch; three Sol workers
implemented disjoint fixes. The coordinator reviewed and validated the combined
tree. Good: shared extraction, compatibility fallback, explicit degradation and
real worker IPC. Missed: raw required-query diagnostics, opaque receiver fallback,
invalid constructor lookalikes, and a failing root formatter despite a passing
tracked-file workaround.

Three materially distinct remedies were compared twice for each new issue:

| Issue | Selected | Rejected alternatives |
| --- | --- | --- |
| Required query leaks raw errors | Fixed public error at compatibility-query boundary | Generic redaction is incomplete; classified error framework adds unnecessary ownership |
| Missing receiver evidence guesses a target | Shared resolver rejects members with neither name nor type | Raising parentheses cap postpones failure; new receiver-state IPC schema is unnecessary |
| Invalid constructor property publication | Shared capture-label guard checks direct ancestry and modifier tokens | Class-only query constraint misses static methods; new AST pass duplicates work |
| Generated evidence fails formatting | Anchored `/eval/results/` ignore | Reformatting mutates evidence; custom tracked-file runner adds quoting and coverage complexity |

Second review preserved compatibility success, named module aliases, provider
dispatch, typed chains, ordinary fields, class expressions, abstract classes,
constructor visibility and comments. Fixed strings avoid disclosure without a
new error taxonomy. Guards use existing metadata and direct AST children; no
additional query, dependency, background task, retry loop or traversal was added.
No benchmark improvement is claimed. Reversal is limited to these local hunks.

Fresh evidence: `/opt/d2/ontoindex-2412-review-1yPJYz/`.

| Check | Result |
| --- | --- |
| Native build, same command and cwd as above | Exit 0; `build.log`; current compiled worker used |
| Final focused and neighboring tests | Exit 0; 728 tests, 14 files; `focused-final.log` |
| Retained qualification probe runner | Exit 0; 10/10; `probes.log` |
| Backend `tsc --noEmit` | Exit 0; `typecheck.log` |
| ESLint on 22 affected source/test files | Exit 0; 0 errors, 585 warnings; `lint.log` |
| Root `npm run format:check` | Exit 0; `format-check.log` |
| Retained generated evidence integrity | 69 files unchanged against `evidence-hashes.json` |
| Bounded OntoIndex verify_diff | PASS; 22 explicit expected/changed files; `scope.log` |

Initial test run: exit 1, 475 pass and one stale expectation requiring name-only
resolution without receiver evidence. Corrected that fixture and added explicit
module-alias positive coverage; one correction round used, one remaining. Source
and actual-worker regressions cover deep/opaque receivers and constructor
lookalikes. Build once, test suite twice, retained probes once; all started
commands harvested. Typecheck, lint and root formatting ran once after final
code edits. One worker packet was rejected before execution for missing required
packet labels, then corrected; no work was duplicated.

OntoIndex returned committed evidence with `workspace_too_large`; current source
was authority. Impacts were LOW for audit/capture owner and MEDIUM for shared
call resolution. Verification checks file scope only: impact capped at 25,
no expected-symbol assertions and no test execution inside verify_diff. The
full qualification matrix remains unrun for this dirty tree. Typed/named dynamic
receiver heuristics retain their existing compatibility behavior. Changes remain
uncommitted and uninstalled; no version bump, release, CI or manual reindex.

## Additional neighboring regression validation

Four read-only Luna/Sol reviewers selected existing neighboring suites and checked
coverage limits. One native Vitest invocation passed 528 tests across six files
(exit 0, 40.81 seconds): Rust, TypeScript and JavaScript resolver integrations,
Rust element receiver types, audit Markdown rendering and audit report shape.
No further product edits were needed.

Evidence: `/opt/d2/ontoindex-2412-neighbors-8KvL6E/neighbors.log` and
`result.json`. All 3,176 recorded source, test, shared, configuration and selected
compiled-artifact hashes matched after the run; HEAD remained
`fff535ca0033c66cb83306847be09db08fde233c`. Input manifest SHA-256:
`13e121a3cd255f1813d017cd05a58811bfe0a5c8bbfd48f0f902ee9c73264938`.
This binds the neighboring run only; it does not retroactively bind earlier
build inputs or establish source-to-artifact equivalence.

The earlier 728-test run and this six-file run cover separate selected suites.
Full qualification of the repaired dirty tree remains unrun. Delivery remains
pending; GN authority and state are unchanged.

## Full backend follow-up

One default backend run used all three configured Vitest projects with four
workers and existing compiled artifacts. It exited 1: 18,903 passed, 11 failed,
one expected failure and 304 skipped across 805 files (797 passed, five failed,
three skipped). All 4,928 recorded inputs and HEAD matched after the run.
Evidence: `/opt/d2/ontoindex-2412-backend-edn_it6g/`, including `backend.log`,
`backend.exit`, `inputs.json` and `result.json`.

Failures identified three owners: Swift literal `self_expression` was absent
from simple receiver extraction (three assertions including precision totals);
Go indexed receiver types were lost before dispatch (two assertions); TypeScript
tests still rejected newly supported constructor parameter properties (six
assertions). The frozen precision baseline is preserved.

Swift now recognizes its literal node; TypeScript tests assert positive ownership,
arity and type bindings while preserving unsupported-form rejection. Scoped
validation passed 153 tests across five files, exit 0 (`swift-ts.log`). Go repair
is in progress. No tests ran while these files were being edited. One full test
run and one scoped follow-up have run in this continuation. Go correction and
final validation remain pending; no delivery or manager-state changes.

## Backend corrections and final rerun

Go indexed receivers now retain the complete expression identity and infer an
element only from an existing raw container declaration. Scope is deliberately
bounded to direct expression statements in named function/method bodies with a
prior direct declaration or parameter. Nested blocks, closures, qualified
element types and nested containers abstain. Existing make element bindings
remain unchanged. Unresolved Go indexed receivers cannot use name-only fallback.

Compared twice: removing abstention creates false edges; stripping indexing to
the base confuses container and element identity; the selected existing scoped
binding hook preserves provenance. Review found qualified element names lose
their package qualifier in the shared helper. Accepting short names was unsafe;
alias-aware resolver expansion exceeded this fix; rejecting qualified elements
was selected, including pointer-qualified negatives.

The first Go validation exited 1 with 565 passes, 11 incorrect new node-ID
assertions and 28 skips. Existing Go integration and all negative cases passed.
One correction round fixed exact owner assertions and qualified-type abstention.
Final affected validation exits 0: 731 passes, 28 skips, nine files
(`corrections.log`). The seven source-worker tests also pass (`source-worker.log`),
including current Go and Swift extraction through the real message handler with
a mocked parent port. This does not prove real thread/process IPC with rebuilt
artifacts. Existing real-worker tests select stale dist; no build was run here.

Backend typecheck exits 0; eight-file ESLint exits 0 with 26 warnings and zero
errors; root formatting exits 0. Bounded OntoIndex detect-changes reports LOW
risk for four selected production files and 16 indexed symbols; 25 other dirty
files were excluded. Committed context excludes uncommitted source. GN tracker
SHA-256 remains `47c4ef9f44a43a752683bf3955df8b0b1ab181199b2ef953d9f464157aa1785a`.

Final full backend run exits 0 with four workers: 18,960 passes, one expected
failure and 304 skips; 803 files passed and three skipped (806 total), duration
954.25 seconds. All 4,929 files in `inputs-final.json` and HEAD match afterward;
`backend-final.log`, `backend-final.exit` and `result-final.json` retain terminal
evidence. Manifest SHA-256:
`76bdc9bbf16f8afa943aaaa0d7352a1c5ad1e64f71fb89cad1e43959f9cfc684`.

Final source-worker test-file lint exits 0 (six warnings, zero errors), its
format check exits 0, and git diff whitespace check exits 0. No source edits or
concurrent validation occurred during the full run. This follow-up consumed two
full backend runs and four scoped invocations (Swift/TS, initial Go, corrected
combined suites, source worker); all were harvested. The only Go correction
round fixed test identity and qualified-type abstention. No release, version
change, install, CI, commit or manual reindex was performed. Broader web/native/
Python qualification and fresh compiled-worker IPC were not repeated.

## Fresh compiled-worker validation, 2026-11-03

Compared retaining source-only evidence, adding a source-worker launcher, and
rebuilding through the existing Linux build owner. Selected the existing build
and worker-pool integration tests after a second review: this proves actual IPC
without a second harness. Four bounded reviewers and one implementation worker
participated on gpt-6-luna and gpt-6.1-sol. No production source changed during
this follow-up; only worker-pool tests and this status record were edited.

`CARGO_BUILD_JOBS=4 JOBS=4 ONTOINDEX_SKIP_EXT_FETCH=1 npm run build` in
`/opt/d1/_wrk/ontoindex/ontoindex` exits 0. The generated worker is
`ontoindex/dist/core/ingestion/workers/parse-worker.js`. All 4,056 recorded build
inputs and HEAD matched after build.

Added thread/process cases assert complete Go indexed receiver names, element
types, exact target owners and unresolved-receiver abstention. Swift cases assert
literal self, owner type and exact edge endpoints with a competing method owner.
Initial validation passed 89 tests and failed two new Swift source-ID assertions.
Read-only diagnosis confirmed extraction uses `Function:self.swift:Service.caller`
while the declaration symbol has a `#0` suffix. One assertion correction preserves
the exact extracted source ID and resolved target; production identity behavior
was not changed or qualified beyond this receiver-transport test.

Final command in the same directory:
`ONTOINDEX_TEST_WORKERS=4 ./node_modules/.bin/vitest run test/integration/worker-pool.test.ts test/unit/cpp-worker-argcount-parity.test.ts test/unit/go-index-receiver-types.test.ts --reporter=verbose`.
Result: exit 0, 91 passes across three files, zero skips, 11.89 seconds. Both Swift
modes executed. The retained `review-2412-probes.mjs` runner passes 10/10 against
fresh dist. Final test-file ESLint exits 0 with zero errors and 94 warnings;
Prettier and git diff whitespace checks exit 0.

Evidence: `/opt/d2/ontoindex-2412-ipc-cgu9odj5/`, including build/focused/probe logs,
terminal exit files, `validation-inputs-final.json`, and `result.json`. All 5,824
recorded source/artifact inputs and HEAD matched after validation. Manifest hash:
`5096a05502d57cb2cfd327b7f39d6139f186b697ffe99ad800c45a7af47d0acd`.
Initial failure evidence is retained. No overlapping validation or manual reindex
was performed. OntoIndex committed context located WorkerPool but excluded dirty
edits; incoming-reference queries exhausted its buffer pool. Source inspection
was authority for the changed code.

The fresh compiled-worker gap is closed. The earlier 18,960-pass backend result
remains historical full-suite evidence; the full suite and broader web/native/
Python matrix were not rerun after rebuilding. GN tracker hash remains
`47c4ef9f44a43a752683bf3955df8b0b1ab181199b2ef953d9f464157aa1785a`;
its blocked manager state is unchanged. Version and installation remain 2.4.12;
repairs are uncommitted, with no push, install, release or CI action.

## Swift endpoint correction, 2026-11-03

The preceding interpretation of the Swift source-ID mismatch was incorrect.
Accepting the unsuffixed source proved transport but concealed a dangling graph
edge. Four read-only reviewers verified the evidence and traced the mismatch:
worker declarations suffix Swift member Function IDs, while worker call-source
construction and sequential fallback omitted that eligibility. Publication does
not reconcile missing endpoints; exact-ID matching cannot retain this edge.

Compared aligning existing caller builders, looking up canonical symbols after
extraction, and repairing edges during publication. A second review selected the
first: preserve existing cached method extraction, arity, overload type tags and
variadic handling, with no ambiguous name matching or new abstraction. Swift
has no custom enclosing-function finder, so that branch remains unchanged.
Only two production predicates changed: `findEnclosingFunctionId` in
`parse-worker.ts` and the normal fallback in `findEnclosingFunction` in
`call-processor.ts`. Top-level functions remain unsuffixed.

A bounded worker strengthened the existing source-worker and real IPC tests.
Before the fix, three member cases failed and the top-level control passed.
Afterward, zero/one-argument members, same-arity Int/String overloads, and
top-level calls match emitted caller declarations. Sequential edges and real
thread/process edges must have both endpoints in the graph. Independent review
found no correctness issue in the two production changes.

Evidence: `/opt/d2/ontoindex-2412-endpoints-lo7o5yx0/`.

- Red regression: exit 1, three failed, one passed, six excluded by selector.
- Source tests: exit 0, 257 passes across three files, zero skips.
- Backend `tsc --noEmit`: exit 0.
- Native build: exit 0, `CARGO_BUILD_JOBS=4 JOBS=4 ONTOINDEX_SKIP_EXT_FETCH=1 npm run build`
  in `/opt/d1/_wrk/ontoindex/ontoindex`; generated worker
  `ontoindex/dist/core/ingestion/workers/parse-worker.js`.
- Fresh compiled validation: exit 0, 341 passes across five files, zero skips,
  31.52 seconds. Command: `ONTOINDEX_TEST_WORKERS=4 ./node_modules/.bin/vitest run test/integration/worker-pool.test.ts test/unit/cpp-worker-argcount-parity.test.ts test/integration/resolvers/swift.test.ts test/unit/call-processor.test.ts test/unit/go-index-receiver-types.test.ts`.
- Retained qualification probes: exit 0, 10/10.
- Four-file lint: exit 0, zero errors and 120 warnings. Formatting and whitespace
  checks: exit 0.

`result.json` binds terminal logs to `validation-inputs.json`; all 5,824 recorded
source/artifact inputs and HEAD match after validation. Prior failed and passing
evidence is preserved. One build, one deliberate red run, two passing scoped
runs and one probe replay were executed serially. No full-backend rerun or
database publication experiment is claimed for this delta. OntoIndex individual
impact checks were LOW; scoped aggregate diff was MEDIUM including the prior
resolver guard. Committed evidence excludes dirty changes; source is authority.
GN remains blocked with its tracker unchanged. Version/installation stay 2.4.12;
no commit, push, install, release or CI action occurred.

## Full backend after endpoint correction, 2026-11-03

Four read-only Luna/Sol reviewers checked invocation scope, existing evidence,
coverage limits and acceptance. The prior 5,824-file source/artifact manifest
matched current bytes and HEAD, allowing reuse of the successful build without
another build. Installed OntoIndex committed search succeeded at current HEAD;
it explicitly excluded 29 dirty source files. Source is authority for those edits.

Executed once in `/opt/d1/_wrk/ontoindex/ontoindex`:
`ONTOINDEX_TEST_WORKERS=4 ./node_modules/.bin/vitest run`.
All three configured backend projects ran. The host-dependent configuration
limited execution to one worker. Exit 0: 803 files passed, three files skipped;
18,967 tests passed, one expected failure and 304 skips. Vitest duration was
952.62 seconds. All 5,824 recorded source/artifact hashes and HEAD matched after
completion. No product or test source changed during this follow-up.

Evidence: `/opt/d2/ontoindex-2412-full-final-70k6joms/`, containing `command.json`,
`inputs.json`, `backend.log`, `backend.exit` and `result.json`.
Manifest SHA-256: `ca5ec5946c0e8ad9ae029d4dd84a37374109bd21c9071893deac26b08c5ecb9e`.
Log SHA-256: `178bd76667e7d497368149f2c9500fff5c0a1fc227d874f2efe97e917f175aa6`.

Budget used: one full backend run, no build or corrective rerun. The default
reporter stayed quiet for long intervals; status reads exceeded the prescribed
three unchanged-observation limit. No competing validation or replacement run
was launched, and the original session was harvested to terminal success.
Missing-source-map warnings remain in the log. This run does not refresh web,
Python, standalone native-addon, coverage instrumentation or opt-in results.
GN tracker hash and blocked manager state are unchanged. Repairs remain
uncommitted and uninstalled; version remains 2.4.12. No delivery or CI action.
