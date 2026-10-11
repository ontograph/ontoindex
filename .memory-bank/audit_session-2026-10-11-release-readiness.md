# Release readiness audit

Date: 2026-10-11
Candidate: `chore/release-readiness`; overlay corrections committed in `632ace1`.

## Implemented

- Stable and candidate workflows pack once, smoke-test an installed tarball,
  and publish that same tarball.
- Candidate publication reconciliation rejects a mismatched npm SHA512 integrity.
- Cached Ladybug FTS/vector extensions are checked against pinned SHA256 hashes,
  including offline builds.
- CI includes cross-process overlay regression coverage and explicit PR permissions.
- Unreleased changelog records real-time overlay and release-hardening changes.

## Validation evidence

- Focused Vitest run after the implementation commit: 5 files, 45 tests passed
  in 29.27 seconds. Coverage: release workflow, extension fetching, MCP doctor,
  watcher save patterns, and cross-process overlay visibility.
- Earlier full unit log: 472 passing files, 7118 passing tests, one expected
  failure, 65 skipped tests, and one failing workflow assertion. The corrected
  assertion passes in the focused run; the full suite has not been rerun.
- Build, packed CLI startup/help smoke, formatting, typecheck, and lint were
  reported successful by the preceding task segment. Lint reported 4634 warnings;
  these results are inherited evidence, not freshly rerun checks.
- CI run `38114259149` passed for `3f14dbc`, including Linux, macOS, Windows,
  coverage, formatting, lint and typechecks. Browser E2E was skipped.
- Coordinator refreshed OntoIndex to `3f14dbc`; no embeddings are present.
  Context and impact inspection identified the shared overlay read owners.
- Overlay corrections filter symbol rows to snapshot-covered paths and propagate
  unavailable-store errors so callers preserve their base-result fallback.
- After formatting, focused Vitest validation passed: 4 files, 39 tests
  (`overlay-symbol-resolution`, `backend-overlay`, `overlay-query-merge`,
  `overlay-context-impact`). `npx tsc --noEmit` and `git diff --check` passed.
- The preceding segment reported installed-tarball CLI version, fixture analysis
  and MCP discovery of 62 tools passing. This is inherited runtime evidence;
  actual MCP symbol-query behavior remains unverified.

## Review findings

- Four read-only agents on `gpt-6.1-sol` and `gpt-6-luna` reviewed release
  identity, dependency security, overlay resolution and watcher/runtime behavior.
- The two overlay defects above have focused corrections and regression tests.
- Watcher lock recovery now retains one delayed retry and routes dirty startup
  through the same serialized refresh queue. Saves during the startup child
  retain a follow-up; stopping during a lock check prevents timer resurrection.
  Focused watcher validation passed: 3 files, 36 tests; TypeScript and
  `git diff --check` passed. Independent source review found no correctness bug.
- Fresh lockfile-only audits reported 11 production affected packages in the CLI
  and 8 in the web workspace. Counts are affected packages, not unique advisories
  or exploitability proof. CLI findings include `proxy-addr`, `tar`, MCP SDK,
  `ip-address`, `js-yaml` and `hono`; `adm-zip` is dev-only. Dependency remediation
  and final installed-artifact reachability remain release gates.
- Coordinator refreshed OntoIndex to `632ace1`; watcher impact was LOW. The
  precommit change scan covered only the watcher and its two test files:
  3 files, 9 symbols, zero affected flows. Uncommitted source is checked directly.
- Four additional read-only reviewers on the required two models checked watcher
  recovery, candidate lockfiles, distribution identity and artifact smoke coverage.
- Targeted CLI lockfile updates within existing manifest ranges clear the
  production-only audit: zero affected packages. Installed updated dependencies
  without lifecycle scripts; focused MCP/server validation passed 6 files,
  33 tests, followed by TypeScript checking. Independent metadata review confirmed
  SDK compatibility with its allowed Hono adapter range and supported Node engines.
  Full CLI audit still reports five development-only affected packages.
  Audit zero does not prove absence of vulnerabilities.
- Targeted web lockfile updates passed all 15 test files / 278 tests and the
  production build. Production audit now reports two low affected-package entries
  in the KaTeX/Mermaid chain (`GHSA-238p-pmpm-9mq7`). Mermaid's declared KaTeX
  range excludes the patched 0.18.2 version. Compared retaining a documented
  release gate, overriding the incompatible range, and downgrading Mermaid;
  retain the gate pending explicit risk acceptance or an upstream-compatible fix.
  Build reports browser externalization and chunk-size warnings; no browser smoke
  was executed. Audit claims here use coordinator evidence; the reviewer's final
  zero-production claim refers to the CLI audit, not the web audit.
- Existing installed-artifact workflow checks cover version/help, not MCP symbol
  queries. The existing Kimi smoke harness can target the installed CLI, but its
  MCP-only mode deliberately exits 2; acceptance must check recorded preflight
  evidence rather than interpreting that exit as overall success.
- Compared distribution options: GitHub-only, unified npm/GitHub, and independent
  channels. Prefer GitHub-only to match the latest release, pending maintainer
  confirmation; do not activate npm/container publication implicitly.

## Remaining release gates

- Review the entire integration branch, which includes the real-time overlay
  implementation stack in addition to release hardening.
- Obtain passing CI on the final corrected candidate. Run `38116462283` for
  `4744f4d` failed: Express 5 rejected the redundant unnamed wildcard route;
  eight overlay generation assertions expected the superseded empty-result contract.
  The HTTP handler is removed and the assertions now require fail-closed rejection.
  A real Express/CORS startup regression checks allowed and denied PNA preflight
  and protected API authentication. Independent review informed cleanup and
  denied-origin coverage. Final focused validation passed 4 files / 36 tests
  in 19.02 seconds; TypeScript passed; lint had zero errors and eight warnings.
  Formatting and `git diff --check` passed. OntoIndex at `4744f4d` reported LOW
  impact for `createServer`; change detection returned no symbols for these hunks,
  so direct source/diff inspection supplies changed-scope evidence.
- Reconcile package version `2.1.5` with latest GitHub release tag
  `github-release/2.2.1` and registry state before selecting a release version.
- Resolve production dependency-security findings and obtain final watcher CI.
- Confirm GitHub-only versus npm/container distribution before version changes.
  A merge to master can trigger RC npm/container publication; merge approval must
  explicitly account for that workflow, not assume preparation is publication-free.
- Validate the final versioned artifact, including actual MCP symbol queries.
- Obtain explicit merge/publication approval. No release was published by this task.

Authenticated real-time task statuses remain unchanged.

## Authenticated browser validation correction

- Candidate `f58693b` passed Linux, macOS, Windows, coverage, lint, formatting,
  and type checks. Run `38117325691` failed browser readiness: the server started,
  but the workflow probed protected `/api/repos` without bearer authentication.
  Browser tests did not execute.
- Four independent reviewers compared authenticated readiness, public-only
  readiness, and disabling authentication. The selected correction keeps
  production authentication unchanged: CI creates one masked ephemeral token,
  probes public GET readiness, and checks authenticated nonempty repositories.
  A shared fixture seeds frontend session storage; backend-only requests use
  scoped bearer headers, reject redirects, and fail on unauthorized responses.
- Final focused validation: two files / 35 tests passed; web typechecking and
  scoped ESLint passed. Playwright discovered 28 tests across five files;
  discovery is not browser execution evidence. New regressions cover missing
  credentials, unauthorized responses, origin scoping, and redirect refusal.
- OntoIndex refreshed to `f58693b`; token-owner impact was LOW. The precommit
  unstaged scan reported six files, three symbols, no affected flows, LOW risk.
  Untracked fixture files require direct source review and staged verification.
- Prior-segment installed-tarball smoke at `f58693b` reported successful MCP
  inspection of `releaseSmokeSymbol` in an isolated fixture (two nodes, one edge).
  Package version: `2.1.5`; SHA256:
  `286b1525dac55b576f91b2784fc28ffabb56782030245cd3d6189bb63b00c0d8`.
  This evidence predates the browser-harness correction and version selection.
- Remaining gates: corrected-candidate browser CI, KaTeX/Mermaid advisory
  resolution or explicit risk acceptance, version/channel selection, final
  versioned artifact validation, and explicit merge/publication approval.

Knowledge handoff: none; existing build and manager rules already require
validation for final inputs and distinguish prior CI from candidate evidence.

## Database alias release correction

- Shared initialization resolves contained regular-file aliases without deleting
  them and tracks requested aliases for path-specific closure.
- Regression coverage verifies stored rows survive alias opening and canonical
  reopening, and dangling or escaping aliases are rejected without deletion.
- Final focused validation passed three files / 36 tests: result cleanup,
  API graph streaming, and overlay generations. TypeScript, Prettier, and diff
  checks passed; scoped ESLint reported zero errors and eight warnings.
- Four independent reviewers on gpt-6-luna and gpt-6.1-sol found no concrete
  blocker. Browser execution and final installed-artifact proof remain pending.
- OntoIndex was commit-current at 4af8808 but impact stopped at dirty paths;
  source inspection is authoritative. Change detection reported three files,
  15 symbols, two affected flows, and medium risk.
- Version/channel selection, dependency advisory disposition, exact-candidate
  CI, final artifact verification, and merge/publication approval remain gates.
  No version bump, merge, tag, or publication was performed.

## Graph export schema correction

- Exact-candidate CI at `6d7d1d6` passed Linux, macOS, Windows, coverage,
  lint, formatting and typechecks. Chromium passed 27 tests and failed the
  Windows-path test. Its trace reports a native binder error for `n.startLine`.
- Concept and SummaryNode lack line/content columns. The shared export query
  now projects their declared fields, preserving both tables rather than
  swallowing binder errors or adding unnecessary schema migrations.
- Compared schema-aware projection, schema migration and skipping failed
  tables. A second review rejects migration complexity and silent data loss;
  projection covers both streaming and full exports without changing storage.
- Native-schema regression exercises every node table with and without content
  and verifies retained concept/summary rows. Two files / 22 tests passed;
  TypeScript, scoped ESLint, formatting and diff checks passed.
- OntoIndex refreshed to `6d7d1d6`; shared-owner impact was HIGH (eight upstream
  nodes). Precommit scan reports one file / one symbol; the new test additionally
  requires direct source review because it is untracked in that scan.
- Installed tarball smoke at `6d7d1d6` passed version/help and an actual MCP
  `createMCPServer` query against the existing repository index. SHA256:
  `21f411e65b6d366eafb703b6f40a62a10d2361af081f417a368563d2701619b3`.
  Disposable staging was removed. This proof predates the export correction
  and does not establish isolated-fixture or final-version artifact readiness.
- Four bounded Luna/Sol reviews were harvested and closed; review limitations
  do not replace coordinator runtime evidence. Corrected-candidate CI, final
  artifact validation, advisory disposition, version/channel selection and
  explicit merge/publication approval remain gates.

## Corrected candidate validation

- Candidate `80009cb9811b7c2d696c5bff91b45c9bc8d3fc75` passed CI run
  `38123010377`: Linux, macOS, Windows, coverage, Chromium, formatting,
  lint and both typechecks. Benchmark, OntoIndex Check and CodeQL passed;
  the failed-log query returned no failures.
- Four additional bounded reviews on gpt-6-luna and gpt-6.1-sol found no
  projection or regression-test blocker and confirmed the release gates.
- Fresh installed `ontoindex@2.1.5` passed version/help and public MCP
  inspection against the repository index and an isolated TypeScript fixture.
  The installed CLI indexed the fixture with two nodes and one edge; MCP
  returned `found` for `releaseSmokeSymbol`. Tarball SHA256:
  `c7df58572ad7c0fd7470d5f4f52d70a09fa3b9a0d09d36ea62cf18adafc4ed1a`.
  Owned staging directories were removed and absence verified.
- The first isolated harness attempt omitted `ONTOINDEX_HOME` from the SDK
  child environment and failed repository discovery. Explicit environment
  inheritance corrected the harness; no product change was required.
- Fresh production audits reported zero CLI findings and two low web findings
  via KaTeX/Mermaid (`GHSA-238p-pmpm-9mq7`). Mermaid 12.1.0 still declares
  KaTeX `^0.16.47`, excluding patched 0.18.2; a Mermaid upgrade alone does not
  establish remediation. No incompatible override or downgrade was applied.
- The public npm registry returned E404 for `ontoindex`. The RC workflow
  handles E404 by using package version 2.1.5 as its floor; latest GitHub
  release is `github-release/2.2.1`, while Release Please records 1.9.8.
  Release version and channel require reconciliation before publication.
- Remaining gates: version/channel selection, advisory remediation or explicit
  risk acceptance, affected artifact revalidation after source/version changes,
  and explicit merge/publication approval. Master merge can publish npm RC,
  GitHub prerelease and GHCR images automatically. No merge, tag, version bump
  or publication was performed.

Knowledge handoff: none; existing validation rules already require exact-input
evidence and distinguish harness failures from product failures.
