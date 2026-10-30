# Answer Verify CLI Project Plan

Date: 2026-10-14
Status: Closed — shipped in PR #110 (4f77487)
Authority: Follow-up to DONOR_LTM_ANSWER_GROUNDING_PROJECT_PLAN.md (PR #108, #109). Its DL-3.0 decision allowed wiring in a separate plan: 40 of 270 path citations reported (0.148, limit 0.25), median 0.27 ms (limit 20 ms). User requirement of 2026-10-14: review done work, compare options, consolidate the best one and implement it with sub-agents.

## Goal

`ontoindex docs verify-answer <file>` reads an answer text and reports which cited file paths and code symbols do not exist in the repository, using `git ls-files` for paths and the indexed graph for symbols. It never fails because the graph is unavailable; it reports the symbol check as skipped instead. No tool schema, MCP response or stored fact changes.

## How To Use This Plan

Edit only files in the task's `allowed_write_set`. Run commands from the worktree `ontoindex/` directory. Do not change `markdown-answer-grounding.ts` or `markdown-mention-resolution.ts`. If a stop condition occurs, stop and report the full output.

## Current State

Observed on `origin/master` at `0fe72ad`.

- `checkAnswerGrounding(answer, { docPaths, mentionTargets })` and `extractAnswerCitations(answer)` exist in `ontoindex/src/core/ingestion/enrichment/markdown-answer-grounding.ts`. Nothing calls them.
- `resolveMentionTexts(texts, provider, options?)` in `markdown-mention-resolution.ts` returns `{ resolutions: Map<text, MentionResolution>, summary }`, looks up at most `MARKDOWN_MENTION_MAX_DISTINCT` (40) distinct names, and sets `summary.status` to `partial` on timeout or provider error.
- `LbugGraphIdentityProvider({ repoId })` is the provider used by `local-backend.ts`. `cli/docs.ts` already opens the graph for route candidates with `initLbug(repoId, lbugPath)`, `repoId = repoPath`, `lbugPath = await resolveActiveLbugPath(getStoragePaths(repoPath).storagePath)`, and closes it with `closeLbug(repoId)` in a `finally` block.
- `cli/docs.ts` exports command functions registered in `cli/index.ts` with `createLazyAction(() => import('./docs.js'), '<name>')`. `test/unit/docs-cli.test.ts` mocks `repo-manager`, `git`, `fs/promises` and `process.exit`.
- Options compared and set aside: adding the check to the `query` response (no answer input exists), a new MCP `docs` action (changes tool schema and contract snapshots), adding `test/integration` to PR CI (+6.5 min per PR, unrelated to this feature).
- The OntoIndex index is stale (commit `7b1494c`); source on `origin/master` is the authority.

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
  AV-1.0:
    title: Given an answer text, a path list and an optional symbol provider, when verifyAnswer runs, then missing paths are ungrounded, symbols are checked against the provider, and a missing or failing provider yields unverifiable symbols instead of false ungrounded ones
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/src/core/ingestion/enrichment/markdown-answer-verify.ts
      - ontoindex/test/unit/markdown-answer-verify.test.ts
    allowed_write_set:
      - ontoindex/src/core/ingestion/enrichment/markdown-answer-verify.ts
      - ontoindex/test/unit/markdown-answer-verify.test.ts
    non_goals:
      - Editing markdown-answer-grounding.ts, markdown-mention-resolution.ts, cli/docs.ts or cli/index.ts.
      - File system, git, graph or network access inside the module.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/markdown-answer-verify.test.ts test/unit/markdown-answer-grounding.test.ts
      - cd ontoindex && npx tsc --noEmit -p tsconfig.json
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/ingestion/enrichment/markdown-answer-grounding.ts
        - src/core/ingestion/enrichment/markdown-mention-resolution.ts
      generated_outputs: []
    expected_evidence:
      - Both commands exit 0 and the new test file reports AV1-A through AV1-F passing.
    rollback:
      - git rm --cached -f ontoindex/src/core/ingestion/enrichment/markdown-answer-verify.ts ontoindex/test/unit/markdown-answer-verify.test.ts
    stop_conditions:
      - The module needs a change to a file outside the write set.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on 2026-10-30 to reconcile shipped plans
        validation_summary: Shipped in PR #110 (4f77487); closeout table AV-1.0..AV-3.0. Modules present on master; 2026-10-30 vitest run of markdown-answer-verify, markdown-answer-grounding, markdown-mention-resolution and sidecar-local-backend-enrichment passed 67 tests in 4 files, exit 0.
    dod_status: pass

  AV-2.0:
    title: Given an answer file and the CLI, when docs verify-answer runs, then it prints the report as JSON or text, exits 1 only with --strict and an ungrounded status, and still reports when the graph cannot be opened
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
      - AV-1.0
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/src/cli/docs.ts
      - ontoindex/src/cli/index.ts
      - ontoindex/test/unit/docs-verify-answer-cli.test.ts
    allowed_write_set:
      - ontoindex/src/cli/docs.ts
      - ontoindex/src/cli/index.ts
      - ontoindex/test/unit/docs-verify-answer-cli.test.ts
    non_goals:
      - Changing any existing command, option or output.
      - Editing test/unit/docs-cli.test.ts.
      - Adding an MCP tool or changing a tool schema.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/docs-verify-answer-cli.test.ts test/unit/docs-cli.test.ts test/unit/markdown-answer-verify.test.ts
      - cd ontoindex && npx tsc --noEmit -p tsconfig.json
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/ingestion/enrichment/markdown-answer-verify.ts
      generated_outputs: []
    expected_evidence:
      - Both commands exit 0; AV2-A through AV2-E pass and every test in docs-cli.test.ts still passes unchanged.
    rollback:
      - git checkout -- ontoindex/src/cli/docs.ts ontoindex/src/cli/index.ts
      - git rm --cached -f ontoindex/test/unit/docs-verify-answer-cli.test.ts
    stop_conditions:
      - An existing docs-cli test fails.
      - A CLI contract or help snapshot test outside the write set fails and needs a snapshot update; report it.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on 2026-10-30 to reconcile shipped plans
        validation_summary: Shipped in PR #110 (4f77487); closeout table AV-1.0..AV-3.0. Modules present on master; 2026-10-30 vitest run of markdown-answer-verify, markdown-answer-grounding, markdown-mention-resolution and sidecar-local-backend-enrichment passed 67 tests in 4 files, exit 0.
    dod_status: pass

  AV-3.0:
    title: Given the built CLI and this repository's tracked plans as answers, when verify-answer runs on them, then exit codes, report fields and timing are recorded
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
      - AV-2.0
    type: measurement
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - .memory-bank/audit_session-markdown-graph-rag-recall.md
    allowed_write_set:
      - .memory-bank/audit_session-markdown-graph-rag-recall.md
    non_goals:
      - Changing source.
    required_validation:
      - grep -q "^## Answer verify CLI" .memory-bank/audit_session-markdown-graph-rag-recall.md
    validation_workspace:
      root: .
      inputs:
        - ontoindex/src/cli/docs.ts
      generated_outputs: []
    expected_evidence:
      - The audit-session file has an Answer verify CLI section with the command, JSON status, symbolCheck value, counts and wall time for two runs (graph available and graph unavailable).
    rollback:
      - git checkout -- .memory-bank/audit_session-markdown-graph-rag-recall.md
    stop_conditions:
      - The command crashes with a stack trace instead of a report.
    known_blockers: []
    closeout:
      role_results:
        coder-performance: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on 2026-10-30 to reconcile shipped plans
        validation_summary: Shipped in PR #110 (4f77487); closeout table AV-1.0..AV-3.0. Measurement recorded in the plan closeout and audit-session file; 2026-10-30 vitest run of the four Markdown answer, mention and sidecar test files passed 67 tests, exit 0.
    dod_status: pass
```

## Task Cards

### AV-1.0: verification core

Create `ontoindex/src/core/ingestion/enrichment/markdown-answer-verify.ts` exporting exactly:

```ts
import type { GraphIdentityProvider } from './markdown-graph-identity-provider.js';
import type { AnswerGroundingResult } from './markdown-answer-grounding.js';

export interface VerifyAnswerInput {
  answer: string;
  paths: readonly string[];
  provider?: Pick<GraphIdentityProvider, 'findSymbols'>;
}
export interface VerifyAnswerReport extends AnswerGroundingResult {
  symbolCheck: 'ok' | 'partial' | 'skipped';
  pathsKnown: number;
}

export async function verifyAnswer(input: VerifyAnswerInput): Promise<VerifyAnswerReport>;
```

Rules, all fixed:

1. Call `extractAnswerCitations(input.answer)` and collect the `text` of every `kind === 'symbol'` citation.
2. With no `provider`, or with no symbol citations and no provider, `symbolCheck` is `skipped` and `mentionTargets` is `{}`. With a provider and zero symbol citations, `symbolCheck` is `ok` without a lookup.
3. With a provider and at least one symbol citation, call `resolveMentionTexts(symbolTexts, provider)`. Set `symbolCheck` to `summary.status === 'ok' ? 'ok' : 'partial'`. Build `mentionTargets` from the returned `resolutions` map: one entry per text with `status` and `targets` (map each target to `{ name, filePath }`).
4. Call `checkAnswerGrounding(input.answer, { docPaths: input.paths, mentionTargets })`.
5. If `symbolCheck` is `partial` or `skipped`, or if the number of distinct `mentionLookupName` values among the symbol citations is greater than `MARKDOWN_MENTION_MAX_DISTINCT`, move every symbol citation from `ungrounded` into `unverifiable` (keep order, append after the existing unverifiable items) and recompute `status`: `no-citations` if there were no citations at all, `ungrounded` if any `ungrounded` remain, else `grounded`. Path citations are never moved.
6. Return the grounding result with `symbolCheck` and `pathsKnown: input.paths.length` added.

Tests (`markdown-answer-verify.test.ts`, fake provider objects, no mocks of other modules):
- AV1-A: no provider; a missing path is ungrounded, a symbol citation is unverifiable, `symbolCheck` is `skipped`, status is `ungrounded` because of the path.
- AV1-B: provider returns one candidate with `startLine` for `buildPhaseList` and none for `ghostFn`; `buildPhaseList` is grounded, `ghostFn` ungrounded, `symbolCheck` is `ok`.
- AV1-C: provider that throws; symbols become unverifiable, `symbolCheck` is `partial`, status is `grounded` when all paths exist.
- AV1-D: answer with only existing paths and no symbols and a provider whose `findSymbols` must not be called (assert zero calls); `symbolCheck` is `ok`.
- AV1-E: 45 distinct symbol citations such as `` `SymbolA0` `` to `` `SymbolA44` `` with a provider that returns nothing; none is reported ungrounded (all unverifiable).
- AV1-F: an answer with no citations returns status `no-citations`.

### AV-2.0: CLI command

In `ontoindex/src/cli/docs.ts` add and export:

```ts
export const verifyAnswerCommand = async (
  file: string,
  options: { json?: boolean; strict?: boolean; repo?: string },
): Promise<void>;
```

Behavior:

1. `resolveRepoPath(options)`; when null print `Not a git repository and no --repo specified.` to stderr and `process.exit(1)`.
2. Read `file` with `readFile(file, 'utf8')` from `fs/promises`; on error print `Cannot read <file>: <message>` to stderr and `process.exit(1)`.
3. List paths with `execFileSync('git', ['ls-files'], { cwd: repoPath, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })` from `node:child_process`, split on newlines, drop empty entries. On error print `git ls-files failed: <message>` to stderr and `process.exit(1)`.
4. Provider: `const repo = await findRepo(repoPath)`. When `repo` is missing, no provider and a warning `repository is not indexed; symbol check skipped`. Otherwise, in a `try`, `await initLbug(repoPath, await resolveActiveLbugPath(getStoragePaths(repo.repoPath).storagePath))` and use `new LbugGraphIdentityProvider({ repoId: repoPath })`; when `initLbug` throws, no provider and a warning `graph unavailable: <message>; symbol check skipped`. Always `await closeLbug(repoPath).catch(() => undefined)` in a `finally` after verification.
5. Call `verifyAnswer({ answer, paths, provider })`. Output `JSON.stringify({ ...report, warnings }, null, 2)` when `--json`, otherwise a text report: a first line `Answer grounding: <status> (symbols: <symbolCheck>)`, then one line `  ungrounded <kind> <text>` per ungrounded citation and `  unverifiable <kind> <text>` per unverifiable citation, then each warning prefixed `warning: `.
6. When `options.strict` and `report.status === 'ungrounded'`, `process.exit(1)`. Otherwise return normally (exit code 0).

In `ontoindex/src/cli/index.ts`, after the `knowledge` command registration, add:

```ts
docsProgram
  .command('verify-answer <file>')
  .description('Check that paths and symbols cited in an answer file exist in the repository')
  .option('--json', 'Output stable JSON')
  .option('--strict', 'Exit non-zero when a cited path or symbol is not found')
  .option('-r, --repo <path>', 'Target repository')
  .action(createLazyAction(() => import('./docs.js'), 'verifyAnswerCommand'));
```

Tests in `docs-verify-answer-cli.test.ts` (mock `../../src/storage/repo-manager.js`, `../../src/storage/git.js`, `../../src/core/lbug/pool-adapter.js`, `node:child_process`, `fs/promises` and `../../src/core/ingestion/enrichment/markdown-answer-verify.js`; spy on `process.exit` and `console.log` the way `docs-cli.test.ts` does):
- AV2-A: with `--json`, the printed JSON contains the mocked report fields and `warnings`.
- AV2-B: `--strict` with a report whose status is `ungrounded` calls `process.exit(1)`; without `--strict` it does not.
- AV2-C: `initLbug` rejecting still prints a report, passes no provider to `verifyAnswer`, and adds a `graph unavailable` warning.
- AV2-D: an unreadable file prints a `Cannot read` message and exits 1.
- AV2-E: `closeLbug` is called once after a successful graph open, also when `verifyAnswer` rejects.

### AV-3.0: live measurement

After AV-2.0 is merged and `ontoindex` is rebuilt (`npm run build` in `ontoindex/`), run from the repository root with `node ontoindex/dist/cli/index.js`:

```bash
node ontoindex/dist/cli/index.js docs verify-answer .memory-bank/DONOR_LTM_ANSWER_GROUNDING_PROJECT_PLAN.md --json
node ontoindex/dist/cli/index.js docs verify-answer .memory-bank/MARKDOWN_MENTION_RESOLUTION_PROJECT_PLAN.md --json --strict
```

Run each once with the graph available and once with `--repo` pointing at a directory that is a git repository without an index. Record in an `Answer verify CLI` section of the audit-session file: each command, exit code, JSON `status`, `symbolCheck`, counts of grounded, ungrounded and unverifiable citations, and wall time. The unindexed run must show `symbolCheck: "skipped"` and a warning; if either run prints a stack trace, record it and stop.

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REQ-001 | Wire the grounding check where a user can run it | implementation | AV-2.0 | AV2-A through AV2-E |
| REQ-002 | Symbol check never produces false ungrounded reports when the graph is missing, partial or over the lookup cap | implementation | AV-1.0 | AV1-A, AV1-C, AV1-E |
| REQ-003 | Show the command works on real files and without an index | proof-only | AV-3.0 | Recorded Answer verify CLI section |
| REQ-004 | No tool schema, MCP response or stored fact changes | non-goal | AV-2.0 | Existing docs-cli tests unchanged and passing |
| REQ-005 | Query response field, MCP `docs` action, integration tests in PR CI | rejected | AV-2.0 | See Decisions |

## Decisions And Non-Goals

- Chosen: a CLI command over an injectable core. The core is a pure function; only the CLI touches git, the file system and the graph.
- Rejected, `query` response field: `query` has no answer text input.
- Rejected for now, MCP `docs` action: it changes the tool schema and contract snapshots; revisit after this command is proven.
- Rejected, `test/integration` in PR CI: costs about 6.5 minutes per PR and is unrelated to this feature; a scheduled run is a separate decision.
- Paths are checked against `git ls-files`, so untracked files cited by an answer are reported. That is intended.
- Plan files under `.memory-bank/` are written in the main session; code write sets stay under `ontoindex/`.

## Closeout
Executed 2026-10-14 with two workers (`gpt-6-luna` xhigh for AV-1.0, `gpt-6.1-sol` low for the AV-2.0 tests); the CLI wiring was written in the main session.

| Task | Result | Evidence |
| --- | --- | --- |
| AV-1.0 | Done | Module and tests AV1-A to AV1-F; 12 tests with the grounding tests pass. |
| AV-2.0 | Done | `verifyAnswerCommand` and registration; `docs-verify-answer-cli.test.ts` (6 cases) and the unchanged `docs-cli.test.ts` pass, 39 tests in 4 files; `tsc` exit 0. |
| AV-3.0 | Done | See "Answer verify CLI" in the audit-session file. |

Deviations: the strict exit uses `process.exit(1)` after the graph is closed instead of `process.exitCode`, so tests can observe it. Open: symbol check against a fresh index of current `master`, and the underscore false positives in the grounding module.

