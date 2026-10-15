import { describe, expect, it } from 'vitest';
import { applyEnrichmentTokenBudget } from '../../src/mcp/local/enrichment-token-budget.js';
import { estimateJsonTokens } from '../../src/mcp/local/search-token-budget.js';

const budgetOf = (primary: Record<string, unknown>, core: Record<string, unknown>): number =>
  estimateJsonTokens(primary) + estimateJsonTokens(core);

describe('enrichment token budget', () => {
  it('returns results without enrichment unchanged', () => {
    const input = { result: 'ok', enrichment: { retrievalPolicy: 'graph-only' } };
    expect(applyEnrichmentTokenBudget(input, 1)).toBe(input);
    expect(applyEnrichmentTokenBudget('not an object', 1)).toBe('not an object');
  });

  it('keeps everything under a large budget', () => {
    const result = applyEnrichmentTokenBudget(
      {
        enrichment: {
          relatedDocs: [{ doc: 'd1' }],
          relatedChunks: [{ chunk: 'c1' }],
          visibleRecords: [{ record: 'r1' }],
          facts: [{ fact: 'f1' }],
        },
      },
      100000,
    ) as any;

    expect(result.enrichment.relatedDocs).toHaveLength(1);
    expect(result.enrichment.relatedChunks).toHaveLength(1);
    expect(result.enrichment.visibleRecords).toHaveLength(1);
    expect(result.enrichment.facts).toHaveLength(1);
    expect(result.enrichment.budget.truncated).toBe(false);
  });

  it('keeps mentionTargets when the budget is large', () => {
    const mentionTarget = { target: 'symbol' };
    const result = applyEnrichmentTokenBudget(
      { enrichment: { mentionTargets: [mentionTarget] } },
      100000,
    ) as any;

    expect(result.enrichment.mentionTargets).toEqual([mentionTarget]);
    expect(result.enrichment.budget.mention_targets_dropped).toBe(0);
    expect(result.enrichment.budget.truncated).toBe(false);
  });

  it('drops mentionTargets after facts when the budget is short', () => {
    const primary = { query: 'q' };
    const core = { retrievalPolicy: 'graph-only' };
    const fact = { fact: 'f' };
    const mentionTarget = { target: 'symbol' };
    const budget = budgetOf(primary, core) + estimateJsonTokens(fact) + 1;
    const result = applyEnrichmentTokenBudget(
      {
        ...primary,
        enrichment: {
          ...core,
          relatedDocs: [],
          relatedChunks: [],
          visibleRecords: [],
          facts: [fact],
          mentionTargets: [mentionTarget],
        },
      },
      budget,
    ) as any;

    expect(result.enrichment.facts).toEqual([fact]);
    expect(result.enrichment.mentionTargets).toEqual([]);
    expect(result.enrichment.budget.mention_targets_dropped).toBe(1);
    expect(result.enrichment.budget.truncated).toBe(true);
  });

  it('does not add absent array keys to the output', () => {
    const result = applyEnrichmentTokenBudget({ enrichment: { relatedDocs: [] } }, 100000) as any;

    for (const key of ['relatedChunks', 'visibleRecords', 'facts', 'mentionTargets']) {
      expect(Object.hasOwn(result.enrichment, key)).toBe(false);
    }
  });

  it('spends the budget in priority order', () => {
    const primary = { query: 'q' };
    const core = { retrievalPolicy: 'graph-only' };
    const relatedDoc = { doc: 'd' };
    const relatedChunk = { chunk: 'c' };
    const input = {
      ...primary,
      enrichment: {
        ...core,
        relatedDocs: [relatedDoc],
        relatedChunks: [relatedChunk],
        visibleRecords: [{ record: 'r' }],
        facts: [{ fact: 'f' }],
      },
    };
    const budget =
      budgetOf(primary, core) +
      (estimateJsonTokens(relatedDoc) + 1) * 2 +
      estimateJsonTokens(relatedChunk) +
      1;
    const result = applyEnrichmentTokenBudget(input, budget) as any;

    expect(result.enrichment.relatedDocs).toEqual([relatedDoc]);
    expect(result.enrichment.relatedChunks).toEqual([relatedChunk]);
    expect(result.enrichment.visibleRecords).toEqual([]);
    expect(result.enrichment.facts).toEqual([]);
    expect(result.enrichment.budget.visible_records_dropped).toBe(1);
    expect(result.enrichment.budget.facts_dropped).toBe(1);
  });

  it('counts relatedDocs twice', () => {
    const primary = { query: 'q' };
    const core = { retrievalPolicy: 'graph-only' };
    const relatedDoc = { doc: 'd' };
    const budget = budgetOf(primary, core) + estimateJsonTokens(relatedDoc) + 1;
    const result = applyEnrichmentTokenBudget(
      { ...primary, enrichment: { ...core, relatedDocs: [relatedDoc] } },
      budget,
    ) as any;

    expect(result.enrichment.relatedDocs).toEqual([]);
    expect(result.enrichment.budget.related_docs_dropped).toBe(1);
  });

  it('keeps nothing when the core alone exceeds the budget', () => {
    const primary = { query: 'q' };
    const core = { explanation: 'x'.repeat(1000) };
    const input = {
      ...primary,
      enrichment: {
        ...core,
        relatedDocs: [{ doc: 'd' }],
        relatedChunks: [{ chunk: 'c' }],
        visibleRecords: [{ record: 'r' }],
        facts: [{ fact: 'f' }],
      },
    };
    const result = applyEnrichmentTokenBudget(input, budgetOf(primary, core) - 1) as any;

    expect(result.enrichment.relatedDocs).toEqual([]);
    expect(result.enrichment.relatedChunks).toEqual([]);
    expect(result.enrichment.visibleRecords).toEqual([]);
    expect(result.enrichment.facts).toEqual([]);
    expect(result.enrichment.budget.remaining_before).toBeLessThan(0);
  });

  it('stops each array at the first item that does not fit', () => {
    const primary = { query: 'q' };
    const core = { retrievalPolicy: 'graph-only' };
    const large = { value: 'x'.repeat(1000) };
    const small = { value: 's' };
    const input = {
      ...primary,
      enrichment: {
        ...core,
        relatedDocs: [large, small],
        relatedChunks: [large, small],
        visibleRecords: [large, small],
        facts: [large, small],
      },
    };
    const smallCost = estimateJsonTokens(small) + 1;
    const result = applyEnrichmentTokenBudget(
      input,
      budgetOf(primary, core) + smallCost * 5,
    ) as any;

    expect(result.enrichment.relatedDocs).toEqual([]);
    expect(result.enrichment.relatedChunks).toEqual([]);
    expect(result.enrichment.visibleRecords).toEqual([]);
    expect(result.enrichment.facts).toEqual([]);
    expect(result.enrichment.budget.related_docs_dropped).toBe(2);
    expect(result.enrichment.budget.related_chunks_dropped).toBe(2);
    expect(result.enrichment.budget.visible_records_dropped).toBe(2);
    expect(result.enrichment.budget.facts_dropped).toBe(2);
  });

  it('preserves unrelated enrichment keys and does not mutate the input', () => {
    const input = {
      query: 'q',
      enrichment: {
        retrievalPolicy: { name: 'policy' },
        explanation: { text: 'why' },
        summary: { count: 1 },
        factsBound: true,
        relatedSymbols: ['symbol'],
        relatedFacts: [{ id: 'fact' }],
        relatedIdentities: [{ id: 'identity' }],
        relatedDocs: [{ doc: 'd' }],
        relatedChunks: [{ chunk: 'c' }],
      },
    };
    const before = structuredClone(input);
    const result = applyEnrichmentTokenBudget(input, 1) as any;

    expect(input).toEqual(before);
    expect(result).not.toBe(input);
    expect(result.enrichment).not.toBe(input.enrichment);
    expect(result.enrichment).toMatchObject({
      retrievalPolicy: before.enrichment.retrievalPolicy,
      explanation: before.enrichment.explanation,
      summary: before.enrichment.summary,
      factsBound: before.enrichment.factsBound,
      relatedSymbols: before.enrichment.relatedSymbols,
      relatedFacts: before.enrichment.relatedFacts,
      relatedIdentities: before.enrichment.relatedIdentities,
    });
    expect(result.enrichment.relatedDocs).not.toBe(input.enrichment.relatedDocs);
    expect(result.enrichment.relatedChunks).not.toBe(input.enrichment.relatedChunks);
  });
});
