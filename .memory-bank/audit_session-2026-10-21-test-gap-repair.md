# Test-gap initialization and remediation repair

Date: 2026-10-21
Authority: User instruction to proceed with reported test-gap, provenance and docs issues

## Outcome

The public MCP `gn_test_gap` path now initializes through the existing server
repository gate and dispatches the backend-resolved canonical repository ID.
The graph operation runs inside the existing committed-generation pin and
overlay suppression context. Its report retains live filename heuristics as
heuristic evidence and the existing committed-graph warning; the response is
not labeled wholly committed-only.

The existing smoke evidence manifest now records MCP handshake name/version
alongside the launched CLI path/hash/version. Those facts remain separate;
handshake identity alone does not authenticate every loaded module.

Missing/stale/partial docs hints now suggest the registered command
`ontoindex docs sidecar run markdown`. Sidecar absence remains explicit. No
sidecar was generated and no public API or database connection owner was added.

## Decisions and review

Compared twice: reuse server initialization, initialize inside the report, or
add a graph-aware audit resolver. Reusing the server gate avoids another pool
lifecycle. Canonical dispatch avoids an absolute path becoming a different
basename pool ID. Read-only impact reported LOW with two direct callers.

A challenger rejected retaining the committed wrapper's whole-response
provenance because the report also reads live heuristic filenames. The final
implementation captures the report within that context and retains its own
evidence classifications. Regression asserts absence of a whole-response
`readContext` and no automatic analysis.

## Validation

- Final focused Vitest invocation: six files, 139 tests passed, exit 0.
- TypeScript `tsc --noEmit --incremental false`: exit 0.
- Native `npm run build`: exit 0; existing npm configuration warnings remain.
- Scoped whitespace check: exit 0.
- Read-only challenger found no remaining material concerns after correction.
- Bounded OntoIndex diff: PASS for the 11 expected files, with no unexpected
  files. Empty symbol inventory and stale index limit this to file-scope evidence.

Exact final command from `ontoindex/`:

```sh
ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/mcp-server-graph-walk-init.test.ts test/integration/committed-navigation-sdk.test.ts test/unit/committed-navigation-smoke.test.ts test/unit/docs-inline-context.test.ts test/unit/super/help.test.ts test/integration/mcp-docs-facades.test.ts && ./node_modules/.bin/tsc --noEmit --incremental false
```

Three suite invocations consumed the three-run budget. The first two returned
138 passing tests and one failing new integration test. The final correction
separates symbol/file graph expectations from semantic query coverage: this
fixture has no embeddings, so query coverage must remain unknown. Earlier
overlay attribution was a hypothesis, not established failure causality.

## Live evidence and remaining limitations

One fresh built-server process made two bounded tool calls against
`/opt/d1/_wrk/ontocode`. Evidence:
`/tmp/ontoindex-test-gap-fix-20261021/{manifest.json,responses.json}`.

- Handshake advertised `ontoindex 2.3.5-rc.8`; manifest retains CLI hash and
  independently read target HEAD.
- `gn_test_gap` with filePath
  `ontocode-rs/core/src/context/subagent_notification.rs` and maxItems 5:
  no invocation error, five resolved graph symbols, target status NEEDS-VERIFY
  with no found test evidence. Committed dirty-exclusion warning retained.
- `gn_docs` readiness: non-retryable workspace_too_large, 7001 indexed files
  versus cap 1600. The sidecar branch was not reached. Combined smoke exit 1
  reflects this blocked docs call; it is not a failing test-gap invocation.
- Server stderr also reported watcher ENOSPC. No system limits were changed;
  this does not establish causality for the separate file-count refusal.
- The process closed; no failing request was retried. Existing host-managed
  MCP servers were not restarted. The installed distribution was not replaced.

Budgets: tests 3/3, builds 1/1, fresh post-fix server launches 1/1. No reindex,
cap increase, sidecar generation, commit, push or installation occurred.

At that checkpoint WORKSPACE_RELATIONSHIP_RECOVERY_PLAN was blocked at GRAPH-1.
Current-worktree relationship navigation still requires the recorded resolution
and edge ownership design. Knowledge handoff: none; existing validation and
anti-loop rules already cover bounded failure attribution and unchanged retries.

## Critical review follow-up

Two development agents used gpt-6.1-sol at medium effort. Shared super dispatch
now owns test-gap initialization for both public routes. Docs readiness skips
graph preparation in server and backend routing; other docs actions retain
their guards. Smoke classification accepts only complete, non-retryable
workspace_too_large refusals and rejects unrelated or truncated errors.

Validation: 94 tests across six files passed; after adding readiness SDK
regressions the affected integration file passed all 16 tests. TypeScript,
native build and whitespace checks passed, exit 0. A fresh built-server smoke
made four calls against Ontocode: both test-gap routes resolved symbols with
NEEDS-VERIFY and both readiness routes returned missing-sidecar reports.
Raw responses, CLI hash, HEAD, handshake identity and stderr are retained at
/tmp/ontoindex-review-live-z1sZzu. No failing request was repeated.

GRAPH-1 completed through manager complete-local. Independent challenge added
coherent captured-input and base-generation verification before publication.
Production relationships require an ADR amendment and staged implementation;
default large-workspace navigation remains unresolved. Budgets used: tests
2/3, builds 1/1, live smoke processes 1/1. No install, push, reindex, cap increase
or sidecar generation occurred in this follow-up.
