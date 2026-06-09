# Using OntoIndex for test coverage processes

## What OntoIndex is good at here

OntoIndex is strongest at **graph-based verification coverage**, not raw runtime line coverage. It answers questions like:

- What changed?
- What depends on the changed code?
- Which tests appear to cover it?
- Which high-risk areas still lack test evidence?
- Which requirements have code but no tests, or tests but no implementation trace?

That makes it a good fit for **test planning**, **PR gating**, **coverage debt tracking**, and **requirement-to-test traceability**.

It does **not** replace runtime coverage tools such as Istanbul, nyc, lcov, gcov, or Vitest/Jest coverage instrumentation.

## Mental model

- Runtime coverage tools answer **"what executed?"**
- OntoIndex answers **"what should be tested, what changed, what depends on it, and what still lacks verification?"**

The best workflow is to use both:

1. runtime coverage for execution facts
2. OntoIndex for structural risk and test-gap detection

## Recommended solutions

## 1. Changed-file test gate

**Best for:** daily development, CI, and PR checks.

Use OntoIndex to inspect the diff and classify changed source files as:

- `covered`
- `weakly_covered`
- `uncovered`

The core tool is `verification_gap`. It combines:

- git diff from a base ref
- naming-convention test discovery
- direct test imports
- graph traces from test files to changed source files

This is much more actionable than a repo-wide percentage because it answers the real question:

**"Did this change introduce unverified behavior?"**

**Suggested policy:**

- `uncovered` → fail
- `weakly_covered` → warn
- `covered` → pass

## 2. Risk-based test planning

**Best for:** refactors, parser/search/core changes, and public API edits.

Use OntoIndex before writing tests:

- `gn_diff_impact` to inspect changed files and symbols
- `gn_safe_edit_check` to estimate blast radius and likely test coverage
- `impact` for focused symbol-by-symbol dependency checks

This lets you prioritize tests by:

- caller count
- downstream dependency count
- process participation
- cluster criticality
- lack of existing test signal

Instead of trying to raise coverage everywhere, you test the code most likely to break other behavior.

## 3. Requirement-to-test traceability

**Best for:** product flows, protocols, acceptance criteria, and contract-heavy work.

If your repo uses requirement or bug IDs like:

- `REQ-123`
- `BUG-88`
- `RFC-12`

then `requirements_trace` can classify each item as:

- `implemented`
- `partial`
- `missing`

This gives a useful governance layer:

1. requirement exists
2. implementation evidence exists
3. test evidence exists

This is stronger than generic coverage for critical workflows because it ties tests to named obligations.

## 4. Test recommendation workflow

**Best for:** large repos where developers know code changed but do not know where tests belong.

Use OntoIndex as a guided test-authoring assistant:

1. `gn_explain_module` — understand the changed file, exports, and co-change partners
2. `gn_find_related` — inspect callers, callees, and nearby symbols
3. `gn_propose_location` — propose where a new test file should live

This is useful when the repository has:

- inconsistent test placement
- multiple test styles
- many adjacent modules with shared behavior

OntoIndex helps place the test near the real dependency edges instead of guessing by filename alone.

## 5. Pre-commit / PR readiness gate

**Best for:** team-wide quality enforcement.

Combine:

- `gn_pre_commit_audit`
- `verification_gap`
- `gn_diff_impact`

Suggested rule set:

1. If a changed symbol is high-risk and no test signal exists → block
2. If a changed file is `uncovered` → block
3. If a changed file is `weakly_covered` but blast radius is low → warn
4. If the change is docs-only or config-only → ignore

This produces a much better PR gate than global coverage thresholds, because it is tied to the actual changed graph surface.

## 6. Coverage-debt backlog

**Best for:** continuous improvement, not just PR policing.

Run periodic OntoIndex audits to build a backlog of:

- uncovered changed hotspots
- high-impact symbols with weak test evidence
- partially traced requirements
- modules with repeated churn but poor verification signal

Then rank the backlog by:

- blast radius
- churn recency
- public API status
- process criticality
- co-change density

This turns OntoIndex into a **coverage prioritizer**, not just a checker.

## Suggested rollout

If you want the most practical value with the least process weight:

1. Adopt **changed-file test gating** with `verification_gap`
2. Add **risk-based PR gating** with `gn_diff_impact` and `gn_pre_commit_audit`
3. Add **requirements_trace** for critical flows and protocol work
4. Build a periodic **coverage-debt backlog** from recurring findings

## Practical workflow recipes

## Recipe A — PR verification check

Use when reviewing a branch or pending change.

1. Run `gn_diff_impact` on the diff
2. Run `verification_gap` against the same base ref
3. If high-risk symbols are uncovered, require tests before merge

## Recipe B — Safe refactor with test planning

Use before changing a function, class, or method.

1. Run `gn_safe_edit_check`
2. If verdict is `CAUTION` or higher, inspect `gn_find_related`
3. Add tests for top callers, public APIs, and process-critical branches first

## Recipe C — Requirement closure audit

Use before release or milestone closure.

1. Run `requirements_trace` for the requirement IDs in scope
2. Treat `partial` items as missing test evidence unless explicitly justified
3. Close only items with both implementation and test evidence

## Limitations

OntoIndex coverage analysis is structural and graph-driven. That means:

- it can miss runtime-only behavior not visible in static relationships
- it is not a substitute for branch/path coverage
- it depends on index freshness and test-file discoverability
- it is strongest when the repo follows recognizable test naming and import patterns

So the right position is:

- use runtime coverage to measure execution
- use OntoIndex to decide where testing effort matters most

## Recommended default stance

For most teams, the best OntoIndex test-coverage process is:

1. **Gate changed files with `verification_gap`**
2. **Prioritize tests with `gn_diff_impact`**
3. **Use `requirements_trace` for critical workflows**
4. **Track persistent weak spots as coverage debt**

That gives immediate value without requiring a full custom test platform.
