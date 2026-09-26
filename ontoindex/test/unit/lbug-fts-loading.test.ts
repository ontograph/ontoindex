import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
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
  createFTSIndex,
  initLbug,
  loadFTSExtension,
  loadVectorExtension,
} from '../../src/core/lbug/lbug-adapter.js';

describe('FTS extension loading', () => {
  const dbPath = '/tmp/ontoindex-fts-loading.test.lbug';
  const originalInstallFlag = process.env.ONTOINDEX_ALLOW_EXTENSION_INSTALL;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ONTOINDEX_ALLOW_EXTENSION_INSTALL;
    process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR = '/tmp/ontoindex-missing-fts-extension';
    process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE = '/tmp/ontoindex-missing-fts-cache';
    mocks.query.mockImplementation(async (query: string) => {
      if (/fts|vector/i.test(query)) {
        throw new Error('extension is unavailable');
      }
      return { getAll: async () => [] };
    });
  });

  // Cached-path loads (`LOAD EXTENSION '<file>'`) depend on the host cache; assert the rest.
  const extensionQueries = (pattern: RegExp): string[] =>
    mocks.query.mock.calls
      .map(([query]) => String(query))
      .filter((query) => pattern.test(query) && !query.startsWith("LOAD EXTENSION '"));

  afterEach(async () => {
    await closeLbug();
    delete process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR;
    delete process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE;
    if (originalInstallFlag === undefined) {
      delete process.env.ONTOINDEX_ALLOW_EXTENSION_INSTALL;
    } else {
      process.env.ONTOINDEX_ALLOW_EXTENSION_INSTALL = originalInstallFlag;
    }
  });

  it('does not install over the network or retry an unavailable extension by default', async () => {
    await initLbug(dbPath);

    await loadFTSExtension();
    await loadFTSExtension();

    expect(extensionQueries(/EXTENSION fts|INSTALL fts/)).toEqual(['LOAD EXTENSION fts']);
  });

  it('skips CREATE_FTS_INDEX with a clear error when FTS is unavailable', async () => {
    await initLbug(dbPath);

    await expect(createFTSIndex('File', 'file_fts', ['name'])).rejects.toThrow(
      /FTS extension unavailable/,
    );
    expect(extensionQueries(/CREATE_FTS_INDEX/)).toEqual([]);
  });

  it('does not install VECTOR over the network by default', async () => {
    await initLbug(dbPath);

    await loadVectorExtension();
    await loadVectorExtension();

    expect(extensionQueries(/VECTOR/)).toEqual(['LOAD EXTENSION VECTOR']);
  });

  it('allows network installation when explicitly enabled', async () => {
    process.env.ONTOINDEX_ALLOW_EXTENSION_INSTALL = '1';
    let installed = false;
    mocks.query.mockImplementation(async (query: string) => {
      if (query.startsWith('LOAD EXTENSION') && /fts/.test(query) && !installed) {
        throw new Error('fts extension is unavailable');
      }
      if (query === 'INSTALL fts') installed = true;
      return { getAll: async () => [] };
    });

    await initLbug(dbPath);
    await loadFTSExtension();

    expect(extensionQueries(/EXTENSION fts|INSTALL fts/)).toEqual([
      'LOAD EXTENSION fts',
      'INSTALL fts',
      'LOAD EXTENSION fts',
    ]);
  });
});
