# OntoIndex v1.9.7

Release date: 2026-06-13

## Highlights

- Fixed `gn_ensure_fresh` repo resolution for MCP and direct-runtime use. It now resolves indexed repos by registry-backed name/path matching, reads `HEAD` from the indexed repo path instead of the MCP process cwd, and correctly reports stale indexes for lowercase MCP repo ids, mixed-case registry names, and absolute repo paths.
- Fixed clean-install CI failures caused by the partial `tree-sitter@0.25` migration. Blocked grammar packages are now vendored under `ontoindex/vendor/` and pinned through `file:` dependencies so `npm ci` resolves a reproducible dependency graph without `--legacy-peer-deps`.
- Declared `docs/wiki/` as generated release output in `.prettierignore` and normalized tracked source/test formatting so the repo-root Prettier gate passes consistently in CI.

## Install

```bash
npm install -g https://github.com/ontograph/ontoindex/releases/download/v1.9.7/ontoindex-1.9.7.tgz
ontoindex --version
```

After npm publication:

```bash
npx -y ontoindex@1.9.7 --version
```

## Validation

- `npm ci` in `ontoindex` passed.
- `npm run build` in `ontoindex` passed.
- `npx tsc --noEmit` in `ontoindex` passed.
- `npx prettier --check .` at repo root passed.
- `npm test -- --run test/unit/super/ensure-fresh.test.ts` passed: 12 tests.
- `npm test -- --run test/integration/parsing.test.ts test/integration/class-impact-all-languages.test.ts` passed: 148 tests.
- Direct `/tmp` runtime reproduction of `gnEnsureFresh(...)` now returns real `indexedCommit`, `currentCommit`, and `isStale` values for lowercase repo ids, mixed-case names, and absolute paths.

## Artifact

- Tag: `v1.9.7`
- Package: `ontoindex-1.9.7.tgz`
- SHA-256: `7f63ce68d136ef704cd475ed041ccef34e6aa8ca6c126fb798338646372c16bb`

## Notes

- Tree-sitter vendor snapshots are taken from the currently working grammar packages and patched only at the package-metadata level to align peer/dependency ranges with `tree-sitter@^0.25.0`.
- Existing MCP sessions must be restarted to load the `gn_ensure_fresh` runtime fix after upgrade.
