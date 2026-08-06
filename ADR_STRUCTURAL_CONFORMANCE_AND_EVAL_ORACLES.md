# ADR: Structural Conformance Rules and Evaluation Oracles

Status: Accepted
Owner: OntoIndex maintainers
Date: 2026-07-26
Revision: 6 (implemented, challenged, and reconciled with live rule evidence)

## Context

A review of 26 open-source repositories from recent arXiv work on AI-assisted
software engineering (recorded in `tmp/arxiv/`) produced 100 candidate approaches
for OntoIndex. Two challenge passes against the indexed graph reduced these to 24,
cutting anything already implemented, misrouted to the wrong module, or requiring
a new subsystem rather than an extension.

The surviving work answers one question that OntoIndex cannot answer today:

> Did a change go through the intended abstraction, dependency direction, and
> ownership boundary, or did it merely make the tests pass?

Two external findings motivate this. The NITR benchmark reports that 13.3% of
evaluated agent outputs passed functional tests while violating a structural
oracle. The CodeThread study found that static complexity metrics did not explain
downstream maintainability failures, while contract drift and oversized
downstream edits did. Test-passing is therefore an incomplete quality signal, and
the usual complexity-metric response does not fix it.

OntoIndex is unusually well positioned here because it already holds call and
import edges. Competing implementations of this idea scan normalized source text
with regular expressions, which cannot distinguish a call from a mention.

## Existing capability (verified)

Verified against graph index `2026-07-25T16:36:44.769Z` at HEAD `ecbd066e` using
OntoIndex MCP `gn_diagnose`, `gn_find_related`, and `gn_test_gap`, with direct
source reads because the worktree was dirty.

Already implemented, and therefore explicitly not part of this decision:

- Forbidden dependency edges. `ontoindex/src/mcp/local/backend-boundary-violations.ts`
  normalizes rules with `from`/`to` globs and `forbidden_edge_types` (default
  `['CALLS', 'IMPORTS']`), matches with `minimatch`, and emits `GNV-NNN` findings.
- Structural complexity. `backend-tech-debt.ts` computes line count, parameter
  count, and caller count, ranked by complexity times churn times callers. No
  external complexity tool is needed.
- Commit-time reporting. `CommitAuditReport` in `mcp/super/pre-commit-audit.ts`
  already carries `preCommitChecklist`, `perSymbolImpact`, and
  `testCoverageDelta`.
- Scope and dedupe. `core/audit-lifecycle/` provides `scope-guard.ts`,
  `finding-dedupe.ts`, and `dispatch-prompt.ts`.

Two constraints that shape the decision:

- `DiagnosticFinding` is defined in `ontoindex-shared/src/analysis/types.ts` and
  consumed by six backends. Changing it is a cross-package change, not a local
  edit. Its `severity` already includes `advisory`.
- `gn_test_gap` self-reports `filenameDerivedCoverage: heuristic`. No
  test-evidence work is trustworthy until real coverage data is ingested.

### Verification notes from the challenge pass

The first revision of this ADR contained examples that could not run. Recorded
here so the same mistakes are not reintroduced:

- `gn_scope_guard` requires a persisted audit session and bundle id. A probe call
  with an ad hoc session returns `audit session does not exist`. It cannot be
  used as a standalone evaluation oracle, so it was removed from the oracle
  example and moved to a note under Slice 2.
- `max_call_sites` and required-edge rules do not exist in any form; `rg` finds
  no reference in `ontoindex/src`. The first revision presented `max_call_sites`
  inside a JSON rules example, which implied it was already loadable
  configuration. `normalizeRule` would ignore the field entirely. It is now
  clearly marked as proposed and shown as a schema extension, not as usable
  config.
- `gn_can_delete` returns `DO-NOT-DELETE` for a symbol with one caller, but also
  reports `freshness: stale` and `parserCoverage: incomplete` while `gn_diagnose`
  reports the index fresh at HEAD. Any oracle built on it must treat
  `evidence.freshness` as part of the result, not assume a clean verdict.

## Decision

Adopt structural conformance in three independent slices under one invariant:

> Every evaluation claim is derived from the canonical artifact at its existing
> owner. The runner does not guess schemas, read a second checkout, or infer that
> a missing check passed.

Concretely:

- The Docker environment owns `/testbed` file-change checks, structural tool
  calls through the warm eval-server, and graph provenance.
- `run_eval.py` only orchestrates those environment APIs and persists their
  result.
- `analyze_results.py` owns grading discovery and reads canonical SWE-bench
  per-instance `report.json` files.
- Missing artifacts or unmet preconditions are `DEGRADED` / `not measured`, never
  PASS or zero.

1. **Boundary rule sets as versioned repo configuration.** Configuration only,
   against the existing engine.
2. **A structural-oracle stage in evaluation.** The genuine gap in
   `eval/run_eval.py`.
3. **Partial-credit scoring.** Extends `eval/analysis/analyze_results.py`.

Explicitly deferred: any change to `ontoindex-shared`, and all test-evidence work
dependent on coverage ingestion.

### Slice 1: Boundary rule sets

The engine accepts either an inline `rules` array or a `rules_file` path resolved
relative to the repository root. Rules are plain JSON.

Create the trackable root file `ontoindex-boundary-rules.json` (`.ontoindex/` is
gitignored runtime state):

```json
[
  {
    "from": "ontoindex/src/core/**",
    "to": "ontoindex/src/mcp/super/**",
    "label": "core must not call MCP super-functions",
    "forbidden_edge_types": ["CALLS"]
  },
  {
    "from": "ontoindex/src/core/**",
    "to": "ontoindex/src/mcp/shared/**",
    "label": "core must not call MCP shared policy helpers",
    "forbidden_edge_types": ["CALLS"]
  }
]
```

`forbidden_edge_types` is optional and defaults to `['CALLS', 'IMPORTS']`. The
`label` is optional and defaults to `"<from> -> <to>"`; supply it, because it is
what appears in the finding message and in the `clean_rules` list.

The narrower target globs and `CALLS`-only edge type are deliberate. A live
`core/** -> mcp/**` CALLS rule produced false positives by resolving Node's
`fs.rename` to `LocalBackend.rename`; splitting `mcp/super/**` and
`mcp/shared/**` removed that noise. An `IMPORTS`-only probe returned clean even
though TypeScript imports from `core/audit-lifecycle` to
`mcp/shared/freshness-policy.ts` exist, so IMPORTS is not authoritative for this
rule set.

A violation is reported at `critical` severity with a message of the form:

```text
Boundary violation: 'verifyFindingFreshEvidence'
(ontoindex/src/core/audit-lifecycle/finding-verify.ts) calls
'evaluateFreshnessGatePolicy'
(ontoindex/src/mcp/shared/freshness-policy.ts), violating rule:
ontoindex/src/core/** -> ontoindex/src/mcp/shared/**
```

**Ownership boundaries.** The NITR benchmark's hardest dimension is dependency
control, expressed as a rule pair: the domain module owns a type, and consumers
must not reach around it. In this schema that is two rules, one forbidding the
consumer direction and one asserted by the absence of violations in the domain
direction:

```json
[
  {
    "from": "src/consumers/**",
    "to": "src/domain/internal/**",
    "label": "consumers must not touch domain internals",
    "forbidden_edge_types": ["CALLS", "IMPORTS"]
  }
]
```

**Commit gating.** Add one entry to the existing `preCommitChecklist` array in
`CommitAuditReport` rather than introducing a separate surface:

```ts
{
  check: 'boundary-rules',
  passed: violations.length === 0,
  detail: `${violations.length} boundary violation(s) across ${violatedRules} rule(s)`,
}
```

**Required edges and call-site caps (proposed, not implemented).** Neither exists
today. `normalizeRule` reads only `from`, `to`, `label`, and
`forbidden_edge_types`; any other key is silently ignored, so the shape below is
a proposed schema extension and must not be written into a rules file until the
backend supports it.

Both are genuine extensions of the same backend rather than new modules: the
existing query already returns every matching edge with source and target paths,
so a required-edge rule inverts the pass condition and a call-site cap counts
matched rows against a threshold. Each needs a new field in `normalizeRule`, a
new branch in the per-rule evaluation, and a distinct finding message, because
the current message is hardcoded to the word "violating".

```jsonc
// PROPOSED — not yet loadable by normalizeRule
{
  "from": "src/**",
  "to": "src/util/logger.ts",
  "label": "logging must stay centralized",
  "max_call_sites": 12
}
```

### Slice 2: Structural-oracle stage in evaluation

`eval/run_eval.py` runs `process_instance` and `run_configuration` with no
structural stage. Add one that runs after tests, where overall pass requires both
oracles.

Oracles are implemented by calling existing MCP tools. Do not write new
predicates.

```yaml
structural_oracles:
  - id: ERR_LAYER_VIOLATION
    tool: boundary_violations
    rules_file: ontoindex-boundary-rules.json
    expect: no_violations

  - id: ERR_FROZEN_PATH_MODIFIED
    check: frozen_paths
    paths: ["app/main.cc"]
```

Only `boundary_violations` is exposed through the structural tool runner in this
slice. Adding another tool requires an explicit interpreter for its result and a
test of its freshness/precondition fields; arbitrary LocalBackend tools are not
accepted.

`gn_scope_guard` is deliberately absent. It requires a persisted audit session and
bundle id, so it belongs to the audit lifecycle rather than to a standalone eval
run. Wiring it in would mean creating a session per evaluation instance, which is
a larger decision and out of scope here.

`frozen_paths` is the one check with no graph tool behind it. It runs
`git status --porcelain=v1 --untracked-files=all -- <path>` inside `/testbed`, the
checkout the agent actually edits. Any tracked, deleted, renamed, or untracked
change to a frozen path fails. Host-side hashes are invalid because the harness
host does not own the container checkout.

Each oracle emits a stable machine error code so results aggregate across runs
and models. Every eval result records the graph index id and HEAD, matching the
session-lock discipline `core/audit-lifecycle/` already applies.

### Slice 3: Partial-credit scoring

`compute_metrics` in `eval/analysis/analyze_results.py` tracks patch rate, cost,
API calls, and tool usage. It has no notion of partial credit: `n_with_patch`
collapses "no patch", "patch that breaks tests", and "patch that partially
passes" into a single count.

Add:

- per-oracle pass/fail alongside test results;
- the functional-pass-structural-fail rate, as the headline metric;
- separate outcome buckets for no patch, broken patch, and partial pass;
- test-level fix rate alongside binary resolve rate;
- pass@N and stability across repeated runs;
- cost-to-progress ratio, extending existing cost tracking;
- correlation of the existing `total_gn_tool_calls` and `augment_hit_rate` with
  partial progress.

SWE-bench grading remains a separate phase. The analyzer discovers canonical
per-instance artifacts under
`swebench_eval/logs/run_evaluation/**/report.json`, merges the report map by
instance id, and then computes outcomes. It must not read grading fields from
`summary.json`, which records agent execution rather than test results.

Partial credit is the actual FAIL_TO_PASS success ratio when PASS_TO_PASS has no
regression, matching SWE-bench's PARTIAL definition. It is not a fixed 0.5.

The headline metric is the point of the whole ADR:

```text
resolve rate:                        42.0%
functional pass, structural fail:    13.3%   <- justifies graph-aware tooling
partial progress (test-level):       61.4%
```

A rubric section with must-have versus diagnostic criteria may be added, with
machine-checkable criteria routed to existing MCP verifiers. Negative criteria
("must not modify unrelated modules") are expressed by flipping the pass
condition, not by a separate mechanism.

## Non-Goals

- No native structural-analysis engine. Oracles call existing tools.
- No text or regex scanning of source. OntoIndex has real edges; string matching
  would be a downgrade.
- No external complexity tool. `backend-tech-debt.ts` already computes the
  metrics, and the CodeThread result shows complexity is a weak signal anyway.
- No changes to `ontoindex-shared` in this ADR. Objectivity classification,
  suppression reasons, and confidence calibration on `DiagnosticFinding` are a
  separate cross-package project with six consumers.
- No test-evidence verifiers until coverage ingestion lands.
- No CI gate by default. Boundary rules gate commits only through the existing
  checklist, and evaluation oracles never gate product code.
- No mutation testing, paired-change benchmarks, or repair-utility benchmarks.
  Each is a new subsystem, defensible later.

## Recommended Sequence

1. Write `ontoindex-boundary-rules.json` for OntoIndex itself and fix or accept
   what it reports. Config only, roughly a day.
2. Add the boundary entry to `preCommitChecklist`.
3. Add the structural-oracle stage to `eval/run_eval.py`, starting with
   `boundary_violations` and `frozen_paths`.
4. Add per-oracle results and the functional-pass-structural-fail rate to
   `analyze_results.py`.
5. Add remaining partial-credit buckets and pass@N.
6. Extend the boundary backend with required-edge and call-site-cap rules once
   real rule sets exist and demand them.
7. Improve review output: configurable `classifyReviewRisk` thresholds, exposure
   of the `heuristic` flag, complexity delta on `ReviewFile`, changed-caller
   counts.

Steps 1 and 2 deliver enforced architecture rules against an engine that already
ships. Steps 3 and 4 deliver the metric that justifies the approach.

## Acceptance Criteria

Slice 1 is accepted when a committed rules file runs against this repository, a
deliberately introduced `core` to `mcp` edge is reported with source and target
symbols, a clean run lists every rule under `clean_rules`, and the commit
checklist reflects the result.

Slice 2 is accepted when an evaluation task declares at least one structural
oracle, a solution passing tests while violating an oracle is recorded as an
overall failure with its stable error code, `frozen_paths` detects a modified
frozen file inside `/testbed`, each result carries a stable eval-cache graph id
and indexed HEAD, and any oracle
running on degraded evidence is reported as degraded rather than passing.

Slice 3 is accepted when the analysis output distinguishes no patch from broken
patch from partial pass, reports functional-pass-structural-fail as a first-class
figure in table, Markdown, CSV, and JSON output, loads persisted SWE-bench
`report.json` artifacts automatically, and remains correct when a run has no
structural oracles or grading artifacts at all.

## Risks

Rules that encode taste rather than a real decision will generate noise and be
ignored; keep the initial set small and derived from decisions the team can name.
Oracles are narrower and more brittle than functional tests, so a failing oracle
must always name the rule that failed and the edge that triggered it. The
headline metric depends on having oracles defined; with none declared, it is
correctly zero rather than misleadingly perfect.

The sharpest risk is the one this ADR already tripped over: an oracle that calls
a tool whose preconditions are unmet will fail in a way that looks like a code
violation. Every oracle must distinguish "the rule was violated" from "the check
could not run", and the evaluation stage must treat the second as degraded rather
than as either pass or fail.

## Placement

`/docs/`, `/ontoindex/docs/`, and `docs/plans/` are gitignored, so this ADR stays
at repository root as `ADR_STRUCTURAL_CONFORMANCE_AND_EVAL_ORACLES.md` and must
be committed, matching `ADR_DUPLICATE_CODE_DISCOVERY.md`. The supporting review
lives at `tmp/arxiv/candidate-reviews-100-approaches.md`, which is scratch and
not a tracked source of truth.
