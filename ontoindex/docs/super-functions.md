# OntoIndex Super-Functions

Super-functions (`gn_*` prefix) are higher-level MCP tools that wrap multiple primitives, env-var configuration, and lifecycle orchestration into single user-level intents. They are designed for 3rd-party coding agents (Claude Code, Cursor, Aider, Cline) that should not need to know about env vars, query choreography, or internal API shape.

Existing primitives (`ontoindex_query`, `ontoindex_context`, `ontoindex_impact`, etc.) remain available as an escape hatch for power users who need precise control.

**All Phase 1 super-functions are read-only.** No DB writes. No persistent side effects. Env-var changes made during a call are reverted in a `finally` block before the call returns.

---

## Phase 1 — Discovery wrappers

### `gn_explore` — concept-level discovery

**Intent:** "Help me understand this concept in the codebase."

**When to use:**
- First exploration of an unfamiliar area ("how does auth work here?")
- When you need multiple related entry points from a single natural-language query
- When you want intent classification, file skeletons, citation paths, and cluster context in one shot

**Replaces:** ad-hoc `ontoindex_query` + manual top-N `ontoindex_context` calls + `getFileSkeleton` per symbol + cluster lookup + co-change analysis (4-8 separate calls).

**Auto-enables for the call duration:**
- `ONTOINDEX_INTENT_ENSEMBLE=1` — activates the graph leg of the hybrid search pipeline
- `ONTOINDEX_CITATIONS=1` — adds BFS citation paths to the result (depth 4)

Both env vars are reverted in `finally` even if the call throws.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `string` | required | Free-text concept or question |
| `depth` | `'shallow' \| 'balanced' \| 'deep'` | `'balanced'` | Controls top-N: shallow=3, balanced=5, deep=10 |
| `qualityMode` | `'fast' \| 'balanced' \| 'thorough'` | `'balanced'` | Search quality vs latency trade-off |
| `includeSkeletons` | `boolean` | `true` | Whether to extract file skeletons for top symbols |
| `includeCitations` | `boolean` | `true` | Whether to compute BFS citation paths |

**Example invocation (TypeScript):**

```typescript
import { gnExplore } from 'ontoindex/src/mcp/super/explore.js';

const report = await gnExplore('OntoIndex', {
  query: 'how does intent classification work?',
  depth: 'balanced',
  includeCitations: true,
});
```

**Example return shape:**

```json
{
  "version": 1,
  "query": {
    "original": "how does intent classification work?",
    "classified": { "intent": "nl-conceptual", "confidence": 0.87 }
  },
  "topProcesses": [
    {
      "name": "intent-classification-flow",
      "description": "Classifies free-text queries into intent buckets for routing",
      "keySymbols": ["classifyIntent", "applyEnsemble", "mergeWithRRF"],
      "relevanceScore": 0.94
    }
  ],
  "topSymbols": [
    {
      "nodeId": "Function:classifyIntent",
      "name": "classifyIntent",
      "filePath": "ontoindex/src/core/search/intent-classifier.ts",
      "cluster": "search-pipeline",
      "skeleton": "export function classifyIntent(query: string): IntentClassification { ... }",
      "citations": [
        { "from": "Function:classifyIntent", "to": "Function:detectCallsOf", "type": "CALLS" },
        { "from": "Function:classifyIntent", "to": "Function:detectCrossFileImpact", "type": "CALLS" }
      ],
      "coChangedFiles": [
        "ontoindex/src/core/search/per-intent-ensemble.ts",
        "ontoindex/src/mcp/local/backend-search.ts"
      ]
    },
    {
      "nodeId": "Function:applyEnsemble",
      "name": "applyEnsemble",
      "filePath": "ontoindex/src/core/search/per-intent-ensemble.ts",
      "cluster": "search-pipeline",
      "skeleton": "export async function applyEnsemble(results, intent): Promise<RankedResult[]> { ... }",
      "citations": [],
      "coChangedFiles": [
        "ontoindex/src/core/search/intent-classifier.ts"
      ]
    }
  ],
  "clusters": [
    {
      "name": "search-pipeline",
      "role": "core query processing and ranking",
      "fileCount": 12,
      "keyFiles": [
        "ontoindex/src/core/search/intent-classifier.ts",
        "ontoindex/src/core/search/per-intent-ensemble.ts",
        "ontoindex/src/mcp/local/backend-search.ts"
      ]
    }
  ],
  "suggestedEntryPoints": [
    {
      "type": "process",
      "nodeId": "intent-classification-flow",
      "rationale": "Top-ranked process: Classifies free-text queries into intent buckets for routing"
    },
    {
      "type": "symbol",
      "nodeId": "Function:classifyIntent",
      "rationale": "Top-ranked symbol: classifyIntent"
    },
    {
      "type": "file",
      "nodeId": "ontoindex/src/core/search/intent-classifier.ts",
      "rationale": "File containing top-ranked symbol: classifyIntent"
    }
  ],
  "warnings": []
}
```

**Composes (internal primitives):**
- `classifyIntent` from `intent-classifier.ts` — determines query intent bucket
- `query` from `backend-search.ts` — runs the hybrid search (with ensemble env var active)
- `getFileSkeleton` from `skeleton.ts` — extracts code skeletons for top symbols
- `computeGraphPath` from `graph-path.ts` — BFS citation paths (depth 4) per symbol
- `executeParameterized` — cluster lookup via Cypher (`MEMBER_OF` → `Community` nodes)
- `executeParameterized` — co-change query via Cypher (`CO_CHANGED_WITH` edges from file)

---

### `gn_explain_module` — file/module overview

**Intent:** "What does this file or module do?"

**When to use:**
- When you land in an unfamiliar file and need a quick orientation
- Before editing a file: understand its public API, cluster membership, and co-change partners
- When reviewing a PR and need to quickly summarize what a changed file is responsible for

**Replaces:** skeleton lookup + cluster query + co-change query + public API enumeration + git-log for last touch (5-7 separate calls).

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filePath` | `string` | required | Path to the file (relative to repo root or absolute) |
| `includeSkeleton` | `boolean` | `true` | Include a text skeleton of the file's structure |
| `includePublicAPI` | `boolean` | `true` | Enumerate exported symbols with signatures and doc comments |
| `includeCoChange` | `boolean` | `true` | Include top-10 co-changed files (by commit count) |
| `recentTouchDays` | `number` | `30` | Lookback window used when computing "recently touched" |

**Example invocation (TypeScript):**

```typescript
import { gnExplainModule } from 'ontoindex/src/mcp/super/explain-module.js';

const report = await gnExplainModule('OntoIndex', {
  filePath: 'ontoindex/src/core/search/per-intent-ensemble.ts',
});
```

**Example return shape:**

```json
{
  "version": 1,
  "filePath": "ontoindex/src/core/search/per-intent-ensemble.ts",
  "fileSkeleton": "// per-intent-ensemble.ts\nexport async function applyEnsemble(...) { ... }\nexport function mergeWithRRF(...) { ... }",
  "publicAPI": [
    {
      "name": "applyEnsemble",
      "kind": "Function",
      "signature": "async function applyEnsemble(results: RawResults[], intent: Intent): Promise<RankedResult[]>",
      "documentation": "Applies per-intent ensemble weighting to merge graph, vector, and text search results."
    },
    {
      "name": "mergeWithRRF",
      "kind": "Function",
      "signature": "function mergeWithRRF(lists: RankedResult[][], k?: number): RankedResult[]",
      "documentation": "Reciprocal Rank Fusion across multiple ranked lists."
    }
  ],
  "cluster": {
    "name": "search-pipeline",
    "role": "core query processing and ranking",
    "fileCount": 12
  },
  "coChangedFiles": [
    { "path": "ontoindex/src/core/search/intent-classifier.ts", "coChangeCount": 18 },
    { "path": "ontoindex/src/mcp/local/backend-search.ts", "coChangeCount": 14 },
    { "path": "ontoindex/src/core/search/graph-path.ts", "coChangeCount": 9 }
  ],
  "recentlyTouched": { "lastCommitDate": "2026-04-29T11:23:41+00:00", "daysAgo": 2 },
  "fileStats": { "lineCount": 214, "symbolCount": 8, "importCount": 6 },
  "warnings": []
}
```

**Composes (internal primitives):**
- `getFileSkeleton` from `skeleton.ts` — text skeleton at depth 2
- `executeParameterized` — file node lookup (`MATCH (f:File {filePath: $path})`)
- `executeParameterized` — exported symbols via `CONTAINS` edges where `exported = true`
- `executeParameterized` — cluster via `IN_COMMUNITY` edge to `Community` node
- `executeParameterized` — co-change top-10 via `CO_CHANGED_WITH` edges
- `execFileSync('git log')` — last-commit date fallback when `lastModified` not in graph

**When the file is not indexed:**

If the file is not found in the graph, `gn_explain_module` returns immediately with a warning rather than throwing:

```json
{
  "version": 1,
  "filePath": "ontoindex/src/some/new-file.ts",
  "publicAPI": [],
  "coChangedFiles": [],
  "recentlyTouched": { "lastCommitDate": "", "daysAgo": -1 },
  "fileStats": { "lineCount": 0, "symbolCount": 0, "importCount": 0 },
  "warnings": ["file not in index — run npx ontoindex analyze"]
}
```

---

### `gn_find_related` — symbol-level neighborhood

**Intent:** "What's near this symbol? What calls it, what does it call, what changes with it?"

**When to use:**
- Before editing a function: understand its callers and dependencies
- When tracing why a change in one file ripples to another
- When trying to understand the cluster of code that co-evolves with a symbol
- Accepts either a canonical `nodeId` (e.g. `"Function:classifyIntent"`) or a fuzzy name (e.g. `"classifyIntent"`)

**Replaces:** `ontoindex_context` + caller query + callee query + co-change query + cluster sibling lookup (4-6 separate calls).

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | `string` | required | Canonical `nodeId` (e.g. `"Function:foo"`) or fuzzy name |
| `includeCallers` | `boolean` | `true` | Include upstream callers and references |
| `includeCallees` | `boolean` | `true` | Include downstream callees and imports |
| `includeCoChanged` | `boolean` | `true` | Include files that frequently change together with this symbol's file |
| `includeClusterSiblings` | `boolean` | `true` | Include other symbols in the same Leiden community |
| `includeCrossRepo` | `boolean` | `false` | Include cross-repo references (requires group config; not yet wired in Phase 1) |
| `maxItemsPerCategory` | `number` | `10` | Maximum results returned per category |

**Example invocation (TypeScript):**

```typescript
import { gnFindRelated } from 'ontoindex/src/mcp/super/find-related.js';

// Using a fuzzy name — gn_find_related resolves to canonical nodeId automatically.
const report = await gnFindRelated('OntoIndex', {
  symbol: 'mergeWithRRF',
  maxItemsPerCategory: 5,
});
```

**Example return shape:**

```json
{
  "version": 1,
  "resolvedSymbol": {
    "nodeId": "Function:mergeWithRRF",
    "name": "mergeWithRRF",
    "filePath": "ontoindex/src/core/search/per-intent-ensemble.ts",
    "kind": "Function"
  },
  "callers": [
    {
      "nodeId": "Function:applyEnsemble",
      "name": "applyEnsemble",
      "filePath": "ontoindex/src/core/search/per-intent-ensemble.ts",
      "relationshipKind": "CALLS"
    },
    {
      "nodeId": "Function:backendQuery",
      "name": "backendQuery",
      "filePath": "ontoindex/src/mcp/local/backend-search.ts",
      "relationshipKind": "CALLS"
    }
  ],
  "callees": [
    {
      "nodeId": "Function:scoreByRank",
      "name": "scoreByRank",
      "filePath": "ontoindex/src/core/search/per-intent-ensemble.ts",
      "relationshipKind": "CALLS"
    }
  ],
  "coChangedFiles": [
    {
      "filePath": "ontoindex/src/core/search/intent-classifier.ts",
      "coChangeCount": 18,
      "lastChangedTogether": "2026-04-29"
    },
    {
      "filePath": "ontoindex/src/mcp/local/backend-search.ts",
      "coChangeCount": 14,
      "lastChangedTogether": "2026-04-27"
    }
  ],
  "clusterSiblings": [
    {
      "nodeId": "Function:applyEnsemble",
      "name": "applyEnsemble",
      "filePath": "ontoindex/src/core/search/per-intent-ensemble.ts",
      "reason": "same Leiden community: search-pipeline"
    },
    {
      "nodeId": "Function:classifyIntent",
      "name": "classifyIntent",
      "filePath": "ontoindex/src/core/search/intent-classifier.ts",
      "reason": "same Leiden community: search-pipeline"
    }
  ],
  "warnings": []
}
```

**Symbol resolution:** If the input is a fuzzy name, `gn_find_related` runs a Cypher lookup and picks the node with the most incoming `CALLS` edges (most-used definition wins). If multiple definitions exist and the result is ambiguous, the warnings field notes this and you can switch to a canonical `nodeId`.

**Composes (internal primitives):**
- `executeParameterized` — canonical nodeId lookup or fuzzy name → nodeId resolution
- `executeParameterized` — upstream callers via `CodeRelation {type: 'CALLS' | 'REFERENCES'}`
- `executeParameterized` — downstream callees via `CodeRelation {type: 'CALLS' | 'REFERENCES' | 'IMPORTS'}`
- `executeParameterized` — co-change files via `CodeRelation {type: 'CO_CHANGED_WITH'}` from symbol's file
- `executeParameterized` — cluster siblings via `MEMBER_OF` → `Community` ← `MEMBER_OF` pattern

---

---

## Phase 2 — Safety wrappers

### `gn_safe_edit_check` — pre-edit risk synthesis

**Intent:** "Is it safe to edit this symbol?"

**When to use:**
- Before applying any edit to a function, class, or method
- Replaces the discipline rule "MUST run ontoindex_impact" — bundles upstream + downstream + test coverage + co-change + LSP refs into a single SAFE/CAUTION/DANGEROUS/BLOCKED verdict
- When you need a concrete recommended tool (`rename`, `update_symbol_body`, `extract_function`, `move_symbol`, `manual`) for your intended edit

**Replaces:** `ontoindex_impact` upstream + `ontoindex_impact` downstream + manual test discovery + manual co-change query + manual LSP enrichment + risk synthesis (5-8 calls).

**Auto-enables:** `ONTOINDEX_LSP_REFERENCES=1` for the call duration (reverts on completion via `finally` block).

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | `string` | required | Canonical `nodeId` (e.g. `"Function:mergeWithRRF"`) or fuzzy name |
| `intent` | `'rename' \| 'modify-body' \| 'delete' \| 'general'` | `'general'` | Intended edit type — guides `recommendedTool` inference |
| `force` | `boolean` | `false` | Bypass BLOCKED verdict guard (use when you've acknowledged the risk) |

**Example invocation (TypeScript):**

```typescript
import { gnSafeEditCheck } from 'ontoindex/src/mcp/super/safe-edit-check.js';

const report = await gnSafeEditCheck('OntoIndex', {
  symbol: 'mergeWithRRF',
  intent: 'modify-body',
});
```

**Example return shape:**

```json
{
  "version": 1,
  "symbol": {
    "nodeId": "Function:mergeWithRRF",
    "name": "mergeWithRRF",
    "filePath": "ontoindex/src/core/search/per-intent-ensemble.ts",
    "kind": "Function"
  },
  "verdict": "CAUTION",
  "reasoning": "2 upstream callers; no test coverage detected",
  "blastRadius": {
    "upstreamCount": 2,
    "upstreamFiles": [
      "ontoindex/src/core/search/per-intent-ensemble.ts",
      "ontoindex/src/mcp/local/backend-search.ts"
    ],
    "downstreamCount": 1,
    "transitiveImpact": { "processCount": 1, "clusterCount": 1 }
  },
  "testCoverage": {
    "coveringTests": [],
    "likelihoodOfCoverage": "NONE"
  },
  "coChangeNetwork": {
    "siblings": [
      "ontoindex/src/core/search/intent-classifier.ts",
      "ontoindex/src/mcp/local/backend-search.ts"
    ],
    "recentTouchDays": 2
  },
  "lspRefs": [
    { "filePath": "ontoindex/src/core/search/per-intent-ensemble.ts", "line": 47, "column": 12 },
    { "filePath": "ontoindex/src/mcp/local/backend-search.ts", "line": 88, "column": 18 }
  ],
  "recommendedTool": "update_symbol_body",
  "preChecks": [
    { "check": "symbol_in_index", "passed": true, "detail": "Resolved to Function node at ontoindex/src/core/search/per-intent-ensemble.ts." },
    { "check": "test_coverage", "passed": false, "detail": "Coverage likelihood: NONE. Tests: 0." },
    { "check": "blast_radius", "passed": true, "detail": "2 upstream callers, 1 downstream callees." }
  ],
  "warnings": [],
  "suggestedNext": [
    {
      "tool": "gn_find_related",
      "params": { "symbol": "Function:mergeWithRRF", "includeCallers": true },
      "reason": "Inspect callers before editing."
    }
  ]
}
```

**Verdict matrix (deterministic):**
- **BLOCKED:** `upstreamCount > 100` AND `isExported` AND `force: false` — high blast radius public API guard
- **DANGEROUS:** `transitiveImpact.processCount > 5` OR `upstreamCount > 100` OR symbol is exported public API
- **CAUTION:** `upstreamCount` between 10–100 OR `likelihoodOfCoverage === 'NONE'` OR `coChangeNetwork.recentTouchDays > 30`
- **SAFE:** else (isolated, well-tested, recently active)

**Composes (internal primitives):**
- `executeParameterized` — canonical nodeId lookup and fuzzy resolution (same pattern as `gn_find_related`)
- `executeParameterized` — upstream callers via `CodeRelation {type: 'CALLS' | 'REFERENCES'}` (8 parallel DB calls via `Promise.all`)
- `executeParameterized` — downstream callees, process count, cluster count, co-change siblings, co-change recency, exported flag
- `findTestFiles` from `_helpers/test-coverage.ts` — shared test-file discovery helper
- `lspBridge.getClient(ext).findReferences()` — best-effort LSP refs (never throws; adds warning on failure)
- Deterministic verdict synthesis matrix (no randomness; `recentTouchDays` from stored graph data)

---

### `gn_can_delete` — dead-code safety verdict

**Intent:** "Can I delete this symbol?"

**When to use:**
- Before removing a function, class, or method from the codebase
- When `vulture`, `eslint no-unused`, or manual inspection marks a symbol as potentially dead
- As a final confirmation step after `gn_safe_edit_check` returns `SAFE` with `intent: 'delete'`

**Replaces:** manual caller query + test-file import check + co-change recency check + cross-repo reference scan (3-5 calls).

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | `string` | required | Canonical `nodeId` or fuzzy name |
| `includeCrossRepo` | `boolean` | `false` | Include cross-repo reference check (currently returns `[]` + warning — not yet wired) |

**Example invocation (TypeScript):**

```typescript
import { gnCanDelete } from 'ontoindex/src/mcp/super/can-delete.js';

const report = await gnCanDelete('OntoIndex', {
  symbol: 'legacyNormalizeQuery',
});
```

**Example return shape:**

```json
{
  "version": 1,
  "symbol": {
    "nodeId": "Function:legacyNormalizeQuery",
    "name": "legacyNormalizeQuery",
    "filePath": "ontoindex/src/core/search/query-normalizer.ts",
    "kind": "Function"
  },
  "verdict": "DELETE-SAFE",
  "reasoning": "No callers, no test coverage, and no recent co-change activity detected.",
  "blockers": [],
  "callers": [],
  "tests": [],
  "coChangeNetwork": {
    "siblings": [
      "ontoindex/src/core/search/intent-classifier.ts"
    ],
    "recentTouchDays": 45
  },
  "warnings": []
}
```

**Verdict matrix:**
- **DELETE-SAFE:** zero callers AND zero test files importing the symbol's file AND no recent co-change activity (`recentTouchDays >= 7` or unknown)
- **CAUTION:** `recentTouchDays < 7` (recently touched = signal that it may be in active use even if not yet indexed)
- **DO-NOT-DELETE:** any caller OR any test file importing the symbol's file OR cross-repo references

**Symbol not in index:** If the symbol cannot be resolved, `gn_can_delete` returns `DELETE-SAFE` with a warning (`"symbol not in index — already gone"`) rather than throwing.

**Composes (internal primitives):**
- `executeParameterized` — canonical nodeId lookup and fuzzy resolution
- `executeParameterized` — upstream callers via `CodeRelation {type: 'CALLS' | 'REFERENCES'}` (limit 100)
- `executeParameterized` — test files via `CodeRelation {type: 'IMPORTS'}` with `*test*` / `*spec*` filename filter
- `executeParameterized` — co-change recency via `CodeRelation {type: 'CO_CHANGED_WITH'}` (uses `r.confidence` and `r.lastDate`)
- Cross-repo: kill-switch pattern from Phase 1 W1c — returns `[]` + warning when `GroupToolPort` is not wired

---

### `gn_pre_commit_audit` — ship-readiness verdict

**Intent:** "Is this commit/PR ready to ship?"

**When to use:**
- Before `git commit` to verify no HIGH-risk symbols were accidentally changed
- When the staged diff includes more files than expected and you want a structured diff-vs-intent check
- Replaces the discipline rule "MUST run ontoindex_detect_changes" — automates the full symbol-impact loop for all changed files

**Replaces:** `git diff` parsing + per-file symbol lookup + per-symbol impact query + `ontoindex_detect_changes` + reviewer inference from `git log` (varies; 5+ calls for a typical 3-file diff).

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `scope` | `'staged' \| 'unstaged' \| 'all' \| 'branch'` | `'staged'` | Which git diff to audit |
| `expectedSymbols` | `string[]` | `undefined` | Symbols you intended to change — any others become `unexpectedSymbols` and trigger REVIEW |

**Scope options:**
- `staged` (default) — `git diff --cached --name-only`
- `unstaged` — `git diff --name-only`
- `all` — `git diff HEAD --name-only`
- `branch` — `git diff main...HEAD --name-only`

**Example invocation (TypeScript):**

```typescript
import { gnPreCommitAudit } from 'ontoindex/src/mcp/super/pre-commit-audit.js';

const report = await gnPreCommitAudit('OntoIndex', {
  scope: 'staged',
  expectedSymbols: ['gnSafeEditCheck', 'computeVerdict'],
});
```

**Example return shape:**

```json
{
  "version": 1,
  "verdict": "READY",
  "reasoning": "All 2 changed file(s) have LOW/MEDIUM risk symbols. No unexpected symbols. Coverage held.",
  "changedFiles": [
    {
      "path": "ontoindex/src/mcp/super/safe-edit-check.ts",
      "changedSymbols": ["gnSafeEditCheck", "computeVerdict", "makeEnvSetter"],
      "perSymbolImpact": { "upstream": 1, "downstream": 4, "risk": "LOW" }
    },
    {
      "path": "ontoindex/src/mcp/super/_helpers/test-coverage.ts",
      "changedSymbols": ["findTestFiles"],
      "perSymbolImpact": { "upstream": 3, "downstream": 2, "risk": "LOW" }
    }
  ],
  "unexpectedSymbols": [],
  "testCoverageDelta": { "coveredBefore": 2, "coveredAfter": 2, "deltaPp": 0 },
  "suggestedReviewers": ["Evgeniy Rasyuk"],
  "preCommitChecklist": [
    { "check": "staged diff non-empty", "passed": true, "detail": "2 file(s) changed" },
    { "check": "no HIGH-risk symbols", "passed": true, "detail": "all symbol risks are LOW or MEDIUM" },
    { "check": "symbols match expected scope", "passed": true, "detail": "all changed symbols are within expected scope" },
    { "check": "test coverage stable", "passed": true, "detail": "coverage held or improved" }
  ],
  "warnings": []
}
```

**Verdict matrix:**
- **DO-NOT-COMMIT:** any changed symbol has `upstream > 50` callers (HIGH risk) OR any unexpected symbol is an exported public API
- **REVIEW:** `unexpectedSymbols` non-empty when `expectedSymbols` was provided OR test coverage drops by >5pp
- **READY:** all changed files have LOW/MEDIUM risk; no unexpected symbols; coverage held

**Composes (internal primitives):**
- `execFileSync('git', diffArgs)` — resolves changed files from the requested scope
- `executeParameterized` — per-file symbol lookup via `CodeRelation {type: 'DEFINES'}`
- `executeParameterized` — per-symbol upstream count via `CodeRelation {type: 'CALLS' | 'REFERENCES'}`
- `executeParameterized` — per-symbol downstream count via `CodeRelation {type: 'CALLS' | 'REFERENCES' | 'IMPORTS'}`
- `executeParameterized` — test-coverage check via `CodeRelation {type: 'IMPORTS'}` with test filename filter
- `execFileSync('git log --format=%aN')` — best-effort suggested reviewer inference (top-3 by recent commit count)

---

## Phase 3 — Refactor + lifecycle

### `gn_safe_refactor` — single dispatcher for 6 atomic refactor tools

**Intent:** "Apply rename/extract/move/modify safely with safety wrappers."

**When to use:** ANY refactor that previously required choosing among 6 atomic tools (`ontoindex_rename`, `ontoindex_update_symbol_body`, `ontoindex_extract_function`, `ontoindex_move_symbol`, etc.).

**Replaces:** manual choice among atomic tools + pre-edit safety check + post-write verification (4-6 calls).

**Safety stack (built-in):**
1. Pre-check via `gn_safe_edit_check` (auto-aborts on BLOCKED/DANGEROUS without `force: true`)
2. Dry-run preview by default (`dryRun: true`); explicit `dryRun: false` to apply
3. Post-write `ontoindex_detect_changes` verification; surfaces unexpected scope as warning + rollback instructions

**Default `dryRun: true` is the FIRST WRITE super-function rule** — never auto-apply without explicit confirmation.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `intent` | `'rename' \| 'modify-body' \| 'extract' \| 'move' \| 'split-function' \| 'convert-to-method'` | required | Refactor operation to perform |
| `symbol` | `string` | required | Canonical `nodeId` (e.g. `"Function:mergeWithRRF"`) or fuzzy name |
| `params.newName` | `string` | — | New name for `rename` or `extract` intent |
| `params.newBody` | `string` | — | Replacement body for `modify-body` intent |
| `params.sourceLineRange` | `[number, number]` | — | Source lines for `extract` intent |
| `params.targetFile` | `string` | — | Destination file for `extract` or `move` intent |
| `dryRun` | `boolean` | `true` | Preview-only when `true`; apply when `false` |
| `force` | `boolean` | `false` | Bypass BLOCKED/DANGEROUS pre-check verdict |
| `preChecks` | `boolean` | `true` | Run `gn_safe_edit_check` before proceeding |

**Example invocation (TypeScript):**

```typescript
import { gnSafeRefactor } from 'ontoindex/src/mcp/super/safe-refactor.js';

// Dry-run first (default — WRITE super-function rule)
const preview = await gnSafeRefactor('OntoIndex', {
  intent: 'rename',
  symbol: 'mergeWithRRF',
  params: { newName: 'mergeResultsWithRRF' },
  // dryRun: true is the default; omit or set explicitly
});

// Inspect preview.preview.diffSummary and preview.preCheckReport, then apply:
const result = await gnSafeRefactor('OntoIndex', {
  intent: 'rename',
  symbol: 'mergeWithRRF',
  params: { newName: 'mergeResultsWithRRF' },
  dryRun: false,
});
```

**Example return shape (dry-run):**

```json
{
  "version": 1,
  "intent": "rename",
  "symbol": {
    "nodeId": "Function:mergeWithRRF",
    "name": "mergeWithRRF",
    "filePath": "ontoindex/src/core/search/per-intent-ensemble.ts",
    "kind": "Function"
  },
  "preCheckReport": {
    "verdict": "CAUTION",
    "reasoning": "2 upstream callers; no test coverage detected"
  },
  "preview": {
    "affectedFiles": [
      "ontoindex/src/core/search/per-intent-ensemble.ts",
      "ontoindex/src/mcp/local/backend-search.ts"
    ],
    "diffSummary": "rename mergeWithRRF → mergeResultsWithRRF (4 edits across 2 files)",
    "estimatedLinesChanged": 4
  },
  "applied": false,
  "warnings": []
}
```

**Example return shape (applied):**

```json
{
  "version": 1,
  "intent": "rename",
  "symbol": {
    "nodeId": "Function:mergeWithRRF",
    "name": "mergeWithRRF",
    "filePath": "ontoindex/src/core/search/per-intent-ensemble.ts",
    "kind": "Function"
  },
  "preview": {
    "affectedFiles": ["ontoindex/src/core/search/per-intent-ensemble.ts", "ontoindex/src/mcp/local/backend-search.ts"],
    "diffSummary": "rename mergeWithRRF → mergeResultsWithRRF (4 edits across 2 files)",
    "estimatedLinesChanged": 4
  },
  "applied": true,
  "postCheckSummary": {
    "changedSymbols": ["mergeWithRRF"],
    "unexpected": []
  },
  "warnings": []
}
```

**Unsupported intents:** `split-function` and `convert-to-method` return `applied: false` with a warning entry — they are not yet dispatched in Phase 3.

**Composes (internal primitives):**
- `gnSafeEditCheck` from `safe-edit-check.ts` — pre-edit risk verdict (SAFE/CAUTION/DANGEROUS/BLOCKED)
- `renameSymbol` from `backend-rename.ts` — atomic rename with `dry_run` flag
- `resolveSymbolCandidates` from `backend-symbol-resolution.ts` — line range for `modify-body` preview
- `extractFunction` from `backend-extract-function.ts` — atomic extract with `dry_run` flag
- `moveSymbol` from `backend-move-symbol.ts` — atomic move with `dry_run` flag
- `detectChanges` from `backend-detect-changes.ts` — post-write unexpected-scope check

---

### `gn_ensure_fresh` — index lifecycle helper

**Intent:** "Make sure the index is current."

**When to use:** Before any retrieval-heavy operation if the repo has been edited since last analyze. Especially before `gn_explore` or `gn_safe_edit_check` to avoid stale results.

**Replaces:** manual `npx ontoindex status` + `npx ontoindex analyze` flow.

**Optional `autoAnalyze: true`** triggers re-analyze (with optional `--embeddings` flag). Default behavior is REPORT-ONLY (returns recommendations).

**Caveat:** when `withEmbeddings: true`, MCP processes hold DuckDB write-lock — manually stop them first OR use `killMcpForLock: true` (future enhancement; currently emits a warning).

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `withEmbeddings` | `boolean` | `false` | Check (and optionally generate) embeddings |
| `autoAnalyze` | `boolean` | `false` | Run `npx ontoindex analyze` when index is stale (requires explicit `true`) |
| `killMcpForLock` | `boolean` | `false` | Stop MCP processes before analyze to release DuckDB lock (future) |

**Example invocation (TypeScript):**

```typescript
import { gnEnsureFresh } from 'ontoindex/src/mcp/super/ensure-fresh.js';

// Check freshness (default — report only)
const report = await gnEnsureFresh('OntoIndex', {});

// Re-analyze if stale
const result = await gnEnsureFresh('OntoIndex', {
  autoAnalyze: true,
  withEmbeddings: false,
});
```

**Example return shape:**

```json
{
  "version": 1,
  "preCheck": {
    "indexedCommit": "a9de021a",
    "currentCommit": "e55bd133",
    "isStale": true
  },
  "embeddingsStatus": { "count": 0, "required": false },
  "actionsTaken": [],
  "warnings": [],
  "recommendations": [
    "Index is stale (indexed a9de021a vs current e55bd133). Run: npx ontoindex analyze"
  ]
}
```

**Example return shape (autoAnalyze: true):**

```json
{
  "version": 1,
  "preCheck": {
    "indexedCommit": "a9de021a",
    "currentCommit": "e55bd133",
    "isStale": true
  },
  "embeddingsStatus": { "count": 0, "required": false },
  "actionsTaken": ["Ran: npx ontoindex analyze"],
  "postCheck": {
    "indexedCommit": "e55bd133",
    "currentCommit": "e55bd133",
    "isStale": false
  },
  "warnings": [],
  "recommendations": []
}
```

**Composes (internal primitives):**
- `execFileSync('git', ['rev-parse', 'HEAD'])` — current HEAD commit
- `readFileSync('~/.ontoindex/registry.json')` — registry lookup for `lastCommit` and embeddings count
- `execFileSync('npx', ['ontoindex', 'analyze', ...])` — re-analyze when `autoAnalyze: true` and stale

---

### `gn_quality_mode` — single switch hides 25+ env vars

**Intent:** "Set retrieval quality preset for the session."

**When to use:** At session start. Replaces 25+ env var decisions with a single mode picker.

**Modes:**
- **`fast`** (default): clears `ONTOINDEX_INTENT_ENSEMBLE`, `ONTOINDEX_CITATIONS`, `ONTOINDEX_LSP_REFERENCES` — all defaults. ~50ms p50 query latency.
- **`balanced`**: sets `ONTOINDEX_INTENT_ENSEMBLE=1`, `ONTOINDEX_CITATIONS=1`; clears `ONTOINDEX_LSP_REFERENCES`. ~150ms p50.
- **`thorough`**: balanced + sets `ONTOINDEX_LSP_REFERENCES=1`, `ONTOINDEX_VEC_POOL_MIN=3`. ~300-500ms p50.

**Note:** SYNC return (not Promise). Mutates `process.env` directly. Revert by calling `gn_quality_mode({ level: 'fast' })`.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `level` | `'fast' \| 'balanced' \| 'thorough'` | required | Quality/latency preset to apply |
| `duration` | `'session' \| 'until-revert'` | `'session'` | Advisory only — both behave identically at runtime; `until-revert` emits a reminder warning |

**Example invocation (TypeScript):**

```typescript
import { gnQualityMode } from 'ontoindex/src/mcp/super/quality-mode.js';

// Set at session start — SYNC, no await
const report = gnQualityMode({ level: 'balanced' });

// Revert to defaults
gnQualityMode({ level: 'fast' });
```

**Example return shape:**

```json
{
  "version": 1,
  "appliedMode": "balanced",
  "envVarsSet": {
    "ONTOINDEX_INTENT_ENSEMBLE": "1",
    "ONTOINDEX_CITATIONS": "1"
  },
  "envVarsCleared": ["ONTOINDEX_LSP_REFERENCES"],
  "warnings": []
}
```

**Composes (internal primitives):**
- `process.env` — direct mutation; no external primitives called

---

## Phase 4 — PR review + self-help

### `gn_diff_impact` — PR-blast-radius wrapper

**Intent:** "What is the blast radius of this PR or commit range?"

**When to use:**
- During PR review to understand which symbols were changed and their upstream risk
- Before merging a feature branch: run with `commitRange: 'main...HEAD'` for a full branch diff
- When `gn_pre_commit_audit` is too narrow (staged only) and you need an arbitrary commit range
- Replaces the discipline rule "MUST run ontoindex_detect_changes" for multi-commit ranges

**Replaces:** manual `git diff <range> --name-only` + per-file symbol lookup + per-symbol upstream/downstream impact queries + test-coverage delta + reviewer inference from `git log` (varies; 5-10+ calls for a typical PR).

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `commitRange` | `string` | `undefined` | Git range e.g. `'HEAD~5..HEAD'` or `'main...feature'`; omit for staged diff |
| `scope` | `'staged' \| 'commit-range' \| 'branch'` | `'commit-range'` if `commitRange` set, else `'staged'` | Scope selector when `commitRange` is omitted |
| `includeReviewers` | `boolean` | `true` | Suggest reviewers from `git log --format=%aN` on changed files |

**Example invocation (TypeScript):**

```typescript
import { gnDiffImpact } from 'ontoindex/src/mcp/super/diff-impact.js';

const report = await gnDiffImpact('OntoIndex', {
  commitRange: 'main...HEAD',
  includeReviewers: true,
});
```

**Example return shape:**

```json
{
  "version": 1,
  "commitRange": "main...HEAD",
  "changedFiles": [
    {
      "path": "ontoindex/src/mcp/super/diff-impact.ts",
      "addedLines": 180,
      "removedLines": 0,
      "changedSymbols": [
        {
          "nodeId": "Function:gnDiffImpact",
          "name": "gnDiffImpact",
          "impact": { "upstreamCount": 2, "downstreamCount": 5, "risk": "LOW" }
        }
      ]
    }
  ],
  "totalSymbolsChanged": 3,
  "highRiskSymbols": [],
  "testCoverageDelta": { "coveredBefore": 2, "coveredAfter": 2, "deltaPp": 0 },
  "suggestedReviewers": ["Evgeniy Rasyuk"],
  "warnings": []
}
```

**Composes (internal primitives):**
- `execFileSync('git', diffArgs)` — resolves changed file paths via `--name-only` and line counts via `--numstat`
- `executeParameterized` — per-file symbol lookup via `CodeRelation {type: 'DEFINES'}` (limit 50 per file)
- `executeParameterized` — per-symbol upstream count via `CodeRelation {type: 'CALLS' | 'REFERENCES'}`
- `executeParameterized` — per-symbol downstream count via `CodeRelation {type: 'CALLS' | 'REFERENCES' | 'IMPORTS'}`
- `executeParameterized` — test-coverage heuristic via `CodeRelation {type: 'IMPORTS'}` with `*test*` / `*spec*` filename filter
- `execFileSync('git log --format=%aN')` — best-effort suggested reviewer inference (top-3 by recent commit count on changed files)

---

### `gn_diagnose` — system-status + improvement recommendations

**Intent:** "What's not optimal in my OntoIndex setup?"

**When to use:**
- At session start to verify the index is fresh and LSP servers are available
- When retrieval results seem stale or incomplete — run this before reporting a bug
- When onboarding to a new machine and verifying the OntoIndex environment
- When you suspect a quality-mode mismatch (e.g. ensemble is off when it should be on)

**Replaces:** manual `npx ontoindex status` + `which typescript-language-server` + `which pyright` + manual `process.env` inspection + recommendation synthesis (4-6 separate checks).

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `checkLsp` | `boolean` | `true` | Probe `typescript-language-server`, `pyright`, and `rust-analyzer` on PATH |
| `checkEmbeddings` | `boolean` | `true` | Report embedding count and populated status |
| `checkIndexFreshness` | `boolean` | `true` | Compare indexed commit vs current HEAD; warn if stale |

**Example invocation (TypeScript):**

```typescript
import { gnDiagnose } from 'ontoindex/src/mcp/super/diagnose.js';

const report = await gnDiagnose('OntoIndex', {});
```

**Example return shape:**

```json
{
  "version": 1,
  "indexFreshness": {
    "isStale": false,
    "indexedCommit": "e55bd133",
    "currentCommit": "e55bd133"
  },
  "embeddings": { "count": 0, "populated": false },
  "lspAvailable": { "typescript": true, "python": false, "rust": false },
  "envVars": {
    "ONTOINDEX_INTENT_ENSEMBLE": "1"
  },
  "recommendations": [
    {
      "severity": "INFO",
      "detail": "Embeddings not populated",
      "fix": "npx ontoindex analyze --embeddings"
    },
    {
      "severity": "INFO",
      "detail": "pyright not in PATH",
      "fix": "npm install -g pyright"
    }
  ],
  "warnings": []
}
```

**Recommendations emitted:**

| Condition | Severity | Fix |
|-----------|----------|-----|
| Index stale | `WARN` | `gn_ensure_fresh({autoAnalyze: true})` |
| Embeddings not populated | `INFO` | `npx ontoindex analyze --embeddings` |
| `typescript-language-server` not in PATH | `INFO` | `npm install -g typescript-language-server` |
| `pyright` not in PATH | `INFO` | `npm install -g pyright` |
| `rust-analyzer` not in PATH | `INFO` | Install via rustup or package manager |
| `ONTOINDEX_INTENT_ENSEMBLE` not set | `INFO` | `gn_quality_mode({level: "balanced"})` |

**Composes (internal primitives):**
- `gnEnsureFresh(repoId, {autoAnalyze: false})` — read-only freshness and embeddings check
- `execFileSync('which', [serverName])` — LSP binary probe; ENOENT is caught gracefully
- `process.env` — enumerate all `ONTOINDEX_*` keys

---

### `gn_propose_location` — where to add new code

**Intent:** "Where in the codebase should I put this new code?"

**When to use:**
- Before creating a new file: understand which cluster and directory it belongs in
- When unfamiliar with the codebase layout and unsure where a new handler / service / helper should live
- When naming a new file: get a suggested filename derived from sibling naming conventions

**Replaces:** manual `gn_explore` + cluster-to-directory mapping + sibling file enumeration + naming-convention sniffing + import pattern extraction (4-6 separate steps).

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `intent` | `string` | required | Free-text description of the new code, e.g. `"add new auth session handler"` |
| `language` | `string` | detected from siblings | Language hint for file extension; falls back to `.ts` if siblings are TypeScript |

**Example invocation (TypeScript):**

```typescript
import { gnProposeLocation } from 'ontoindex/src/mcp/super/propose-location.js';

const report = await gnProposeLocation('OntoIndex', {
  intent: 'add new auth session handler',
});
```

**Example return shape:**

```json
{
  "version": 1,
  "intent": "add new auth session handler",
  "candidates": [
    {
      "directory": "ontoindex/src/server",
      "suggestedFilename": "auth-session-handler.ts",
      "rationale": "Cluster \"server-api\" (role: HTTP API surface, 8 files) matched intent via semantic search.",
      "matchedCluster": "server-api",
      "siblingFiles": [
        "ontoindex/src/server/api.ts",
        "ontoindex/src/server/analyze-job.ts"
      ],
      "importPattern": "import { executeParameterized } from '../core/lbug/pool-adapter.js';\nimport { execFileSync } from 'child_process';"
    },
    {
      "directory": "ontoindex/src/mcp/local",
      "suggestedFilename": "auth-session-handler.ts",
      "rationale": "Cluster \"mcp-tools\" (role: MCP tool handlers, 12 files) matched intent via semantic search.",
      "matchedCluster": "mcp-tools",
      "siblingFiles": [
        "ontoindex/src/mcp/local/backend-search.ts",
        "ontoindex/src/mcp/local/backend-impact.ts"
      ],
      "importPattern": "import { executeParameterized } from '../../core/lbug/pool-adapter.js';"
    }
  ],
  "warnings": []
}
```

**Composes (internal primitives):**
- `gnExplore(repoId, {query: intent, depth: 'shallow'})` — finds top clusters matching the intent
- `executeParameterized` — sibling file enumeration via `CodeRelation {type: 'IN_COMMUNITY'}` (tries `name` then `heuristicLabel`)
- Filesystem read (`readFileSync`) — import pattern extraction from top-3 sibling files (best-effort)
- `longestCommonDirectory` — derives the suggested directory from sibling file paths
- `detectNamingSuffix` — sniffs majority suffix (e.g. `-service.ts`, `.handler.ts`) from sibling filenames
- `stemFromIntent` — lowercases and tokenizes the intent into a hyphenated filename stem (max 3 content words)

---

## Recommended workflow

0. **Set quality once at session start (optional):**
   ```typescript
   gn_quality_mode({ level: 'balanced' })
   ```
   Enables intent ensemble + citations for all subsequent calls in this session. Use `'thorough'` when LSP-level precision is needed; use `'fast'` to restore defaults.

1. **Discover unfamiliar code:**
   ```typescript
   gn_explore({ query: 'how does caching work in the ingestion pipeline?' })
   ```
   Use the `suggestedEntryPoints` and `topSymbols` in the result to orient yourself.

2. **Zoom into a specific symbol of interest:**
   ```typescript
   gn_find_related({ symbol: 'processChunk' })
   ```
   Check `callers` to understand who depends on it before editing; check `coChangedFiles` to know what else you will likely need to update.

3. **Understand the surrounding file before making changes:**
   ```typescript
   gn_explain_module({ filePath: 'ontoindex/src/core/ingestion/parsing-processor.ts' })
   ```
   Review `publicAPI` to confirm your intended change target is exported and check `cluster` membership to understand where the file fits architecturally.

4. **Before editing:**
   ```typescript
   gn_safe_edit_check({ symbol: 'processChunk', intent: 'modify-body' })
   ```
   Replaces remembering "MUST run ontoindex_impact" — returns a SAFE/CAUTION/DANGEROUS/BLOCKED verdict plus a `recommendedTool`.

5. **Before deleting:**
   ```typescript
   gn_can_delete({ symbol: 'legacyNormalizeQuery' })
   ```
   Zero-blocker verdict means safe to remove; any blocker means DO-NOT-DELETE.

6. **Before committing:**
   ```typescript
   gn_pre_commit_audit({ scope: 'staged' })
   ```
   Replaces remembering "MUST run ontoindex_detect_changes" — audits all staged symbols and returns READY/REVIEW/DO-NOT-COMMIT.

7. **For refactors (rename / extract / move / modify-body):**
   ```typescript
   // Step 1 — dry-run preview (default dryRun: true)
   gn_safe_refactor({ intent: 'rename', symbol: 'processChunk', params: { newName: 'processFileChunk' } })
   // Step 2 — apply after reviewing preview
   gn_safe_refactor({ intent: 'rename', symbol: 'processChunk', params: { newName: 'processFileChunk' }, dryRun: false })
   ```
   Pre-check and post-write detect_changes run automatically. Pass `force: true` to override BLOCKED/DANGEROUS.

8. **Optional pre-flight before retrieval-heavy work:**
   ```typescript
   gn_ensure_fresh({})
   ```
   Returns staleness status and recommendations. Add `autoAnalyze: true` to re-index automatically when stale.

9. **For PR review:**
   ```typescript
   gn_diff_impact({ commitRange: 'main...HEAD' })
   ```
   Returns per-file symbol impact, HIGH-risk symbols, test-coverage delta, and suggested reviewers for the full branch diff.

10. **Health check:**
    ```typescript
    gn_diagnose({})
    ```
    Run at session start to verify index freshness, LSP availability, embeddings, and env-var quality mode. Emits ranked recommendations with fix commands.

11. **Where to add new code:**
    ```typescript
    gn_propose_location({ intent: 'add new auth session handler' })
    ```
    Returns up to 3 candidate directories with suggested filenames, cluster rationale, sibling files, and common import patterns.

---

## Current limitations

- **Read-only.** No DB writes, no file writes, no side effects beyond temporary env-var manipulation that is reverted before the call returns.
- **Call-local env-var management.** `ONTOINDEX_INTENT_ENSEMBLE` and `ONTOINDEX_CITATIONS` are set and unset within a single call using a `try/finally` restore pattern. They do NOT persist across calls. If two super-functions were called concurrently (not possible under the MCP sequential protocol), env-var state would be undefined — this is noted in `explore.ts` comments and revisited if needed in Phase 2+.
- **Cross-repo references not yet wired.** `gn_find_related` accepts `includeCrossRepo: true` but currently returns an empty array with a warning. Full cross-repo support is planned for a later phase.
- **No caching between sub-calls.** Each invocation re-queries the graph. Caching is a Phase 5 optimization concern.
- **Best-effort sub-calls.** Individual Cypher queries inside a super-function (cluster lookup, co-change, citations) are executed best-effort. If one fails, a warning is added to `warnings[]` and the result is omitted rather than the whole call failing.

---

## Phase 5 super-functions (planned)

Phase 1 covers discovery; Phase 2 covers safety; Phase 3 covers refactoring and lifecycle; Phase 4 covers PR review and self-help. Subsequent phases add:

- **Phase 5 (Docs + agent prompts):** AGENTS.md / CLAUDE.md updates to recommend super-functions first; `gn_help()` discovery tool

The full super-function roadmap is tracked through ADRs and release documentation.

---

## See also

- `ontoindex/docs/power-user-config.md` — full env-var reference (37 vars); use this when primitives are needed directly
- `docs/adr/0000-index.md` — architectural decisions for the underlying primitives (intent ensemble, citation BFS, Leiden clustering, co-change mining, etc.)
