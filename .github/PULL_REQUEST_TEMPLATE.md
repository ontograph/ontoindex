## Summary

<!-- One or two sentences: what does this PR change? -->

## Motivation / context

<!-- Why is this change needed? Link issues, ADRs, or prior discussion. -->

## Areas touched

<!-- Check all that apply -->

- [ ] `ontoindex/` (CLI / core / MCP server)
- [ ] `ontoindex-web/` (Vite / React UI)
- [ ] `.github/` (workflows, actions)
- [ ] `eval/` or other tooling
- [ ] Docs / agent config only (`AGENTS.md`, `CLAUDE.md`, `.cursor/`, `llms.txt`, etc.)

## Scope & constraints

**In scope**

- <!-- bullets -->

**Explicitly out of scope / not done here**

- <!-- bullets — prevents reviewers assuming missing work is an oversight -->

## Implementation notes

<!-- Optional: design choices, tradeoffs, follow-ups -->

## Testing & verification

<!-- What you ran; paste commands. Omit sections that do not apply. -->

- [ ] `cd ontoindex && npm test`
- [ ] `cd ontoindex && npm run test:integration` *(if core/indexing/MCP paths changed)*
- [ ] `cd ontoindex && npx tsc --noEmit`
- [ ] `cd ontoindex-web && npm test` *(if web changed)*
- [ ] `cd ontoindex-web && npx tsc -b --noEmit` *(if web changed)*
- [ ] Manual / Playwright E2E *(note environment — see `ontoindex-web/e2e/`)*

## Risk & rollout

<!-- Breaking changes, migrations, index refresh (`npx ontoindex analyze`), release notes -->

## Checklist

- [ ] PR body meets repo minimum length (workflow may label short descriptions)
- [ ] If `AGENTS.md` / overlays changed: headers, scope block, and changelog updated per project conventions
- [ ] No secrets, tokens, or machine-specific paths committed
