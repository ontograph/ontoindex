# Current working-tree Linux test results

Date: 2026-11-02
Authority: user requested full tests on the current codebase.
Original full-suite outcome: FAIL; nine backend integration assertions failed.
Latest outcome: a fresh full current-code run passed 18,846 ordinary backend
tests, one expected failure and 304 skips, plus web, native, Python, Chromium
and opt-in suites. Seven default skips passed in supplements; 297 remain unrun.
All 4,238 recorded inputs stayed unchanged. See Latest full current-code run
below; earlier runs and failure diagnoses remain historical evidence.
Minimum-runtime follow-up corrected a Tree-sitter ABI mismatch; the same rebuilt
addon passes 61 focused tests on Node 22.12 and Node 24.21. See Minimum-runtime
follow-up below; those cross-runtime results are historical.

## Latest full current-code run

Evidence: `/opt/d2/ontoindex-full-current-5QrET9Wq/REPORT.md`, with command
scripts, per-suite terminal receipts, JSON/XML reports and input hashes alongside.
Linux Node 24.21/npm 11.19; current dirty HEAD `d3f9fe8`. The required npm
pretest rebuilt current native, shared and backend outputs successfully.
Backend: 801 files passed, three skipped, 919.04 seconds; 18,846 ordinary
passes, one expected failure, 304 skips. Web: 271; Rust: 11; root HTTP: five;
Python: 46 eval and 100 triage; Chromium: 28, no skips or flakes. Native CSV
and lock scripts passed. Supplements passed 46 cgroup/workspace tests, two
real-WAL cases and one frozen TypeScript replay. Four standalone probes passed
18/8/8/19 checks. All runner exits are zero; supplemental counts overlap.

Seven default skips passed in supplements, leaving 297 unrun: 224 Kotlin,
68 Dart and five other documented type-environment cases. Whole-project
coverage and Node 22 were not rerun. All 4,238 recorded input hashes matched
after all suites; only four generated Python bytecode files were removed.
Report-only memory updates followed that comparison. Whitespace check passed.
Browser services were reaped and all runner sessions harvested. Four Luna/Sol
reviewers checked scope and evidence. No product edits, live installation,
commit, release or CI occurred; GN manager state is unchanged.

## Earlier run record

Original run HEAD: `d3f9fe80f5b24086c8d2f9909facf3ec4c939481`, with the uncommitted
R1–R7 repairs in 16 source/test files. No product source changed during the
full-suite run or supplemental validation. `tested-inputs.json` records the
dirty-file SHA-256 values; final verification matched every value.

Original run evidence directory: `/opt/d2/ontoindex-current-tests-20261102-nOEHQJ`.
`summary.json`, per-run `.exit` files, JSON/XML reports and logs retain results.
`backend-failures.json` records exact failed test identities and assertions.

## Results

| Runner | Result | Exit |
| --- | --- | --- |
| Backend, all three Vitest projects | 18,792 ordinary passes, 1 expected failure, 9 failures, 302 skips; 792 files pass, 4 fail, 2 skip | 1 |
| Web unit | 271 passed | 0 |
| Native Rust, `CARGO_BUILD_JOBS=4 just test-native` | 11 passed | 0 |
| Native CSV and lock JavaScript | Both scripts passed | 0 each |
| Root HTTP | 5 passed | 0 |
| Python evaluation / triage | 46 / 100 passed | 0 each |
| Delegated cgroup CPU and dirty-workspace replay | 46 passed | 0 |
| Chromium configured E2E | 28 passed; no skips, failures or flakes | 0 |
| Current built-code qualification probes | 18 passed | 0 |
| Prior review / prior issue / boundary probes | 8 / 8 / 19 passed | 0 each |
| Built tool contract | No missing/extra implementations or facade-action drift; 8 host-visible facades | 0 |
| RRF benchmark and checked-baseline gate | Ratio 1.6271 to 1.6033, -1.5%, within threshold | 0 each |
| Scoped ESLint | 0 errors, 139 warnings | 0 |
| Whitespace check | Passed | 0 |

The current-code prerequisite build exited 0 before these suites. It refreshed
generated CLI artifacts for integration tests; no installation or release occurred.
Earlier focused validation had two new pool-test accounting failures. Clearing
initialization-query mock history corrected those fixtures; the pool suite then
passed 42 tests, and passed again within the full run.

Backend JSON counts the expected failure within its 18,793 passing entries;
the table separates it. Cgroup supplemental results overlap the backend run,
so they are not added to a distinct-test total. Four cgroup skips were exercised
successfully, leaving 298 unexecuted cases. The existing self-index enabled all
19 super-function integration tests; both real-driver corrupt-WAL tests passed.

## Original failures and diagnosis

- TypeScript: constructor parameter property `user.address.save()` (1).
- Go: declared-field, nested-field and mixed call/field chains (5).
- PHP: constructor-promoted field chain (1).
- Ruby: YARD field chain and grandparent-return chain (2).

The new unresolved-chain guards in `call-processor.ts` prevent ordinary
name-only dispatch after an incomplete walk. These integration cases previously
continued through that fallback. Source review establishes missing constructor
property coverage in the TypeScript field extractor and PHP promotion coverage.
Ruby YARD already has a declared-type propagation path, so its failure needs
further tracing; a missing-type explanation is not established. The exact Go
metadata failure is also unresolved. Ruby's grandparent fixture has no declared
method return type. Nine failed assertions do not establish nine independent
root causes.

Four read-only Luna/Sol reviewers checked failure ownership, compatibility,
runner coverage, and audit/checkout regression evidence. Options considered:

1. Restore fallback: small rollback, but reopens arbitrary outer-method edges.
2. Restrict rejection to TS/JS: limits compatibility changes, but retains unsafe
   behavior in other languages and requires an explicit language-scope decision.
3. Preserve rejection and repair demonstrated metadata gaps in existing owners:
   preferred correctness direction; begin with TypeScript constructor properties
   and add competing-owner positive/negative tests before broadening changes.

Second challenge rejected rejecting only unknown bases: existing new tests also
show false edges from known bases with missing chain metadata. Different policies
for sequential and worker paths would violate graph parity. No fallback was
restored and no failing expectation was weakened during this testing task.

`ontoindex/src/core/ingestion/call-processor.ts` | incomplete-chain guards expose nine integration failures | trace precise metadata gaps before compatibility edits | sequential and extracted call resolution.

`ontoindex/src/core/ingestion/field-extractors/typescript.ts` | constructor parameter properties are omitted from direct-field extraction | extend the existing extractor with genuine parameter-property detection and regression coverage | TypeScript field registry consumed by chain resolution.

## Evidence limits and closeout

OntoIndex committed queries identify callers at the tested HEAD; dirty source
is authority for the repairs. Working-tree graph coverage remains unavailable
under the workspace size limit. The first direct scope-audit attempt omitted
database initialization and reported incomplete collection. After initializing
the existing committed database, the same bounded 16-file audit passed with no
unexpected files. Expected-symbol scope and executed-test evidence were not
provided by that audit; its PASS does not override the failing test result.

Coverage-instrumented thresholds, Node 22, external frozen-corpus parity and
native saturated-checkout/second-caller recovery remain unproven. Non-Linux
execution is prohibited. Configured manual/debug browser specs are excluded.
The checkout regressions use the real JavaScript pool with a mock native driver
and fake timers. The search tests inject timeout identities; audit tests use real
wrappers/aggregation with mocked inner dependencies. These do not prove native
saturation, full worker IPC, or general performance improvement.

All started runners were harvested; the browser driver reaped its backend and
Vite services. No detached tasks, CI dispatch, commit, version bump, installation
or publication occurred. The unrelated GN manager remains blocked and unchanged.
The original full testing request completed with the failures recorded above.

## Repair review and chosen approach

The follow-up compared three materially distinct approaches twice:

| Approach | Correctness and compatibility | Complexity, performance and validation | Decision |
| --- | --- | --- | --- |
| Restore name-only fallback after an incomplete chain | Restores prior positives but can select an unrelated same-name method | Small rollback; competing-owner negative tests would fail | Reject |
| Apply strict rejection only to TS/JS | Leaves false edges possible in other languages and creates divergent resolution contracts | Small language branch with ongoing parity burden | Reject |
| Preserve rejection and repair declared metadata in existing owners | Recovers supported chains while refusing unproven outer targets | Bounded extractor/parser changes; requires sequential/worker and file-order checks | Implement |

The second review checked unknown bases, valid prefixes, competing owners,
optional properties, constructor-only syntax, and file ordering. Restoring
fallback only for unknown bases would still admit false edges. No approach
requires a new dependency, external service, credential path or persistent
cache. Reverting the metadata repairs independently preserves the strict guards
but reintroduces missing valid edges; reverting the guards restores unsafe edges.

What worked: the chain guards preserve valid prefix evidence, fail closed on
unknown outer targets, and expose existing metadata omissions. Earlier validation
retained actual failures instead of declaring a green full suite.

What was missing: initial unit checks did not cover preparation ordering,
constructor properties, PHP capture-node identity, or worker metadata propagation.
Repeated fixture corrections increased validation churn. Two originally declared
correction rounds were exceeded by additional PHP capture and Ruby ordering
corrections under the user's broad implementation request; no durable budget
amendment was recorded before those corrections. This is a process deviation,
not a reset of the original budget. No unchanged failure was retried blindly.

Simplification: Ruby annotation extraction now reuses a small annotation-only
helper. It avoids constructing the complete property list for each field,
which produced quadratic list allocation for multi-name accessors. No cache,
generic inference framework or performance benchmark was added. A stale comment
claiming a separate web implementation was removed after source verification.

Implemented changes:

- TypeScript field extraction recognizes constructor visibility/readonly
  parameter properties; ordinary parameters remain excluded.
- Generic captured-node extraction supplies declared field metadata when the
  enclosing-owner lookup cannot supply it, including Go captured fields.
- PHP promotion queries capture the parameter node, and the existing extractor
  accepts that node kind.
- Ruby YARD annotations reach the initial property registration. Sequential
  parsing registers owner-qualified properties before call resolution, so
  consumer/provider input order does not determine correctness. Standalone
  call processing retains its fallback with matching IDs.
- The grandparent positive fixture now declares its supported return type.
  A separate unannotated negative retains the prefix call and refuses the outer
  call. General unannotated Ruby return inference is still unsupported.

## Repair validation evidence

Evidence directory: `/opt/d2/ontoindex-chain-repair-20261102-VOK2FT`.
All runs use source Vitest directly, bypassing the build-triggering npm pretest.
The source worker test invokes the actual handler with mocked parentPort;
it does not establish full worker IPC correctness.

| Report | Passed | Failed | Skipped | Result |
| --- | --- | --- | --- | --- |
| `focused.json` | 626 | 6 | 28 | Failed: fixture newlines and Ruby AST annotation placement |
| `focused-corrected.json` | 664 | 5 | 28 | Failed: unsupported test cleanup calls |
| `focused-final.json` | 672 | 1 | 28 | Failed: PHP worker capture metadata |
| `capture-corrected.json` | 673 | 0 | 28 | Exit 0 |
| `resolvers.json` | 1162 | 1 | 0 | Exit 1: Ruby preparation order |
| `ruby-preparation.json` | 375 | 0 | 0 | Exit 0: Ruby ordering repair and relevant regressions |
| `final-regression.json` | 1912 | 0 | 28 | Exit 0: 20 files, eight language resolver suites and focused regressions, 117.64 seconds |

Counts above overlap and must not be summed as unique tests. The final run used
`ONTOINDEX_TEST_WORKERS=4 ./node_modules/.bin/vitest run --project default`
with the 20 exact file selectors enumerated by its JSON testResults, plus
default/JSON reporters. It includes TS, JS, Rust, C++, Python, Go, PHP and Ruby
resolvers and the new metadata, order, call, type, pool, search and audit checks.
`final-inputs.json` records SHA-256 digests for all 33 changed source/test files.
Production TypeScript (`./node_modules/.bin/tsc --noEmit --incremental false`)
passed with exit 0; see `final-typecheck.log`. Scoped ESLint first exited 1
because the Ruby owner change left `findEnclosingClassId` unused. Removing only
that import produced exit 0, zero errors and 465 warnings in
`final-eslint-corrected.log`. This cleanup is an additional correction beyond
the original budget, recorded here rather than concealed. Tests and typecheck
precede that import-only deletion; no behavior changed and they were not repeated.
`final-inputs.json` still identifies the exact tested inputs, while
`closeout-inputs.json` records the post-lint source state. Whitespace checks pass.

OntoIndex committed context for `processSequentialFileMatches` matches HEAD
`d3f9fe80f5b24086c8d2f9909facf3ec4c939481` and explicitly excludes dirty edits.
Source inspection is authority for those edits. Individual owner impacts were
LOW; bounded aggregate ingestion diff impact was HIGH (50 symbols, six flows),
which motivated the eight-language resolver check. A class-impact expansion
failed with a buffer-pool allocation error; that graph expansion is unavailable.
The diff-impact artifact is plain text despite its `.json` suffix.

Remaining evidence gaps: a fresh full backend run, rebuilt-worker IPC parity,
native saturation with a second caller, instrumented coverage and Node 22.
Go secondary names in multi-name declarations remain unsupported and fail closed.
Broader Ruby method-comment attribution is outside this repair. No general
performance improvement or full-suite green result is claimed. No build, version
bump, commit, installation, publication or GN manager transition was performed
during the repair task.

## Post-repair continuation

User authorized continuation of remaining validation. Evidence directory:
`/opt/d2/ontoindex-postrepair-full-sl7xnnzj`. The full configured backend command
is `ONTOINDEX_TEST_WORKERS=4 ./node_modules/.bin/vitest run --reporter=default
--reporter=json --outputFile=/opt/d2/ontoindex-postrepair-full-sl7xnnzj/backend.json`,
run from `ontoindex/`, with output in `backend.log` and terminal code in
`backend.exit`. Direct Vitest avoids npm's build-triggering pretest. This run
uses current source and pre-existing dist artifacts: production worker tests
cannot establish rebuilt-worker correctness. `inputs.json` binds its 33 dirty
source/test files. No product/test edits are allowed during this run.

Four read-only Luna/Sol packets reviewed runner ownership, worker IPC, native
checkout recovery and evidence limits. Existing real-driver parallel-query and
WAL tests do not establish recovery after an expired checkout waiter. The
chosen new regression compares three options:

| Option | Review | Decision |
| --- | --- | --- |
| Expensive native query that exceeds the checkout deadline | Depends on host load and risks native timeout/resource contention | Reject |
| Production checkout hold/test hook | Deterministic but expands production API and introduces test-only ownership | Reject |
| Delay one real QueryResult materialization in the test, then release it | Reuses actual pool/native driver and existing database fixture; deterministic queue ordering without production changes | Select |

Second review requires an explicit barrier-entry signal, immediate rejection
observation, a new waiter queued before releasing the original caller, result
cleanup checked by object identity, and settlement of all started queries before
restoring spies. Real checkout timers remain 15 seconds versus the held query's
30-second deadline; severe scheduling stalls remain a validation sensitivity.
This establishes real-connection recovery under a controlled JavaScript delay,
not reproduction of native-driver latency. No dependencies or production hooks
are added. Rollback is removal of the single new regression file.

Continuation validation allocation: one full configured backend invocation,
one new recovery-test invocation, one real-WAL supplement if skipped by the full
run, scoped lint and whitespace checks. Allow one cause-based correction for the
new test; no unchanged retries. This new regression allocation does not erase the
prior metadata-repair budget overrun. No build, install, CI or delivery is planned.

The full run completed with exit 0 in 927.69 seconds: 799 files passed and three
skipped; 18,820 ordinary passes, one expected failure and 304 skipped tests
(19,125 total). The JSON reporter includes the expected failure in its 18,821
passed count. All 33 recorded input hashes and HEAD still matched when checked
after completion. This closes the fresh full-backend gap for current source
with existing dist artifacts. The two real-WAL cases remain skipped in this run
because their opt-in flag was absent; they are selected for the supplement.
The new native recovery regression is added after this full run and needs its
own focused result. No rebuilt-worker correctness claim follows from this run.

The added `ontoindex/test/unit/lbug-native-checkout-recovery.test.ts` uses the
existing native database fixture with a one-connection pool. It verifies the
second caller's typed checkout timeout, handoff to a third caller queued before
release, successful later parameterized execution, and exactly one close for the
first result. It restores the previous pool-size environment value, releases its
barrier in `finally`, settles every started query, and restores its two spies.
No production code changed in this continuation.

The supplement command, from `ontoindex/`, was
`ONTOINDEX_TEST_WORKERS=4 ONTOINDEX_REAL_WAL_TEST=1 ./node_modules/.bin/vitest run
--project default test/unit/lbug-native-checkout-recovery.test.ts
test/unit/lbug-real-wal.test.ts --reporter=default --reporter=json
--outputFile=/opt/d2/ontoindex-postrepair-full-sl7xnnzj/native-supplement.json`.
It exited 0: three tests passed across two files in 16.39 seconds. See
`native-supplement.log`, `.json` and `.exit` in the evidence directory.
`supplement-inputs.json` records 34 source/test hashes, captured during the
supplement and verified unchanged afterward. The full-suite skips remain 304;
the separate supplement exercises two of those cases. Of the original skips,
228 are Kotlin/Dart cases. Counts across runs must not be summed as unique tests.

Scoped lint initially exited 127 because ESLint lives at the repository root,
not in the package's node_modules. Corrected command from repository root:
`./node_modules/.bin/eslint ontoindex/test/unit/lbug-native-checkout-recovery.test.ts`.
It exited 0 with no diagnostics (`native-eslint-corrected.log` and `.exit`).
No code correction or test retry was needed. Whitespace validation passed.
Allocation consumed: one full backend run; one supplement invocation covering
both the allocated native regression and WAL supplement; one lint launch failure
and one corrected lint invocation. Prior repair overruns remain recorded above.

This continuation is complete. Rebuilt-worker IPC, instrumented coverage,
Node 22 and external frozen-corpus parity remain unproven. Native recovery under
controlled JavaScript delay does not reproduce native-driver latency or pinned
buffer exhaustion. The full run used Node 24.21.0 and existing dist workers.
No build, install, version bump, commit, release or GN manager transition was
performed. The unrelated GN manager remains blocked with no active task.

## Remaining validation follow-up

The next user-authorized continuation uses four read-only Luna/Sol reviews to
resolve coverage, Node 22, current-source worker IPC and frozen-corpus capability.
Evidence directory: `/opt/d2/ontoindex-remaining-validation-9uiwv0c1`.
All 34 previously validated source/test inputs still match. No product edit is
planned. Allocation: one scoped instrumented-coverage invocation and one frozen
TypeScript replay invocation, serially; one cause-based correction only if a
new failure identifies a bounded owner. No build, installation or acquisition.

Coverage alternatives: repeat the full instrumented backend suite, instrument
the repaired owners with their focused and language-resolver tests, or infer
coverage from prior passing tests. Select scoped instrumentation for the 20
changed production files with the configured thresholds unchanged. The full
suite adds substantial runtime; pass counts alone cannot measure coverage.
Second review rejects applying the project-wide denominator to a focused test
subset or calling scoped percentages project-wide qualification. Exact argv
and selected paths are saved in `coverage-command.json`.

The frozen replay fixture is locally present and hash-bound to its manifest:
41 TypeScript sources and two configuration files. Its opt-in gate is selected
for a fresh replay in both TypeScript registry modes, with workers and graph
summary phases disabled. Reuse this existing gate; acquiring another corpus or
creating a new harness would expand scope without closing this known gap.
There is no existing source-backed real-worker IPC path; compiled-artifact
qualification remains deferred under the no-build constraint. Node 22 was not
found in PATH or standard checked installation roots; no substitute runtime
result will be labeled Node 22 compatibility.

Both allocated checks completed with exit 0. Scoped coverage ran 21 test files:
1,913 passed, 28 skipped, 134.37 seconds. The V8 report contains exactly the 20
selected production files: statements 66.92% (4,487/6,705), branches 56.53%
(3,118/5,515), functions 61.83% (473/765), lines 69.43% (4,095/5,898). Existing
thresholds 26/23/28/27 were unchanged. `coverage-tests.json`, `.log`, `.exit`,
`coverage/coverage-summary.json` and `coverage/coverage-final.json` retain the
results. These percentages are scoped, not project-wide or changed-line coverage.
Audit backends remain lightly exercised outside their invocation-error paths:
dead-code line coverage is 9.45%, boundary-violations 19.64%, cycle-detect 23.8%.
No test-only additions were made solely to increase those percentages.

Frozen replay ran one selected test with 36 other tests excluded by the name
filter, in 15.43 seconds. `frozen-command.json` records the exact direct-Vitest
argv and environment; `frozen-parity-tests.json`, `.log`, `.exit` and
`frozen-parity-detail.json` record the result. It verified all 43 frozen files,
accepted 41 TypeScript sources with zero refusals, and reproduced full-parse
results via retained replay for registry modes 0 and 1. Both modes produce 544
nodes; their 792/799 relationship and 93/100 call counts are mode-specific,
not cross-mode equality claims. Workers, Git history and graph-summary phases
are excluded. Other languages have no external-corpus parity claim here.

All 34 source/test input hashes remained unchanged after both checks. Four
Luna/Sol reviewers were harvested and closed. Budget consumed: one scoped
coverage run and one frozen replay, no retry or correction. The report header
was corrected to show the already-completed full backend result. Only evidence
documentation changed in this continuation; no build, install, commit, CI or
GN manager transition occurred.

Remaining prerequisites are explicit: rebuilt artifacts for real worker IPC;
a native Node 22.12+ (major 22) runtime for compatibility; a separate full
instrumented run for project-wide coverage; and identified frozen fixtures for
other languages. Review also found root `.nvmrc` selects 20 while
`ontoindex/package.json` requires `>=22.12.0 <26.0.0`; runtime-selector alignment
remains a bounded follow-up, and changing it alone would not prove compatibility.

## Final review and simplified next steps

Four Luna/Sol reviewers challenged the dirty ingestion implementation,
pool/search/audit repairs, runtime prerequisites and evidence claims. Both code
reviews found no concrete new defect within their bounded scopes. OntoIndex
committed context identified owners at HEAD; direct source review covered dirty
changes excluded from that graph. All 34 source/test hashes still match the
passing evidence; no product-code refactor or unchanged suite rerun is justified.

What worked: strict incomplete-chain rejection remained intact; declared-field
repairs reused extractor/parser owners; checkout timeout gained a distinct type
without changing connection lifetime; search stopped retry amplification; audit
wrappers reused the existing invocation-error marker. Regression evidence
includes source language resolution, real native connection handoff, scoped V8
coverage and frozen TypeScript replay. These establish no general speedup.

What needed correction: the initial repair exceeded its correction budget
(preserved above), the original failures and current success were mixed in the
report header, and pending prose still described completed recovery as open.
Runtime and stale-index documentation had drifted from package/repository policy.
Repeated review paperwork and expanding coverage goals would add work without
fixing an observed defect. New worker loaders, generic retry abstractions,
production test hooks, and tests written merely to raise percentages are rejected.

Runtime options reviewed twice: select minimum supported 22.12, select tested
24.21.0, or remove the selector. Select 24.21.0 for the development default:
it satisfies the declared engine range and has current execution evidence.
Selecting the minimum would create an untested default; removing the selector
would remove reproducibility. Keep 22.12–25.x as the supported range and retain
Node 22 compatibility as a separate unexecuted check. Exact patch selection
requires maintenance at a future validated runtime upgrade; no security or
performance advantage over Node 22 is claimed. Only `.nvmrc`, CONTRIBUTING.md
and RUNBOOK.md change for this correction; no dependency or engine range changes.

Stale-index guidance options: correct the existing runbook section, remove it
and link policy only, or create a separate guide. Correct in place to preserve
useful troubleshooting without duplicating a guide. The second review rejects
forcing reindex on every stale response and grep-only fallback for staleness.
Instructions now use OntoIndex results with freshness labels and source checks
for excluded edits, and restrict manual refresh to the coordinator when an
immediate refresh is needed and no job is active. Examples use the installed CLI.

Validation: one inline Node assertion command exited 0, verifying `.nvmrc`
equals the running 24.21.0, satisfies CLI engines via installed semver, both docs
state the supported range/default, and stale-index instructions contain the
coordinator/no-active-job guard without npx or git-only fallback. Whitespace
validation exited 0. No builds, installations, tests, commits or CI were started.
Rollback: revert only the three configuration/documentation edits from this
review. Existing source repairs and historical evidence remain intact.

One forward sequence remains: preserve current passing source evidence; when
builds are authorized, rebuild through the existing owner and qualify real worker
IPC against those artifacts; independently exercise Node 22 when that runtime
is available. Keep pinned buffer exhaustion and GN dependencies in their existing
owners. Project-wide coverage and additional language corpora are optional
evidence extensions unless selected by an explicit acceptance requirement; they
are not new completion gates for this repair. No new manager plan or harness is
introduced, and the unrelated GN manager remains unchanged.

## Authorized rebuilt-worker validation

The user authorized local build and focused worker IPC validation. Four bounded
Luna/Sol reviewers checked build safety, test selection, field coverage and
prior evidence identity. All 34 prior source/test hashes matched current files.
The committed OntoIndex graph matches HEAD and excludes dirty edits. One peer
reported a buffer-pool allocation failure; direct source was authoritative for
that query. Parent impact for `createWorkerPool` returned LOW; no production
symbol changed.

Review found that source-handler field tests mocked `parentPort`. Three options
were compared: rely on generic IPC tests, add field assertions in the existing
worker suite, or introduce a separate harness. The second review selected the
existing suite: generic tests miss these values, while a new harness duplicates
worker lifetime and transport ownership. One integration case now verifies TS
constructor fields with distinct owners, Go struct fields, PHP promotions and
Ruby annotations across compiled-worker IPC. Exact counts reject ordinary
parameter promotion; untyped properties remain without declaredType. Existing
pool cleanup is reused. A peer reviewed the addition without finding a defect.
Rollback is removal of this single test; existing repairs are untouched.

Evidence: `/opt/d2/ontoindex-rebuilt-worker-16ipbi9v`.
From `/opt/d1/_wrk/ontoindex/ontoindex`,
`CARGO_BUILD_JOBS=4 ONTOINDEX_SKIP_EXT_FETCH=1 npm run build` exited 0 in 5.64s.
The existing build owner rebuilt TypeScript, checked the native Cargo artifact,
validated/copied cached extensions and validated dispatch imports. Node was
24.21.0. Output: `ontoindex/dist/core/ingestion/workers/parse-worker.js`, SHA-256
`a26fac0635e163a03593ecac3a54f780ab370916e0c4ea03d7b5b18cad6bb1e7`, changed from
the prior generated worker. Native addon hash matched generated provenance.
Build emitted ten Rust naming warnings and npm configuration warnings.

`test-command.json` records the exact direct Vitest invocation: default project,
four-worker cap, serialized files, setup bypass after explicit build, two
integration files and a bounded name selector. It exited 0 in 12.54s: 43 passed,
zero failed, 43 excluded. Coverage includes field metadata IPC, collected and
streamed TS/JS/Python scope artifacts, repeated thread/process worker startup and
teardown, and sequential/worker/recovery replay parity for TS, JS, C++, Rust,
supported Python and mixed Python fixtures. Expected scope-refusal diagnostics
appeared; legacy field metadata transport passed. This is fixture validation,
not a throughput or native buffer-exhaustion measurement.

`inputs.json`, `outputs-before-tests.json`, `test-inputs.json` and
`verification.json` bind the run: 791 recorded source/config inputs, 1,734
generated files and both selected test files remained unchanged across their
validation intervals. The manifest covers the selected source/configuration
scope, not all transitive installed dependency bytes. Scoped ESLint exited 0
with 88 warnings and no errors. Whitespace validation exited 0.

Budget used: one of one builds, one of one focused suites, zero corrective
retries. One scoped lint and whitespace check also ran. No install, release,
commit, CI or detached job was started. Existing full-suite evidence is reused;
it was not rerun. The rebuilt-worker gap is closed. Node 22 compatibility remains
unexecuted; buffer-exhaustion measurement and GN dependencies retain their
existing owners. GN manager remains blocked with active task null.

## Minimum-runtime compatibility and Tree-sitter ABI correction

User continuation selected the remaining Node 22 compatibility check. Four
Luna/Sol peers checked runtime acquisition, test scope, ABI correction and the
separate buffer measurement prerequisites. GN `manager_loop_next` returned
`no_dispatch`, blocked with active task null; tracking revision
`47c4ef9f44a43a752683bf3955df8b0b1ab181199b2ef953d9f464157aa1785a`.
No GN task state changed.

Evidence: `/opt/d2/ontoindex-node22-of0n6zlx`. Official Node 22.12.0 Linux x64
archive matched its official HTTPS SHASUMS256 entry. It ran from an isolated
directory; default Node 24.21.0 remained unchanged. `acquisition.json` records
URL and hash. CLI version and help passed. Initial compatibility suite exited 1:
three native-addon tests passed, but both integration forks exited unexpectedly.
The JSON reporter's empty integration results do not establish passes;
`tests.log` preserves both unhandled errors.

Four serial import probes isolated the failure: Tree-sitter and compiled
parser-loader exited on SIGSEGV (-11); LadybugDB and worker-pool imports passed.
The selected Tree-sitter binary exported Node-API 10, confirmed by disassembly;
Node 22.12 supports 9. Generated build flags also specified NAPI_VERSION=10.

Three fixes were reviewed twice: pin the existing addon to Node-API 9, rebuild
per runtime, or raise the advertised minimum. Pinning was selected because it
preserves the supported minimum and allows identical artifact bytes across
runtimes. Separate builds obscure delivery compatibility; raising the minimum
changes the public contract without repairing the native target. No performance
claim follows. OntoIndex committed impact for the parser loader was HIGH with
19 dependents; that warning preceded the edit. Source inspection established
that the selected node-addon-api target uses except.gypi, so no extra inherited
common.gypi override was needed.

Only `ontoindex/vendor/tree-sitter/binding.gyp` changed: a fixed NAPI_VERSION=9
variable replaces the host-derived definition. Existing `node-gyp rebuild
--jobs=4` ran from `ontoindex/vendor/tree-sitter` on Node 24, exiting 0 in 5.76s.
`rebuild-command.json` records exact arguments. Generated definitions and the
exported ABI getter both report 9. TypeScript parsing then passed on both
runtimes. Previous binary retained as `tree-sitter-before.node` for diagnosis;
rollback requires reverting this configuration and rebuilding the addon.

Final serial suites each exited 0: 61 passed, 43 excluded, four files, about
12.68s each on Node 22.12 and Node 24.21. These exercised native loading, compiled
field metadata IPC, six replay parity fixtures, worker lifecycle and 15 existing
parser compatibility cases. `node22-command.json` and `node24-command.json` retain
exact selectors; their corrected JSON/log files retain assertions and results.
No full-suite rerun occurred. Both runs used addon SHA-256
`a1d839ba9a57000bf0e493792658f43750af2de87a1b228b6dada6cbdb901886`.
`verification.json` confirms 796 selected source/config/test hashes and 1,734
generated output hashes remained unchanged across final validation. Whitespace
check exited 0; no source formatter or production TypeScript edit was needed.

Execution accounting: one isolated runtime acquisition, one initial failed
suite, four diagnostic imports, one corrective addon rebuild, two parse probes,
two final suites, and two CLI startup checks. One correction round was used;
there were no unchanged suite retries or detached jobs. Source fix and current
checkout artifact are validated; clean install and existing installed copies
are not. `build-vendored-natives.cjs` skips an existing addon loadable on its host,
so delivery must explicitly rebuild/replace old Tree-sitter binaries. No default
runtime, installation, release, commit or CI changed. Broader buffer measurement
still needs its pinned database/settings/query packet and bounded run allowance;
GN dependencies remain in their existing owner.

## Native lifecycle repair

Continuation closed the loadable-stale-artifact gap in the existing Linux build
and postinstall owners. Four Luna/Sol research packets compared unconditional
runtime rebuild, a provenance cache, and binary ABI inspection. A second review
selected the runtime-only rebuild: it covers source/configuration changes without
another cache or platform-specific introspection. Its cost is one native compile
per lifecycle invocation and requiring the native toolchain even for an existing
loadable runtime. Two Sol workers implemented disjoint script/test packets.

`ontoindex/scripts/build-vendored-natives.cjs` skips Tree-sitter's initial Linux
load probe, runs the existing four-job node-gyp rebuild, then verifies in a fresh
Node child. Before loading, it checks both application package resolution and
the canonical loader-selected artifact against the rebuilt vendor output.
Redirected artifacts, build errors and verification signals fail the lifecycle.
Optional grammars retain their existing load/skip and best-effort behavior.
`ontoindex/scripts/build.js` invokes that owner after Rust artifact checks and
before dist deletion or TypeScript compilation. Existing build/prepare/prepack
hooks therefore use the repair without additional package hooks.

Evidence: `/opt/d2/ontoindex-native-lifecycle-3sofhxlm`. `native-build.json` records
`node scripts/build-vendored-natives.cjs` in `ontoindex/`: exit 0 in 5.53s on Node
24.21.0. `test-command.json`, `tests.json` and `tests.log` record direct Vitest,
global setup disabled, maximum four workers and sequential files: 39 passed in
three files (18 vendored lifecycle, six build lifecycle, 15 parser compatibility),
exit 0. Tests execute the verification child code in a VM and assert rejection
before native load as well as failure propagation before output deletion.
Scoped ESLint and repository whitespace checks exit 0. Existing root Prettier
formatted the four touched files; the worker's first formatter path was missing
and did not modify files. No test correction or unchanged retry was needed.

`verification.json` confirms the five recorded implementation/test/binding inputs
were unchanged during validation and the rebuilt addon has SHA-256
`a1d839ba9a57000bf0e493792658f43750af2de87a1b228b6dada6cbdb901886`, identical to
the previously Node 22/24-tested artifact. Node 22 was not reacquired or rerun.
The scoped OntoIndex CLI impact calls reported LOW; committed evidence excludes
dirty edits. `graph-scope.json` contains CLI text, despite its filename: the
bounded detect-changes command reports three tracked files/four symbols, LOW,
zero affected processes. It omits the new untracked test, which was checked from
source and executed. An attempted JSON read of that text failed; reading its
actual format resolved the evidence-format issue without rerunning the command.

Execution accounting: one real native-builder run, one focused suite, one lint
run, no correction suite; no detached jobs. Six distinct agents contributed
(four research, two implementation); two initial implementation packet-shape
rejections were corrected before either worker wrote files. GN manager remains
blocked with active task null and unchanged revision
`47c4ef9f44a43a752683bf3955df8b0b1ab181199b2ef953d9f464157aa1785a`.

This proves the checkout lifecycle and unchanged compiled bytes. Full tarball
installation, copied-dependency layouts, Bun and pre-root dependency lifecycle
behavior were not qualified; an application dependency resolving outside the
rebuilt vendor directory now fails explicitly. Existing installed processes and
copies remain unchanged. No full application build, install, commit, release or
CI run occurred. Rollback is reverting these two script changes and their tests;
the earlier NAPI 9 fix is separate. Buffer measurement and GN dependencies retain
their existing scope and prerequisites.

## Isolated packed-install qualification

User continuation selected the remaining clean-install check. Four Luna/Sol
read-only packets reviewed packaging inputs, installer behavior, smoke coverage
and qualification limits. Compared builder-only validation, isolated tarball
installation and the full managed installer; selected the existing workflow's
explicit npm prefix route. The managed installer prefers the writable default
npm prefix, so setting only ONTOINDEX_NPM_PREFIX would not prove isolation.
OntoIndex CLI context/query used committed evidence and excluded dirty sources;
current scripts and workflow source were inspected directly.

Evidence: `/opt/d2/ontoindex-clean-install-evidence-xva33baq`.
Current-source `npm run build` in `ontoindex/` exited 0 in 11.077s with
CARGO_BUILD_JOBS=4, JOBS=4, npm_config_jobs=4 and ONTOINDEX_SKIP_EXT_FETCH=1.
It rebuilt the runtime, TypeScript/shared outputs and bundled cached verified
extensions. `npm pack --ignore-scripts --json --pack-destination <owned-stage>`
exited 0. The first harness merged warning stderr into JSON stdout and failed
parsing before install; its owned stage was removed. No product defect was
inferred. One corrected pack separated stdout/stderr and reused the completed
build. Original and corrected command records/logs are retained.

The tarball contained 2,079 files, 30,420,398 bytes, SHA-256
`4a649b467df43867e2dc47c904bcee31d961f4854935723f12c85fd2c23df6ec`.
Packed builder, binding.gyp and compiled worker bytes matched checkout output.
Installation into an empty owned prefix used `npm install --prefix <prefix>
--omit=dev --no-audit --no-fund --foreground-scripts --ignore-scripts=false
--install-links=false <tarball>` and exited 0 in 16.892s. Node was 24.21.0,
npm 11.19.0. Full stdout/stderr preserve lifecycle execution; native make
invocations specify four jobs. This is an empty-prefix install with existing
npm cache and packaged grammar artifacts, not a cold-cache source-only build.

Installed smoke passed Rust, TypeScript and JavaScript parsing with no root
errors, loaded LadybugDB and the packaged OntoIndex native addon, and verified
application runtime realpath and ordinary loader-selected artifact. CLI version
and watch help exited 0 through the absolute isolated executable. Objdump confirms
the installed exported ABI getter returns 9; addon SHA-256 is
`a1d839ba9a57000bf0e493792658f43750af2de87a1b228b6dada6cbdb901886`, identical to
the earlier Node 22/24-tested bytes. This turn did not reacquire Node 22 or run
database queries/MCP smoke. Five selected source/configuration input hashes
remained unchanged. Whitespace check passed; no product edits were needed.

Both owned staging directories were removed after marker, owner, symlink and
worktree checks. Corrected stage contained 528,788,529 logical bytes; the first
stage contained 30,420,447. This is logical file size, not measured allocated
disk recovery. Logs, command records, tarball hash, smoke output, ABI output and
cleanup receipts remain outside staging. Active CLI target remains the existing
managed 2.4.11 installation. No config, active installation, session, version,
commit, push, publication or CI was changed.

Execution accounting: one full local build, two packs (one harness correction),
one clean install, one three-language/native smoke, two CLI invocations and one
ABI inspection. All runner sessions were harvested; no detached jobs. GN
manager remains blocked with active task null and the same revision. Remaining:
delivery of uncommitted fixes to active installations, separate GN dependencies
and pinned buffer measurement. Copied-dependency topology, other package managers
and a fresh Node 22 installation remain outside this qualification.

## Installer isolation review — 2026-11-02

Four Luna/Sol reviewers examined native lifecycle, saved evidence, installer
isolation and repair complexity. The installer ignored an explicit
`ONTOINDEX_NPM_PREFIX` when the npm default was writable, selected its validation
binary through PATH, and could clean an unrelated dangling PATH shim. These
are source-confirmed defects; previous disposable npm installation evidence
did not exercise this installer wrapper.

Compared fixes: correct the two branches; select one prefix for every operation;
or export npm prefix configuration. The single-prefix approach removes branch
duplication and configuration ambiguity without dependencies or extra work.
Second review required empty-override compatibility, deterministic executable
selection, invalid-prefix failure without default cleanup and selected-prefix
shim handling. The script now applies that decision, including scoped repair
advice. Existing selected-prefix installs are still removed before npm runs;
transactional upgrade recovery is separate scope.

The native rebuild remains justified: successful loading on Node 24 does not
prove minimum-Node compatibility. A proposed load-first shortcut was withdrawn.
No provenance cache, new timeout-classifier abstraction or repeated broad suite
was added. Existing tests already cover checkout-timeout retry suppression and
accessor metadata through compiled workers. Earlier harness JSON parsing failed
because stderr was combined with stdout; preserved corrected evidence separates
those streams. The earlier native and clean-install receipts remain historical
evidence, not tests rerun in this review.

OntoIndex committed queries exclude dirty changes. Installer shell helpers
returned `not-in-index`, risk UNKNOWN; source inspection is authority for this
change. GN remains blocked with no active task; its gates were not modified.

Validation: `bash -n scripts/install-ontoindex-latest.sh` and scoped ESLint
exit 0. Direct Vitest with global setup skipped, four-worker cap and file
parallelism disabled passes all seven tests in
`ontoindex/test/unit/install-local-cleanup.test.ts`. Fixtures use real shell
functions and filesystem state, mocked npm/native loading, and existing local
assets; no network or real installation occurs. Independent Sol review accepted
both product diff and test scope. Formatting is confined to the test file.
The worker initially omitted the fixture version; source review corrected it
before test execution. Its PASS report was not treated as executed test evidence.
This review changed the installer, its existing test owner and these three memory
records. No build, live installation, commit, push, publication or CI run occurred.
