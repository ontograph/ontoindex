# MCP six-repair closeout

Date: 2026-10-13
Authority: User instruction to proceed with the six proposed repairs
Decision: [Diagnostic binding and resource errors](../ADR_MCP_DIAGNOSTIC_BINDING_AND_RESOURCE_ERRORS.md)

## Outcome

Implemented the six source-backed repairs: actionable mismatch restart choices,
exact doctor path comparison, conservative bare-process recognition, implicit
Git-root resolution, trusted startup binding, and MCP resource protocol errors.
Challenge corrections carry the selected repository path separately from the
service project, handle internal repository IDs, reject missing resource detail
parameters, and keep ambiguous process arguments and discovery failures degraded.

Four bounded agents ran on gpt-6-luna and gpt-6.1-sol. The parent integrated the
disjoint changes and completed serial validation. Existing dirty files were
preserved; pre-task copies and final hashes are in
`/tmp/ontoindex-six-repairs-V2memd`. No active pre-existing plan was advanced.

## Validation

Working directory: `ontoindex/`.

- `npm test -- test/unit/mcp-doctor.test.ts test/unit/mcp-command.test.ts test/unit/repo-resolution-errors.test.ts test/unit/server.test.ts test/unit/resources.test.ts test/unit/super/diagnose.test.ts test/unit/mcp-service-project-context.test.ts test/unit/mcp-server-graph-walk-init.test.ts test/unit/mcp-server-error-path.test.ts test/unit/mcp-server-shutdown.test.ts test/unit/mcp-path-security.test.ts test/unit/target-context.test.ts test/unit/response-pages.test.ts test/unit/mcp-http-diagnostics.test.ts test/unit/super/dispatch-validation.test.ts test/integration/mcp-resource-errors-sdk.test.ts test/integration/mcp-http-real-sdk.test.ts test/integration/mcp-facades.test.ts test/integration/mcp-http-api-auth.test.ts --maxWorkers=4`: exit 0; 19 suites, 465 tests passed.
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`: exit 0.
- Scoped `git diff --check`: exit 0.
- `gn_verify_diff`: PASS with explicit changed/expected files. This verifies
  supplied scope, not complete graph impact; dirty target symbols returned
  source-only identity and UNKNOWN impact. Source inspection is authority.

Initial runs exposed old success-as-error-content expectations and unavailable
process READY fixtures; affected assertions were corrected and final tests rerun.
Vitest's repository configuration ignores unhandled errors, so suite success
does not attest all runtime paths. SDK tests assert protocol responses directly.

## Remaining limits

The original intermittent client handshake failure was not reproduced. The
installed binary was not rebuilt or replaced. No commit, push, release, GitHub
CI, CodeQL, process restart, reindex, or credential recovery occurred.
The checkout has no `ontocode-rs` workspace; its Rust formatting command does
not apply to these TypeScript changes.
