# OntoIndex v1.9.8

Release date: 2026-06-14

## Highlights

- Added a compact freshness contract to high-risk MCP responses. Repo label, repo path, indexed
  commit, current head, stale state, dirty file count, and scope confidence now travel through the
  shared target-context and response-envelope path.
- Added a dirty-workspace overlay summary. OntoIndex can now distinguish clean workspaces, dirty
  tracked files, stale indexes, unknown untracked source files, and unknown states without inventing
  new graph edges.
- Made MCP guidance facade-first. `discover`, `gn_help`, and `gn_tool_contract` now identify
  recommended facade tools separately from compatibility tools while keeping existing low-level tools
  callable.
- Added explicit embedding lifecycle reporting. `analyze` and `status` now explain whether semantic
  search is off, preserved, refreshed, skipped, absent, or available.
- Added an experimental guarded file-delta analyze planner behind `--experimental-file-delta`. Safe
  cases run bounded symbols analysis; unsafe cases fall back to full analyze.
- Fixed `status --repo /path/to/repo` handling so path-like repo selectors are inspected as
  filesystem paths instead of being rejected by registry lookup.
- Updated README framing so the default workflow is clearly local-first: install, analyze, setup,
  MCP, serve, and generated wiki.

## Install

```bash
npm install -g https://github.com/ontograph/ontoindex/releases/download/v1.9.8/ontoindex-1.9.8.tgz
ontoindex --version
```

After npm publication:

```bash
npx -y ontoindex@1.9.8 --version
```

## Validation

- `npm exec vitest run test/unit/super/ensure-fresh.test.ts test/unit/target-context.test.ts test/unit/systems-audit-contracts.test.ts test/unit/super/help.test.ts test/unit/super/tool-contract.test.ts test/unit/facade-completeness.test.ts test/unit/status.test.ts test/unit/embedding-lifecycle.test.ts test/unit/run-analyze-snapshot.test.ts test/unit/cli-index-help.test.ts test/unit/experimental-file-delta.test.ts` passed: 232 tests.
- `npm exec tsc --noEmit` passed.
- `npm run build` passed.
- `git diff --check` passed.
- `npx prettier --check .` passed.
- OntoIndex refresh completed after task slices.
- `detect-changes --repo ontoindex` completed with a residual critical warning on `statusCommand` /
  repo path resolution. This release intentionally changes that path and includes expanded targeted
  status coverage.

## Artifact

- Tag: `v1.9.8`
- Package: `ontoindex-1.9.8.tgz`
- Size: 93 MB
- Files: 1,919
- SHA-256: `7b232d8367a93dbbdc64f876eea19a7218c65655395c9ba4ab25b4622e8270d9`

## Notes

- The package remains large because vendored tree-sitter grammar packages are still included for the
  reproducible `tree-sitter@0.25` install path introduced in v1.9.7.
- `--experimental-file-delta` is intentionally guarded. It does not partially recompute communities
  and does not claim full graph correctness for unsafe changes.
- Existing MCP sessions must be restarted to load the new response envelope and facade guidance.
