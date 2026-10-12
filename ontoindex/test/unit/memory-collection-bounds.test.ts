import fs from 'fs/promises';
import { constants } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadMemory,
  loadMemoryCollection,
  loadMemories,
  MAX_MEMORY_FILE_SIZE_BYTES,
} from '../../src/mcp/memory-parser.js';

describe('bounded memory collection', () => {
  let repo: string;
  let directory: string;
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-bounds-'));
    directory = path.join(repo, '.ontoindex/memories');
    await fs.mkdir(directory, { recursive: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('counts all directory entries and refuses overflow without revealing names', async () => {
    for (let i = 0; i < 1024; i++) await fs.writeFile(path.join(directory, `${i}.txt`), '');
    expect(await loadMemoryCollection(repo)).toMatchObject({
      total: 0,
      truncated: false,
      memories: [],
    });
    await fs.writeFile(path.join(directory, 'last.md'), 'body');
    expect(await loadMemoryCollection(repo)).toMatchObject({
      total: null,
      truncated: true,
      memories: [],
    });
  });

  it('returns a sorted file prefix with exact total and rejects array-only partial output', async () => {
    for (let i = 0; i < 129; i++)
      await fs.writeFile(path.join(directory, `${String(i).padStart(3, '0')}.md`), 'body');
    const result = await loadMemoryCollection(repo);
    expect(result).toMatchObject({ total: 129, truncated: true });
    expect(result.memories).toHaveLength(128);
    expect(result.memories[0].fileName).toBe('000.md');
    expect(result.memories[127].fileName).toBe('127.md');
    await expect(loadMemories(repo)).rejects.toThrow('file limit');
  });

  it('verifies directory containment before enumeration', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-memories-'));
    try {
      await fs.writeFile(path.join(outside, '.invalid.md'), 'secret');
      await fs.rm(directory, { recursive: true });
      await fs.symlink(outside, directory);
      const enumerate = vi.spyOn(fs, 'opendir');
      expect(await loadMemoryCollection(repo)).toMatchObject({
        total: null,
        truncated: true,
        memories: [],
      });
      expect(enumerate).not.toHaveBeenCalled();
      expect(await loadMemories(repo)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('clears metadata bodies and distinguishes a missing directory', async () => {
    await fs.writeFile(path.join(directory, 'note.md'), 'body');
    expect((await loadMemoryCollection(repo, { includeBody: false })).memories[0].body).toBe('');
    await fs.rm(directory, { recursive: true });
    expect(await loadMemoryCollection(repo)).toMatchObject({
      total: 0,
      truncated: false,
      directoryMissing: true,
    });
  });

  it('enforces the aggregate byte budget and preserves individual oversize artifacts', async () => {
    for (let i = 0; i < 17; i++)
      await fs.writeFile(
        path.join(directory, `${String(i).padStart(2, '0')}.md`),
        'x'.repeat(MAX_MEMORY_FILE_SIZE_BYTES),
      );
    const result = await loadMemoryCollection(repo);
    expect(result).toMatchObject({ total: 17, truncated: true });
    expect(
      result.memories.reduce((sum, memory) => sum + (memory.sizeBytes ?? 0), 0),
    ).toBeLessThanOrEqual(1024 * 1024);
    await fs.writeFile(
      path.join(directory, 'large.md'),
      'x'.repeat(MAX_MEMORY_FILE_SIZE_BYTES + 1),
    );
    expect(await loadMemory(repo, 'large')).toMatchObject({
      content: null,
      memory: { valid: false, body: '' },
    });
  });

  it('accepts complete files that exactly fill the aggregate byte budget', async () => {
    for (let i = 0; i < 16; i++) {
      await fs.writeFile(
        path.join(directory, `${String(i).padStart(2, '0')}.md`),
        'x'.repeat(MAX_MEMORY_FILE_SIZE_BYTES),
      );
    }
    const result = await loadMemoryCollection(repo);
    expect(result).toMatchObject({ total: 16, truncated: false, warnings: [] });
    expect(result.memories).toHaveLength(16);
    expect(result.memories.every((memory) => memory.sizeBytes === MAX_MEMORY_FILE_SIZE_BYTES)).toBe(
      true,
    );
    expect(result.memories[15].validationErrors).not.toContain(
      'Memory collection byte limit reached',
    );
  });

  it('bounds growing files through short reads and closes their handles', async () => {
    await fs.writeFile(path.join(directory, 'growing.md'), 'initial');
    const realOpen = fs.open.bind(fs);
    let acquired = 0;
    const close = vi.fn();
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, 'stat').mockResolvedValue({ size: 7, isFile: () => true } as Awaited<
        ReturnType<typeof handle.stat>
      >);
      vi.spyOn(handle, 'read').mockImplementation((async (
        buffer: Buffer,
        offset: number,
        length: number,
      ) => {
        const bytesRead = Math.min(length, 997);
        buffer.fill(120, offset, offset + bytesRead);
        acquired += bytesRead;
        return { bytesRead, buffer };
      }) as typeof handle.read);
      const realClose = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        close();
        await realClose();
      });
      return handle;
    });
    expect(await loadMemory(repo, 'growing')).toMatchObject({
      content: null,
      memory: { valid: false, body: '' },
    });
    expect(acquired).toBe(MAX_MEMORY_FILE_SIZE_BYTES + 1);
    expect(close).toHaveBeenCalledOnce();
  });

  it('opens nonblocking and rejects nonregular handles before reading', async () => {
    await fs.writeFile(path.join(directory, 'special.md'), 'initial');
    const read = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const open = vi.spyOn(fs, 'open').mockResolvedValue({
      stat: async () => ({ size: 0, isFile: () => false }),
      read,
      close,
    } as unknown as Awaited<ReturnType<typeof fs.open>>);
    expect(await loadMemory(repo, 'special')).toMatchObject({
      content: null,
      memory: { valid: false },
    });
    expect(open).toHaveBeenCalledWith(
      await fs.realpath(path.join(directory, 'special.md')),
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
