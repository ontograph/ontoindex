# ADR 0091: GitNexus-Inspired PR Readiness Pack

**Status:** Proposed - Challenged And Narrowed
**Date:** 2026-06-17
**Source:** `./tmp/GitNexus` donor review, challenged with OntoIndex MCP against current
`runAuditReport`, `gnDiffImpact`, `gnDiagnose`, `mcp-doctor`, and wiki surfaces.

## Context

The GitNexus donor is largely an ancestor or close sibling of OntoIndex. Most ideas are already
implemented, renamed, or intentionally rejected:

- graph search, context, impact, docs, wiki, MCP setup, diagnose, and audit surfaces already exist;
- ADR 0086 owns runtime freshness and output budgets;
- ADR 0088 owns agent-ready symbol ergonomics;
- ADR 0089 owns indexing lifecycle and file-scope explainability;
- ADR 0090 owns guarded response metadata and one task context pack.

The useful donor lesson is not another tool family. It is that PR review work needs one compact
readiness pack that combines facts OntoIndex already knows but currently exposes through several
separate calls.

Release readiness is related, but it is not the first slice. It touches package publishing, artifact
state, and CI policy, so it should wait until the PR pack proves the compact profile shape is useful.

## Review and Challenge

Architecture-fit gate:

1. **Real new functionality gate:** pass only for cross-surface readiness packs that combine existing
   graph, diff, docs, runtime, and local git facts into one bounded result. Reject individual tools
   that duplicate existing `gn_diagnose`, `gn_diff_impact`, `gn_review_diff`, `audit`, docs, or wiki
   functions.
2. **Core-extension gate:** pass only when implemented through existing doctor, diagnose,
   diff-impact, review-diff, audit-report, docs, and wiki owners. Reject a new swarm runtime,
   separate PR-review framework, external CI service, or new storage model.

Challenge findings:

1. **Do not add 300 MCP tools.**
   The donor review produced many names, but OntoIndex should expose fewer, denser reports.
2. **Do not recreate reviewer personas as tools.**
   Reviewer personas are prompt packaging. OntoIndex should produce facts: branch hygiene, risk,
   tests, docs, security-sensitive paths, and synthesis warnings.
3. **Do not duplicate CI providers.**
   First implementation must consume local git state only. GitHub CLI or provider data belongs in a
   later explicit integration.
4. **Do not turn release automation into publish automation.**
   Release readiness is deferred. Any future release report may recommend commands, but must not
   publish, tag, or push.
5. **Do not add new wiki generation behavior.**
   Readiness may check generated wiki state. It must not regenerate wiki during the report.
6. **Do not ship PR and release readiness in one implementation slice.**
   A shared readiness abstraction before two real consumers is premature. Start with the PR pack and
   promote shared helpers only after release readiness is approved separately.

## Decision

Approve one native capability:

**A compact PR readiness pack built from existing OntoIndex diff, review, docs, and test-gap facts.**

Approved first scope:

1. `pr-pack` profile on the existing diff/review path;
2. local readiness verdict and stop conditions inside that profile;
3. optional docs/wiki/test-gap facts when already available and cheap;
4. bounded next-command suggestions.

Not approved:

- first-slice `release-pack` or `mcp-doctor` release rendering;
- new reviewer-swarm MCP tool family;
- autonomous PR comment posting;
- tag/release/publish execution;
- external CI database;
- persona prompt registry;
- new graph storage.

## What Is New

### 1. PR Readiness Pack

Extend the existing diff/review family with an opt-in compact PR profile:

```ts
gn_diff_impact({ repo: "ontoindex", scope: "branch", profile: "pr-pack" })
```

The bounded report should include:

- changed files and changed symbols summary;
- graph blast-radius highlights;
- test-gap summary from the existing test-gap helper;
- docs/ADR impact summary from existing docs evidence;
- cheap security-sensitive path hints, for example workflows, scripts, auth, crypto, secrets, or
  dependency manifests;
- local branch hygiene facts when cheap to compute;
- exact next validation commands.

This reuses `gn_diff_impact`, `gn_review_diff`, `gn_test_gap`, docs evidence, and existing git helpers.
It is a report, not a reviewer-agent swarm.

### 2. Local Readiness Verdict

Add a small verdict shape for the PR pack:

```ts
type ReadinessVerdict = "READY" | "REVIEW" | "BLOCKED";

type ReadinessStopCondition = {
  severity: "INFO" | "WARN" | "ERROR";
  reason: string;
  fix?: string;
};
```

Keep this local to the diff/review helper for the first implementation. Promote it to a shared helper
only if a later release-readiness slice becomes a second real consumer.

### 3. Existing Wiki And Docs Reuse

The PR pack may include docs/wiki facts only when already present:

- generated wiki freshness;
- ADRs affected by changed files;
- docs drift warnings from existing docs tooling.

No wiki generation or external docs fetch happens inside the pack.

## Integration Points

| Need                  | Existing owner to extend                                          |
| --------------------- | ----------------------------------------------------------------- |
| PR diff facts         | `ontoindex/src/mcp/super/diff-impact.ts`, review helpers          |
| test gaps             | `ontoindex/src/mcp/super/write-through-verification.ts`           |
| docs evidence         | `ontoindex/src/mcp/super/docs-evidence.ts`, `gn_docs`             |
| audit rollup          | `ontoindex/src/mcp/local/backend-audit-report.ts`                 |
| wiki freshness        | `ontoindex/src/core/wiki/` metadata readers                       |
| local git facts       | existing git/diff helpers used by diff-impact and review-diff     |
| bounded output shape  | existing response-envelope/review contract helpers                |

## Implementation Slices

1. Add `profile: "pr-pack"` to `gn_diff_impact` using already-collected diff and impact facts.
2. Add a local `ReadinessVerdict` and stop-condition shape inside the PR-pack implementation.
3. Add test-gap and docs/ADR summary fields to `pr-pack` only when existing helpers can provide them
   cheaply.
4. Add cheap local branch hygiene and security-sensitive path hints without network calls.
5. Add exact next validation commands based on changed surfaces.
6. Add focused tests for bounded output, verdict escalation, default compatibility, and no network or
   publish/tag side effects.

## Acceptance Criteria

- Default diagnose and diff-impact responses remain backward compatible.
- `pr-pack` returns a bounded summary with exact next commands.
- `pr-pack` does not run publish, tag, push, wiki generation, or CI/GitHub network calls.
- Tests cover verdict escalation and stop conditions.
- The implementation reuses existing diff, review, docs, test-gap, and audit helpers.
- Release readiness remains deferred unless a later ADR or revision proves a second consumer is needed.

## Deferred

- Release readiness profile on `gn_diagnose`.
- Release-pack summary rendering in `mcp-doctor`.
- Reviewer-swarm orchestration.
- GitHub PR comment posting.
- External CI provider adapters.
- Release publishing automation.
- Full branch cleanup automation.
- Persona prompt registry.
