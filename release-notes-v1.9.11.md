# OntoIndex v1.9.11

Release date: 2026-06-16

## Highlights

- Added a shared runtime-health contract for agent workflows. `status` and MCP response metadata now
  report dirty, stale, failed, unclean-lock, and unknown trust states with repair guidance.
- Added recoverable MCP runtime states for not-indexed repos, wrong repo bindings, stale/degraded
  indexes, and truncated responses.
- Added setup and `mcp-doctor` validation for configured client commands, cwd/repo bindings, and
  process liveness.
- Bounded diff-impact output with a summary-first profile so dirty worktrees do not flood agent
  context.
- Marked ADR 0086 implemented for the narrowed core runtime-health and output-budget contract.

## Install

```bash
npm install -g https://github.com/ontograph/ontoindex/releases/download/v1.9.11/ontoindex-1.9.11.tgz
ontoindex --version
```

After npm publication:

```bash
npx -y ontoindex@1.9.11 --version
```

## Validation

- Focused ADR 0086 unit suite passed: 8 files, 93 tests.
- Full `npm test` passed after rebuilding the optional Kotlin parser binding: 507 files, 9,176
  tests.
- `npm run build` passed.
- `git diff --check` passed.

## Artifact

- Tag: `v1.9.11`
- Package: `ontoindex-1.9.11.tgz`
- Size: 21.6 MB
- Files: 1,758
- SHA-256: `4285f2ae8fa71952ac4a7a3a459369968d39c92207b3392148f3ceddeb147ff6`
