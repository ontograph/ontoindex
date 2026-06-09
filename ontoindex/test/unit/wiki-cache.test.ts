import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import {
  pageKey,
  getCachedPage,
  setCachedPage,
  evictStaleCache,
} from '../../src/core/wiki/wiki-cache.js';

// Helper to build the expected SHA-256 for a given set of args,
// mirroring the implementation's formula.
function expectedKey(inputs: string[], modelName: string, templateVersion: string): string {
  const sorted = [...inputs].sort().join('\0');
  const data = `${templateVersion}\0${modelName}\0${sorted}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

describe('pageKey', () => {
  it('returns a consistent 64-char hex string', () => {
    const key = pageKey(['a', 'b'], 'gpt-4', '1');
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Calling again with identical args produces the same result
    expect(pageKey(['a', 'b'], 'gpt-4', '1')).toBe(key);
  });

  it('matches the expected SHA-256 formula', () => {
    const key = pageKey(['a', 'b'], 'gpt-4', '1');
    expect(key).toBe(expectedKey(['a', 'b'], 'gpt-4', '1'));
  });

  it('produces the same hash regardless of input order (inputs are sorted internally)', () => {
    const key1 = pageKey(['a', 'b'], 'gpt-4', '1');
    const key2 = pageKey(['b', 'a'], 'gpt-4', '1');
    expect(key1).toBe(key2);
  });

  it('produces a different hash when the model name differs', () => {
    const key1 = pageKey(['a', 'b'], 'gpt-4', '1');
    const key2 = pageKey(['a', 'b'], 'claude-3', '1');
    expect(key1).not.toBe(key2);
  });

  it('produces a different hash when the templateVersion differs', () => {
    const key1 = pageKey(['a', 'b'], 'gpt-4', '1');
    const key2 = pageKey(['a', 'b'], 'gpt-4', '2');
    expect(key1).not.toBe(key2);
  });

  it('produces a different hash when inputs differ', () => {
    const key1 = pageKey(['a', 'b'], 'gpt-4', '1');
    const key2 = pageKey(['a', 'c'], 'gpt-4', '1');
    expect(key1).not.toBe(key2);
  });
});

describe('getCachedPage / setCachedPage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-cache-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null for a key that has not been cached', async () => {
    const result = await getCachedPage(tmpDir, 'nonexistent-key');
    expect(result).toBeNull();
  });

  it('returns the written content after setCachedPage', async () => {
    const key = 'test-key-abc123';
    const content = '# My cached page\n\nSome content here.';
    await setCachedPage(tmpDir, key, content);
    const result = await getCachedPage(tmpDir, key);
    expect(result).toBe(content);
  });

  it('overwrites previously cached content for the same key', async () => {
    const key = 'overwrite-key';
    await setCachedPage(tmpDir, key, 'original');
    await setCachedPage(tmpDir, key, 'updated');
    expect(await getCachedPage(tmpDir, key)).toBe('updated');
  });

  it('creates the cacheDir when it does not exist yet', async () => {
    const newDir = path.join(tmpDir, 'nonexistent', 'subdir');
    await setCachedPage(newDir, 'mykey', 'hello');
    expect(await getCachedPage(newDir, 'mykey')).toBe('hello');
  });

  it('stores separate files for different keys', async () => {
    await setCachedPage(tmpDir, 'key1', 'content-one');
    await setCachedPage(tmpDir, 'key2', 'content-two');
    expect(await getCachedPage(tmpDir, 'key1')).toBe('content-one');
    expect(await getCachedPage(tmpDir, 'key2')).toBe('content-two');
  });
});

describe('evictStaleCache', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-evict-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('does not throw when the cache directory does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    await expect(evictStaleCache(missing)).resolves.toBeUndefined();
  });

  it('does not throw on an empty directory', async () => {
    await expect(evictStaleCache(tmpDir)).resolves.toBeUndefined();
  });

  it('deletes .md files whose mtime is older than 30 days', async () => {
    const filePath = path.join(tmpDir, 'stale.md');
    await fs.writeFile(filePath, 'old content', 'utf-8');

    // Backdate mtime to 31 days ago
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await fs.utimes(filePath, oldDate, oldDate);

    await evictStaleCache(tmpDir);

    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('keeps .md files whose mtime is recent (< 30 days old)', async () => {
    const filePath = path.join(tmpDir, 'fresh.md');
    await fs.writeFile(filePath, 'fresh content', 'utf-8');

    // Backdate to 15 days ago — still within the 30-day window
    const recentDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    await fs.utimes(filePath, recentDate, recentDate);

    await evictStaleCache(tmpDir);

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('fresh content');
  });

  it('ignores non-.md files regardless of mtime', async () => {
    const txtFile = path.join(tmpDir, 'old.txt');
    await fs.writeFile(txtFile, 'text file', 'utf-8');
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await fs.utimes(txtFile, oldDate, oldDate);

    await evictStaleCache(tmpDir);

    const content = await fs.readFile(txtFile, 'utf-8');
    expect(content).toBe('text file');
  });

  it('evicts stale files but keeps fresh ones in the same directory', async () => {
    const stale = path.join(tmpDir, 'stale.md');
    const fresh = path.join(tmpDir, 'fresh.md');
    await fs.writeFile(stale, 'old', 'utf-8');
    await fs.writeFile(fresh, 'new', 'utf-8');

    const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    await fs.utimes(stale, oldDate, oldDate);

    await evictStaleCache(tmpDir);

    await expect(fs.access(stale)).rejects.toThrow();
    expect(await fs.readFile(fresh, 'utf-8')).toBe('new');
  });
});
