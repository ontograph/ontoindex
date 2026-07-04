/**
 * Unit tests for duplicate-code exact-mode pure helpers.
 * No real jscpd is spawned; only argv building, JSON parsing, and summary.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  JSCPD_VERSION,
  DEFAULT_IGNORE_GLOBS,
  buildJscpdArgs,
  normalizeJscpdJson,
  formatSummary,
} from '../../src/cli/duplicate-code.js';

describe('buildJscpdArgs', () => {
  it('includes pinned version, json reporter to output dir, and default ignores', () => {
    const args = buildJscpdArgs({}, '/tmp/out');
    expect(args.slice(0, 2)).toEqual(['--yes', `jscpd@${JSCPD_VERSION}`]);
    expect(args).toContain('--reporters');
    expect(args).toContain('json');
    expect(args[args.indexOf('--output') + 1]).toBe('/tmp/out');
    const ignoreIdx = args.indexOf('--ignore');
    expect(ignoreIdx).toBeGreaterThan(-1);
    expect(args[ignoreIdx + 1]).toBe(DEFAULT_IGNORE_GLOBS.join(','));
    expect(args[args.length - 1]).toBe('.');
  });

  it('applies min-lines/min-tokens and merges user excludes and includes', () => {
    const args = buildJscpdArgs({
      minLines: '30',
      minTokens: '70',
      exclude: ['**/legacy/**'],
      include: ['src/**'],
      path: 'packages/app',
    }, '/tmp/out');
    expect(args).toContain('--min-lines');
    expect(args[args.indexOf('--min-lines') + 1]).toBe('30');
    expect(args[args.indexOf('--min-tokens') + 1]).toBe('70');
    expect(args[args.indexOf('--ignore') + 1]).toContain('**/legacy/**');
    expect(args[args.indexOf('--pattern') + 1]).toBe('src/**');
    expect(args[args.length - 1]).toBe('packages/app');
  });

  it('omits threshold flags for non-positive values', () => {
    const args = buildJscpdArgs({ minLines: '0', minTokens: 'abc' }, '/tmp/out');
    expect(args).not.toContain('--min-lines');
    expect(args).not.toContain('--min-tokens');
  });
});

describe('normalizeJscpdJson', () => {
  const raw = {
    duplicates: [
      {
        format: 'typescript',
        lines: 42,
        tokens: 210,
        firstFile: { name: 'a.ts', start: 10, end: 51 },
        secondFile: { name: 'b.ts', start: 100, end: 141 },
      },
    ],
    statistics: { total: { percentage: 3.5 } },
  };

  it('maps jscpd JSON into the ADR report shape with line ranges', () => {
    const report = normalizeJscpdJson(raw, { minLines: '30' });
    expect(report.detector).toBe('jscpd');
    expect(report.detectorVersion).toBe(JSCPD_VERSION);
    expect(report.duplicationPercent).toBe(3.5);
    expect(report.thresholds.minLines).toBe(30);
    expect(report.groups).toHaveLength(1);
    const g = report.groups[0];
    expect(g.id).toBe(1);
    expect(g.lines).toBe(42);
    expect(g.tokens).toBe(210);
    expect(g.files[0]).toEqual({ path: 'a.ts', startLine: 10, endLine: 51 });
    expect(g.files[1]).toEqual({ path: 'b.ts', startLine: 100, endLine: 141 });
  });

  it('tolerates missing/empty input without throwing', () => {
    expect(() => normalizeJscpdJson(undefined, {})).not.toThrow();
    const report = normalizeJscpdJson({}, {});
    expect(report.groups).toEqual([]);
    expect(report.duplicationPercent).toBeUndefined();
  });
});

describe('formatSummary', () => {
  const makeGroups = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      format: 'ts',
      files: [
        { path: `f${i}.ts`, startLine: 1, endLine: 5 },
        { path: `g${i}.ts`, startLine: 1, endLine: 5 },
      ],
      lines: 5,
      tokens: 20,
    }));

  it('caps output and reports remaining count', () => {
    const report = {
      detector: 'jscpd',
      detectorVersion: JSCPD_VERSION,
      thresholds: {},
      ignoredPathsSummary: [],
      groups: makeGroups(25),
    };
    const out = formatSummary(report);
    expect(out).toContain('25 group(s)');
    expect(out).toContain('... 5 more group(s)');
    expect(out.split('\n').filter((l) => l.trim().startsWith('#')).length).toBe(20);
  });

  it('shows no tail when under the cap', () => {
    const report = {
      detector: 'jscpd',
      detectorVersion: JSCPD_VERSION,
      thresholds: {},
      ignoredPathsSummary: [],
      groups: makeGroups(3),
    };
    const out = formatSummary(report);
    expect(out).not.toContain('more group(s)');
  });
});

// ---------------------------------------------------------------------------
// duplicateCodeCommand guards (no real jscpd spawn)
// ---------------------------------------------------------------------------


describe('duplicateCodeCommand mode guards', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    errSpy.mockRestore();
    process.exitCode = undefined;
  });

  it("rejects --mode both with a non-zero exit and no spawn", async () => {
    const { duplicateCodeCommand } = await import('../../src/cli/duplicate-code.js');
    await duplicateCodeCommand({ mode: 'both' });
    expect(process.exitCode).toBe(2);
    expect(errSpy.mock.calls[0]?.[0]).toContain("Mode 'both' was removed");
  });

  it('rejects --mode semantic as proof-gated / not implemented', async () => {
    const { duplicateCodeCommand } = await import('../../src/cli/duplicate-code.js');
    await duplicateCodeCommand({ mode: 'semantic' });
    expect(process.exitCode).toBe(2);
    expect(errSpy.mock.calls[0]?.[0]).toContain('Semantic mode is not implemented');
  });

  it('rejects an unknown mode', async () => {
    const { duplicateCodeCommand } = await import('../../src/cli/duplicate-code.js');
    await duplicateCodeCommand({ mode: 'fuzzy' });
    expect(process.exitCode).toBe(2);
    expect(errSpy.mock.calls[0]?.[0]).toContain("Unknown mode 'fuzzy'");
  });
});

describe('duplicateCodeCommand missing-binary path', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    errSpy.mockRestore();
    process.exitCode = undefined;
    vi.resetModules();
    vi.doUnmock('node:child_process');
  });

  it('emits one clear message and exits non-zero when npx is missing (ENOENT)', async () => {
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const listeners: Record<string, (arg: unknown) => void> = {};
        const child = {
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: (event: string, cb: (arg: unknown) => void) => {
            listeners[event] = cb;
            return child;
          },
        };
        // Fire ENOENT asynchronously, like a real failed spawn.
        setImmediate(() => {
          const err = Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' });
          listeners.error?.(err);
        });
        return child;
      },
    }));
    vi.resetModules();
    const { duplicateCodeCommand } = await import('../../src/cli/duplicate-code.js');
    await duplicateCodeCommand({ mode: 'exact', path: 'src/cli' });
    expect(process.exitCode).toBe(1);
    const combined = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(combined).toContain("Could not run 'npx'");
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it('emits one clear message when jscpd exits without writing a report', async () => {
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const listeners: Record<string, (arg: unknown) => void> = {};
        const child = {
          stdout: { on: () => {} },
          stderr: {
            on: (event: string, cb: (chunk: Buffer) => void) => {
              if (event === 'data') {
                cb(Buffer.from('network unavailable'));
              }
            },
          },
          on: (event: string, cb: (arg: unknown) => void) => {
            listeners[event] = cb;
            return child;
          },
        };
        setImmediate(() => listeners.close?.(1));
        return child;
      },
    }));
    vi.resetModules();
    const { duplicateCodeCommand } = await import('../../src/cli/duplicate-code.js');
    await duplicateCodeCommand({ mode: 'exact', path: 'src/cli' });
    expect(process.exitCode).toBe(1);
    const combined = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(combined).toContain('jscpd did not produce a report');
    expect(combined).toContain('network unavailable');
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
