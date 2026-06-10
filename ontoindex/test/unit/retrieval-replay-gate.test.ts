import { describe, expect, it } from 'vitest';

import { evaluateRetrievalReplayGate } from '../../src/core/search/replay/replay-gate.js';
import {
  RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION,
  type RetrievalReplayCaseV1,
} from '../../src/core/search/replay/replay-case.js';

function makeCase(overrides: Partial<RetrievalReplayCaseV1>): RetrievalReplayCaseV1 {
  return {
    schemaVersion: RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION,
    id: 'case-gate',
    query: 'query',
    request: { action: 'semantic' },
    expected: {
      topK: 2,
      identities: [
        { kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' },
        { kind: 'file', filePath: 'b.ts' },
      ],
    },
    ...overrides,
  } as RetrievalReplayCaseV1;
}

describe('retrieval replay gate', () => {
  it('warns on baseline invalid with reasons without conflating with pass', () => {
    const caseInput = makeCase({});
    const result = evaluateRetrievalReplayGate({
      caseInput,
      baselineInvalid: true,
      baselineInvalidReasons: ['baseline drifted'],
      metrics: {
        jaccardAtK: 1,
        top1Stable: true,
        rankDelta: 0,
        missingExpected: 0,
        newUnexpected: 0,
        capabilityDrift: false,
        freshnessDrift: false,
        latencyDeltaMs: 0,
        warnings: [],
      },
    });

    expect(result.status).toBe('baseline_invalid');
    expect(result.verdict).toBe('WARN');
    expect(result.reasons).toContain('baseline drifted');
    expect(result.reasons).toContain(
      'baseline_invalid: unable to compare against baseline snapshot assumptions',
    );
  });

  it('keeps baseline_invalid as a separate status when movement also fails', () => {
    const caseInput = makeCase({
      expected: {
        topK: 1,
        requireTop1Stable: true,
        identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      },
    });

    const result = evaluateRetrievalReplayGate({
      caseInput,
      baselineInvalid: true,
      metrics: {
        jaccardAtK: 0,
        top1Stable: false,
        rankDelta: 1,
        missingExpected: 1,
        newUnexpected: 0,
        capabilityDrift: false,
        freshnessDrift: false,
        latencyDeltaMs: 0,
        warnings: [],
      },
    });

    expect(result.status).toBe('baseline_invalid');
    expect(result.verdict).toBe('FAIL');
    expect(result.reasons).toContain('top1 changed');
  });

  it('fails when required top-1 identity changes', () => {
    const caseInput = makeCase({
      expected: {
        topK: 1,
        requireTop1Stable: true,
        identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      },
    });

    const result = evaluateRetrievalReplayGate({
      caseInput,
      metrics: {
        jaccardAtK: 0,
        top1Stable: false,
        rankDelta: 2,
        missingExpected: 1,
        newUnexpected: 0,
        capabilityDrift: false,
        freshnessDrift: false,
        latencyDeltaMs: 0,
        warnings: [],
      },
    });

    expect(result.verdict).toBe('FAIL');
    expect(result.status).toBe('ok');
    expect(result.reasons).toContain('top1 changed');
  });

  it('warns on stale index or missing required capabilities even with no movement failures', () => {
    const caseInput = makeCase({
      expected: {
        topK: 1,
        allowedCapabilityDrift: ['sidecar'],
        identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      },
    });

    const missingCapabilitiesResult = evaluateRetrievalReplayGate({
      caseInput,
      metrics: {
        jaccardAtK: 1,
        top1Stable: true,
        rankDelta: 0,
        missingExpected: 0,
        newUnexpected: 0,
        capabilityDrift: true,
        freshnessDrift: false,
        latencyDeltaMs: 0,
        warnings: [],
      },
      missingCapabilities: ['embeddings'],
      indexFreshness: 'fresh',
    });

    expect(missingCapabilitiesResult.verdict).toBe('WARN');
    expect(missingCapabilitiesResult.reasons).toContain('missing required capabilities: embeddings');

    const staleIndexResult = evaluateRetrievalReplayGate({
      caseInput,
      metrics: {
        jaccardAtK: 1,
        top1Stable: true,
        rankDelta: 0,
        missingExpected: 0,
        newUnexpected: 0,
        capabilityDrift: false,
        freshnessDrift: true,
        latencyDeltaMs: 0,
        warnings: [],
      },
      indexFreshness: 'stale',
    });

    expect(staleIndexResult.verdict).toBe('WARN');
    expect(staleIndexResult.reasons).toContain('index freshness is stale');
  });

  it('passes when movement is within thresholds and no drift', () => {
    const caseInput = makeCase({
      expected: {
        topK: 2,
        minimumJaccardAtK: 0.5,
        identities: [
          { kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' },
          { kind: 'file', filePath: 'b.ts' },
        ],
      },
    });

    const result = evaluateRetrievalReplayGate({
      caseInput,
      metrics: {
        jaccardAtK: 1,
        top1Stable: false,
        rankDelta: 0,
        missingExpected: 0,
        newUnexpected: 0,
        capabilityDrift: false,
        freshnessDrift: false,
        latencyDeltaMs: 0,
        warnings: [],
      },
      indexFreshness: 'fresh',
    });

    expect(result.verdict).toBe('PASS');
    expect(result.status).toBe('ok');
    expect(result.reasons).toEqual([]);
  });
});
