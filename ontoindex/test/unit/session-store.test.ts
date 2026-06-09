import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileSessionStore } from '../../src/core/memory/session-store.js';
import fs from 'fs/promises';

vi.mock('fs/promises');

describe('SessionStore', () => {
  const repoPath = '/mock/repo';
  const sessionId = 'test-session';
  let store: FileSessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new FileSessionStore(repoPath, sessionId);
  });

  it('round-trips set/get and lists keys', async () => {
    let mockData = '{}';
    vi.mocked(fs.readFile).mockImplementation(async () => mockData);
    vi.mocked(fs.writeFile).mockImplementation(async (_path, data) => {
      mockData = data as string;
    });

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
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    vi.mocked(fs.readFile).mockRejectedValue(enoent);

    await expect(store.get('missing')).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([]);
  });

  it('preserves load error message coercion for non-Error thrown values', async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce({ message: false });
    await expect(store.get('key')).rejects.toThrow('Failed to load session store: false');

    vi.mocked(fs.readFile).mockRejectedValueOnce({ message: '' });
    await expect(store.get('key')).rejects.toThrow('Failed to load session store: ');

    vi.mocked(fs.readFile).mockRejectedValueOnce({});
    await expect(store.get('key')).rejects.toThrow('Failed to load session store: undefined');

    vi.mocked(fs.readFile).mockRejectedValueOnce(null);
    await expect(store.get('key')).rejects.toThrow(TypeError);
  });

  it('throws when exceeding 1 MB cap', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{}');

    // Generate a value just over 1MB
    const largeValue = 'a'.repeat(1024 * 1024 + 1);

    await expect(store.set('large_key', largeValue)).rejects.toThrow(/exceeds 1 MB cap/);
  });

  it('throws on invalid session ID', () => {
    expect(() => new FileSessionStore(repoPath, 'invalid/session')).toThrow(/Invalid session ID/);
  });
});
