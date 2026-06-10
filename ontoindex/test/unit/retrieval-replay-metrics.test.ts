import { describe, expect, it } from 'vitest';

import { computeRetrievalReplayMovementMetrics } from '../../src/core/search/replay/replay-metrics.js';
import { RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION, type RetrievalReplayCaseV1 } from '../../src/core/search/replay/replay-case.js';

function makeCase(overrides: Partial<RetrievalReplayCaseV1>): RetrievalReplayCaseV1 {
  return {
    schemaVersion: RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION,
    id: 'case-metrics',
    query: 'query',
    request: { action: 'semantic' },
    expected: {
      topK: 3,
      identities: [
        { kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' },
        { kind: 'file', filePath: 'b.ts' },
        { kind: 'route', name: '/health' },
      ],
    },
    ...overrides,
  } as RetrievalReplayCaseV1;
}

describe('retrieval replay movement metrics', () => {
  it('computes stable movement on exact matches', () => {
    const caseInput = makeCase({
      expected: {
        topK: 2,
        identities: [
          { kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' },
          { kind: 'file', filePath: 'b.ts' },
        ],
      },
    });

    const metrics = computeRetrievalReplayMovementMetrics({
      caseInput,
      actual: [
        { kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' },
        { kind: 'file', filePath: 'b.ts' },
        { kind: 'route', name: '/extra' },
      ],
      elapsedMs: 120,
      baselineElapsedMs: 100,
      indexFreshness: 'fresh',
    });

    expect(metrics.jaccardAtK).toBe(1);
    expect(metrics.top1Stable).toBe(true);
    expect(metrics.rankDelta).toBe(0);
    expect(metrics.missingExpected).toBe(0);
    expect(metrics.newUnexpected).toBe(0);
    expect(metrics.capabilityDrift).toBe(false);
    expect(metrics.freshnessDrift).toBe(false);
    expect(metrics.latencyDeltaMs).toBe(20);
  });

  it('treats unknown actual top-1 as unstable against known expected top-1', () => {
    const caseInput = makeCase({
      expected: {
        topK: 1,
        identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      },
    });

    const metrics = computeRetrievalReplayMovementMetrics({
      caseInput,
      actual: [{ kind: 'unknown', reason: 'collapsed' }],
      elapsedMs: 50,
      baselineElapsedMs: 60,
      indexFreshness: 'fresh',
    });

    expect(metrics.top1Stable).toBe(false);
    expect(metrics.jaccardAtK).toBe(0);
    expect(metrics.missingExpected).toBe(1);
    expect(metrics.newUnexpected).toBe(1);
  });

  it('flags capability and freshness drift separately', () => {
    const caseInput = makeCase({
      expected: {
        topK: 2,
        identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
        allowedCapabilityDrift: ['sidecar'],
      },
    });

    const metrics = computeRetrievalReplayMovementMetrics({
      caseInput,
      actual: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      elapsedMs: 30,
      baselineElapsedMs: 30,
      missingCapabilities: ['sidecar', 'embeddings'],
      indexFreshness: 'stale',
    });

    expect(metrics.capabilityDrift).toBe(true);
    expect(metrics.freshnessDrift).toBe(true);
    expect(metrics.warnings).toContain('missing required capabilities: embeddings');
    expect(metrics.warnings).toContain('index freshness drift: stale');
  });

  it('warns when baseline latency is not supplied', () => {
    const caseInput = makeCase({
      expected: {
        topK: 1,
        identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      },
    });

    const metrics = computeRetrievalReplayMovementMetrics({
      caseInput,
      actual: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      elapsedMs: 35,
      indexFreshness: 'fresh',
    });

    expect(metrics.latencyDeltaMs).toBe(0);
    expect(metrics.warnings).toContain('baseline latency not supplied; latencyDeltaMs reported as 0');
  });
});
