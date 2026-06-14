# Security Refactoring Plan

Last updated: 2026-06-14
Status: Challenged and narrowed
Owner: OntoIndex maintainers

## Purpose

Convert GitHub Security findings into a staged refactoring plan that fixes real first-party risk
without broad rewrites, false-positive churn, or replacing existing OntoIndex architecture.

Sources reviewed:

- GitHub Dependabot alerts for `ontograph/ontoindex`.
- GitHub CodeQL alerts for `ontograph/ontoindex`.
- Local package manifests and lockfiles.
- OntoIndex local CLI query for security-related code paths.

## Architecture-Fit Gate

### Gate 1: Real Security Improvement

Accepted work must reduce an observable security risk:

- vulnerable dependency no longer resolves in lockfiles;
- user-controlled request values are normalized before use;
- filesystem paths cannot escape approved roots;
- git clone inputs cannot become git options or unsafe command arguments;
- URL trust checks use parsed protocol and host, not substring checks;
- expensive regex and timer behavior is bounded;
- security behavior is covered by focused tests.

Rejected work:

- suppressing first-party CodeQL alerts without proof;
- moving to a new web framework;
- adding a separate security service;
- replacing LadybugDB, MCP, or the HTTP API;
- broad cleanup that does not close or downgrade a concrete alert.

### Gate 2: Core Extension Only

Accepted work must extend existing code paths:

- `ontoindex/src/server/api.ts`;
- `ontoindex/src/server/git-clone.ts`;
- `docker-server.mjs`;
- CLI/wiki URL parsing;
- existing sanitization helpers;
- package manifests and lockfiles;
- CodeQL configuration only for vendored/generated boundaries.

Do not introduce a second authorization model, a new request router, or a detached validation
subsystem.

## Challenge Summary

The first version of this plan was too broad. The security page contains many alerts, but they are
not all the same kind of work.

Key corrections:

1. **Do not batch all CodeQL alerts together.** The critical `api.ts` type-confusion finding and
   server path traversal findings are release-blocking; vendored grammar ReDoS is not.
2. **Do not start with generic helper abstractions.** Start at the boundary that accepts untrusted
   input, then extract helpers only after two or more call sites prove the same invariant.
3. **Do not hide first-party alerts with CodeQL exclusions.** Exclusions are acceptable only for
   vendored/generated code with written rationale.
4. **Do not rely only on `overrides` for dependency alerts.** Prefer upgrading the direct parent
   dependency where possible; use overrides only when the parent package cannot move yet.
5. **Treat dismissed/stale Dependabot alerts separately from real unresolved dependencies.** The
   local `ontoindex-web` tree resolves `axios@1.17.0`, so the open axios alert needs verification
   before code churn.

## Current Findings

### Dependabot

| Priority | Package | Location | Current local state | Target action |
| --- | --- | --- | --- | --- |
| P0 | `esbuild` | `ontoindex-web/package-lock.json` | `0.27.0` via `vite@8.0.16` | Upgrade direct parent or override to `0.28.1` |
| P1 | `esbuild` | `ontoindex/package-lock.json` | `0.28.0` via `vite` / `tsx` | Upgrade or override to `0.28.1` |
| P2 | `axios` | `ontoindex-web/package-lock.json` | local tree resolves `1.17.0` | Recheck alert; dismiss only with evidence if stale |
| P3 | `joi` | `ontoindex-web/package-lock.json` | local tree resolves `18.2.1`; alert auto-dismissed | No work unless alert reopens |

### CodeQL Alert Groups

| Priority | Area | Main files | Alert class | Decision |
| --- | --- | --- | --- | --- |
| P0 | HTTP API request boundary | `ontoindex/src/server/api.ts` | type confusion, path injection, regex injection, missing rate limits | Fix first |
| P0 | Server path access | `api.ts`, `git-clone.ts`, `docker-server.mjs` | path injection | Fix with boundary-specific safe path helpers |
| P1 | Git clone/import | `ontoindex/src/server/git-clone.ts` | command-line injection, path injection, ReDoS | Fix after path helper exists |
| P1 | URL trust checks | `ontoindex/src/cli/wiki.ts`, `ontoindex/src/core/wiki/llm-client.ts` | incomplete URL substring validation | Fix parsed-host fallback paths |
| P2 | Sanitization helpers | setup, Cypher, LadybugDB, ADR generator | incomplete sanitization | Fix per helper with tests |
| P2 | Regex/parser behavior | COBOL, query rewrite, PR marker scan, Vue SFC extractor | ReDoS or weak tag filters | Fix with caps or linear parsing |
| P3 | Dynamic dispatch | MCP local backend, analyze jobs | unvalidated dynamic method calls | Fix with typed action maps |
| P3 | Vendored upstream code | `ontoindex/vendor/tree-sitter-swift/grammar.js` | ReDoS in vendored grammar | Triage separately; likely vendor policy |

## Workstreams

### S1. Dependency Lockfile Remediation

Priority: P0

Plan:

- Update `ontoindex-web` so `esbuild` resolves to `0.28.1` or newer.
- Update `ontoindex` so `esbuild` resolves to `0.28.1` or newer.
- Prefer direct package upgrades before `overrides`.
- Use `overrides` only if `vite` / `tsx` cannot move safely.
- Verify `axios@1.17.0` and `joi@18.2.1`; do not modify them unless alerts remain valid.

Acceptance:

- `cd ontoindex && npm ls esbuild` shows `0.28.1` or newer.
- `cd ontoindex-web && npm ls esbuild axios joi` shows non-vulnerable versions.
- Lockfiles are updated.
- Dependabot alerts are closed or have evidence-backed dismissal notes.

Validation:

- `cd ontoindex && npm ci && npm exec tsc --noEmit`.
- `cd ontoindex-web && npm ci && npm test`.

### S2. HTTP API Boundary Normalization

Priority: P0

Problem:

- `api.ts` currently accepts request parameters in several shapes and only sometimes narrows them
  before use.

Plan:

- Add local request-normalization helpers in the server API layer:
  - required string;
  - optional string;
  - bounded integer;
  - boolean flag;
  - enum value.
- Reject arrays and objects for scalar parameters.
- Apply the helpers before path, regex, file read, or database query use.
- Keep valid request behavior stable.

Acceptance:

- The CodeQL type-confusion alert in `api.ts` is resolved.
- Tests cover string, array, object, missing, and malformed request inputs.
- The implementation does not add a second router or authorization layer.

Validation:

- `cd ontoindex && npm test -- --run test/unit/api-guards.test.ts`.
- `cd ontoindex && npm exec tsc --noEmit`.

### S3. Server Safe Path Resolution

Priority: P0

Problem:

- Multiple server paths are derived from user-controlled request data or registry values.

Plan:

- Add a small safe-path helper close to server code.
- Require an explicit allowed root for each path operation.
- Decode and normalize once.
- Reject:
  - `..` traversal;
  - absolute external paths;
  - encoded traversal;
  - Windows separator bypasses;
  - paths escaping after `realpath` when the target exists.
- Apply first to `api.ts`; then to `git-clone.ts` and `docker-server.mjs`.

Acceptance:

- First-party path-injection alerts are fixed or reduced with proof.
- Tests cover allowed in-root paths and traversal variants.
- Error responses are structured and do not leak host paths unnecessarily.

Validation:

- API guard tests.
- Git-clone tests.
- Docker server path tests or new focused tests.

### S4. Git Clone Input and Argument Hardening

Priority: P1

Problem:

- CodeQL reports that user-provided clone inputs can influence git command arguments.

Plan:

- Validate repository URLs with `new URL()`.
- Allow only approved protocols.
- Reject values that begin with `-` or contain known unsafe git option forms.
- Explicitly reject `--upload-pack`.
- Keep clone destinations under the approved clone root.
- Use positional arguments safely; do not concatenate shell commands.

Acceptance:

- CodeQL command-line injection alerts in `git-clone.ts` are resolved.
- Tests cover malicious option-like payloads, unsafe protocols, traversal names, and safe URLs.

Validation:

- Focused `git-clone` tests.
- `cd ontoindex && npm exec tsc --noEmit`.

### S5. Parsed URL Host Validation

Priority: P1

Problem:

- Some URL trust checks still rely on substring behavior or fallback substring behavior.

Plan:

- Introduce or reuse parsed URL helpers:
  - protocol allow list;
  - exact hostname match;
  - suffix match only with dot boundary;
  - normalized lowercase host.
- Apply to:
  - gist URL parsing in `ontoindex/src/cli/wiki.ts`;
  - Azure endpoint detection fallback paths in `ontoindex/src/core/wiki/llm-client.ts`.
- Preserve existing valid Azure and gist examples.

Acceptance:

- Hosts like `gist.github.com.evil.test` and `evil.test/path/gist.github.com` are rejected.
- Valid `gist.github.com` and Azure endpoints still work.
- CodeQL URL substring alerts are resolved or reduced.

Validation:

- Wiki CLI tests.
- LLM client tests.

### S6. Targeted Sanitization Helpers

Priority: P2

Problem:

- CodeQL reports incomplete escaping in several unrelated output formats.

Plan:

- Fix each format with the smallest correct helper:
  - markdown table cell escaping;
  - Cypher string escaping;
  - generated config/template escaping;
  - regex literal escaping.
- Do not create one universal sanitizer.
- Add tests for backslash, pipe, newline, quote, and delimiter payloads.

Acceptance:

- Incomplete-sanitization alerts are resolved.
- Each helper documents its target format.

Validation:

- Focused helper tests.
- Existing setup/Cypher/LadybugDB tests.

### S7. Regex and Parser Hardening

Priority: P2

Plan:

- Replace vulnerable regexes with linear scans where practical.
- Add input length caps before regex parsing when replacement is not practical.
- Prefer case-insensitive exact tag parsing over partial tag filters.
- Keep vendored grammar alerts out of this workstream unless runtime reachability is proven.

Acceptance:

- First-party ReDoS and weak tag-filter alerts are reduced.
- Tests include large adversarial strings.

Validation:

- Parser/extractor tests.
- CodeQL rerun.

### S8. Rate Limiting for Heavy Server Routes

Priority: P2

Plan:

- Add lightweight in-process rate limiting around:
  - auth-sensitive routes;
  - filesystem-heavy routes;
  - clone/import routes.
- Keep defaults local-development friendly.
- Make limits configurable by environment variables.

Acceptance:

- Missing-rate-limiting alerts are resolved.
- Tests cover allowed requests, exceeded limits, and reset behavior.

Validation:

- API guard tests.

### S9. Dynamic Dispatch Allow Lists

Priority: P3

Plan:

- Replace user-controlled method lookup with explicit typed action maps.
- Reject unknown actions with structured errors.
- Keep existing public action names.

Acceptance:

- Dynamic dispatch alerts are resolved.
- Tests cover allowed and unknown actions.

Validation:

- MCP local backend tests.
- Analyze-job tests.

### S10. Vendored and Generated Code Policy

Priority: P3

Plan:

- Keep first-party code scanned.
- Treat `ontoindex/vendor/**` as vendored code.
- Exclude or dismiss vendored alerts only with written rationale and upstream tracking.
- Do not use this policy to hide first-party findings.

Acceptance:

- Vendored alerts are separated from first-party alerts.
- Security dashboard no longer mixes upstream grammar findings with OntoIndex-owned code.

Validation:

- CodeQL rerun.
- Dismissal notes or CodeQL config change reviewed by maintainers.

## Delivery Order

1. S1 Dependency Lockfile Remediation.
2. S2 HTTP API Boundary Normalization.
3. S3 Server Safe Path Resolution.
4. S4 Git Clone Input and Argument Hardening.
5. S5 Parsed URL Host Validation.
6. S6 Targeted Sanitization Helpers.
7. S8 Rate Limiting for Heavy Server Routes.
8. S7 Regex and Parser Hardening.
9. S9 Dynamic Dispatch Allow Lists.
10. S10 Vendored and Generated Code Policy.

## Tracking

Tracking rule: update this table before starting each task.

| Task | Status | Owner | Validation |
| --- | --- | --- | --- |
| S1 Dependency Lockfile Remediation | Pending | unassigned | Pending |
| S2 HTTP API Boundary Normalization | Pending | unassigned | Pending |
| S3 Server Safe Path Resolution | Pending | unassigned | Pending |
| S4 Git Clone Input and Argument Hardening | Pending | unassigned | Pending |
| S5 Parsed URL Host Validation | Pending | unassigned | Pending |
| S6 Targeted Sanitization Helpers | Pending | unassigned | Pending |
| S7 Regex and Parser Hardening | Pending | unassigned | Pending |
| S8 Rate Limiting for Heavy Server Routes | Pending | unassigned | Pending |
| S9 Dynamic Dispatch Allow Lists | Pending | unassigned | Pending |
| S10 Vendored and Generated Code Policy | Pending | unassigned | Pending |

## Done Criteria

- Open Dependabot alerts are closed or dismissed with evidence.
- No untriaged critical/high first-party CodeQL alerts remain.
- Vendored/generated alerts are separated from first-party findings.
- Security-sensitive helpers have focused tests.
- `npm exec tsc --noEmit` passes in touched packages.
- Relevant package tests pass.
- GitHub Security page reflects the intended alert state after rerun.
