import { describe, expect, it } from 'vitest';

import {
  deriveRuntimeHealth,
  type RuntimeAnalysisCheckpointState,
  type RuntimeAnalyzeLockState,
  type RuntimeEmbeddingCheckpointState,
} from '../../src/core/runtime/runtime-health.js';

function makeLock(state: RuntimeAnalyzeLockState['state']): RuntimeAnalyzeLockState {
  return {
    path: '/tmp/fixture/.ontoindex/analyze.lock',
    present: state !== 'absent',
    state,
    ...(state === 'active' || state === 'stale' ? { pid: 123 } : {}),
    ...(state === 'active' ? { reason: 'analyze.lock is owned by PID 123' } : {}),
    ...(state === 'stale'
      ? { reason: 'analyze.lock refers to PID 123, which is no longer running' }
      : {}),
    ...(state === 'unknown' ? { reason: 'analyze.lock exists but could not be trusted' } : {}),
  };
}

function makeCheckpoint(
  state: RuntimeAnalysisCheckpointState['state'],
): RuntimeAnalysisCheckpointState {
  return {
    path: '/tmp/fixture/.ontoindex/analysis-checkpoint.json',
    present: state !== 'absent',
    state,
    ...(state === 'failed' ? { reason: 'native writer failed' } : {}),
    ...(state === 'running' ? { reason: 'analysis-checkpoint.json shows an in-progress run' } : {}),
    ...(state === 'partial' ? { reason: 'analysis-checkpoint.json shows a partial run' } : {}),
    ...(state === 'unknown'
      ? { reason: 'analysis-checkpoint.json exists but could not be trusted' }
      : {}),
  };
}

function makeEmbeddingCheckpoint(
  state: RuntimeEmbeddingCheckpointState['present'],
): RuntimeEmbeddingCheckpointState {
  return {
    path: '/tmp/fixture/.ontoindex/embedding-checkpoint.json',
    present: state,
    reason: state ? 'embedding-checkpoint.json exists from an incomplete embedding run' : undefined,
  };
}

describe('deriveRuntimeHealth', () => {
  const base = {
    indexedCommit: 'abc123def456',
    currentCommit: 'abc123def456',
    dirtyWorktree: false,
    analyzeLock: makeLock('absent'),
    analysisCheckpoint: makeCheckpoint('absent'),
    embeddingCheckpoint: makeEmbeddingCheckpoint(false),
    metaReason: null,
    hasMeta: true,
  } as const;

  it('classifies a clean repository', () => {
    expect(deriveRuntimeHealth(base)).toEqual({
      freshnessState: 'clean',
      degradedReason: null,
      repairCommand: 'ontoindex status',
    });
  });

  it('classifies a stale indexed commit', () => {
    expect(
      deriveRuntimeHealth({
        ...base,
        currentCommit: 'fff999aaa888',
      }),
    ).toEqual({
      freshnessState: 'stale',
      degradedReason: 'current commit does not match indexed commit',
      repairCommand: 'ontoindex analyze',
    });
  });

  it('keeps stale as the primary state when the worktree is also dirty', () => {
    expect(
      deriveRuntimeHealth({
        ...base,
        currentCommit: 'fff999aaa888',
        dirtyWorktree: true,
      }),
    ).toEqual({
      freshnessState: 'stale',
      degradedReason: 'current commit does not match indexed commit',
      repairCommand: 'ontoindex analyze',
    });
  });

  it('classifies a dirty worktree', () => {
    expect(
      deriveRuntimeHealth({
        ...base,
        dirtyWorktree: true,
      }),
    ).toEqual({
      freshnessState: 'dirty',
      degradedReason: 'dirty worktree contains uncommitted changes',
      repairCommand: 'commit, stash, or clean the worktree, then rerun ontoindex analyze',
    });
  });

  it('classifies degraded runtime artifacts', () => {
    expect(
      deriveRuntimeHealth({
        ...base,
        analyzeLock: makeLock('active'),
      }),
    ).toEqual({
      freshnessState: 'degraded',
      degradedReason: 'analyze.lock is owned by PID 123',
      repairCommand: 'wait for the active analyze run to finish',
    });
  });

  it('classifies stale runtime artifacts as untrusted', () => {
    expect(
      deriveRuntimeHealth({
        ...base,
        analyzeLock: makeLock('stale'),
      }),
    ).toEqual({
      freshnessState: 'untrusted',
      degradedReason: 'analyze.lock refers to PID 123, which is no longer running',
      repairCommand: 'remove the stale analyze.lock, then rerun ontoindex analyze --force',
    });
  });

  it('classifies failed partial runs', () => {
    expect(
      deriveRuntimeHealth({
        ...base,
        analysisCheckpoint: makeCheckpoint('failed'),
      }),
    ).toEqual({
      freshnessState: 'failed-after-partial-run',
      degradedReason: 'native writer failed',
      repairCommand: 'ontoindex analyze --force',
    });
  });

  it('degrades when an embedding checkpoint is present', () => {
    expect(
      deriveRuntimeHealth({
        ...base,
        embeddingCheckpoint: makeEmbeddingCheckpoint(true),
      }),
    ).toEqual({
      freshnessState: 'degraded',
      degradedReason: 'embedding-checkpoint.json exists from an incomplete embedding run',
      repairCommand: 'ontoindex analyze',
    });
  });
});
