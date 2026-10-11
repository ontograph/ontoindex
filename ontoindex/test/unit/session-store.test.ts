import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileSessionStore } from '../../src/core/memory/session-store.js';
import fs from 'fs/promises';
import path from 'node:path';

describe('SessionStore', () => {
  let repoPath: string;
  const sessionId = 'test-session';
  let store: FileSessionStore;

  beforeEach(async () => {
    repoPath = await fs.realpath(
      await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'session-store-')),
    );
    store = new FileSessionStore(repoPath, sessionId);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it('round-trips set/get and lists keys', async () => {
    await store.set('key1', 'value1');
    await store.set('key2', 'value2');

    const val1 = await store.get('key1');
    expect(val1).toBe('value1');

    const val2 = await store.get('key2');
    expect(val2).toBe('value2');

    const keys = await store.list();
    expect(keys).toEqual(['key1', 'key2']);
  });

  it('returns empty values when the session file is missing', async () => {
    await expect(store.get('missing')).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([]);
  });

  it('throws when exceeding 1 MB cap', async () => {
    // Generate a value just over 1MB
    const largeValue = 'a'.repeat(1024 * 1024 + 1);

    await expect(store.set('large_key', largeValue)).rejects.toThrow(/exceeds 1 MB cap/);
  });

  it('preserves error coercion for non-Error thrown values', async () => {
    const read = vi.spyOn(fs, 'readFile');
    for (const [value, message] of [
      [{ message: false }, 'false'],
      [{ message: '' }, ''],
      [{}, 'undefined'],
    ] as const) {
      read.mockRejectedValueOnce(value);
      await expect(store.get('key')).rejects.toThrow(`Failed to load session store: ${message}`);
    }
    read.mockRejectedValueOnce(null);
    await expect(store.get('key')).rejects.toThrow(TypeError);
  });

  it('throws on invalid session ID', () => {
    expect(() => new FileSessionStore(repoPath, 'invalid/session')).toThrow(/Invalid session ID/);
    expect(() => new FileSessionStore(repoPath, 'invalid\0session')).toThrow(/Invalid session ID/);
  });

  it('reads only persisted own keys, including prototype-named keys', async () => {
    await expect(store.get('toString')).resolves.toBeNull();
    await expect(store.get('__proto__')).resolves.toBeNull();
    await store.set('__proto__', 'saved');
    await expect(store.get('__proto__')).resolves.toBe('saved');
  });

  it('reports malformed JSON without overwriting it', async () => {
    const directory = path.join(repoPath, '.ontoindex', 'sessions');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${sessionId}.json`);
    await fs.writeFile(file, '{broken');
    await expect(store.set('key', 'value')).rejects.toThrow('Failed to load session store');
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  });

  it('resolves the repo-contained session path before creating or writing', async () => {
    await store.set('key', 'value');

    const sessionsPath = path.resolve(repoPath, '.ontoindex', 'sessions');
    expect(await fs.readFile(path.join(sessionsPath, 'test-session.json'), 'utf-8')).toContain(
      '"key"',
    );
  });
});
