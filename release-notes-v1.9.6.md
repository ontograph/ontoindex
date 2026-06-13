# OntoIndex v1.9.6

Release date: 2026-06-13

## Highlights

- Fixed CLI multi-repo ergonomics so direct `query`, `context`, `impact`, and related commands prefer the indexed repository under the current working directory.
- Added `status --repo <name-or-path>` so agents can verify a target repository without relying on process cwd.
- Fixed MCP `discover({action: "tools"})` to return the callable MCP frontier by default; pass `codebase: true` to inspect tools discovered inside the indexed repository graph.
- Fixed symbol impact/context lookup for displayed owner-qualified names such as `ThreadManager.validate_environment_selections`.
- Updated generated agent guidance to use current MCP frontier calls: `search`, `inspect`, `impact`, and `gn_verify_diff`.

## Install

```bash
npm install -g https://github.com/ontograph/ontoindex/releases/download/v1.9.6/ontoindex-1.9.6.tgz
ontoindex --version
```

After npm publication:

```bash
npx -y ontoindex@1.9.6 --version
```

## Validation

- `npm run build` in `ontoindex` passed.
- `npx tsc --noEmit` in `ontoindex` passed.
- `npm test -- --run test/unit/tool-direct-cli.test.ts test/unit/calltool-dispatch.test.ts test/integration/mcp-facades.test.ts` passed: 3 files, 106 tests.
- Live CLI validation from `/opt/demodb/_workfolder/ontocode` passed for `status --repo codex`, cwd-inferred `query`, and owner-qualified `impact` targets.

## Artifact

- Tag: `v1.9.6`
- Package: `ontoindex-1.9.6.tgz`
- SHA-256: `5c9cdf167357eb0fbc1fa7b6c2a37b697d6fe523f07e119742c2a30264e57db1`

## Notes

- Existing MCP sessions must be restarted to load this release; already-running MCP servers continue using their old `dist` code.
- `missing-store` enrichment status means optional docs/enrichment sidecar data is absent; it does not mean the graph index is incomplete.
