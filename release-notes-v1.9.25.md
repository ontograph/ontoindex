# OntoIndex v1.9.25

## Highlights

- Adds target-mode test evidence discovery to `gn_test_gap` for symbols, files, and behavior
  queries.
- Lets `gn_test_suggestions` reuse existing targeted tests from `gn_test_gap` before suggesting a
  new test file.
- Adds read-first/files-only projection surfaces for exploration and module-neighborhood MCP tools.
- Includes embedding, zvec, LadybugDB, runtime-health, and tree-sitter compatibility improvements
  behind existing CLI/MCP contracts.

## Validation

- `npm test -- --run test/unit/super/test-gap-target.test.ts test/integration/systems-audit-mcp.test.ts test/unit/tool-contract-schema.test.ts`
- `npx tsc --noEmit --pretty false`
- `npm run build`
- `npm pack --pack-destination ..`
