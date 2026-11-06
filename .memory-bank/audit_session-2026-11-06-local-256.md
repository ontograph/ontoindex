# OntoIndex 2.5.6 local delivery

Date: 2026-11-06
Authority: user requested version bump, commit all to main, build and local install.
Product commit: `2d429bb1ec9c5b83e73b3744d147929a365e615e`, pushed to origin/main.
Validated staged tree: `a87f814732416f2fba0d58855ccf9a1c2cb1a9e7`.

## Validation

- Native Linux build and scripts/verify-release.sh passed, exit 0 (session 28225).
  Unit: 13,387 passed, 1 expected failure, 70 skipped. Integration: 3,050
  passed, 236 skipped. Used two test workers and CARGO_BUILD_JOBS=4.
- Precommit lint, formatting, production and test typechecks passed. Bounded
  OntoIndex file-scope verification passed; it does not execute tests.
- npm pack --ignore-scripts passed. Tarball SHA-256:
  `828996386ce6fc97ed17782f288ba5d48c2795b7518e63c20e7a2c7e6ed0863d`.
- Versioned installer passed (session 30189). npm 11 skipped lifecycle scripts
  under its allow-scripts policy. Required patch/native setup was run explicitly.
  First native attempt lacked node-gyp; retry with npm's bundled node-gyp through
  npm_config_node_gyp passed (session 3009). No global npm policy was changed.
- Installed CLI reports 2.5.6. Fresh MCP handshake reports 2.5.6 and all eight
  public facades; shutdown completed cleanly. No public release or tag created.

## Installation

CLI, ~/.ontocode/config.toml, ~/.codex/config.toml and refresh helper select
~/.local/opt/ontoindex-2.5.6. Configuration backups end in .bak-ontoindex-256.
Live MCP processes still use 2.5.3, 2.5.4 and 2.5.5, so these copies are retained.
No obsolete installation was safely removable; recovered installation space: zero.
Restart existing sessions to use the new MCP executable.

Only main was pushed; master was left unchanged. Browser/web/Python/coverage
qualification was not run for this delivery. Temporary packaging files were
removed after installation and smoke verification.
