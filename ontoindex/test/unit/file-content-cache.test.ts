import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { GraphNode } from 'ontoindex-shared';
import {
  FileContentCache,
  MAX_CACHED_CHARS,
  MAX_SNIPPET_BOUNDARIES,
  isBinaryContent,
} from '../../src/core/lbug/csv-generator.js';

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

  it('keeps the entry-count limit and never retains oversized compatibility reads', async () => {
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
    expect(read).toHaveBeenCalledTimes(5);
  });
});

const symbol = (filePath: string, startLine: number, endLine = startLine): GraphNode => ({
  id: `${filePath}:${startLine}:${endLine}`,
  label: 'Function',
  properties: { name: 'symbol', filePath, startLine, endLine },
});

const withSources = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'csv-snippets-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};

describe('bounded symbol snippets', () => {
  it('reads interleaved late and overlapping snippets without whole-file reads or rescans', async () => {
    await withSources(async (directory) => {
      const contents = new Map([
        [
          'a.ts',
          'x'.repeat(5 * 1024 * 1024) +
            '\n' +
            Array.from({ length: 4000 }, (_, i) => `a${i}\r`).join('\n') +
            '\n',
        ],
        [
          'b.ts',
          'y'.repeat(5 * 1024 * 1024) +
            '\n' +
            Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n'),
        ],
      ]);
      for (const [file, content] of contents)
        await fs.writeFile(path.join(directory, file), content);
      const nodes = [
        symbol('a.ts', 3990),
        symbol('b.ts', 2990),
        symbol('a.ts', 3989, 3992),
        symbol('a.ts', 1),
        symbol('b.ts', 1),
        symbol('a.ts', 4001),
        symbol('a.ts', 5000),
      ];
      const cache = new FileContentCache(directory);
      cache.planSnippets(nodes);
      const originalOpen = fs.open.bind(fs);
      let scannedBytes = 0;
      let snippetBytes = 0;
      const cap = 32;
      const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(
          async (...readArgs: Parameters<typeof read>) => {
            const result = await read(...readArgs);
            const requestedBytes = readArgs[2] as number;
            if (requestedBytes > 3 * (cap + 1) + 4) scannedBytes += result.bytesRead;
            else snippetBytes += result.bytesRead;
            expect(requestedBytes).toBeLessThanOrEqual(64 * 1024);
            return result;
          },
        );
        return handle;
      });
      const wholeRead = vi.spyOn(fs, 'readFile');
      for (const node of nodes) {
        const { filePath, startLine, endLine } = node.properties;
        const lines = contents.get(filePath)!.split('\n');
        const expected = lines.slice(Math.max(0, startLine! - 2), endLine! + 3).join('\n');
        expect(await cache.getSnippet(filePath, startLine!, endLine!, cap)).toBe(
          expected.length > cap ? expected.slice(0, cap) + '\n... [truncated]' : expected,
        );
      }
      expect(wholeRead).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(nodes.length);
      // One complete fixed-buffer scan per source, plus only bounded snippet reads.
      const totalBytes = [...contents.values()].reduce(
        (sum, content) => sum + Buffer.byteLength(content),
        0,
      );
      expect(scannedBytes + snippetBytes).toBeLessThanOrEqual(
        totalBytes + nodes.length * (3 * (cap + 1) + 4),
      );
      expect(cache.retainedChars).toBe(0);
      await expect(cache.getSnippet('a.ts', 3990, 3990, cap)).rejects.toThrow('Unplanned');
    });
  });

  it.each([
    ['bom-crlf', Buffer.from('\ufeffa\r\nb😀\r\nc\rd\n'), 1, 100],
    ['unicode-cut', Buffer.from('a😀尾\nsecond\nthird'), 1, 2],
    ['malformed', Buffer.from([0xef, 0xbb, 0xbf, 0xf0, 0x80, 0x0a, 0xff, 0x61]), 1, 100],
    ['trailing-empty', Buffer.from('a\nb\nc\n'), 3, 100],
    ['empty', Buffer.alloc(0), 1, 100],
    ['strict-threshold', Buffer.from('x'.repeat(900) + '\0'.repeat(100)), 1, 32],
    ['binary', Buffer.from('x'.repeat(899) + '\0'.repeat(101)), 1, 32],
    [
      'binary-late',
      Buffer.from('x'.repeat(899) + '\0'.repeat(101) + '\n'.repeat(20) + 'late'),
      20,
      32,
    ],
  ] as const)('matches full UTF-8 split/join semantics for %s', async (_name, bytes, line, cap) => {
    await withSources(async (directory) => {
      await fs.writeFile(path.join(directory, 'source.ts'), bytes);
      const cache = new FileContentCache(directory);
      cache.planSnippets([symbol('source.ts', line)]);
      const content = bytes.toString('utf8');
      const full = content
        .split('\n')
        .slice(Math.max(0, line - 2), line + 3)
        .join('\n');
      const expected = isBinaryContent(content)
        ? '[Binary file - content not stored]'
        : full.length > cap
          ? full.slice(0, cap) + '\n... [truncated]'
          : full;
      expect(await cache.getSnippet('source.ts', line, line, cap)).toBe(expected);
    });
  });

  it('fails explicitly when source bytes change after the boundary scan', async () => {
    await withSources(async (directory) => {
      const file = path.join(directory, 'source.ts');
      await fs.writeFile(file, 'one\ntwo\nthree');
      const cache = new FileContentCache(directory);
      cache.planSnippets([symbol('source.ts', 1), symbol('source.ts', 2)]);
      await cache.getSnippet('source.ts', 1, 1, 100);
      await fs.writeFile(file, 'replacement\nchanged');
      await expect(cache.getSnippet('source.ts', 2, 2, 100)).rejects.toThrow('CSV source changed');
    });
  });

  it('fails explicitly when the source path is replaced during the scan', async () => {
    await withSources(async (directory) => {
      const file = path.join(directory, 'source.ts');
      await fs.writeFile(file, 'one\ntwo\nthree');
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementationOnce(
          async (...readArgs: Parameters<typeof read>) => {
            const result = await read(...readArgs);
            await fs.rename(file, `${file}.old`);
            await fs.writeFile(file, 'new\nsource');
            return result;
          },
        );
        return handle;
      });
      const cache = new FileContentCache(directory);
      cache.planSnippets([symbol('source.ts', 1)]);
      await expect(cache.getSnippet('source.ts', 1, 1, 100)).rejects.toThrow('CSV source changed');
    });
  });

  it('rejects boundary metadata overflow before allocating the next pair', () => {
    const cache = new FileContentCache('/repo');
    function* repeated(): Iterable<GraphNode> {
      for (let i = 0; i <= MAX_SNIPPET_BOUNDARIES / 2; i++) yield symbol('a.ts', 1);
    }
    expect(() => cache.planSnippets(repeated())).toThrow('boundary metadata exceeds');
  });
});
