import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/passive-retrieval/graph-expansion-basic.json' with { type: 'json' };
import markdownFixture from '../fixtures/markdown-rag-retrieval/quality-basic.json' with { type: 'json' };
import {
  evaluatePassiveRetrievalQuality,
  type PassiveRetrievalQualityFixture,
} from '../../src/core/ingestion/enrichment/index.js';

const qualityFixture = fixture.qualityFixture as PassiveRetrievalQualityFixture;
const markdownQualityFixture = markdownFixture.qualityFixture as PassiveRetrievalQualityFixture;

describe('passive retrieval quality', () => {
  it('measures default retrieval separately from opt-in passive expansion', () => {
    const result = evaluatePassiveRetrievalQuality(qualityFixture);

    expect(result.fixtureName).toBe('graph-expansion-basic');
    expect(result.defaultRetrieval).toMatchObject({
      scope: 'default',
      caseCount: 2,
      passedCaseCount: 2,
      recallAtK: 1,
    });
    expect(result.optInPassiveRetrieval).toMatchObject({
      scope: 'opt-in-passive',
      caseCount: 2,
      passedCaseCount: 2,
      recallAtK: 1,
    });
    expect(result.passed).toBe(true);
  });

  it('fails the gate when a ranking change pushes an expected result outside topK', () => {
    const result = evaluatePassiveRetrievalQuality({
      ...qualityFixture,
      optInPassiveCases: [
        {
          name: 'passive symbol expansion recall',
          topK: 1,
          expectedResultIds: ['Function:src/billing/invoice.ts:createInvoice'],
          actualResultIds: [
            'Function:src/orders/service.ts:createOrder',
            'Function:src/billing/invoice.ts:createInvoice',
          ],
        },
      ],
    });

    expect(result.defaultRetrieval.passedCaseCount).toBe(2);
    expect(result.optInPassiveRetrieval.passedCaseCount).toBe(0);
    expect(result.optInPassiveRetrieval.recallAtK).toBe(0);
    expect(result.optInPassiveRetrieval.cases[0]).toMatchObject({
      hitResultIds: [],
      missingResultIds: ['Function:src/billing/invoice.ts:createInvoice'],
      passed: false,
    });
    expect(result.passed).toBe(false);
  });

  it('deduplicates actual results before computing Recall@k', () => {
    const result = evaluatePassiveRetrievalQuality({
      name: 'dedupe',
      defaultCases: [
        {
          name: 'duplicate default hit',
          topK: 2,
          expectedResultIds: ['src/orders/service.ts', 'src/billing/invoice.ts'],
          actualResultIds: [
            'src/orders/service.ts',
            'src/orders/service.ts',
            'src/billing/invoice.ts',
          ],
        },
      ],
      optInPassiveCases: [],
    });

    expect(result.defaultRetrieval.cases[0]).toMatchObject({
      actualTopKResultIds: ['src/orders/service.ts', 'src/billing/invoice.ts'],
      recall: 1,
      passed: true,
    });
  });

  it('checks markdown citation hits and multi-hop intermediate evidence separately', () => {
    const result = evaluatePassiveRetrievalQuality(markdownQualityFixture);

    expect(result.fixtureName).toBe('markdown-rag-quality-basic');
    expect(result.defaultRetrieval).toMatchObject({
      caseCount: 1,
      passedCaseCount: 1,
      recallAtK: 1,
    });
    expect(result.optInPassiveRetrieval).toMatchObject({
      caseCount: 2,
      passedCaseCount: 2,
      recallAtK: 1,
    });
    expect(result.optInPassiveRetrieval.cases[0]).toMatchObject({
      citationHitRate: 1,
      missingCitations: [],
    });
    expect(result.optInPassiveRetrieval.cases[1]).toMatchObject({
      hitIntermediateEvidenceIds: [
        'entity:checkout',
        'mention:Function:src/billing/invoice.ts:createInvoice',
      ],
      missingIntermediateEvidenceIds: [],
      citationHitRate: 1,
    });
    expect(result.passed).toBe(true);
  });

  it('fails markdown quality when citations or intermediate evidence drift', () => {
    const result = evaluatePassiveRetrievalQuality({
      ...markdownQualityFixture,
      defaultCases: [],
      optInPassiveCases: [
        {
          ...markdownQualityFixture.optInPassiveCases[1],
          actualCitations: [],
          actualIntermediateEvidenceIds: ['entity:checkout'],
        },
      ],
    });

    expect(result.optInPassiveRetrieval.passedCaseCount).toBe(0);
    expect(result.optInPassiveRetrieval.cases[0]).toMatchObject({
      missingIntermediateEvidenceIds: ['mention:Function:src/billing/invoice.ts:createInvoice'],
      citationHitRate: 0,
      passed: false,
    });
    expect(result.optInPassiveRetrieval.cases[0].missingCitations).toHaveLength(1);
    expect(result.passed).toBe(false);
  });
});
