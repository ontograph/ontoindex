import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('fs', () => ({ readFileSync: vi.fn() }));
vi.mock('os', () => ({ homedir: vi.fn(() => '/home/testuser') }));
vi.mock('../../src/storage/repo-manager.js', () => ({
  getGlobalRegistryPath: vi.fn(() => '/home/testuser/.ontoindex/registry.json'),
  loadMeta: vi.fn(),
  readActiveGenerationMeta: vi.fn(),
  resolveActiveIndexGeneration: vi.fn(),
}));
vi.mock('../../src/core/runtime/runtime-health.js', () => ({ readRuntimeHealth: vi.fn() }));
vi.mock('../../src/core/analysis/analysis-coordinator.js', () => ({ submitAnalysisJob: vi.fn() }));
vi.mock('../../src/core/indexing/source-manifest.js', () => ({
  computeSourceManifest: vi.fn(),
  sourceManifestDigest: vi.fn(),
}));
vi.mock('../../src/mcp/shared/target-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/shared/target-context.js')>()),
  resolveTargetContext: vi.fn(),
}));

import { readFileSync } from 'fs';
import { execFile } from 'child_process';
import {
  loadMeta,
  readActiveGenerationMeta,
  resolveActiveIndexGeneration,
} from '../../src/storage/repo-manager.js';
import { readRuntimeHealth } from '../../src/core/runtime/runtime-health.js';
import { gnEnsureFresh, resetFreshnessCache } from '../../src/mcp/super/ensure-fresh.js';

const repoPath = '/tmp/embedding-prereqs-repo';
const commit = 'abc123def456abc123def456abc123def456abc1';
let priorEnv: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  resetFreshnessCache();
  priorEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ONTOINDEX_')) {
      priorEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  (readFileSync as any).mockReturnValue(
    JSON.stringify([
      { name: 'repo', path: repoPath, lastCommit: commit, stats: { embeddings: 0 } },
    ]),
  );
  (loadMeta as any).mockResolvedValue({
    repoPath,
    lastCommit: commit,
    generationId: 'g1',
    model_hash: 'stored',
    stats: { embeddings: 0 },
  });
  (resolveActiveIndexGeneration as any).mockResolvedValue({
    generationId: 'g1',
    generationPath: `${repoPath}/.ontoindex/generations/g1`,
  });
  (readActiveGenerationMeta as any).mockResolvedValue({
    activeGeneration: { generationId: 'g1' },
    meta: {
      repoPath,
      lastCommit: commit,
      generationId: 'g1',
      model_hash: 'stored',
      stats: { embeddings: 0 },
    },
    authority: 'active-generation',
  });
  (readRuntimeHealth as any).mockResolvedValue({
    version: 1,
    repoLabel: 'repo',
    repoPath,
    indexedCommit: commit,
    currentCommit: commit,
    dirtyWorktree: false,
    freshnessState: 'clean',
    degradedReason: null,
    repairCommand: 'ontoindex analyze',
    repairAction: { tool: 'ontoindex', command: 'analyze', args: [], reason: 'test' },
    hasRuntimeArtifacts: false,
    analyzeLock: { path: `${repoPath}/.ontoindex/analyze.lock`, present: false, state: 'absent' },
    analysisCheckpoint: {
      path: `${repoPath}/.ontoindex/analysis-checkpoint.json`,
      present: false,
      state: 'absent',
    },
    embeddingCheckpoint: {
      path: `${repoPath}/.ontoindex/embedding-checkpoint.json`,
      present: false,
    },
    bootstrapSource: { path: `${repoPath}/.ontoindex/bootstrap-source.json`, present: false },
    warnings: [],
  });
  (execFile as any).mockImplementation((_cmd: string, args: string[], opts: any, callback: any) => {
    if (args.includes('--show-toplevel')) callback(null, `${repoPath}\n`, '');
    else if (args.includes('HEAD')) callback(null, `${commit}\n`, '');
    else callback(null, '', '');
    return {} as any;
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env))
    if (key.startsWith('ONTOINDEX_')) delete process.env[key];
  for (const [key, value] of Object.entries(priorEnv))
    if (value !== undefined) process.env[key] = value;
});

describe('gnEnsureFresh embedding prerequisites', () => {
  it('names all missing configuration without exposing environment values', async () => {
    process.env.ONTOINDEX_EMBEDDING_URL = 'http://user:pw@host/';
    const report = await gnEnsureFresh('repo', {});
    expect(report.embeddingsStatus.prerequisites).toMatchObject({
      urlConfigured: true,
      modelConfigured: false,
      modelHashConfigured: false,
    });
    expect(report.embeddingsStatus.prerequisites?.note).toContain('ONTOINDEX_EMBEDDING_MODEL');
    expect(report.embeddingsStatus.prerequisites?.note).toContain('ONTOINDEX_EMBEDDING_MODEL_HASH');
    expect(JSON.stringify(report)).not.toContain('pw');
  });

  it('explains CLI versus managed repair prerequisites', async () => {
    process.env.ONTOINDEX_EMBEDDING_URL = 'https://host/';
    process.env.ONTOINDEX_EMBEDDING_MODEL = 'embedding-model';
    const report = await gnEnsureFresh('repo', {});
    expect(report.embeddingsStatus.prerequisites?.note).toContain('ontoindex analyze --embeddings');
    expect(report.embeddingsStatus.prerequisites?.note).toContain('ONTOINDEX_EMBEDDING_MODEL_HASH');
  });

  it('omits prerequisites when embeddings are populated', async () => {
    (readActiveGenerationMeta as any).mockResolvedValue({
      activeGeneration: { generationId: 'g1' },
      meta: {
        repoPath,
        lastCommit: commit,
        generationId: 'g1',
        model_hash: 'stored',
        stats: { embeddings: 10 },
      },
      authority: 'active-generation',
    });
    const report = await gnEnsureFresh('repo', {});
    expect(report.embeddingsStatus.status).toBe('ok');
    expect(report.embeddingsStatus).not.toHaveProperty('prerequisites');
  });
});
