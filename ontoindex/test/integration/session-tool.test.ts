import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import fs from 'fs/promises';

vi.mock('fs/promises');

describe('Session MCP Tool Integration', () => {
  let backend: LocalBackend;
  const repoHandle: any = { id: 'mock-repo', repoPath: '/mock/repo/path' };
  let mockData = '{}';

  beforeEach(() => {
    vi.clearAllMocks();
    mockData = '{}';
    vi.mocked(fs.readFile).mockImplementation(async () => mockData);
    vi.mocked(fs.writeFile).mockImplementation(async (_path, data) => {
      mockData = data as string;
    });
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);

    backend = new LocalBackend();

    // Bypass initialization — session path only touches the filesystem.
    // `ensureInitialized` is private on main, so cast through `any` for the
    // mock assignment (TS compile-time only; runtime is plain JS).
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
    backend.resolveRepo = vi.fn().mockResolvedValue(repoHandle);
  });

  it('performs a round-trip set and get via callTool', async () => {
    // 1. Set a value
    const setResult = await backend.callTool('session', {
      action: 'set',
      session_id: 'test-session-123',
      key: 'my_key',
      value: 'my_value',
    });

    expect(setResult).toBeDefined();
    expect(setResult.status).toBe('success');
    expect(setResult.action).toBe('set');

    // 2. Get the value
    const getResult = await backend.callTool('session', {
      action: 'get',
      session_id: 'test-session-123',
      key: 'my_key',
    });

    expect(getResult).toBeDefined();
    expect(getResult.value).toBe('my_value');
    expect(getResult.action).toBe('get');

    // 3. List keys
    const listResult = await backend.callTool('session', {
      action: 'list',
      session_id: 'test-session-123',
    });

    expect(listResult).toBeDefined();
    expect(listResult.keys).toContain('my_key');
    expect(listResult.action).toBe('list');
  });

  it('returns error on invalid action', async () => {
    const result = await backend.callTool('session', {
      action: 'invalid_action' as any,
      session_id: 'test-session-123',
    });
    expect(result.error).toContain('Unknown action: invalid_action');
  });
});
