# OntoIndex v1.9.29

Highlights:

- docs readiness and context now surface explicit tracker-state facts from Markdown frontmatter, so
  bounded manager loops can carry open tasks, blocked reasons, no-dispatch gates, reopen criteria,
  and next actions through existing `gn_docs` responses
- diagnostic and support reporting is now aligned across `ontoindex status`, `mcp-doctor`, and
  audit failure paths, including embedding state, audit freshness, MCP resource exposure, Ladybug
  store state, extension availability, and timeout hints
- diff, review, detect-changes, and pre-commit audit flows now accept repository-relative path
  scoping, which makes dirty-worktree validation practical without adding a parallel tool surface
- setup/help text now makes the `list_repos` / `ontoindex list` relationship explicit instead of
  leaving a CLI/docs mismatch

Validation:

- `cd ontoindex && npx tsc --noEmit --pretty false`
- `cd ontoindex && npx vitest run test/unit/target-context.test.ts test/unit/super/diagnose.test.ts test/unit/super/ensure-fresh.test.ts test/unit/status.test.ts test/unit/mcp-doctor.test.ts test/unit/audit-command.test.ts test/unit/super/tool-contract.test.ts test/unit/super/tool-contract-policies.test.ts test/unit/tool-contract-schema.test.ts test/unit/mcp-hints.test.ts test/unit/resources.test.ts test/unit/tools.test.ts test/unit/tool-direct-cli.test.ts test/unit/cli-index-help.test.ts test/unit/detect-changes-bounds.test.ts test/unit/review-diff.test.ts test/unit/super/diff-impact.test.ts test/unit/super/pre-commit-audit.test.ts test/unit/markdown-sidecar-producer.test.ts test/integration/mcp-docs-facades.test.ts`
- `cd ontoindex && npm run build`
- `cd ontoindex && npm pack --pack-destination ..`

Known baseline issue:

- `cd ontoindex && npx vitest run ... test/unit/tool-contract-schema.test.ts ...` still has the
  same pre-existing snapshot failure on both the clean baseline worktree and the release tree; the
  release change set did not introduce a new test regression there
