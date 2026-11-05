import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
  resolveLocalLbugExtensionPath: vi.fn(),
  lbugExtensionInstallAllowed: vi.fn(),
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  resolveLocalLbugExtensionPath: mocks.resolveLocalLbugExtensionPath,
  lbugExtensionInstallAllowed: mocks.lbugExtensionInstallAllowed,
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: class {},
    Connection: class {
      query = mocks.query;
      close = mocks.close;
    },
  },
}));

import {
  closeLbug,
  initLbugWithDb,
  isUnavailableExtension,
} from '../../src/core/lbug/pool-adapter.js';

describe('pool extension loading', () => {
  const repoId = 'pool-extension-loading';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lbugExtensionInstallAllowed.mockReturnValue(false);
    mocks.resolveLocalLbugExtensionPath.mockResolvedValue("/tmp/onto'index/libfts.lbug_extension");
    mocks.query.mockImplementation(async (query: string) => {
      if (query.startsWith("LOAD EXTENSION '/tmp/")) {
        throw new Error('cached extension is incompatible');
      }
      return undefined;
    });
  });

  afterEach(async () => {
    await closeLbug(repoId);
  });

  it('tries an escaped resolved FTS path before the bare fallback', async () => {
    await initLbugWithDb(repoId, {} as never, '/tmp/pool-extension-loading.lbug');

    expect(mocks.resolveLocalLbugExtensionPath).toHaveBeenCalledTimes(2);
    expect(mocks.resolveLocalLbugExtensionPath).toHaveBeenCalledWith('fts');
    expect(mocks.resolveLocalLbugExtensionPath).toHaveBeenCalledWith('vector');
    expect(mocks.query.mock.calls.slice(0, 2).map(([query]) => query)).toEqual([
      "LOAD EXTENSION '/tmp/onto\\'index/libfts.lbug_extension'",
      'LOAD EXTENSION fts',
    ]);
  });

  it('degrades when LadybugDB reports an extension that was never installed', async () => {
    mocks.resolveLocalLbugExtensionPath.mockResolvedValue(null);
    mocks.query.mockImplementation(async (query: string) => {
      if (query.includes('EXTENSION fts') || query.includes('EXTENSION VECTOR')) {
        throw new Error(
          'Binder exception: Extension: fts is an official extension and has not been installed.\nYou can install it by: install fts.',
        );
      }
      return undefined;
    });
    await expect(
      initLbugWithDb(repoId, {} as never, '/tmp/pool-extension-loading.lbug'),
    ).resolves.toBeUndefined();
  });

  it('keeps unrelated extension failures fatal', async () => {
    mocks.resolveLocalLbugExtensionPath.mockResolvedValue(null);
    mocks.query.mockImplementation(async (query: string) => {
      if (query.includes('EXTENSION fts'))
        throw new Error('Runtime exception: database is corrupted');
      return undefined;
    });
    await expect(
      initLbugWithDb(repoId, {} as never, '/tmp/pool-extension-loading.lbug'),
    ).rejects.toThrow('corrupted');
  });

  it.each(['fts', 'vector'])(
    'preserves the corrupt local %s error when the bare fallback is absent',
    async (extension) => {
      const localError = new Error('invalid ELF header');
      mocks.resolveLocalLbugExtensionPath.mockImplementation(async (name: string) =>
        name === extension ? `/tmp/lib${name}.lbug_extension` : null,
      );
      mocks.query.mockImplementation(async (query: string) => {
        if (query === `LOAD EXTENSION '/tmp/lib${extension}.lbug_extension'`) throw localError;
        if (query.toLowerCase() === `load extension ${extension}`) {
          throw new Error(`Extension: ${extension} has not been installed`);
        }
        return undefined;
      });

      await expect(
        initLbugWithDb(repoId, {} as never, '/tmp/pool-extension-loading.lbug'),
      ).rejects.toBe(localError);
    },
  );

  it.each(['fts', 'vector'])(
    'loads %s when the local load fails but the bare fallback succeeds',
    async (extension) => {
      mocks.resolveLocalLbugExtensionPath.mockImplementation(async (name: string) =>
        name === extension ? `/tmp/lib${name}.lbug_extension` : null,
      );
      await expect(
        initLbugWithDb(repoId, {} as never, '/tmp/pool-extension-loading.lbug'),
      ).resolves.toBeUndefined();
      expect(mocks.query).toHaveBeenCalledWith(
        `LOAD EXTENSION '/tmp/lib${extension}.lbug_extension'`,
      );
      expect(mocks.query).toHaveBeenCalledWith(
        `LOAD EXTENSION ${extension === 'fts' ? 'fts' : 'VECTOR'}`,
      );
    },
  );

  it.each(['fts', 'vector'])(
    'degrades when both local and bare %s loads report absence',
    async (extension) => {
      mocks.resolveLocalLbugExtensionPath.mockImplementation(async (name: string) =>
        name === extension ? `/tmp/lib${name}.lbug_extension` : null,
      );
      mocks.query.mockImplementation(async (query: string) => {
        if (query.toLowerCase().includes(extension)) {
          throw new Error(`Extension: ${extension} has not been installed`);
        }
        return undefined;
      });
      await expect(
        initLbugWithDb(repoId, {} as never, '/tmp/pool-extension-loading.lbug'),
      ).resolves.toBeUndefined();
    },
  );

  it.each(['install absent', 'reload absent', 'success'])(
    'handles VECTOR install fallback: %s',
    async (outcome) => {
      const localError = new Error('invalid ELF header');
      mocks.lbugExtensionInstallAllowed.mockReturnValue(true);
      mocks.resolveLocalLbugExtensionPath.mockImplementation(async (name: string) =>
        name === 'vector' ? '/tmp/libvector.lbug_extension' : null,
      );
      let vectorLoads = 0;
      mocks.query.mockImplementation(async (query: string) => {
        if (query === "LOAD EXTENSION '/tmp/libvector.lbug_extension'") throw localError;
        if (query === 'INSTALL VECTOR' && outcome === 'install absent') {
          throw new Error('Could not download extension VECTOR');
        }
        if (
          query === 'LOAD EXTENSION VECTOR' &&
          (++vectorLoads === 1 || outcome === 'reload absent')
        ) {
          throw new Error('Extension: VECTOR has not been installed');
        }
        return undefined;
      });
      const initialization = initLbugWithDb(
        repoId,
        {} as never,
        '/tmp/pool-extension-loading.lbug',
      );
      if (outcome === 'success') {
        await expect(initialization).resolves.toBeUndefined();
      } else {
        await expect(initialization).rejects.toBe(localError);
      }
      expect(mocks.query).toHaveBeenCalledWith('INSTALL VECTOR');
    },
  );
});

describe('isUnavailableExtension', () => {
  it.each([
    'Binder exception: Extension: fts is an official extension and has not been installed.\nYou can install it by: install fts.',
    "Binder exception: The extension /x/libfts.lbug_extension is neither an official extension, nor does the extension path: '/x/libfts.lbug_extension' exists.",
    'extension vector not found',
  ])('treats an absent extension as unavailable: %s', (message) => {
    expect(isUnavailableExtension(new Error(message))).toBe(true);
  });

  it.each([
    'Runtime exception: database is corrupted',
    'Connection pool timeout',
    'Binder exception: Table Foo does not exist',
  ])('keeps other errors fatal: %s', (message) => {
    expect(isUnavailableExtension(new Error(message))).toBe(false);
  });
});
