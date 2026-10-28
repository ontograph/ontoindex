import { beforeEach, afterEach, describe, expect, it } from 'vitest';

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
import { execFileSync } from 'node:child_process';
import { computeSourceManifest } from '../../src/core/indexing/source-manifest.js';

describe('commitless runtime health', () => {
  let repoPath: string;
  let meta: RepoMeta;
  const readHealth = () => readRuntimeHealth(repoPath, { meta });

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-health-commitless-'));
    await fs.mkdir(path.join(repoPath, 'src'));
    await fs.writeFile(
      path.join(repoPath, 'src/main.py'),
      'def digest(value):\n    return value\n',
    );
    await fs.writeFile(path.join(repoPath, '.gitignore'), 'ignored.py\n');
    meta = {
      repoPath,
      lastCommit: '',
      indexedAt: '2026-10-11T00:00:00.000Z',
      sourceManifest: await computeSourceManifest(repoPath, { includePaths: ['src'] }),
    };
  });

  afterEach(async () => {
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it('trusts unchanged non-Git sources', async () => {
    const health = await readHealth();
    expect(health.freshnessState).toBe('clean');
    expect(health.indexedCommit).toBeNull();
    expect(health.currentCommit).toBeNull();
    expect(health.dirtyWorktree).toBeNull();
  });

  it('trusts unchanged sources in an unborn Git repository', async () => {
    execFileSync('git', ['init', '--quiet'], { cwd: repoPath });
    const health = await readHealth();
    expect(health.currentCommit).toBeNull();
    expect(health.dirtyWorktree).toBe(true);
    expect(health.freshnessState).toBe('clean');
  });

  it('uses the saved scope and symbols profile, preserving capability degradation', async () => {
    meta.sourceManifest = await computeSourceManifest(repoPath, {
      includePaths: ['src'],
      pipelineProfile: 'symbols',
    });
    meta.indexMode = 'symbols-only';
    meta.capabilities = { symbols: true, impact: 'degraded', processes: false };
    await fs.writeFile(path.join(repoPath, 'outside.py'), 'outside = 1\n');
    const health = await readHealth();
    expect(health.freshnessState).toBe('degraded');
    expect(health.degradedReason).toMatch(/symbols|capabilit/);
  });

  it.each(
    (process.platform === 'win32'
      ? ['edit', 'add', 'delete']
      : ['edit', 'add', 'delete', 'mode']) as const,
  )('detects selected source %s', async (change) => {
    const filename = path.join(repoPath, 'src/main.py');
    if (change === 'edit') await fs.appendFile(filename, '\nchanged = True\n');
    if (change === 'add') await fs.writeFile(path.join(repoPath, 'src/new.py'), 'new = True\n');
    if (change === 'delete') await fs.unlink(filename);
    if (change === 'mode') await fs.chmod(filename, 0o755);
    expect((await readHealth()).freshnessState).toBe('stale');
  });

  it('ignores changes outside the saved scope and ignored inputs', async () => {
    await fs.writeFile(path.join(repoPath, 'outside.py'), 'outside = True\n');
    await fs.writeFile(path.join(repoPath, 'src/ignored.py'), 'ignored = True\n');
    expect((await readHealth()).freshnessState).toBe('clean');
  });

  it.each(['missing', 'unsupported', 'malformed'] as const)(
    'fails closed for a %s manifest',
    async (kind) => {
      if (kind === 'missing') delete meta.sourceManifest;
      if (kind === 'unsupported') Object.assign(meta.sourceManifest!, { version: 999 });
      if (kind === 'malformed') Object.assign(meta.sourceManifest!, { sourceDigest: 'invalid' });
      expect((await readHealth()).freshnessState).toBe('untrusted');
    },
  );

  it('preserves incomplete source coverage', async () => {
    meta.sourceManifest!.coverage = 'degraded';
    const health = await readHealth();
    expect(health.freshnessState).toBe('degraded');
    expect(health.degradedReason).toBe('source manifest coverage is incomplete');
  });
});

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

async function makeCommittedGitRepo(): Promise<string> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-health-git-'));
  await fs.mkdir(path.join(repoPath, 'src'));
  await fs.writeFile(path.join(repoPath, 'src/main.ts'), 'export const initial = true;\n');
  execFileSync('git', ['init', '--quiet'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'Runtime Health Test'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'runtime-health@example.invalid'], {
    cwd: repoPath,
  });
  execFileSync('git', ['add', 'src/main.ts'], { cwd: repoPath });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial fixture'], { cwd: repoPath });
  return repoPath;
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

  it.each([
    ['active', 'absent', 'degraded'],
    ['stale', 'absent', 'untrusted'],
    ['unknown', 'absent', 'untrusted'],
    ['absent', 'failed', 'failed-after-partial-run'],
    ['absent', 'partial', 'degraded'],
    ['absent', 'unknown', 'untrusted'],
  ] as const)(
    'preserves %s lock / %s checkpoint with a matching commitless manifest',
    (lock, checkpoint, expected) => {
      expect(
        deriveRuntimeHealth({
          ...base,
          indexedCommit: null,
          currentCommit: null,
          sourceFreshness: { state: 'clean', reason: null },
          analyzeLock: makeLock(lock),
          analysisCheckpoint: makeCheckpoint(checkpoint),
        }).freshnessState,
      ).toBe(expected);
    },
  );

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
      degradedReason:
        'committed index is current, but uncommitted files are not represented in the graph',
      repairCommand:
        'ontoindex analyze supports working-tree sources; ontoindex analyze --dirty-overlay provides partial file coverage, with current relationships limited to covered files',
      repairAction: {
        tool: 'ontoindex',
        command: 'analyze',
        args: [],
        reason:
          'analyze working-tree sources; verify partial overlay coverage before relying on current relationships',
      },
    });
  });

  it('reports current committed freshness and coverable dirty source files', async () => {
    const repoPath = await makeCommittedGitRepo();
    try {
      const indexedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim();
      await fs.appendFile(path.join(repoPath, 'src/main.ts'), '\nexport const changed = true;\n');

      const health = await readRuntimeHealth(repoPath, {
        meta: {
          repoPath,
          lastCommit: indexedCommit,
          indexedAt: '2026-10-14T00:00:00.000Z',
          stats: { embeddings: 3 },
        },
      });

      expect(health.freshnessState).toBe('dirty');
      expect(health.degradedReason).toBe(
        'committed index is current, but uncommitted files are not represented in the graph',
      );
      expect(health.committedFreshness).toBe('fresh');
      expect(health.workspaceReadiness).toEqual({
        state: 'not-checked',
        dirtyCoverageScope: 'symbol-overlay-eligibility',
        preparationChecked: false,
      });
      expect(health.dirtyCoverage).toEqual({
        state: 'coverable',
        dirtySourceFiles: 1,
        coveredFiles: 1,
        uncoveredFiles: 0,
        cap: 50,
      });
      expect(health.embeddingsAvailable).toBe(true);
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('reports stale committed freshness independently of worktree coverage', async () => {
    const repoPath = await makeCommittedGitRepo();
    try {
      const health = await readRuntimeHealth(repoPath, {
        meta: {
          repoPath,
          lastCommit: '0'.repeat(40),
          indexedAt: '2026-10-14T00:00:00.000Z',
        },
      });

      expect(health.committedFreshness).toBe('stale');
      expect(health.dirtyCoverage).toEqual({
        state: 'none',
        dirtySourceFiles: 0,
        coveredFiles: 0,
        uncoveredFiles: 0,
        cap: 50,
      });
      expect(health.embeddingsAvailable).toBeNull();
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('reports unknown dirty coverage and a warning when the overlay probe fails', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-health-bad-git-'));
    try {
      await fs.writeFile(path.join(repoPath, '.git'), 'invalid git directory pointer\n');
      const health = await readRuntimeHealth(repoPath, {
        meta: {
          repoPath,
          lastCommit: 'a'.repeat(40),
          indexedAt: '2026-10-14T00:00:00.000Z',
        },
      });

      expect(health.dirtyCoverage).toEqual({
        state: 'unknown',
        dirtySourceFiles: null,
        coveredFiles: null,
        uncoveredFiles: null,
        cap: 50,
      });
      expect(
        health.warnings.some((warning) => warning.includes('dirty overlay probe failed')),
      ).toBe(true);
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('reports covered and uncovered dirty source files beyond the overlay cap', async () => {
    const repoPath = await makeCommittedGitRepo();
    try {
      await Promise.all(
        Array.from({ length: 51 }, (_, index) =>
          fs.writeFile(
            path.join(repoPath, `src/dirty-${index}.ts`),
            `export const value${index} = ${index};\n`,
          ),
        ),
      );
      const indexedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim();
      const health = await readRuntimeHealth(repoPath, {
        meta: { repoPath, lastCommit: indexedCommit, indexedAt: '2026-10-14T00:00:00.000Z' },
      });

      expect(health.dirtyCoverage).toEqual({
        state: 'over-cap',
        dirtySourceFiles: 51,
        coveredFiles: 50,
        uncoveredFiles: 1,
        cap: 50,
      });
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('counts tombstones as covered when source files exceed the overlay cap', async () => {
    const repoPath = await makeCommittedGitRepo();
    try {
      await Promise.all(
        Array.from({ length: 51 }, (_, index) =>
          fs.writeFile(
            path.join(repoPath, `src/dirty-${index}.ts`),
            `export const value${index} = ${index};\n`,
          ),
        ),
      );
      await fs.unlink(path.join(repoPath, 'src/main.ts'));
      const indexedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim();
      const health = await readRuntimeHealth(repoPath, {
        meta: { repoPath, lastCommit: indexedCommit, indexedAt: '2026-10-14T00:00:00.000Z' },
      });

      expect(health.dirtyCoverage).toEqual({
        state: 'over-cap',
        dirtySourceFiles: 52,
        coveredFiles: 51,
        uncoveredFiles: 1,
        cap: 50,
      });
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
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

  it.skipIf(process.platform !== 'linux')(
    'detects PID reuse from process start identity',
    async () => {
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
    },
  );

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

  it('does not load on-disk metadata when meta is explicitly null', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-health-explicit-null-'));
    try {
      await fs.writeFile(
        path.join(storagePath, 'meta.json'),
        JSON.stringify({
          repoPath: '.',
          lastCommit: 'disk-only-commit',
          indexedAt: '2026-08-18T00:00:00.000Z',
          degradedFileAggregates: {
            sampledDegradedCount: 1,
            groups: [
              {
                cause: 'disk metadata sentinel',
                phase: 'test',
                language: 'typescript',
                count: 1,
              },
            ],
            omittedGroupCount: 0,
          },
        } satisfies RepoMeta),
      );

      const health = await readRuntimeHealth(process.cwd(), {
        repoLabel: 'explicit-null-fixture',
        storagePath,
        meta: null,
      });

      expect(health.indexedCommit).toBeNull();
      expect(health.degradedFileAggregates).toBeUndefined();
      expect(health.freshnessState).toBe('untrusted');
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });
});
