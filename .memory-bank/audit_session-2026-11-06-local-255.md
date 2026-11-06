# OntoIndex 2.5.5 local delivery

Date: 2026-11-06
Authority: user-approved qualification, version bump, commit/push and local installation.
Product commit: `d2a42692679994de23c6efa59d55149f2a1c8e77`.
Merge: `0ec233fa624e29ebb5c5b7ae4022801b78037c10` (PR #216).
Validated staged tree: `29f5dadce9a3efc85276ed148b255964685e6e50`.

## Validation

- `scripts/verify-release.sh` passed the native build, 13,324 unit tests and
  3,050 integration tests (exit 0). Unit: 1 expected failure, 70 skipped;
  integration: 236 skipped. The run used two workers, the existing external
  Ladybug extension cache, and `ONTOINDEX_SKIP_EXT_FETCH=1`.
- Pre-commit lint, formatting, production type checking and strict test type
  checking passed. OntoIndex explicit file-scope verification passed.
- A separate verbose unit run passed with identical totals. Earlier gate
  attempts were interrupted (exit 130), not passing evidence. Quiet default
  reporting was initially mistaken for lack of progress; the completed gate
  took about 10 minutes for units and 19 minutes for integrations.
- Local installer, native dependency smoke and CLI version check passed.
  A new MCP process reported version 2.5.5 and all eight public tools;
  installed CLI context lookup found `isNameShadowed`.

## Installation and limits

CLI, both MCP configurations and the refresh helper select
`~/.local/opt/ontoindex-2.5.5`; configuration backups end in `.bak-ontoindex-255`.
No public release was created. GitHub checks were absent after `[skip ci]`;
validation evidence is local.

2.5.3 and 2.5.4 remain because live processes use them. No installation was
removed; recovered space is zero. Stop-before-upgrade remains required for
pre-2.2.9 readers, which do not create pins.

Root `npm ci --ignore-scripts --no-audit --no-fund` restored locked packages.
One existing lock inconsistency remains: `fast-levenshtein` says 2.0.7 but its
archive and integrity identify 2.0.6; the registry has no 2.0.7 version.

Pinned TypeScript Language Server 6.0.3 and TypeScript 6.0.3 were installed in
`~/.local/opt/ontoindex-language-tools`. Initialize/shutdown and a two-reference
TypeScript fixture passed. This does not establish full repository LSP coverage.
Browser, web, Python and coverage qualification were not rerun for this delivery.
