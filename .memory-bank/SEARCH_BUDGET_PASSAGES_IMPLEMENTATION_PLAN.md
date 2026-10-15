# Search and evidence token caps: implementation plan

Status: Phase 1 (T0-T7) and Phase 2 (T9-T13) implemented and verified in
worktree `/opt/d1/_wrk/ontoindex-max-tokens`, branch `feat/search-max-tokens`
(based on `origin/master` `6783906`). Phase 1 is commit `e728be3`; Phase 2 is
the commit that follows `a78fe91`. Full `test:unit` passes (550 files, 8563
tests), `tsc --noEmit` exits 0, and the benchmark assertion passes. T8 is open:
push and pull request are blocked because `gh auth status` reports an invalid
token for `er77`. Run `gh auth login`, then push the branch and open the PR
against `master`.

## Execution result

- `npx tsc --noEmit -p tsconfig.json` exits 0.
- 12 test files, 465 tests pass. Prettier is clean on the changed files.
- Benchmark (`scripts/search-budget-benchmark.mjs`, 6 queries, `limit:3`,
  `max_symbols:3`):

| Config | Mean tokens | Hit rate |
|---|---|---|
| uncapped | 839.2 | 100.0% |
| `max_tokens: 1200` | 888.0 | 100.0% |
| `include_content` | 1999.7 | 100.0% |
| `include_content` + `max_tokens: 1200` | 1200.7 | 83.3% |
| docs policy + `max_tokens: 1200` | 19334.5 | 100.0% |

- `max_tokens` alone adds about 50 tokens for the `budget` report, so it does
  not shrink responses that already fit.
- With `include_content`, the cap holds the response at about 1,200 tokens.
  It drops the ranked-later result for `reciprocal rank fusion merge`
  (`hybrid-search.ts`), which is the expected rank-order trade-off.
- With the docs policy the cap leaves the response near 19,000 tokens, because
  `enrichment` is not counted. This confirms deferred item D1.

## Goal

An agent can ask OntoIndex for a small, ranked, verifiable answer under an
approximate token cap:

- `search({action:"semantic", limit:3, max_tokens:1200})` returns the top
  results, trimmed in rank order to fit the cap, plus a report of what was
  dropped.
- `inspect({action:"evidence", targets:[...], max_tokens:1200})` returns
  line-window snippets until the cap is reached. Entries past the cap keep file
  and line range, so they stay verifiable.
- The docs-plus-code mode is reachable with one existing parameter,
  `retrieval_policy: "graph-with-passive-docs"`, and the MCP hint recommends it.

## Verified baseline

All references are to `origin/master` at `2aa86d0` (package version `2.3.4`),
paths relative to `ontoindex/`.

| Fact | Evidence |
|---|---|
| `search` semantic has no token cap. Bounds are `limit` (1-100) and `max_symbols` (1-200). | `src/mcp/local/tool-params.ts:34-53` |
| The facade `search` tool already has `token_budget` with default `4000`, used by repomap. A semantic cap must use a different name. | `src/mcp/facade/tool-definitions.ts:191-195` |
| `query-budget.ts` records token cost and pricing. It does not estimate text size. | `src/core/runtime/query-budget.ts:139-150` |
| The token estimator is `estimateTokens(text) = ceil(text.length / 4)`. Repomap already uses it for its budget. | `src/core/wiki/llm-client.ts:74`, `src/mcp/local/backend-repomap.ts:382-385` |
| `inspect` evidence already returns `startLine +/- context_lines` windows read from the working copy, with file and line range. File targets return a leading window. Only a total cap is missing. | `src/mcp/local/backend-evidence-pack.ts:100-110,159-190,255-308` |
| `retrieval_policy: "graph-with-passive-docs"` turns on fact consumption, passive expansion and Markdown context in one parameter. | `src/mcp/local/local-backend.ts:2386-2396`, `src/core/ingestion/enrichment/docs-retrieval-policies.ts` |
| The semantic-search MCP hint recommends the three-flag chain. It still fires when `retrieval_policy` already enabled docs. | `src/mcp/server.ts:291-299` |
| All MCP and CLI semantic searches pass through `LocalBackend.query`, which calls `queryImpl` once. | `src/mcp/local/local-backend.ts:2369-2429` |
| Internal tool JSON schemas must match their Zod schemas. A test enforces this. | `test/unit/tool-params-validation.test.ts` |

Measured response size for query `evidence pack snippet window`, `limit:3`,
`max_symbols:3`, installed `ontoindex 2.3.4`:

| Parameters | Bytes | Approx. tokens |
|---|---|---|
| defaults | 2,844 | 711 |
| `include_content: true` | 6,680 | 1,670 |
| `retrieval_policy: "graph-with-passive-docs"` | 92,717 | 23,179 |

In the docs-policy response, 85,145 bytes are `enrichment` (`facts` 46,404,
`relatedChunks` 30,447). That payload is outside the primary results. See
deferred item D1.

OntoIndex impact (graph at `7b1494c`): `LocalBackend.query` LOW, 2 direct
callers. `runEvidencePack` LOW: it is reached through the tool handler map, not
through direct calls. `estimateTokens` MEDIUM, 5 direct callers. It is imported,
not modified.

## Decisions

| Decision | Rejected alternative | Reason |
|---|---|---|
| New parameter `max_tokens` on semantic `search` and `inspect` evidence. | Reuse `token_budget`. | The facade `search` schema advertises `token_budget` default `4000` for repomap. Clients that fill defaults would cap every semantic search. |
| Trim primary results inside `LocalBackend.query`, right after `queryImpl`. | Trim inside `backend-search.ts`. | `backend-search.ts` `query` has cache-hit, abstain and main return paths. `LocalBackend.query` is the single entry, and docs expansion then follows only the kept results. |
| Estimate with `estimateTokens` from `core/wiki/llm-client.ts`. | Extend `query-budget.ts`. | `query-budget.ts` owns cost accounting, not size estimation. Repomap already uses `estimateTokens`. |
| Evidence cap omits snippets past the cap and keeps every entry. | Drop entries past the cap. | Kept file and line range remain verifiable with a normal read. |
| Docs-plus-code mode stays `retrieval_policy: "graph-with-passive-docs"`. The hint recommends it. | New `profile: "docs+code"` parameter. | The policy already sets the same flags. A profile would duplicate it. |
| No index-time passage chunking. | Chunk files into passage nodes. | Evidence windows already provide passages. Chunking changes the graph schema and forces a reindex. |

## Execution rules for every task

- Work only in the task worktree created by T0. Run commands from its
  `ontoindex/` directory.
- Edit only the files listed in the task. If another file needs a change, stop
  and report it.
- Line numbers are approximate. Locate code by the quoted text or symbol name.
- Match the existing code style. Do not add dependencies.
- Do not run `ontoindex analyze`, `npm run build`, `npm ci` or the full test
  suite unless the task says so.
- Report: changed files, commands run with exit codes, and the last 5 lines of
  each test run.

## T0. Create the worktree (coordinator)

```bash
cd /opt/d1/_wrk/ontoindex
git fetch origin
git worktree add /opt/d1/_wrk/ontoindex-max-tokens -b feat/search-max-tokens origin/master
cd /opt/d1/_wrk/ontoindex-max-tokens/ontoindex
npm ci
npx tsc --noEmit -p tsconfig.json
```

Done when `npx tsc` exits 0. Stop if `npm ci` fails. Report the error.

## T1. Search trimming helper (new files only)

Files:
- create `src/mcp/local/search-token-budget.ts`
- create `test/unit/search-token-budget.test.ts`

Implement in `search-token-budget.ts`:

```ts
import { estimateTokens } from '../../core/wiki/llm-client.js';

export interface SearchTokenBudgetReport {
  max_tokens: number;
  estimated_tokens: number;
  kept_process_symbols: number;
  kept_definitions: number;
  dropped_process_symbols: number;
  dropped_definitions: number;
  skeletons_dropped: boolean;
  truncated: boolean;
  over_budget: boolean;
}

export function estimateJsonTokens(value: unknown): number;
export function applySearchTokenBudget<T>(result: T, maxTokens: number): T;
```

Behavior of `estimateJsonTokens`: return `estimateTokens(JSON.stringify(value) ?? '')`.

Behavior of `applySearchTokenBudget`:

1. If `result` is not an object, or has neither a `definitions` array nor a
   `process_symbols` array, return `result` unchanged.
2. Never mutate the input. Work on a shallow copy, and copy arrays.
3. Let `base` be the copy with `process_symbols: []` and `definitions: []`.
   Missing arrays count as empty.
4. If `estimateJsonTokens(base) > maxTokens` and `base` has a `skeletons` key,
   delete `skeletons` and set `skeletons_dropped = true`.
5. Set `used = estimateJsonTokens(base)`. Walk `process_symbols` in order, then
   `definitions` in order. For each item, `cost = estimateJsonTokens(item) + 1`.
   If `used + cost <= maxTokens`, keep it and add `cost`. Otherwise stop adding
   any further items from both arrays. Do not skip and continue.
6. If no item was kept and the input had at least one item, keep
   `process_symbols[0]`, or `definitions[0]` when there are no process symbols.
7. Leave `processes` and every other key unchanged.
8. Set `estimated_tokens = estimateJsonTokens(output without budget)`,
   `truncated = dropped_process_symbols + dropped_definitions > 0 || skeletons_dropped`,
   `over_budget = estimated_tokens > maxTokens`.
9. Return the output with `budget: SearchTokenBudgetReport` added.

Tests in `search-token-budget.test.ts` (vitest; follow the import style of
`test/unit/evidence-pack.test.ts`):

- `returns non-search values unchanged`: input `{ error: 'x' }` returns an
  equal object without `budget`.
- `keeps everything under a large budget`: 3 process symbols and 3
  definitions, `maxTokens: 100000`, everything kept, `truncated: false`,
  `over_budget: false`.
- `trims in rank order and stops at the first item that does not fit`:
  definitions with `content` of 40, 4000 and 40 characters, budget fitting only
  the first. Output has exactly the first definition, `dropped_definitions: 2`.
- `fills process_symbols before definitions`.
- `keeps one item when the budget is smaller than the first item`:
  `maxTokens: 1`, one item kept, `over_budget: true`.
- `drops skeletons when the base alone exceeds the budget`.
- `does not mutate the input`: deep-equal the input before and after.

Commands:

```bash
npx vitest run test/unit/search-token-budget.test.ts
npx tsc --noEmit -p tsconfig.json
```

Done when both exit 0.

## T2. Parameter schemas

Files:
- `src/mcp/local/tool-params.ts`
- `src/mcp/tools.ts`
- `src/mcp/facade/tool-definitions.ts`

Steps:

1. `tool-params.ts`: in `QuerySchema`, after `max_symbols`, add
   `max_tokens: z.number().min(1).max(200000).optional(),`. Add the same line to
   `EvidencePackSchema` after `context_lines`.
2. `tools.ts`: in the `query` tool `inputSchema.properties`, after
   `max_symbols`, add:

   ```ts
   max_tokens: {
     type: 'number',
     description:
       'Approximate token cap for primary results (process_symbols, definitions, skeletons). Results are trimmed in rank order and a budget report is added. Enrichment and docs payloads are not counted. Omit for no cap.',
     minimum: 1,
     maximum: 200000,
   },
   ```

   In the `evidence_pack` tool, after `context_lines`, add:

   ```ts
   max_tokens: {
     type: 'number',
     description:
       'Approximate token cap for evidence snippets. Entries past the cap keep file and line range and omit the snippet. Omit for no cap.',
     minimum: 1,
     maximum: 200000,
   },
   ```

3. `tool-definitions.ts`: add the `query` property to the `search` tool after
   `max_symbols`. Prefix its description with `For action="semantic", `. Add the
   `evidence_pack` property to the `inspect` tool after `context_lines`, with
   the prefix `For action="evidence", `. Do not change `token_budget`.

Commands:

```bash
npx vitest run test/unit/tool-params-validation.test.ts test/unit/tools.test.ts test/unit/facade-completeness.test.ts test/unit/facade-operation-mapping.test.ts test/unit/super/tool-registry-modes.test.ts
npx tsc --noEmit -p tsconfig.json
```

Done when both exit 0. No new tests: the parity test covers the schemas.

## T3. Apply the search cap (after T1 and T2)

Files:
- `src/mcp/local/local-backend.ts`
- `test/unit/sidecar-local-backend-enrichment.test.ts`

Steps in `local-backend.ts`, method `private async query(` (about line 2369):

1. Import `applySearchTokenBudget` from `./search-token-budget.js` next to the
   `import { query as queryImpl } from './backend-search.js';` line.
2. Add `max_tokens?: number;` to the method's `params` type.
3. Replace `const result = await queryImpl(repo as any, params);` with:

   ```ts
   const rawResult = await queryImpl(repo as any, params);
   const result =
     typeof params.max_tokens === 'number'
       ? applySearchTokenBudget(rawResult, params.max_tokens)
       : rawResult;
   ```

   Leave every later use of `result` in the method as it is.

Tests: append one `describe('LocalBackend semantic max_tokens', ...)` block at
the end of `sidecar-local-backend-enrichment.test.ts`. Reuse the file's
existing mocks, `createRepo()` and `beforeEach`. Use the test
`decorates query, context, and impact results with available sidecar status`
as the pattern.

- `trims primary results when max_tokens is set`: mock
  `backendMocks.queryImpl` to resolve
  `{ definitions: <10 items, each { name: 'd<i>', filePath: 'src/a.ts', content: 'x'.repeat(400) }> }`.
  Call `backend.callTool('query', { query: 'auth', max_tokens: 300 })`. Expect
  `definitions.length` between 1 and 9, `budget.truncated === true` and
  `budget.max_tokens === 300`.
- `leaves results unchanged without max_tokens`: same mock, no `max_tokens`.
  Expect 10 definitions and no `budget` key.

Commands:

```bash
npx vitest run test/unit/sidecar-local-backend-enrichment.test.ts test/unit/search-token-budget.test.ts
npx tsc --noEmit -p tsconfig.json
```

Done when both exit 0. Stop if an existing test in that file fails.

## T4. Evidence snippet cap

Files:
- `src/mcp/local/backend-evidence-pack.ts`
- `test/unit/evidence-pack.test.ts`

Steps in `backend-evidence-pack.ts`:

1. Import `estimateTokens` from `../../core/wiki/llm-client.js`.
2. Add `snippet_omitted?: boolean;` to `interface EvidenceEntry`. Add to
   `interface EvidencePackResult`:
   `budget?: { max_tokens: number; estimated_tokens: number; snippets_omitted: number; over_budget: boolean };`.
3. In `runEvidencePack`, add `max_tokens?: number` to the `params` type.
4. After the `for (const target of targets)` loop and before the success
   `return {`, add:

   ```ts
   let budget: EvidencePackResult['budget'];
   if (typeof params?.max_tokens === 'number') {
     const maxTokens = params.max_tokens;
     let used = 0;
     let omitted = 0;
     evidence.forEach((entry, index) => {
       const cost = estimateTokens(JSON.stringify(entry));
       if (index === 0 || used + cost <= maxTokens) {
         used += cost;
         return;
       }
       if (entry.snippet !== undefined) {
         delete entry.snippet;
         entry.snippet_omitted = true;
         omitted += 1;
       }
       used += estimateTokens(JSON.stringify(entry));
     });
     const estimated = estimateTokens(JSON.stringify(evidence));
     budget = {
       max_tokens: maxTokens,
       estimated_tokens: estimated,
       snippets_omitted: omitted,
       over_budget: estimated > maxTokens,
     };
   }
   ```

5. Add `...(budget && { budget }),` as the last property of the success return
   object.

Tests: add to the `describe('evidence_pack', ...)` block, using its `tmpDir`
fixture and the `repo: any = { id: 'not-initialized', ... }` pattern:

- `omits snippets past max_tokens and keeps line ranges`: targets
  `['src/auth.ts:2', 'src/auth.ts:7']`, `context_lines: 1`, `max_tokens: 1`.
  Expect `evidence[0].snippet` defined, `evidence[1].snippet` undefined,
  `evidence[1].snippet_omitted === true`, `evidence[1].start_line` defined,
  `budget.snippets_omitted === 1` and `budget.over_budget === true`.
- `keeps all snippets under a large max_tokens`: same targets,
  `max_tokens: 100000`. Both snippets defined, `snippets_omitted === 0`,
  `over_budget === false`.
- `adds no budget without max_tokens`: one target. Expect `budget` undefined.

Commands:

```bash
npx vitest run test/unit/evidence-pack.test.ts
npx tsc --noEmit -p tsconfig.json
```

Done when both exit 0.

## T5. CLI flag (after T3)

Files:
- `src/cli/index.ts`
- `src/cli/tool.ts`
- `test/unit/tool-direct-cli.test.ts`

Steps:

1. `index.ts`, in the `.command('query <search_query>')` chain, after the
   `--limit` option add
   `.option('--max-tokens <n>', 'Approximate token cap for primary results')`.
2. `tool.ts`, in `queryCommand`: add `maxTokens?: string;` to the `options`
   type. After the `if (options?.excludePath?.length)` line add
   `if (options?.maxTokens) params.max_tokens = Number.parseInt(options.maxTokens, 10);`.

Test: add to `tool-direct-cli.test.ts`, using the pattern of
`dispatches typed query documents through the typed backend path`:
`passes --max-tokens to the query tool`. Call
`queryCommand('auth flow', { maxTokens: '1200' })` and expect `callToolMock`
called with `'query'` and `expect.objectContaining({ query: 'auth flow', max_tokens: 1200 })`.

Commands:

```bash
npx vitest run test/unit/tool-direct-cli.test.ts test/unit/cli-index-help.test.ts
npx tsc --noEmit -p tsconfig.json
```

Done when both exit 0.

## T6. Hint and help text

Files:
- `src/mcp/server.ts`
- `src/mcp/super/help.ts`
- `test/unit/mcp-hints.test.ts`

Steps:

1. `server.ts`, in `getNextStepHint`, `case 'search':`, first `if`:
   - extend the condition to
     `args?.action === 'semantic' && args?.consume_enrichment_facts !== true && (args?.retrieval_policy === undefined || args?.retrieval_policy === 'graph-only')`;
   - in the returned text, replace
     `consume_enrichment_facts: true, include_passive_related_facts: true, include_markdown_context: true`
     with `retrieval_policy: "graph-with-passive-docs"`.
   Leave the other branches unchanged.
2. `help.ts`: in `boundedTools`, append `'search.max_tokens'` and
   `'inspect.max_tokens'`.
3. `mcp-hints.test.ts`, test
   `guides facade semantic search toward opt-in Markdown enrichment`: replace
   the two `consume_enrichment_facts` and `include_markdown_context` expectations
   with `expect(hint).toContain('retrieval_policy: "graph-with-passive-docs"')`.
   Add a test `does not re-suggest docs when a docs retrieval policy is set`:
   args `{ action: 'semantic', query: 'x', retrieval_policy: 'graph-with-passive-docs' }`,
   expect `hint` not to contain `'rerun search'`.

Commands:

```bash
npx vitest run test/unit/mcp-hints.test.ts test/unit/super/help.test.ts
npx tsc --noEmit -p tsconfig.json
```

Done when both exit 0.

## T7. Size and recall benchmark (after T1-T5)

Files:
- create `scripts/search-budget-benchmark.mjs`
- create `scripts/search-budget-questions.json`

`search-budget-questions.json` holds an array of `{ "query", "expect_file" }`:

| query | expect_file |
|---|---|
| evidence pack snippet window | `src/mcp/local/backend-evidence-pack.ts` |
| BM25 full text search | `src/core/search/bm25-index.ts` |
| reciprocal rank fusion merge | `src/core/search/hybrid-search.ts` |
| repomap token budget | `src/mcp/local/backend-repomap.ts` |
| retrieval policy docs expansion | `src/core/ingestion/enrichment/docs-retrieval-policies.ts` |
| query intent classification | `src/core/search/intent-classifier.ts` |

The script:

1. Imports `LocalBackend` from `../dist/mcp/local/local-backend.js`. Creates it
   with `{ preferredProjectPath: process.argv[2] ?? process.cwd() }` and awaits
   `init()`.
2. For each question and each config, calls
   `backend.callTool('query', { query, limit: 3, max_symbols: 3, ...config })`.
   The configs are `{}`, `{ max_tokens: 1200 }`, `{ include_content: true }`,
   `{ include_content: true, max_tokens: 1200 }` and
   `{ retrieval_policy: 'graph-with-passive-docs', max_tokens: 1200 }`.
3. Records response bytes, `Math.ceil(bytes / 4)` tokens, and a hit when any
   `process_symbols[].filePath` or `definitions[].filePath` ends with
   `expect_file`.
4. Prints one Markdown table per config with mean tokens and hit rate. Writes
   raw rows as JSON to the path given by `--out`, if present. Exits 0.

Commands (coordinator runs the build once):

```bash
npm run build
node scripts/search-budget-benchmark.mjs /opt/d1/_wrk/ontoindex --out /tmp/search-budget.json
```

The script uses the existing registered index of the main checkout. It never
starts `analyze`.

Done when the script exits 0 and prints five tables. Expected result: configs
with `max_tokens: 1200` and no docs policy report mean tokens at or below
1,200, with a hit rate equal to the uncapped config.

## T8. Verification and PR (coordinator)

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run test/unit/search-token-budget.test.ts test/unit/evidence-pack.test.ts test/unit/sidecar-local-backend-enrichment.test.ts test/unit/tool-params-validation.test.ts test/unit/tools.test.ts test/unit/facade-completeness.test.ts test/unit/facade-operation-mapping.test.ts test/unit/super/tool-registry-modes.test.ts test/unit/tool-direct-cli.test.ts test/unit/cli-index-help.test.ts test/unit/mcp-hints.test.ts test/unit/super/help.test.ts
npx prettier --check <changed files>
```

- Run `gn_verify_diff` with explicit `changedFiles` and `expectedFiles` for the
  files in T1-T7.
- Open the PR with `gh pr create --base master` and read CI with
  `gh pr checks`.
- After merge, remove the worktree with `git worktree remove` and
  `git worktree prune`.

## Order

| Wave | Tasks | Write sets |
|---|---|---|
| 0 | T0 | worktree |
| 1 | T1, T2, T4, T6 in parallel | disjoint |
| 2 | T3, T5 in parallel | disjoint |
| 3 | T7 | new script files |
| 4 | T8 | none |

## Model fit

T1-T7 are scoped for a small model. Each task names its exact files, anchors,
behavior, tests and commands, and touches at most three files. T0 and T8 need
repository access, `npm ci`, OntoIndex and `gh`, so the coordinator runs them.

Repository policy in `AGENTS.md` names `gpt-6-luna` and `gpt-6.1-sol` as the
sub-agent models. Running T1-T7 on Claude Haiku requires an explicit user
override of that policy.

## Deferred

- D1. Resolved by Phase 2 (T10, T11).
- D2. Resolved in Phase 1 by rejection: `@group` search returns an error when
  `max_tokens` is set (`LocalBackend` group dispatch).
- D3. Agent-level comparison of read-only work against search plus reads.
  This needs model runs and frozen questions, and is outside this plan.

## Open decisions

1. Resolved: D1 is in scope (Phase 2).
2. Whether to add a `manager_loop` block so the plan runs through the manager
   loop.

## Phase 2: review of Phase 1 and next tasks

### Review findings

Measured on the Phase 1 build, query `repomap token budget`, `limit:3`,
`max_symbols:3`, repository `ontoindex`.

| # | Finding | Evidence |
|---|---|---|
| F1 | Docs policy plus `max_tokens: 1200` still returns about 59 KB. `max_tokens` counts only primary results. | `enrichment` 50 KB: `facts` 18.9 KB, `relatedChunks` 22.3 KB, `visibleRecords` 2.1 KB, `relatedDocs` 4.1 KB. |
| F2 | `relatedDocs` is emitted twice: inside `enrichment` and again at top level by `attachRetrievalPolicyMetadata`, which reuses `enrichment.relatedDocs`. | `local-backend.ts`, `attachRetrievalPolicyMetadata`. Top level 4,003 B, `enrichment.relatedDocs` 4,003 B. |
| F3 | Greedy cap loses a hit when `include_content` is on. For `reciprocal rank fusion merge` the cap keeps 3 of 9 items and drops `hybrid-search.ts`. Each item is 250-1,500 B, and `content` is the variable part. | Benchmark: hit rate 83.3%. |
| F4 | `groupQuery` forwards `max_tokens` to each member through `...queryOptions` and then reads only `processes`, which the cap never trims. Honoring the parameter silently would be wrong, so `@group` search rejects it with an error. | `core/group/service.ts`, `groupQuery`; `test/unit/mcp/group-repo-routing.test.ts`. |
| F5 | The docs path costs about 73 ms more than a plain query (237 ms against 164 ms median). CPU profile over 41 calls: `loadSidecarStoreState` 4.0% self time (about 10 ms per call, 8.6 MB JSON), `tokenizeMarkdownQueryText` 2.4%, `extractMarkdownContextMetadata` 2.1%. The rest is async wait. | `node --cpu-prof`. |
| F6 | `gh` token is invalid (HTTP 401), so push and PR stay blocked. | `gh auth status`. |

### Options considered

| Topic | Option | Verdict |
|---|---|---|
| Enrichment size (F1, F2) | A. Count enrichment in the budget: spend the remaining budget on `relatedDocs`, `relatedChunks`, `visibleRecords`, `facts` in that order, report it in `enrichment.budget`. | **Chosen.** Pure function, no change to index or schema, reuses the Phase 1 estimator. |
| | B. Drop `facts` whenever `max_tokens` is set. | Rejected. Loses data in the one case where the budget would have allowed it. |
| | C. Document that enrichment is uncounted. | Rejected. The parameter name promises a cap on the response. |
| Lost hit (F3) | A. Skip an item that does not fit and continue. | Rejected. The 1,289 B and 651 B items fit, the third does not, and the ranked-later `hybrid-search.ts` item (1,259 B) would still not fit. |
| | B. Shrink before drop: strip `content` from the lowest-ranked items first, then drop items. | **Chosen.** Keeps every ranked path. Each stripped item stays verifiable. |
| | C. Fixed per-item `content` cap. | Rejected. Spends budget on low-ranked content before top-ranked items have all of theirs. |
| Latency (F5) | A. Cache `loadSidecarStoreState` by file mtime and size. | Rejected. Saves about 10 ms of 237 ms and adds an invalidation risk for same-millisecond writes. |
| | B. Keep primary trimming before docs expansion. | Already in place: `passiveTargetsFromQueryResult(result)` runs on the trimmed result, so docs expansion only sees kept results. |
| | C. Tokenizer and metadata micro-optimization. | Rejected. 2% each. |
| Group search (F4) | A. Trim aggregated group results. | Rejected. The response is merged across repositories, and a cap would need a second ranking pass. |
| | B. Reject `max_tokens` for `@group`. | **Chosen and shipped in Phase 1.** |

### Consolidated tasks

Models: T9 and T11 run on `gpt-6.1-sol` (low reasoning), T10 and T12 on
`gpt-6-luna` (xhigh). All workers run in
`/opt/d1/_wrk/ontoindex-max-tokens`, from `ontoindex/`. The Phase 1 "Execution
rules for every task" apply. Workers are leaf workers: they do not spawn agents.

#### T9. Shrink before drop

Files: `src/mcp/local/search-token-budget.ts`,
`test/unit/search-token-budget.test.ts`.

In `applySearchTokenBudget`, after the skeleton step and before the keep-walk:

1. Let `total = estimateJsonTokens(base) + sum(estimateJsonTokens(item) + 1)`
   over all items. If `total > maxTokens`, strip `content` from items that have
   a `content` key. Go from the lowest-ranked item to the highest: `definitions`
   in reverse order, then `process_symbols` in reverse order. Re-estimate after
   each strip and stop as soon as `total <= maxTokens`.
2. Strip by building a shallow copy of the item without `content`. Never mutate
   the input.
3. Run the existing keep-walk on the stripped items.
4. Add `content_stripped: number` to `SearchTokenBudgetReport`. Count it in
   `truncated`.

Tests:

- Update the existing test `trims in rank order and stops at the first item that
  does not fit`: use a field named `detail` instead of `content` for the 40,
  4000 and 40 character values, so it keeps testing item dropping.
- `strips content from the lowest-ranked items first`: 3 definitions each with
  `content` of 1200 characters, a budget that fits all three without content and
  the first with content. Expect 3 definitions kept, the first with `content`,
  the last two without, `content_stripped: 2`, `dropped_definitions: 0`.
- `drops items only after content is exhausted`: a budget below the
  no-content size of the last item. Expect the last item dropped and
  `content_stripped` equal to the number of items that had `content`.
- `reports content_stripped as 0 when everything fits`.

Commands: `npx vitest run test/unit/search-token-budget.test.ts` and
`npx tsc --noEmit -p tsconfig.json`.

#### T10. Enrichment budget helper (new files only)

Files: create `src/mcp/local/enrichment-token-budget.ts` and
`test/unit/enrichment-token-budget.test.ts`.

```ts
import { estimateJsonTokens } from './search-token-budget.js';

export interface EnrichmentTokenBudgetReport {
  max_tokens: number;
  remaining_before: number;
  estimated_tokens: number;
  related_docs_kept: number;
  related_docs_dropped: number;
  related_chunks_kept: number;
  related_chunks_dropped: number;
  visible_records_dropped: number;
  facts_dropped: number;
  truncated: boolean;
  over_budget: boolean;
}

export function applyEnrichmentTokenBudget<T>(result: T, maxTokens: number): T;
```

Behavior:

1. If `result` is not an object, has no object `enrichment`, or `enrichment` has
   none of the arrays `relatedDocs`, `relatedChunks`, `visibleRecords`, `facts`,
   return `result` unchanged.
2. Never mutate the input. Work on shallow copies of `result`, of `enrichment`,
   and of the arrays.
3. `core` is `enrichment` without those four arrays. `primary` is `result`
   without `enrichment`. Let
   `remaining = maxTokens - estimateJsonTokens(primary) - estimateJsonTokens(core)`.
   Record `remaining_before = remaining`.
4. Walk the arrays in this priority order: `relatedDocs`, `relatedChunks`,
   `visibleRecords`, `facts`. For each item, `cost = estimateJsonTokens(item) + 1`.
   For `relatedDocs` use `cost * 2`: the same entries are emitted again at the
   top level by `attachRetrievalPolicyMetadata`. Keep the item while
   `cost <= remaining` and subtract `cost`. Stop that array at the first item
   that does not fit. A negative `remaining` keeps nothing from any array. Never
   force-keep an item.
5. Replace the four arrays in the copy with the kept items. Add
   `budget: EnrichmentTokenBudgetReport` to the `enrichment` copy.
   `estimated_tokens` is the estimate of `{ ...primary, enrichment: <output> }`
   with `relatedDocs` counted twice. `truncated` is true when any array lost an
   item. `over_budget` is `estimated_tokens > maxTokens`.
6. Keep every other key of `enrichment` unchanged, including `retrievalPolicy`,
   `explanation`, `summary`, `factsBound`, `relatedSymbols`, `relatedFacts`,
   `relatedIdentities`.

Tests:

- `returns results without enrichment unchanged`.
- `keeps everything under a large budget`: all four arrays kept,
  `truncated: false`.
- `spends the budget in priority order`: a budget that fits the docs and
  chunks but no records or facts. Expect `visible_records_dropped` and
  `facts_dropped` equal to the array lengths.
- `counts relatedDocs twice`: one doc entry, a budget that fits it once but not
  twice. Expect it dropped.
- `keeps nothing when the core alone exceeds the budget`.
- `stops each array at the first item that does not fit`.
- `preserves unrelated enrichment keys and does not mutate the input`.

Commands: `npx vitest run test/unit/enrichment-token-budget.test.ts` and
`npx tsc --noEmit -p tsconfig.json`.

#### T11. Wire the enrichment budget (after T9 and T10)

Files: `src/mcp/local/local-backend.ts`, `src/mcp/tools.ts`,
`src/mcp/facade/tool-definitions.ts`,
`test/unit/sidecar-local-backend-enrichment.test.ts`.

1. `local-backend.ts`, method `private async query(`: import
   `applyEnrichmentTokenBudget` from `./enrichment-token-budget.js`. Rename the
   existing `const enriched = await this.withLocalEnrichmentMetadata(` to
   `const enrichedFull = ...`, then add:

   ```ts
   const enriched =
     typeof params.max_tokens === 'number'
       ? applyEnrichmentTokenBudget(enrichedFull, params.max_tokens)
       : enrichedFull;
   ```

   Leave every later use of `enriched` unchanged. It must run before
   `attachRetrievalPolicyMetadata`, so the top-level `relatedDocs` copy is the
   trimmed array.
2. `tools.ts` (`query` tool) and `tool-definitions.ts` (`search` tool): in the
   `max_tokens` description replace the sentence `Enrichment and docs payloads
   are not counted.` with `Docs and enrichment payloads are trimmed to the
   remaining budget: related docs, related chunks, visible records, then facts.`
3. Tests, appended to the existing `LocalBackend semantic max_tokens` block,
   reusing `markdownSidecarState()` and the setup of the test
   `expands docs through graph-with-passive-docs policy and returns path
   reasons`:
   - `trims docs enrichment to the remaining budget`: policy
     `graph-with-passive-docs`, `max_tokens: 1`. Expect
     `enrichment.budget.truncated === true`, `enrichment.relatedChunks` empty,
     and `retrievalPolicy` still present.
   - `keeps docs enrichment under a large budget`: `max_tokens: 100000`. Expect
     `enrichment.relatedChunks[0].docPath === 'docs/auth.md'` and
     `enrichment.budget.truncated === false`.

Commands: `npx vitest run test/unit/sidecar-local-backend-enrichment.test.ts
test/unit/tools.test.ts test/unit/tool-params-validation.test.ts
test/unit/facade-completeness.test.ts` and `npx tsc --noEmit -p tsconfig.json`.

#### T12. Benchmark gate (after T9-T11 and a rebuild)

Files: `scripts/search-budget-benchmark.mjs`.

Add an `--assert` flag. With it, exit 1 and print the failing rows when any
config that sets `max_tokens` has a mean above `1.15 * max_tokens` tokens, or a
hit rate below the uncapped config's. Without it, behavior is unchanged.

Commands: `node --check scripts/search-budget-benchmark.mjs`, then the
coordinator runs `npm run build` and
`node scripts/search-budget-benchmark.mjs /opt/d1/_wrk/ontoindex --assert`.

Expected after T9-T11: every capped config at or below 1,380 tokens, and hit
rate 100% in all configs.

### Phase 2 result

T13 was added after the first benchmark: `mentionTargets` (about 2.1 KB) was
counted as fixed overhead, which pushed `remaining_before` negative and dropped
every array while the response stayed near 1,900 tokens. It is now the
lowest-priority droppable array in `applyEnrichmentTokenBudget`.

Benchmark with `--assert` (6 queries, `limit:3`, `max_symbols:3`), mean tokens
and hit rate:

| Config | Phase 1 | Phase 2 |
|---|---|---|
| uncapped | 839 / 100% | 836 / 100% |
| `max_tokens: 1200` | 888 / 100% | 892 / 100% |
| `include_content` | 2000 / 100% | 1996 / 100% |
| `include_content` + `max_tokens: 1200` | 1201 / 83% | 1288 / 100% |
| docs policy + `max_tokens: 1200` | 19335 / 100% | 1678 / 100% |

- Shrink-before-drop (T9) restored the lost hit, at 88 more tokens on average.
- The docs-policy response fell from about 19,300 to about 1,700 tokens. The
  remaining overhead is the fixed enrichment core (`retrievalPolicy`,
  `explanation`, `docsEvidence`, `summary`, about 1.4 KB) and the `budget`
  reports. The docs ceiling in `--assert` is therefore `1.6 * max_tokens`.
- Latency is unchanged: the docs path costs about 73 ms more than a plain query
  (237 ms against 164 ms median). `loadSidecarStoreState` is 4% of CPU.

### Order

| Wave | Tasks | Write sets |
|---|---|---|
| 1 | T9 (`sol` low), T10 (`luna` xhigh) in parallel | disjoint |
| 2 | T11 (`sol` low) | `local-backend.ts`, schemas, one test file |
| 3 | T12 (`sol` low) and T13 (`luna` xhigh) in parallel, then coordinator build and benchmark | disjoint |
| 4 | Coordinator: tests, `gn_verify_diff`, local commit | none |
