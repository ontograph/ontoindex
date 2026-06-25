# OntoIndex v1.9.27

Highlights:

- release installers now use `wget` for GitHub release metadata, tarball, and LadybugDB extension downloads
- analyze now persists embedding `model_hash` into `.ontoindex/meta.json`
- `gn_diagnose` / `gn_ensure_fresh` no longer degrade a populated embedding index solely because the MCP process environment lacks `ONTOINDEX_EMBEDDING_MODEL_HASH`

Validation:

- `cd ontoindex && node ./node_modules/vitest/vitest.mjs run test/unit/super/ensure-fresh.test.ts test/unit/run-analyze-snapshot.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`
- `node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js detect-changes --repo ontoindex`
