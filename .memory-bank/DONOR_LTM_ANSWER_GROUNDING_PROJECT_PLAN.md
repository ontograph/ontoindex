# Donor LTM Answer Grounding Project Plan

Date: 2026-10-14
Status: Proposed
Authority: User requirement of 2026-10-14: review the donor project `serge3emskov/pharma-ltm-assistant`, compare it with OntoIndex, and write an implementation plan for the adoptable ideas. Ideas only; the donor repository has no license, so no donor code or data is copied.

## Goal

Given an answer text and the evidence a `query` returned, a deterministic check reports which file paths and code symbols cited by the answer are absent from that evidence, so a reader or an agent can see invented citations. The check uses no model, runs in bounded time, and changes no stored fact and no existing response field.

## How To Use This Plan

Each task is self-contained and every design decision is made in the card. Edit only the files in the task's allowed write set. Run validation commands from the worktree `ontoindex/` directory. If a stop condition occurs, stop and report instead of widening scope.

## Current State

Observed on `origin/master` at `1463494`.

- The donor (`tmp/pharma-ltm-assistant`, commit `6cf71f1`) keeps a post-answer audit: drugs named in the model's answer are re-checked by the same deterministic rules as the question, and code appends a warning when the answer omits one. This is the only donor idea with no OntoIndex counterpart that fits a deterministic, model-free producer.
- OntoIndex already returns the evidence needed to check citations: chunk `docPath`, `lineSpan` and `chunkKey` on Markdown evidence, and a bounded `mentionTargets` map with resolved `filePath`, `name` and `startLine` (PR #96, #101).
- `mentionLookupName` in `markdown-mention-resolution.ts` already turns a backtick text into a symbol lookup name and rejects commands, paths and flags.
- No code compares an answer against returned evidence.
- Compared and set aside (see Decisions): rejection log, absent-versus-unknown state, fact lifecycle, per-kind lifetime, declarative rule files.
- The OntoIndex graph index is stale (commit `7b1494c`); source on `origin/master` is the authority for every claim above.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: in-progress
  selection_policy: active_next_task-first
  active_next_task: DL-1.0
  max_in_flight: 1
  dispatch_mode: human
  reopen_gate: null

tasks:
  DL-1.0:
    title: Given an answer text and returned evidence, when checkAnswerGrounding runs, then path and symbol citations missing from the evidence are reported as ungrounded, ambiguous symbols as unverifiable, and oversized input is bounded
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/src/core/ingestion/enrichment/markdown-answer-grounding.ts
      - ontoindex/test/unit/markdown-answer-grounding.test.ts
    allowed_write_set:
      - ontoindex/src/core/ingestion/enrichment/markdown-answer-grounding.ts
      - ontoindex/test/unit/markdown-answer-grounding.test.ts
    non_goals:
      - Editing local-backend.ts, any tool schema or any stored fact format.
      - Calling a model, the graph or the file system.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/markdown-answer-grounding.test.ts
      - cd ontoindex && npx tsc --noEmit -p tsconfig.json
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/ingestion/enrichment/markdown-mention-resolution.ts
      generated_outputs: []
    expected_evidence:
      - Both commands exit 0 and the test file reports DL1-A through DL1-F passing.
    rollback:
      - git rm --cached -f ontoindex/src/core/ingestion/enrichment/markdown-answer-grounding.ts ontoindex/test/unit/markdown-answer-grounding.test.ts
    stop_conditions:
      - The module needs a change to markdown-mention-resolution.ts.
    known_blockers: []

  DL-2.0:
    title: Given eight labelled answers with known faithful and invented citations, when the checker runs against fixed evidence, then every invented citation is reported and no faithful citation is
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on:
      - DL-1.0
    type: test
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/test/unit/markdown-answer-grounding-eval.test.ts
    allowed_write_set:
      - ontoindex/test/unit/markdown-answer-grounding-eval.test.ts
    non_goals:
      - Changing the checker or its constants to make a case pass.
      - Reading the live index or the network.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/markdown-answer-grounding-eval.test.ts test/unit/markdown-answer-grounding.test.ts
      - cd ontoindex && npx tsc --noEmit -p tsconfig.json
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/ingestion/enrichment/markdown-answer-grounding.ts
      generated_outputs: []
    expected_evidence:
      - Both commands exit 0; DL2-A reports 4 of 4 faithful answers with zero ungrounded citations and DL2-B reports 4 of 4 invented citations detected.
    rollback:
      - git rm --cached -f ontoindex/test/unit/markdown-answer-grounding-eval.test.ts
    stop_conditions:
      - A case fails and the only fix is to change the checker; report the failure instead.
    known_blockers: []

  DL-3.0:
    title: Given the built CLI and this repository's own plan closeouts as answers, when the checker runs against live query evidence, then ungrounded counts, false-positive review and added milliseconds are recorded
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
      - DL-2.0
    type: measurement
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - .memory-bank/audit_session-markdown-graph-rag-recall.md
    allowed_write_set:
      - .memory-bank/audit_session-markdown-graph-rag-recall.md
    non_goals:
      - Changing source.
      - Wiring the checker into any tool response.
    required_validation:
      - test -s .memory-bank/audit_session-markdown-graph-rag-recall.md
    validation_workspace:
      root: .
      inputs:
        - .memory-bank/audit_session-markdown-graph-rag-recall.md
      generated_outputs: []
    expected_evidence:
      - The audit-session file has an Answer grounding section with citations checked, ungrounded count, reviewed false positives, median milliseconds and the wiring decision.
    rollback:
      - git checkout -- .memory-bank/audit_session-markdown-graph-rag-recall.md
    stop_conditions:
      - More than 20 percent of reviewed ungrounded citations are false positives; record the result and do not recommend wiring.
    known_blockers: []
```

## Task Cards

### DL-1.0: grounding module

Create `ontoindex/src/core/ingestion/enrichment/markdown-answer-grounding.ts` exporting exactly:

```ts
export const ANSWER_GROUNDING_MAX_ANSWER_BYTES = 65536;
export const ANSWER_GROUNDING_MAX_CITATIONS = 200;

export interface GroundingEvidence {
  docPaths: readonly string[];
  mentionTargets: Readonly<
    Record<string, { status: 'resolved' | 'ambiguous' | 'unresolved'; targets: { name?: string; filePath?: string }[] }>
  >;
}
export interface AnswerCitation {
  kind: 'path' | 'symbol';
  text: string;
  line?: number;
}
export interface AnswerGroundingResult {
  status: 'grounded' | 'ungrounded' | 'no-citations';
  grounded: AnswerCitation[];
  ungrounded: AnswerCitation[];
  unverifiable: AnswerCitation[];
  truncated: boolean;
}

export function extractAnswerCitations(answer: string): AnswerCitation[];
export function checkAnswerGrounding(answer: string, evidence: GroundingEvidence): AnswerGroundingResult;
```

Rules, all fixed:

1. `extractAnswerCitations` first cuts the answer to `ANSWER_GROUNDING_MAX_ANSWER_BYTES` UTF-8 bytes. A path citation matches `/(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}(?::(\d+))?/g`; the optional `:N` suffix becomes `line` and is removed from `text`. A symbol citation is the text of an inline backtick span for which `mentionLookupName` (imported from `./markdown-mention-resolution.js`) returns a name; the citation `text` is the full backtick text. Backtick spans that look like a path are path citations, not symbol citations. Fenced code blocks are skipped. Results keep first-seen order and are de-duplicated by `kind` plus `text`.
2. `checkAnswerGrounding` keeps the first `ANSWER_GROUNDING_MAX_CITATIONS` citations and sets `truncated` when more exist.
3. A path citation is grounded when its normalized text (backslashes to slashes, leading `./` removed) equals, or is a path-suffix of, a normalized `docPaths` entry or a `filePath` of any `mentionTargets` target; otherwise it is ungrounded.
4. A symbol citation looks up `mentionTargets[text]`. Status `resolved` makes it grounded. Status `ambiguous` makes it unverifiable. Status `unresolved` or a missing entry makes it ungrounded, except that a symbol whose lookup name equals the `name` of any target in the map is grounded.
5. `status` is `no-citations` when there are no citations, `ungrounded` when `ungrounded` is non-empty, otherwise `grounded`. Unverifiable citations never change `status`.
6. The module is pure: no I/O, no clock, no model call.

Tests (`markdown-answer-grounding.test.ts`):
- DL1-A: extraction finds `src/a/b.ts:12` (with `line` 12), `` `buildPhaseList` ``, and skips a symbol inside a fenced block and `` `git status` ``.
- DL1-B: a path equal to a `docPaths` entry, and one that is a suffix of it, are grounded.
- DL1-C: a path in no evidence is ungrounded and sets `status` to `ungrounded`.
- DL1-D: a `resolved` symbol is grounded; a symbol absent from the map is ungrounded.
- DL1-E: an `ambiguous` symbol is unverifiable and does not change `status` when everything else is grounded.
- DL1-F: 300 distinct paths give 200 checked citations with `truncated` true; an answer above 64 KB is cut and still returns.

### DL-2.0: labelled evaluation

Create `ontoindex/test/unit/markdown-answer-grounding-eval.test.ts` with fixed evidence (three `docPaths`, two resolved targets, one ambiguous) and eight answers written inline. Four answers cite only evidence paths and symbols (some with `:line` suffixes and mixed case in prose). Four each contain exactly one invented path or one invented symbol that looks plausible (for example a real-looking sibling file name). Do not tune the checker; if a case fails, report it.

Tests:
- DL2-A: the four faithful answers return `grounded` or `no-citations` with an empty `ungrounded` list.
- DL2-B: each invented answer returns `ungrounded` and the invented citation is in the list.
- DL2-C: total citations checked across all eight answers is asserted, so a silent extraction regression fails.

### DL-3.0: live measurement

After rebuilding the CLI from the merged code, run `ontoindex docs sidecar run markdown` and the eight labelled recall queries from the audit-session file. Use each query's returned `docPaths` and `mentionTargets` as evidence and the matching plan Closeout paragraphs as the answer text. Record in an `Answer grounding` section of the audit-session file: citations checked, ungrounded count, how many of the ungrounded citations a reviewer confirms as real errors versus false positives, median and maximum milliseconds, and the decision: wire into a tool response only when false positives are 20 percent or fewer and the median is under 20 ms; otherwise keep the module unwired.

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REQ-001 | Adopt the donor's post-answer audit idea as a deterministic citation check | implementation | DL-1.0 | DL1-A through DL1-F |
| REQ-002 | Prove the check separates invented from faithful citations | compatibility-test | DL-2.0 | DL2-A through DL2-C |
| REQ-003 | Measure precision and cost on real evidence before any wiring | proof-only | DL-3.0 | Recorded Answer grounding section |
| REQ-004 | No donor code or data is copied | non-goal | DL-1.0 | Review of the diff; donor has no license |
| REQ-005 | Rejection log, absent-versus-unknown state, fact lifecycle, time-based forgetting, declarative rule files | rejected | DL-1.0 | Not built; reasons in Decisions |

## Decisions And Non-Goals

- Chosen: the answer-grounding check, because it needs no model, reuses evidence OntoIndex already returns, and is testable as a pure function. The other options were weaker.
- Rejected, rejection log: the Markdown producer is deterministic and has no model output to reject; recall losses come from ranking and caps, which `factsBound` already counts.
- Rejected, absent-versus-unknown state: Markdown facts are derived from document text, so there is no "checked and found absent" event to store; `RequirementTraceStatus` already has `missing`.
- Rejected, fact lifecycle and time-based forgetting: the index is commit-based, so freshness follows commits; a clock-based expiry would contradict that model.
- Rejected, declarative rule files: no rule set exists to externalize today.
- Wiring the checker into `query`, `docs` or any tool schema is out of scope until DL-3.0 meets its decision threshold.
- Plan files under `.memory-bank/` are written in the main session; the task write sets for code and test stay under `ontoindex/`.

## Closeout

Not started.
