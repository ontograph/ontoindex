import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises and os before importing the module
vi.mock('node:fs/promises', () => ({
  appendFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  rename: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn().mockReturnValue('/fake/home'),
}));

import { readRecentOversizedToolCalls, recordToolCall } from '../../src/mcp/local/tool-telemetry.js';
import { appendFile, readFile, stat } from 'node:fs/promises';

const appendMock = appendFile as unknown as ReturnType<typeof vi.fn>;
const readFileMock = readFile as unknown as ReturnType<typeof vi.fn>;
const statMock = stat as unknown as ReturnType<typeof vi.fn>;

describe('recordToolCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    appendMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('appends a JSON line to the telemetry file', async () => {
    recordToolCall({
      ts: '2026-01-01T00:00:00.000Z',
      method: 'dead_code',
      repo: 'myrepo',
      durationMs: 123,
      responseSizeBytes: 456,
      ok: true,
    });
    // Give the fire-and-forget a tick to run
    await new Promise((r) => setTimeout(r, 10));
    expect(appendMock).toHaveBeenCalledOnce();
    const [path, line] = appendMock.mock.calls[0];
    expect(path).toContain('telemetry.jsonl');
    const parsed = JSON.parse(line.trim());
    expect(parsed.method).toBe('dead_code');
    expect(parsed.durationMs).toBe(123);
    expect(parsed.ok).toBe(true);
  });

  it('does not throw when appendFile rejects', async () => {
    appendMock.mockRejectedValue(new Error('disk full'));
    expect(() =>
      recordToolCall({
        ts: new Date().toISOString(),
        method: 'query',
        repo: '',
        durationMs: 1,
        responseSizeBytes: 0,
        ok: false,
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('triggers rotation when file exceeds 10 MB', async () => {
    const { rename } = await import('node:fs/promises');
    const renameMock = rename as unknown as ReturnType<typeof vi.fn>;
    statMock.mockResolvedValue({ size: 11 * 1024 * 1024 });
    recordToolCall({
      ts: new Date().toISOString(),
      method: 'impact',
      repo: '',
      durationMs: 50,
      responseSizeBytes: 100,
      ok: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(renameMock).toHaveBeenCalledOnce();
    expect(renameMock.mock.calls[0][1]).toContain('.1');
  });

  it('returns an empty oversized list when telemetry is missing', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(readRecentOversizedToolCalls()).resolves.toEqual([]);
  });

  it('returns recent unique oversized tool names', async () => {
    readFileMock.mockResolvedValue(
      [
        JSON.stringify({ method: 'small', responseSizeBytes: 10 }),
        JSON.stringify({ method: 'impact', responseSizeBytes: 600 * 1024 }),
        JSON.stringify({ method: 'audit', responseSizeBytes: 700 * 1024 }),
        JSON.stringify({ method: 'impact', responseSizeBytes: 800 * 1024 }),
      ].join('\n'),
    );

    await expect(readRecentOversizedToolCalls({ limit: 2 })).resolves.toEqual(['impact', 'audit']);
  });

  it('returns an empty oversized list when telemetry is corrupt', async () => {
    readFileMock.mockResolvedValue('not-json\n');

    await expect(readRecentOversizedToolCalls()).resolves.toEqual([]);
  });
});
