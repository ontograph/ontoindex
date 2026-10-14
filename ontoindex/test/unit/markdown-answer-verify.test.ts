import { describe, expect, it } from 'vitest';

import type { GraphIdentityProvider } from '../../src/core/ingestion/enrichment/markdown-graph-identity-provider.js';
import { verifyAnswer } from '../../src/core/ingestion/enrichment/markdown-answer-verify.js';

const provider = (
  findSymbols: Pick<GraphIdentityProvider, 'findSymbols'>['findSymbols'],
): Pick<GraphIdentityProvider, 'findSymbols'> => ({ findSymbols });

const texts = (citations: { text: string }[]) => citations.map(({ text }) => text);

describe('verify answer', () => {
  it('AV1-A marks missing paths ungrounded and symbols unverifiable without a provider', async () => {
    const result = await verifyAnswer({
      answer: '`missing.ts` and `ghostFn`',
      paths: [],
    });

    expect(result.symbolCheck).toBe('skipped');
    expect(result.status).toBe('ungrounded');
    expect(texts(result.ungrounded)).toEqual(['missing.ts']);
    expect(texts(result.unverifiable)).toEqual(['ghostFn']);
  });

  it('AV1-B grounds a found symbol and reports a missing symbol', async () => {
    const result = await verifyAnswer({
      answer: '`buildPhaseList` and `ghostFn`',
      paths: [],
      provider: provider(async ({ mention }) =>
        mention === 'buildPhaseList'
          ? [
              {
                type: 'symbol',
                id: 'symbol:buildPhaseList',
                name: 'buildPhaseList',
                filePath: 'src/pipeline.ts',
                startLine: 12,
                confidence: 1,
              },
            ]
          : [],
      ),
    });

    expect(result.symbolCheck).toBe('ok');
    expect(result.status).toBe('ungrounded');
    expect(texts(result.grounded)).toEqual(['buildPhaseList']);
    expect(texts(result.ungrounded)).toEqual(['ghostFn']);
  });

  it('AV1-C makes symbols unverifiable on provider failure while keeping paths grounded', async () => {
    const result = await verifyAnswer({
      answer: '`src/known.ts` and `buildPhaseList`',
      paths: ['src/known.ts'],
      provider: provider(async () => {
        throw new Error('provider unavailable');
      }),
    });

    expect(result.symbolCheck).toBe('partial');
    expect(result.status).toBe('grounded');
    expect(texts(result.grounded)).toEqual(['src/known.ts']);
    expect(texts(result.unverifiable)).toEqual(['buildPhaseList']);
  });

  it('AV1-D does not look up symbols when the answer cites only paths', async () => {
    let calls = 0;
    const result = await verifyAnswer({
      answer: '`src/known.ts`',
      paths: ['src/known.ts'],
      provider: provider(async () => {
        calls++;
        return [];
      }),
    });

    expect(calls).toBe(0);
    expect(result.symbolCheck).toBe('ok');
    expect(result.status).toBe('grounded');
    expect(result.pathsKnown).toBe(1);
  });

  it('AV1-E marks symbols past the distinct lookup cap unverifiable', async () => {
    const symbols = Array.from({ length: 45 }, (_, index) => `\`SymbolA${index}\``).join(' ');
    const result = await verifyAnswer({
      answer: symbols,
      paths: [],
      provider: provider(async () => []),
    });

    expect(result.symbolCheck).toBe('ok');
    expect(result.ungrounded).toEqual([]);
    expect(result.unverifiable).toHaveLength(45);
    expect(result.status).toBe('grounded');
  });

  it('AV1-F returns no-citations when the answer has no citations', async () => {
    const result = await verifyAnswer({ answer: 'Plain prose only.', paths: [] });

    expect(result.status).toBe('no-citations');
    expect(result.symbolCheck).toBe('skipped');
    expect(result.pathsKnown).toBe(0);
  });
});
