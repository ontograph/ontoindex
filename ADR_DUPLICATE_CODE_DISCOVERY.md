# ADR: Duplicate-Code Discovery

Status: Proposed
Owner: OntoIndex maintainers
Date: 2026-07-04

## Context

OntoIndex has strong code-intelligence surfaces for semantic search, impact analysis, tech-debt review, hotspots, dead-code review, and audit dedupe. None of them directly answer:

- where are exact or near-exact copied code blocks?
- where are semantically similar implementations that may be refactor candidates?

These are related but different problems. Exact duplicate detection is deterministic and line-range oriented. Semantic duplicate discovery is advisory, because similar meaning does not always mean duplicated implementation.

This ADR supersedes the earlier donor duplicate-code note, which reached the same helper-first-`jscpd` conclusion. That prior direction is folded in here; do not maintain both. If the donor note is still tracked, mark it superseded and link to this file.

## Dependency reality

Neither `jscpd` nor `cpd` is currently a dependency or on PATH (verified against `ontoindex/package.json` and the shell on 2026-07-04). Exact mode is therefore a new external tool, not a wrapper over something already installed.

Decision: invoke via `npx --yes jscpd@<pinned>` on demand, not a devDependency. Rationale: keeps the tool out of the default install for everyone who never runs duplicate-code, and avoids lockfile churn for an advisory CLI. The version is pinned in the command so runs are reproducible. If `npx`/network is unavailable, the command exits with one clear message telling the user which binary/version is needed and how to install it. Revisit adding a pinned devDependency only if on-demand `npx` proves too slow or flaky in practice.

## Decision

Add a CLI-only advisory command with two independent modes:

```text
ontoindex duplicate-code --mode exact
ontoindex duplicate-code --mode semantic
```

There is no combined `both` mode. Exact and semantic produce different output shapes and must not be merged into one opaque score; a consumer that wants both can run both and read two reports. Add a combined mode only if a real caller needs it.

The first and only initially-built implementation is `--mode exact`.

## Mode 1: Exact Duplicate-Code Detection

Run an external detector (`jscpd` via on-demand `npx`) through a thin wrapper.

Required output:

- duplicate group id;
- file paths;
- start and end lines;
- duplicated line/token counts;
- duplication percentage when available;
- detector name and version;
- thresholds used for the run;
- ignored/generated/vendor path summary.

Required controls:

- `--min-lines`;
- `--min-tokens`;
- `--include` / `--exclude`;
- respect `.gitignore` by default;
- skip known generated and vendor paths by default;
- machine-readable JSON output;
- bounded human summary output.

This mode shells out. OntoIndex must not reimplement token-based clone detection until there is proof the external detector cannot satisfy the workflow.

## Mode 2: Semantic Duplicate Candidates (gated)

Semantic mode is not scheduled work. It is blocked behind a proof-gate: build it only after exact mode has shipped and been shown insufficient for a real duplicate-refactor workflow.

Proof-gate (all required before any semantic code is written):

- a concrete case where exact mode misses a duplicate that a human confirms is a real copy;
- evidence that semantic ranking separates true near-duplicates from same-domain-but-distinct code at a usable precision (embeddings rank by meaning, not near-duplication, so false positives are the default failure mode);
- a noise-control plan that keeps the candidate list small enough to act on.

If it is built, it uses existing semantic search and symbol metadata, and must:

- compare functions/classes/methods against same-kind candidates;
- prefer candidates with similar size and different file paths;
- suppress the same symbol and same-file trivial neighbors;
- return a confidence score and why the pair was suggested;
- label results as candidates, never confirmed duplicates;
- stay advisory: never fail CI, block commits, or auto-request refactors.

## Non-Goals

- No native duplicate-code engine in the first slice.
- No default CI gate.
- No merged exact+semantic score.
- No scanning of generated, vendored, build, or lockfile content by default.
- No model-visible MCP tool until the CLI report format is stable.

## Recommended Sequence

1. Add `duplicate-code --mode exact` as a CLI-only advisory wrapper around `npx jscpd`.
2. Add tests for command construction, ignored paths, JSON parsing, and bounded summary output.
3. Only if the semantic proof-gate is met: add `duplicate-code --mode semantic` as a separate advisory mode.
4. Consider MCP exposure only after the exact report is small, stable, and low-noise.

## Acceptance Criteria

Exact mode is accepted when:

- it runs on this repo without scanning ignored/generated/vendor paths;
- JSON output includes duplicate groups with file paths and line ranges;
- human output is bounded and actionable;
- a missing detector / no-network case produces one clear install-and-run message;
- focused tests cover parser and command-building behavior.

Semantic mode is out of scope until its proof-gate is met; its acceptance criteria will be defined then.

## Placement

This ADR must live in a tracked path. `/docs/`, `/ontoindex/docs/`, and `docs/plans/` are gitignored, so it stays at repo root (`ADR_DUPLICATE_CODE_DISCOVERY.md`) and must be committed. If a tracked ADR directory is later established, move it there.
