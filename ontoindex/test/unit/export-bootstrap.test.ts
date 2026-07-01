import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  exportBootstrapCommand,
  exportBootstrapHydrateCommand,
} from '../../src/cli/export.js';
import {
  RegistryNameCollisionError,
  getStoragePaths,
  listRegisteredRepos,
  loadMeta,
  registerRepo,
  saveMeta,
} from '../../src/storage/repo-manager.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';

const { readRuntimeHealthMock, getLbugRuntimeDiagnosticsMock } = vi.hoisted(() => ({
  readRuntimeHealthMock: vi.fn(),
  getLbugRuntimeDiagnosticsMock: vi.fn(),
}));

vi.mock('../../src/core/runtime/runtime-health.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/runtime/runtime-health.js')>();
  return {
    ...actual,
    readRuntimeHealth: readRuntimeHealthMock,
  };
});

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  getLbugRuntimeDiagnostics: getLbugRuntimeDiagnosticsMock,
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(),
  closeLbug: vi.fn(),
  executeQuery: vi.fn(),
}));

describe('bootstrap export and hydrate', () => {
  let repoHandle: TestDBHandle;
  let restoreHandle: TestDBHandle;
  let homeHandle: TestDBHandle;
  let savedHome: string | undefined;
  let artifactPath: string;
  let originalLbug: Buffer;
  let originalSnapshot: string;

  const initGitRepo = (dir: string, remoteName?: string): void => {
    execSync('git init -q', { cwd: dir });
    if (remoteName) {
      execSync(`git remote add origin git@github.com:test/${remoteName}.git`, { cwd: dir });
    }
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    repoHandle = await createTempDir('ontoindex-bootstrap-src-');
    restoreHandle = await createTempDir('ontoindex-bootstrap-dst-');
    homeHandle = await createTempDir('ontoindex-bootstrap-home-');
    savedHome = process.env.ONTOINDEX_HOME;
    process.env.ONTOINDEX_HOME = homeHandle.dbPath;

    const { storagePath, lbugPath } = getStoragePaths(repoHandle.dbPath);
    await fs.mkdir(storagePath, { recursive: true });
    originalLbug = Buffer.from('LBUG bootstrap payload', 'utf8');
    originalSnapshot = JSON.stringify(
      {
        lastCommit: 'abc123def456',
        savedAt: '2026-06-30T00:00:00.000Z',
        calleesMap: {
          'Function:alpha': ['Function:beta'],
        },
        fileToSymbols: {
          'src/index.ts': ['Function:alpha'],
        },
      },
      null,
      2,
    );
    await fs.writeFile(lbugPath, originalLbug);
    await fs.writeFile(path.join(storagePath, 'snapshot.json'), originalSnapshot, 'utf8');
    await saveMeta(storagePath, {
      repoPath: '.',
      lastCommit: 'abc123def456',
      indexedAt: '2026-06-30T00:00:00.000Z',
      stats: { files: 1, nodes: 2, edges: 3, embeddings: 0 },
    });

    artifactPath = path.join(repoHandle.dbPath, '.ontoindex', 'exports', 'bootstrap-index.json.gz');

    readRuntimeHealthMock.mockResolvedValue({
      version: 1,
      repoLabel: path.basename(repoHandle.dbPath),
      repoPath: repoHandle.dbPath,
      indexedCommit: 'abc123def456',
      currentCommit: 'abc123def456',
      dirtyWorktree: false,
      freshnessState: 'clean',
      degradedReason: null,
      repairCommand: 'ontoindex status',
      hasRuntimeArtifacts: false,
      analyzeLock: { path: `${storagePath}/analyze.lock`, present: false, state: 'absent' },
      analysisCheckpoint: {
        path: `${storagePath}/analysis-checkpoint.json`,
        present: false,
        state: 'absent',
      },
      embeddingCheckpoint: {
        path: `${storagePath}/embedding-checkpoint.json`,
        present: false,
      },
      bootstrapSource: {
        path: `${storagePath}/bootstrap-source.json`,
        present: false,
      },
      warnings: [],
    });

    getLbugRuntimeDiagnosticsMock.mockResolvedValue({
      extensionHintDir: '/tmp/lbug-ext',
      getAllTimeoutMs: 30000,
      extensions: {
        fts: { available: true, path: '/tmp/lbug-ext/libfts.lbug_extension' },
        vector: { available: true, path: '/tmp/lbug-ext/libvector.lbug_extension' },
      },
    });
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.ONTOINDEX_HOME;
    else process.env.ONTOINDEX_HOME = savedHome;
    await repoHandle.cleanup();
    await restoreHandle.cleanup();
    await homeHandle.cleanup();
  });

  it('exports a compressed artifact and hydrates it into a new repo', async () => {
    await exportBootstrapCommand({ repo: repoHandle.dbPath, out: artifactPath });

    const compressed = await fs.readFile(artifactPath);
    const artifact = JSON.parse(gunzipSync(compressed).toString('utf8')) as {
      artifactType: string;
      format: { container: string; graphStoreEncoding: string; graphStoreField: string };
      payload: {
        lbugSha256: string;
        lbugSizeBytes: number;
        meta: { lastCommit: string };
        snapshotJson: string | null;
      };
    };
    expect(artifact.artifactType).toBe('bootstrap-index');
    expect(artifact.format).toEqual({
      container: 'json+gzip',
      graphStoreEncoding: 'base64',
      graphStoreField: 'payload.lbugBase64',
    });
    expect(artifact.payload.meta.lastCommit).toBe('abc123def456');
    expect(artifact.payload.snapshotJson).toBe(originalSnapshot);
    expect(artifact.payload.lbugSizeBytes).toBe(originalLbug.byteLength);

    await exportBootstrapHydrateCommand(artifactPath, { repo: restoreHandle.dbPath });

    const restoredPaths = getStoragePaths(restoreHandle.dbPath);
    await expect(fs.readFile(restoredPaths.lbugPath)).resolves.toEqual(originalLbug);
    await expect(loadMeta(restoredPaths.storagePath)).resolves.toMatchObject({
      lastCommit: 'abc123def456',
      indexedAt: '2026-06-30T00:00:00.000Z',
    });
    await expect(fs.readFile(path.join(restoredPaths.storagePath, 'snapshot.json'), 'utf8')).resolves.toBe(
      originalSnapshot,
    );
    await expect(fs.readFile(path.join(restoredPaths.storagePath, 'bootstrap-source.json'), 'utf8')).resolves.toContain(
      '"sourceIndexedCommit": "abc123def456"',
    );
    await expect(fs.readFile(path.join(restoreHandle.dbPath, '.gitignore'), 'utf8')).resolves.toContain(
      '.ontoindex',
    );

    const entries = await listRegisteredRepos();
    expect(entries.some((entry) => path.resolve(entry.path) === path.resolve(restoreHandle.dbPath))).toBe(
      true,
    );
  });

  it('force hydrate replaces stale snapshot state from an older local index', async () => {
    const restoredPaths = getStoragePaths(restoreHandle.dbPath);
    await fs.mkdir(restoredPaths.storagePath, { recursive: true });
    await fs.writeFile(restoredPaths.lbugPath, Buffer.from('stale lbug', 'utf8'));
    await saveMeta(restoredPaths.storagePath, {
      repoPath: '.',
      lastCommit: 'deadbeef',
      indexedAt: '2025-01-01T00:00:00.000Z',
      stats: { files: 9, nodes: 9, edges: 9, embeddings: 0 },
    });
    await fs.writeFile(
      path.join(restoredPaths.storagePath, 'snapshot.json'),
      JSON.stringify({ lastCommit: 'deadbeef', stale: true }, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(restoredPaths.storagePath, 'bootstrap-source.json'),
      '{"sourceIndexedCommit":"deadbeef"}',
      'utf8',
    );

    await exportBootstrapCommand({ repo: repoHandle.dbPath, out: artifactPath });
    await exportBootstrapHydrateCommand(artifactPath, { repo: restoreHandle.dbPath, force: true });

    await expect(fs.readFile(restoredPaths.lbugPath)).resolves.toEqual(originalLbug);
    await expect(fs.readFile(path.join(restoredPaths.storagePath, 'snapshot.json'), 'utf8')).resolves.toBe(
      originalSnapshot,
    );
    await expect(fs.readFile(path.join(restoredPaths.storagePath, 'bootstrap-source.json'), 'utf8')).resolves.toContain(
      '"sourceIndexedCommit": "abc123def456"',
    );
  });

  it('preserves bare relative repo paths for bootstrap export', async () => {
    const originalCwd = process.cwd();
    process.chdir(path.dirname(repoHandle.dbPath));
    try {
      await exportBootstrapCommand({
        repo: path.basename(repoHandle.dbPath),
        out: artifactPath,
      });
    } finally {
      process.chdir(originalCwd);
    }

    const compressed = await fs.readFile(artifactPath);
    const artifact = JSON.parse(gunzipSync(compressed).toString('utf8')) as {
      payload: { meta: { lastCommit: string } };
    };
    expect(artifact.payload.meta.lastCommit).toBe('abc123def456');
  });

  it('resolves registered repo names for export and git-root subdirs for hydrate', async () => {
    initGitRepo(repoHandle.dbPath);
    initGitRepo(restoreHandle.dbPath);
    await registerRepo(repoHandle.dbPath, {
      repoPath: '.',
      lastCommit: 'abc123def456',
      indexedAt: '2026-06-30T00:00:00.000Z',
      stats: { files: 1, nodes: 2, edges: 3, embeddings: 0 },
    });

    await exportBootstrapCommand({ repo: path.basename(repoHandle.dbPath), out: artifactPath });

    const nestedTarget = path.join(restoreHandle.dbPath, 'nested', 'dir');
    await fs.mkdir(nestedTarget, { recursive: true });
    await exportBootstrapHydrateCommand(artifactPath, {
      repo: nestedTarget,
      name: 'restored-bootstrap-repo',
    });

    const restoredPaths = getStoragePaths(restoreHandle.dbPath);
    await expect(fs.readFile(restoredPaths.lbugPath)).resolves.toEqual(originalLbug);
    await expect(loadMeta(restoredPaths.storagePath)).resolves.toMatchObject({
      lastCommit: 'abc123def456',
    });

    const entries = await listRegisteredRepos({ validate: true });
    const restoredEntry = entries.find(
      (entry) => path.resolve(entry.path) === path.resolve(restoreHandle.dbPath),
    );
    expect(restoredEntry?.name).toBe('restored-bootstrap-repo');
  });

  it('rejects ambiguous default hydrated names when another checkout already owns that repo identity', async () => {
    initGitRepo(repoHandle.dbPath, 'shared-bootstrap');
    initGitRepo(restoreHandle.dbPath, 'shared-bootstrap');
    await registerRepo(repoHandle.dbPath, {
      repoPath: '.',
      lastCommit: 'abc123def456',
      indexedAt: '2026-06-30T00:00:00.000Z',
      stats: { files: 1, nodes: 2, edges: 3, embeddings: 0 },
    });

    await exportBootstrapCommand({ repo: repoHandle.dbPath, out: artifactPath });

    await expect(
      exportBootstrapHydrateCommand(artifactPath, { repo: restoreHandle.dbPath }),
    ).rejects.toBeInstanceOf(RegistryNameCollisionError);

    const restoredPaths = getStoragePaths(restoreHandle.dbPath);
    expect(await loadMeta(restoredPaths.storagePath)).toBeNull();
    await expect(fs.access(restoredPaths.lbugPath)).rejects.toThrow();
    await expect(fs.access(path.join(restoredPaths.storagePath, 'snapshot.json'))).rejects.toThrow();
    await expect(fs.access(path.join(restoredPaths.storagePath, 'bootstrap-source.json'))).rejects.toThrow();

    await exportBootstrapHydrateCommand(artifactPath, {
      repo: restoreHandle.dbPath,
      name: 'shared-bootstrap-clone',
    });

    const entries = await listRegisteredRepos();
    expect(entries.some((entry) => entry.name === 'shared-bootstrap-clone')).toBe(true);
  });
});
