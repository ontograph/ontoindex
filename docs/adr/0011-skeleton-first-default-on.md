# ADR-0011: Skeleton-first viewing default

**Status:** Accepted (default-on; Pillar 1 of v7+ pivot)
**Date:** 2026-04-29 (v8 W0b)
**Source:** `ontoindex/src/core/search/skeleton.ts`; usage in `ontoindex/src/mcp/local/backend-search.ts`.

## Context

When an agent retrieves a symbol via MCP, returning the full file content is wasteful for large files. A "skeleton" view (function signatures + class shapes + comments; no function bodies) is sufficient for most reasoning steps and uses 4-10× fewer tokens. The v7+ symbolic intelligence pivot proposed making this the default (Pillar 1 — "view"). v8 W0b shipped it default-on with `ONTOINDEX_SKELETON_DEFAULT=0` as the disable flag.

## Decision

**Default: skeleton view** for all retrieved symbols. Skeleton depth is **intent-aware**. User can disable with `ONTOINDEX_SKELETON_DEFAULT=0`. Skeleton excludes function bodies but preserves all signatures, declarations, comments, and imports.

## Algorithm / Technique

### Activation gate (`backend-search.ts`)

```
const skeletonDefault = process.env.ONTOINDEX_SKELETON_DEFAULT !== '0';

const includeSkeleton = params.include_skeleton ?? skeletonDefault;
```

Two layers:
1. Per-call: `params.include_skeleton` overrides everything.
2. Default: env-driven; `ONTOINDEX_SKELETON_DEFAULT=0` opts out globally.

### Intent-aware depth (`backend-search.ts`)

```
const SKELETON_DEPTH_BY_INTENT: Record<string, number> = {
  'cross-file-impact': 2,
  'calls-of': 2,
  'nl-conceptual': 3,
  ambiguous: 3,
  identifier: 1,
};
```

- **Depth 1 (`identifier`):** just the symbol's signature + the file's top-level declarations.
- **Depth 2 (`calls-of`, `cross-file-impact`):** signature + immediate scope + call/import context.
- **Depth 3 (`nl-conceptual`, `ambiguous`):** signature + scope + nested function shapes (still no bodies). For natural-language queries the agent benefits from seeing more structural context.

### Skeleton extraction (`skeleton.ts:getFileSkeleton`)

Inputs: `filePath`, `language`, `depth`, optional `targetSymbol`.

Algorithm (per language provider):

1. Parse file with tree-sitter (cached AST when available).
2. Walk the AST top-down.
3. For each node visited:
   - If node is a **comment**, **import**, **type alias**, **const declaration**, or **interface**: include in full.
   - If node is a **function** or **method** declaration:
     - If `currentDepth <= depth`: emit `signature + opening brace + ' /* body omitted */ + closing brace`.
     - If `currentDepth > depth`: skip entirely.
   - If node is a **class** or **module**:
     - Emit class declaration + brace.
     - Recurse into class members at `currentDepth + 1`.
   - Other nodes (statements, expressions): omit unless they're at the file scope (file-scope statements like top-level constants stay).
4. Join included AST node strings with their original whitespace preserved.

### Why preserve signatures, not bodies

Token economics:
- Average TS function body: 20-100 lines.
- Average TS function signature: 1-3 lines.
- Token savings: 5-30× for function-heavy files.

Information value:
- Body: implementation detail — agent rarely needs it for retrieval-stage reasoning.
- Signature: parameters, return type, decorators — sufficient for "is this the right symbol?"
- Comments: design intent — preserved.
- Imports: dependency context — preserved.

### `targetSymbol` zoom

When set, include the target symbol's full body (recurse without depth limit inside it) but apply the depth limit to surrounding context. Lets the agent get a focused view: "this is the function I want; here's its full body; here's the surrounding skeleton at depth N."

### Languages supported

Per-language skeleton logic lives in each `LanguageProvider` (TypeScript, JavaScript, Python, Ruby, Go, Java, Swift, COBOL, etc.). Languages without scope-capture providers fall back to "include the whole file" — graceful degradation.

### Caching

Skeleton extraction is cached per `(filePath, depth, contentHash)` tuple. Tests verify cache invalidation on content change.

### Production telemetry

Per v8 W0b acceptance: measure agent-task-completion-rate pre/post skeleton-default-on. The acceptance gate explicitly required NO completion-rate regression >5pp. Per v8 closure record, this gate held; skeleton-first ships default-on.

## Consequences

**Positive:**
- 4-10× token reduction on average TS/JS retrieval (per v7+ pivot doc claims; held in v8 W0b benchmarks)
- Intent-aware depth means depth=1 for identifier queries, depth=3 for natural-language — well-tuned per query type
- Single env var (`ONTOINDEX_SKELETON_DEFAULT=0`) for users who need full bodies (e.g., very small files where skeleton=full)
- Caching prevents redundant tree-sitter walks

**Negative:**
- Some queries genuinely need bodies (e.g., "what algorithm does X use?") — agent must explicitly request `include_skeleton: false` for those
- Static depth-by-intent mapping doesn't adapt to file size (a 100-line file with depth=1 vs a 5000-line file with depth=2 may both be sub-optimal)
- "Full body of target + skeleton elsewhere" mode adds complexity to extraction logic
- COBOL/Swift skeleton support is partial.

**Open issues for future work:**
- File-size-aware depth (adaptive)
- Per-provider skeleton quality benchmarks
- Skeleton for documentation generation (reuse for wiki — see ADR / future Pillar 5 synthesis project)
- Skeleton-mode tuning per intent (deferred from v8/v9; carry-forward in forward plan)
