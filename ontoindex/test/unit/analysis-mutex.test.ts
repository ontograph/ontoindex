import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(false),
    executeParameterized: vi.fn().mockResolvedValue([]),
    executeQuery: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([
    {
      name: 'testrepo',
      path: '/fake/testrepo',
      storagePath: '/fake/.ontoindex/repos/testrepo',
      indexedAt: '2024-01-01T00:00:00Z',
      lastCommit: 'abc123',
      stats: {},
    },
  ]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { initLbug } from '../../src/core/lbug/pool-adapter.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';

const initMock = initLbug as unknown as ReturnType<typeof vi.fn>;

describe('LocalBackend analysis mutex', () => {
  let backend: LocalBackend;
  let tmpDirs: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    lbugMocks.isLbugReady.mockReturnValue(false);
    lbugMocks.initLbug.mockResolvedValue(undefined);
    backend = new LocalBackend();
    await backend.init();
  });

  afterEach(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
  });

  it('serializes concurrent ensureInitialized calls on the same repo', async () => {
    const order: string[] = [];
    let resolve1!: () => void;
    let resolve2!: () => void;
    const p1 = new Promise<void>((res) => {
      resolve1 = res;
    });
    const p2 = new Promise<void>((res) => {
      resolve2 = res;
    });

    initMock
      .mockImplementationOnce(async () => {
        order.push('init-1-start');
        await p1;
        order.push('init-1-end');
      })
      .mockImplementationOnce(async () => {
        order.push('init-2-start');
        await p2;
        order.push('init-2-end');
      });

    (backend as any).initializedRepos.clear();
    (backend as any).reinitPromises.clear();
    (backend as any).analysisLocks.clear();

    const call1 = (backend as any).ensureInitialized('testrepo');
    const call2 = (backend as any).ensureInitialized('testrepo');

    resolve1();
    await call1;
    resolve2();
    await call2;

    const idx1End = order.indexOf('init-1-end');
    const idx2Start = order.indexOf('init-2-start');
    expect(idx1End).toBeGreaterThan(-1);
    expect(idx2Start).toBeGreaterThan(-1);
    expect(idx2Start).toBeGreaterThan(idx1End);
  });

  it('does not deadlock when the lock-holder rejects', async () => {
    lbugMocks.initLbug.mockRejectedValueOnce(new Error('init failed'));

    (backend as any).initializedRepos.clear();
    (backend as any).reinitPromises.clear();
    (backend as any).analysisLocks.clear();

    await expect((backend as any).ensureInitialized('testrepo')).rejects.toThrow();

    lbugMocks.initLbug.mockResolvedValueOnce(undefined);
    lbugMocks.isLbugReady.mockReturnValue(false);
    (backend as any).initializedRepos.clear();
    (backend as any).reinitPromises.clear();
    await expect((backend as any).ensureInitialized('testrepo')).resolves.toBeUndefined();
  });

  it('fails fast when LadybugDB read-only recovery sidecars are present', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-lbug-sidecar-'));
    tmpDirs.push(tmpDir);
    const storagePath = path.join(tmpDir, '.ontoindex');
    fs.mkdirSync(storagePath, { recursive: true });
    fs.writeFileSync(path.join(storagePath, 'lbug.wal'), 'pending');
    vi.mocked(listRegisteredRepos).mockResolvedValueOnce([
      {
        name: 'testrepo',
        path: tmpDir,
        storagePath,
        indexedAt: '2024-01-01T00:00:00Z',
        lastCommit: 'abc123',
        stats: {},
      },
    ] as any);

    backend = new LocalBackend();
    await backend.init();

    await expect((backend as any).ensureInitialized('testrepo')).rejects.toThrow(
      /needs LadybugDB recovery/,
    );
    expect(initMock).not.toHaveBeenCalled();
  });

  it('keeps the existing LadybugDB pool open when reinit preflight fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-lbug-reinit-'));
    tmpDirs.push(tmpDir);
    const storagePath = path.join(tmpDir, '.ontoindex');
    fs.mkdirSync(storagePath, { recursive: true });
    fs.writeFileSync(
      path.join(storagePath, 'meta.json'),
      JSON.stringify({ indexedAt: '2024-01-01T00:00:00Z' }),
    );
    vi.mocked(listRegisteredRepos).mockResolvedValueOnce([
      {
        name: 'testrepo',
        path: tmpDir,
        storagePath,
        indexedAt: '2024-01-01T00:00:00Z',
        lastCommit: 'abc123',
        stats: {},
      },
    ] as any);

    backend = new LocalBackend();
    await backend.init();
    lbugMocks.isLbugReady.mockReturnValue(false);
    await expect((backend as any).ensureInitialized('testrepo')).resolves.toBeUndefined();

    lbugMocks.closeLbug.mockClear();
    lbugMocks.initLbug.mockClear();
    lbugMocks.isLbugReady.mockReturnValue(true);
    fs.writeFileSync(
      path.join(storagePath, 'meta.json'),
      JSON.stringify({ indexedAt: '2024-01-02T00:00:00Z' }),
    );
    fs.writeFileSync(path.join(storagePath, 'lbug.wal'), 'pending');

    await expect((backend as any).ensureInitialized('testrepo')).rejects.toThrow(
      /needs LadybugDB recovery/,
    );
    expect(lbugMocks.closeLbug).not.toHaveBeenCalled();
    expect(lbugMocks.initLbug).not.toHaveBeenCalled();
  });
});
