import { describe, expect, it } from 'vitest';
import {
  applySearchTokenBudget,
  estimateJsonTokens,
} from '../../src/mcp/local/search-token-budget.js';

describe('search token budget', () => {
  it('returns non-search values unchanged', () => {
    const input = { error: 'x' };
    expect(applySearchTokenBudget(input, 1)).toEqual(input);
    expect(applySearchTokenBudget(input, 1)).not.toHaveProperty('budget');
  });

  it('keeps everything under a large budget', () => {
    const result = applySearchTokenBudget(
      {
        process_symbols: [{ name: 'p1' }, { name: 'p2' }, { name: 'p3' }],
        definitions: [{ name: 'd1' }, { name: 'd2' }, { name: 'd3' }],
      },
      100000,
    );
    expect(result.process_symbols).toHaveLength(3);
    expect(result.definitions).toHaveLength(3);
    expect(result.budget.truncated).toBe(false);
    expect(result.budget.over_budget).toBe(false);
  });

  it('trims in rank order and stops at the first item that does not fit', () => {
    const first = { detail: 'a'.repeat(40) };
    const input = {
      definitions: [first, { detail: 'b'.repeat(4000) }, { detail: 'c'.repeat(40) }],
    };
    const baseTokens = estimateJsonTokens({ ...input, process_symbols: [], definitions: [] });
    const budget = baseTokens + estimateJsonTokens(first) + 1;
    const result = applySearchTokenBudget(input, budget);
    expect(result.definitions).toEqual([first]);
    expect(result.budget.dropped_definitions).toBe(2);
  });

  it('strips content from the lowest-ranked items first', () => {
    const input = {
      process_symbols: [{ name: 'p', content: 'p'.repeat(1200) }],
      definitions: [1, 2, 3].map((rank) => ({ name: `d${rank}`, content: 'x'.repeat(1200) })),
    };
    const before = structuredClone(input);
    const base = { ...input, process_symbols: [], definitions: [] };
    const budget =
      estimateJsonTokens(base) +
      estimateJsonTokens(input.process_symbols[0]) +
      1 +
      estimateJsonTokens(input.definitions[0]) +
      1 +
      input.definitions
        .slice(1)
        .reduce((sum, item) => sum + estimateJsonTokens({ name: item.name }) + 1, 0);
    const result = applySearchTokenBudget(input, budget);
    expect(result.definitions).toEqual([input.definitions[0], { name: 'd2' }, { name: 'd3' }]);
    expect(result.process_symbols).toEqual(input.process_symbols);
    expect(result.budget.content_stripped).toBe(2);
    expect(result.budget.dropped_definitions).toBe(0);
    expect(result.budget.truncated).toBe(true);
    expect(input).toEqual(before);
  });

  it('drops items only after content is exhausted', () => {
    const input = {
      process_symbols: [{ name: 'p', content: 'p'.repeat(1200) }],
      definitions: [
        { name: 'd1', content: 'x'.repeat(1200) },
        { name: 'd2', content: 'y'.repeat(1200) },
      ],
    };
    const budget =
      estimateJsonTokens({ ...input, process_symbols: [], definitions: [] }) +
      estimateJsonTokens({ name: 'p' }) +
      1 +
      estimateJsonTokens({ name: 'd1' }) +
      1;
    const result = applySearchTokenBudget(input, budget);
    expect(result.process_symbols).toEqual([{ name: 'p' }]);
    expect(result.definitions).toEqual([{ name: 'd1' }]);
    expect(result.budget.dropped_definitions).toBe(1);
    expect(result.budget.content_stripped).toBe(3);
  });

  it('reports content_stripped as 0 when everything fits', () => {
    const input = { definitions: [{ name: 'd', content: 'x'.repeat(1200) }] };
    const result = applySearchTokenBudget(input, 100000);
    expect(result.definitions).toEqual(input.definitions);
    expect(result.budget.content_stripped).toBe(0);
    expect(result.budget.truncated).toBe(false);
  });

  it('fills process_symbols before definitions', () => {
    const result = applySearchTokenBudget(
      { process_symbols: [{ name: 'p' }], definitions: [{ name: 'd' }] },
      6,
    );
    expect(result.process_symbols).toEqual([{ name: 'p' }]);
    expect(result.definitions).toEqual([]);
  });

  it('keeps one item when the budget is smaller than the first item', () => {
    const result = applySearchTokenBudget({ process_symbols: [{ name: 'large' }] }, 1);
    expect(result.process_symbols).toEqual([{ name: 'large' }]);
    expect(result.budget.over_budget).toBe(true);
  });

  it('drops skeletons when the base alone exceeds the budget', () => {
    const result = applySearchTokenBudget(
      { skeletons: [{ content: 'x'.repeat(100) }], definitions: [{ name: 'd' }] },
      1,
    );
    expect(result).not.toHaveProperty('skeletons');
    expect(result.budget.skeletons_dropped).toBe(true);
  });

  it('does not mutate the input', () => {
    const input = {
      skeletons: [{ name: 's' }],
      process_symbols: [{ name: 'p' }],
      definitions: [{ name: 'd' }],
    };
    const before = structuredClone(input);
    applySearchTokenBudget(input, 1);
    expect(input).toEqual(before);
  });
});
