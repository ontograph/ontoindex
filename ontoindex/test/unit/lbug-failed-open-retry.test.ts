import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  close: vi.fn(),
  releases: [] as ReturnType<typeof vi.fn>[],
  fail: true,
}));
vi.mock('../../src/storage/repo-manager.js', () => ({
  acquireIndexGenerationPin: async (dbPath: string) => {
    const release = vi.fn(async () => {});
    mocks.releases.push(release);
    return { dbPath, release };
  },
}));
vi.mock('fs/promises', () => ({
  default: {
    stat: async () => ({ ino: 1, size: 1, mtimeMs: 1 }),
    realpath: async (path: string) => path,
  },
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  resolveLocalLbugExtensionPath: async () => null,
}));
vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: class {
      _initPromise: Promise<void> | null = null;
      constructor(...args: unknown[]) {
        mocks.construct(...args);
      }
      async init() {
        if (mocks.fail) {
          this._initPromise = Promise.reject(new Error('native open failed'));
          await this._initPromise;
        }
      }
      async close() {
        if (this._initPromise) await this._initPromise;
        mocks.close();
      }
    },
    Connection: class {
      query = async () => ({ getAll: async () => [], close: async () => {} });
      close = async () => {};
    },
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  mocks.fail = true;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  mocks.construct.mockClear();
  mocks.close.mockClear();
  mocks.releases.length = 0;
});

describe('failed native open retry', () => {
  it.each([
    [undefined, 30000],
    ['0', 1000],
    ['999999', 600000],
    ['invalid', 30000],
  ])('caches failures then closes and retries with bounded delay %s', async (raw, delay) => {
    vi.stubEnv('ONTOINDEX_LBUG_FAILED_OPEN_RETRY_MS', raw);
    const pool = await import('../../src/core/lbug/pool-adapter.js');
    await expect(pool.initLbug('repo', '/repo')).rejects.toThrow('unrecoverable');
    vi.setSystemTime(delay - 1);
    await expect(pool.initLbug('repo', '/repo')).rejects.toThrow('native');
    expect(mocks.construct).toHaveBeenCalledTimes(2);
    mocks.fail = false;
    vi.setSystemTime(delay);
    await pool.initLbug('repo', '/repo');
    expect(mocks.construct).toHaveBeenCalledTimes(3);
    expect(mocks.close).toHaveBeenCalledTimes(2);
    expect(mocks.releases[0]).toHaveBeenCalledTimes(1);
    await pool.closeLbug('repo');
  });
  it('evicts expired failures before admitting another repo at capacity', async () => {
    const pool = await import('../../src/core/lbug/pool-adapter.js');
    for (let i = 0; i < 5; i++) {
      await expect(pool.initLbug(`bad${i}`, `/bad${i}`)).rejects.toThrow();
    }
    vi.setSystemTime(30000);
    mocks.fail = false;
    await pool.initLbug('good', '/good');
    expect(mocks.close).toHaveBeenCalledTimes(10);
    for (const release of mocks.releases.slice(0, 5)) expect(release).toHaveBeenCalledTimes(1);
    await pool.closeLbug('good');
  });
});
