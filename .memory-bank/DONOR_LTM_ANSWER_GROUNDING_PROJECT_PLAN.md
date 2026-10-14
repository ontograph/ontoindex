# Donor LTM Answer Grounding Project Plan

Date: 2026-10-14
Status: Complete (shipped in PR #108; measurement recorded in the audit-session file; task statuses in the YAML stay OPEN because workers had no manager-loop lease)
Authority: User requirement of 2026-10-14: review the donor project `serge3emskov/pharma-ltm-assistant`, compare it with OntoIndex, and write an implementation plan for the adoptable ideas. Ideas only; the donor repository has no license, so no donor code or data is copied.

## Goal

Given an answer text and the evidence a `query` returned, a deterministic check reports which file paths and code symbols cited by the answer are absent from that evidence, so a reader or an agent can see invented citations. The check uses no model, runs in bounded time, and changes no stored fact and no existing response field.

## How To Use This Plan

This plan is written so a small model (Haiku class) can execute it without design work.

1. Work in a git worktree created from `origin/master`. If `node_modules` is missing there, symlink `node_modules` and `ontoindex/node_modules` from the main checkout, and delete both symlinks before committing.
2. For each task, create every file listed under "Files" with the exact content shown. Copy it character for character. Do not reformat, rename, reorder or "improve" anything.
3. Run the commands under "Run" from the directory shown. Compare the output with "Expected". If it matches, the task is done.
4. If anything differs from "Expected", stop and report the full command output. Do not edit the code or the tests to make them pass.
5. Edit only files in the task's `allowed_write_set`.

Every file below was run before this plan was written: 9 tests pass and `tsc --noEmit` exits 0 on `origin/master` at `1463494`.

## Current State

Observed on `origin/master` at `1463494`.

- The donor (`tmp/pharma-ltm-assistant`, commit `6cf71f1`) keeps a post-answer audit: drugs named in the model's answer are re-checked by the same deterministic rules as the question, and code appends a warning when the answer omits one. This is the only donor idea with no OntoIndex counterpart that fits a deterministic, model-free producer.
- OntoIndex already returns the evidence needed to check citations: chunk `docPath`, `lineSpan` and `chunkKey` on Markdown evidence, and a bounded `mentionTargets` map with resolved `filePath`, `name` and `startLine` (PR #96, #101).
- `mentionLookupName` in `markdown-mention-resolution.ts` already turns a backtick text into a symbol lookup name and rejects commands, paths and flags.
- No code compares an answer against returned evidence.
- `mentionTargets` in the response only contains `resolved` and `ambiguous` entries; unresolved mentions are omitted, so a missing key means unresolved.
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
      - Both commands exit 0 and vitest reports 6 tests passed (DL1-A to DL1-F).
    rollback:
      - git rm --cached -f ontoindex/src/core/ingestion/enrichment/markdown-answer-grounding.ts ontoindex/test/unit/markdown-answer-grounding.test.ts
    stop_conditions:
      - The module needs a change to markdown-mention-resolution.ts.
      - A test fails after the files were copied verbatim; report the output and do not edit the code or the test.
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
      - Both commands exit 0 and vitest reports 9 tests passed across 2 files (DL1-A to DL1-F and DL2-A to DL2-C).
    rollback:
      - git rm --cached -f ontoindex/test/unit/markdown-answer-grounding-eval.test.ts
    stop_conditions:
      - A test fails after the file was copied verbatim; report the output and do not edit the checker or the test.
    known_blockers: []

  DL-3.0:
    title: Given the merged module and the repository's tracked Markdown, when the measurement script runs, then path-citation counts, ungrounded share and median milliseconds are recorded and the wiring decision follows the fixed thresholds
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
      - Changing source or committing the measurement script.
      - Wiring the checker into any tool response.
      - Rebuilding the CLI, running the sidecar or calling a model.
    required_validation:
      - grep -q "^## Answer grounding" .memory-bank/audit_session-markdown-graph-rag-recall.md
    validation_workspace:
      root: .
      inputs:
        - ontoindex/src/core/ingestion/enrichment/markdown-answer-grounding.ts
      generated_outputs: []
    expected_evidence:
      - The audit-session file has an Answer grounding section with the script's JSON line verbatim, the first 10 sample lines and the decision sentence chosen by the fixed rule.
    rollback:
      - git checkout -- .memory-bank/audit_session-markdown-graph-rag-recall.md
    stop_conditions:
      - The script exits non-zero or prints no JSON line; record the error output and stop.
    known_blockers: []
```

## Task Cards

### Review findings that changed the first draft

The first draft's extraction rules were run on sample text before this revision. These defects were found and fixed in the code below:

| Draft rule | Problem found | Fix in the reference code |
| --- | --- | --- |
| Any backtick span accepted by `mentionLookupName` is a symbol | `` `file.md` `` became the symbol `md`; `` `status` `` became a symbol, so every plain word in backticks would be reported as invented | Spans that look like a path are paths; a symbol must contain an uppercase letter, `_` or `.` |
| `` `buildPhaseList()` `` | `mentionLookupName` rejects `()`, so call-style citations were dropped | A trailing `()` is removed before the check |
| Path regex with any 1-8 character extension | Matched URLs such as `https://github.com/o/r/blob/main/y.md` | URLs are removed before matching; extensions come from a fixed allowlist |
| `mentionTargets` with an `unresolved` status | The backend never returns `unresolved` entries | A missing key is treated as unresolved |
| DL-3.0 measured live query evidence with a human reviewer | Needs a CLI rebuild, a sidecar run and judgment; not executable by a small model | Replaced with a fixed script against `git ls-files` and a mechanical decision rule |
| DL2-C expected 12 citations | Actual count is 11; the ambiguous name is counted once | The test asserts 11 |

Known limits, accepted: line numbers are recorded but not checked against `lineSpan`; a lowercase single-word function name in backticks (for example `` `analyze` ``) is not checked; paths without a directory in prose (`local-backend.ts`) are only checked when written in backticks.

### DL-1.0: grounding module and unit tests

Files:

`ontoindex/src/core/ingestion/enrichment/markdown-answer-grounding.ts`

```ts
import { mentionLookupName } from './markdown-mention-resolution.js';

export const ANSWER_GROUNDING_MAX_ANSWER_BYTES = 65536;
export const ANSWER_GROUNDING_MAX_CITATIONS = 200;

export interface GroundingEvidence {
  docPaths: readonly string[];
  mentionTargets: Readonly<
    Record<
      string,
      {
        status: 'resolved' | 'ambiguous' | 'unresolved';
        targets: readonly { name?: string; filePath?: string }[];
      }
    >
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

const EXT = '(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|rs|py|go|java|sh|css|html)';
const FENCE_RE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const SPAN_RE = /`([^`\n]+)`/g;
const PATH_IN_SPAN_RE = new RegExp(
  `^(?:\\./)?(?:[\\w-][\\w.-]*/)*[\\w-][\\w.-]*\\.${EXT}(?::(\\d+))?$`,
);
const PATH_IN_PROSE_RE = new RegExp(
  `(?:\\./)?(?:[\\w-][\\w.-]*/)+[\\w-][\\w.-]*\\.${EXT}(?::(\\d+))?\\b`,
  'g',
);

function normalizePath(text: string): string {
  return text.replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathCitation(raw: string, line: string | undefined): AnswerCitation {
  const text = normalizePath(line === undefined ? raw : raw.slice(0, -(line.length + 1)));
  return line === undefined ? { kind: 'path', text } : { kind: 'path', text, line: Number(line) };
}

function isCodeLike(text: string): boolean {
  return /[A-Z_.]/.test(text);
}

export function extractAnswerCitations(answer: string): AnswerCitation[] {
  const bounded = Buffer.from(answer, 'utf8')
    .subarray(0, ANSWER_GROUNDING_MAX_ANSWER_BYTES)
    .toString('utf8');
  const text = bounded.replace(FENCE_RE, '').replace(URL_RE, ' ');
  const found: AnswerCitation[] = [];
  const prose = text.replace(SPAN_RE, (_match, inner: string) => {
    const span = inner.trim();
    const pathMatch = PATH_IN_SPAN_RE.exec(span);
    if (pathMatch) {
      found.push(pathCitation(span, pathMatch[1]));
    } else {
      const symbol = span.replace(/\(\)$/, '');
      if (mentionLookupName(symbol) !== undefined && isCodeLike(symbol)) {
        found.push({ kind: 'symbol', text: symbol });
      }
    }
    return ' ';
  });
  for (const match of prose.matchAll(PATH_IN_PROSE_RE)) {
    found.push(pathCitation(match[0], match[1]));
  }
  const seen = new Set<string>();
  return found.filter((citation) => {
    const key = `${citation.kind}\0${citation.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function checkAnswerGrounding(
  answer: string,
  evidence: GroundingEvidence,
): AnswerGroundingResult {
  const all = extractAnswerCitations(answer);
  const citations = all.slice(0, ANSWER_GROUNDING_MAX_CITATIONS);
  const entries = Object.entries(evidence.mentionTargets);
  const knownPaths = [
    ...evidence.docPaths,
    ...entries.flatMap(([, entry]) => entry.targets.map((target) => target.filePath ?? '')),
  ]
    .filter((path) => path.length > 0)
    .map(normalizePath);
  const resolvedNames = new Set(
    entries
      .filter(([, entry]) => entry.status === 'resolved')
      .flatMap(([, entry]) => entry.targets.map((target) => target.name ?? '')),
  );
  const ambiguousNames = new Set(
    entries
      .filter(([, entry]) => entry.status === 'ambiguous')
      .map(([key]) => mentionLookupName(key) ?? key),
  );
  const result: AnswerGroundingResult = {
    status: 'no-citations',
    grounded: [],
    ungrounded: [],
    unverifiable: [],
    truncated: all.length > citations.length,
  };
  for (const citation of citations) {
    if (citation.kind === 'path') {
      const ok = knownPaths.some(
        (path) => path === citation.text || path.endsWith(`/${citation.text}`),
      );
      (ok ? result.grounded : result.ungrounded).push(citation);
      continue;
    }
    const entry = evidence.mentionTargets[citation.text];
    const name = mentionLookupName(citation.text) ?? citation.text;
    if (entry?.status === 'resolved' || resolvedNames.has(name)) result.grounded.push(citation);
    else if (entry?.status === 'ambiguous' || ambiguousNames.has(name))
      result.unverifiable.push(citation);
    else result.ungrounded.push(citation);
  }
  if (citations.length > 0)
    result.status = result.ungrounded.length > 0 ? 'ungrounded' : 'grounded';
  return result;
}
```

`ontoindex/test/unit/markdown-answer-grounding.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import {
  ANSWER_GROUNDING_MAX_CITATIONS,
  checkAnswerGrounding,
  extractAnswerCitations,
  type GroundingEvidence,
} from '../../src/core/ingestion/enrichment/markdown-answer-grounding.js';

const evidence: GroundingEvidence = {
  docPaths: ['ontoindex/src/core/a/b.ts', 'RUNBOOK.md'],
  mentionTargets: {
    buildPhaseList: {
      status: 'resolved',
      targets: [{ name: 'buildPhaseList', filePath: 'ontoindex/src/core/pipeline/phases.ts' }],
    },
    LocalBackend: { status: 'ambiguous', targets: [] },
  },
};

const texts = (list: { text: string }[]) => list.map((citation) => citation.text);

describe('markdown answer grounding', () => {
  it('DL1-A extracts path and symbol citations and skips fences, URLs, commands and plain words', () => {
    const answer = [
      'See src/core/a/b.ts:12 and https://github.com/o/r/blob/main/y.md, Node.js and and/or.',
      '```ts',
      'hidden/inside.ts `hiddenSymbol`',
      '```',
      'Call `buildPhaseList()`, `git status`, `status` and `RUNBOOK.md`.',
    ].join('\n');
    expect(extractAnswerCitations(answer)).toEqual([
      { kind: 'symbol', text: 'buildPhaseList' },
      { kind: 'path', text: 'RUNBOOK.md' },
      { kind: 'path', text: 'src/core/a/b.ts', line: 12 },
    ]);
  });

  it('DL1-B grounds exact and suffix path matches', () => {
    const result = checkAnswerGrounding('`RUNBOOK.md` and core/a/b.ts', evidence);
    expect(result.status).toBe('grounded');
    expect(texts(result.grounded)).toEqual(['RUNBOOK.md', 'core/a/b.ts']);
  });

  it('DL1-C reports a path absent from the evidence', () => {
    const result = checkAnswerGrounding('Edit docs/missing.md first.', evidence);
    expect(result.status).toBe('ungrounded');
    expect(texts(result.ungrounded)).toEqual(['docs/missing.md']);
  });

  it('DL1-D grounds resolved symbols, including a qualified name, and reports unknown symbols', () => {
    const result = checkAnswerGrounding(
      '`buildPhaseList`, `Pipeline.buildPhaseList`, `ghostFn`',
      evidence,
    );
    expect(texts(result.grounded)).toEqual(['buildPhaseList', 'Pipeline.buildPhaseList']);
    expect(texts(result.ungrounded)).toEqual(['ghostFn']);
  });

  it('DL1-E marks ambiguous symbols unverifiable without changing status', () => {
    const result = checkAnswerGrounding('`LocalBackend` calls `buildPhaseList`.', evidence);
    expect(result.status).toBe('grounded');
    expect(texts(result.unverifiable)).toEqual(['LocalBackend']);
  });

  it('DL1-F bounds citations and answer size', () => {
    const many = Array.from({ length: 300 }, (_, index) => `dir/file${index}.ts`).join(' ');
    const result = checkAnswerGrounding(many, evidence);
    expect(result.ungrounded).toHaveLength(ANSWER_GROUNDING_MAX_CITATIONS);
    expect(result.truncated).toBe(true);
    expect(extractAnswerCitations(`${'a'.repeat(70000)} dir/late.ts`)).toEqual([]);
    expect(checkAnswerGrounding('no citations here', evidence).status).toBe('no-citations');
  });
});
```

Run (from `ontoindex/`):

```bash
npx vitest run test/unit/markdown-answer-grounding.test.ts
npx tsc --noEmit -p tsconfig.json
```

Expected: vitest prints `Tests  6 passed (6)`; `tsc` prints nothing and exits 0.

### DL-2.0: labelled evaluation

Files:

`ontoindex/test/unit/markdown-answer-grounding-eval.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import {
  checkAnswerGrounding,
  type GroundingEvidence,
} from '../../src/core/ingestion/enrichment/markdown-answer-grounding.js';

const evidence: GroundingEvidence = {
  docPaths: [
    'ontoindex/src/mcp/local/local-backend.ts',
    'ontoindex/src/core/ingestion/enrichment/markdown-query-ranking.ts',
    'RUNBOOK.md',
  ],
  mentionTargets: {
    rankMarkdownChunks: {
      status: 'resolved',
      targets: [
        {
          name: 'rankMarkdownChunks',
          filePath: 'ontoindex/src/core/ingestion/enrichment/markdown-query-ranking.ts',
        },
      ],
    },
    boundMarkdownFacts: {
      status: 'resolved',
      targets: [
        { name: 'boundMarkdownFacts', filePath: 'ontoindex/src/mcp/local/local-backend.ts' },
      ],
    },
    LocalBackend: { status: 'ambiguous', targets: [] },
  },
};

const faithful = [
  'Ranking lives in `rankMarkdownChunks` (src/core/ingestion/enrichment/markdown-query-ranking.ts:40).',
  'The response is capped by `boundMarkdownFacts` in ontoindex/src/mcp/local/local-backend.ts.',
  'See `RUNBOOK.md` for the sidecar steps; `LocalBackend` wires it together.',
  'No code is involved: rerun the sidecar and query again.',
];

const invented: { answer: string; citation: string }[] = [
  {
    answer: 'Ranking lives in src/core/ingestion/enrichment/markdown-query-ranker.ts.',
    citation: 'src/core/ingestion/enrichment/markdown-query-ranker.ts',
  },
  {
    answer: 'Call `rankMarkdownDocuments` before `boundMarkdownFacts`.',
    citation: 'rankMarkdownDocuments',
  },
  {
    answer: 'The limits are documented in `docs/markdown-limits.md`.',
    citation: 'docs/markdown-limits.md',
  },
  {
    answer: 'Facts are capped by `capMarkdownFacts` in local-backend.ts.',
    citation: 'capMarkdownFacts',
  },
];

describe('markdown answer grounding evaluation', () => {
  it('DL2-A faithful answers have no ungrounded citations', () => {
    for (const answer of faithful) {
      const result = checkAnswerGrounding(answer, evidence);
      expect(result.ungrounded, answer).toEqual([]);
      expect(['grounded', 'no-citations']).toContain(result.status);
    }
  });

  it('DL2-B every invented citation is reported', () => {
    for (const { answer, citation } of invented) {
      const result = checkAnswerGrounding(answer, evidence);
      expect(result.status, answer).toBe('ungrounded');
      expect(result.ungrounded.map((item) => item.text)).toContain(citation);
    }
  });

  it('DL2-C the number of checked citations is stable', () => {
    const total = [...faithful, ...invented.map((item) => item.answer)]
      .map((answer) => checkAnswerGrounding(answer, evidence))
      .reduce(
        (sum, result) =>
          sum + result.grounded.length + result.ungrounded.length + result.unverifiable.length,
        0,
      );
    expect(total).toBe(11);
  });
});
```

Run (from `ontoindex/`):

```bash
npx vitest run test/unit/markdown-answer-grounding-eval.test.ts test/unit/markdown-answer-grounding.test.ts
npx tsc --noEmit -p tsconfig.json
```

Expected: vitest prints `Test Files  2 passed (2)` and `Tests  9 passed (9)`; `tsc` exits 0.

### DL-3.0: measurement

Do not commit the script. Save it outside the repository as `/tmp/measure-answer-grounding.mts`:

```ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
const mod = await import(
  process.cwd() + '/ontoindex/src/core/ingestion/enrichment/markdown-answer-grounding.ts'
);
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const files = execFileSync(
  'git',
  ['ls-files', '.memory-bank/*.md', 'RUNBOOK.md', 'ontoindex/CHANGELOG.md'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean);
let paths = 0,
  ungrounded = 0;
const times: number[] = [];
const samples: string[] = [];
for (const file of files) {
  const t0 = performance.now();
  const r = mod.checkAnswerGrounding(readFileSync(file, 'utf8'), {
    docPaths: tracked,
    mentionTargets: {},
  });
  times.push(performance.now() - t0);
  const p = [...r.grounded, ...r.ungrounded].filter((c: any) => c.kind === 'path');
  const u = r.ungrounded.filter((c: any) => c.kind === 'path');
  paths += p.length;
  ungrounded += u.length;
  for (const c of u) if (samples.length < 15) samples.push(`${file}: ${c.text}`);
}
times.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    files: files.length,
    pathCitations: paths,
    ungroundedPaths: ungrounded,
    medianMs: +times[times.length >> 1].toFixed(2),
    maxMs: +times[times.length - 1].toFixed(2),
  }),
);
console.log(samples.join('\n'));
```

Run from the repository root, after DL-1.0 is merged:

```bash
npx --prefix ontoindex tsx /tmp/measure-answer-grounding.mts
```

The first output line is JSON with `files`, `pathCitations`, `ungroundedPaths`, `medianMs` and `maxMs`. The following lines are samples. The reference run on `1463494` printed `{"files":43,"pathCitations":271,"ungroundedPaths":44,"medianMs":0.28,"maxMs":5.26}`. Most samples were example paths inside plans (`docs/x.md`), which do not exist, so they are correct detections, not errors. The counts change whenever tracked Markdown changes, including this plan; do not treat a different number as a failure. Only the decision rule below matters.

Append this section to `.memory-bank/audit_session-markdown-graph-rag-recall.md`, filling in the values:

```markdown
## Answer grounding

Run on <commit> with `/tmp/measure-answer-grounding.mts` against `git ls-files`.

<JSON line, verbatim>

Samples (first 10):

<sample lines, verbatim>

Decision: <one sentence from the rule below>
```

Decision rule, applied mechanically with `share = ungroundedPaths / pathCitations`:

- `medianMs` is 20 or more: "Do not wire: too slow."
- otherwise `share` is above 0.25: "Do not wire: too many paths reported; plans cite example paths."
- otherwise: "Wiring is allowed in a separate plan; this plan does not wire it."

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REQ-001 | Adopt the donor's post-answer audit idea as a deterministic citation check | implementation | DL-1.0 | DL1-A through DL1-F |
| REQ-002 | Prove the check separates invented from faithful citations | compatibility-test | DL-2.0 | DL2-A through DL2-C |
| REQ-003 | Measure reported share and cost on the repository's own Markdown before any wiring | proof-only | DL-3.0 | Recorded Answer grounding section |
| REQ-004 | No donor code or data is copied | non-goal | DL-1.0 | Review of the diff; donor has no license |
| REQ-005 | Rejection log, absent-versus-unknown state, fact lifecycle, time-based forgetting, declarative rule files | rejected | DL-1.0 | Not built; reasons in Decisions |

## Decisions And Non-Goals

- Chosen: the answer-grounding check, because it needs no model, reuses evidence OntoIndex already returns, and is testable as a pure function. The other options were weaker.
- Rejected, rejection log: the Markdown producer is deterministic and has no model output to reject; recall losses come from ranking and caps, which `factsBound` already counts.
- Rejected, absent-versus-unknown state: Markdown facts are derived from document text, so there is no "checked and found absent" event to store; `RequirementTraceStatus` already has `missing`.
- Rejected, fact lifecycle and time-based forgetting: the index is commit-based, so freshness follows commits; a clock-based expiry would contradict that model.
- Rejected, declarative rule files: no rule set exists to externalize today.
- Wiring the checker into `query`, `docs` or any tool schema is out of scope; DL-3.0 only records whether a later plan may do it.
- Model budget: every task is copy, run and compare. A small model is enough; a stronger model is needed only if a stop condition fires.
- Plan files under `.memory-bank/` are written in the main session; the task write sets for code and test stay under `ontoindex/`.

## Closeout
Executed 2026-10-14 with two workers (`gpt-6-luna`, `gpt-6.1-sol`) copying the verified files.

| Task | Result | Evidence |
| --- | --- | --- |
| DL-1.0 | Done | Module and 6 tests copied verbatim; vitest 6 passed, `tsc` exit 0, Prettier clean (PR #108). |
| DL-2.0 | Done | Evaluation file copied verbatim; 9 tests across 2 files passed. |
| DL-3.0 | Done | 43 files, 270 path citations, 40 reported (0.148), median 0.27 ms, max 5.26 ms; decision: wiring allowed in a separate plan. Recorded in the audit-session file. |

The checker is not wired into any tool or response.
