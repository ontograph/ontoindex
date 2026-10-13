import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ construct: vi.fn(), failFirst: false }));
vi.mock('../../src/storage/repo-manager.js', () => ({
  acquireIndexGenerationPin: async (dbPath: string) => ({ dbPath, release: async () => {} }),
}));
vi.mock('fs/promises', () => ({
  default: {
    stat: async () => ({ ino: 1, size: 1, mtimeMs: 1 }),
    realpath: async () => '/buffer',
  },
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  resolveLocalLbugExtensionPath: async () => null,
}));
vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: class {
      constructor(...args: unknown[]) {
        mocks.construct(...args);
        if (mocks.failFirst && mocks.construct.mock.calls.length === 1)
          throw new Error('corrupt WAL');
      }
      init = async () => {};
      close = async () => {};
    },
    Connection: class {
      query = async () => ({ getAll: async () => [], close: async () => {} });
      close = async () => {};
    },
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  mocks.construct.mockClear();
  mocks.failFirst = false;
});

describe('LadybugDB buffer budget', () => {
  it.each([undefined, '', '0', '64', '16384', '-1', '16385', '1.5', '64MB', 'NaN', 'Infinity'])(
    'validates %s',
    async (raw) => {
      vi.stubEnv('ONTOINDEX_LBUG_BUFFER_MB', raw);
      const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
      const pool = await import('../../src/core/lbug/pool-adapter.js');
      await pool.initLbug('buffer', '/buffer');
      const valid = raw === '64' || raw === '16384';
      expect(mocks.construct.mock.calls[0][1]).toBe(valid ? Number(raw) * 1048576 : 0);
      expect(warning).toHaveBeenCalledTimes(raw && raw !== '0' && !valid ? 1 : 0);
      await pool.closeLbug('buffer');
    },
  );
  it('uses the same budget for normal and recovery opens', async () => {
    vi.stubEnv('ONTOINDEX_LBUG_BUFFER_MB', '128');
    mocks.failFirst = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = await import('../../src/core/lbug/pool-adapter.js');
    await pool.initLbug('buffer', '/buffer');
    expect(mocks.construct.mock.calls.map((args) => args[1])).toEqual([
      128 * 1048576,
      128 * 1048576,
    ]);
    await pool.closeLbug('buffer');
  });
});
