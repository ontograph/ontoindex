# Destructured export metadata repair

Date: 2026-11-01
Status: Closed
Authority: User request to challenge the 2.4.5 qualification and execute the selected repair.

## Goal

Public destructured JS/TS bindings retain export authority through normal parsing,
workers and serialized import-state replay; private names and expression operands
remain inaccessible through namespace lookup.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: closed
  selection_policy: active_next_task-first
  active_next_task: null
  max_in_flight: 1
  dispatch_mode: none
  reopen_gate: null
tasks:
  EXPORT-1:
    title: Destructured public bindings retain namespace authority through parsing and replay
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/named-bindings/typescript.ts
    - ontoindex/test/unit/import-processor.test.ts
    - ontoindex/test/integration/worker-pool.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/named-bindings/typescript.ts
    - ontoindex/test/unit/import-processor.test.ts
    - ontoindex/test/integration/worker-pool.test.ts
    non_goals:
    - Resolver fallback or scope-capture admission changes
    - Release versioning or installation changes
    - Unrelated blocked GN tasks and live host capability configuration
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=2 ./node_modules/.bin/vitest run test/unit/import-processor.test.ts
    - cd ontoindex && CARGO_BUILD_JOBS=4 node scripts/build.js
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=2 ./node_modules/.bin/vitest run test/unit/import-processor.test.ts test/unit/model/import-resolution-state.test.ts test/unit/model/resolution-context.test.ts test/unit/namespace-heritage.test.ts test/integration/worker-pool.test.ts test/integration/scope-retention-replay-edit-differential.test.ts
    - git diff --check
    expected_evidence:
    - New regression fails before the repair and passes afterward
    - Exact binding marker sets exclude keys and default expressions in JS and TS
    - Cached and reparsed ASTs and compiled worker output preserve public-private resolution
    - Ordinary and bounded serialized snapshots preserve producer-generated export authority
    - Independent challenge and bounded OntoIndex verification report no unresolved defect
    rollback:
    - Revert only the three task-owned source and test changes
    stop_conditions:
    - Required change exceeds the declared owners or changes resolver visibility
    - Repeated failure without a corrected cause
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: 2026-11-01 review challenge consolidate and proceed request
        validation_summary: Native build exit0; 237 tests across six files exit0; final changed unit file 41 tests exit0; lint zero errors; git diff check exit0; OntoIndex file scope PASS; four research packets and two independent diff reviews found no blocking source defect. No authenticated role receipts claimed.
    dod_status: pass
```

## Required Traceability

| Requirement ID | User requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REQ-001 | Challenge and repair qualification finding | implementation | EXPORT-1 | Failing regression followed by passing focused suite |
| REQ-002 | Preserve robustness and performance | compatibility-test | EXPORT-1 | Exact markers, privacy controls, iterative AST traversal |
| REQ-003 | Use OntoIndex navigation | proof-only | EXPORT-1 | Fresh context, LOW impact, scoped final audit |

## Decisions And Non-Goals

The 2.4.5 report accurately bounds its evidence and retains its corrected negative
probe. Its main gap is destructured-binding coverage. Main and worker producers
share the extractor; snapshots preserve the metadata they receive.

| Alternative | Correctness and robustness | Compatibility and complexity | Performance, security, validation and rollback |
| --- | --- | --- | --- |
| Local binding-position collector (selected) | Repairs missing authority at its source; ignores expression subtrees and malformed patterns | One existing owner, unchanged marker and API contracts | Linear binding traversal; iterative stack avoids recursion; exact-set/privacy tests; revert one source change |
| Shared strict capture helper | Avoids duplicate syntax rules but current helper rejects nested/rest forms and throws | Requires separating strict capture validation from metadata collection | No demonstrated speed gain; broader capture regressions and rollback needed |
| Derive markers from completed captures | Reuses completed semantic work but inherits whole-file capture refusal | Adds ordering and propagation coupling | Avoids one small traversal but broadens failure modes; needs pipeline qualification |
| Resolver direct-lookup fallback | Masks missing metadata and may expose private names | Small edit with incompatible visibility behavior | Rejected on correctness and privacy grounds |

Second challenge: export-name collection and scope-capture admission serve different
contracts. Collect legal binding positions without relaxing capture admission or
claiming variable type/inheritance inference. Never descend into keys or RHS values.
Use both JS and TS parsers and check malformed-pattern recovery. No benchmark speed
claim is planned; the change adds work only for exported declaration patterns.

The separate GN tracker remains blocked with no active task. Its state is unchanged.
Existing 2.4.5 full-gate evidence covers the release tree, not this future patch.
Initial validation budget: one native build, three test invocations (including the
expected red test), one scoped lint/format check; no installation or publication.
Actual execution used four test invocations. The fourth corrected a test-only
restore API misuse discovered in the added retained-context transition check.
This exceeded the initial manager estimate by one invocation; no repeated
unchanged failure or additional build occurred.

## Closeout

Implementation: 36 added source lines in the existing extractor; two existing
test files extended. No dependency, resolver, scope-capture, version or host
configuration changes. Four read-only research packets compared alternatives;
two independent source reviews found no blocking collector defect.

Evidence (native Linux):

- Expected regression: `/tmp/ontoindex-245-export-red.log`, exit 1,
  14 failed and 27 passed. Failures were missing markers and namespace lookup.
- Build: `/tmp/ontoindex-245-export-build.log`, exit 0. Native addon and TypeScript
  compilation passed; existing compiler warnings remain.
- Six-file suite: `/tmp/ontoindex-245-export-tests.log`, exit 0,
  237 passed in 75.08 seconds, including real compiled worker and edit replay.
- Added transition fixture: `/tmp/ontoindex-245-export-final-unit.log`, exit 1,
  4 failed due to incorrect restore API invocation; production unchanged.
- Corrected final unit file: `/tmp/ontoindex-245-export-corrected-unit.log`,
  exit 0, 41 passed in 3.42 seconds.
- Scoped ESLint: zero errors, 92 warnings including one new non-null assertion
  on a stack pop guarded by a nonempty-length check. Formatting and diff checks pass.
- OntoIndex bounded file verification passed; symbol scope was not checked.

Limits: namespace tests explicitly seed symbols and establish export visibility,
not variable type inference or new graph edges. Retained-map replacement tests
cover export removal; production edit replay remains covered by the existing
generic differential suite. No full release gate, benchmark, installation or
publication was run for this patch. No measured speedup is claimed.
