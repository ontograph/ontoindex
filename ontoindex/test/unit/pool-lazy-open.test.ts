import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ release: vi.fn(async () => {}) }));
vi.mock('../../src/storage/repo-manager.js', () => ({
  acquireIndexGenerationPin: async (dbPath: string) => ({ dbPath, release: mocks.release }),
}));
vi.mock('fs/promises', () => ({
  default: {
    stat: async () => ({ ino: 1, size: 1, mtimeMs: 1 }),
    realpath: async () => '/lazy',
  },
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  resolveLocalLbugExtensionPath: async () => null,
}));

describe('real driver lazy database open', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('surfaces native init failure before publishing and keeps failed ownership fenced', async () => {
    const require = createRequire(import.meta.url);
    const nativePath = require.resolve('@ladybugdb/core').replace(/index\.js$/, 'lbug_native.js');
    const databasePath = nativePath.replace(/lbug_native\.js$/, 'database.js');
    const oldNative = require.cache[nativePath];
    const oldDatabase = require.cache[databasePath];
    const init = vi.fn((callback: (error: Error) => void) =>
      callback(new Error('Could not set lock on native file')),
    );
    require.cache[nativePath] = {
      exports: {
        NodeDatabase: class {
          initAsync = init;
        },
      },
    } as any;
    delete require.cache[databasePath];
    const Database = require(databasePath);
    const connectionPath = nativePath.replace(/lbug_native\.js$/, 'connection.js');
    const oldConnection = require.cache[connectionPath];
    delete require.cache[connectionPath];
    const Connection = require(connectionPath);
    vi.doMock('@ladybugdb/core', () => ({
      default: {
        Database,
        Connection,
      },
    }));
    try {
      const pool = await import('../../src/core/lbug/pool-adapter.js');
      await expect(pool.initLbug('lazy', '/lazy')).rejects.toThrow('native initialization failed');
      expect(init).toHaveBeenCalledTimes(1);
      expect(pool.isLbugDbPathReady('/lazy')).toBe(false);
      await expect(pool.executeQuery('lazy', 'RETURN 1')).rejects.toThrow('not initialized');
      expect(mocks.release).not.toHaveBeenCalled();
      await expect(pool.initLbug('lazy', '/lazy')).rejects.toThrow('remains fenced');
      expect(init).toHaveBeenCalledTimes(1);
    } finally {
      if (oldNative) require.cache[nativePath] = oldNative;
      else delete require.cache[nativePath];
      if (oldDatabase) require.cache[databasePath] = oldDatabase;
      else delete require.cache[databasePath];
      if (oldConnection) require.cache[connectionPath] = oldConnection;
      else delete require.cache[connectionPath];
      vi.doUnmock('@ladybugdb/core');
    }
  });
});
