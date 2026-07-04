# OntoIndex v2.0.4

## Highlights

- Added `ontoindex duplicate-code --mode exact` as a CLI-only advisory duplicate-code discovery
  command.
- The exact detector shells out to pinned `jscpd@5.0.11` through `npx`, avoiding a new default
  dependency while keeping runs reproducible.
- Reports are available as bounded human summaries, `--json` output, or a normalized JSON report
  file via `--output <path>`.
- Semantic duplicate discovery remains proof-gated by the ADR until exact mode is shown
  insufficient for a real workflow.

## Validation

- `cd ontoindex && npx vitest run test/unit/duplicate-code.test.ts`
- `cd ontoindex && npx tsc --noEmit`
- `cd ontoindex && npm run build`
- `cd ontoindex && node dist/cli/index.js duplicate-code --path src/cli --min-lines 10 --output /tmp/onto-dupe-report.json`
