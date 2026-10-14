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
