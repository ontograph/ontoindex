import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  close: vi.fn(),
  releases: [] as ReturnType<typeof vi.fn>[],
  fail: true,
  errors: [] as (string | null)[],
  closes: [] as ReturnType<typeof vi.fn>[],
  absentInitPromise: false,
  closeError: null as string | null,
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
      closeMock = vi.fn(async () => {});
      constructor(...args: unknown[]) {
        mocks.closes.push(this.closeMock);
        if (mocks.absentInitPromise)
          delete (this as { _initPromise?: Promise<void> | null })._initPromise;
        mocks.construct(...args);
      }
      async init() {
        const error = mocks.errors.shift();
        if (error) {
          if (mocks.absentInitPromise) throw new Error(error);
          this._initPromise = Promise.reject(new Error(error));
          await this._initPromise;
        }
      }
      async close() {
        if (this._initPromise) await this._initPromise;
        if (mocks.closeError) throw new Error(mocks.closeError);
        await this.closeMock();
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
  mocks.errors = [];
  mocks.absentInitPromise = false;
  mocks.closeError = null;
  mocks.closes = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  mocks.construct.mockClear();
  mocks.close.mockClear();
  mocks.releases.length = 0;
});

describe('WAL recovery and failed native cleanup', () => {
  it('recovers init failures while retaining the generation pin', async () => {
    mocks.errors = ['Corrupted wal file', null];
    const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const pool = await import('../../src/core/lbug/pool-adapter.js');
    await pool.initLbug('repo', '/repo');
    expect(mocks.construct.mock.calls[1][7]).toBe(false);
    expect(mocks.closes[0]).toHaveBeenCalledTimes(1);
    expect(mocks.releases[0]).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('WAL corruption'));
    await pool.closeLbug();
    expect(mocks.releases[0]).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });
  it('preserves non-WAL errors and fences retries without recovery', async () => {
    mocks.errors = ['EACCES: permission denied'];
    const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const pool = await import('../../src/core/lbug/pool-adapter.js');
    await expect(pool.initLbug('repo', '/repo')).rejects.toThrow('EACCES: permission denied');
    await expect(pool.initLbug('repo', '/repo')).rejects.toThrow('EACCES: permission denied');
    expect(mocks.construct).toHaveBeenCalledTimes(1);
    expect(mocks.closes[0]).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
    await pool.closeLbug();
    warning.mockRestore();
  });
  it('preserves the init error when failed-primary cleanup fails', async () => {
    mocks.errors = ['corrupt WAL'];
    mocks.closeError = 'cleanup failure';
    const pool = await import('../../src/core/lbug/pool-adapter.js');
    await expect(pool.initLbug('repo', '/repo')).rejects.toThrow('corrupt WAL');
    expect(mocks.construct).toHaveBeenCalledTimes(1);
    mocks.closeError = null;
    await pool.closeLbug();
  });
  it('retains recovery failures and drains them at shutdown', async () => {
    mocks.errors = ['Corrupted wal file', 'Corrupted wal file'];
    const pool = await import('../../src/core/lbug/pool-adapter.js');
    await expect(pool.initLbug('repo', '/repo')).rejects.toThrow(
      /unrecoverable due to WAL corruption.*Cause: Corrupted wal file/,
    );
    expect(mocks.releases[0]).not.toHaveBeenCalled();
    await pool.closeLbug();
    expect(mocks.closes[1]).toHaveBeenCalledTimes(1);
    expect(mocks.releases[0]).toHaveBeenCalledTimes(1);
  });
  it('supports failed wrappers without a driver init promise property', async () => {
    mocks.absentInitPromise = true;
    mocks.errors = ['corrupt WAL', 'corrupt WAL'];
    const pool = await import('../../src/core/lbug/pool-adapter.js');
    await expect(pool.initLbug('repo', '/repo')).rejects.toThrow('unrecoverable');
    await pool.closeLbug();
    expect(mocks.releases[0]).toHaveBeenCalledTimes(1);
  });
  it('retries lock failures without recovery', async () => {
    mocks.errors = ['Could not set lock', 'lock held', null];
    const pool = await import('../../src/core/lbug/pool-adapter.js');
    const opening = pool.initLbug('repo', '/repo');
    void opening.catch(() => {});
    await vi.advanceTimersByTimeAsync(10000);
    await opening;
    expect(mocks.construct).toHaveBeenCalledTimes(3);
    expect(mocks.construct.mock.calls.every((args) => args.length === 4)).toBe(true);
    await pool.closeLbug();
  });
  it('does not let another path cleanup failure block admission', async () => {
    mocks.errors = ['corrupt WAL', 'corrupt WAL'];
    const pool = await import('../../src/core/lbug/pool-adapter.js');
    await expect(pool.initLbug('bad', '/bad')).rejects.toThrow();
    mocks.closes[1].mockRejectedValueOnce(new Error('close failed'));
    vi.setSystemTime(30000);
    await pool.initLbug('good', '/good');
    expect(mocks.releases[0]).not.toHaveBeenCalled();
    await pool.closeLbug();
    expect(mocks.releases[0]).toHaveBeenCalledTimes(1);
  });
});
