import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import { FileContentCache, MAX_CACHED_CHARS } from '../../src/core/lbug/csv-generator.js';

afterEach(() => vi.restoreAllMocks());

describe('FileContentCache', () => {
  it('evicts least-recently-used entries to bound retained characters', async () => {
    const content = 'a'.repeat(4 * 1024 * 1024);
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: content.length } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    const read = vi.spyOn(fs, 'readFile').mockResolvedValue(content);
    const cache = new FileContentCache('/repo');
    for (let i = 0; i < 16; i++) await cache.get(`${i}.ts`);
    expect(cache.retainedChars).toBe(MAX_CACHED_CHARS);
    await cache.get('0.ts'); // Touch the oldest entry so 1.ts is evicted next.
    await cache.get('16.ts');
    expect(cache.retainedChars).toBe(MAX_CACHED_CHARS);
    await cache.get('0.ts');
    expect(read).toHaveBeenCalledTimes(17);
    await cache.get('1.ts');
    expect(read).toHaveBeenCalledTimes(18);
    expect(cache.retainedChars).toBeLessThanOrEqual(MAX_CACHED_CHARS);
  });

  it('keeps the entry-count limit and excludes the large-file slot from the LRU total', async () => {
    const stat = vi
      .spyOn(fs, 'stat')
      .mockResolvedValue({ size: 3 } as Awaited<ReturnType<typeof fs.stat>>);
    const read = vi.spyOn(fs, 'readFile').mockResolvedValue('abc');
    const cache = new FileContentCache('/repo', 2);
    await cache.get('a.ts');
    await cache.get('b.ts');
    await cache.get('c.ts');
    expect(cache.retainedChars).toBe(6);
    stat.mockResolvedValue({ size: MAX_CACHED_CHARS + 1 } as Awaited<ReturnType<typeof fs.stat>>);
    read.mockResolvedValue('large');
    await cache.getLines('large.ts');
    expect(cache.retainedChars).toBe(6);
    expect(await cache.get('large.ts')).toBe('large');
    expect(read).toHaveBeenCalledTimes(4);
  });
});
