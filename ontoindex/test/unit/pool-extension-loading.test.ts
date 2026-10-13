import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
  resolveLocalLbugExtensionPath: vi.fn(),
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  resolveLocalLbugExtensionPath: mocks.resolveLocalLbugExtensionPath,
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

    expect(mocks.resolveLocalLbugExtensionPath).toHaveBeenCalledOnce();
    expect(mocks.resolveLocalLbugExtensionPath).toHaveBeenCalledWith('fts');
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
