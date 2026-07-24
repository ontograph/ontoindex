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

import { closeLbug, initLbugWithDb } from '../../src/core/lbug/pool-adapter.js';

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
});
