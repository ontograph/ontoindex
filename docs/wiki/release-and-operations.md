# Release And Operations

## Package

The release package is `ontoindex` from `ontoindex/package.json`.

Current package metadata:

```text
name: ontoindex
version: 1.9.3
license: AGPL-3.0-or-later
node: >=20.0.0
repository: https://github.com/ontograph/ontoindex
```

## Build And Pack

Common release commands:

```bash
cd ontoindex
npm run build
npm pack --pack-destination ..
```

Latest local distributable:

```text
/opt/demodb/_workfolder/OntoIndex/ontoindex-1.9.3.tgz
```

## Validation Commands

CLI/core:

```bash
cd ontoindex
npx tsc --noEmit
npm run build
npm run test:unit
```

Web:

```bash
cd ontoindex-web
npx tsc -b --noEmit
npm run build
npm test
```

Root quality:

```bash
npm run lint
```

## Dependency State

The repo has been updated to current major dependency families:

- TypeScript 6
- ESLint 10
- React 19
- Vite 8
- Vitest 4
- MCP SDK 1.29
- tree-sitter 0.25 core

Tree-sitter parser packages still have uneven peer ranges, so installs may require the legacy peer resolver until the grammar ecosystem catches up.

## MCP Operations

Current self-repo MCP config should point at:

```text
ONTOINDEX_MCP_PROJECT_CWD=/opt/demodb/_workfolder/OntoIndex
ONTOINDEX_MCP_REPO=/opt/demodb/_workfolder/OntoIndex
ONTOINDEX_MAX_WORKERS=7
```

Restart the MCP client after config changes so the running process does not retain an older repository target.
