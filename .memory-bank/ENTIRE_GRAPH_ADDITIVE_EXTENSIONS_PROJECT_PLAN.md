# Entire Graph Additive Extensions Project Plan
Date: 2026-07-25
Status: Complete
Audience: coder-manager and coder-* sub-agents (sub-agent dispatch mode)
Authority: `ENTIRE_GRAPH_100_APPROACHES.md`, current source evidence, and the
architectural invariants in `ARCHITECTURE.md` and `GUARDRAILS.md`. No ADR is
required for the bounded tasks below; every task extends an existing owner and
must stop if implementation needs a new product surface, persistence model, or
query architecture.

## Manager Tracking

```yaml
manager_loop:
  status: closed
  active_next_task: null
  selected_task: null
  no_selected_task_reason: "All 12 tasks are DONE; TASK-12 (the final task) closed DONE and the plan is complete, so no task remains to select or dispatch."
  last_decision:
    outcome: completed
    label: TASK-12
    reason: "TASK-12 met DoD across exactly four changed files (ontoindex/src/cli/ai-context.ts, ontoindex/src/cli/setup.ts, ontoindex/test/unit/ai-context.test.ts, ontoindex/test/unit/setup.test.ts); ontoindex/test/unit/setup-codex.test.ts remained unchanged but was included in validation. Both generated surfaces now emit the ordered small-tool ladder (explore/search; inspect/context; impact before edits; gn_verify_diff before commit) and both state that the graph is commit-based: if current HEAD differs from the indexed commit, exactly one coordinated process MUST re-analyze before graph-backed claims, dirty/uncommitted changes must not be silently assumed represented, and current source/diff must be verified. Managed markers, include-file ownership, and control flow are unchanged; user content is preserved; no new command/product surface or auto-analysis was added. Repeated generation is asserted byte-identical for repo-managed CLAUDE.md and global ONTOINDEX.md across .claude/.codex/.ontocode. Validation: focused Vitest 3 files/42 tests PASS, npx tsc --noEmit PASS, Prettier --check on five owner files PASS, scoped git diff --check PASS. OntoIndex impacts LOW: generateOntoIndexContent (9 upstream/1 direct/2 processes/2 modules), ensureOntoIndexAgentGuidance (4 upstream/1 direct/1 module), generateAIContextFiles (8 upstream/3 direct/2 processes/2 modules), setupCommand (3 direct). Final independent coder-worker-test PASS and final challenger PASS. gn_verify_diff with changedFiles/expectedFiles set to the exact four task files shows no unexpected changed files and no missing required tests, but aggregate status is FAIL due to cumulative dirty-worktree changed-symbol/impact pollution; this is a tooling limitation of a noisy cumulative worktree, not a clean PASS. Residual risk LOW: generated guidance is advisory, committed generated artifacts converge on regeneration, and aggregate verify-diff remains noisy in the cumulative dirty worktree."
    planning_work_considered: true
    reopen_gate: "Reopen TASK-12 only if either generated surface stops emitting the ordered ladder (explore/search; inspect/context; impact before edits; gn_verify_diff before commit); if the commit-based freshness rule (re-analyze when HEAD differs from indexed commit, no silent worktree graph assumption, verify current source/diff) is dropped from either surface; if managed block markers, include-file ownership, or control flow change; if user content is no longer preserved; if a new command/product surface or automatic analysis is introduced; if repeated generation stops being byte-identical for repo-managed CLAUDE.md or global ONTOINDEX.md across .claude/.codex/.ontocode; or if scope drifts beyond the four TASK-12 files (ontoindex/src/cli/ai-context.ts, ontoindex/src/cli/setup.ts, ontoindex/test/unit/ai-context.test.ts, ontoindex/test/unit/setup.test.ts)."
  closeout_state: complete
  dispatch_mode: sub-agent
  selection_policy: active_next_task-first
  auto_continue: until-stop-condition
  dispatch_preflight:
    tool_surface: unchecked
    child_capability_probes: {}
    required_roles:
      coder-architector:
        agent_type_candidates: [coder-architector, worker]
        local_fallback_allowed: false
        required_for: [dor-dod-adr-gate, paperwork, readiness, closeout]
      coder-worker:
        agent_type_candidates: [coder-worker, worker]
        local_fallback_allowed: false
        required_for: [implementation]
      coder-worker-test:
        agent_type_candidates: [coder-worker-test, worker]
        local_fallback_allowed: false
        required_for: [verification]
      coder-worker-challenger:
        agent_type_candidates: [coder-worker-challenger, worker]
        local_fallback_allowed: false
        required_for: [challenge]
    fork_context: false
    unavailable_outcome: "blocked: model/capacity"
  ontoindex:
    required: true
    status: stale
    unavailable_action: direct-source-fallback
    tools_used:
      - gn_diagnose(repo=ontoindex)
      - gn_explore(repo=ontoindex)
      - impact(action=symbol, target_uid=Function:ontoindex-shared/src/language-detection.ts:getLanguageFromFilename)
      - impact(action=batch, targets=[appendQueryLog, classifyGraphFactProvenance, generateOntoIndexContent, ensureOntoIndexAgentGuidance, statusCommand, formatIndexCapabilityWarnings])
      - ctx_compose source-owner verification
    limitations:
      - "The graph index is stale: indexed 8bcdc39e, current ecbd066e."
      - "The only dirty worktree file at planning time is the untracked source report ENTIRE_GRAPH_100_APPROACHES.md; graph scope confidence is medium."
      - "Embeddings and the docs sidecar are unavailable, so lexical/graph retrieval and direct current-source inspection are authoritative for exact write sets."
      - "Every worker must rerun impact/inspection for existing target symbols immediately before edits and warn on HIGH or CRITICAL risk."
      - "`getLanguageFromFilename`, `statusCommand`, and `formatIndexCapabilityWarnings` each resolve to two graph nodes (Function and Const). Workers must pass `target_uid` with the `Function:` node or impact returns `ambiguous` with zero counts."
      - "`appendQueryLog` and `backend-search.ts:query` report zero upstream callers. That is a graph gap, not proof of isolation: MCP tool handlers reach `query` at runtime. Verify callers from source before editing."
    source_fallback:
      - ENTIRE_GRAPH_100_APPROACHES.md
      - .github/workflows/bench.yml
      - .github/workflows/publish.yml
      - ontoindex/scripts/large-codebase-benchmark.mjs
      - ontoindex/scripts/bench-gate.mjs
      - ontoindex/scripts/kimi-k3-mcp-smoke.mjs
      - ontoindex/src/core/search/semantic-cache.ts
      - ontoindex/src/mcp/local/query-log.ts
      - ontoindex/src/core/run-analyze.ts
      - ontoindex-shared/src/language-detection.ts
    fallback_evidence:
      - "bench.yml hides benchmark failure with `|| true` and copies baseline.json to current.json; referenced benchmark/baseline files are absent from the current tree."
      - "publish.yml creates ontoindex-*.tgz before npm publish but does not verify the public release API/download contract consumed by both installer scripts."
      - "semantic-cache.ts writes JSON directly and evicts only by entry count."
      - "run-analyze.ts persists degraded file path/reason pairs; status and runtime health mainly expose a count or one reason."
      - "large-codebase-benchmark.mjs already samples process-tree RSS but has no threshold or scenario manifest."
      - "query-log.ts is bounded and non-fatal but lacks cache, response-size, truncation, and retrieval-mode fields."

tasks:
  TASK-1:
    title: Replace the simulated benchmark gate with real Vitest benchmark output
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: []
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: ci
    owner_files:
      - .github/workflows/bench.yml
      - ontoindex/scripts/bench-gate.mjs
      - ontoindex/test/bench/query.bench.ts
      - ontoindex/test/bench/baseline.json
      - ontoindex/test/unit/bench-gate.test.ts
      - ontoindex/vitest.config.ts
      - .gitignore
    allowed_write_set:
      - .github/workflows/bench.yml
      - ontoindex/scripts/bench-gate.mjs
      - ontoindex/test/bench/query.bench.ts
      - ontoindex/test/bench/baseline.json
      - ontoindex/test/unit/bench-gate.test.ts
      - ontoindex/vitest.config.ts
      - .gitignore
    target_symbols:
      - run
    do_not_touch:
      - ontoindex/scripts/large-codebase-benchmark.mjs
      - any production query implementation
      - package dependencies or a second benchmark framework
      - existing `lbug-db`, `default`, and `serial-slow` include/exclude lists beyond what benchmark collection requires
    non_goals:
      - Replacing Vitest benchmarks.
      - Adding hosted benchmark storage or dashboards.
      - Treating copied baseline data as current execution evidence.
    source_evidence:
      - .github/workflows/bench.yml:34-47
      - ontoindex/scripts/bench-gate.mjs:4-49
      - "Current tree has no ontoindex/test/bench/query.bench.ts or baseline.json despite workflow references."
      - "ontoindex/vitest.config.ts declares projects `lbug-db`, `default`, and `serial-slow`; all include globs match `*.test.ts` only, so a new `*.bench.ts` file is collected by no project as configured."
      - "`vitest bench` supports `--outputJson`, but its schema is Vitest's own and does not match the flat `{name: {mean}}` shape bench-gate.mjs reads today."
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: "No deterministic test currently proves a real benchmark result is consumed or a regression fails the gate."
    adr_gate:
      required: false
      reason: >-
        Repairs an existing CI gate using the benchmark runner already selected
        by the repository. No product API, persistence, query, or runtime
        architecture changes.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontoindex && npx vitest bench test/bench/query.bench.ts --project=lbug-db --outputJson test/bench/current.json"
        - "cd ontoindex && node scripts/bench-gate.mjs"
        - "cd ontoindex && npx vitest run test/unit/bench-gate.test.ts"
      executed:
        - "cd ontoindex && npx vitest bench test/bench/query.bench.ts --project=lbug-db --outputJson test/bench/current.json"
        - "cd ontoindex && node scripts/bench-gate.mjs"
        - "cd ontoindex && npx vitest run test/unit/bench-gate.test.ts"
      diff_scope:
        - .github/workflows/bench.yml
        - .gitignore
        - ontoindex/scripts/bench-gate.mjs
        - ontoindex/vitest.config.ts
        - ontoindex/test/bench/query.bench.ts
        - ontoindex/test/bench/baseline.json
        - ontoindex/test/unit/bench-gate.test.ts
      unrelated_failures: []
    required_validation:
      - "The workflow consumes the JSON written by the real benchmark command."
      - "Benchmark command failures propagate; no `|| true` remains."
      - "A deliberately regressed fixture fails and unchanged baseline data passes."
      - "The benchmark file is actually collected: the run reports at least one executed benchmark, and an empty or unmatched run fails instead of passing silently."
      - "bench-gate.mjs parses the real `--outputJson` schema, and a schema mismatch fails closed rather than warning and continuing."
      - "Generated `test/bench/current.json` is git-ignored; only the baseline is committed."
    expected_evidence:
      - Actual current.json shape and mapping to the gate input recorded.
      - Focused unit proof for pass, regression, missing result, and malformed result.
      - Workflow diff contains no baseline-to-current copy.
      - Recorded proof that the chosen project collects the benchmark file, including the exact `--project` value used.
      - git diff --check clean on the write set.
    rollback:
      - Revert the workflow, gate script, benchmark fixture, baseline, and unit test.
    stop_conditions:
      - Real output cannot be consumed without adding a new benchmark dependency.
      - The proposed fixture requires network or nondeterministic external state.
      - The gate would warn and pass when a required current result is missing.
      - Collecting the benchmark would require restructuring existing project include/exclude lists or changing which tests the current projects run.
    closeout_evidence:
      - "Real Vitest benchmark ran under the lbug-db project with the production no-trace 10+10 merge path and a same-run control; no simulated data."
      - "Ratio gate passed: baseline 1.6271004399998796, observed examples 1.655 and 1.676, within the 15% budget."
      - "Unit/acceptance suite 12/12 green (pass, regression, missing result, malformed result, and collection-count paths)."
      - "Prettier --check and scoped git diff --check both clean; generated test/bench/current.json is git-ignored and uncommitted."
      - "gn_verify_diff PASS with exact scope over the seven write-set files."
      - "Challenger returned final PASS after rework; prior findings (production fidelity, runner normalization, actual-output acceptance, workflow path coverage) all resolved."
    evidence:
      - Actual current.json shape recorded and mapped to the flat gate input; schema mismatch fails closed.
      - Workflow consumes real --outputJson benchmark output; no `|| true` and no baseline-to-current copy remain.
      - test/bench/query.bench.ts is collected by the lbug-db project; empty/unmatched runs fail instead of passing silently.
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - .github/workflows/bench.yml
        - .gitignore
        - ontoindex/scripts/bench-gate.mjs
        - ontoindex/vitest.config.ts
        - ontoindex/test/bench/query.bench.ts
        - ontoindex/test/bench/baseline.json
        - ontoindex/test/unit/bench-gate.test.ts
      validation_summary:
        - "cd ontoindex && npx vitest bench test/bench/query.bench.ts --project=lbug-db --outputJson test/bench/current.json -> pass (real benchmark, production no-trace 10+10 merge, same-run control)"
        - "cd ontoindex && node scripts/bench-gate.mjs -> pass (baseline 1.6271004399998796 vs observed 1.655/1.676, <=15%)"
        - "cd ontoindex && npx vitest run test/unit/bench-gate.test.ts -> pass (12/12)"
        - "prettier --check and scoped git diff --check -> clean; gn_verify_diff -> PASS exact scope"
      evidence_refs:
        - closeout_evidence
        - evidence
      final_outcome_label: done
      remaining_risk: null
    next_on_done: [TASK-2]

  TASK-2:
    title: Verify the live GitHub release tarball before npm publication
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-1]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: release
    owner_files:
      - .github/workflows/publish.yml
      - ontoindex/scripts/verify-release-asset.mjs
      - ontoindex/test/unit/verify-release-asset.test.ts
    allowed_write_set:
      - .github/workflows/publish.yml
      - ontoindex/scripts/verify-release-asset.mjs
      - ontoindex/test/unit/verify-release-asset.test.ts
    target_symbols:
      - verifyReleaseAsset
    do_not_touch:
      - scripts/install-ontoindex-latest.sh
      - scripts/install-ontoindex-latest.ps1
      - npm publication semantics other than ordering behind verification
    non_goals:
      - Reimplementing installer logic.
      - Creating another release artifact format.
      - Publishing, tagging, or contacting GitHub from unit tests.
    source_evidence:
      - .github/workflows/publish.yml:112-146
      - scripts/install-ontoindex-latest.sh:295-339
      - scripts/install-ontoindex-latest.ps1
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: "No post-release check proves the public API exposes the exact installer tarball or that its package/CLI contents match the tag."
    adr_gate:
      required: false
      reason: >-
        Adds a release verification gate around the already-owned npm tarball
        and installer contract. It does not change package format, installer
        behavior, or publication ownership.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontoindex && npx vitest run test/unit/verify-release-asset.test.ts"
        - "npx prettier --check .github/workflows/publish.yml ontoindex/scripts/verify-release-asset.mjs ontoindex/test/unit/verify-release-asset.test.ts"
      executed:
        - "cd ontoindex && npx vitest run test/unit/verify-release-asset.test.ts"
        - "npx prettier --check .github/workflows/publish.yml ontoindex/scripts/verify-release-asset.mjs ontoindex/test/unit/verify-release-asset.test.ts"
      diff_scope:
        - .github/workflows/publish.yml
        - ontoindex/scripts/verify-release-asset.mjs
        - ontoindex/test/unit/verify-release-asset.test.ts
      unrelated_failures: []
    required_validation:
      - "Exactly one expected ontoindex-<version>.tgz asset is accepted."
      - "Downloaded tarball package version and bin entry match the release tag and dist/cli/index.js."
      - "Verification runs after GitHub release creation and before npm publish."
    expected_evidence:
      - Fixture release JSON covers absent, duplicate, wrong-version, and expected asset cases.
      - Fixture tarballs cover mismatched package version and missing CLI entry.
      - Workflow uses the tag-specific release endpoint, not `/releases/latest`.
      - git diff --check clean on the write set.
    rollback:
      - Revert publish.yml and remove the verifier script/test.
    stop_conditions:
      - Verification needs installer mutation or a new asset naming contract.
      - npm publication would happen before verification completes.
      - Unit proof would require live network access.
    closeout_evidence:
      - "Verifier accepts exactly the installer-compatible asset set and rejects absent, duplicate, and wrong-version assets."
      - "Prerelease releases are rejected as unstable; verification uses the tag-specific release API, not /releases/latest."
      - "Transport retries are bounded to 4 attempts with capped 5s backoff for metadata/download, covering 404 metadata, 429, 5xx, and 403+Retry-After; permanent 4xx fails fast."
      - "Asset download is unauthenticated; tarball inspection uses safe tar -xOf, then checks package version, bin entry, and CLI against the release tag; temp cleanup and ordering verified."
      - "Focused suite 30/30 green; combined suite 42/42 green; Prettier --check and scoped git diff --check clean."
      - "Scoped gn_verify_diff PASS over the three write-set files; challenger returned final PASS."
    evidence:
      - Exactly one expected ontoindex-<version>.tgz asset accepted; downloaded package version and bin entry match the release tag and dist/cli/index.js.
      - Verification runs after GitHub release creation and before npm publish; bounded retries fail closed on permanent 4xx.
      - Offline fixtures cover absent/duplicate/wrong-version/expected assets and mismatched-version/missing-CLI tarballs; no live GitHub call in unit tests.
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - .github/workflows/publish.yml
        - ontoindex/scripts/verify-release-asset.mjs
        - ontoindex/test/unit/verify-release-asset.test.ts
      validation_summary:
        - "cd ontoindex && npx vitest run test/unit/verify-release-asset.test.ts -> pass (30/30 focused; 42/42 combined)"
        - "npx prettier --check .github/workflows/publish.yml ontoindex/scripts/verify-release-asset.mjs ontoindex/test/unit/verify-release-asset.test.ts -> clean; scoped git diff --check -> clean; gn_verify_diff -> PASS exact scope"
      evidence_refs:
        - closeout_evidence
        - evidence
      final_outcome_label: done
      remaining_risk: null
    next_on_done: [TASK-3]

  TASK-3:
    title: Make semantic-cache writes atomic and byte bounded
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-2]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
      - ontoindex/src/core/search/semantic-cache.ts
      - ontoindex/test/unit/core/semantic-cache.test.ts
    allowed_write_set:
      - ontoindex/src/core/search/semantic-cache.ts
      - ontoindex/test/unit/core/semantic-cache.test.ts
    target_symbols:
      - SemanticRetrievalCache
      - SemanticRetrievalCache.set
      - SemanticRetrievalCache.evictOverflow
    do_not_touch:
      - cache key construction semantics
      - indexed-head invalidation semantics
      - query result contracts or LadybugDB persistence
    non_goals:
      - A committed-tree graph cache.
      - Worktree-aware cached graph answers.
      - A cache daemon or external cache dependency.
    source_evidence:
      - ontoindex/src/core/search/semantic-cache.ts:36-156
      - ontoindex/test/unit/core/semantic-cache.test.ts
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: false
      reason: >-
        Strengthens the existing local semantic result cache with atomic file
        replacement and a second eviction limit. Cache identity, freshness,
        primary graph persistence, and public response contracts remain intact.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontoindex && npx vitest run test/unit/core/semantic-cache.test.ts"
      executed:
        - "cd ontoindex && npx vitest run test/unit/core/semantic-cache.test.ts"
      diff_scope:
        - ontoindex/src/core/search/semantic-cache.ts
        - ontoindex/test/unit/core/semantic-cache.test.ts
      unrelated_failures: []
    required_validation:
      - "Writes use same-directory temporary files plus atomic replacement."
      - "Pruning honors maxEntries and maxBytes deterministically."
      - "Interrupted or malformed temporary writes never become readable cache entries."
      - "Existing key, TTL, stale-head, and count-eviction behavior remains green."
    expected_evidence:
      - Pre-edit impact for SemanticRetrievalCache methods recorded.
      - Unit cases for byte-only eviction, combined limits, replacement, and orphan temp files.
      - No cache files are added to git.
      - git diff --check clean on the write set.
    rollback:
      - Revert semantic-cache.ts and its unit test.
    stop_conditions:
      - Atomic replacement is unavailable without changing cache location or adding a dependency.
      - Byte pruning would require reading or caching graph state.
      - Existing cache-key or indexed-head semantics would change.
    closeout_evidence:
      - "Semantic cache writes now use a same-directory temporary file plus atomic rename replacement; no cross-directory temp or added dependency."
      - "Pruning is deterministic count-plus-byte: maxBytes is additive to maxEntries, and eviction applies count and total-byte limits in a stable order."
      - "Malformed .json cache files are counted and pruned first; temp files are ignored for readable-entry selection so interrupted writes never become cache hits."
      - "Concurrent-replacement race fixed via rename-aside with snapshot inode/content validation and non-clobbering link restore."
      - "Tests: semantic-cache 15/15 and backend-search-typed 24/24 green; tsc reports no errors; Prettier and git diff --check clean."
      - "Scoped gn_verify_diff PASS after passing an exact TASK-3 changedFiles override; the initial scope=all run showed cumulative TASK-1/TASK-2 files, not scope drift."
    evidence:
      - Same-directory atomic set with maxBytes as an additive limit and deterministic count+byte pruning; malformed .json counted/pruned first and temp files ignored.
      - Concurrent replacement race fixed by rename-aside, snapshot inode/content validation, and non-clobbering link restore.
      - semantic-cache 15/15, backend-search-typed 24/24, tsc clean, Prettier and diff --check clean, scoped gn_verify_diff PASS with exact TASK-3 changedFiles override.
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - ontoindex/src/core/search/semantic-cache.ts
        - ontoindex/test/unit/core/semantic-cache.test.ts
      validation_summary:
        - "cd ontoindex && npx vitest run test/unit/core/semantic-cache.test.ts -> pass (15/15; backend-search-typed 24/24)"
        - "tsc -> no errors; Prettier --check and scoped git diff --check -> clean; gn_verify_diff -> PASS with exact TASK-3 changedFiles override"
      evidence_refs:
        - closeout_evidence
        - evidence
      final_outcome_label: done
      remaining_risk: "Low: a crash may leave ignored temp files; replacement-race accounting may briefly exceed budget and self-corrects on the next set; byte comparison backstops the Windows inode-reuse weakness."
    next_on_done: [TASK-4]

  TASK-4:
    title: Add bounded shebang fallback to shared language detection
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-3]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: integration
    owner_files:
      - ontoindex-shared/src/language-detection.ts
      - ontoindex-shared/src/index.ts
      - ontoindex/src/core/ingestion/filesystem-walker.ts
      - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
      - ontoindex/src/core/ingestion/workers/parse-worker.ts
      - ontoindex/src/core/ingestion/parsing-processor.ts
      - ontoindex/test/unit/ingestion-utils.test.ts
      - ontoindex/test/integration/filesystem-walker.test.ts
      - ontoindex/test/unit/parse-impl-fallback.test.ts
      - ontoindex/test/integration/parse-fallback.test.ts
    allowed_write_set:
      - ontoindex-shared/src/language-detection.ts
      - ontoindex-shared/src/index.ts
      - ontoindex/src/core/ingestion/filesystem-walker.ts
      - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
      - ontoindex/src/core/ingestion/workers/parse-worker.ts
      - ontoindex/src/core/ingestion/parsing-processor.ts
      - ontoindex/test/unit/ingestion-utils.test.ts
      - ontoindex/test/integration/filesystem-walker.test.ts
      - ontoindex/test/unit/parse-impl-fallback.test.ts
      - ontoindex/test/integration/parse-fallback.test.ts
    target_symbols:
      - getLanguageFromFilename
      - readFileContents
      - runChunkedParseAndResolve
      - processBatch
      - collectParseableWorkerInputs
      - prepareSequentialFile
    do_not_touch:
      - LanguageProvider registry ownership
      - the static phase DAG
      - generated/vendor file ignore policy
      - unsupported interpreters or shell parsing beyond the first shebang line
      - shell/bash interpreter aliasing (shell has no SupportedLanguages, provider, or parser support)
    non_goals:
      - Content-based language classification for arbitrary files.
      - Dynamic language-provider loading.
      - Reading whole unsupported files during scan.
      - Shebang mapping for shell/bash scripts; shell is unsupported because
        SupportedLanguages, the provider registry, and the parser loader have no
        shell entry, so no shell alias may be added.
    source_evidence:
      - ontoindex-shared/src/language-detection.ts:63-79
      - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts:343-379
      - ontoindex/src/core/ingestion/workers/parse-worker.ts:831-871
      - ontoindex/src/core/ingestion/filesystem-walker.ts
      - ontoindex/src/core/ingestion/parsing-processor.ts:446-479,943-950
      - "parsing-processor.ts collectParseableWorkerInputs (line 458) and prepareSequentialFile (line 949) both call path-only getLanguageFromFilename(file.path) and drop files with no detected language before worker/sequential parsing, so both must consume the same additive shebang entry point."
      - "SupportedLanguages enumerates only JavaScript, Python, Ruby, and PHP among script interpreters; there is no shell/bash member, provider, or parser loader, so shebang acceptance is bounded to Python, Ruby, JavaScript/Node, and PHP."
      - "OntoIndex impact on Function:ontoindex-shared/src/language-detection.ts:getLanguageFromFilename is CRITICAL: 52 upstream nodes, 25 direct callers, 6 processes, 7 modules (ingestion, embeddings, workers, pipeline-phases, call-resolution, analysis-packs, enrichment)."
      - "Direct callers include chunker.ts, ast-utils.ts, and structural-extractor.ts in the embeddings path, which are outside this task's write set and must keep working unchanged."
      - "OntoIndex impact (target_uid Function:...parsing-processor.ts:collectParseableWorkerInputs) is LOW: 5 upstream nodes, 1 direct caller (processParsingWithWorkers), 1 process (runChunkedParseAndResolve), 1 module (Ingestion)."
      - "OntoIndex impact (target_uid Function:...parsing-processor.ts:prepareSequentialFile) is LOW: 3 upstream nodes, 1 direct caller (processSequentialFiles), 1 process (processSequentialFiles), 1 module (Ingestion)."
      - "ontoindex-shared/src/index.ts is the package public barrel (package.json exports only `.` -> dist/index.js) and already re-exports getLanguageFromShebang alongside getLanguageFromFilename; adding the shebang entry point requires this one-line additive export update, not a new export surface or scope violation."
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: "Extensionless files are scanned but filtered before parse; both parent and worker language decisions currently use only the path."
    adr_gate:
      required: false
      reason: >-
        Extends the shared detector and existing parse routing with a bounded
        first-line fallback. Provider ownership and the static pipeline remain
        unchanged; recognized extensions retain precedence.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontoindex && npx vitest run test/unit/ingestion-utils.test.ts test/unit/parse-impl-fallback.test.ts"
        - "cd ontoindex && npx vitest run test/integration/filesystem-walker.test.ts test/integration/parse-fallback.test.ts"
      executed:
        - "cd ontoindex && npx vitest run test/unit/ingestion-utils.test.ts test/unit/parse-impl-fallback.test.ts"
        - "cd ontoindex && npx vitest run test/integration/filesystem-walker.test.ts test/integration/parse-fallback.test.ts"
      diff_scope:
        - ontoindex-shared/src/language-detection.ts
        - ontoindex-shared/src/index.ts
        - ontoindex/src/core/ingestion/filesystem-walker.ts
        - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
        - ontoindex/src/core/ingestion/workers/parse-worker.ts
        - ontoindex/src/core/ingestion/parsing-processor.ts
        - ontoindex/test/unit/ingestion-utils.test.ts
        - ontoindex/test/integration/filesystem-walker.test.ts
        - ontoindex/test/unit/parse-impl-fallback.test.ts
        - ontoindex/test/integration/parse-fallback.test.ts
      unrelated_failures: []
    required_validation:
      - "Recognized extensions and basenames win over shebang content."
      - "Extensionless Python, Ruby, JavaScript/Node, and PHP scripts map from only a bounded first line; shell/bash shebangs stay unsupported and are never aliased."
      - "`/usr/bin/env` flags, direct interpreter paths, whitespace, CRLF, and unsupported interpreters are covered."
      - "Parent, worker (collectParseableWorkerInputs), and sequential (prepareSequentialFile) parse paths agree on the detected language for the same file."
      - "The existing `getLanguageFromFilename(filename)` signature and its path-only return value stay unchanged for all 25 direct callers; shebang input arrives through a separate additive entry point rather than a required new parameter."
      - "Embeddings callers (chunker, ast-utils, structural-extractor) are exercised and unchanged."
    expected_evidence:
      - Impact rerun for all four existing target symbols using explicit `target_uid` values, with the CRITICAL detector radius reported to the user before edits.
      - Impact rerun for collectParseableWorkerInputs and prepareSequentialFile using explicit `Function:` target_uid values; both are LOW and reported before edits.
      - A fixture extensionless executable reaches the existing provider parser.
      - An extensionless shell/bash script is still dropped (no shell alias) and this is asserted in the parse fallback fixtures.
      - The scan still does not materialize whole-file contents solely for detection.
      - git diff --check clean on the write set.
    rollback:
      - Revert all write-set files.
    stop_conditions:
      - The implementation needs a dynamic provider, phase, or registry.
      - Detection requires unbounded content reads or executing the file.
      - Existing extension precedence cannot be preserved.
      - The change would require editing any of the 25 direct callers, or altering the existing detector signature in a way that forces caller updates outside the write set.
      - Shell/bash support would require a new SupportedLanguages member, provider, or parser loader, or any shell-to-supported-language alias.
      - The worker and sequential parse paths cannot be made to agree without editing symbols outside the allowed write set.
    closeout_evidence:
      - "The original getLanguageFromFilename remains byte-identical: signature and path-only return unchanged for all 25 direct callers despite its CRITICAL impact radius; shebang input arrives only through the separate additive getLanguageFromShebang entry point."
      - "getLanguageFromShebang detects Python, Ruby, JavaScript/Node, and PHP from a bounded first line across direct interpreter paths, /usr/bin/env flags, interpreter assignments, version suffixes, and whitespace/CRLF; shell/bash shebangs are unsupported and return null, and no shell-to-supported-language alias was added."
      - "filesystem-walker performs 256-byte bounded first-line reads only for extensionless unknown files; recognized extensions/basenames keep precedence and no whole-file materialization occurs during scan."
      - "Parent, worker (collectParseableWorkerInputs), and sequential (prepareSequentialFile) parse paths agree on the detected language for the same extensionless file; embeddings callers (chunker, ast-utils, structural-extractor) are exercised and unchanged."
      - "Validation: 116 unit + 34 integration target tests green, 74 embedding compatibility tests green, shared + ontoindex tsc clean, Prettier --check and scoped git diff --check clean."
      - "gn_verify_diff PASS with the exact 10-file changedFiles override; independent coder-worker-test PASS and coder-worker-challenger PASS."
    evidence:
      - "getLanguageFromFilename unchanged despite CRITICAL 25-caller impact; additive getLanguageFromShebang supports Python/Ruby/Node/PHP via direct paths, env flags, assignments, version suffixes, and whitespace/CRLF; shell unsupported and null."
      - "Bounded 256-byte reads only for extensionless unknown files; extension precedence preserved; parent/worker/sequential parse paths agree."
      - "116 unit + 34 integration target tests, 74 embedding compatibility tests, tsc/Prettier/diff clean, gn_verify_diff PASS over the exact 10 changed files."
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - ontoindex-shared/src/language-detection.ts
        - ontoindex-shared/src/index.ts
        - ontoindex/src/core/ingestion/filesystem-walker.ts
        - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
        - ontoindex/src/core/ingestion/workers/parse-worker.ts
        - ontoindex/src/core/ingestion/parsing-processor.ts
        - ontoindex/test/unit/ingestion-utils.test.ts
        - ontoindex/test/integration/filesystem-walker.test.ts
        - ontoindex/test/unit/parse-impl-fallback.test.ts
        - ontoindex/test/integration/parse-fallback.test.ts
      validation_summary:
        - "cd ontoindex && npx vitest run test/unit/ingestion-utils.test.ts test/unit/parse-impl-fallback.test.ts -> pass (unit)"
        - "cd ontoindex && npx vitest run test/integration/filesystem-walker.test.ts test/integration/parse-fallback.test.ts -> pass (integration)"
        - "116 unit + 34 integration target tests, 74 embedding compatibility tests -> pass; shared + ontoindex tsc, Prettier --check, scoped git diff --check -> clean; gn_verify_diff -> PASS exact 10-file scope"
      evidence_refs:
        - closeout_evidence
        - evidence
      final_outcome_label: done
      remaining_risk: "Optional/non-blocking: no direct processBatch threshold fixture, and the scannedFiles structural type does not explicitly expose shebangLanguage though the runtime spread preserves it."
    next_on_done: [TASK-5]

  TASK-5:
    title: Aggregate degraded files by reason, phase, and detected language
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-4]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: integration
    owner_files:
      - ontoindex/src/core/run-analyze.ts
      - ontoindex/src/storage/repo-manager.ts
      - ontoindex/src/storage/index-capabilities.ts
      - ontoindex/src/core/runtime/runtime-health.ts
      - ontoindex/src/mcp/super/diagnose.ts
      - ontoindex/src/cli/status.ts
      - ontoindex/test/unit/run-analyze-snapshot.test.ts
      - ontoindex/test/unit/index-capabilities.test.ts
      - ontoindex/test/unit/runtime-health.test.ts
      - ontoindex/test/unit/super/diagnose.test.ts
      - ontoindex/test/unit/status.test.ts
    allowed_write_set:
      - ontoindex/src/core/run-analyze.ts
      - ontoindex/src/storage/repo-manager.ts
      - ontoindex/src/storage/index-capabilities.ts
      - ontoindex/src/core/runtime/runtime-health.ts
      - ontoindex/src/mcp/super/diagnose.ts
      - ontoindex/src/cli/status.ts
      - ontoindex/test/unit/run-analyze-snapshot.test.ts
      - ontoindex/test/unit/index-capabilities.test.ts
      - ontoindex/test/unit/runtime-health.test.ts
      - ontoindex/test/unit/super/diagnose.test.ts
      - ontoindex/test/unit/status.test.ts
    target_symbols:
      - runFullAnalysis
      - RepoMeta
      - formatIndexCapabilityWarnings
      - readRuntimeHealth
      - gnDiagnose
      - statusCommand
    do_not_touch:
      - partial checkpoint registration rules
      - capability envelope versioning
      - normal index registration or freshness semantics
      - unbounded MCP file lists
    non_goals:
      - Publishing partial analysis as an index.
      - Adding `status --json` or another diagnostics command.
      - Persisting source contents or full error traces in meta.json.
    source_evidence:
      - ontoindex/src/core/run-analyze.ts:868-895,1235-1260
      - ontoindex/src/storage/repo-manager.ts:15-46
      - ontoindex/src/storage/index-capabilities.ts:8-48
      - ontoindex/src/core/runtime/runtime-health.ts:287-308
      - ontoindex/src/cli/status.ts:93-180
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: false
      reason: >-
        Adds bounded aggregates to existing metadata, runtime-health, status,
        and diagnose owners. It preserves the current capability envelope and
        diagnostic-only treatment of partial/degraded analysis.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontoindex && npx vitest run test/unit/run-analyze-snapshot.test.ts test/unit/index-capabilities.test.ts test/unit/runtime-health.test.ts test/unit/status.test.ts"
        - "cd ontoindex && npx vitest run test/unit/super/diagnose.test.ts"
      executed:
        - "cd ontoindex && npx vitest run test/unit/run-analyze-snapshot.test.ts test/unit/index-capabilities.test.ts test/unit/runtime-health.test.ts test/unit/status.test.ts"
        - "cd ontoindex && npx vitest run test/unit/super/diagnose.test.ts"
      diff_scope:
        - ontoindex/src/core/run-analyze.ts
        - ontoindex/src/storage/repo-manager.ts
        - ontoindex/src/storage/index-capabilities.ts
        - ontoindex/src/core/runtime/runtime-health.ts
        - ontoindex/test/unit/run-analyze-snapshot.test.ts
        - ontoindex/test/unit/index-capabilities.test.ts
        - ontoindex/test/unit/runtime-health.test.ts
        - ontoindex/test/unit/status.test.ts
        - ontoindex/test/unit/super/diagnose.test.ts
      unrelated_failures: []
    required_validation:
      - "meta.json records bounded degraded samples plus deterministic counts by reason, phase, and detected language."
      - "status and gn_diagnose expose the grouped counts through existing contracts."
      - "Unknown phase/language values remain explicit and deterministic."
      - "No MCP response contains an unbounded raw degraded-file list."
    expected_evidence:
      - Impact recorded for all existing target symbols before edits.
      - Snapshot tests prove stable ordering, sample caps, duplicate file handling, and legacy meta compatibility.
      - Runtime-health and diagnose fixtures cover grouped and absent metadata.
      - git diff --check clean on the write set.
    rollback:
      - Revert the eleven write-set files; old meta remains readable because new fields are optional.
    stop_conditions:
      - Aggregation requires a new diagnostics command or envelope version.
      - Raw file lists would become unbounded in MCP output.
      - Partial checkpoints would become registered or queryable as complete indexes.
    closeout_evidence:
      - "run-analyze retains each degraded file's raw reason in bounded legacy samples while grouping on a normalized cause that maps digit runs to N, so numeric-varying reasons collapse into stable groups."
      - "Aggregates are bounded: 100 legacy samples cap, 20 group cap with omittedGroupCount for the remainder, deterministic sort, first-seen unique path retained, and explicit unknown phase/language buckets."
      - "sampledDegradedCount keeps honest semantics (it counts sampled degraded files, not total), and the optional aggregate sampleFiles field is omitted to avoid an unbounded raw list in metadata/MCP output."
      - "Legacy meta fallback preserved: old meta without the new optional aggregates remains readable, and readers tolerate absence of every new field."
      - "runtime-health projects a bounded degraded status warning and gn_diagnose surfaces a bounded runtimeHealth projection; neither emits an unbounded file list."
      - "Source diagnose.ts and cli/status.ts were unchanged; only their unit tests were updated. Actual scope was 9 files (4 source + 5 tests), narrower than the 11-file planned owner set."
      - "Tests 98/98 across the five target suites; shared+ontoindex tsc clean; Prettier --check and scoped git diff --check clean; gn_verify_diff PASS over the exact 9 changed files."
      - "Independent coder-worker-test PASS; coder-worker-challenger PASS after rework."
      - "Unrelated pre-existing runtime-health analyze-lock/repair changes were preserved and are explicitly excluded from TASK-5 scope."
    evidence:
      - meta.json records bounded degraded samples plus deterministic counts by normalized reason, phase, and detected language; digit runs normalize to N for stable grouping while raw reasons stay in bounded legacy samples.
      - 100-sample and 20-group caps with omittedGroupCount, honest sampledDegradedCount, deterministic sort, first-seen unique path, explicit unknown phase/language, omitted optional aggregate sampleFiles, and a working legacy meta fallback.
      - status warning and gn_diagnose runtimeHealth projections are bounded; diagnose.ts and status.ts source unchanged with only tests updated; 9 changed files with gn_verify_diff PASS.
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - ontoindex/src/core/run-analyze.ts
        - ontoindex/src/storage/repo-manager.ts
        - ontoindex/src/storage/index-capabilities.ts
        - ontoindex/src/core/runtime/runtime-health.ts
        - ontoindex/test/unit/run-analyze-snapshot.test.ts
        - ontoindex/test/unit/index-capabilities.test.ts
        - ontoindex/test/unit/runtime-health.test.ts
        - ontoindex/test/unit/status.test.ts
        - ontoindex/test/unit/super/diagnose.test.ts
      validation_summary:
        - "cd ontoindex && npx vitest run test/unit/run-analyze-snapshot.test.ts test/unit/index-capabilities.test.ts test/unit/runtime-health.test.ts test/unit/status.test.ts -> pass"
        - "cd ontoindex && npx vitest run test/unit/super/diagnose.test.ts -> pass (98/98 across the five target suites)"
        - "shared+ontoindex tsc clean; Prettier --check and scoped git diff --check clean; gn_verify_diff -> PASS exact scope over 9 files"
      evidence_refs:
        - closeout_evidence
        - evidence
      final_outcome_label: done
      remaining_risk: "Unrelated pre-existing runtime-health analyze-lock/repair changes remain in the worktree; preserved and out of TASK-5 scope."
    next_on_done: [TASK-6]

  TASK-6:
    title: Add an optional peak-RSS threshold to the large-codebase benchmark
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-5]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: integration
    owner_files:
      - ontoindex/scripts/large-codebase-benchmark.mjs
      - ontoindex/test/unit/large-codebase-benchmark.test.ts
    allowed_write_set:
      - ontoindex/scripts/large-codebase-benchmark.mjs
      - ontoindex/test/unit/large-codebase-benchmark.test.ts
    target_symbols:
      - parseArgs
      - runBenchmark
      - renderMarkdown
    do_not_touch:
      - memory sampling implementation except threshold evaluation
      - analyze command semantics
      - benchmark output location defaults
    non_goals:
      - A new memory profiler.
      - Enforcing a threshold when the option is omitted.
      - Killing a successful run before its report is written.
    source_evidence:
      - ontoindex/scripts/large-codebase-benchmark.mjs:12-105,193-267,268-397
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: "The script records peakRssKiB but cannot fail a run on an explicit memory budget."
    adr_gate:
      required: false
      reason: >-
        Adds an opt-in threshold to an existing benchmark measurement and
        report. No runtime memory subsystem or production behavior changes.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: [TASK-9]
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: coder-worker
      model_requested: null
      model_effective: null
      preflight_result: pass
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 1
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: done
    validation:
      required_commands:
        - "cd ontoindex && npx vitest run test/unit/large-codebase-benchmark.test.ts"
        - "cd ontoindex && node scripts/large-codebase-benchmark.mjs --repo . --mode status --dry-run --max-peak-rss-mib 512"
      executed:
        - "cd ontoindex && npx vitest run test/unit/large-codebase-benchmark.test.ts -> pass (10/10)"
        - "cd ontoindex && node scripts/large-codebase-benchmark.mjs --repo . --mode status --dry-run --max-peak-rss-mib 512 -> maxPeakRssMib present in dry-run JSON"
        - "cd ontoindex && node scripts/large-codebase-benchmark.mjs --help -> lists --max-peak-rss-mib"
      diff_scope:
        - ontoindex/scripts/large-codebase-benchmark.mjs
        - ontoindex/test/unit/large-codebase-benchmark.test.ts
      unrelated_failures: []
    required_validation:
      - "`--max-peak-rss-mib` accepts a positive finite number and appears in dry-run/report metadata."
      - "Exceeded threshold writes JSON and Markdown before returning non-zero."
      - "Unavailable RSS is explicit and fails closed only when a threshold was requested."
      - "Omitted threshold preserves current behavior."
    expected_evidence:
      - Impact rerun for parseArgs, runBenchmark, and renderMarkdown before edits.
      - Unit cases for below, equal, above, omitted, invalid, and unavailable thresholds.
      - git diff --check clean on the write set.
    rollback:
      - Revert the benchmark script and remove its unit test.
    stop_conditions:
      - Threshold evaluation needs a new profiler or platform-specific dependency.
      - The report cannot be written before non-zero exit.
      - Existing no-threshold behavior would change.
    closeout_evidence:
      - "parseArgs validates --max-peak-rss-mib as a positive finite number (rejects non-positive and non-finite) and threads maxPeakRssMib into dry-run output and the report record metadata."
      - "evaluatePeakRssThreshold returns explicit within/exceeded/rss-unavailable/not-requested statuses; runBenchmark impact is LOW."
      - "runBenchmark writes JSON and Markdown reports before setting a non-zero exit code on exceeded or rss-unavailable, so reports precede the failure."
      - "rss-unavailable fails closed only when a threshold was requested; an omitted threshold leaves prior behavior unchanged."
      - "Tests 10/10 in the benchmark unit suite plus direct --help and --dry-run runs; Prettier --check and scoped git diff --check clean; gn_verify_diff PASS over the exact two changed files."
      - "Independent coder-worker-test PASS and coder-worker-challenger PASS."
      - "Residual nonblocking: no direct Markdown-line assertion in the unit suite; pre-existing report-entry portability and Markdown escaping are excluded from TASK-6 scope."
    evidence:
      - "--max-peak-rss-mib accepts a positive finite number and appears in dry-run JSON and the report record; within/exceeded/rss-unavailable/not-requested statuses are explicit."
      - "Reports are written before the non-zero exit; rss-unavailable fails closed only when requested; omitted threshold is unchanged; runBenchmark impact LOW."
      - "Two changed files with gn_verify_diff PASS; 10/10 unit tests plus direct help/dry-run; Prettier and diff --check clean; independent test and challenger PASS."
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - ontoindex/scripts/large-codebase-benchmark.mjs
        - ontoindex/test/unit/large-codebase-benchmark.test.ts
      validation_summary:
        - "cd ontoindex && npx vitest run test/unit/large-codebase-benchmark.test.ts -> pass (10/10)"
        - "cd ontoindex && node scripts/large-codebase-benchmark.mjs --repo . --mode status --dry-run --max-peak-rss-mib 512 -> maxPeakRssMib in dry-run metadata; --help lists the flag"
        - "Prettier --check and scoped git diff --check clean; gn_verify_diff -> PASS exact scope over 2 files"
      evidence_refs:
        - closeout_evidence
        - evidence
      final_outcome_label: done
      remaining_risk: "No direct Markdown-line assertion in the unit suite; pre-existing report-entry portability and Markdown escaping remain out of TASK-6 scope and were not touched."
    next_on_done: [TASK-7, TASK-9]

  TASK-7:
    title: Add a shared cross-language call-resolution precision baseline
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-6]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: integration
    owner_files:
      - ontoindex/test/integration/resolvers/helpers.ts
      - ontoindex/test/integration/resolvers/precision-baseline.test.ts
      - ontoindex/test/fixtures/lang-resolution/precision-baseline.json
    allowed_write_set:
      - ontoindex/test/integration/resolvers/helpers.ts
      - ontoindex/test/integration/resolvers/precision-baseline.test.ts
      - ontoindex/test/fixtures/lang-resolution/precision-baseline.json
    target_symbols:
      - runPipelineFromRepo
      - getRelationships
    do_not_touch:
      - production call-resolution code
      - existing language-specific fixtures except through the baseline manifest
      - resolver scoring or ambiguity policy
    non_goals:
      - A new resolver architecture.
      - Treating unresolved ambiguity as an error.
      - Replacing language-specific integration tests.
    source_evidence:
      - ontoindex/test/integration/resolvers/helpers.ts
      - ontoindex/test/integration/resolvers/*.test.ts
      - ontoindex/test/fixtures/lang-resolution/*
      - ontoindex/test/unit/symbol-table.test.ts
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: "Language fixtures are individually asserted but no shared deterministic precision summary detects cross-language drift."
    adr_gate:
      required: false
      reason: >-
        Adds a test-only aggregate over existing fixtures and the existing
        pipeline. Resolver semantics and production ownership remain unchanged.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontoindex && npx vitest run test/integration/resolvers/precision-baseline.test.ts"
      executed:
        - "cd ontoindex && npx vitest run test/integration/resolvers/precision-baseline.test.ts"
      diff_scope:
        - ontoindex/test/integration/resolvers/precision-baseline.test.ts
        - ontoindex/test/fixtures/lang-resolution/precision-baseline.json
      unrelated_failures: []
    required_validation:
      - "Every semantic language represented by the existing resolver suite contributes positive and negative cases."
      - "Ambiguous fixtures pass when the resolver emits no false-positive edge."
      - "The report is deterministic and changes only through an explicit manifest update."
      - "Existing per-language tests remain authoritative for detailed failures."
    expected_evidence:
      - Manifest schema and language coverage table recorded.
      - Test output reports true positives, false positives, expected unresolved cases, and precision per language.
      - No production file changes.
      - git diff --check clean on the write set.
    rollback:
      - Revert helpers.ts and remove the baseline test/manifest.
    stop_conditions:
      - Baseline requires production resolver changes.
      - A language cannot supply both positive and negative evidence from existing fixtures without inventing semantics.
      - Ambiguous unresolved cases would be scored as failures.
    closeout_evidence:
      - "Two new files only: precision-baseline.test.ts and precision-baseline.json. helpers.ts unchanged despite HIGH 25-test shared impact; no production call-resolution code touched."
      - "v2 manifest carries an independent 14-language inventory with per-language truePositives/falsePositives/falseNegatives/expectedUnresolved/precision; full-availability aggregate is 16 TP, 0 FP, 0 FN, 1 expected unresolved, precision 1."
      - "COBOL supplies the one expected-unresolved dynamic-call case; expected-unresolved passes only when no matching CALLS edge exists and never enters the precision denominator."
      - "Kotlin and Dart are explicit parser-gated skips in this environment; Swift and COBOL resolve. Fixtures are authoritative and skipGraphPhases is true."
      - "Validation: focused precision-baseline suite 19/19; four-language regression 136 passed/228 skipped; tsc clean; Prettier --check and scoped git diff --check clean; exact-scope gn_verify_diff PASS over the two new files."
      - "Independent coder-worker-test PASS and coder-worker-challenger PASS after rework."
    evidence:
      - Test-only aggregate over existing lang-resolution fixtures via a v2 manifest; production resolver semantics and helpers.ts unchanged.
      - Per-language and aggregate TP/FP/FN/expectedUnresolved/precision reported; 16 TP / 0 FP / 0 FN / 1 expected unresolved at full availability, precision 1.
      - Parser-gated Kotlin/Dart record explicit skips when grammar is unavailable; deterministic report updates only through an explicit manifest change.
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - ontoindex/test/integration/resolvers/precision-baseline.test.ts
        - ontoindex/test/fixtures/lang-resolution/precision-baseline.json
      validation_summary:
        - "cd ontoindex && npx vitest run test/integration/resolvers/precision-baseline.test.ts -> pass (19/19)"
        - "four-language resolver regression -> 136 passed / 228 skipped; tsc -> clean"
        - "prettier --check and scoped git diff --check -> clean; gn_verify_diff -> PASS exact scope over the two new files"
      evidence_refs:
        - closeout_evidence
        - evidence
      final_outcome_label: done
      remaining_risk: "Language inventory is hand-maintained in the manifest; Kotlin/Dart precision are not runtime-verified in this environment (parser-gated skips)."
    next_on_done: [TASK-8]

  TASK-8:
    title: Persist relation-type and provenance-band aggregate counts
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-7]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: integration
    owner_files:
      - ontoindex/src/core/graph/fact-provenance.ts
      - ontoindex/src/storage/repo-manager.ts
      - ontoindex/src/core/run-analyze.ts
      - ontoindex/scripts/large-codebase-benchmark.mjs
      - ontoindex/test/unit/graph-fact-provenance.test.ts
      - ontoindex/test/unit/run-analyze-snapshot.test.ts
      - ontoindex/test/unit/large-codebase-benchmark.test.ts
    allowed_write_set:
      - ontoindex/src/core/graph/fact-provenance.ts
      - ontoindex/src/storage/repo-manager.ts
      - ontoindex/src/core/run-analyze.ts
      - ontoindex/scripts/large-codebase-benchmark.mjs
      - ontoindex/test/unit/graph-fact-provenance.test.ts
      - ontoindex/test/unit/run-analyze-snapshot.test.ts
      - ontoindex/test/unit/large-codebase-benchmark.test.ts
    target_symbols:
      - classifyGraphFactProvenance
      - RepoMeta
      - runFullAnalysis
      - summarizeTelemetry
      - renderMarkdown
    do_not_touch:
      - GraphRelationship schema
      - LadybugDB relationship tables
      - provenance classification vocabulary
      - partial checkpoint authority
    non_goals:
      - Per-edge provenance persistence changes.
      - A graph schema migration.
      - New public stats or capabilities commands.
      - Changing how impact-kernel classifies provenance for query responses.
    source_evidence:
      - ontoindex/src/core/graph/fact-provenance.ts
      - ontoindex-shared/src/graph/types.ts:115-165
      - ontoindex/src/core/run-analyze.ts:1235-1260
      - ontoindex/scripts/large-codebase-benchmark.mjs
      - "classifyGraphFactProvenance has exactly one production caller today: impact-kernel.ts:377, which passes only relationType and confidence when projecting query results. It is not currently used during ingestion."
      - "GraphRelationship carries `type` and numeric `confidence` at build time, so ingestion-side classification can call the same pure function with the same two inputs."
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: "No test covers provenance classification applied across a whole built graph; existing coverage is per-input unit cases only."
    adr_gate:
      required: false
      reason: >-
        Persists bounded aggregate distributions derived from the existing
        in-memory KnowledgeGraph and existing provenance classifier. No edge,
        database, or query schema changes.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: [TASK-9]
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontoindex && npx vitest run test/unit/graph-fact-provenance.test.ts test/unit/run-analyze-snapshot.test.ts test/unit/large-codebase-benchmark.test.ts"
      executed:
        - "cd ontoindex && npx vitest run test/unit/graph-fact-provenance.test.ts test/unit/run-analyze-snapshot.test.ts test/unit/large-codebase-benchmark.test.ts"
      diff_scope:
        - ontoindex/src/core/graph/fact-provenance.ts
        - ontoindex/src/storage/repo-manager.ts
        - ontoindex/src/core/run-analyze.ts
        - ontoindex/scripts/large-codebase-benchmark.mjs
        - ontoindex/test/unit/graph-fact-provenance.test.ts
        - ontoindex/test/unit/run-analyze-snapshot.test.ts
        - ontoindex/test/unit/large-codebase-benchmark.test.ts
      unrelated_failures: []
    required_validation:
      - "Relation-type counts and extracted/inferred/ambiguous counts are deterministic and bounded."
      - "Each distribution sums exactly to the total relationship count."
      - "Legacy meta without the aggregate fields remains readable."
      - "Large benchmark JSON/Markdown includes the aggregate distributions for comparisons."
      - "Ingestion-side counting reuses classifyGraphFactProvenance unchanged and passes only relationType and confidence, so impact-kernel classification stays byte-identical."
      - "Counting adds a single bounded pass over existing relationships and does not retain per-edge provenance in memory or on disk."
    expected_evidence:
      - Impact recorded for all existing target symbols before edits.
      - Unit cases cover empty graph, every provenance band, stable ordering, and sum invariants.
      - No GraphRelationship or LadybugDB schema diff.
      - git diff --check clean on the write set.
    rollback:
      - Revert the seven write-set files; optional meta fields can be dropped safely.
    stop_conditions:
      - Counts require changing edge schema or persistence tables.
      - Classification vocabulary must expand beyond extracted/inferred/ambiguous.
      - Aggregate size can grow with repository cardinality rather than fixed relation/provenance vocabularies.
      - Ingestion-side counting would require changing classifyGraphFactProvenance behavior or its impact-kernel results.
    closeout_evidence:
      - "Seven write-set files changed (six modified, one new test large-codebase-benchmark.test.ts); no files outside the allowed write set were touched."
      - "classifyGraphFactProvenance is byte-identical: the fact-provenance.ts diff only appends new exported types and summarizeRelationshipDistributions below the unchanged function body."
      - "summarizeRelationshipDistributions is additive and makes a single visitor pass, passing only relationType and confidence into the unchanged classifier so impact-kernel classification stays identical."
      - "Distributions carry totalRelationships plus byType and byProvenance; byType (summed over count) and the three provenance bands each sum exactly to totalRelationships. Missing/empty types fall into a deterministic UNKNOWN bucket and byType is ordered by descending count then type name."
      - "run-analyze persists relationshipDistributions as an optional meta field legacy readers tolerate; large-codebase-benchmark.mjs surfaces the distributions in both JSON and Markdown output."
      - "TASK-6 is DONE, so TASK-9's extra TASK-6+TASK-8 dependency gate is satisfied."
      - "Validation: focused suite 48/48 green, tsc --noEmit clean, Prettier --check and scoped git diff --check clean, exact-scope gn_verify_diff PASS over the seven files."
      - "Independent coder-worker-test and coder-worker-challenger both returned PASS."
    evidence:
      - Relation-type and provenance-band counts are deterministic, bounded to fixed vocabularies, and each distribution sums exactly to totalRelationships.
      - classifyGraphFactProvenance body unchanged and reused via a single additive pass with only relationType/confidence; impact-kernel classification unaffected.
      - Optional meta field is legacy-readable and both benchmark JSON and Markdown include the aggregate distributions; no GraphRelationship or LadybugDB schema diff.
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - ontoindex/src/core/graph/fact-provenance.ts
        - ontoindex/src/storage/repo-manager.ts
        - ontoindex/src/core/run-analyze.ts
        - ontoindex/scripts/large-codebase-benchmark.mjs
        - ontoindex/test/unit/graph-fact-provenance.test.ts
        - ontoindex/test/unit/run-analyze-snapshot.test.ts
        - ontoindex/test/unit/large-codebase-benchmark.test.ts
      validation_summary:
        - "cd ontoindex && npx vitest run test/unit/graph-fact-provenance.test.ts test/unit/run-analyze-snapshot.test.ts test/unit/large-codebase-benchmark.test.ts -> pass (48/48)"
        - "tsc --noEmit -> clean; Prettier --check and scoped git diff --check -> clean; gn_verify_diff -> PASS exact scope over the seven files"
      evidence_refs:
        - closeout_evidence
        - evidence
      final_outcome_label: done
      remaining_risk: null
    next_on_done: [TASK-9]

  TASK-9:
    title: Add a pinned benchmark scenario manifest
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-6, TASK-8]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: integration
    owner_files:
      - eval/benchmark-scenarios.json
      - ontoindex/scripts/large-codebase-benchmark.mjs
      - ontoindex/test/unit/large-codebase-benchmark.test.ts
    allowed_write_set:
      - eval/benchmark-scenarios.json
      - ontoindex/scripts/large-codebase-benchmark.mjs
      - ontoindex/test/unit/large-codebase-benchmark.test.ts
    target_symbols:
      - parseArgs
      - runBenchmark
    do_not_touch:
      - repository cloning or network fetch behavior
      - benchmark output directory defaults
      - graph-quality field definitions owned by TASK-8
    non_goals:
      - A benchmark orchestration service.
      - Auto-updating pinned commits or thresholds.
      - Running arbitrary shell commands from manifest data.
    source_evidence:
      - ontoindex/scripts/large-codebase-benchmark.mjs
      - eval/
      - "Current benchmark records commit/dirty state but has no checked-in scenario contract."
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: false
      reason: >-
        Adds declarative inputs to the existing benchmark harness. The manifest
        selects existing modes and thresholds; it does not introduce execution
        plugins, remote orchestration, or a new benchmark backend.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: "TASK-6 and TASK-8 must be DONE so memory and graph-quality threshold fields are stable."
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontoindex && npx vitest run test/unit/large-codebase-benchmark.test.ts"
        - "cd ontoindex && node scripts/large-codebase-benchmark.mjs --scenario-manifest ../eval/benchmark-scenarios.json --list-scenarios"
      executed:
        - "cd ontoindex && npx vitest run test/unit/large-codebase-benchmark.test.ts"
        - "cd ontoindex && node scripts/large-codebase-benchmark.mjs --scenario-manifest ../eval/benchmark-scenarios.json --list-scenarios"
      diff_scope:
        - eval/benchmark-scenarios.json
        - ontoindex/scripts/large-codebase-benchmark.mjs
        - ontoindex/test/unit/large-codebase-benchmark.test.ts
      unrelated_failures: []
    required_validation:
      - "Each scenario declares repository path/identity, exact commit, mode/profile, timeout, peak RSS limit, and graph-quality floors."
      - "Dirty or commit-mismatched checkouts fail before benchmark execution."
      - "Manifest parsing is strict, deterministic, and cannot invoke arbitrary commands."
      - "Direct single-repo CLI usage remains supported."
    expected_evidence:
      - Dependency closeout for TASK-6 and TASK-8 recorded before dispatch.
      - Unit cases for valid, malformed, duplicate-id, dirty, and commit-mismatch scenarios.
      - Checked-in scenarios use real immutable commit SHAs and documented thresholds.
      - git diff --check clean on the write set.
    rollback:
      - Revert the benchmark script/test and remove the scenario manifest.
    stop_conditions:
      - TASK-6 or TASK-8 is not DONE.
      - Manifest requires repository cloning, shell snippets, or dynamic plugins.
      - Dirty/mismatched checkouts would only warn instead of fail closed.
    closeout_evidence:
      - "Strict checked-in manifest eval/benchmark-scenarios.json drives the harness via --scenario-manifest; one pinned scenario targets the independent entireio/entire-graph repo at commit 76eb362dfd436c9a5103140cdb34779d797b6885 as a caller-provisioned sibling checkout resolved relative to the manifest."
      - "Preflight verifies canonical remote identity (normalizing .git and ssh forms) and fails closed before spawning any benchmark on missing checkout, remote mismatch, dirty tree, unresolved HEAD, or pinned-commit mismatch; no clone, fetch, network, or shell is used (git runs via spawnSync argv)."
      - "Each scenario declares path/identity, exact commit, mode/profile, timeout, opt-in peak-RSS limit, and graph-quality floors; graphQuality and peak-RSS are evaluated and persisted into JSON and Markdown before the harness returns, and failing floors or missing distributions fail closed. Multi-scenario runs aggregate failures without aborting siblings; direct single-repo CLI usage remains supported."
      - "Validation: focused suite 50/50 green; list-scenarios prints the parsed scenario and absent-checkout preflight fails closed; tsc --noEmit clean; Prettier --check and scoped git diff --check clean; exact-scope gn_verify_diff PASS over the three write-set files."
      - "Independent coder-worker-test and coder-worker-challenger both returned final PASS."
    evidence:
      - Manifest is strict JSON parsed with unknown-key and duplicate-id rejection; no field maps to an arbitrary command and git is invoked via spawnSync argv, never a shell.
      - Preflight (missing/wrong-remote/dirty/commit) runs before any benchmark spawn; graph-quality floors and peak-RSS threshold are persisted to JSON/Markdown before return and fail closed on breach or missing distributions.
      - Caller-provisioned sibling checkout with canonical remote-identity verification; no clone, fetch, or network at run time; direct single-repo CLI path and multi-scenario failure aggregation both preserved.
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - eval/benchmark-scenarios.json
        - ontoindex/scripts/large-codebase-benchmark.mjs
        - ontoindex/test/unit/large-codebase-benchmark.test.ts
      validation_summary:
        - "cd ontoindex && npx vitest run test/unit/large-codebase-benchmark.test.ts -> pass (50/50)"
        - "cd ontoindex && node scripts/large-codebase-benchmark.mjs --scenario-manifest ../eval/benchmark-scenarios.json --list-scenarios -> pass (parsed scenario printed; absent-checkout preflight fails closed)"
        - "tsc --noEmit -> clean; prettier --check + scoped git diff --check -> clean; gn_verify_diff -> PASS exact scope over the three files"
      evidence_refs:
        - closeout_evidence
        - evidence
      final_outcome_label: done
      remaining_risk: "Conservative remote-identity normalization does not normalize port differences, and --list-scenarios is manifest-only; both non-blocking."
    next_on_done: [TASK-10]

  TASK-10:
    title: Add graph-first and locate-share fields to model smoke transcripts
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-9]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
      - ontoindex/scripts/kimi-k3-mcp-smoke.mjs
      - ontoindex/test/unit/kimi-k3-mcp-smoke.test.ts
    allowed_write_set:
      - ontoindex/scripts/kimi-k3-mcp-smoke.mjs
      - ontoindex/test/unit/kimi-k3-mcp-smoke.test.ts
    target_symbols:
      - gradeModelRun
      - runSmoke
      - runModel
    do_not_touch:
      - global runtime telemetry
      - user prompt collection outside explicit smoke runs
      - model provider or MCP tool contracts
    non_goals:
      - Monitoring arbitrary agent sessions.
      - Inferring redundant grep usage outside evaluation artifacts.
      - Adding a new evaluation service.
    source_evidence:
      - ontoindex/scripts/kimi-k3-mcp-smoke.mjs:160-323,425-459
      - ontoindex/test/unit/kimi-k3-mcp-smoke.test.ts
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: false
      reason: >-
        Extends explicit evaluation artifacts already written by the smoke
        harness. It does not add product telemetry or copy prompt content into a
        global store.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontoindex && npx vitest run test/unit/kimi-k3-mcp-smoke.test.ts"
      executed:
        - "cd ontoindex && npx vitest run test/unit/kimi-k3-mcp-smoke.test.ts"
      diff_scope:
        - ontoindex/scripts/kimi-k3-mcp-smoke.mjs
        - ontoindex/test/unit/kimi-k3-mcp-smoke.test.ts
      unrelated_failures:
        - "gn_verify_diff scope=all surfaces 38 pre-existing dirty worktree files outside TASK-10; exact-scope verify over the two TASK-10 files is PASS."
    required_validation:
      - "Transcript metadata reports first locate mechanism, graph locate count, fallback locate count, and graph share."
      - "Classification uses only recorded tool-call identities, not assistant prose."
      - "Empty/no-tool and malformed transcript cases are explicit."
      - "No additional prompt text is copied into global or cross-run telemetry."
    expected_evidence:
      - Impact rerun for gradeModelRun, runSmoke, and runModel before edits.
      - Fixture transcripts cover graph-first, fallback-first, graph-only, fallback-only, mixed, and no-locate cases.
      - Existing smoke gates remain unchanged.
      - git diff --check clean on the write set.
    rollback:
      - Revert the smoke script and its unit test.
    stop_conditions:
      - Measurement needs runtime-global collection or prompt-body retention.
      - Tool identity cannot be classified deterministically from the transcript.
      - Existing model grading semantics would change.
    closeout_evidence:
      - "Transcript locate metadata (extractTranscriptLocateMetadata) reports firstLocateMechanism as graph/fallback/none/malformed with graphLocateCount, fallbackLocateCount, and graphShare; graph vs fallback is decided solely from recorded tool-call identities, never assistant prose or the prompt body."
      - "Empty/no-tool transcripts resolve to none and structurally invalid transcripts to malformed; metadata is computed per model run and propagated through gradeModelRun/runModel into runSmoke output only, with no global runtime telemetry and no prompt-body retention."
      - "Validation: focused suite 18/18 green; Prettier --check and scoped git diff --check clean over the two write-set files; exact-scope gn_verify_diff PASS over the two TASK-10 files (worker-verified)."
      - "Independent coder-worker-test and coder-worker-challenger both returned final PASS."
    evidence:
      - Graph/fallback classification keys off tool names (canonical MCP and gn_ locate tools vs grep/find/read/shell fallbacks); assistant prose and prompt text are ignored.
      - locateMetadata is per-run, threaded through gradeModelRun and runModel into runSmoke output; no global telemetry write and no prompt content is copied cross-run.
      - none and malformed transcript branches are explicit; graphShare is graphLocateCount/(graph+fallback) and 0 when no locate tool is called.
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - ontoindex/scripts/kimi-k3-mcp-smoke.mjs
        - ontoindex/test/unit/kimi-k3-mcp-smoke.test.ts
      validation_summary:
        - "cd ontoindex && npx vitest run test/unit/kimi-k3-mcp-smoke.test.ts -> pass (18/18)"
        - "prettier --check + scoped git diff --check -> clean; gn_verify_diff -> PASS exact scope over the two TASK-10 files (scope=all only shows unrelated dirty files)"
      evidence_refs:
        - closeout_evidence
        - evidence
      final_outcome_label: done
      remaining_risk: "LOW: canonical mcp__ namespace is not needed by this harness's bare inspect transcript, and the broad gn_/non-locate taxonomy could inflate counts if reused for arbitrary sessions, which is outside the plan's non-goal scope."
    next_on_done: [TASK-11]

  TASK-11:
    title: Add cache, response-size, truncation, and retrieval fields to query logs
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-10]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: integration
    owner_files:
      - ontoindex/src/mcp/local/query-log.ts
      - ontoindex/src/mcp/local/backend-search.ts
      - ontoindex/src/mcp/local/tool-telemetry.ts
      - ontoindex/test/unit/query-log.test.ts
      - ontoindex/test/unit/backend-search-typed.test.ts
      - ontoindex/test/unit/tool-telemetry.test.ts
    allowed_write_set:
      - ontoindex/src/mcp/local/query-log.ts
      - ontoindex/src/mcp/local/backend-search.ts
      - ontoindex/src/mcp/local/tool-telemetry.ts
      - ontoindex/test/unit/query-log.test.ts
      - ontoindex/test/unit/backend-search-typed.test.ts
      - ontoindex/test/unit/tool-telemetry.test.ts
    target_symbols:
      - appendQueryLog
      - query
      - recordToolCall
    do_not_touch:
      - public search response shape
      - cache key or freshness behavior
      - a new stats command or telemetry service
      - unbounded query/result storage
    non_goals:
      - Logging full responses.
      - Making logging failures user-visible or fatal.
      - Global aggregation outside the existing JSONL files.
    source_evidence:
      - ontoindex/src/mcp/local/query-log.ts:20-84
      - ontoindex/src/mcp/local/backend-search.ts:1587-1665,2170-2178
      - ontoindex/src/mcp/local/tool-telemetry.ts
      - "backend-search.ts:query is a complexity hotspot spanning roughly 1534-2320 with multiple return points; the cache-hit branch at 1628 returns before the single appendQueryLog call at 2173."
      - "OntoIndex reports zero upstream callers for both appendQueryLog and query. Treat this as missing graph coverage, not isolation, and confirm MCP/CLI/HTTP callers from source before editing."
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: "The current append point misses cache-hit early returns and records no response-size, truncation, or retrieval-mode evidence."
    adr_gate:
      required: false
      reason: >-
        Adds bounded operational fields to an existing opt-out, non-fatal query
        log and reuses existing response-size telemetry. Public query contracts
        and cache behavior remain unchanged.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontoindex && npx vitest run test/unit/query-log.test.ts test/unit/backend-search-typed.test.ts test/unit/tool-telemetry.test.ts"
      executed:
        - "cd ontoindex && npx vitest run test/unit/query-log.test.ts test/unit/backend-search-typed.test.ts test/unit/tool-telemetry.test.ts"
      diff_scope:
        - ontoindex/src/mcp/local/backend-search.ts
        - ontoindex/src/mcp/local/query-log.ts
        - ontoindex/test/unit/backend-search-typed.test.ts
        - ontoindex/test/unit/query-log.test.ts
      unrelated_failures: []
    required_validation:
      - "Every structured search exit records hit/miss/stale/expired or disabled cache status when logging is enabled."
      - "Entry includes bounded response bytes, truncation state/reasons, and retrieval mode/policy."
      - "JSONL query/result bounds and rotation behavior remain intact."
      - "Disabled logging and write failures remain non-fatal."
    expected_evidence:
      - Impact rerun for appendQueryLog, query, and recordToolCall before edits, with the zero-caller graph gap explicitly reconciled against source callers.
      - Unit cases for hit, miss, stale, expired, truncated, plain/typed modes, disabled logging, and write failure.
      - No full response bodies or unbounded arrays in log fixtures.
      - git diff --check clean on the write set.
    rollback:
      - Revert the six write-set files; old JSONL readers tolerate absent new fields.
    stop_conditions:
      - Logging requires changing public search results or cache semantics.
      - A common append path cannot cover early returns without broad query refactoring.
      - Response bodies or user prompts would be stored unbounded.
    closeout_evidence:
      - "Centralized logQueryExit (backend-search.ts:365) is the sole appendQueryLog caller and covers all five query() return points once, replacing the prior single append that missed cache-hit early returns."
      - "Each exit records cache status (hit/miss/stale/expired or disabled), pre-guard UTF8 responseBytes via Buffer.byteLength, bounded truncation reasons, and retrieval mode/policy; JSONL query/result caps and rotation stay intact via unchanged tool-telemetry."
      - "Disabled logging and appendQueryLog write failures remain non-fatal (.catch swallow); tool-telemetry.ts source and test are unchanged."
      - "Zero-caller graph gap reconciled from source: appendQueryLog has one real caller (logQueryExit) plus its import; query() is an MCP/CLI entry with no in-graph callers."
      - "Raw NUL byte in the HEAD copy of query-log.test.ts removed from the worktree (0 raw NUL bytes); runtime escaped-NUL test is green."
      - "Validation: required suite 50/50 green, tsc/build, Prettier --check and git diff --check clean on the four files; exact 4-file gn_verify_diff PASS (scope=all only surfaces pre-existing unrelated dirty files)."
      - "Independent coder-worker-test and coder-worker-challenger both returned final PASS after rework."
    evidence:
      - logQueryExit computes responseBytes before the response-size guard so oversized responses are still bounded and flagged; truncatedReasons drives the truncated boolean.
      - Cache status defaults to disabled when logging is off and otherwise reflects hit/miss/stale/expired; retrieval mode/policy distinguish plain vs typed queries.
      - Serialization and logging are skipped when the query log is disabled at the append boundary; appendQueryLog rejections are swallowed to keep query paths non-fatal.
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - ontoindex/src/mcp/local/backend-search.ts
        - ontoindex/src/mcp/local/query-log.ts
        - ontoindex/test/unit/backend-search-typed.test.ts
        - ontoindex/test/unit/query-log.test.ts
      validation_summary:
        - "cd ontoindex && npx vitest run test/unit/query-log.test.ts test/unit/backend-search-typed.test.ts test/unit/tool-telemetry.test.ts -> pass (50/50)"
        - "tsc/build, prettier --check + git diff --check -> clean on the four files; exact 4-file gn_verify_diff -> PASS (scope=all only shows pre-existing unrelated dirty files)"
      evidence_refs:
        - closeout_evidence
        - evidence
      final_outcome_label: done
      remaining_risk: "LOW (non-blocking): pre-guard serialization consumes CPU even when the query log is disabled at the guard boundary, and thrown exceptions on query paths are not logged; both preserve unchanged semantics."
    next_on_done: [TASK-12]

  TASK-12:
    title: Tighten generated agent guidance to a small-tool ladder and freshness rule
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-11]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
      - ontoindex/src/cli/ai-context.ts
      - ontoindex/src/cli/setup.ts
      - ontoindex/test/unit/ai-context.test.ts
      - ontoindex/test/unit/setup.test.ts
      - ontoindex/test/unit/setup-codex.test.ts
    allowed_write_set:
      - ontoindex/src/cli/ai-context.ts
      - ontoindex/src/cli/setup.ts
      - ontoindex/test/unit/ai-context.test.ts
      - ontoindex/test/unit/setup.test.ts
      - ontoindex/test/unit/setup-codex.test.ts
    target_symbols:
      - generateOntoIndexContent
      - ensureOntoIndexAgentGuidance
    do_not_touch:
      - setup client configuration behavior
      - managed block markers and include-file ownership
      - a new agent-guide command
      - automatic analysis or silent freshness repair
    non_goals:
      - Adding more generated documentation surfaces.
      - Running analyze automatically from generated instructions.
      - Encoding every OntoIndex tool in the generated block.
    source_evidence:
      - ontoindex/src/cli/ai-context.ts:65-140
      - ontoindex/src/cli/setup.ts:76-100,296-337
      - ontoindex/test/unit/ai-context.test.ts
      - ontoindex/test/unit/setup.test.ts
      - ontoindex/test/unit/setup-codex.test.ts
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: false
      reason: >-
        Edits text emitted by existing managed guidance owners. Tool ownership,
        setup behavior, MCP contracts, and explicit freshness remain unchanged.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontoindex && npx vitest run test/unit/ai-context.test.ts test/unit/setup.test.ts test/unit/setup-codex.test.ts"
      executed:
        - "cd ontoindex && npx vitest run test/unit/ai-context.test.ts test/unit/setup.test.ts test/unit/setup-codex.test.ts"
        - "cd ontoindex && npx tsc --noEmit"
        - "npx prettier --check ontoindex/src/cli/ai-context.ts ontoindex/src/cli/setup.ts ontoindex/test/unit/ai-context.test.ts ontoindex/test/unit/setup.test.ts ontoindex/test/unit/setup-codex.test.ts"
        - "git diff --check -- ontoindex/src/cli/ai-context.ts ontoindex/src/cli/setup.ts ontoindex/test/unit/ai-context.test.ts ontoindex/test/unit/setup.test.ts"
      diff_scope:
        - ontoindex/src/cli/ai-context.ts
        - ontoindex/src/cli/setup.ts
        - ontoindex/test/unit/ai-context.test.ts
        - ontoindex/test/unit/setup.test.ts
      unrelated_failures: []
    required_validation:
      - "Generated guidance orders explore/search, inspect, impact, and verify-diff as a concise ladder."
      - "Guidance explicitly requires re-analysis when HEAD differs from indexed commit and forbids silent worktree graph assumptions."
      - "Managed block replacement and ONTOINDEX.md include behavior remain idempotent."
      - "No new command or product surface is introduced."
    expected_evidence:
      - Impact rerun for generateOntoIndexContent and ensureOntoIndexAgentGuidance before edits.
      - Golden text assertions cover both repository-managed blocks and global ONTOINDEX.md guidance.
      - Repeated generation produces byte-identical output after the first update.
      - git diff --check clean on the write set.
    rollback:
      - Revert the five write-set files.
    stop_conditions:
      - The change requires a new command, hook, or automatic analyze behavior.
      - Managed block markers or include ownership must change.
      - Guidance grows into a full tool catalog rather than a concise ladder.
    closeout_evidence:
      - "Implementation changed exactly four files: ontoindex/src/cli/ai-context.ts, ontoindex/src/cli/setup.ts, ontoindex/test/unit/ai-context.test.ts, ontoindex/test/unit/setup.test.ts. setup-codex.test.ts remained unchanged but was included in validation."
      - "Both generated surfaces emit the ordered ladder: explore/search; inspect/context; impact before edits; gn_verify_diff before commit."
      - "Both surfaces state the graph is commit-based: if current HEAD differs from the indexed commit, exactly one coordinated process MUST re-analyze before graph-backed claims; dirty/uncommitted changes must not be silently assumed represented and current source/diff must be verified."
      - "Managed markers, include-file ownership, and control flow are unchanged; user content is preserved; no new command/product surface or auto-analysis was added."
      - "Repeated generation is asserted byte-identical for repo-managed CLAUDE.md and global ONTOINDEX.md across .claude/.codex/.ontocode."
      - "Final validation: focused Vitest 3 files / 42 tests PASS; npx tsc --noEmit PASS; Prettier --check on five owner files PASS; scoped git diff --check PASS."
      - "OntoIndex impacts LOW: generateOntoIndexContent 9 upstream/1 direct/2 processes/2 modules; ensureOntoIndexAgentGuidance 4 upstream/1 direct/1 module; generateAIContextFiles 8 upstream/3 direct/2 processes/2 modules; setupCommand 3 direct."
      - "Final independent coder-worker-test PASS and final coder-worker-challenger PASS."
      - "gn_verify_diff with changedFiles/expectedFiles set to the exact four task files shows no unexpected changed files and no missing required tests, but aggregate status is FAIL due to cumulative dirty-worktree changed-symbol/impact pollution; recorded as a tooling limitation, not a PASS claim."
    evidence:
      - Both generated guidance surfaces order the concise ladder explore/search, inspect/context, impact-before-edit, gn_verify_diff-before-commit, and both state the commit-based freshness rule requiring one coordinated re-analysis when HEAD differs from the indexed commit with no silent worktree graph assumption.
      - Managed block markers, include-file ownership, and control flow are unchanged and user content is preserved; no new command/product surface or automatic analysis was introduced.
      - Repeated generation is byte-identical for repo-managed CLAUDE.md and global ONTOINDEX.md across .claude/.codex/.ontocode; focused Vitest 3 files/42 tests, tsc --noEmit, Prettier --check, and scoped git diff --check all pass on the four changed files.
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - ontoindex/src/cli/ai-context.ts
        - ontoindex/src/cli/setup.ts
        - ontoindex/test/unit/ai-context.test.ts
        - ontoindex/test/unit/setup.test.ts
      validation_summary:
        - "cd ontoindex && npx vitest run test/unit/ai-context.test.ts test/unit/setup.test.ts test/unit/setup-codex.test.ts -> pass (3 files / 42 tests)"
        - "cd ontoindex && npx tsc --noEmit -> pass"
        - "npx prettier --check on the five owner files -> clean; scoped git diff --check -> clean"
        - "gn_verify_diff with exact four-file changedFiles/expectedFiles -> no unexpected changed files and no missing required tests; aggregate scope=all status FAIL from cumulative dirty-worktree changed-symbol/impact pollution (tooling limitation, not a PASS)"
      evidence_refs:
        - closeout_evidence
        - evidence
      final_outcome_label: done
      remaining_risk: "LOW: generated guidance is advisory; committed generated artifacts converge on regeneration; aggregate gn_verify_diff remains noisy in the cumulative dirty worktree."
    next_on_done: []
```

## Dispatch Authorization

Sub-agent dispatch is authorized for the four roles named in
`dispatch_preflight.required_roles`. `coder-architector` owns readiness,
paperwork, ADR decisions, and final closeout. Each `coder-worker` receives one
task only and may edit only that task's `allowed_write_set`. No local fallback
is allowed. Tasks execute in numeric order; TASK-9 additionally requires both
TASK-6 and TASK-8 to be DONE.

## Dispatch Preflight

Before substantive work, cache one non-mutating capability probe per
role/effective-model/tool-surface tuple. A successful spawn does not prove child
repository read/write, shell, or OntoIndex capability. Missing child capability
is `blocked: capability unavailable`. Immediately before each task, rerun
`git status --short` on its write set and stop on overlapping user changes.

## Goal

Implement the 12 retained extensions from `ENTIRE_GRAPH_100_APPROACHES.md` as
bounded changes to existing OntoIndex owners. The result improves release and CI
correctness, cache and ingestion reliability, degraded-state diagnostics,
benchmark reproducibility, graph-quality evidence, evaluation measurement, and
generated agent guidance without adding a second graph, store, query backend,
pipeline, capability surface, or partial-index publication path.

## Planning Principles

- Keep one `KnowledgeGraph` persisted to LadybugDB; CLI, MCP, and HTTP remain
  projections over the same backend.
- Keep indexed-commit freshness explicit. No task may silently combine worktree
  state with cached graph answers.
- Keep partial checkpoints diagnostic and unregistered.
- Extend existing capability envelopes and commands; do not add `stats`,
  `agent-guide`, `capabilities`, or status-line products.
- Keep the compile-time phase DAG and `LanguageProvider` ownership intact.
- Prefer optional fields, pure helpers, focused tests, and checked-in fixtures
  over new services or dependencies.
- Existing metadata readers must tolerate absence of every newly added optional
  field.

## Current Source Evidence

- OntoIndex MCP returned successfully but the index is stale (`8bcdc39e` versus
  `ecbd066e`), embeddings are absent, and graph scope confidence is medium.
- The current worktree has one untracked planning input and no dirty source
  files. Workers must still check their exact write set before editing.
- `bench.yml` currently cannot detect regressions because it suppresses the
  benchmark exit and copies baseline data to current data. Its referenced
  `test/bench` files are absent.
- `publish.yml` creates the GitHub tarball before npm publication but does not
  query the tag-specific release API or inspect the downloaded public asset.
- Semantic cache identity, TTL, stale-head handling, and count eviction already
  exist; only atomic replacement and byte-bound pruning are planned.
- Shared language detection is extension/basename based. Parse selection and
  worker grouping both call it from file paths, so both owners must agree on a
  bounded shebang fallback.
- Degraded files are collected from telemetry into `meta.json` as path/reason
  pairs. Existing status/health output mostly reports a count or one reason.
- Relationship type is a bounded union and provenance already classifies facts
  as extracted, inferred, or ambiguous, so aggregate distributions need no graph
  schema change.
- The large benchmark already records repository commit/dirty state, process
  tree RSS, JSON, and Markdown output; thresholds and pinned scenarios can reuse
  those owners.
- The smoke harness already writes exact run-local metadata/transcripts. Query
  logging and tool response-size telemetry already exist and are bounded.

## Task Preparation Rules

1. Select only `manager_loop.active_next_task` unless it is blocked by an
   explicit dependency or stop condition.
2. Re-read the current source and dirty diff for every owner file immediately
   before dispatch.
3. Run OntoIndex impact for every existing target symbol before editing; report
   direct callers, affected processes, and risk. Warn before HIGH/CRITICAL work.
4. Treat stale graph output as advisory and verify exact claims from current
   source.
5. Do not expand a task write set after dispatch. Stop and update this plan
   first.
6. Do not add a task-local abstraction unless it removes concrete duplication
   inside the allowed write set and matches an existing pattern.

## Execution Rules

Implement exactly one task per worker. Preserve unrelated user changes. Keep all
new fields optional and bounded. Fail closed on malformed benchmark manifests,
release assets, and threshold inputs. Do not auto-analyze, publish partial
indexes, add alternate stores/query systems, or add dependencies unless a task
stop condition routes the work back to `coder-architector` for a new ADR/plan.

## Validation Tier Policy

- `ci`: TASK-1 must prove the workflow consumes actual benchmark output and the
  gate fails a deterministic regression.
- `release`: TASK-2 must validate the tag-specific public asset contract before
  npm publication; unit tests remain offline.
- `integration`: TASK-4, TASK-5, TASK-6, TASK-7, TASK-8, TASK-9, and TASK-11
  cross file/process or persisted-output boundaries that unit-only source checks
  cannot prove.
- `unit-fast`: TASK-3, TASK-10, and TASK-12 are bounded pure/local behavior with
  focused deterministic tests.

## Evidence Protocol

Every task records the exact changed files, pre-edit impact output, validation
commands and exit results, source references, before/after behavior, rollback,
reviewer result, and remaining risk. CI/release tasks include fixture evidence
for failure paths. Metadata/telemetry tasks include size bounds and legacy-reader
compatibility. No generated benchmark outputs, tarballs, cache files, logs,
temporary repositories, or credentials may be committed.

## Definition Of Ready

Each task card has one bounded owner, allowed write set, target symbols,
non-goals, exact validation, acceptance evidence, rollback, stop conditions,
reviewer, and ADR disposition. The queue has exactly one dependency-ready OPEN
task at a time; TASK-9 also records its extra TASK-6 gate. The stale-index and
direct-source fallback limitations are explicit.

## Definition Of Done

A task is DONE only when work stayed inside its write set, all required focused
validation passed, `git diff --check` is clean, no generated artifacts were
added, OntoIndex diff verification matches expected files/symbols/tests, the
challenger confirms architectural invariants and non-goals were preserved, and
the closeout fields record evidence and remaining risk. The plan is complete
only when all 12 tasks are DONE and a final planned-vs-done challenge passes.

## Fixtures And Test Data

- TASK-1 uses a deterministic local Vitest benchmark and checked-in baseline;
  no network or production repository.
- TASK-2 builds release JSON and tarball fixtures inside tests; no live GitHub
  call occurs in unit validation.
- TASK-4 uses temporary extensionless files with bounded first lines.
- TASK-7 reuses existing `test/fixtures/lang-resolution` repositories through a
  checked-in precision manifest.
- TASK-9 uses checked-in immutable scenario definitions but does not clone or
  mutate target repositories.
- TASK-10 and TASK-11 use synthetic transcripts/query results with no real user
  prompt or response bodies beyond the existing bounded fixtures.

## Senior-Owned Work

Pre-junior contributors must not change the graph/store/query architecture,
freshness policy, partial-index authority, public capability envelopes, static
phase DAG, provider registry, graph schema, publication artifact format, or add
new commands/dependencies. Any such need stops the task and routes to
`coder-architector` for an ADR and separate plan.

## Phase 1: Release And CI Correctness

### Task TASK-1: Real benchmark gate

Replace simulated current data with Vitest `--outputJson` output, provide the
missing deterministic benchmark/baseline, and fail on benchmark or regression
errors. See `tasks.TASK-1`.

### Task TASK-2: Live release asset verification

After GitHub release creation, verify the tag-specific public tarball, package
version, and CLI entry before npm publication. See `tasks.TASK-2`.

## Phase 2: Reliability And Diagnostics

### Task TASK-3: Atomic byte-bounded semantic cache

Use atomic replacement and enforce count plus total-byte limits without changing
cache identity or freshness. See `tasks.TASK-3`.

### Task TASK-4: Shebang fallback

Detect supported extensionless scripts from a bounded first line while keeping
extension precedence and provider ownership. See `tasks.TASK-4`.

### Task TASK-5: Degraded-file aggregates

Persist and project bounded counts by reason, phase, and language through the
existing status/runtime/diagnose owners. See `tasks.TASK-5`.

### Task TASK-6: Peak-RSS threshold

Add an opt-in memory threshold that writes the report before returning failure.
See `tasks.TASK-6`.

## Phase 3: Quality And Benchmark Evidence

### Task TASK-7: Cross-language precision baseline

Aggregate existing positive, negative, and ambiguity fixtures into a stable
test-only precision report. See `tasks.TASK-7`.

### Task TASK-8: Relationship distributions

Persist bounded relation-type and provenance-band counts and include them in
large benchmark output. See `tasks.TASK-8`.

### Task TASK-9: Pinned scenario manifest

After TASK-6 and TASK-8 stabilize threshold fields, add strict checked-in
benchmark scenarios with immutable commits. See `tasks.TASK-9`.

## Phase 4: Agent And Retrieval Measurement

### Task TASK-10: Graph-first transcript fields

Add run-local locate mechanism/count/share evidence to the existing smoke
artifacts. See `tasks.TASK-10`.

### Task TASK-11: Query-log operational fields

Record bounded cache, response-size, truncation, and retrieval-mode data across
all structured search exits. See `tasks.TASK-11`.

### Task TASK-12: Concise generated guidance

Align both generated guidance owners on the small-tool ladder and explicit
indexed-commit freshness rule. See `tasks.TASK-12`.

## Required Traceability

| Requirement ID | Retained extension | Disposition | Task IDs | Validation | Status |
|---|---|---|---|---|---|
| EGA-001 | Graph-first and locate-share evaluation fields | implementation | TASK-10 | `kimi-k3-mcp-smoke.test.ts` fixture transcript classifications | DONE |
| EGA-002 | Cache/response/truncation/retrieval query-log fields | implementation | TASK-11 | query-log, backend-search, and tool-telemetry unit suites | DONE |
| EGA-003 | Small-tool ladder and explicit freshness guidance | implementation | TASK-12 | ai-context/setup idempotency suites | DONE |
| EGA-004 | Atomic semantic-cache writes and byte ceiling | implementation | TASK-3 | semantic-cache unit suite | DONE |
| EGA-005 | Shebang fallback for extensionless executable files | implementation | TASK-4 | ingestion-utils, filesystem-walker, and parse fallback suites | DONE |
| EGA-006 | Degraded-file aggregates by reason/phase/language | implementation | TASK-5 | run-analyze, capabilities, health, status, diagnose suites | DONE |
| EGA-007 | Shared cross-language call precision baseline | compatibility-test | TASK-7 | resolver precision baseline integration suite | DONE |
| EGA-008 | Relation-type and provenance-band counts | implementation | TASK-8 | provenance, run-analyze snapshot, benchmark suites | DONE |
| EGA-009 | Real benchmark CI gate | implementation | TASK-1 | real Vitest benchmark output plus bench-gate tests | DONE |
| EGA-010 | Optional peak-RSS threshold | implementation | TASK-6 | large benchmark unit/dry-run validation | DONE |
| EGA-011 | Pinned benchmark scenario manifest | implementation | TASK-9 | manifest parser and list-scenarios validation | DONE |
| EGA-012 | Live release-asset verification | implementation | TASK-2 | offline verifier tests and workflow ordering | DONE |

## Quality Gate

```yaml
quality_gate:
  unmapped_requirements: 0
  missing_task_fields: 0
  missing_acceptance_fixtures: 0
  missing_failure_routes: 0
  branch_deadlocks: 0
  dependency_errors: 0
  write_scope_errors: 0
  prose_yaml_mismatches: 0
  challenger_findings: 0
```

## Final Closeout

The project closes only when TASK-1 through TASK-12 are DONE with recorded
validation and exact changed-file evidence, TASK-9's dependency gate was
respected, final `gn_verify_diff({repo: "ontoindex", scope: "all"})` reports no
unexpected files/symbols/tests, and a final `coder-worker-challenger`
planned-vs-done review confirms all core decisions and rejection boundaries from
`ENTIRE_GRAPH_100_APPROACHES.md` remain intact. Then set
`manager_loop.closeout_state: complete` and `manager_loop.status: closed`.

## Standard Validation Commands

- TASK-1: `cd ontoindex && npx vitest bench test/bench/query.bench.ts --project=lbug-db --outputJson test/bench/current.json && node scripts/bench-gate.mjs && npx vitest run test/unit/bench-gate.test.ts`
- TASK-2: `cd ontoindex && npx vitest run test/unit/verify-release-asset.test.ts`
- TASK-3: `cd ontoindex && npx vitest run test/unit/core/semantic-cache.test.ts`
- TASK-4: `cd ontoindex && npx vitest run test/unit/ingestion-utils.test.ts test/unit/parse-impl-fallback.test.ts test/integration/filesystem-walker.test.ts test/integration/parse-fallback.test.ts`
- TASK-5: `cd ontoindex && npx vitest run test/unit/run-analyze-snapshot.test.ts test/unit/index-capabilities.test.ts test/unit/runtime-health.test.ts test/unit/status.test.ts test/unit/super/diagnose.test.ts`
- TASK-6/TASK-8/TASK-9: `cd ontoindex && npx vitest run test/unit/large-codebase-benchmark.test.ts`
- TASK-7: `cd ontoindex && npx vitest run test/integration/resolvers/precision-baseline.test.ts`
- TASK-10: `cd ontoindex && npx vitest run test/unit/kimi-k3-mcp-smoke.test.ts`
- TASK-11: `cd ontoindex && npx vitest run test/unit/query-log.test.ts test/unit/backend-search-typed.test.ts test/unit/tool-telemetry.test.ts`
- TASK-12: `cd ontoindex && npx vitest run test/unit/ai-context.test.ts test/unit/setup.test.ts test/unit/setup-codex.test.ts`
- Every task: scoped `git diff --check`; before commit: `gn_verify_diff({repo: "ontoindex", scope: "all"})`.
