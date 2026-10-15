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
    const first = { content: 'a'.repeat(40) };
    const input = {
      definitions: [first, { content: 'b'.repeat(4000) }, { content: 'c'.repeat(40) }],
    };
    const baseTokens = estimateJsonTokens({ ...input, process_symbols: [], definitions: [] });
    const budget = baseTokens + estimateJsonTokens(first) + 1;
    const result = applySearchTokenBudget(input, budget);
    expect(result.definitions).toEqual([first]);
    expect(result.budget.dropped_definitions).toBe(2);
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
