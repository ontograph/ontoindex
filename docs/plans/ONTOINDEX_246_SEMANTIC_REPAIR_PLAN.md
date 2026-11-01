# All-tools semantic repair

Date: 2026-11-01
Status: Closed
Authority: User request to challenge the all-tools qualification and execute the consolidated repairs.

## Goal

Mutation previews use actual indexed coordinates, exports and route shapes retain declaration ownership, analysis reports preserve uncertainty, and known query failures signal MCP invocation errors.

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
  REPAIR-1:
    title: Real ingestion and SDK boundaries preserve accurate mutation and analysis evidence
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: integration
    impact_risk: low
    owner_files:
    - ontoindex/src/mcp/local/backend-symbol-mutations.ts
    - ontoindex/src/mcp/local/backend-move-symbol.ts
    - ontoindex/src/mcp/local/backend-extract-function.ts
    - ontoindex/src/mcp/local/backend-rename.ts
    - ontoindex/src/mcp/facade/tool-definitions.ts
    - ontoindex/src/core/ingestion/export-detection.ts
    - ontoindex/src/core/ingestion/route-extractors/response-shapes.ts
    - ontoindex/src/core/ingestion/workers/route-extractor.ts
    - ontoindex/src/core/ingestion/workers/parse-types.ts
    - ontoindex/src/core/ingestion/workers/parse-worker.ts
    - ontoindex/src/core/ingestion/parsing-processor.ts
    - ontoindex/src/core/ingestion/pipeline-phases/routes.ts
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-stage.ts
    - ontoindex/src/audit/ipc-trace.ts
    - ontoindex/src/core/systems-audit/abi-diff.ts
    - ontoindex/src/mcp/local/backend-coupling-matrix.ts
    - ontoindex/src/mcp/local/backend-graph-diff.ts
    - ontoindex/fixtures/mcp-tool-contract/stable-tools.snapshot.json
    - ontoindex/test/integration/replace-symbol-roundtrip.test.ts
    - ontoindex/test/integration/mutation-indexed-ranges.test.ts
    - ontoindex/test/unit/mutation-dirty-guard.test.ts
    - ontoindex/test/unit/backend-extract-function.test.ts
    - ontoindex/test/unit/backend-rename.test.ts
    - ontoindex/test/integration/mcp-facade-metadata.test.ts
    - ontoindex/test/unit/tool-contract-schema.test.ts
    - ontoindex/test/integration/parsing.test.ts
    - ontoindex/test/integration/worker-pool.test.ts
    - ontoindex/test/unit/shape-check.test.ts
    - ontoindex/test/unit/routes-phase.test.ts
    - ontoindex/test/integration/resolvers/express-routes.test.ts
    - ontoindex/test/integration/scope-retention-extraction-replay-parity.test.ts
    - ontoindex/test/unit/ipc-trace-impl.test.ts
    - ontoindex/test/unit/ipc-trace.test.ts
    - ontoindex/test/unit/systems-abi-diff.test.ts
    - ontoindex/test/integration/facade-envelope-per-route.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/backend-symbol-mutations.ts
    - ontoindex/src/mcp/local/backend-move-symbol.ts
    - ontoindex/src/mcp/local/backend-extract-function.ts
    - ontoindex/src/mcp/local/backend-rename.ts
    - ontoindex/src/mcp/facade/tool-definitions.ts
    - ontoindex/fixtures/mcp-tool-contract/stable-tools.snapshot.json
    - ontoindex/test/integration/replace-symbol-roundtrip.test.ts
    - ontoindex/test/integration/mutation-indexed-ranges.test.ts
    - ontoindex/test/unit/mutation-dirty-guard.test.ts
    - ontoindex/test/unit/backend-extract-function.test.ts
    - ontoindex/test/unit/backend-rename.test.ts
    - ontoindex/test/integration/mcp-facade-metadata.test.ts
    - ontoindex/test/unit/tool-contract-schema.test.ts
    - ontoindex/src/core/ingestion/export-detection.ts
    - ontoindex/src/core/ingestion/route-extractors/response-shapes.ts
    - ontoindex/src/core/ingestion/workers/route-extractor.ts
    - ontoindex/src/core/ingestion/workers/parse-types.ts
    - ontoindex/src/core/ingestion/workers/parse-worker.ts
    - ontoindex/src/core/ingestion/parsing-processor.ts
    - ontoindex/src/core/ingestion/pipeline-phases/routes.ts
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-stage.ts
    - ontoindex/test/integration/parsing.test.ts
    - ontoindex/test/integration/worker-pool.test.ts
    - ontoindex/test/unit/shape-check.test.ts
    - ontoindex/test/unit/routes-phase.test.ts
    - ontoindex/test/integration/resolvers/express-routes.test.ts
    - ontoindex/test/integration/scope-retention-extraction-replay-parity.test.ts
    - ontoindex/src/audit/ipc-trace.ts
    - ontoindex/src/core/systems-audit/abi-diff.ts
    - ontoindex/test/unit/ipc-trace-impl.test.ts
    - ontoindex/test/unit/ipc-trace.test.ts
    - ontoindex/test/unit/systems-abi-diff.test.ts
    - ontoindex/src/mcp/local/backend-coupling-matrix.ts
    - ontoindex/src/mcp/local/backend-graph-diff.ts
    - ontoindex/test/integration/facade-envelope-per-route.test.ts
    non_goals:
    - Release versioning publication installation and unrelated GN plan gates
    - Persisted coordinate migration semantic rename apply and new dependencies
    - Unproven database memory sizing changes
    required_validation:
    - cd ontoindex && CARGO_BUILD_JOBS=4 node scripts/build.js
    - Focused Vitest suites for all changed owners including actual parser worker replay and SDK boundaries
    - Scoped ESLint and git diff --check
    - Bounded OntoIndex verify_diff and independent final source challenge
    expected_evidence:
    - Zero-based parsed ranges support row-zero and prefixed mutation previews while stale writes remain refused
    - Export metadata excludes nested and unrelated declarations in sequential and worker paths
    - Route keys remain handler-owned through retained replay and duplicate URL union
    - Incomplete ABI parsing suppresses unproven absence and IPC observations do not claim connected bridges
    - Real audit handler execution failures retain payloads and return MCP isError true
    - Advertised refactor arguments match existing action-specific forwarding and defaults
    rollback:
    - Revert only declared repair source tests schema fixture and accompanying decision record
    stop_conditions:
    - Unresolved public contract or required write outside declared scope
    - Repeated unchanged failure or exhausted execution allowance
    known_blockers: []
    closeout:
      main_session_evidence:
        authorized_by: user
        authorization_ref: 2026-11-01 request to review, challenge, select robust proposals, consolidate and proceed; GPT-6 Astra helpers explicitly requested
        validation_summary: 'Native build2 exit0; final Vitest 804/804 tests across 23 files exit0 (session29536, terminal be1d66); scoped ESLint 0 errors/229 warnings exit0 (session33041, terminal345c96); git diff --check exit0; bounded OntoIndex verify_diff PASS for35 files; independent Astra source challenge found no remaining blocker. Evidence: /tmp/ontoindex-semantic-repair-20261101-U4U2to.'
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
    dod_status: pass
```

## Required Traceability

| Requirement ID | User requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REQ-001 | Challenge completed qualification | proof-only | REPAIR-1 | Four independent research packets and final challenge |
| REQ-002 | Select robust performant solutions and implement | implementation | REPAIR-1 | Real parser, replay and SDK regressions |
| REQ-003 | Use OntoIndex for navigation | compatibility-test | REPAIR-1 | Fresh committed impact and bounded scope audit |
| REQ-004 | Keep established public argument semantics | architecture-gate | REPAIR-1 | ADR_MCP_REFACTOR_COORDINATES_AND_ARGUMENTS.md and schema tests |

## Decisions And Non-Goals

The saved qualification has useful broad transport and test coverage. Its weakest
claims concern semantic correctness: one-based mocks conceal zero-based range
failures, file-wide text confuses declaration ownership, and nonempty observations
are presented as stronger evidence than the implementation establishes. Forgotten
seams include retained extraction replay, duplicated graph references, unsupported
ABI declarations, and real handler errors through SDK transport.

| Issue | Three materially distinct alternatives | Selected fix and second challenge |
| --- | --- | --- |
| F1 coordinates | Migrate stored coordinates; normalize all resolver output; adapt mutation consumers | Adapt consumers. Keep public indexed coordinates unchanged; never guess the base. Test actual ingestion and resolver, stale guards and row zero. |
| F2 exports | Stop at selected blocks; follow declaration-owned wrappers; replace with scope export resolution | Declaration ownership. Block-only repair misses program text and initializer/class ancestry. Preserve exported bindings without granting nested visibility. |
| F3 route shapes | Slice by registration lines; reparse in route phase; collect AST evidence in existing parse pass | Existing AST pass. Same-line and named handlers defeat line slicing. Carry compact arrays through both producers and strict retained replay; unresolved handlers contribute no invented keys. |
| F4 IPC | Require JS plus native hits; label observations unverified; build full native linkage resolver | Label observations unverified. Unrelated hits cannot establish connectivity. Preserve completed-query success and observed locations. |
| F5 ABI | Broaden regexes; bounded declaration recognition with completeness; reuse installed Tree-sitter grammars | Bounded conservative recognition. Stop at unsupported syntax, preserve source lines, suppress absence only against incomplete sides. Tree-sitter is available but eager grammar loading and broad member semantics exceed this repair. |
| F6 rename | Remove first-match break; scan deduplicated candidate files; require semantic language-service references | One bounded scan per candidate. Preserve preview-only behavior and literal token replacements; report cap/read omissions and line-edit counts. |
| Refactor schema | Add aliases; change internal names; advertise existing names | Advertise snake-case keys with action-specific defaults. Keep safe_refactor camelCase separate and cover forwarding compatibility. |
| Query failure transport | Infer status centrally; throw from handlers; use existing invocation marker at known catches | Existing marker. Generic sniffing misclassifies domain data; throwing changes direct-handler contracts. Test real handlers through SDK. |
| Partial line mutation | Expand AST wrapper; refuse unsafe slices; defer | Refuse unsafe JS/TS apply slices in the existing guard owner. Second review found separate-line exports and same-line neighbors can be damaged even with correct coordinates. Require a complete top-level AST node; preserve files on refusal. |
| Buffer exhaustion | Serialize coupling queries; use mandatory membership joins; split edge and membership queries | Defer query changes pending isolated proof. Internal overlap remains possible despite a serial external request. Mandatory joins change capped sampling; splitting needs generation and multiplicity controls. Never truncate graph-diff inputs or raise memory speculatively. |

All selected fixes preserve containment, permissions and stale-write protection;
add no dependency; remain in existing owners; and can be reverted by packet.
Performance choices remove duplicate reads and per-route file scans. No measured
speedup or database exhaustion root cause is claimed. Unsupported syntax and
unresolved links stay explicit. The GN blocked tracker is unchanged.

Execution: four read-only Astra reviewers completed discovery. Implementation
helpers own disjoint file sets; main session owns validation and acceptance.
Initial allowance: 3 native build/typecheck invocations, 8 focused test invocations,
2 scoped lint/format invocations, 2 optional serial live audit probes. No parallel
validators. Children receive zero execution allowance; they author tests for the
parent to run. This includes correction reserve; no benchmark or app launch.

## Closeout

Implementation and required local validation are complete. The manager accepted
REPAIR-1 through complete-local: task DONE, manager closed, active task null,
terminal decision no-dispatch. Evidence directory:
`/tmp/ontoindex-semantic-repair-20261101-U4U2to`.

- First error-signaling suite: 176 tests in five files passed, exit 0 (7.08s),
  `errors-tests.log`. Real handler SDK tests preserve JSON-RPC results and mark
  failures; successful controls and existing domain-marker tests pass.
- Second focused invocation: 77/78 tests passed in six files, exit 1,
  `analysis-shapes-tests.log`. The multiline C++ declaration regression exposed
  a member recognizer without dotAll. Correction round 1/2 is limited to that
  expression in abi-diff.ts; retain the test and original failure evidence.
- Native build 1 passed, exit 0, `build-1.log`. Third test invocation passed
  570/575 in 13 files, exit 1, `contracts-ingestion-tests.log`; ABI correction
  passed. Contracts correction round 1/2 addresses three canonical-temp-path
  test assumptions and two multiline named-export boundary failures.
- Independent ingestion review found stale shapes after named export and
  destructuring reassignment. Alternatives were dropping declaration support,
  implementing full dataflow, or reusing conservative invalidation. Selected
  existing invalidation with binding-only traversal, preserving unaffected
  handlers. Ingestion correction round 1/2 owns one source and one test file.
- Two parser diagnostic invocations consume test allowance slots 4 and 5.
  The first failed because tsx eval selected CJS for a top-level-await dependency;
  the corrected compiled ESM probe passed. It proves the TS grammar treats a
  standalone multiline `export` token as an identifier expression, with no syntax
  error. A narrow preceding-export refusal is required; repeating the same parser
  after deletion would miss the issue. Logs: `parser-export-probe.log` and
  `parser-export-probe-2.log`.
- Serial live coupling probe again exhausted the buffer pool (57ms), with exact
  request/response saved in `live-coupling.json`. This is the installed runtime,
  not the in-progress source patch. Remaining heavy probe stopped as planned.
  Parallel requests alone do not explain the failure; memory root cause remains
  open. No pool-size change is justified by this evidence.
- Report corrected in sibling Ontocode: precise apply fixture limits and usable
  shell continuations; removed-checkout reconstruction remains required.
- Safety check classifies replacement as DANGEROUS because it is exported.
  Its measured upstream impact is LOW; ADR and compatibility gates remain required.
  Committed graph omits current edits; source and tests establish their behavior.
- Buffer source challenge found a separate 50,000-row boundary mismatch: coupling
  requests that cap while the shared pool rejects results at the same count.
  Query isolation and a real database cap-boundary regression remain follow-up
  work; existing mocked tests do not prove native memory behavior.

### Final acceptance evidence

- Native build 2: `cd ontoindex && CARGO_BUILD_JOBS=4 node scripts/build.js`,
  exit 0 after all source corrections and formatting; `build-2.log`, terminal
  receipt `7e0fe5`. Native addon and TypeScript bundle produced. No source edits
  followed this build.
- Combined Vitest invocation: 804/804 tests across 23 files, exit 0, 36.02s;
  `final-tests.log`, session 29536, terminal receipt `be1d66`. It covers real
  indexed mutation ranges, rename, schema forwarding, parsing workers/replay,
  routes, IPC/ABI, error markers, SDK envelopes and dispatcher boundaries.
  Two mock-backend disposal warnings remain visible in the log.
- Scoped ESLint on all 34 changed TypeScript files: exit 0, 0 errors and
  229 warnings; `lint.log`, session 33041, terminal receipt `345c96`.
  Warning provenance was not compared to baseline; this is not a warning-free gate.
- `git diff --check`: exit 0. Bounded OntoIndex `verify_diff`: PASS for the
  explicit 35 source/test/fixture paths, with no unexpected files. Impact scanning
  was capped at 25 symbols, expected symbol scope was not checked, and the graph
  excludes dirty sources. This establishes bounded file scope, not fresh graph
  semantics or test execution.
- Independent Astra final source challenge found no remaining blocking finding
  in the reviewed corrections. All four implementation helpers executed zero
  validators. Their source review is separate from main-session test evidence.
- Budget reconciliation: 2/3 native builds; 6/8 test/diagnostic invocations
  (four suites and two parser probes); 2/2 scoped format/lint command invocations;
  1/2 live probes, with further heavy probing stopped after buffer exhaustion.
  The format command launched Prettier twice for tracked and untracked files;
  the two command slots therefore contain three formatter/linter processes.
- No measured speedup, full-suite qualification, installed-client qualification,
  commit, release, push or installation is claimed for this repair.

### Remaining work and choice criteria

For the next database task, first pin the database generation and record effective
pool settings, then isolate the two internal coupling queries and test the
50,000-row boundary against the native database. Choose serialization if overlap
alone causes exhaustion; choose a bounded query rewrite if one query exhausts the
pool. Splitting edge and membership queries is the third option, requiring explicit
snapshot consistency and duplicate-edge handling. Mandatory joins may change
capped samples. Raising memory without this proof and truncating graph-diff inputs
are rejected: the former can conceal growth, the latter invent removed edges.

The selected repairs favor existing owners and shared parsing evidence over schema
migrations or new resolvers. Correctness and robustness are covered at real
ingestion/replay/transport seams; compatibility preserves stored coordinates and
existing argument names; security retains containment, permissions and stale-write
checks. Complexity remains local with no new dependency. Deduplicated reads and
cached handler extraction avoid repeated work, but performance needs measurement.
Each packet can be reverted independently with its fixtures. The second challenge
added malformed export, reassignment, hostile replay and incomplete-parser cases;
all remain in the passing suite. Conservative parser limits and uncertain IPC
connectivity are explicit residual limitations.
