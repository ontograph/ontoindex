# OntoIndex v2.0.3

## Highlights

- Group sync now supports opt-in `shared_libs` extraction for C and C++ include contracts without requiring Ladybug DB.
- Shared-library matching handles repo-local include roots, same-repo cross-service headers, bare shared headers, and case-sensitive include paths while filtering common toolchain headers.
- Group config defaults and docs now keep `shared_libs` off by default, so include scanning is only enabled when a repo explicitly wants it.
- `review diff` guidance now documents the GitHub PR adapter flow and a prompt-only synthesis critic pass over the existing ADR 0018 review envelope.

## Validation

- `cd ontoindex && npm run build`
- `cd ontoindex && npx tsc --noEmit --pretty false`
- `cd ontoindex && npx vitest run test/unit/group/config-parser.test.ts test/unit/group/matching.test.ts test/unit/group/sync.test.ts test/unit/export-bootstrap.test.ts test/unit/export-graph-html.test.ts test/unit/local-backend-repo-runtime.test.ts test/unit/mcp-command.test.ts test/unit/mcp-doctor.test.ts test/unit/setup.test.ts test/unit/status.test.ts test/unit/super/diagnose.test.ts test/unit/super/ensure-fresh.test.ts test/unit/target-context.test.ts`
- `cd ontoindex && npm pack --pack-destination ..`
- `git diff --check`
