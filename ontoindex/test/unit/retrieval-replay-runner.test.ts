import { describe, expect, it } from 'vitest';

import type { RetrievalReplayExecutor, RetrievalReplayExecutorRun } from '../../src/core/search/replay/replay-runner.js';
import { replayRetrievalCases } from '../../src/core/search/replay/replay-runner.js';
import { RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION, type RetrievalReplayCaseV1 } from '../../src/core/search/replay/replay-case.js';

function makeCase(overrides: Partial<RetrievalReplayCaseV1> = {}): RetrievalReplayCaseV1 {
  return {
    schemaVersion: RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION,
    id: 'case-runner',
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

function makeExecutor(run: Omit<RetrievalReplayExecutorRun, 'identities'> & { identities?: RetrievalReplayExecutorRun['identities'] }): RetrievalReplayExecutor {
  return {
    run: async () => ({
      identities: [],
      ...run,
    }),
  };
}

describe('retrieval replay runner', () => {
  it('captures report metadata and PASS for stable fresh runs', async () => {
    const caseInput = makeCase({
      expected: {
        topK: 1,
        identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      },
    });

    const executor = makeExecutor({
      identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      latencyMs: 120,
      repoPath: '/repo',
      indexedHead: 'abc',
      currentHead: 'abc',
      qualityMode: 'balanced',
      enabledCapabilities: ['semantic', 'graph'],
      missingCapabilities: [],
      indexFreshness: 'fresh',
      sidecarFreshness: 'fresh',
      embeddingFreshness: 'fresh',
      baselineElapsedMs: 100,
    });

    const report = await replayRetrievalCases({
      cases: [caseInput],
      executor,
      now: () => 1_000,
    });

    expect(report.cases).toHaveLength(1);
    const caseReport = report.cases[0];
    expect(caseReport.caseSchemaVersion).toBe(RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION);
    expect(caseReport.repoPath).toBe('/repo');
    expect(caseReport.indexedHead).toBe('abc');
    expect(caseReport.currentHead).toBe('abc');
    expect(caseReport.qualityMode).toBe('balanced');
    expect(caseReport.verdict).toBe('PASS');
    expect(caseReport.metrics.latencyDeltaMs).toBe(20);
    expect(caseReport.gate.verdict).toBe('PASS');
    expect(caseReport.sidecarFreshness).toBe('fresh');
    expect(caseReport.embeddingFreshness).toBe('fresh');
  });

  it('warns when index freshness is stale', async () => {
    const executor = makeExecutor({
      identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      latencyMs: 50,
      indexFreshness: 'stale',
    });

    const caseInput = makeCase({
      expected: {
        topK: 1,
        identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      },
    });

    const report = await replayRetrievalCases({
      cases: [caseInput],
      executor,
    });

    const caseReport = report.cases[0];
    expect(caseReport.verdict).toBe('WARN');
    expect(caseReport.gate.status).toBe('ok');
    expect(caseReport.gate.reasons).toContain('index freshness is stale');
  });

  it('warns when required capability is missing', async () => {
    const executor = makeExecutor({
      identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      missingCapabilities: ['embeddings'],
    });

    const caseInput = makeCase({
      expected: {
        topK: 2,
        identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      },
    });

    const report = await replayRetrievalCases({
      cases: [caseInput],
      executor,
    });

    const caseReport = report.cases[0];
    expect(caseReport.verdict).toBe('WARN');
    expect(caseReport.gate.reasons).toContain('missing required capabilities: embeddings');
  });

  it('fails when top-1 changes and requireTop1Stable is set', async () => {
    const executor = makeExecutor({
      identities: [{ kind: 'unknown', reason: 'shifted' }],
    });
    const caseInput = makeCase({
      expected: {
        topK: 1,
        requireTop1Stable: true,
        identities: [{ kind: 'symbol', uid: 'symbol:a', filePath: 'a.ts', name: 'A' }],
      },
    });

    const report = await replayRetrievalCases({
      cases: [caseInput],
      executor,
      now: () => 100,
    });

    const caseReport = report.cases[0];
    expect(caseReport.verdict).toBe('FAIL');
    expect(caseReport.gate.reasons).toContain('top1 changed');
  });

  it('fails if executor throws and captures error', async () => {
    const executor: RetrievalReplayExecutor = {
      run: async () => {
        throw new Error('backend unavailable');
      },
    };

    const report = await replayRetrievalCases({
      cases: [makeCase()],
      executor,
    });
    const caseReport = report.cases[0];

    expect(caseReport.verdict).toBe('FAIL');
    expect(caseReport.error).toBe('backend unavailable');
    expect(caseReport.warnings).toContain('executor error: backend unavailable');
  });
});
