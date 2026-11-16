import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Mock fs/promises and os before importing the module
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    appendFileSync: vi.fn(fs.appendFileSync),
    mkdirSync: vi.fn(fs.mkdirSync),
    renameSync: vi.fn(),
    statSync: vi.fn(fs.statSync),
  };
});

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: vi.fn().mockReturnValue('/fake/home'),
}));

import {
  readRecentOversizedToolCalls,
  readToolTelemetrySummary,
  recordToolCall,
  recordToolCallStart,
  withToolCallTelemetry,
  hasToolCallTelemetryScope,
  toolCallErrorFields,
} from '../../src/mcp/local/tool-telemetry.js';
import { readFile } from 'node:fs/promises';

const appendMock = appendFileSync as unknown as ReturnType<typeof vi.fn>;
const readFileMock = readFile as unknown as ReturnType<typeof vi.fn>;
const statMock = statSync as unknown as ReturnType<typeof vi.fn>;

describe('recordToolCall', () => {
  let originalTelemetryDir: string | undefined;

  beforeEach(() => {
    originalTelemetryDir = process.env.ONTOINDEX_TELEMETRY_DIR;
    delete process.env.ONTOINDEX_TELEMETRY_DIR;
    vi.clearAllMocks();
    statMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    vi.mocked(mkdirSync).mockImplementation(() => undefined);
    appendMock.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalTelemetryDir === undefined) delete process.env.ONTOINDEX_TELEMETRY_DIR;
    else process.env.ONTOINDEX_TELEMETRY_DIR = originalTelemetryDir;
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
    expect(appendMock).toHaveBeenCalledOnce();
    const [path, line] = appendMock.mock.calls[0];
    expect(path).toBe(join('/fake/home', '.ontoindex', 'telemetry.jsonl'));
    const parsed = JSON.parse(line.trim());
    expect(parsed.method).toBe('dead_code');
    expect(parsed.durationMs).toBe(123);
    expect(parsed.ok).toBe(true);
  });

  it('serializes optional diagnostic identifiers and ignores start lines in oversized reads', async () => {
    recordToolCall({
      ts: 'x',
      method: 'query',
      repo: '',
      durationMs: 1,
      responseSizeBytes: 2,
      ok: false,
      id: '1-2',
      code: 'TOOL_FAILED',
      reason: 'timeout',
    });
    expect(JSON.parse(appendMock.mock.calls[0][1])).toMatchObject({
      id: '1-2',
      code: 'TOOL_FAILED',
      reason: 'timeout',
    });
    readFileMock.mockResolvedValue(
      [
        JSON.stringify({ phase: 'start', method: 'query', responseSizeBytes: 900000 }),
        JSON.stringify({ method: 'query', responseSizeBytes: 600 * 1024 }),
      ].join('\n'),
    );
    await expect(readRecentOversizedToolCalls()).resolves.toEqual(['query']);
  });

  it('writes start records synchronously and swallows write failures', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    appendMock.mockImplementation(realFs.appendFileSync);
    vi.mocked(mkdirSync).mockImplementation(realFs.mkdirSync);
    const dir = mkdtempSync(join(tmpdir(), 'ontoindex-telemetry-'));
    vi.stubEnv('ONTOINDEX_TELEMETRY_DIR', dir);
    try {
      recordToolCallStart({
        phase: 'start',
        ts: '2026-01-01T00:00:00.000Z',
        id: '1-1',
        method: 'query',
        repo: 'r',
        readMode: 'workspace',
      });
      const lines = readFileSync(join(dir, 'telemetry.jsonl'), 'utf8').trim().split('\n');
      expect(JSON.parse(lines[0])).toEqual({
        phase: 'start',
        ts: '2026-01-01T00:00:00.000Z',
        id: '1-1',
        method: 'query',
        repo: 'r',
        readMode: 'workspace',
      });
      const regularFile = join(dir, 'not-a-directory');
      writeFileSync(regularFile, 'occupied');
      vi.stubEnv('ONTOINDEX_TELEMETRY_DIR', regularFile);
      expect(() =>
        recordToolCallStart({ phase: 'start', ts: 'x', id: 'x', method: 'query', repo: '' }),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a durable start record when the child is killed before an end record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ontoindex-telemetry-child-'));
    try {
      const telemetryModule = new URL('../../src/mcp/local/tool-telemetry.ts', import.meta.url)
        .href;
      const tsxImport = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
      const script = `import { recordToolCallStart } from ${JSON.stringify(telemetryModule)}; recordToolCallStart({phase:'start',ts:'x',id:'child-1',method:'query',repo:''}); process.kill(process.pid,'SIGKILL');`;
      const child = spawnSync(
        process.execPath,
        ['--import', tsxImport, '--input-type=module', '-e', script],
        {
          env: { ...process.env, ONTOINDEX_TELEMETRY_DIR: dir },
          timeout: 30_000,
          killSignal: 'SIGKILL',
        },
      );
      expect(child.error, child.stderr?.toString()).toBeUndefined();
      expect(child.signal).toBe('SIGKILL');
      const lines = readFileSync(join(dir, 'telemetry.jsonl'), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).phase).toBe('start');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the telemetry directory override for appends, rotation and reads', async () => {
    vi.stubEnv('ONTOINDEX_TELEMETRY_DIR', '/isolated/telemetry');
    const telemetryPath = join('/isolated/telemetry', 'telemetry.jsonl');
    statMock.mockReturnValue({ size: 11 * 1024 * 1024 });
    recordToolCall({
      ts: '2026-01-01T00:00:00.000Z',
      method: 'list_repos',
      repo: '',
      durationMs: 1,
      responseSizeBytes: 600 * 1024,
      ok: true,
    });
    expect(appendMock).toHaveBeenCalledOnce();
    expect(mkdirSync).toHaveBeenCalledWith('/isolated/telemetry', { recursive: true });
    expect(statMock).toHaveBeenCalledWith(telemetryPath);
    expect(renameSync).toHaveBeenCalledWith(telemetryPath, telemetryPath + '.1');
    expect(appendMock.mock.calls[0][0]).toBe(telemetryPath);

    readFileMock.mockResolvedValue(appendMock.mock.calls[0][1]);
    await expect(readRecentOversizedToolCalls()).resolves.toEqual(['list_repos']);
    expect(readFileMock).toHaveBeenCalledWith(telemetryPath, 'utf8');
  });

  it('does not throw when appendFileSync throws', () => {
    appendMock.mockImplementation(() => {
      throw new Error('disk full');
    });
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
  });

  it('triggers rotation when file exceeds 10 MB', async () => {
    const renameMock = vi.mocked(renameSync);
    statMock.mockReturnValue({ size: 11 * 1024 * 1024 });
    recordToolCall({
      ts: new Date().toISOString(),
      method: 'impact',
      repo: '',
      durationMs: 50,
      responseSizeBytes: 100,
      ok: true,
    });
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

  it('returns a compact summary with count and names', async () => {
    readFileMock.mockResolvedValue(
      [
        JSON.stringify({ method: 'impact', responseSizeBytes: 600 * 1024 }),
        JSON.stringify({ method: 'audit', responseSizeBytes: 700 * 1024 }),
        JSON.stringify({ method: 'impact', responseSizeBytes: 800 * 1024 }),
      ].join('\n'),
    );

    await expect(readToolTelemetrySummary({ limit: 5 })).resolves.toEqual({
      recentOversizedCount: 2,
      recentOversizedTools: ['impact', 'audit'],
    });
  });

  it('returns an empty oversized list when telemetry is corrupt', async () => {
    readFileMock.mockResolvedValue('not-json\n');

    await expect(readRecentOversizedToolCalls()).resolves.toEqual([]);
  });
});

describe('tool-call telemetry scope', () => {
  beforeEach(async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    appendMock.mockImplementation(realFs.appendFileSync);
    vi.mocked(mkdirSync).mockImplementation(realFs.mkdirSync);
    statMock.mockImplementation(realFs.statSync);
  });
  it.each(['success', 'throw', 'fail'] as const)(
    'records one matched pair for %s',
    async (mode) => {
      const dir = mkdtempSync(join(tmpdir(), 'ontoindex-scope-'));
      vi.stubEnv('ONTOINDEX_TELEMETRY_DIR', dir);
      appendMock.mockClear();
      const failure = Object.assign(new Error('failed'), {
        code: 'TOOL_FAILED',
        diagnostics: { reason: 'timeout' },
      });
      try {
        expect(hasToolCallTelemetryScope()).toBe(false);
        const result = withToolCallTelemetry(
          'inspect.context',
          { repo: 'fixture', read_mode: 'committed' },
          async (scope) => {
            expect(hasToolCallTelemetryScope()).toBe(true);
            await Promise.resolve().then(() => expect(hasToolCallTelemetryScope()).toBe(true));
            scope.setResponseSize(42);
            if (mode === 'throw') throw failure;
            if (mode === 'fail') scope.fail(failure);
            return 'result';
          },
        );
        if (mode === 'throw') await expect(result).rejects.toBe(failure);
        else await expect(result).resolves.toBe('result');
        expect(appendMock).toHaveBeenCalledTimes(2);
        const [start, completion] = readFileSync(join(dir, 'telemetry.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(start).toMatchObject({
          phase: 'start',
          method: 'inspect.context',
          repo: 'fixture',
          readMode: 'committed',
        });
        expect(completion).toMatchObject({
          id: start.id,
          ok: mode === 'success',
          responseSizeBytes: 42,
        });
        if (mode !== 'success')
          expect(completion).toMatchObject({ code: 'TOOL_FAILED', reason: 'timeout' });
      } finally {
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it('ignores late writes and closes the scope in background work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ontoindex-closed-scope-'));
    vi.stubEnv('ONTOINDEX_TELEMETRY_DIR', dir);
    appendMock.mockClear();
    let finish!: () => void;
    let background!: Promise<void>;
    try {
      await withToolCallTelemetry('query', { repo: '@group' }, async (scope) => {
        background = new Promise<void>((resolve) => {
          finish = resolve;
        }).then(() => {
          expect(hasToolCallTelemetryScope()).toBe(false);
          scope.fail({ code: 'LATE' });
          scope.setResponseSize(999);
        });
        scope.setResponseSize(7);
      });
      finish();
      await background;
      expect(appendMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(appendMock.mock.calls[1][1])).toMatchObject({
        repo: '',
        ok: true,
        responseSizeBytes: 7,
      });
      expect(JSON.parse(appendMock.mock.calls[1][1])).not.toHaveProperty('code');
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('only records bounded diagnostic identifiers', () => {
    expect(
      toolCallErrorFields({ code: 'private/path', diagnostics: { reason: 'x'.repeat(65) } }),
    ).toEqual({});
    expect(toolCallErrorFields(null)).toEqual({});
  });
});
