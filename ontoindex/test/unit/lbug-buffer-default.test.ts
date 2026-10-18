import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

describe('LadybugDB buffer manager default', () => {
  it.each([
    [undefined, 64],
    ['', 64],
    ['0', 64],
    ['64', 64],
    ['128', 128],
    ['abc', 64],
    ['-1', 64],
    ['99999', 64],
    ['1.5', 64],
  ])('maps %s to %i MiB', async (raw, expectedMb) => {
    if (raw === undefined) vi.stubEnv('ONTOINDEX_LBUG_BUFFER_MB', undefined);
    else vi.stubEnv('ONTOINDEX_LBUG_BUFFER_MB', raw);
    vi.resetModules();
    const { readBufferManagerSize } = await import('../../src/core/lbug/pool-adapter.js');
    expect(readBufferManagerSize()).toBe(expectedMb * 1048576);
  });
});

describe('LadybugDB buffer for workspace generations', () => {
  const overlay = '/repo/.ontoindex/overlay/1792-123-abc/lbug';
  const committed = '/repo/.ontoindex/generations/g1/lbug';
  const load = async (raw?: string) => {
    vi.stubEnv('ONTOINDEX_LBUG_BUFFER_MB', raw);
    vi.resetModules();
    return (await import('../../src/core/lbug/pool-adapter.js')).readBufferManagerSize;
  };

  it('gives an overlay generation 256 MiB and the committed index 64 MiB by default', async () => {
    const read = await load(undefined);
    expect(read(overlay)).toBe(256 * 1048576);
    expect(read(committed)).toBe(64 * 1048576);
    expect(read()).toBe(64 * 1048576);
  });

  it('treats an empty or zero setting as unset', async () => {
    for (const raw of ['', '0']) {
      const read = await load(raw);
      expect(read(overlay)).toBe(256 * 1048576);
      expect(read(committed)).toBe(64 * 1048576);
    }
  });

  it('lets an explicit setting override both', async () => {
    const read = await load('128');
    expect(read(overlay)).toBe(128 * 1048576);
    expect(read(committed)).toBe(128 * 1048576);
  });

  it('does not mistake a directory named overlay elsewhere in the path', async () => {
    const read = await load(undefined);
    expect(read('/overlay/store/generations/lbug')).toBe(64 * 1048576);
    expect(read('/repo/.ontoindex/overlay/lbug')).toBe(64 * 1048576);
  });
});
