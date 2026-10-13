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
