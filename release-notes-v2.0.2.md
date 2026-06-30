# OntoIndex v2.0.2

## Fixes

- Bootstrap export artifacts now preserve the graph-diff `snapshot.json` baseline.
- `bootstrap-hydrate --force` clears stale snapshot state before replacing a local index.
- Hydrated indexes add `.ontoindex` to `.gitignore`, matching analyze/index behavior.
- Bootstrap repo targeting now supports registered names, explicit paths, git-root subdirectories, and bare relative directories.
- Hydrate now preflights registry-name collisions before writing local `.ontoindex` state, so retries with `--name` do not require cleanup.

## Validation

- `npm run build`
- `npx tsc --noEmit`
- `npm test` (full suite: one native bridge test failed once, then passed on targeted rerun)
- Focused bootstrap/runtime/status tests passed.
