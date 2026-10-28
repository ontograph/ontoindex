# Luna workspace completion tracker

Date: 2026-10-22
Status: In progress
Authority: User request; ADR_AUTOMATIC_DIRTY_WORKSPACE.md

## Goal

Complete bounded dirty-workspace navigation through small, reviewed Luna packets.
Helper completion does not establish runtime readiness.

## Start here

Read this tracker and the selected packet only. Validate the tracker, resolve the
manager's next task, and preserve existing role gates. The coordinator owns this
file; Luna receives only a decided source/test write set. No archive loading.

Baseline: commit `2623820`, package `2.3.5-rc.12`. Retained release evidence:
native build and 640 tests passed; installed CLI and native loading passed.
Connected MCP identity and CI completion remain unverified here. OntoIndex
freshness returned `Transport closed`; source inspection is authority.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: closed
  selection_policy: active_next_task-first
  active_next_task: null
  max_in_flight: 1
  dispatch_mode: none
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
  reopen_gate: null
tasks:
  INPUT-COMPLETE:
    title: Reject contradictory complete input evidence at candidate admission
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    type: code
    complexity: simple
    depends_on: []
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.ts
    - ontoindex/test/unit/scope-retention-candidate-reader.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.ts
    - ontoindex/test/unit/scope-retention-candidate-reader.test.ts
    non_goals:
    - Seed activation or configuration schema redesign
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-retention-candidate-reader.test.ts test/unit/scope-retention-candidate-auxiliary-paths.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit --incremental false
    expected_evidence:
    - Complete flag agrees with empty reasons and complete retention configuration and source membership
    - Honest complete and incomplete candidates remain accepted
    rollback:
    - Revert only new evidence guards and regression cases
    stop_conditions:
    - Producer compatibility contradiction or scope expansion
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Select robust fixes and proceed with two Sol-medium developers
        validation_summary: Two Luna reviewers and two Sol-medium source/test developers confirmed producer invariants. Selected metadata and existing-set checks over stage reconstruction or manifest migration after second review. Complete flags now agree with reasons and require retained status complete configuration and exact source inventory. Honest partial candidates remain accepted. Nine corruption cases plus valid complete fixture added. Foreground two-suite Vitest passed 170 tests exit 0 in 7.02s; production tsc --noEmit --incremental false exit 0; explicit source/test whitespace passed. One of two suite invocations and one of one typecheck used; children ran none. OntoIndex impact target absent UNKNOWN; source inspection authority. Declared-file verify_diff PASS with symbol scope skipped. No activation build install or runtime acceptance claim.
    dod_status: pass
  PARSED-MEMBERS:
    title: Completed parsed producer covers every retained inventory path
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    type: code
    complexity: simple
    depends_on: []
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.ts
    - ontoindex/test/unit/scope-retention-candidate-reader.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.ts
    - ontoindex/test/unit/scope-retention-candidate-reader.test.ts
    non_goals:
    - Seed activation or complete cross-record schema redesign
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-retention-candidate-reader.test.ts test/unit/scope-retention-candidate-auxiliary-paths.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit --incremental false
    expected_evidence:
    - Equal-count substitution cannot hide a missing retained path
    - Completed valid and unfinished partial candidates preserve compatibility
    rollback:
    - Revert only membership check and associated regression cases
    stop_conditions:
    - Producer semantics contradict required membership
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed with remaining replay admission gaps
        validation_summary: Two Luna discovery/challenge agents and two Sol-medium source/test developers confirmed equal-count parsed-file substitution. Selected one-way set inclusion over full inventory equality or a duplicated path index after two reviews. Completed incomplete candidates now require every retained path in parsed records; extra non-retained records and unfinished partial candidates remain allowed. Three new cases use retained A and actual missing-outcome B without reconciliation. Foreground reader/auxiliary suites passed 160 tests exit 0; production tsc --noEmit --incremental false exit 0; explicit untracked source/test whitespace scan and tracker diff check exit 0. OntoIndex target absent gives UNKNOWN impact and source authority; declared file verify_diff passed with symbol scope skipped. One suite and one typecheck consumed. No seed activation build install or runtime readiness claim.
    dod_status: pass
  CANCEL-COMPOSE:
    title: Shared waiter cancellation composes with real child drain and cleanup
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    type: code
    complexity: simple
    depends_on: []
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    allowed_write_set:
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    non_goals:
    - Production refactor or workspace activation
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/local-backend-repo-runtime.test.ts test/unit/workspace-build-supervisor.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit --incremental false
    expected_evidence:
    - Cancelling one waiter preserves the shared child
    - Lifecycle stop drains child and artifacts before releasing lock once
    - Previous generation remains intact
    rollback:
    - Remove only the composed regression and its import
    stop_conditions:
    - Production defect requires a separately scoped fix
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed with remaining workspace lifecycle tasks
        validation_summary: Composed real-supervisor regression selected after comparing mocked extension and production refactor twice. Four agents participated including two Sol-medium development implementation/review packets. One caller cancellation preserves the real shared child; lifecycle stop drains remaining caller and records child death and artifact cleanup inside the single lock release while preserving old CURRENT and graph contents. Two foreground suites passed 155 tests exit 0; tsc --noEmit --incremental false exit 0; scoped git diff --check exit 0. OntoIndex supervisor impact LOW; bounded verify_diff PASS checks declared file scope only and skips symbols. No production change or build/install. Budget one suite invocation and one typecheck consumed. Tracker classification was corrected once before validation; implementation dispatch preceded tracker validation, a sequencing deviation with no active lease or write-scope overlap.
    dod_status: pass
  FILE-ID:
    title: File auxiliary source IDs match the complete owning file path
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    type: code
    complexity: simple
    depends_on: []
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.ts
    - ontoindex/test/unit/scope-retention-candidate-auxiliary-paths.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.ts
    - ontoindex/test/unit/scope-retention-candidate-auxiliary-paths.test.ts
    non_goals:
    - New ID schema or seed admission activation
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-retention-candidate-auxiliary-paths.test.ts test/unit/scope-retention-candidate-reader.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit --incremental false
    expected_evidence:
    - File path suffix mismatch refuses for calls and assignments
    - Exact File IDs including colon-containing paths remain accepted
    - Existing Function and Method ownership behavior remains intact
    rollback:
    - Revert only File equality guard and regression tests
    stop_conditions:
    - Identity schema changes required
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed with the selected FILE-ID fix
        validation_summary: Two Sol-medium developers changed source and tests separately; two Luna reviewers challenged ownership and fixture semantics. Exact File equality was selected over a shared parser or schema migration. Final foreground auxiliary-paths and candidate-reader suites passed 157 tests in two files exit 0; tsc --noEmit --incremental false exit 0; explicit source/test whitespace scan and tracker diff check exit 0. Six added cases reject suffixed File IDs for calls and assignments in retained and incomplete candidates and accept colon-containing exact paths. Existing Function and Method cases passed. OntoIndex verify_diff passed declared file scope with symbol checking explicitly skipped; source is authority for the unindexed helper. Budget one suite run and one typecheck consumed. No build install or deployment performed.
    dod_status: pass
  MODULE-BLOCK:
    title: Module bare blocks retain lexical isolation and module var ownership
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    type: code
    complexity: simple
    depends_on:
    - CATCH-IMPL
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/languages/typescript-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-captures.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/languages/typescript-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-captures.test.ts
    non_goals:
    - Provider activation or additional statement families
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-captures.test.ts test/unit/scope-resolution/typescript-declaration-captures.test.ts test/unit/scope-resolution/scope-extractor.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit --incremental false
    - git diff --check -- .memory-bank/LUNA_WORKSPACE_COMPLETION_PLAN.md
    expected_evidence:
    - Four grammars preserve block-local bindings and module var coalescing
    - Returns collisions and unsupported contents refuse atomically
    rollback:
    - Revert only module block dispatch and its added tests
    stop_conditions:
    - Shared scope changes required
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed with the selected bounded capture fix
        validation_summary: Two Sol-medium developers changed source and tests separately after four-agent discovery. Existing walker reused instead of duplicate traversal or broader statement activation; both review passes retained return and collision refusal. Final foreground suites passed 502 tests in three files exit 0; production tsc --noEmit --incremental false exit 0; explicit whitespace scan exit 0. First suite had four obsolete bare-block rejection assertions; one fixture correction resolved them. Budget two suite runs and one typecheck consumed. Provider activation remains outside scope.
    dod_status: pass
  CATCH-DESIGN:
    title: Freeze catch binding scope and lexical conflict behavior before implementation
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    type: design-gate
    complexity: standard
    depends_on: []
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - .memory-bank/LUNA_WORKSPACE_COMPLETION_PLAN.md
    allowed_write_set:
    - .memory-bank/LUNA_WORKSPACE_COMPLETION_PLAN.md
    non_goals:
    - Production edits or provider activation
    required_validation:
    - project_plan_validate .memory-bank/LUNA_WORKSPACE_COMPLETION_PLAN.md
    - git diff --check
    expected_evidence:
    - Exact scope owner and direct-body lexical conflict policy recorded
    - Three alternatives challenged twice and one selected
    - Two-file implementation packet frozen with real-parser acceptance fixtures
    rollback:
    - Revert only unaccepted planning edits
    stop_conditions:
    - Shared scope model or ADR amendment required
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Current-thread request to proceed with tracker tasks
        validation_summary: Three alternatives reviewed twice; owner conflict policy and fixtures frozen; plan validation passed and git diff --check exited 0
    dod_status: pass
  CATCH-IMPL:
    title: Simple catch identifiers bind inside catch scopes without leaking
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    type: code
    complexity: simple
    depends_on:
    - CATCH-DESIGN
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/languages/typescript-declaration-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-declaration-captures.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/languages/typescript-declaration-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-declaration-captures.test.ts
    non_goals:
    - Destructuring provider activation new schema or changed var collision policy
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-declaration-captures.test.ts test/unit/scope-resolution/scope-extractor.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - TS TSX JS JSX simple catch identifiers remain local to their catch scopes
    - Nested catches preserve distinct canonical identities
    - Optional catch binding emits no declaration
    - Unsupported patterns malformed syntax and unsupported collisions refuse explicitly
    - Existing var catch collision refusal and local definitions remain intact
    rollback:
    - Revert only the new helper and focused tests
    stop_conditions:
    - Unresolved design or changes outside the two named files
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed with fresh completion evidence for the duplicate catch task
        validation_summary: Existing implementation verified locally; 190 tests in the two required suites passed exit 0; tsc --noEmit --incremental false passed exit 0; scoped git diff --check passed exit 0. Four read-only reviews found no missing acceptance behavior. Whole-tree whitespace reports unrelated trailing blank lines in current-plan and pending-task projections. No historical receipt is claimed.
    dod_status: pass
```

## Luna packet and cost controls

After CATCH-DESIGN acceptance, target `emitTypeScriptCatchBindingCaptures` in the
existing declaration owner. Reuse existing Block scopes and capture types.

```gherkin
Scenario: Catch identifiers remain local
  Given the accepted catch design and existing capture helpers
  When the identifier-only helper is added
  Then extraction preserves catch-local identity and refuses unsupported forms
  And the focused suite and production typecheck pass
```

- Write set: only the two CATCH-IMPL files. Preserve concurrent edits.
- Stop when semantics are unresolved or the write set needs expansion.
- Supply relevant symbols and fixtures, not full history or whole repositories.
- One implementation writer; normally two to four files per later packet.
- Per packet: two focused suite invocations, one typecheck, one correction round.
  Failed launches count; uncertain launches reserve a slot until reconciled.
- No full-suite runs, builds, installs or reindexing for capture-only work.
- Return exact commands, exit codes, hashes, truncation and remaining budget.
- Coordinator accepts evidence and updates tracking; no inferred PASS.
- Bind validation to the revision and consumed input hashes; changed inputs
  invalidate affected evidence. A broader scope requires a new packet.
- Use eligible `gpt-6-luna` bounded helpers; preserve coder-worker/challenger
  gates, explicit Sol medium requests and repository four-agent minimum.
  Read-only packets may satisfy the remaining count; do not invent write scope.
- Before implementation, select supported sub-agent dispatch and complete role
  preflight; design uses authorized local completion.

## Catch design decision

Reuse the existing catch-clause Block. Add `emitTypeScriptCatchBindingCaptures`
in the declaration helper and anchor variable/name records at the identifier.
The existing catch body remains a distinct child Block. No shared schema,
binding metadata or provider activation changes are needed.

| Alternative | First review | Second review and decision |
| --- | --- | --- |
| Existing catch scope with identifier anchors | Correct environment identity, compatible extractor, minimum allocation and diff | Select; validate direct-body conflicts before emitting, preserve var refusal, rollback helper/tests |
| Body Block owns the catch parameter | Simple placement but conflates catch and body environments | Reject; loses correct ownership and redeclaration distinction |
| New Catch scope kind and protocol | Supports richer modeling but changes shared types and consumers | Reject; unnecessary compatibility, performance and validation cost for simple identifiers |

Second review challenges same-name outer bindings, nested/sibling catches,
body conflicts, malformed syntax and unsupported patterns. Retain current
parse-error refusal. Check direct body declarations without traversing nested
environments repeatedly; preserve existing var catch-collision behavior.

Frozen parser/extractor fixtures in the two-file implementation write set:

- All four grammars: simple catch owns its binding without outer leakage;
  optional catch emits none; nested/sibling catches have distinct identities.
- Outer lexical/import/parameter bindings and nested-block bindings may shadow.
- Same-name direct body let/const/class/function declarations refuse; unsupported
  direct binding patterns refuse when conflict freedom cannot be proven.
- Destructured, typed, escaped or malformed catch parameters refuse atomically;
  wrong node kinds refuse. Existing var collision tests remain unchanged.
- Unicode identifiers retain native ranges; detached records survive parser
  reuse and independent mutation.

Scope helper changes require a new packet. Correction runs consume the same
two focused-suite and one typecheck slots; no extra invocation is implied.
MODEL is the retained-model prerequisite and SCOPE comprises capture plus
provider acceptance. After CATCH-IMPL, coordinator prepares exact successor tasks
and transfers open gates and evidence; early tasks cannot close the full goal.

## Remaining stages

2026-10-23 assignment/route coverage checkpoint: source review found assignment
capture already precedes receiver-type fallback and the assignment-only return.
Compared changing capture order, adding failure flags and parser-backed tests;
selected regression proof without product edits. Four real-parser TS/TSX/JS/JSX
cases assert original typed/unresolved/static receiver inputs, retained RHS calls,
baseline graph equality and matching write edges through the existing assignment
replay owner. Two route cases cover TS builtins and Ruby literal/dynamic require,
include/extend/prepend and attr_accessor without false incompleteness.

Four agents included two Sol-medium developers with disjoint test files.
Foreground four-suite validation passed 220 tests, exit 0 (11.62s); production
TypeScript and scoped whitespace exited 0. One suite invocation and one typecheck
used; children ran none. OntoIndex bounded file verification passed with symbol
scope skipped; committed processCalls context succeeded, dirty source governs
current behavior. These tests establish selected paths only. C++ temporary-
receiver skip semantics and full supported-language coverage remain unverified,
followed by cross-record consistency, independent full replay parity, graph
replacement and runtime/performance acceptance before build/install. Seed
readiness remains false. Structured duplicate CATCH-IMPL selection is unchanged.

2026-10-23 call observation checkpoint: the existing sequential call processor
now exposes an optional trailing incomplete-observation callback. Unknown or
unavailable languages, absent queries/extractors, caught parser/query failures
and ordinary fallback calls without retained extraction signal incompleteness.
Opt-in parsing records calls-producer-incomplete; existing global issue guards
prevent final completion from overriding it. Default graph routing and parser
passes are unchanged. Compared full language ledgers, new extractors and bounded
failure signaling twice; selected the existing-owner callback for this slice.

Four agents included two Sol-medium developers. Six suites passed 505 tests,
exit 0 (13.58s); after a test-mock type correction the affected suite passed
three tests, exit 0 (1.69s). Production TypeScript and scoped whitespace exited
0. Budget used two suite invocations and one typecheck; children ran none.
OntoIndex file verification passed with symbol scope skipped; committed call
processor impact LOW2 and parse LOW1. Dirty source is authority. Real TS fixtures
prove retained success and missing/null-extractor refusal while preserving graph
resolution. Skip/parser/query and parse-retention guard tests passed. This is
specific failure coverage, not full supported-language admission: assignment
coverage, intentional skip routes, cross-record consistency and independent full
replay parity remain open before graph/runtime activation and build/install.
Seed readiness stays false; structured duplicate CATCH-IMPL remains unchanged.

2026-10-23 heritage completion checkpoint: source review confirmed the existing
sequential prepass already captures declarations and Ruby include/extend/prepend.
Selected reuse over duplicate producer callbacks or graph reconstruction. Added
an optional incomplete-observation signal for language/query skips and caught
parse/query failures; opt-in retention records heritage-producer-incomplete.
Successful observed heritage production now receives the explicit completion
marker, subject to existing global issue/lifecycle guards. No extra extraction
pass or duplicate capture was introduced. Full language coverage remains open.

Four agents included two Sol-medium developers. Real Ruby parser fixtures assert
four exact records and graph-edge parity against the separate legacy producers;
empty-success, unavailable/parse/query failure and worker/sequential/recovery
retention tests preserve uncertainty. Initial suite: 474 passed, two new fixture
assertions failed because intentionally partial scope capture suppresses all
completion. Corrected fixture expectations only; final seven-suite run passed
476 tests, exit 0 (13.07s). Production TypeScript and scoped whitespace exited 0.
Budget used two suite invocations and one typecheck; children ran none. Bounded
OntoIndex file verification passed with symbol scope skipped; committed extractor
and parse impact LOW, dirty source is authority. Next prove supported-input
coverage and cross-record consistency, then independent full replay parity,
source-owned graph replacement and runtime/performance acceptance. Seed readiness
stays false; no build/install or activation ran. Structured duplicate CATCH-IMPL
selection remains unchanged.

2026-10-23 producer completion checkpoint: explicit frozen eleven-family markers
distinguish completed empty output from unobserved producers. Capture resumes
invalidate markers; retention/input issues, cancellation, deadline and disposal
suppress all completion. Caught binding finalization failures now record retention
incompleteness. Successful parse finalization marks observed producers; heritage
remains false because legacy paths do not expose every input. Coverage and seed
readiness remain separate; seedReady is false.

Candidate format v2 persists markers under existing metadata stability checks.
Read-back rejects v1, missing/extra/nonboolean family keys, contradictory graph
flags, completion with retention issues and completed imports without a snapshot.
Older internal candidates require regeneration. Five foreground suites passed
492 tests, exit 0 (12.78s); production TypeScript no-emit and scoped whitespace
exited 0. One suite invocation and one typecheck used; children ran neither.
Five agents participated, including two Sol-medium developers; source reviews
found no blockers. OntoIndex file-scope verification passed; symbol scope skipped.
Committed stage/parse impact LOW; new candidate owners absent from graph, so
dirty source is authority. Supported-language coverage, heritage capture,
cross-record consistency, independent replay parity, graph activation,
runtime/performance acceptance and fresh build/install remain open. Structured
duplicate CATCH-IMPL selection is unchanged; no install or activation ran.

2026-10-23 auxiliary validation checkpoint: candidate read-back now reuses the
existing retention capture validators for calls, heritage, assignments,
constructor bindings, exported types and file bindings. Private scratch batches
rotate at 512 KiB or 1,000 records, use a separate bounded allowance and dispose
on every exit. No disk retention, duplicate schema or per-record stage creation
is added. Stored null call-argument slots normalize back to undefined; persisted
constructor records require exactly one binding. Existing capture behavior stays
unchanged. Candidate readiness remains false.

Four suites passed 397 tests, including all six valid families, 31 correctly
rehashed malformed-record cases and byte/count batch rollover. TypeScript and
scoped whitespace exited 0. One test invocation and one typecheck ran. Bounded
OntoIndex verification passed file scope with symbol scope skipped; committed
retention-owner impact was LOW2. Four agents included two Sol-medium developers.
All eleven families now have per-record validation. Remaining gates are explicit
per-family producer completion/absence, supported input coverage, cross-record
consistency and independent replay parity before admission and graph activation.
No build, install, connection switch or runtime activation ran for this slice.

2026-10-23 semantic record checkpoint: candidate read-back now validates model
registrations through the existing exported `cloneRegistrationEvent` validator
and import snapshots through `restoreImportResolutionState`. It refuses multiple
final import snapshots. Validation creates no semantic model per event and adds
no duplicate schema. Fourteen new cases cover all nine registration kinds,
populated import maps, correctly rehashed invalid semantic records and duplicate
snapshots. Five suites passed 213 tests; TypeScript and scoped whitespace exited
0. One focused suite invocation and one typecheck ran. Bounded OntoIndex file
verification passed with symbol scope skipped; committed clone impact was LOW3.
Four agents included two Sol-medium developers. Candidate readiness stays false.

Remaining admission gap: six auxiliary families still need reusable per-record
validation, and the persisted manifest lacks per-family producer completion or
explicit absence evidence. Supported/excluded input coverage and relational
replay parity must be proven before seed admission. Counts and generic observed
evidence alone cannot establish completeness. Runtime graph activation and fresh
build/install remain open; no such operation ran for this checkpoint.

2026-10-23 candidate integrity checkpoint: persistence now awaits bounded
read-back verification before returning. Verification checks manifest shape,
all eleven fixed family descriptors and filenames, source/commit/base/parser
identity, JSONL framing, record counts, byte totals and hashes. It rejects
symlinks, non-regular files, malformed data, cancellation and expired deadlines.
Read-back uses bounded buffers and observes file metadata changes; the caller
must retain generation ownership. Verification establishes observed artifact
integrity; semantic replay completeness and seed admission remain open.
The writer now preserves the codec's existing final newline, fixing duplicate
blank JSONL records that earlier trim-based tests missed. Existing cleanup and
refund apply to read-back failure. Four agents included two Sol-medium developers.
Final checks: 85 tests across four suites, TypeScript and scoped whitespace
passed. Initial TypeScript exited 2 on unknown-value narrowing after the reader's
const-arrow never guard; correction round 1 changed it to a function declaration
without weakening validation, followed by passing focused tests and typecheck.
Bounded OntoIndex file-scope verification passed with symbol
scope skipped. Two focused suite invocations and two typechecks ran. No build,
install, connection switch or seed activation. Next establish semantic admission
and supported-language replay completeness before graph replacement/activation.

2026-10-23 candidate persistence checkpoint: internal opt-in full analysis now
creates its existing staged generation before parsing and awaits streaming of
all eleven retained families before parse disposal. The candidate manifest is
written last with content hashes, record counts, source-manifest digest, target
commit, base-generation identity and observed parser/configuration evidence.
Candidates always declare `seedReady=false`; incomplete evidence is preserved.
The writer enforces 64 MiB total, 100,000 records, 256 KiB lines and shared
allowance charges. Failure removes owned output and refunds successfully deleted
artifacts; pipeline/database/progress failures preserve the previous generation.
Opt-out retains normal generation timing. Two Sol-medium developers and two
Luna reviewers handled disjoint implementation and review packets.

Current validation: 61 tests across candidate persistence, snapshot persistence
and parse lifecycle suites passed; TypeScript and four-file whitespace checks
exited 0. Two suite invocations and two typechecks ran after the writer's final
identity snapshot, count recheck and manifest-I/O regression additions.
Bounded OntoIndex verification passed file scope, with symbol scope skipped.
Next: reject corrupt/mismatched candidate inputs through an admission reader,
prove supported-language completeness and replay parity, then integrate
source-owned graph replacement and runtime/performance acceptance. No build,
install, connection switch or seed activation accompanied this checkpoint.

2026-10-23 generation initialization cleanup: `runFullAnalysis` now initializes
LadybugDB inside its existing failure handler. Initialization failure removes
the unpublished staged generation and preserves the previous `current` symlink
and graph, metadata and snapshot bytes. The original error is rethrown before
graph loading or publication. Snapshot persistence suite: 41 tests passed;
`tsc --noEmit --incremental false` and scoped whitespace check exited 0.
Bounded OntoIndex verify_diff passed file scope; symbol scope was skipped.

Next persistence bridge: create the existing staged generation before the
pipeline and stream bounded candidate records during the awaited retention
consumer, before parse disposal. Extend existing failure cleanup to parse errors.
Keep candidate-only evidence and `seedReady=false` until complete admission,
identity, corruption rejection and replay parity are proven. No new store,
background consumer or disposed handle in PipelineResult. Source identity is
bounded workspace-file evidence, without loaded-code or grammar attestation.
The umbrella's duplicate CATCH-IMPL state remains pending supported migration;
accepted execution-plan receipts must not be copied into it.

2026-10-23 parser identity handoff checkpoint: opt-in parse retention now
observes the same parser-code identity again after final capture flush and before
transfer. A changed hash preserves the initial value and records conflict; a read
failure records unavailable evidence without changing normal graph output.
Four real sequential cases cover matching/changed/final-unavailable/both-unavailable
observations, two calls, exact evidence reasons, full baseline graph equality and
allowance refunds. Three suites passed347tests; TypeScript exited0. One suite
invocation and one typecheck consumed. Four agents participated including two
Sol-medium developers. Endpoint comparison is not an atomic code snapshot or
loaded-grammar authentication and cannot detect change-and-revert. No new
build/install/connection switch. Full seed admission, generation persistence,
source-owned graph replacement and runtime/performance acceptance remain open.
seedReady=false; structured duplicate CATCH-IMPL selection unchanged.

2026-10-23 retained parser identity checkpoint: the existing fifteen-file
parser-code hash now has one shared internal owner in tree-sitter/parser-identity.
Workspace capture and opt-in parse retention use that same algorithm; ordinary
parsing performs no identity reads. Retained input evidence adds nullable
parserCodeIdentity with lowercase64hex validation, conflict/unavailable reasons,
shared input-byte admission, idempotent duplicate observation and disposal refund.
Identity-read failure preserves legacy graph output while recording unavailable
evidence. Missing null alone preserves prior direct-stage source/config completeness
semantics; completeness is not a seed-admission assertion. Four suites passed
423tests across two invocations; TypeScript exited0. Four agents participated
including two Sol-medium developers; children launched no tests/builds.
No build/install/connection switch follows this source change. Explicit complete
seed admission, loaded grammar/base/source identity and generation lifecycle
handoff remain open before persistence; graph replacement and runtime acceptance
follow. seedReady=false and structured duplicate CATCH-IMPL selection unchanged.

2026-10-23 parser-code identity checkpoint: workspaceParserIdentity now
domain-separates and frames fifteen ordered logical filenames plus raw bytes.
The existing cache identity now includes scope provider/capture/extraction,
finalization and reference-resolution/emission code instead of package/loader
alone. Source and compiled paths use their active module extension. Seven
implementation-mutation regressions and missing-file rejection pass through both
configuration and capture entry points. Workspace capture suite passed79tests;
backend overlay and TOCTOU suites passed118tests; production TypeScript exited0.
Two test invocations and one typecheck consumed. Four agents participated
including two Sol-medium developers. This is bounded analyzer-code identity,
not loaded grammar binary authentication or a complete replay seed. No build,
install or active connection switch followed this source change; prior local
candidate predates it. Full identity/completeness admission, persistence,
source-owned replacement and runtime/performance acceptance remain open.
seedReady=false; structured duplicate CATCH-IMPL selection unchanged.

2026-10-23 lifecycle/build checkpoint: graph capture completion getters now
check cancellation/deadline/disposal, and disposal resets both flags synchronously.
Previously cleared graph records could leave completion flags true. Three new
lifecycle regressions plus existing parse/retention suites passed 326 tests;
TypeScript no-emit and native Linux build exited 0. Tarball pack and isolated
offline install passed; first CLI start failed missing LadybugDB native module
after scripts-disabled install. Existing npm rebuild corrected native setup;
CLI rc.12, four native imports and installed lifecycle smoke then passed.
Candidate: /home/er77/.local/opt/ontoindex-2.3.5-rc.12-replay-20261023d.
Tarball SHA256: 128999800518d3ad8bf0af137bd5ddd9d866e6042299fc8eba201f18770066f6.
Built/installed retention module hashes match. Installed MCP facade smoke passed
seven calls, evidence /opt/d1/tmp/ontoindex-replay-smoke-20261023d.
Active CLI/MCP connection unchanged. No new release version or external publish.
Manager reconcile succeeded without changing duplicate CATCH-IMPL selection.
Four agents participated including two Sol-medium developers. Complete-input
admission and actual loaded parser/config/base identity remain prerequisites;
parse currently disposes capture before generation creation. Persistence,
source-owned replacement, large-workspace performance and full lifecycle
acceptance remain open; seedReady=false. Build/install candidate does not close
those gates.

2026-10-23 late-target/chunk replay checkpoint: retained unresolved calls now
survive producer cleanup and resolve after a unique imported target is registered
without reparsing the caller. An independent full-model baseline matches; two
imported same-name candidates remain unresolved and an unrelated decoy is rejected.
Sequential alias replay covers four grammars in declaration-first and
consumer-first order across two chunks, verified through parse-plan telemetry.
Synthetic scan sizes force chunk boundaries while identity hashes actual small
source bytes. Two complete suites passed 201 tests; production TypeScript exited
0. Two suite invocations and one typecheck consumed; four agents participated
including two Sol-medium developers. Persistence research confirms the existing
generation publication owner and rejects archiving observed inputs as a complete
seed. Generation/parser/config/base identity admission, complete supported-input
coverage and atomic publication validation remain before persistence activation.
Source-owned replacement, runtime/performance acceptance and fresh build/install
remain open; seedReady=false and structured CATCH-IMPL selection unchanged.

2026-10-23 full-pipeline recovery checkpoint: the existing real worker-thread
protocol-error matrix now decodes all eleven retained families and reconstructs
the legacy graph through existing model/import, call and assignment consumers.
All four TS/TSX/JS/JSX cases match complete normalized fixture nodes and
relationships after producer context cleanup and graph mutation. Empty input
families remain valid; native crashes and broader syntax are not covered.
A separate real sequential zero-allowance test preserves nonempty legacy graph
and calls while retention is incomplete with zero family records; disposal
preserves the zero allowance. Five targeted tests passed across two runs;
one earlier filter invocation selected zero tests. Production TypeScript exited
0. Three test invocations and one typecheck consumed; four agents participated,
including two Sol-medium developers. Persistence admission, source-owned
replacement, runtime/performance acceptance and fresh build/install remain open.
seedReady=false; duplicate structured CATCH-IMPL selection is preserved.

2026-10-23 grammar/recovery replay checkpoint: retained sequential alias replay
now passes for TS, TSX, JS and JSX with source/config identity, complete fixture
relationship equality and missing-import negative controls. A real worker-thread
protocol-error test now compares retained scope finalization, resolution and
emission against pre-cleanup captures after producer arrays/cache are cleared.
Typed annotation refusal remains incomplete with legacy calls preserved. This
lower-level scope-emitter check does not establish full recovered-pipeline seed
replay or native-crash recovery. Two suites passed 67 tests; production TypeScript
exited 0. The first recovery check exposed test-only ID/inventory assumptions;
those were corrected before the passing combined run. Three test invocations and
one typecheck consumed; two Sol-medium developers and two Luna reviewers were
used, with no child validation or background commands. Persistence, source-owned
replacement, measured runtime acceptance and fresh build/install remain open.
seedReady=false; structured duplicate CATCH-IMPL selection remains unchanged.

2026-10-23 structural relationship checkpoint: parse handoff now retains every
observed relationship except CALLS and ACCESSES reason write, which the current
replay resolvers regenerate. The eleventh family preserves IDs, endpoints,
type, confidence, reason and optional step/evidence through the existing bounded
two-pass codec. All family admission and disk-byte invariants include it;
replay/cancellation/disposal/refunds and completed-empty markers are covered.
Real sequential replay now compares the complete fixture relationship list,
using only retained nodes/structural edges plus regenerated CALLS, after producer
mutation. Three suites passed 443 tests; production TypeScript, scoped whitespace
and OntoIndex file-scope verify_diff passed (symbol scope skipped). Four children
(two Sol-medium developers, two Luna reviewers) ran no validation. One focused
suite and one typecheck consumed. The separate scope emitter uses step2 for
writes with descriptive reasons; it is absent from this parse path and requires
its own replay coverage before activation. Broader grammar/recovery parity,
persistence, source-owned replacement, runtime acceptance and fresh build/install
remain open. seedReady=false; manager duplicate CATCH-IMPL selection unchanged.

2026-10-23 graph-node retention checkpoint: parse now walks graph.iterNodes()
at handoff and captures observed nodes individually under shared byte/count
limits. The existing two-pass codec now also encodes JSON-compatible graph-node
records with extensible properties, strict data descriptors and bounded
bytes/depth/work. Undefined object fields are omitted in the explicit JSON
projection; unsupported data makes retention incomplete. The tenth family has
detached batched replay, cancellation/disposal/refunds and an empty/completed
capture marker. Real sequential alias replay now seeds nodes exclusively from
retained records and verifies independence after producer node mutation.
Three focused suites passed 428 tests; production TypeScript, scoped whitespace
and OntoIndex file-scope verify_diff passed (symbol scope skipped). Budget used:
one of two suites and one of one typecheck; four children ran no validation.
Two Sol-medium developers and two Luna reviewers contributed. Complete graph
seed/structural relationships, broader replay, generation persistence,
source-owned replacement and measured runtime acceptance remain open.
seedReady=false; no fresh build/install or active MCP switch. The structured
manager remains in-progress with duplicate CATCH-IMPL selection preserved.

2026-10-23 replay checkpoint: a nine-family synthetic fixture now compares
five CALLS and three production property writes from decoded retained inputs
against a fresh baseline. A real sequential two-file fixture preserves imported
alias CALLS, source/config hashes and a missing-import negative control; only
declaration nodes are copied into an otherwise relationship-empty graph.
Validation exposed a production overwrite in call-resolution/utils.ts:
same-file singleton constructor groups replaced earlier receiver indexes.
Grouping original bindings before verification now preserves every group and
cross-group ambiguity, matching the existing call owner. Committed impact LOW2.
After two fixture corrections and the bounded shared-helper repair, four suites
passed 492 tests; production TypeScript, scoped whitespace and OntoIndex
file-scope verify_diff exited/passed 0 (symbol scope skipped). Three suite runs
were consumed; the third addressed the newly proven product defect. Two Sol-medium
developers and two Luna reviewers contributed. Complete declaration-node seed,
broader replay coverage, generation persistence, source-owned replacement and
measured runtime acceptance remain open. seedReady=false; no build/install or
active MCP switch occurred. Structured duplicate CATCH-IMPL state is unchanged.

2026-10-23 import retention checkpoint: the existing V1 import snapshot now
accepts optional exact UTF-8 byte and outer/member entry limits. Incremental
copying preserves all four maps, empty file entries and insertion order; proxies
and accessors are refused without invocation. Parse captures the final import
maps as a ninth family under shared admission, cancellation, replay and refund
rules. Oversized state is explicitly incomplete; the singleton snapshot retains
the 256 KiB record ceiling. A bounded temporary escaped string can exceed its
remaining budget before rejection (at most a bounded multiple of record size).
Four focused suites passed 363 tests; after one added alias replay regression,
the affected retention suite passed 221 tests. Production TypeScript, scoped
whitespace and file-scope OntoIndex verify_diff passed (symbol scope skipped).
Two Sol-medium developers and two Luna reviewers contributed. Alias resolution
survives producer cleanup with a same-name decoy; complete CALLS replay remains
open. Next: identical-input graph replay, persistence, source-owned replacement,
workspace performance/lifecycle acceptance and fresh build/install. seedReady
remains false; structured manager state and prior installed candidate unchanged.

2026-10-23 retention checkpoint: finalized file-scope bindings survive worker,
sequential and mocked recovery cleanup through a lazy accumulator iterator.
Four focused suites passed 436 tests and production TypeScript passed. Semantic
registration observation preserves chronological adds and clears without a full
local journal; reentrant writes disable observation while preserving legacy
mutation and local capture. The observer now feeds an eighth shared-budget
retention family through the resolution context and parse owner. Five suites
passed 387 tests after one recovery-fixture correction; TypeScript and scoped
whitespace checks exited 0. OntoIndex file-scope verify_diff returned PASS with
symbol scope skipped. Two Sol-medium developers and two Luna reviewers contributed.
Next: bounded import-state retention, complete identical-input replay, generation
persistence, source-owned replacement and measured workspace/lifecycle acceptance.
seedReady remains false. The prior local build/install predates these changes;
the active MCP connection has not switched to a new candidate. The duplicate
CATCH-IMPL manager selection remains unresolved; tool-owned state is preserved.

Consolidated challenge review: existing-owner reuse, opt-in capture, detached
replay, explicit seedReady=false, shared limits and recovery fixtures are
strengths. Concrete defects were call-attempt limits resetting per batch and
inherited-field reads in call validation. Compared local repair, a generic
codec framework and producer trust twice; selected minimal local hardening.
Lifetime callCaptureAttempts, inherited-field rejection, required own mixed-chain
kind/name and null-prototype detachment now preserve the intended boundary.
Two Luna reviewers and two Sol-medium developers contributed. Three suites passed
298 tests, exit 0 (6.83s); production TypeScript and whitespace passed, exit 0.
Budget used one of two suites, one of one typechecks, zero corrections; children
ran no executable validation. No throughput/RSS benchmark was run.

Constructor/export continuation: the existing stage now retains original
constructor binding inputs and a distinct final downstream exported-type
snapshot. Worker constructor capture precedes cleanup; sequential capture
precedes verification. Both use shared six-family limits, detached replay and
lifecycle checks; seedReady remains false. Two Sol-medium developers and two
Luna explorers contributed. Constructor suites passed 324 tests; combined
constructor/export suites passed 351 tests (exit 0, 9.68s) and TypeScript passed.
One mocked-recovery export fixture expectation was corrected: its graph-derived
map is empty because that mock does not rebuild symbols. Final cancellation-loop
hardening passed two targeted export tests (47 excluded) and TypeScript, exit 0.
Explicit five-file OntoIndex verification passed with symbol scope skipped.
No build, install, performance measurement or workspace activation occurred.
Follow-up closed nonempty worker export snapshots after graph reconstruction
and final binding enrichment, plus actual UTF-8 byte batching and exact-boundary
packing for constructor/export records. Existing resolution-context factory now
accepts opt-in registration capture or restored model plus detached import state;
default capture remains disabled. Limited replay found and fixed same-file
constructor group replacement in buildFileReceiverTypeIndexes. Groups now merge
before verification, preserving ambiguity; unique-file arrays are borrowed and
duplicate-file arrays copied only once. Real retained singleton replay with model
and import restoration preserves two calls and two field writes. Six suites
passed 464 tests (9.86s), TypeScript and scoped whitespace passed, all exit 0.
Two Sol-medium developers and three Luna explorers contributed. Each code packet
used one of two focused invocations and one of one typechecks; children ran no
validation. Full pipeline replay still needs shared-budget model/import capture,
file-scope bindings and complete configuration/identity proof. seedReady=false.
Reflective own-key inspection has no strict peak-memory bound.

Native Linux build and package creation passed. Local candidate installed at
`/home/er77/.local/opt/ontoindex-2.3.5-rc.12-retention-20261023`; active CLI symlink
and session launch configuration remain unchanged. Offline install with scripts
disabled lacked native dependencies; one existing npm rebuild correction passed.
Installed CLI reports rc.12 and tree-sitter/LadybugDB native loads pass. Three
changed compiled modules match built SHA-256 hashes. Tarball SHA-256:
`c501bfa2f3d4b83bbded5ef285790d59d684b241bd45eba8050c1c64d99a6d1c`.
Isolated SDK MCP handshake and tool-contract status passed from installed path;
actual registry exposure is 14 tools, while the compatibility inventory is 54
plus eight facades. All eight default workspace probes still refuse
workspace_too_large (1832 indexed files, cap1600). Single refusal durations
26-120ms are diagnostic samples, not navigation performance acceptance.
No reindex, cap changes, connected-session switch or external publication.

Consolidated continuation order:
1. Harden validation and lifetime work bounds (implemented above).
2. Constructor/export retention and worker timing/byte-batching proof are complete
   for observed records; complete CALLS semantics still require replay acceptance.
3. Freeze supported/refused syntax and language inventory; compare retained
   replay with full resolution using identical source/configuration bytes.
4. Extend existing generation publication/pins/recovery for complete persistence;
   prove stale/corrupt/partial refusal and prune safety.
5. Implement source-owned replacement and dependency closure after replay parity,
   preserving clean callers and derived-data parity.
6. Run large-dirty eight-tool correctness and measured performance acceptance,
   then authenticate installed artifacts and disposable lifecycle behavior.

The structured manager still selects duplicate CATCH-IMPL. Reconcile it through
authenticated manager evidence; no task status or receipt is inferred here.
Forgotten boundaries: source changes are not installed MCP proof; test totals
are not all-language replay; encoded-byte limits are not an RSS limit. Large
workspace availability remains unresolved until the later acceptance gates pass.

Assignment retention slice: compared existing-handle observation, resolved-write
retention and graph reconstruction twice. Selected original observation because
the alternatives lose unresolved receivers and pre-enrichment input. The handle
now exposes captureAssignments/iterateAssignments, assignmentRecordCount and
assignmentEvidenceScope observed-parser-inputs. Four own required strings and
optional receiverTypeName are validated without invoking accessors/proxies;
undefined optional values are omitted. Scope/call/heritage/assignment share byte
and record limits, replay exclusion, cancellation and disposal refund ownership.
Worker capture precedes mutation/cleanup. Sequential onAssignment follows local
TypeEnv lookup and precedes constructor/class fallback. Callback absence skips
added source-ID and record allocation; graph behavior remains unchanged.
Two Luna explorers and two Sol-medium developers contributed. Three suites
passed 290 tests, exit 0 (6.79s); production tsc --noEmit --incremental false and
whitespace passed, exit 0. Bounded OntoIndex file verification passed; symbol
scope skipped. Budget used one of two suites, one of one typechecks, zero
correction rounds; children ran no executable validation. Tests cover typed,
unresolved and class-fallback originals, graph parity, mocked-worker cleanup,
real sequential retention and four-family disk replay/admission permutations.
seedReady remains false. Constructors, exports, complete replay and generation
persistence remain open. No build, installation or runtime activation occurred.

Heritage retention slice: compared extending the existing transient handle,
separate store and graph reconstruction twice. Selected the existing owner to
preserve unresolved original input without duplicate lifecycle infrastructure.
captureHeritage/iterateHeritage retain exactly four own string fields, including
provider-defined kind strings, under shared scope/call/heritage byte and record
limits. Bounded replay, strict proxy/accessor/shape rejection, cancellation,
deadline and idempotent disposal/refund use existing lifecycle ownership.
Worker capture precedes enrichment/cleanup; sequential capture precedes prepass
array clearing. The prepass already includes Ruby call-based heritage, so the
later Ruby pass is not captured twice. Ruby parity remains source-reviewed.
Two Luna explorers and two Sol-medium developers contributed. Two focused suites
passed 135 tests, exit 0 (6.18s); production tsc --noEmit --incremental false and
whitespace passed, exit 0. OntoIndex explicit-file verification passed with
symbol scope skipped. Budget used one of two suites and one of one typechecks;
zero correction rounds and child executable validation. Tests prove mixed-family
replay accounting, producer/replay isolation and worker/real sequential TS cleanup.
heritageEvidenceScope is observed-parser-inputs; seedReady remains false.
Assignments, constructors, exports, complete replay and persistence remain open.
No build, installation, index refresh or runtime activation was performed.

Typed-parameter diagnosis: validateDeclaration in typescript-captures.ts refuses
parameter annotation children; the atomic refusal unit contract explicitly
includes value:string. The lower-level binding helper accepts annotation fields,
but that does not establish whole-file composer support. Compared allowing
annotations, weakening scope acceptance and testing explicit refusal with legacy
survival twice; selected the third without production semantic expansion.
Two TS/TSX sequential cases and plain/typed real protocol-error recovery cases
verify empty scope artifacts, failed/scope-extraction-error, incomplete retained
scope inventory, preserved symbols/CALLS and retained original calls. Four cases
passed, 74 excluded, exit 0 (1.74s). Budget used one of two focused invocations,
zero builds/typechecks/corrections; four agents contributed and children ran no
suite/build/format. OntoIndex explicit-file verification and whitespace passed;
symbol scope was skipped. Annotation support remains a capture inventory gate.

Worker recovery verification: compared mocked rejection, controlled real-worker
protocol failure and production parser crash injection twice. Selected real
thread protocol failure with existing pool and production sequential recovery;
only the full-pipeline pool factory is redirected to a temporary error worker.
Actual parsing/resolution are used. Five targeted cases pass across the parsing
owner and TS/TSX/JS/JSX pipeline, preserving original calls once after cleanup,
resolved edges, unavailable seeds and restored allowance. This covers controlled
protocol failure, not native parser crashes or partial-result failure recovery.
First invocation exited 1 (four passed, one failed: typed-parameter fixture
produced no scope artifact). A parameter-free fixture correction preserved scope
acceptance; final invocation exited 0, five passed and 36 excluded (1.97s).
The subsequent diagnosis above confirms intentional annotation refusal. Budget consumed two of two
focused invocations and one of one correction rounds; no builds/typechecks,
children ran no executable validation. Four agents contributed (two Luna
explorers and two Sol-medium developers). Scope remains test-only.

Call-retention verification extension: every registered tree-sitter provider has
a call extractor; COBOL uses its standalone processor. Compared providerless
fallback, shared extraction refactor and real-provider regression extension twice;
selected regression extension without speculative production changes. TS/TSX/JS/JSX
now exercise sequential and mocked recovery-handoff retention. Java method-reference
coverage asserts unresolved capture exactly once, original receiver heuristic,
unavailable arity and unchanged graph/heritage beside a resolved ordinary call.
Two Luna explorers and two Sol-medium test developers contributed. Two suites
passed 171 tests, exit 0 (6.33s). Budget used one of two suite invocations, zero
typechecks and zero correction rounds; children ran no validation. Production
typecheck was unnecessary for this test-only extension. Live recovery, other
CALLS dependency families and complete seed replay remain open. No build,
installation, refresh or runtime activation was performed.

Sequential provider-call retention slice: processCalls accepts an opt-in observer
and captures special/generic provider extraction before resolution and receiver
enrichment. Generic observation follows routing and built-in filtering. Callback
absence skips added extraction, inference and record allocation. The existing
retention handle captures these records under observed-parser-inputs;
seedReady=false. All registered tree-sitter providers have call extractors;
COBOL uses a standalone processor. No production missing-extractor gap is
established. Other CALLS dependency families remain incomplete.
Real TS extraction covers unresolved calls, original argument
and receiver metadata, function identity and callback-off graph parity. Sequential
and mocked recovery-handoff tests replay originals once after cleanup; this does
not establish live worker-failure recovery or all-language parity.
Validation: three focused suites passed 241 tests, exit 0 (6.67s); production
tsc --noEmit --incremental false and whitespace passed, exit 0. Explicit-file
OntoIndex verification passed with symbol scope skipped. Four agents contributed
(two Luna explorers, two Sol-medium developers); children ran no validation.
Budget used one of two suite invocations and one of one typechecks; the source
correction addressed the TS generic-extractor name-capture requirement before
validation. No build, installation, reindex or runtime activation was performed.
The older worker-only evidence-scope literal below records that earlier slice.

2026-10-23 CALLS decision: original worker calls are enriched in place before
resolution and cleared afterward. Scope retention currently omits these records.
Compared extending the existing opt-in handle (selected), a separate callback or
store (duplicate lifecycle/configuration), and copy-on-enrichment (does not retain
through cleanup). Second review requires capture before enrichment, nested-array
detachment, lossless undefined argument-type slots, strict shape/size validation,
shared byte/count limits, cancellation and disposal accounting. Extend the same
retention owner with bounded in-memory encoded observed worker-call records;
retain the 64 MiB shared ceiling and explicit worker-only evidence scope. This
bounded step does not establish sequential CALLS coverage or complete replay.
Two Luna reviewers and two Sol-medium developers have disjoint source/test
packets; validation budget is two foreground suites, one typecheck and one
correction round. No child validation or build/reindex is authorized in this packet.
Execution: existing retention handle now captures calls before chunk receiver
enrichment/cleanup and replays detached batches through iterateCalls. Strict
shape, nested-array and undefined-slot handling share existing byte/count and
disposal budgets; callEvidenceScope is observed-worker-inputs and seedReady=false.
Encoded records remain in memory within the shared artifact-byte ceiling; this
is not an RSS limit or persistent seed store. First suite exited 1 (100 passed,
nine stale provider-fixture assumptions); one correction made missing-hook
coverage explicit and forwarded registered hooks in actual-provider fixtures.
Final two suites passed 109 tests, exit 0 (5.24s); production TypeScript,
whitespace and explicit-file OntoIndex verification passed, symbol scope skipped.
Budget used two suites, one typecheck and one correction; children ran none.
Pipeline mutation/cleanup proof uses explicit mocked worker/enrichment data.
Sequential/recovery call extraction, heritage/assignment/constructor/export
retention, full CALLS replay and complete seed readiness remain open.

2026-10-23 live-worker decision: compare existing native build plus compiled
worker acceptance (selected), a TypeScript worker loader (extra runtime path,
does not prove packaged resolution), and synthetic transport alone (cannot prove
production extraction). Second review requires identical fixture paths/source,
exact artifacts and extraction outcomes, native Map preservation, unsupported
whole-file refusal with legacy symbols retained, collected/streamed parity and
worker cleanup. Extend existing worker-pool and retention fixtures only.
Budget: one native build, two foreground suite invocations, one correction round;
children run no validation. Existing build completed exit 0, rewrote 207 files,
and bundled cached Linux native/extension artifacts with extension fetch disabled.
Compiled worker SHA-256:
`521cf28bcffe589e728e0188fde3426f423064483ed8ca454238b9d68b0eca5c`.
This local artifact passed the targeted worker validation below; it does not
authenticate the connected MCP process or a published installation.
First focused run exited 1: four production-provider retention cases passed,
two live-worker cases matched ParsedFiles exactly but failed an outcome-order
assumption. The worker groups files by language to minimize parser switches
(`parse-worker.ts:865`); compare outcome inventories by path with duplicate
checks rather than changing production scheduling. One correction changed the
test inventory comparison only; no production scheduling changed. Final focused
run passed six tests in two files, exit 0 (1.77s); 83 other cases were excluded
by the test-name filter. Two collected/streamed real compiled-worker cases cover
four grammars, exact source-provider artifact parity, Maps, catch/body bindings,
module vars, imports/exports, typed failed extraction and retained legacy nodes.
Four existing retention cases now consume production-provider bridge artifacts
and preserve mutation isolation, exports and cross-file finalization parity.
Native build includes TypeScript compilation; no separate typecheck was run.
Whitespace and explicit-file OntoIndex verification passed; symbol scope skipped.
Budget consumed one build, two suites and one correction; children ran none.
Two Luna reviewers and two Sol-medium developers contributed bounded packets;
the coordinator applied the final ordering correction after stopping its writer.
seedReady remains false. CALLS retention before mutation, complete language
coverage, all-language seed replay/publication, graph replacement, large dirty
workspace acceptance and performance remain open.

2026-10-23 provider execution: production TypeScript/JavaScript providers now
register one shared borrowed-root emitter and the existing binding-host,
canonical-binding, import and export hooks. Two Luna reviewers and two Sol-medium
developers completed disjoint packets. Four-grammar tests use actual registered
providers through direct bridge, sequential parsing and rejected-worker fallback;
module vars/catches, imports/exports, CALLS parity, no reparsing, detached results
and legacy symbols on unsupported-source refusal are covered. First suite exited
1 (437 passed, eight new fixture scope-selection failures); one correction
selected exception blocks by range. Final four suites passed 445 tests, exit 0
(5.13s); production TypeScript and whitespace exited 0. Budget used two suites,
one correction and one typecheck; children ran none. Explicit-file OntoIndex
verification passed with symbol scope skipped. Both provider impacts were LOW
in the committed snapshot; current changes were verified from source.
This activates additive extraction of the supported subset only. No fresh dist
worker was built/run; real worker extraction, complete semantics, registry-primary
activation and full replay/publication remain open. ScopeRetentionStage still
declares seedReady=false. Next: fresh compiled-worker extraction/transport parity.

2026-10-23 provider decision: register the existing composer plus binding-host,
canonical-binding, import and export hooks on both TS/JS providers. Compared
complete hook registration, emission-only registration and a separate reparse
path twice. Complete registration preserves semantics through the existing
bridge; emission alone omits interpretation and reparsing duplicates ownership
and parse cost. Require a borrowed root, preserve strict whole-file refusal and
legacy parsing, and leave registry-primary selection and seedReady unchanged.
The supported subset is bounded by composer acceptance/refusal tests; this
registration cannot establish complete language coverage. Sequential and
rejected-dispatch fallback can be tested from current source; real worker
extraction requires freshly built dist and remains a separate acceptance gate.
Current packet budget: two foreground suite invocations, one production
typecheck, one correction round; children run no validation.

2026-10-23 module-try execution: two Luna read-only reviewers and two Sol-medium
developers completed disjoint source/test packets. Existing traversal accepts
module try/catch/finally; module returns refuse, module vars share one batch,
and nested hoisted vars participate in import collision validation. Catch/block
lexicals retain local ownership. Four-grammar tests cover source-order references,
canonical repeated vars, exports, shadowing, detached replay and atomic refusal.
First suite exited 1 (493 passed, four new fixture-order failures); one correction
removed incidental definition-order assumptions. Final three suites passed 497
tests, exit 0 (4.95s). Production TypeScript exited 0. Budget consumed two of two
suites, one correction and one of one typechecks; children ran none. Explicit-file
OntoIndex verification passed with symbol scope skipped. Composer impact remains
UNKNOWN/not-in-index; workspace preparation exceeds its cap and committed graph
excludes these untracked files. Production-provider/worker acceptance stays open.

2026-10-23 roadmap challenge: parser-to-registry tests, detached replay and
existing-owner reuse provide useful bounded evidence. The principal weakness is
integration lag: capture test totals do not establish production-worker
extraction, large-workspace navigation or published seed correctness. Remaining
syntax must have an explicit supported/refused inventory rather than an
unbounded sequence of helper packets.

For module exception blocks, compared continued refusal (lowest change cost,
coverage gap persists), a separate module walker (independent control but
duplicated validation and drift), and shared traversal with one module-var
batch (selected). Second review requires module return refusal, import/lexical
collision checks, catch/block isolation, source-order references, repeated-var
canonical identity and detached replay. Existing extraction selects canonical
vars by source position; batching shares environment validation work. Rollback
is limited to composer routing and focused tests. No provider activation or
performance improvement is claimed by this packet.

Consolidated next order: complete this bounded module-try packet; freeze a
supported/refused capture inventory and both-provider activation seam; prove
production-worker/sequential/fallback parity; retain CALLS before mutation;
establish complete all-language SEED publication/replay; implement bounded
replacement; validate eight-tool dirty-workspace behavior and performance on
identical captured bytes. Deployment identity and disposable lifecycle proof
remain independent acceptance work. Preserve authenticated manager state while
its duplicate CATCH-IMPL selection awaits supported reconciliation.

2026-10-23 named-catch composition: reused the existing catch-binding helper
after comparing continued refusal, duplicate binding logic and helper reuse.
Two Luna reviewers checked semantics; two Sol-medium developers separately owned
composer and tests. Simple identifier parameters bind in their catch-clause
scope across TS/TSX/JS/JSX, with distinct nested/sibling identities and correct
outer/finally lookup. Tests cover lexical shadowing, var/lexical collisions,
unsupported syntax and detached replay. Three foreground suites passed 481
tests (4.79s), exit 0; production TypeScript and explicit whitespace checks
exited 0. Explicit-file OntoIndex verification passed with symbol scope skipped.
Typed/destructured/escaped catches and module try remain refused. Provider,
CALLS, SEED and runtime acceptance gates remain open; structured manager state
is unchanged.

2026-10-23 optional-binding catch composition: extended the existing strict try
branch after comparing refusal, a separate exception walker and owner reuse
twice. Two Luna reviewers checked scope/var behavior; two Sol-medium developers
owned source and tests separately. Function/generator bodies accept parameterless
catch clauses with optional finally, validating exact syntax and traversing
try/catch/finally bodies in source order. Existing catch-clause/body scopes remain
separate; no parameter declarations are synthesized. Four-grammar cases verify
nested ancestry, local isolation, canonical var identities, detached references
and atomic refusals. Named/typed/destructured catches, malformed contents and
module try remain refused. Three foreground suites passed 473 tests, exit 0
(9.27s); production TypeScript and explicit whitespace checks for both untracked
files exited 0. Budget used one of two suites and one of one typechecks; children
ran none. Explicit-file OntoIndex verification passed with symbol scope skipped;
composer impact was UNKNOWN/not-in-index and source supplied authority. Complete
capture/provider activation, CALLS retention and replay remain open; authenticated
manager state remains unchanged.

2026-10-23 function-body try/finally capture: selected strict block routing over
continued refusal or a separate exception walker after two reviews. Two Luna
explorers checked ownership and edge cases; two Sol-medium developers separately
owned composer and tests. Validated try/finally nodes queue existing block
traversal in source order with separate lexical-name sets. Four-grammar cases
cover nested blocks, throws/returns, canonical parameter/var identities, sibling
lexical isolation and detached captures. Catch-containing forms, module try,
malformed structure, unsupported contents and binding collisions remain refused.
Three foreground suites passed 461 tests, exit 0 (10.81s); production TypeScript
and explicit whitespace checks for both untracked files exited 0. Budget used
one of two suites and one of one typechecks; children ran none. Explicit-file
OntoIndex verification passed with symbol scope skipped; composer impact was
UNKNOWN/not-in-index, so source supplied authority. Bare imports remain refused
until their dependency effects have a supported representation. Complete capture,
provider activation, CALLS retention and full replay remain open. Authenticated
manager state remains unchanged.

2026-10-23 module throw capture: reused the validated return/throw helper with
a four-line module routing branch. Compared continued refusal, duplicate handling
and helper reuse; two Luna reviewers confirmed ownership and refusal boundaries,
and two Sol-medium developers owned source and tests separately. Four-grammar
tests assert exact reference order/ranges/arity/module scope and equality against
an equal-width expression baseline for declarations, imports, exports and scopes.
Literals and grouped multiline values pass; malformed throws, prefix line breaks,
unsupported operands and module returns remain refused. Three foreground suites
passed 334 tests, exit 0 (13.67s); production TypeScript and explicit whitespace
checks for both untracked files exited 0. Budget used one of two suites and one
of one typechecks; children ran none. Explicit-file OntoIndex verification passed
with symbol scope skipped; composer impact was UNKNOWN/not-in-index and source
was authoritative. Complete captures/provider activation, CALLS retention and
full replay remain open. Authenticated tracker state remains unchanged.

2026-10-23 throw-value capture: two Sol-medium developers extended the existing
composer and its tests after two Luna discovery/challenge packets. Compared
continued refusal, a separate walker and shared return-value traversal twice;
selected shared traversal with a strict throw boundary. Declared function and
generator bodies, nested blocks and braced conditionals capture supported thrown
literals, identifier reads and call/constructor trees. Throws require a value
without prefix line terminators, including comment-contained Unicode separators;
grouped multiline values remain supported. Module throws and unsupported values
remain refused. Four-grammar tests verify exact references, ownership, ranges,
order, detached captures and atomic refusal; existing return ASI tests pass.
Three foreground suites passed 322 tests, exit 0 (8.13s); production TypeScript
and explicit whitespace checks for both untracked files exited 0. Budget used
one of two suites and one of one typechecks; children ran none. Explicit-file
OntoIndex verification passed with symbol scope skipped. Composer impact was
UNKNOWN/not-in-index, so current source supplied authority. Complete captures,
provider activation, CALLS retention and full replay remain open; authenticated
tracker state remains unchanged.

2026-10-23 real-thread artifact transport: reused the production worker pool
and its temporary-worker test pattern after comparing provider activation,
codec-only proof and real message transport. Two Sol-medium developers owned
disjoint worker integration and protocol tests; two Luna explorers reviewed seams.
Four real-thread cases cover result parts/final results with collected/streamed
delivery. Nonempty artifact Maps, references and emitted graph output match the
direct baseline. Two protocol regressions prove ordered merge survives producer
array cleanup while retaining artifact identity, and codec replay detaches nested
state from source mutation. No merge deep cloning or provider activation added.
Protocol suite passed 10 tests, exit 0 (1.05s); filtered worker suite passed four
tests, exit 0 (0.982s), with 23 unrelated cases skipped by name filter. Production
TypeScript and scoped whitespace exited 0; explicit-file OntoIndex verification
passed with symbol scope skipped. Budget used two of two suite invocations and
one of one typechecks; children ran none. This proves synthetic artifact
transport through a real thread, not production-worker artifact extraction.
Complete captures/provider coverage, production extraction parity, activation,
CALLS retention and full replay remain open. Authenticated tracker state remains
unchanged, including the duplicate CATCH-IMPL selection.

2026-10-23 fallback graph parity: two Sol-medium developers extended existing
test owners after two Luna discovery packets. Eight cases cover four grammars
in sequential and mocked-dispatch-rejection fallback modes. Artifacts finalize,
resolve and emit after AST cache disposal; exact caller-to-target edges and
complete emitted graph data match direct extraction. Mocked worker/recovery
retention cases now carry nonempty definitions and references, compare direct
and retained output after producer arrays clear, and preserve one unresolved
call and seedReady=false. Captured source text matches the synthetic call fixture.
Three foreground suites passed 98 tests, exit 0 (6.24s); production TypeScript
and scoped whitespace exited 0. Budget used one of two suites and one of one
typechecks; children ran none. Explicit-file OntoIndex verification passed with
symbol scope skipped. Committed depth-one parser impact was LOW; a broader
agent query reported HIGH, so production parser code remained unchanged.
Live worker-thread serialization, complete provider coverage, activation and
full replay remain open. Existing authenticated manager state is preserved.

2026-10-23 retention-consumer integration proof: reused the existing parse-phase
consumer and disposal owner after comparing unconditional activation, a new phase
and test-first seam validation. Two Sol-medium developers extended disjoint
fallback and lifecycle tests; two Luna explorers reviewed ownership and fixtures.
Four-grammar parser artifacts now finalize, resolve and emit the exact local call
into a fresh graph. Real retention lifecycle cases cover admitted inputs,
incomplete inventory and cancellation after draining; refusal precedes finalization
and emission, preserves the graph and original error, and releases allowance.
The callback supplies the admission policy in these fixtures; no production
activation or automatic completeness gate was added. Input identity completeness
does not establish semantic capture completeness, and seedReady remains false.
Three foreground suites passed 96 tests, exit 0 (5.50s); production TypeScript
and scoped whitespace exited 0. Budget: one of two suites and one of one
typechecks; children executed none. Explicit-file OntoIndex verification passed
with symbol scope skipped. Sequential real-parser coverage and lifecycle admission
are proven; live-worker/fallback finalization parity, complete capture/provider
coverage and pipeline activation remain open. Authenticated tracker state is
unchanged; its duplicate CATCH-IMPL selection remains unresolved.

2026-10-23 cross-file capture/finalizer boundary: two Sol-medium developers added
real-parser tests in finalize-orchestrator.test.ts and scope-retention.test.ts;
two read-only agents inspected existing ownership and parity. Reused capture,
codec, retention and finalizer owners instead of a bespoke resolver or early
provider activation. Four-grammar cases prove explicit public exports, canonical
aliased import binding, private-import refusal, local shadowing and nonempty
reference sites. Detached retention survives original map mutation and preserves
finalized index contents. Foreground suites passed 81 tests, two files, exit 0
(1.08s); TypeScript and scoped whitespace exited 0. Budget used one of two suites,
one of one typecheck; children ran none. Explicit-file OntoIndex verification
passed with symbol scope skipped. Finalizer committed impact was LOW; current
dirty source supplied exact contract evidence. Suspected scopeTree/merged-binding
mismatch was not established as a product bug: the existing interface separates
structural scopes from finalized binding maps and resolution remains a later
phase. No production finalizer change landed. Tests use fixture import-target
resolution; production resolver and registry integration remain separate work.

2026-10-23 standalone-read packet: direct/grouped identifier expression statements
reuse the existing read helper at module, function, nested-block and braced-branch
positions. Two Sol-medium developers owned source and tests; two independent
auditors challenged admitted syntax. Foreground composer/reference suites passed
264 tests, exit 0 (6.24s); TypeScript and scoped whitespace exited 0. First run
had four test-fixture failures from mutating the expected result through a
capture range; snapshotting that expected result corrected the test. Budget:
two of two suites, one of one typecheck; children executed none. Explicit-file
OntoIndex verification passed with symbol scope skipped; helper impact was
UNKNOWN/not-in-index, so current source is authority.

2026-10-23 receiver-read correction: member calls now emit the original call
followed by a detached identifier read for their validated receiver, before
argument references. Selected helper reuse over rejecting member calls or
narrowing the usage contract after two reviews. Source and helper tests had
separate Sol-medium owners; a partial composer-test handoff was completed by a
replacement Sol-medium owner before validation. Independent source review found
no duplicate receiver traversal or changed free/constructor output. Exact helper
and composer expectations cover Unicode ranges, nested preorder, scopes and
independent metadata/read ranges. Four foreground suites passed 350 tests, exit 0
(9.45s), including provider bridge and fallback fixtures. TypeScript and scoped
whitespace checks exited 0. Budget used: one of two suites, one of one typecheck;
children ran none. Explicit-file OntoIndex verification passed with symbol scope
skipped; helper impact was UNKNOWN/not-in-index, so source is authority.
Production activation, full capture completeness, CALLS retention, seed
publication, graph updates and large dirty-workspace acceptance remain open.

2026-10-23 provider integration prerequisite evidence: fixture-scoped clones of
the real TS/JS providers now exercise the existing composer and interpreter
hooks through the bridge and sequential/crashed-worker fallback. Four-grammar
retention tests verify source hashes, canonical bindings/exports and failed-file
accounting; seedReady remains false. Two foreground suites passed 82 tests and
TypeScript no-emit passed. Production provider hooks remain absent. The expanded
export baseline passed 240 foreground export/declaration tests and TypeScript;
authenticated worker and independent challenger PASS are integrated; LEX-EXPORT
is DONE. Receipt:
role-result-344211e12a59fda50f5b463355f277178c89f8960af52b283581967bd276e606.

CALLS discovery identifies a mandatory parity boundary: worker payloads are
available before seedCrossFileReceiverTypes, whereas sequential processCalls
resolves directly from prepared AST/TypeEnv state. A worker-only snapshot is
insufficient. Reuse ScopeRetentionStage lifecycle and bounded schema validation;
observe canonical sequential inputs before resolution without creating another
parser/resolver. Include heritage, assignments, constructors and distinct export
evidence; fileScopeBindings alone are not equivalent to exported bindings.

2026-10-23 execution update: identifier initializers and function-body braced
conditionals are implemented in the current capture composer. Latest foreground
composer/reference suites passed 256 tests and TypeScript no-emit passed.
Lexical-export current-baseline review is complete with authenticated worker and
challenger PASS. The umbrella CATCH-IMPL selection remains a duplicate of accepted execution
work and must be reconciled through supported manager transitions.

Current source fixes the integration order: reuse the existing synchronous
borrowed-root hooks in languages/typescript.ts for both providers, then prove
sequential/worker/fallback outcome parity. ScopeRetentionStage still declares
seedReady=false. CALLS inputs must be retained before receiver enrichment and
cleanup; cross-file resolution still reparses source. Reuse repo-manager.ts
publication, rollback and reader pins for complete seed persistence. Establish
all-file seed replay parity before bounded dependency-closure replacement.
Extend existing automatic-dirty-workspace fixtures for eight tools and compare
against full analysis of identical captured bytes. No provider or runtime
activation is established by the capture results.

These are roadmap gates, not ready worker packets. Before dispatch, the coordinator
must discover exact owners/tests, compare three alternatives twice, then create
small tasks with explicit dependencies. Completion of the first two tasks must
handoff to a successor tracker; it cannot close the overall workspace goal.

Older checkpoints (before 2026-10-24) are archived in LUNA_WORKSPACE_COMPLETION_HISTORY.md.

Checkpoint 2026-10-24 (parity and base guard). Foreground validation: tsc exit
0, build exit 0, two files and nine tests passed. The replay parity test now
records per-producer coverage, persists a candidate before replay, and checks
worker, sequential and recovery coverage equality with seedReady false. The new
workspace-analysis-base-guard test covers both base-or-HEAD refusals with and
without CURRENT; disabling either guard in run-analyze.ts made exactly its two
cases fail, and the source was restored byte for byte. Reviewer findings,
unverified at phase boundaries: no test kills a real build after the CURRENT
rename or during candidate persistence, and hard-kill lease release is untested.
The supervisor process-group model discards unpublished output; it cannot undo a
published rename. First removeNodesByFiles consumer is test-only: a differential
harness against a full run over identical bytes. No production caller, no
seedReady change, no push.

Checkpoint 2026-10-24 (publication order, strict close, differential). Review
of the SIGKILL claim: with a successful close, a kill before the CURRENT rename
leaves the old pointer and a kill after leaves a complete generation, so the
earlier incomplete-CURRENT claim is withdrawn. A real defect was found instead:
runWorkspaceAnalysis closed the generation database without strict mode, so a
swallowed native close failure could be followed by publication. Fixed with
closeLbugForPath(..., { strict: true }); the new publication-order test failed
before the fix (two cases) and passes after. New tests: publication order (four
cases plus two close-failure cases), and a differential harness for
removeNodesByFiles (three scenarios against full-run oracles). The harness
documents a replacement gap: callers with unresolved calls never appear in
affectedSourceIds, so a replacement design must replay them too. Validation: tsc
exit 0, build exit 0, five files and 62 tests passed, differential three tests
passed. Open findings, not fixed: no explicit fsync protocol for power loss; an
unreadable published database stays selected and is not rebuilt; a standalone
CLI kill has no stale capture-directory reclamation; a 7001-file manifest is
estimated near 1.74 MiB against the 1 MiB cap (estimate, unmeasured) and would
fail with the typed manifest limit error. Local candidate installed at
/home/er77/.local/opt/ontoindex-2.3.5-rc.12-strictclose-20261024, tarball sha256
6ebdf0fa1e044b63f1e6772cfbdfdd9f55bcf05eedb0e3b043708b3460a8afe5, version rc.12,
All 716 built non-native js files matched the installed copy byte for byte. The
MCP config was not edited. No push, seedReady still false.

Checkpoint 2026-10-24 (real-workspace measurement, manifest cap). The real
pipeline over the 7033-file ontocode checkout, with scope retention and no graph
phases, took 32.7 s and 2.2 GB peak RSS (maxRSS, not a full analysis). Its
metadata measured 1,442,567 bytes against the 1 MiB manifest cap, so persistence
would have failed with the typed manifest limit error; the earlier 1.74 MiB
estimate was high. Fix: one shared MAX_MANIFEST_BYTES of 8 MiB, exported by the
reader and imported by the writer, replacing two separate 1 MiB constants. The
8 MiB value is a chosen headroom for roughly five times today's workspace, not a
derived bound. New test persists and verifies a 7000-entry manifest above 1 MiB;
it fails with the old limit and passes now. Real persistence over the same
checkout then succeeded: manifest 1,445,831 bytes, artifacts 31.7 MB of the 64
MiB allowance, 35.0 s, 2.1 GB RSS, status incomplete, seedReady false. Coverage
shows why replay stays unadmitted on this repo: 2561 Rust and 232 Python files
are refused as unsupported, 601 TS/JS files refuse unsupported-syntax, and 3636
extensionless or other files are unaccounted. Retention also hit its call, heritage,
assignment and graph record count limits. Validation: tsc 0, build 0, seven
scope-retention and run-analyze files, 473 tests passed. Installed
/home/er77/.local/opt/ontoindex-2.3.5-rc.12-manifestcap-20261024, tarball sha256
1d5af96bb58a02772b4ab0e12967349db566b316a597b6140b9a5ca54fa5e244; 716 of 716
built js files matched. MCP config not edited. No push.

Checkpoint 2026-10-24 (durable publication, capture owner, unparsed coverage, typed open
error). Four Sol-medium developers and four reviewers worked on disjoint write
sets; developers ran no tests. Changes: scope-retention coverage gains a numeric
unparsed bucket for unknown-language files with a missing outcome, so they no
longer block complete; durable-publish adds syncTree and syncPath, called before
the CURRENT rename (a native LadybugDB flush guarantee remains unverified); a
capture owner marker sits beside the capture root (inside it, the root is re-read
as a repository) and the next capture sweeps dead owners; LbugOpenError and a
conservative classifier replace string matching in the pool (step 1 only, no
quarantine yet). Foreground validation: tsc 0, whitespace clean, one aggregate
run of 26 files and 761 tests passed; mutation checks removing syncTree and the
strict close made their tests fail. Installed
/home/er77/.local/opt/ontoindex-2.3.5-rc.12-durable-20261024, tarball sha256
323ba7d6b38ebad36bf4fbb9892def2b1ce1211e9b285b5dc55fe9ff9b421565; 725 of 725
built js files match, the three new modules are present, lbugjs.node is present,
and an MCP handshake reports 2.3.5-rc.12 with nine tools. The client config
still points at the core-20261023c path and was not edited. No push. seedReady
stays false; gates 4 to 6 remain open.

Checkpoint 2026-10-24 (unreadable-database quarantine, replay planner, record
measurement). Two Sol-medium developers and two Luna reviewers worked on disjoint
write sets; developers ran no tests. Quarantine: withPinnedOverlay writes an
atomic, identity-bound READ_FAILURE.json beside the generation only for a typed
native-open failure of kind corrupt or incompatible on the admitted database, and
computeSnapshot then reports the generation unusable; lock, resource, permission
and unknown kinds write nothing. The runtime allows one automatic repair per
unchanged workspace input per process, keyed without generation or diagnostic
text, then fails closed. A pre-handler LbugOpenError maps to a preparation error
with no handler call. The pure replay planner returns a whole-file union only when
admission is proven and coverage complete, otherwise full analysis is required;
nothing calls it yet and admission stays unproven. Measurement over the 7033-file
checkout: the shared 100,000 record ceiling is spent by two families, model
registrations 89,455 records (27.8 MB) and calls 10,545 (2.5 MB), so heritage,
assignments, bindings, exports, imports and graph families retained zero; this
explains the earlier limit hits and means raising the cap is not the lever until
model registrations are bounded or budgeted per family. Validation: tsc 0; 14-file
aggregate 426 tests passed after fixing a stale parity expectation that lacked the
unparsed field; a mutation disabling the one-repair limit failed its test. Installed
/home/er77/.local/opt/ontoindex-2.3.5-rc.12-quarantine-20261024, tarball sha256
7c1a34b2b5d3480c32db9dd346dd1332756d32f0a7c4e4eb737d0d19855929bc; 726 of 726
built js files match and an MCP handshake reports 2.3.5-rc.12. The client config
still points at the core-20261023c path and was not edited. No push. seedReady
stays false; gates 4 to 6 remain open.

Checkpoint 2026-10-24 (retention demand under a wide cap, measurement only). A scratch
copy of dist with the 64 MiB and 100,000 ceilings raised (no source change)
measured true retained-record demand over the 7033-file checkout: calls 260,111,
graph relationships 159,240, model registrations 89,455, constructor bindings
22,063, exported types 21,200, graph nodes 10,620, assignments 8,283, heritage
1,424, file bindings 352, import states 0; about 573,000 records in total, roughly
six times the shared ceiling. The run still failed with the candidate record limit
and a graph-node byte limit, and the issue set kept unsupported, unsupported-syntax,
failed, missing-outcome and import-state-incomplete. Conclusion: raising or
rebalancing the cap cannot make this workspace complete, because Rust, Python and
TS/JS refusals dominate; a per-family budget is worthwhile only after capture
coverage exists, and the byte allowance would need to grow past 64 MiB too. No cap
was changed. Capture coverage for the refused languages is the gating work for gate 1.

Checkpoint 2026-10-24 (whole-file type-only TypeScript capture). Two Sol-medium
developers and one Luna soundness reviewer; developers ran no tests. Change:
emitTypeScriptCaptures accepts a file made only of comments, named import-type
statements and exported type aliases, and returns just the module scope capture;
every other shape, including mixed files, interfaces, re-exports and syntax
errors, still refuses. Validation: tsc 0; scope-resolution suite 25 files and
1139 tests passed after updating one existing rejection case to a mixed fixture;
disabling the branch fails 9 new tests; a sequential integration fixture reports
two type-only files retained and one mixed file refused with unsupported-syntax.
Real checkout result: 519 of 539 TypeScript files now parse cleanly and the
unsupported-syntax refusals on TS fell from 539 to 20 (JS 62 unchanged), but
retained stays 0 because those files report missing-artifact: the shared
100,000-record ceiling is already spent by model registrations and calls before
parsed-file records are stored. So coverage is not improved yet, and the
ceiling, not capture, now blocks them. Open soundness risk from the reviewer: a
retained file with no export captures makes a value import of a type name read as
resolvable-module, missing-export instead of unavailable, and the model cannot
represent the exported type; acceptable only while seedReady stays false and
coverage is descriptive, and must be revisited (capture type declarations and the
export surface) before any seed admission. Not built or installed. No push.

Checkpoint (2026-10-24, Gate 2 source-id cross-check): the candidate reader now rejects a calls or assignments record whose sourceId does not embed the record's own filePath (rule: text after the first colon equals the path or starts with path plus colon), for every retention status. Measured beforehand on the real 7,035-file checkout: 1,587/1,587 calls and 23/23 assignments satisfy it. Existing reader and auxiliary-paths fixtures were moved from function:example to Function:src/example.ts:example. Thirteen new cases cover foreign file, missing separator, path-prefix boundary, File/Function/Method shapes and an incomplete candidate. Thirteen scope-retention suites passed (536 tests), tsc exit 0, whitespace clean, two mutants caught. Installed candidate capture-20261024 predates this slice and needs a rebuild before the next delivery claim. Nothing is pushed.

Checkpoint (2026-10-24, delivery candidate srcid-20261024): rebuilt from the tree that includes the source-id cross-check and installed at /home/er77/.local/opt/ontoindex-2.3.5-rc.12-srcid-20261024. Tarball SHA-256 09ddac24244a7087ae919270d1a0e0b6f0e3ea2786bc459aa500e3544d9e8de3. All 728 dist JS files equal the build, the installed reader contains the new guard, and an MCP stdio handshake reports 2.3.5-rc.12 with the eight tools. This supersedes capture-20261024 for Gate 2. The connected MCP still runs core-20261023c until ~/.ontocode/config.toml line 46 is repointed to the new dist/cli/index.js and MCP is reloaded; host-side acceptance has not run. Older checkpoints (publication kill test through capture refusal diagnostics) moved to the history file. Nothing is pushed and no gate is complete.

Checkpoint (2026-10-24, Gate 3 edit differential): added test/integration/scope-retention-replay-edit-differential.test.ts. It captures all eleven families for a three-file TypeScript fixture, splices unchanged files' retained records with a changed file's fresh records, replays, and compares the CALLS and write-ACCESSES graph with a full run over the edited bytes. Six edits: removed call, added export that an unresolved call could use, renamed export, deleted file, added export plus a new import, and a new unimported file exporting a name an unresolved call uses. Every edit changes the oracle graph (asserted). All six matched with both the base and the edited import snapshot. An empty import snapshot diverges in every scenario, and two mutants (stale base calls, stale base registration events) were caught, so the harness can fail. Findings: calls and registration events splice per file by filePath (symbol.add) or def.filePath; import state is one workspace snapshot keyed by importing file; graph relationships have no file key and need an endpoint-to-file map; unresolved calls must be replayed after any export change. Limits: function-only TypeScript, no classes, types, re-exports, packages or other languages, and the base snapshot matching may come from global name lookup, so it is not proof for other shapes. This is evidence for an admission design, not admission: nothing is wired, seedReady stays false, no gate is complete, no push. Researcher notes: a sound invalidation set for import state is unverified, and changed files plus import dependents is not proven sufficient because global same-name lookup exists.

Checkpoint (2026-10-24, Gate 3 shape widening): the edit differential now has twelve scenarios. Measured capture status on thirteen small TypeScript shapes: retained are functions, an empty class with a new-expression call, namespace imports, directory-index imports, sibling-directory imports and same-name exports; refused as unsupported-syntax are classes with methods, named and star re-exports, default exports, interface and type exports, and const arrow exports, so a candidate holding any of those is incomplete and the replay planner already refuses it. Six added scenarios cover class rename, namespace member removal, directory-index rename, sibling-directory rename, deleting a same-name file and adding a same-name duplicate. All twelve match with the base and the edited import snapshot, each edit changes the oracle, and two mutants (stale base calls, stale base registration events) fail the new scenarios. A read-only source review of the call resolution tiers found that third-file edits can change an unchanged caller through package membership, global same-name lookup, class and method indexes, ancestry, interface implementors, constructor-binding return types and mixed chains, so file-level dependents are not a sound replay set; the sound choices are dependency receipts per call or replaying every retained call against the rebuilt complete context. Decision for the admission design: replay all retained calls whole against a context rebuilt from spliced records, and skip any selective narrowing, which the planner already does. Limits: small function and empty-class fixtures only, so the matches do not cover re-exports, ancestry or other languages (refused or unmeasured). Nothing wired, seedReady false, no gate complete, no push.

Checkpoint (2026-10-24, type-only export check): read the source behind the open type-only soundness risk. A type-only file is retained with only a module scope and no export captures, so its exports map is absent and finalize keeps its legacy simple-name lookup; the earlier wording about a missing-export reading does not appear in the source, so treat it as unconfirmed. Added two differential scenarios, a file turning from a type alias into a value export and back, with a value import and a call of the same name in an unchanged file. Both match the full run with the base and the edited import snapshot, and the harness now asserts that at least one side of every scenario contains a call. A third scenario, deleting a type-only file, produced no call edge on either side and was removed because it shows nothing. Limit: replay and the full run share the same resolution code, so these matches show that splicing preserves the producer's answer, not that the producer's answer for a type name is semantically right; the retained surface still cannot represent exported types, which stays a prerequisite for seed admission. Nothing wired, seedReady false, no gate complete, no push.

Checkpoint (2026-10-24, SIGABRT attribution attempt two): ran the compiled workspace-build-child on a fresh clone of the Ontocode checkout (10,306 tracked files, the two symlinks removed and the eleven oversized files ignored in the clone only) with core dumps enabled. Three builds under glibc malloc checking (the libc_malloc_debug preload with MALLOC_CHECK_ set to 3) exited 0 at about 168 s each, and five unchecked builds ran at 81 to 94 s; four exited 0 and the fifth failed at capture because the clone's pack file lost its index file mid-run, which is an unrelated clone fault and not the native abort. Across every child or in-process overlay build so far the tally is one abort in 17 completed builds, and the abort did not recur under gdb, malloc checking or plain runs, so it stays unattributed and no component is blamed. Real defect found on the way: the supervisor discarded the exit signal, so a child killed by SIGABRT reported 'exited with code null'. superviseWorkspaceBuild now keeps the signal and reports 'terminated by signal <SIG>' with the stderr tail; the error kind, cleanup, timeout and cancel paths are unchanged. Two Sol-medium developers; tsc 0; the supervisor and real-child suites passed (39 tests); a mutant that drops the signal text fails the new test. Not built or installed, so the installed srcid candidate does not include it. The throwaway clone was removed. Nothing wired, seedReady false, no gate complete, no push.

Checkpoint (2026-10-24, delivery candidate signal-20261024): built and installed one candidate that contains the source-id cross-check and the supervisor signal report, at /home/er77/.local/opt/ontoindex-2.3.5-rc.12-signal-20261024. Tarball SHA-256 a9124d5ce7175ff68f479d86873d061438f5a88edd8ad04267a52806f99769e9. All 728 dist JS files equal the build, the installed reader and supervisor contain both new strings, and an MCP stdio handshake reports 2.3.5-rc.12 with the eight tools. Seven of eight tools returned results (discover, search, inspect, impact, audit, manage, docs); refactor rename returned the same 'no valid overlay CURRENT generation' error as the earlier candidates because this repository has no dirty-overlay generation. This supersedes srcid-20261024. The connected MCP still runs core-20261023c until ~/.ontocode/config.toml line 46 is repointed to the new dist/cli/index.js and MCP is reloaded; host-side acceptance has not run. Nothing is pushed and no gate is complete.

Build-time checkpoint (2026-10-24): on a 10.3k-file Ontocode clone the supervised workspace build took 77 s with the default one parse worker (parse 42.6 s, communities 9.1 s, capture 8 s, load 9.8 s, FTS 5.2 s) and 60 s with four workers (parse 28.4 s, 4.8 GB peak RSS). The supervised child now gets ONTOINDEX_MAX_WORKERS = min(4, cpus/2) unless the operator already set a positive value (workspaceBuildChildEnv, SupervisedBuild.env). Deadlines (60 s caller wait, 120 s build) and the 1600-file cap are unchanged: 60 s is still above the caller wait, so the cap stays until a build under the wait is measured. Validation: 125 tests in the supervisor and runtime suites passed, tsc 0, whitespace clean, one mutant (env dropped) caught. Delivery candidate workers-20261024 is installed at /home/er77/.local/opt/ontoindex-2.3.5-rc.12-workers-20261024 (tarball SHA-256 0850f5e989191abca186d99c50c2243ee2e7af44810af82ac1e685b4e68a1d03, 728 of 728 dist files equal, handshake lists 8 tools). It supersedes signal-20261024. The connected MCP is not repointed and host acceptance has not run. Open: communities phase (about 9 s) is a skip candidate once the replay contract is checked; asynchronous build would remove the wait problem.


Decision checkpoint (2026-10-24): skipping the communities phase in the workspace build is rejected for now. The processes phase declares communities as a dependency, and execution flows and module data reach impact (processes_affected, modules_affected) and gn_explain_module, so a skip would silently remove data those tools return. It would save about 9 s of the 60 s build. The file cap stays at 1600: the build was timed on one clone in two runs (77 s and 60 s) while earlier timings varied between 77 s and 100 s, which is too little data to tie a cap change to. A cap change needs repeated timed runs and a test. An asynchronous build, or a coverage flag that marks an overlay as built without graph summary phases, would have to come first before any phase is skipped.

Repeat-timing checkpoint (2026-10-24): three more four-worker supervised builds of the 10.3k-file clone finished in 66.7 s, 64.6 s and 66.0 s with 4.2 to 4.6 GB peak RSS, all exit 0; together with the earlier 60.3 s run the range is 60 to 67 s. Parse took 29 to 31 s, communities 9 to 11 s, capture 8 to 10 s, storage load 9 to 10 s, FTS 5 s. Every run is above the 60 s caller wait, so the file cap and deadlines stay unchanged. Raising the cap would only move more repos into builds that exceed the wait; a cap change should follow an asynchronous build or a smaller measured build.

Async-build design checkpoint (2026-10-24): no new code is needed for the asynchronous behaviour. A caller that outlasts the 60 s wait receives workspace_timeout with retryable:true while the supervised build keeps running (limit 120 s), and the next request joins it (test 'lets the next request join a build that outlasted the previous waiter'). The gap is the file cap: workspace_too_large is non-retryable and refuses before any build starts. Measured with four workers: 3.9k-file ontoindex clone 30 s and 2.4 GB; 10.3k-file Ontocode clone 60 to 67 s and 4.2 to 4.8 GB. Candidate designs compared: (1) keep one cap, (2) a soft cap of 1600 for a synchronous wait plus a hard cap above it where the first call returns the existing retryable timeout while the build continues, (3) a full job API with a preparing status. Design 2 reuses the shipped join path and is the smallest; design 3 changes the caller contract. Two blockers apply to design 2 and need an operator decision: the cap is an explicit resource decision (about 5 GB per build), and the live Ontocode checkout refuses the workspace input within 1 s because it contains one tracked symlink and two tracked files over 512 KiB (.memory-bank/_lr_validate.md, .memory-bank/ontocode_internal_crate_rename-cargo-metadata.json, ontocode-rs/core/src/tools/handlers/multi_agents_tests.rs; the clone runs excluded 11 oversized files through .ontoindexignore). The server reports that refusal only as workspace_build_failed, build_failed, without the child's message. No cap, deadline or source change was made.

Input-refusal checkpoint (2026-10-24): the supervised build child exits with code 3 when workspace input capture is refused (a tracked symlink or a file over the 512 KiB scan cap), the supervisor classifies that as WorkspaceBuildError kind input_refused, and the server projects it as diagnostics { phase: build, reason: input_refused } with one fixed sentence that names .ontoindexignore. Paths and stderr are not forwarded. Three alternatives were compared: forward the child stderr (rejected, leaks private paths), a new top-level error code (rejected, widens the public contract), a typed reason inside the existing diagnostics (chosen). Validation: 344 tests in four suites passed, tsc 0, whitespace clean, two mutants caught (supervisor classification and server allowlist). End to end against the live Ontocode checkout with the new install: the child exits 3 with the refusal text and an MCP inspect call returns the typed diagnostic with no private text. Delivery candidate refusal-20261024 is installed at /home/er77/.local/opt/ontoindex-2.3.5-rc.12-refusal-20261024 (tarball SHA-256 e7c04fbdda2f13c9fb6d32a9e5f872b7cd8a77e214da1122115de7a332b3b274, 728 of 728 dist files equal, handshake lists 8 tools). It supersedes workers-20261024. The connected MCP is not repointed and host acceptance has not run. The soft and hard cap design stays open for an operator decision on the memory budget.

Review-and-correction checkpoint (2026-10-24): self-review of the input-refusal change found two defects, both fixed. (1) The build child exited 3 for every WorkspaceInputCaptureError, but the transient codes changed-input, timeout and cancelled say retry; a retry-able failure was reported as a deterministic refusal. The classification is now workspaceBuildExitCode in the supervisor module (duck-typed on name and code, no analyze-delta import): only limit and unsupported give 3, everything else 1. (2) The fixed hint named only a symlink or a file over the cap, but unsupported also covers resolver roots needing external inputs and non-regular files; the sentence now says an input the workspace capture refuses, such as a tracked symlink or a file over the scan cap, and to exclude it with .ontoindexignore where allowed. Validation: 355 tests in five suites passed (including the real-child cancel integration), tsc 0, whitespace clean, two mutants caught (changed-input mapped to 3, hint wording). Delivery candidate exit-20261024 is installed at /home/er77/.local/opt/ontoindex-2.3.5-rc.12-exit-20261024 (tarball SHA-256 6b3f4af1cab2ce2b3a639fca79082b58a5e65ee7c18f5725c7015713a13331c4, 728 of 728 dist files equal); against the live Ontocode checkout the child still exits 3 and the MCP call returns the typed diagnostic. It supersedes refusal-20261024. The connected MCP is not repointed and host acceptance has not run. Disk: / is at 94 percent with 5.3 GB free and 17 rc.12 installs of about 0.5 GB each; each new candidate costs 0.5 GB, so pruning needs the operator.

### Current-source review — 2026-10-24

Four bounded reviewers (two Sol-medium and two Luna) checked catch source,
acceptance tests, tracking consistency and runtime diagnostics. The catch helper
already exists. Review retained catch-clause Block ownership over body ownership
or a new shared scope kind; a second challenge found no concrete defect or
missing acceptance case. No production rewrite was warranted.

Fresh foreground validation: the two CATCH-IMPL suites passed 190 tests (exit 0);
`tsc --noEmit --incremental false` passed (exit 0); scoped `git diff --check`
passed (exit 0). Whole-tree whitespace checking reports pre-existing trailing
blank lines in the current-plan and pending-task projections. No build or install
was run. These checks establish current helper behavior, not runtime activation.

Committed OntoIndex context resolved the helper and impact reported LOW. HEAD
matches the indexed commit; 268 dirty entries are outside committed evidence.
Source confirms the supervisor merges child overrides into `process.env`.

The supported manager reconciliation completed without changing the duplicate
OPEN selection. Historical authenticated completion is claimed by MEMORY but is
absent from this task's structured closeout; no historical receipt was invented.
Next consolidate that execution state through supported completion evidence, then
freeze the next capture packet from current source. Preserve the existing cap
until resource policy is decided; prefer existing build joining and validated
snapshot reuse over skipped graph phases or silent committed fallback. Remaining
delivery work is connected-artifact acceptance, controlled dirty/cold fixtures,
complete capture and replay admission, and cancellation/rollback coverage.

| Stage | Depends on | Required acceptance | State |
| --- | --- | --- | --- |
| Capture | CATCH-IMPL | Remaining bindings, imports, declaration exports, reexports and references; explicit unsupported coverage | Open; split by syntax family |
| Provider | Complete capture | Sequential/worker/fallback parity and bounded environment validation | Gated; freeze activation seams |
| CALLS | Complete SCOPE/provider | Retain canonical calls before mutation plus heritage, assignments, exports and constructors | Gated; parse-impl, parse, cross-file-impl, call-processor owners |
| SEED | Complete MODEL, SCOPE, CALLS | Identity/completeness, atomic publication, pins/pruning, recovery | Gated; pipeline types, pipeline, run-analyze, repo-manager owners |
| Graph | SEED | Source-owned edge replacement, dependency closure, derived parity, clean callers preserved | Gated; exact write set required |
| Acceptance | Graph | Eight tools on large dirty fixtures; edit/delete/rename, limits, unsupported input and cancellation; parity against full analysis of identical bytes | Gated; no silent committed fallback |
| Deployment | Independent | Connected artifact identity, cold backend, continuation scope and CI result | Open; read-only after reconnect |
| Lifecycle | Disposable fixture ready | Success/refusal/stale state/rollback and preview/apply separation | Open; fixture first |

All supported language paths must meet completeness before advertising complete
replay capability. TS/JS alone cannot close SEED. Missing docs sidecar remains
unavailable. Keep committed-mode exclusions and resource limits explicit.
Overall completion requires runtime acceptance, deployment proof and lifecycle
acceptance; independent scheduling does not waive those gates.

## Required Traceability

2026-10-23 challenge review: found a concrete materialization defect despite prior
passing helper tests. Shared registry intentionally retains incompatible-only
arity suggestions; the materializer had promoted a singleton suggestion into a
resolved reference. Compared shared ranking changes, confidence thresholds and
an explicit materialization veto twice; chose the veto to preserve registry
compatibility and avoid guessed thresholds. Two Sol-medium developers changed
only resolver and its tests; two Luna reviewers independently challenged
correctness and integration. Both entry points now count incompatible singleton
free calls unresolved without a second provider callback; compatible/unknown and
multi-candidate ambiguity remain intact. Four-grammar fixtures now exercise
capture, production resolver, finalization, materialization and graph emission,
checking exact callers/targets, CALLS/ACCESSES, evidence and confidence. Suspected
emitter attribution defect did not reproduce; emitter remains unchanged.
Foreground suites passed 99 tests, exit 0 (1.09s); production TypeScript and
explicit untracked-file whitespace exited 0. Budget used one of two suites and
one of one typecheck; children executed none. Committed lookupCore impact MEDIUM
but shared source unchanged; dirty materializer is absent from the graph.

Consolidated remaining order: production pipeline integration with explicit
completeness/refusal semantics and sequential/worker/fallback graph parity;
CALLS retention before mutation; complete all-language SEED replay and atomic
publication; bounded dependency-closure graph replacement; eight-tool large
dirty-workspace acceptance. Measure replay versus full analysis on identical
captured bytes with declared time/memory limits before claiming performance.
Deployment identity and disposable lifecycle acceptance remain independent.
Do not infer activation from the component graph fixture or waive capture gates.

2026-10-23 Class constructor materialization: two Luna reviewers and two
Sol-medium developers compared method-registry overload lookup, existing class
lookup and a new instantiable registry twice. Selected the existing class branch
in resolve-references.ts. General resolution accepts singleton Class targets;
candidate ambiguity is checked before rejecting other types. Constructor lookup
does not apply method arity; the free-only API still counts constructors as
unsupported. Four-grammar fixtures cover imported public/private/missing targets,
parameter shadowing and parenthesis-free new expressions. Synthetic cases cover
mixed ordering, missing scopes, explicit receivers, all non-Class kinds and
Class/Interface ambiguity. Foreground resolver/registry/emitter suites passed
91 tests, exit 0 (1.17s); production TypeScript and explicit untracked-file
whitespace checks exited 0. Budget used one of two suites and one of one
typecheck; children executed no suites/builds. Committed class registry impact
LOW; dirty resolver not indexed, so source inspection is authority. Struct/Record,
constructor overloads, member/receiver resolution and activation remain open.

2026-10-23 identifier-read materialization: two Luna reviewers and two Sol-medium
developers compared duplicate resolvers, changed free-only behavior and one
shared internal pass twice. Added resolveReferences for free calls and plain
identifier reads using the existing FieldRegistry; resolveFreeCallReferences
retains its free-only outcomes. Each invocation builds context/registries once.
Singleton indexing, missing-scope guards, detached ranges/evidence and explicit
outcome counters are shared. Four-grammar fixtures prove public imported reads,
local parameter shadowing, calls and missing/private refusals. Function/class
reads remain unresolved under existing field kinds; receiver metadata, writes
and constructors remain unsupported. Foreground three-suite validation passed
65 tests, exit 0 (1.13s). Final test cleanup removed ineffective evidence identity
assertions; affected suite then passed 23 tests, exit 0 (998ms). Production
TypeScript and explicit untracked-file whitespace checks exited 0. Budget used
two of two suite invocations and one of one typecheck; children executed none.
OntoIndex committed field registry impact LOW; dirty materializer not indexed,
so current source is authority. No runtime/provider activation or cap changes.

2026-10-23 free-call materialization: two Luna reviewers and two Sol-medium
developers compared capture/finalizer/emitter coupling against a separate pure
resolution phase twice. Added resolve-references.ts plus its focused test file.
It builds context/registry once, resolves singleton explicit free calls into
both ReferenceIndex maps, clones ranges/evidence, freezes ordered buckets and
partitions all sites into resolved/unresolved/ambiguous/unsupported counters.
Missing scopes cannot enter qualified-name fallback. Four-grammar real capture
fixtures preserve public alias links and local shadowing; private, missing and
ambiguous targets stay unmaterialized. Foreground suites passed 55 tests across
materializer/finalizer/emitter, exit 0 (1.31s); production TypeScript no-emit and
explicit whitespace scans for both untracked files exited 0. Budget used one of
two suite invocations and one of one typecheck; children executed none.
OntoIndex committed emitter context/impact succeeded (LOW); helper not indexed
and workspace preparation over cap make source authority for dirty additions.
No reindex, cap change or runtime activation. Other reference forms, production
pipeline wiring, complete capture, CALLS/SEED and runtime acceptance remain open.

2026-10-23 registry context bridge: compared separate registry view, shared lookup
API expansion and structural-tree mutation twice; selected a small context
builder in finalize-orchestrator.ts. Two Luna reviewers and two Sol-medium
developers used disjoint source/test ownership. buildScopeRegistryContext
rebuilds the validated tree once for lookup reuse, substituting finalized module
bindings and preserving original scopes and index identities. Twelve real-parser
cases resolve imported aliases with confidence/evidence and preserve parameter
shadowing and private/missing refusal. Explicit empty maps override extracted
bindings; absent maps retain them. Foreground finalizer/registry suites passed
64 tests, two files, exit 0 (1.09s); production TypeScript no-emit exited 0.
Budget: one of two suite runs, one of one typecheck; children ran none. Shared
registry algorithms remain unchanged (committed lookupCore impact MEDIUM;
finalizer LOW). Dirty changes are verified from source; live graph preparation
reported workspace_too_large. Pipeline wiring and ReferenceIndex materialization
remain open; context creation alone does not establish runtime activation.

2026-10-23 production import resolver seam: two Sol-medium developers changed
only import-target-adapter.test.ts and finalize-orchestrator.test.ts; two Luna
reviewers confirmed existing resolver/context reuse. Four-grammar cases cover
relative extensionless paths, directory indexes, configured aliases, emitted
extensions, unresolved/private imports, local shadowing and cache isolation.
The finalizer uses real providers and the existing adapter; production pipeline
activation remains open. Foreground validation: 50 tests in two files passed,
exit 0 (1.09s); production TypeScript no-emit exited 0. TypeScript includes src
only; the test files were executed by Vitest. Budget used: one of two focused
suite invocations and one of one typecheck; children executed none. Committed
OntoIndex context/impact succeeded with LOW adapter risk and excluded dirty
changes. Source inspection governs current changes. Umbrella CATCH-IMPL still
selects duplicate accepted work; its tool-owned gates were left intact.

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| SMALL | Affordable exact-file packet | architecture-gate | CATCH-DESIGN | Frozen packet and tracker validation |
| CATCH | Local identifier catch semantics | implementation | CATCH-IMPL | Real parser/extractor regressions |
| MODULE-BLOCK | Module block capture with lexical isolation and shared var ownership | implementation | MODULE-BLOCK | Four-grammar parser and registry regressions |
| FILE-ID | Exact File ownership in auxiliary records | implementation | FILE-ID | Suffix rejection and colon-path acceptance |
| RUNTIME | Complete navigation and replay | non-goal | CATCH-DESIGN, CATCH-IMPL | Required successor stages above |

## Decisions And Non-Goals

Compared one huge implementation task, exhaustive speculative microtasks, and
rolling exact-file packets. Select rolling packets for bounded context and test
cost. Second review rejects premature readiness, helper tests as runtime proof,
and architecture decisions delegated to implementation helpers. No measured
performance claim. Existing completed tasks stay closed. No product edits during
tracker creation; unrelated dirty files remain untouched.

## Closeout

Open. Record accepted results through the manager workflow. Promote remaining
stages into executable successor packets before claiming overall completion.
