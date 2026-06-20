# OntoIndex v1.9.18

Release date: 2026-06-20

## Highlights

- Added an opt-in zvec-backed semantic vector backend while keeping LadybugDB as the source of
  truth and default backend.
- Added zvec mirror freshness metadata, safe synthetic vector document IDs, and bounded fallback
  diagnostics for `gn_diagnose` and retrieval diagnostics.
- Added replay-gate evidence for vector backend comparisons: at least 2x median direct vector-query
  speedup and no expected-anchor regression.
- Added ADR 0097 for the narrowed zvec integration boundary.

## Install

```bash
npm install -g https://github.com/ontograph/ontoindex/releases/download/v1.9.18/ontoindex-1.9.18.tgz
ontoindex --version
```

After npm publication:

```bash
npx -y ontoindex@1.9.18 --version
```

## Validation

- `npm run build` passed.
- Focused ADR 0097 suite passed: 6 files, 74 tests.
- `npx tsc --noEmit` passed.
- `git diff --check` passed.

## Artifact

- Tag: `v1.9.18`
- Package: `ontoindex-1.9.18.tgz`
- Size: 21.6 MB
- Files: 1,768
- SHA-256: `e68fe35b0cce9403fe83a40e932fc173ea61aeb1476aeea575ab4cc9da9694c3`
