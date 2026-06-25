# OntoIndex v1.9.28

Highlights:

- semantic CLI and MCP search now accept `include_paths` / `exclude_paths` so emitted results can be narrowed to repository-relative prefixes without adding a new search surface
- semantic search can now return bounded per-symbol `explanation` text when `include_explanations` is requested
- fallback result ordering now demotes generic app entry files such as `App.tsx` and `main.tsx` when stronger ranking evidence is absent

Validation:

- `cd ontoindex && node ./node_modules/vitest/vitest.mjs run test/unit/backend-search-typed.test.ts test/unit/tool-direct-cli.test.ts`
- `cd ontoindex && npm run build`
- `cd ontoindex && npm pack --pack-destination ..`
- `cd ontoindex && npx tsc --noEmit --pretty false`
