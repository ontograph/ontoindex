import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runPatternAudit } from '../../src/mcp/local/backend-pattern-audit.js';

// Construct trigger strings from parts so this test file doesn't itself
// hit project-wide security lints that forbid the literal tokens.
const EV = 'ev' + 'al';
const INNER_HTML = '.inner' + 'HTML';

describe('pattern_audit', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-pattern-audit-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'bad'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'dist'), { recursive: true });

    // Flag each default rule at least once.
    await fs.writeFile(
      path.join(tmpDir, 'src', 'hit.ts'),
      [
        "const node = document.getElementById('x');",
        "node.addEventListener('click', handler);",
        'setInterval(async () => { await work(); }, 100);',
        `node${INNER_HTML} = '<b>' + userInput + '</b>';`,
        `${EV}(somePayload);`,
      ].join('\n'),
      'utf8',
    );

    // Clean file — should contribute zero findings.
    await fs.writeFile(
      path.join(tmpDir, 'src', 'clean.ts'),
      'export function add(a: number, b: number): number { return a + b; }\n',
      'utf8',
    );

    // Files under node_modules / dist should be excluded.
    await fs.writeFile(
      path.join(tmpDir, 'node_modules', 'bad', 'vendor.js'),
      `node${INNER_HTML} = payload;\n`,
      'utf8',
    );
    await fs.writeFile(path.join(tmpDir, 'dist', 'build.js'), `globalThis.${EV}("x");\n`, 'utf8');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('flags default risky patterns and skips excluded dirs', async () => {
    const repo: any = { id: 'tmp', name: 'tmp', repoPath: tmpDir };
    const result = await runPatternAudit(repo, {});
    expect(result.status).toBe('success');
    expect(result.tool).toBe('pattern_audit');
    expect(result.file_count).toBe(2); // hit.ts + clean.ts
    const patterns = new Set(result.findings.map((f) => f.pattern));
    expect(patterns.has('addEventListener')).toBe(true);
    expect(patterns.has('setInterval-async')).toBe(true);
    expect(patterns.has('innerHTML-assign')).toBe(true);
    expect(patterns.has('eval-call')).toBe(true);
    // Every finding must belong to hit.ts — excluded dirs must not leak.
    for (const f of result.findings) {
      expect(f.file).toBe(path.join('src', 'hit.ts'));
      expect(f.line).toBeGreaterThan(0);
      expect(f.snippet.length).toBeGreaterThan(0);
    }
  });

  it('accepts caller-supplied literal patterns and reports them', async () => {
    const repo: any = { id: 'tmp', name: 'tmp', repoPath: tmpDir };
    const result = await runPatternAudit(repo, { patterns: ['userInput'] });
    expect(result.status).toBe('success');
    // Only the custom rule should run.
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].id).toBe('userInput');
    expect(result.finding_count).toBeGreaterThanOrEqual(1);
    expect(result.findings.every((f) => f.pattern === 'userInput')).toBe(true);
  });

  it('returns zero findings for a repo with no matching code', async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-pa-empty-'));
    try {
      await fs.mkdir(path.join(emptyDir, 'src'));
      await fs.writeFile(path.join(emptyDir, 'src', 'clean.ts'), 'export const x = 1;\n', 'utf8');
      const repo: any = { id: 'e', name: 'e', repoPath: emptyDir };
      const result = await runPatternAudit(repo, {});
      expect(result.status).toBe('success');
      expect(result.finding_count).toBe(0);
      expect(result.findings).toHaveLength(0);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('skips oversized source files', async () => {
    const largeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-pa-large-'));
    try {
      await fs.mkdir(path.join(largeDir, 'src'));
      await fs.writeFile(path.join(largeDir, 'src', 'small.ts'), 'export const x = 1;\n', 'utf8');
      await fs.writeFile(
        path.join(largeDir, 'src', 'large.ts'),
        `${'a'.repeat(1024 * 1024 + 1)}\nnode${INNER_HTML} = payload;\n`,
        'utf8',
      );
      const repo: any = { id: 'large', name: 'large', repoPath: largeDir };
      const result = await runPatternAudit(repo, {});
      expect(result.status).toBe('success');
      expect(result.file_count).toBe(2);
      expect(result.finding_count).toBe(0);
      expect(result.findings).toHaveLength(0);
    } finally {
      await fs.rm(largeDir, { recursive: true, force: true });
    }
  });

  it('stops directory traversal at the traversal cap when no source files match', async () => {
    const broadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-pa-broad-'));
    const traversalCap = 10_000;
    try {
      await Promise.all(
        Array.from({ length: traversalCap + 25 }, (_, i) =>
          fs.mkdir(path.join(broadDir, `dir-${String(i).padStart(5, '0')}`)),
        ),
      );
      const readdirSpy = vi.spyOn(fs, 'readdir');
      const repo: any = { id: 'broad', name: 'broad', repoPath: broadDir };

      const result = await runPatternAudit(repo, {});

      expect(result.status).toBe('success');
      expect(result.file_count).toBe(0);
      expect(result.finding_count).toBe(0);
      expect(result.findings).toHaveLength(0);
      expect(readdirSpy).toHaveBeenCalledTimes(1);
      readdirSpy.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await fs.rm(broadDir, { recursive: true, force: true });
    }
  });
});
