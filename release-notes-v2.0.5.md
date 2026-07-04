# OntoIndex v2.0.5

## Highlights

- `ontoindex setup` now installs shared `ONTOINDEX.md` guidance for Claude Code, Codex, and
  Ontocode, so each client gets the same rule about honest OntoIndex use and graph-first routing
  for non-trivial indexed-repo analysis.
- Setup is idempotent: it writes the guidance file and adds a single `@ONTOINDEX.md` include only
  when the client instruction file does not already reference OntoIndex guidance.
- The install scripts and setup help output now point users to run `ontoindex setup` after
  installation or upgrades.

## Validation

- `cd ontoindex && npx vitest run test/unit/setup.test.ts test/integration/setup-skills.test.ts`
- `cd ontoindex && npx tsc --noEmit`
- `cd ontoindex && bash -n ../scripts/install-ontoindex-latest.sh`
- `cd ontoindex && npm run build`
- `cd ontoindex && npm pack --pack-destination ..`
