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
