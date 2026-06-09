import { describe, expect, it } from 'vitest';
import {
  addQueryBudgetDegradedReason,
  addQueryBudgetStep,
  addQueryBudgetTruncatedReason,
  createQueryBudgetSnapshot,
  createQueryTokenCostSnapshot,
  finishQueryBudgetSnapshot,
  setQueryBudgetFallback,
  updateQueryBudgetSnapshot,
} from '../../src/core/runtime/query-budget.js';

describe('query budget snapshot', () => {
  it('creates compact defaults', () => {
    expect(createQueryBudgetSnapshot()).toEqual({
      truncated: false,
      truncatedReasons: [],
      degradedReasons: [],
    });
  });

  it('records unique truncation reasons and marks the snapshot truncated', () => {
    const snapshot = addQueryBudgetTruncatedReason(
      addQueryBudgetTruncatedReason(createQueryBudgetSnapshot(), ' candidate-limit '),
      'candidate-limit',
    );

    expect(snapshot).toEqual({
      truncated: true,
      truncatedReasons: ['candidate-limit'],
      degradedReasons: [],
    });
  });

  it('records unique degraded reasons without marking the snapshot truncated', () => {
    const snapshot = addQueryBudgetDegradedReason(
      addQueryBudgetDegradedReason(createQueryBudgetSnapshot(), ' docs-sidecar-missing '),
      'docs-sidecar-missing',
    );

    expect(snapshot).toEqual({
      truncated: false,
      truncatedReasons: [],
      degradedReasons: ['docs-sidecar-missing'],
    });
  });

  it('records elapsed timing from explicit timestamps', () => {
    const snapshot = finishQueryBudgetSnapshot(createQueryBudgetSnapshot(), {
      startedAtMs: 100,
      finishedAtMs: 175.9,
    });

    expect(snapshot.elapsedMs).toBe(75);
  });

  it('records fallback paths', () => {
    const snapshot = setQueryBudgetFallback(
      createQueryBudgetSnapshot({ maxCandidates: 50 }),
      'bm25-only',
    );

    expect(snapshot).toEqual({
      maxCandidates: 50,
      truncated: false,
      truncatedReasons: [],
      degradedReasons: [],
      fallback: 'bm25-only',
    });
  });

  it('records compact step snapshots', () => {
    const snapshot = addQueryBudgetStep(createQueryBudgetSnapshot(), {
      name: ' graph-neighborhood ',
      elapsedMs: 88.7,
      emitted: 12,
      limit: 25,
      truncated: false,
    });

    expect(snapshot).toEqual({
      truncated: false,
      truncatedReasons: [],
      degradedReasons: [],
      steps: [
        {
          name: 'graph-neighborhood',
          elapsedMs: 88,
          emitted: 12,
          limit: 25,
        },
      ],
    });
  });

  it('treats truncated step snapshots as truncated output', () => {
    const snapshot = createQueryBudgetSnapshot({
      steps: [{ name: 'ranking', emitted: 25, limit: 25, truncated: true }],
    });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.steps).toEqual([{ name: 'ranking', emitted: 25, limit: 25, truncated: true }]);
  });

  it('updates snapshots while preserving compact output', () => {
    const snapshot = updateQueryBudgetSnapshot(
      createQueryBudgetSnapshot({
        maxDepth: 2,
        maxNodes: -1,
        timeoutMs: Number.POSITIVE_INFINITY,
        truncatedReasons: [' candidate-limit ', ''],
      }),
      {
        emitted: 10.9,
        degradedReasons: ['embeddings-unavailable'],
        steps: [{ name: 'bm25', elapsedMs: 42, emitted: 10 }],
      },
    );

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual({
      maxDepth: 2,
      emitted: 10,
      truncated: true,
      truncatedReasons: ['candidate-limit'],
      degradedReasons: ['embeddings-unavailable'],
      steps: [{ name: 'bm25', elapsedMs: 42, emitted: 10 }],
    });
  });

  it('computes configured token cost without estimating missing usage', () => {
    const snapshot = createQueryBudgetSnapshot({
      tokenCost: {
        usage: {
          inputTokens: 1000.9,
          outputTokens: 500,
          source: 'provider-usage',
        },
        pricing: {
          inputUsdPerMillionTokens: 2.5,
          outputUsdPerMillionTokens: 10,
          source: 'test-config',
          model: 'named-model',
        },
      },
    });

    expect(snapshot.tokenCost).toEqual({
      status: 'available',
      reason: 'token-cost-computed-from-config',
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        source: 'provider-usage',
      },
      pricing: {
        inputUsdPerMillionTokens: 2.5,
        outputUsdPerMillionTokens: 10,
        currency: 'USD',
        source: 'test-config',
        model: 'named-model',
      },
      costUsd: 0.0075,
      warnings: [],
    });
  });

  it('surfaces unknown token cost when pricing is absent', () => {
    expect(
      createQueryTokenCostSnapshot({
        usage: { inputTokens: 100, outputTokens: 25, source: 'provider-usage' },
      }),
    ).toEqual({
      status: 'unknown',
      reason: 'pricing-not-configured',
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        source: 'provider-usage',
      },
      warnings: ['Token/USD cost unknown: pricing-not-configured.'],
    });
  });

  it('surfaces unavailable token cost when no metadata is supplied', () => {
    expect(createQueryTokenCostSnapshot()).toEqual({
      status: 'unavailable',
      reason: 'token-cost-metadata-not-supplied',
      warnings: ['Token/USD cost unavailable: token-cost-metadata-not-supplied.'],
    });
  });
});
