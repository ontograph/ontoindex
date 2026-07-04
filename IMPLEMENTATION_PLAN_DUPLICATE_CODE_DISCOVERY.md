# Implementation Plan: Duplicate-Code Discovery (Exact Mode)

Source ADR: ADR_DUPLICATE_CODE_DISCOVERY.md
Status: Slice 1 DONE (exact mode implemented + tested; verified 2026-07-04)
Scope: `ontoindex duplicate-code --mode exact` only. Semantic mode is proof-gated (out of scope here).

## Guiding constraints (from ADR)

- CLI-only, advisory. No MCP tool, no CI gate in this slice.
- Exact mode shells out to `jscpd` via `npx --yes jscpd@5.0.11`. Not a devDependency.
- Missing binary / no network => one clear install-and-run message.
- Respect `.gitignore`; skip generated/vendor paths by default.
- JSON output for machines, bounded summary for humans.
- Do not reimplement clone detection natively.

## Wiring facts (verified in current source)

- Commands register in `ontoindex/src/cli/index.ts` via `program.command(...)` + `createLazyAction(() => import('./x.js'), 'xCommand')`.
- Command bodies are flat files in `ontoindex/src/cli/*.ts` (e.g. `audit.ts`).
- `createLazyAction` (`ontoindex/src/cli/lazy-action.ts`) defers the import until invocation; the new command must export a named `duplicateCodeCommand`.

## Slice 1 tasks

1. New command file `ontoindex/src/cli/duplicate-code.ts`
   - Export `async function duplicateCodeCommand(options)`.
   - Options: `--mode <exact|semantic>` (default `exact`; `semantic` => print "not yet implemented, see ADR" and exit non-zero-clean), `--min-lines <n>`, `--min-tokens <n>`, `--include <glob...>`, `--exclude <glob...>`, `--path <path>` for scan target, `--json`, `--output <path>` for the normalized JSON report.
   - Reject `--mode both` explicitly (ADR dropped it) with a one-line message.

2. jscpd invocation helper (in the same file until a second caller exists)
   - Build argv for `npx --yes jscpd@5.0.11` (this package is now the Rust `cpd` CLI). The `json` reporter writes `jscpd-report.json` into `--output <dir>`, NOT stdout, so scan into a temp dir and read the file back. `.gitignore` is respected by default (no `--gitignore` flag). Use `--min-lines`/`--min-tokens`, `--ignore` (comma-separated default globs + user excludes), `--pattern` for includes, `--silent --no-tips`.
   - Pin the version in one constant so runs are reproducible.
   - Spawn with `child_process` (no shell string interpolation of user paths; pass args as an array to avoid injection).

3. Missing-binary / offline handling
   - On spawn ENOENT (no `npx`/node) or npx network failure, exit with ONE message: which binary+version is needed and the install/run hint. No stack trace.

4. Output normalization
   - Parse jscpd JSON into the ADR's required shape: group id, file paths, start/end lines, duplicated line+token counts, duplication %, detector name+version, thresholds used, ignored-path summary.
   - `--json` => print normalized JSON. Default => bounded human summary (cap the number of groups shown; print total + "N more" tail).

5. Register in `ontoindex/src/cli/index.ts`
   - `program.command('duplicate-code')` with the options above and `.action(createLazyAction(() => import('./duplicate-code.js'), 'duplicateCodeCommand'))`.

## Tests (focused, no framework beyond existing vitest)

Cover pure logic only; do not spawn real jscpd in tests. Place unit tests in `ontoindex/test/unit/duplicate-code.test.ts` (existing vitest layout).

1. argv builder: given options, produces expected `npx jscpd` args incl. default ignores, temp output directory, min-lines/min-tokens, include/exclude. `.gitignore` is respected by jscpd v5 by default; there is no `--gitignore` flag.
2. JSON parser: sample jscpd JSON => normalized group shape with correct line ranges and counts.
3. bounded summary: many groups => output capped with accurate "N more" tail.
4. mode guard: `--mode both` and `--mode semantic` produce the expected refusal/not-implemented paths.
5. missing-binary/offline path: simulated ENOENT or nonzero/no-report subprocess result => single clear message, non-zero exit, no throw leak.

## Acceptance (from ADR, restated as checks)

- Runs on this repo without scanning ignored/generated/vendor paths.
- JSON output includes duplicate groups with file paths and line ranges.
- Human output is bounded and actionable.
- Missing detector / no-network => one clear message.
- Focused tests cover parser + argv builder + guards.

## Explicitly out of scope

- Semantic mode (proof-gated per ADR).
- MCP tool exposure.
- CI gate / SARIF export.
- Native clone-detection engine.
- Adding jscpd as a devDependency (revisit only if npx proves slow/flaky).

## Decisions confirmed before coding

- PINNED_VERSION: 5.0.11 confirmed available on npm (2026-07-04); bump only intentionally.
- Default ignore glob list: implemented in `DEFAULT_IGNORE_GLOBS`; jscpd v5 respects `.gitignore` by default and receives no `--gitignore` flag.

## Slice 1 Closeout (2026-07-04)

Status: DONE — implementation-ready tasks complete.

Completed:
- Command `ontoindex duplicate-code --mode exact` implemented in `ontoindex/src/cli/duplicate-code.ts` (tasks 1-4).
- Registered in `ontoindex/src/cli/index.ts` (task 5).
- Unit tests in `ontoindex/test/unit/duplicate-code.test.ts` cover all five planned cases: argv builder, JSON parser, bounded summary, mode guards (`both`/`semantic`/unknown), ENOENT missing-binary path, and nonzero/no-report subprocess failure.

Validation:
- `npx vitest run test/unit/duplicate-code.test.ts` => 12 passed.
- `npx tsc --noEmit` => clean for these files.
- Real run: `duplicate-code --path src/cli --min-lines 10 --output /tmp/onto-dupe-report.json` => 19 clone groups (1.94% duplicated), bounded summary printed and normalized JSON report file written.

Owner/scope: changes limited to the two new files plus the `index.ts` command registration. No MCP tool, no CI gate, no devDependency added (per ADR non-goals).

Remaining in scope: none. Semantic mode stays proof-gated per ADR (not eligible until the proof-gate is met).
