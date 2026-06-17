# ADR 0089 Pre-Junior Project Plan: Indexing Lifecycle and File-Scope Explainability

**Status:** Ready for implementation
**ADR:** `docs/adr/0089-claude-context-inspired-indexing-lifecycle-and-file-scope-explainability.md`
**Date:** 2026-06-17
**Review update:** challenged against current owners with OntoIndex MCP. Keep file-scope logic in a
small reusable core helper; keep CLI and MCP as consumers.

## Challenge Result

This plan is smaller than the ADR. OntoIndex already has runtime health, stale-lock detection,
checkpoint detection, ignore rules, and MCP diagnostics. Pre-juniors should expose and reuse those
pieces, not create a watcher, daemon, new lifecycle state machine, or new MCP frontier.

## Goal

Make indexing behavior understandable before and after `analyze`:

- users can preview what files would be indexed without writing `.ontoindex`;
- users can ask why one path is included or skipped;
- MCP diagnostics show the same runtime-health state as CLI status;
- `gn_ensure_fresh` does not auto-analyze when the current index is untrusted or failed.

## Hard Scope

Allowed files:

- `ontoindex/src/config/ignore-service.ts`
- `ontoindex/src/core/indexing/file-scope-preview.ts` or another narrow core helper if needed
- `ontoindex/src/cli/analyze.ts`
- `ontoindex/src/cli/index.ts`
- `ontoindex/src/cli/status.ts`
- `ontoindex/src/core/runtime/runtime-health.ts`
- `ontoindex/src/mcp/super/diagnose.ts`
- `ontoindex/src/mcp/super/ensure-fresh.ts`
- existing nearby CLI/MCP schema files only if required
- focused unit tests under `ontoindex/test/unit/`

Not allowed:

- background indexing;
- file watcher sync;
- daemon registry;
- external vector storage;
- new MCP tool family;
- replacing `.gitignore` / `.ontoindexignore` behavior;
- full rule-trace UI.

## Existing Owner Map

Use these existing owners. Do not create replacements.

| Area                           | Existing owner              | What to extend                                     |
| ------------------------------ | --------------------------- | -------------------------------------------------- |
| Built-in and ignore-file rules | `ignore-service.ts`         | Add one explanation helper beside existing filters |
| File-scope preview             | New narrow core helper      | Reuse ignore-service; no graph writes              |
| Analyze command registration   | `cli/index.ts`              | Register dry-run/explain-file options              |
| Analyze command behavior       | `cli/analyze.ts`            | Consume preview/explain helpers before writing     |
| Runtime health                 | `runtime-health.ts`         | Reuse existing `RuntimeHealthSnapshot`             |
| CLI status display             | `cli/status.ts`             | Show runtime health before freshness if missing    |
| MCP diagnostics                | `mcp/super/diagnose.ts`     | Add bounded file-scope and health fields           |
| MCP freshness / auto-analyze   | `mcp/super/ensure-fresh.ts` | Block auto-analyze on untrusted/failed health      |

## Task List

### T1: Add Path Scope Explanation Helper

**Owner files:**

- `ontoindex/src/config/ignore-service.ts`
- `ontoindex/test/unit/ignore-service.test.ts`

**Change:**

Add a pure helper:

```ts
export type FileScopeExplanation = {
  repoPath: string;
  filePath: string;
  included: boolean;
  reason:
    | "included-extension"
    | "builtin-ignore"
    | "gitignore"
    | "ontoindexignore"
    | "unsupported-extension"
    | "generated"
    | "missing";
  matchedPattern?: string;
  source?: ".gitignore" | ".ontoindexignore" | "builtin" | "extension";
  suggestedFix?: string;
};

export async function explainPathScope(repoPath: string, filePath: string): Promise<FileScopeExplanation>;
```

Keep it simple. Return the first decisive reason. Do not build a full trace of every matching rule.
Preserve existing `shouldIgnorePath`, `loadIgnoreRules`, and `createIgnoreFilter` behavior.

**Tests:**

- path under `node_modules/` returns `builtin-ignore`;
- path ignored by `.ontoindexignore` returns `ontoindexignore`;
- path ignored by `.gitignore` returns `gitignore`;
- supported source file returns `included-extension`;
- unsupported extension returns `unsupported-extension`;
- missing file returns `missing`.

**Done when:**

- existing `createIgnoreFilter` behavior is unchanged;
- helper is covered without running a full analyze.

### T2: Add File Scope Preview Collector

**Owner files:**

- `ontoindex/src/core/indexing/file-scope-preview.ts`
- `ontoindex/src/config/ignore-service.ts`
- `ontoindex/test/unit/file-scope-preview.test.ts`

**Change:**

Add a small collector used by CLI and MCP. Keep it outside `analyze.ts` so the command does not grow
more analysis logic:

```ts
type FileScopePreview = {
  repoPath: string;
  totalCandidates: number;
  includedCount: number;
  skippedCount: number;
  includedByExtension: Record<string, number>;
  topSkippedDirectories: Array<{ path: string; count: number; reason: string }>;
  largestIncludedFiles: Array<{ path: string; bytes: number }>;
  warnings: string[];
};
```

Use the same discovery and ignore rules as analyze. Do not write `.ontoindex`, metadata, graph files,
or skills.

Implementation hint:

- use existing supported-file and ignore helpers where available;
- cap `largestIncludedFiles` and `topSkippedDirectories` with a `limit`;
- use `explainPathScope` for skip reasons instead of duplicating rule logic.

**Tests:**

- preview does not create `.ontoindex`;
- counts include a known `.ts` or `.js` file;
- ignored/generated files appear in skipped counts or warnings.

**Done when:**

- collector can run on a temp repo without writing index state.

### T3: Add CLI Modes

**Owner files:**

- `ontoindex/src/cli/analyze.ts`
- `ontoindex/src/cli/index.ts`
- `ontoindex/test/unit/analyze-runtime.test.ts` or nearest CLI analyze test

**Change:**

Add:

```bash
ontoindex analyze --dry-run
ontoindex analyze --explain-file <path>
```

Output can be plain text first. Do not add JSON unless an existing analyze test pattern already makes
it trivial.

Rules:

- `--dry-run` prints preview and exits zero;
- `--explain-file` prints one explanation and exits zero unless repo/path is invalid;
- neither mode writes `.ontoindex`;
- if both are passed, fail with a clear one-line error.

**Tests:**

- dry-run output includes total/included/skipped counts;
- explain-file output includes included/skipped reason;
- no `.ontoindex` directory is created.

**Done when:**

- commands work from a temp repo using local CLI test harness.

### T4: Wire Runtime Health Into MCP Freshness

**Owner files:**

- `ontoindex/src/mcp/super/ensure-fresh.ts`
- `ontoindex/test/unit/super/ensure-fresh.test.ts`

**Change:**

Before auto-analyze, read existing `RuntimeHealthSnapshot` for the resolved repo path.

If `freshnessState` is `untrusted` or `failed-after-partial-run`:

- return a successful degraded response;
- include `runtimeHealth.freshnessState`;
- include `runtimeHealth.degradedReason`;
- include `runtimeHealth.repairCommand`;
- do not run analyze even when `autoAnalyze: true`.

Do not change `runtime-health.ts` unless a bug is found.
Do not create a new health enum. Use existing `freshnessState` values.

**Tests:**

- stale lock/untrusted state blocks auto-analyze;
- failed checkpoint blocks auto-analyze;
- normal stale state still allows existing auto-analyze behavior.

**Done when:**

- `gn_ensure_fresh` cannot silently repair an untrusted index by running analyze behind the caller.

### T5: Add Bounded File Scope To `gn_diagnose`

**Owner files:**

- `ontoindex/src/mcp/super/diagnose.ts`
- `ontoindex/test/unit/super/diagnose.test.ts`
- file-scope preview helper from T2

**Change:**

Extend params:

```ts
includeFileScopePreview?: boolean;
explainFile?: string;
fileScopeLimit?: number;
```

Return bounded fields:

```ts
fileScopePreview?: FileScopePreview;
fileScopeExplanation?: FileScopeExplanation;
runtimeHealth?: RuntimeHealthSnapshot;
```

Keep defaults compact. Only compute preview when requested.
Do not make `gn_diagnose` walk the repository on default calls.

**Tests:**

- default diagnose response size does not grow with file preview;
- requested explain-file returns one explanation;
- requested preview respects the limit.

**Done when:**

- MCP clients can diagnose file-scope issues without reading logs or running CLI.

### T6: Make CLI Status Honest About Runtime Health

**Owner files:**

- `ontoindex/src/cli/status.ts`
- `ontoindex/test/unit/status.test.ts`

**Change:**

Ensure `status` shows runtime health before any up-to-date wording. OntoIndex MCP currently shows
`readRuntimeHealth` is already called by `statusCommand`; if display is already correct, add a test
and no product code.

Required behavior:

- `untrusted` prints before "up-to-date";
- `failed-after-partial-run` prints the repair command;
- stale lock is visible.

**Tests:**

- mocked health `untrusted` does not produce a healthy-looking status only;
- mocked failed checkpoint includes repair command.

**Done when:**

- a crashed analyze cannot leave a misleading status screen.

## Suggested Work Order

1. T1 first. Everything else depends on one explanation helper.
2. T2 and T3 together. Keep the CLI slice small.
3. T4 before T5. MCP freshness safety matters more than diagnostics polish.
4. T6 last. It may already be mostly implemented.

Do not start with MCP. If the core file-scope helper is not done, MCP work will duplicate logic.

## Validation Commands

Run the smallest relevant checks after each task:

```bash
cd ontoindex
npx vitest run test/unit/ignore-service.test.ts
npx vitest run test/unit/file-scope-preview.test.ts
npx vitest run test/unit/super/ensure-fresh.test.ts
npx vitest run test/unit/super/diagnose.test.ts
npx vitest run test/unit/status.test.ts
npx tsc --noEmit
```

Before final handoff:

```bash
cd ontoindex
npx prettier --check src test ../docs/adr/0089-claude-context-inspired-indexing-lifecycle-and-file-scope-explainability.md ../docs/guides/adr-0089-pre-junior-project-plan.md
npx tsc --noEmit
```

Do not run broad analyze as part of pre-junior tasks unless the manager explicitly asks.

## Stop Conditions

Stop and ask a senior if:

- implementing a task requires a new daemon, watcher, or background worker;
- `ignore-service.ts` behavior must change for existing analyze runs;
- a new MCP tool name seems necessary;
- runtime-health state needs a second lifecycle model;
- tests require touching unrelated packages or generated wiki output.

## Definition of Done

- ADR 0089 accepted scope is implemented without new subsystems.
- Dry-run and explain-file do not write `.ontoindex`.
- MCP diagnostics expose file-scope data only when requested.
- `gn_ensure_fresh` respects untrusted and failed runtime-health states.
- Focused tests and typecheck pass.
