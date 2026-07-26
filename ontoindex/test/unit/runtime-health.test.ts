import { describe, expect, it } from 'vitest';

import {
  deriveRuntimeHealth,
  formatRuntimeHealthDetailLines,
  readAnalyzeLock,
  readRuntimeHealth,
  type RuntimeAnalysisCheckpointState,
  type RuntimeAnalyzeLockState,
  type RuntimeBootstrapSourceState,
  type RuntimeEmbeddingCheckpointState,
} from '../../src/core/runtime/runtime-health.js';
import type { RepoMeta } from '../../src/storage/repo-manager.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

function makeBootstrapSource(
  present: RuntimeBootstrapSourceState['present'],
): RuntimeBootstrapSourceState {
  return {
    path: '/tmp/fixture/.ontoindex/bootstrap-source.json',
    present,
    restoredAt: present ? '2026-06-30T00:00:00.000Z' : undefined,
    sourceRepoLabel: present ? 'fixture-src' : undefined,
    sourceIndexedCommit: present ? 'abc123def456' : undefined,
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
    bootstrapSource: makeBootstrapSource(false),
    metaReason: null,
    hasMeta: true,
  } as const;

  it('classifies a clean repository', () => {
    expect(deriveRuntimeHealth(base)).toEqual({
      freshnessState: 'clean',
      degradedReason: null,
      repairCommand: 'ontoindex status',
      repairAction: {
        tool: 'ontoindex',
        command: 'status',
        args: [],
        reason: 'runtime state is healthy; inspect status only',
      },
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
      repairAction: {
        tool: 'ontoindex',
        command: 'analyze',
        args: [],
        reason: 'refresh the stale index',
      },
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
      repairAction: {
        tool: 'ontoindex',
        command: 'analyze',
        args: [],
        reason: 'refresh the stale index',
      },
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
      repairAction: {
        tool: 'ontoindex',
        command: 'analyze',
        args: [],
        reason: 'analyze after the worktree is clean',
      },
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
      repairAction: {
        tool: 'ontoindex',
        command: 'status',
        args: [],
        reason: 'observe the live analysis owner without displacing it',
      },
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
      repairCommand: 'ontoindex analyze --force',
      repairAction: {
        tool: 'ontoindex',
        command: 'analyze',
        args: ['--force'],
        reason: 'recover the stale lock through managed analysis',
      },
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
      repairAction: {
        tool: 'ontoindex',
        command: 'analyze',
        args: ['--force'],
        reason: 'retry the managed analysis after a failed partial run',
      },
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
      repairAction: {
        tool: 'ontoindex',
        command: 'analyze',
        args: [],
        reason: 'resume the incomplete embedding lifecycle',
      },
    });
  });

  it('includes bootstrap provenance in detail lines when present', () => {
    expect(
      formatRuntimeHealthDetailLines({
        version: 1,
        repoLabel: 'fixture',
        repoPath: '/tmp/fixture',
        indexedCommit: 'abc123def456',
        currentCommit: 'abc123def456',
        dirtyWorktree: false,
        freshnessState: 'clean',
        degradedReason: null,
        repairCommand: 'ontoindex status',
        hasRuntimeArtifacts: false,
        analyzeLock: makeLock('absent'),
        analysisCheckpoint: makeCheckpoint('absent'),
        embeddingCheckpoint: makeEmbeddingCheckpoint(false),
        bootstrapSource: makeBootstrapSource(true),
        warnings: [],
      }),
    ).toContain('  Bootstrap source: restored 2026-06-30T00:00:00.000Z from fixture-src @ abc123d');
  });

  it('detects PID reuse from process start identity', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-health-lock-'));
    try {
      await fs.writeFile(
        path.join(storagePath, 'analyze.lock'),
        JSON.stringify({
          pid: process.pid,
          processStartIdentity: 'different-process',
          startedAt: new Date().toISOString(),
        }),
      );

      const lock = await readAnalyzeLock(storagePath, []);

      expect(lock.state).toBe('stale');
      expect(lock.reason).toContain('reused');
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });

  it('projects degraded-file aggregates and honest sampled reason from meta', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-health-agg-'));
    try {
      const meta: RepoMeta = {
        repoPath: '.',
        lastCommit: 'abc123',
        indexedAt: '2026-05-27T00:00:00.000Z',
        degradedFileAggregates: {
          sampledDegradedCount: 7,
          groups: [
            {
              cause: 'file exceeds scan file-size cap',
              phase: 'scan',
              language: 'python',
              count: 7,
            },
          ],
          omittedGroupCount: 0,
        },
      };

      const health = await readRuntimeHealth(repoPath, {
        repoLabel: 'agg-fixture',
        storagePath: repoPath,
        meta,
      });

      expect(health.degradedFileAggregates).toEqual(meta.degradedFileAggregates);
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('omits degraded-file aggregates from the snapshot when meta has none', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-health-agg-absent-'));
    try {
      const meta: RepoMeta = {
        repoPath: '.',
        lastCommit: 'abc123',
        indexedAt: '2026-05-27T00:00:00.000Z',
      };

      const health = await readRuntimeHealth(repoPath, {
        repoLabel: 'absent-fixture',
        storagePath: repoPath,
        meta,
      });

      expect(health.degradedFileAggregates).toBeUndefined();
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });
});
