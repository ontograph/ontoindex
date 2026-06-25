# OntoIndex v1.9.26

## Highlights

- Adds audit freshness and MCP resource bridge reporting to the existing diagnostics surfaces:
  `status`, `mcp-doctor`, and `gn_diagnose`.
- Fixes stale audit repair guidance so diagnostics point to audit replay instead of `audit verify`.
- Bundles LadybugDB `fts` and `vector` extension binaries from the local cache into release builds
  when available, and teaches runtime extension lookup to prefer packaged artifacts.
- Extends the Windows PowerShell installer to prefetch LadybugDB `fts` and `vector` extensions
  into the local cache before install.

## Validation

- `node ./node_modules/vitest/vitest.mjs run test/unit/status.test.ts test/unit/mcp-doctor.test.ts test/unit/super/diagnose.test.ts test/unit/lbug-extension-cache.test.ts`
- `npm run build`
- `npx tsc --noEmit --pretty false`
- `npm test`
- `npm pack --pack-destination ..`
