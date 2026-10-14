import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: class {
      close = mocks.close;
    },
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

describe('LadybugDB extension loading', () => {
  const dbPath = '/tmp/ontoindex-extension-loading.test.lbug';
  const originalInstallFlag = process.env.ONTOINDEX_ALLOW_EXTENSION_INSTALL;
  const originalExtensionDir = process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR;
  const originalExtensionCache = process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ONTOINDEX_ALLOW_EXTENSION_INSTALL;
    process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR = '/tmp/ontoindex-missing-extensions';
    process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE = '/tmp/ontoindex-missing-extension-cache';
    mocks.query.mockImplementation(async (query: string) => {
      if (/fts|vector/i.test(query)) throw new Error('extension is unavailable');
      return { getAll: async () => [], close: vi.fn() };
    });
  });

  afterEach(async () => {
    await closeLbug();
    for (const [key, value] of [
      ['ONTOINDEX_ALLOW_EXTENSION_INSTALL', originalInstallFlag],
      ['ONTOINDEX_LADYBUG_EXTENSION_DIR', originalExtensionDir],
      ['ONTOINDEX_LADYBUG_EXTENSIONS_CACHE', originalExtensionCache],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const extensionQueries = (pattern: RegExp): string[] =>
    mocks.query.mock.calls
      .map(([query]) => String(query))
      .filter((query) => pattern.test(query) && !query.startsWith("LOAD EXTENSION '"));

  it('does not install FTS by default and caches its unavailable state', async () => {
    await initLbug(dbPath);

    await loadFTSExtension();
    await loadFTSExtension();

    expect(extensionQueries(/EXTENSION fts|INSTALL fts/)).toEqual(['LOAD EXTENSION fts']);
  });

  it('does not install or retry VECTOR by default', async () => {
    await initLbug(dbPath);

    await loadVectorExtension();
    await loadVectorExtension();

    expect(extensionQueries(/EXTENSION VECTOR|INSTALL VECTOR/)).toEqual(['LOAD EXTENSION VECTOR']);
  });

  it('skips CREATE_FTS_INDEX with a clear error when FTS is unavailable', async () => {
    await initLbug(dbPath);

    await expect(createFTSIndex('File', 'file_fts', ['name'])).rejects.toThrow(
      /FTS extension unavailable/,
    );
    expect(extensionQueries(/CREATE_FTS_INDEX/)).toEqual([]);
  });

  it('installs FTS over the network when explicitly enabled', async () => {
    process.env.ONTOINDEX_ALLOW_EXTENSION_INSTALL = '1';
    let installed = false;
    mocks.query.mockImplementation(async (query: string) => {
      if (/LOAD EXTENSION .*fts/i.test(query) && !installed) {
        throw new Error('extension is unavailable');
      }
      if (query === 'INSTALL fts') installed = true;
      return { getAll: async () => [], close: vi.fn() };
    });

    await initLbug(dbPath);
    await loadFTSExtension();

    expect(extensionQueries(/EXTENSION fts|INSTALL fts/)).toEqual([
      'LOAD EXTENSION fts',
      'INSTALL fts',
      'LOAD EXTENSION fts',
    ]);
  });

  it('installs VECTOR over the network when explicitly enabled', async () => {
    process.env.ONTOINDEX_ALLOW_EXTENSION_INSTALL = '1';
    let installed = false;
    mocks.query.mockImplementation(async (query: string) => {
      if (/LOAD EXTENSION .*vector/i.test(query) && !installed) {
        throw new Error('extension is unavailable');
      }
      if (query === 'INSTALL VECTOR') installed = true;
      return { getAll: async () => [], close: vi.fn() };
    });

    await initLbug(dbPath);

    expect(extensionQueries(/EXTENSION VECTOR|INSTALL VECTOR/)).toEqual([
      'LOAD EXTENSION VECTOR',
      'INSTALL VECTOR',
      'LOAD EXTENSION VECTOR',
    ]);
  });
});
