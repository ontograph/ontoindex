import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { runDeadCode } from '../../src/mcp/local/backend-dead-code.js';

const dbMock = executeParameterized as unknown as ReturnType<typeof vi.fn>;

function repo() {
  return { id: 'dc-test', name: 'dc-test' };
}

function initGitRepo(repoPath: string) {
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'OntoIndex Test'], {
    cwd: repoPath,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.email', 'ontoindex-test@example.com'], {
    cwd: repoPath,
    stdio: 'ignore',
  });
}

function commitFile(repoPath: string, relPath: string, content: string, commitDate: string) {
  const absPath = path.join(repoPath, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
  execFileSync('git', ['add', relPath], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', `update ${relPath}`], {
    cwd: repoPath,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: commitDate,
      GIT_COMMITTER_DATE: commitDate,
    },
  });
}

/**
 * The backend issues two kinds of queries:
 *   - symbol-load: `MATCH (n) WHERE (labels(n)[0] = 'Function' ...`
 *   - file-load:   `MATCH (f:File) WHERE f.id IS NOT NULL ...`
 *   - BFS frontier: `MATCH (src)-[r:CodeRelation]->(tgt)`
 *
 * This helper dispatches mock data based on a query-shape match so tests
 * stay readable even though multiple calls flow through one mock.
 */
function wireDb(opts: {
  symbols: any[];
  files?: any[];
  edgesBySource?: Map<string, string[]>;
  incomingCallersByTarget?: Map<string, string[]>;
  jsxUsageByName?: Map<string, string[]>; // name -> list of live file ids that contain <Name usage
  routeHandlerSeeds?: string[];
}) {
  const files = opts.files ?? [];
  const edges = opts.edgesBySource ?? new Map();
  const incoming = opts.incomingCallersByTarget ?? new Map();
  const jsxUsage = opts.jsxUsageByName ?? new Map();
  const routeHandlerSeeds = opts.routeHandlerSeeds ?? [];
  dbMock.mockImplementation(async (_repoId: string, query: string, params?: any) => {
    if (/MATCH \(n:(Function|Method)\)[\s\S]*WHERE n\.content CONTAINS/.test(query)) {
      const openGt = params?.openGt ?? '';
      const name = openGt.slice(1, -1);
      const hitIds = jsxUsage.get(name) ?? [];
      return hitIds.map((id) => ({ id }));
    }
    const labelMatch = query.match(/MATCH \(n:(Function|Method|Class|Constructor)\)/);
    if (labelMatch) {
      const label = labelMatch[1];
      return opts.symbols.filter((s) => (s.type ?? 'Function') === label);
    }
    if (/MATCH \(f:File\)/.test(query)) {
      return files;
    }
    if (/MATCH \(src\)-\[r:CodeRelation\]->\(tgt\)/.test(query)) {
      const match = query.match(/src\.id IN \[([^\]]+)\]/);
      if (!match) return [];
      const ids = match[1].split(',').map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''));
      const targets = new Set<string>();
      for (const id of ids) {
        for (const t of edges.get(id) ?? []) targets.add(t);
      }
      return [...targets].map((id) => ({ id }));
    }
    if (/MATCH \(caller\)-\[r:CodeRelation\]->\(n\)/.test(query)) {
      const id = params?.symId;
      const callers = incoming.get(id) ?? [];
      return callers.map((callerId) => ({ callerId }));
    }
    if (/MATCH \(handler\)-\[r:CodeRelation\]->\(route:Route\)/.test(query)) {
      return routeHandlerSeeds.map((id) => ({ id }));
    }
    return [];
  });
}

describe('dead_code', () => {
  beforeEach(() => {
    dbMock.mockReset();
  });

  it('flags a symbol nobody references as unreached', async () => {
    wireDb({
      symbols: [
        {
          id: 'sA',
          name: 'exportedRoot',
          type: 'Function',
          filePath: 'src/root.ts',
          startLine: 1,
          endLine: 10,
          isExported: true,
        },
        {
          id: 'sB',
          name: 'orphan',
          type: 'Function',
          filePath: 'src/orphan.ts',
          startLine: 5,
          endLine: 20,
          isExported: false,
        },
      ],
    });
    const r = await runDeadCode(repo(), {});
    expect(r.status).toBe('success');
    expect(r.byBucket.unreached).toBe(1);
    expect(r.entries[0]).toMatchObject({ name: 'orphan', bucket: 'unreached' });
  });

  it('returns stable golden reachability buckets for exported and unreached symbols', async () => {
    wireDb({
      symbols: [
        {
          id: 'sA',
          name: 'exportedRoot',
          type: 'Function',
          filePath: 'src/root.ts',
          startLine: 1,
          endLine: 10,
          isExported: true,
        },
        {
          id: 'sB',
          name: 'orphan',
          type: 'Function',
          filePath: 'src/orphan.ts',
          startLine: 5,
          endLine: 20,
          isExported: false,
        },
      ],
    });

    await expect(runDeadCode(repo(), {})).resolves.toEqual({
      status: 'success',
      tool: 'dead_code',
      repo: 'dc-test',
      totalSymbols: 2,
      reachableCount: 1,
      deadCount: 2,
      verifiedReachableCount: 0,
      suppressed_count: 0,
      excluded_path_count: 0,
      representative_excluded_paths: [],
      policyFilter: {
        applied: true,
        includeIgnored: false,
        excludedPathCount: 0,
        representativeExcludedPaths: [],
        globs: [
          'node_modules/**',
          '**/node_modules/**',
          'vendor/**',
          '**/vendor/**',
          'third_party/**',
          '**/third_party/**',
          'generated/**',
          '**/generated/**',
          'dist/**',
          '**/dist/**',
          'build/**',
          '**/build/**',
          '**/*.generated.*',
          '**/*.gen.*',
        ],
        sources: ['built-in defaults', 'tool args'],
      },
      byBucket: {
        unreached: 1,
        unused: 1,
        weakly_referenced: 0,
        entrypoint_unknown: 0,
        test_only: 0,
        exported_uncalled: 1,
      },
      entries: [
        {
          id: 'sB',
          name: 'orphan',
          type: 'Function',
          filePath: 'src/orphan.ts',
          startLine: 5,
          endLine: 20,
          bucket: 'unreached',
          confidence: 'medium',
          reasonCodes: ['not-reachable-from-known-roots', 'no-verified-incoming-refs'],
          includes_deprecated_tag: false,
          verifiedIncomingRefs: 0,
        },
        {
          id: 'sA',
          name: 'exportedRoot',
          type: 'Function',
          filePath: 'src/root.ts',
          startLine: 1,
          endLine: 10,
          bucket: 'unused',
          confidence: 'medium',
          reasonCodes: [
            'exported-symbol-no-internal-reachable-caller',
            'no-verified-incoming-refs',
          ],
          includes_deprecated_tag: false,
          verifiedIncomingRefs: 0,
        },
      ],
      summary:
        '2 dead-code candidates in 2 symbols (1 unreached, 1 unused, 0 weakly-referenced, 0 entrypoint-unknown, 0 test-only) — 0 false positives filtered via context verification; confidence: H=0 M=2 L=0.',
    });
  });

  it('classifies a symbol reachable only via a test file as test_only', async () => {
    wireDb({
      symbols: [
        {
          id: 'prod',
          name: 'prodHelper',
          type: 'Function',
          filePath: 'src/helper.ts',
          isExported: false,
        },
        {
          id: 'testSym',
          name: 'describeBlock',
          type: 'Function',
          filePath: 'test/helper.test.ts',
          isExported: false,
        },
      ],
      edgesBySource: new Map([['testSym', ['prod']]]),
    });
    const r = await runDeadCode(repo(), {});
    expect(r.status).toBe('success');
    expect(r.byBucket.test_only).toBe(1);
    const entry = r.entries.find((e) => e.name === 'prodHelper');
    expect(entry?.bucket).toBe('test_only');
  });

  it('classifies an exported symbol with no internal caller as exported_uncalled', async () => {
    wireDb({
      symbols: [
        {
          id: 'pub',
          name: 'publicApi',
          type: 'Function',
          filePath: 'src/api.ts',
          isExported: true,
        },
        {
          id: 'entry',
          name: 'main',
          type: 'Function',
          filePath: 'src/index.ts',
          isExported: false,
        },
      ],
    });
    const r = await runDeadCode(repo(), {});
    expect(r.status).toBe('success');
    const entry = r.entries.find((e) => e.name === 'publicApi');
    expect(entry?.bucket).toBe('unused');
    expect(r.byBucket.exported_uncalled).toBeGreaterThanOrEqual(1);
  });

  it('include_tests=false keeps no-entrypoint symbols out of test_only', async () => {
    wireDb({
      symbols: [
        {
          id: 'prod',
          name: 'prodHelper',
          type: 'Function',
          filePath: 'src/helper.ts',
          isExported: false,
        },
        {
          id: 'testSym',
          name: 'describeBlock',
          type: 'Function',
          filePath: 'test/helper.test.ts',
          isExported: false,
        },
      ],
      edgesBySource: new Map([['testSym', ['prod']]]),
    });
    const r = await runDeadCode(repo(), { include_tests: false });
    expect(r.status).toBe('success');
    expect(r.byBucket.test_only).toBe(0);
    const prod = r.entries.find((e) => e.name === 'prodHelper');
    expect(prod?.bucket).toBe('entrypoint_unknown');
  });

  it('include_exported=false drops the exported_uncalled bucket', async () => {
    wireDb({
      symbols: [
        {
          id: 'pub',
          name: 'publicApi',
          type: 'Function',
          filePath: 'src/api.ts',
          isExported: true,
        },
      ],
    });
    const r = await runDeadCode(repo(), { include_exported: false });
    expect(r.byBucket.exported_uncalled).toBe(0);
    expect(r.entries.find((e) => e.name === 'publicApi')).toBeUndefined();
  });

  it('respects the limit parameter', async () => {
    const symbols = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      name: `orphan${i}`,
      type: 'Function',
      filePath: `src/o${i}.ts`,
      isExported: false,
    }));
    wireDb({ symbols });
    const r = await runDeadCode(repo(), { limit: 3 });
    expect(r.entries).toHaveLength(3);
    expect(r.byBucket.entrypoint_unknown).toBe(10);
  });

  it('verify pass drops candidates with incoming refs from live nodes', async () => {
    wireDb({
      symbols: [
        {
          id: 'liveExport',
          name: 'exportedRoot',
          type: 'Function',
          filePath: 'src/root.ts',
          isExported: true,
        },
        {
          id: 'falsePos',
          name: 'lookupHelper',
          type: 'Function',
          filePath: 'src/helper.ts',
          isExported: false,
        },
        {
          id: 'trueDead',
          name: 'trulyOrphan',
          type: 'Function',
          filePath: 'src/orphan.ts',
          isExported: false,
        },
      ],
      // live export calls falsePos (BFS missed it); nothing calls trueDead
      incomingCallersByTarget: new Map([['falsePos', ['liveExport']]]),
    });
    const r = await runDeadCode(repo(), {});
    expect(r.status).toBe('success');
    expect(r.verifiedReachableCount).toBe(1);
    expect(r.byBucket.unreached).toBe(1);
    const names = r.entries.map((e) => e.name);
    expect(names).toContain('trulyOrphan');
    expect(names).not.toContain('lookupHelper');
    expect(r.entries.find((e) => e.name === 'trulyOrphan')?.verifiedIncomingRefs).toBe(0);
  });

  it('keeps a candidate whose only incoming ref is another dead candidate (dead island)', async () => {
    wireDb({
      symbols: [
        {
          id: 'deadA',
          name: 'islandA',
          type: 'Function',
          filePath: 'src/island.ts',
          isExported: false,
        },
        {
          id: 'deadB',
          name: 'islandB',
          type: 'Function',
          filePath: 'src/island.ts',
          isExported: false,
        },
      ],
      // A calls B, but neither is reachable from roots — both stay dead
      incomingCallersByTarget: new Map([['deadB', ['deadA']]]),
    });
    const r = await runDeadCode(repo(), {});
    expect(r.verifiedReachableCount).toBe(0);
    expect(r.byBucket.entrypoint_unknown).toBe(1);
    expect(r.byBucket.weakly_referenced).toBe(1);
    expect(r.entries.find((e) => e.name === 'islandB')?.verifiedIncomingRefs).toBe(1);
    expect(r.entries.find((e) => e.name === 'islandB')?.bucket).toBe('weakly_referenced');
    expect(r.entries.find((e) => e.name === 'islandB')?.confidence).not.toBe('high');
    expect(r.entries.find((e) => e.name === 'islandB')?.reasonCodes).toEqual(
      expect.arrayContaining(['verified-incoming-refs-from-unreachable-symbols']),
    );
    expect(r.entries.find((e) => e.name === 'islandA')?.verifiedIncomingRefs).toBe(0);
  });

  it('verify=false keeps the raw BFS output', async () => {
    wireDb({
      symbols: [
        {
          id: 'falsePos',
          name: 'lookupHelper',
          type: 'Function',
          filePath: 'src/helper.ts',
          isExported: false,
        },
      ],
      incomingCallersByTarget: new Map([['falsePos', ['someLive']]]),
    });
    const r = await runDeadCode(repo(), { verify: false });
    expect(r.verifiedReachableCount).toBe(0);
    expect(r.byBucket.entrypoint_unknown).toBe(1);
    expect(r.entries[0].name).toBe('lookupHelper');
    expect(r.entries[0].verifiedIncomingRefs).toBeUndefined();
  });

  it('treats hook directory files as entry-point roots', async () => {
    wireDb({
      symbols: [
        {
          id: 'hookMain',
          name: 'main',
          type: 'Function',
          filePath: 'hooks/claude/my-hook.cjs',
          isExported: false,
        },
        {
          id: 'hookHelper',
          name: 'readInput',
          type: 'Function',
          filePath: 'hooks/claude/my-hook.cjs',
          isExported: false,
        },
      ],
      edgesBySource: new Map([['hookMain', ['hookHelper']]]),
    });
    const r = await runDeadCode(repo(), {});
    expect(r.status).toBe('success');
    expect(r.byBucket.unreached).toBe(0);
  });

  it('treats top-level .mjs scripts as entry-point roots', async () => {
    wireDb({
      symbols: [
        {
          id: 'serverEntry',
          name: 'bootstrap',
          type: 'Function',
          filePath: 'docker-server.mjs',
          isExported: false,
        },
      ],
    });
    const r = await runDeadCode(repo(), {});
    expect(r.byBucket.unreached).toBe(0);
  });

  it('clears a React-component candidate when JSX tag usage exists anywhere', async () => {
    wireDb({
      symbols: [
        {
          id: 'jsxChild',
          name: 'TabContent',
          type: 'Function',
          filePath: 'src/components/HelpPanel.tsx',
          isExported: false,
        },
      ],
      // A `<TabContent>` tag exists in some file (does not need to be reachable).
      jsxUsageByName: new Map([['TabContent', ['anyFile']]]),
    });
    const r = await runDeadCode(repo(), {});
    expect(r.verifiedReachableCount).toBe(1);
    expect(r.byBucket.unreached).toBe(0);
    expect(r.entries.find((e) => e.name === 'TabContent')).toBeUndefined();
  });

  it('keeps a React-component candidate when no JSX usage exists at all', async () => {
    wireDb({
      symbols: [
        {
          id: 'deadComponent',
          name: 'UnrenderedPanel',
          type: 'Function',
          filePath: 'src/components/Orphan.tsx',
          isExported: false,
        },
      ],
      // No JSX usage anywhere.
      jsxUsageByName: new Map(),
    });
    const r = await runDeadCode(repo(), {});
    expect(r.verifiedReachableCount).toBe(0);
    expect(r.entries.map((e) => e.name)).toEqual(['UnrenderedPanel']);
  });

  it('only runs JSX usage check for PascalCase functions in .jsx/.tsx files', async () => {
    wireDb({
      symbols: [
        {
          id: 'lowercaseHelper',
          name: 'formatString',
          type: 'Function',
          filePath: 'src/utils/helpers.tsx',
          isExported: false,
        },
      ],
      // Even if JSX-looking content exists, lowercase name should not trigger the check
      jsxUsageByName: new Map([['formatString', ['someLive']]]),
    });
    const r = await runDeadCode(repo(), {});
    expect(r.byBucket.entrypoint_unknown).toBe(1);
    expect(r.entries[0].name).toBe('formatString');
  });

  it('returns an error response when the graph query throws', async () => {
    dbMock.mockRejectedValue(new Error('db offline'));
    const r = await runDeadCode(repo(), {});
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/db offline/);
    expect(r.entries).toEqual([]);
  });

  it('exclude_patterns suppresses matched symbols', async () => {
    wireDb({
      symbols: [
        {
          id: 'sLegacy',
          name: 'oldHelper',
          type: 'Function',
          filePath: 'src/legacy/old.ts',
          isExported: false,
        },
        {
          id: 'sLive',
          name: 'keepHelper',
          type: 'Function',
          filePath: 'src/live/keep.ts',
          isExported: false,
        },
      ],
    });
    const r = await runDeadCode(repo(), { exclude_patterns: ['legacy/old.ts'] });
    expect(r.status).toBe('success');
    expect(r.suppressed_count).toBe(1);
    const names = r.entries.map((e) => e.name);
    expect(names).not.toContain('oldHelper');
    expect(names).toContain('keepHelper');
  });

  it('discloses repository policy filtering and includeIgnored override', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-dead-code-policy-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.ontoindex'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.ontoindex', 'policy.json'),
        JSON.stringify({
          schemaVersion: 1,
          ignoreGlobs: ['src/vendor/**'],
          generatedGlobs: [],
          riskThresholds: {},
          owners: {},
          audit: {},
        }),
      );
      wireDb({
        symbols: [
          {
            id: 'sVendor',
            name: 'vendorHelper',
            type: 'Function',
            filePath: 'src/vendor/helper.ts',
            isExported: false,
          },
          {
            id: 'sLocal',
            name: 'localHelper',
            type: 'Function',
            filePath: 'src/local/helper.ts',
            isExported: false,
          },
        ],
      });

      const filtered = await runDeadCode({ ...repo(), repoPath: tmpDir }, {});
      expect(filtered.entries.map((entry) => entry.name)).toEqual(['localHelper']);
      expect(filtered.excluded_path_count).toBe(1);
      expect(filtered.representative_excluded_paths).toEqual(['src/vendor/helper.ts']);
      expect(filtered.summary).toContain('Use includeIgnored:true to include them');

      const included = await runDeadCode({ ...repo(), repoPath: tmpDir }, { includeIgnored: true });
      expect(included.entries.map((entry) => entry.name)).toEqual(['localHelper', 'vendorHelper']);
      expect(included.policyFilter.includeIgnored).toBe(true);
      expect(included.excluded_path_count).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('confidence defaults to medium when repoPath is undefined', async () => {
    wireDb({
      symbols: [
        {
          id: 'sOrphan',
          name: 'orphan',
          type: 'Function',
          filePath: 'src/orphan.ts',
          isExported: false,
        },
      ],
    });
    // repo() returns { id, name } with no repoPath — commitsByFile is skipped
    const r = await runDeadCode(repo(), {});
    expect(r.status).toBe('success');
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].confidence).toBe('medium');
  });

  it('min_stale_days is a noop when repoPath is undefined', async () => {
    wireDb({
      symbols: [
        {
          id: 'sOrphan2',
          name: 'orphan2',
          type: 'Function',
          filePath: 'src/orphan2.ts',
          isExported: false,
        },
      ],
    });
    // Without repoPath the min_stale_days filter is silently skipped
    const r = await runDeadCode(repo(), { min_stale_days: 30 });
    expect(r.status).toBe('success');
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].name).toBe('orphan2');
  });

  describe('repoPath-backed churn lookup', () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('derives mixed confidence buckets from absolute file paths in a real git repo', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-dead-code-git-'));
      initGitRepo(tmpDir);

      commitFile(
        tmpDir,
        'src/high.ts',
        'export function highConfidence() {}\n',
        '2025-01-01T00:00:00Z',
      );
      commitFile(
        tmpDir,
        'src/medium.ts',
        'export function mediumConfidence() { return 1; }\n',
        '2026-04-20T00:00:00Z',
      );
      commitFile(
        tmpDir,
        'src/low.ts',
        'export function lowConfidence() { return 1; }\n',
        '2026-04-18T00:00:00Z',
      );
      commitFile(
        tmpDir,
        'src/low.ts',
        'export function lowConfidence() { return 2; }\n',
        '2026-04-19T00:00:00Z',
      );
      commitFile(
        tmpDir,
        'src/low.ts',
        'export function lowConfidence() { return 3; }\n',
        '2026-04-20T00:00:00Z',
      );

      wireDb({
        symbols: [
          {
            id: 'root',
            name: 'exportedRoot',
            type: 'Function',
            filePath: path.join(tmpDir, 'src/root.ts'),
            isExported: true,
          },
          {
            id: 'high',
            name: 'highConfidence',
            type: 'Function',
            filePath: path.join(tmpDir, 'src/high.ts'),
            isExported: false,
          },
          {
            id: 'medium',
            name: 'mediumConfidence',
            type: 'Function',
            filePath: path.join(tmpDir, 'src/medium.ts'),
            isExported: false,
          },
          {
            id: 'low',
            name: 'lowConfidence',
            type: 'Function',
            filePath: path.join(tmpDir, 'src/low.ts'),
            isExported: false,
          },
        ],
      });

      const r = await runDeadCode(
        { id: 'repo-git', name: 'repo-git', repoPath: tmpDir },
        { include_exported: false },
      );
      expect(r.status).toBe('success');
      expect(r.entries.find((e) => e.name === 'highConfidence')?.confidence).toBe('high');
      expect(r.entries.find((e) => e.name === 'mediumConfidence')?.confidence).toBe('medium');
      expect(r.entries.find((e) => e.name === 'lowConfidence')?.confidence).toBe('low');
    });

    it('applies min_stale_days to absolute file paths using repo-relative churn keys', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-dead-code-stale-'));
      initGitRepo(tmpDir);
      const now = Date.now();
      const staleCommitDate = new Date(now - 120 * 24 * 60 * 60 * 1000).toISOString();
      const recentCommitDate = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

      commitFile(tmpDir, 'src/stale.ts', 'export function staleHelper() {}\n', staleCommitDate);
      commitFile(tmpDir, 'src/recent.ts', 'export function recentHelper() {}\n', recentCommitDate);

      wireDb({
        symbols: [
          {
            id: 'root',
            name: 'exportedRoot',
            type: 'Function',
            filePath: path.join(tmpDir, 'src/root.ts'),
            isExported: true,
          },
          {
            id: 'stale',
            name: 'staleHelper',
            type: 'Function',
            filePath: path.join(tmpDir, 'src/stale.ts'),
            isExported: false,
          },
          {
            id: 'recent',
            name: 'recentHelper',
            type: 'Function',
            filePath: path.join(tmpDir, 'src/recent.ts'),
            isExported: false,
          },
        ],
      });

      const r = await runDeadCode(
        { id: 'repo-stale', name: 'repo-stale', repoPath: tmpDir },
        { include_exported: false, min_stale_days: 30 },
      );
      expect(r.status).toBe('success');
      expect(r.entries.map((e) => e.name)).toContain('staleHelper');
      expect(r.entries.map((e) => e.name)).not.toContain('recentHelper');
    });
  });

  describe('@deprecated / @internal tag detection', () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('includes_deprecated_tag is true for symbol with @deprecated in header', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-dead-code-'));
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, 'helper.ts'),
        [
          '/**',
          ' * @deprecated use newHelper instead.',
          ' */',
          'export function oldHelper() {}',
        ].join('\n'),
      );

      wireDb({
        symbols: [
          {
            id: 'dep1',
            name: 'oldHelper',
            type: 'Function',
            filePath: 'src/helper.ts',
            startLine: 4,
            endLine: 4,
            isExported: true,
          },
        ],
      });

      const r = await runDeadCode(
        { id: 'dep-test', name: 'dep-test', repoPath: tmpDir },
        { include_exported: true },
      );
      expect(r.status).toBe('success');
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0].includes_deprecated_tag).toBe(true);
    });

    it('includes_deprecated_tag defaults to false when repoPath absent', async () => {
      wireDb({
        symbols: [
          {
            id: 'noRepo1',
            name: 'orphanNoRepo',
            type: 'Function',
            filePath: 'src/orphan.ts',
            startLine: 5,
            endLine: 10,
            isExported: false,
          },
        ],
      });

      const r = await runDeadCode({ id: 'no-repo-test', name: 'no-repo-test' }, {});
      expect(r.status).toBe('success');
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0].includes_deprecated_tag).toBe(false);
    });
  });

  describe('model-pack roots', () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('treats HANDLES_ROUTE handlers as reachable when route-model packs are active', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-dead-code-model-pack-'));
      fs.mkdirSync(path.join(tmpDir, 'ontoindex-packs', 'core', 'framework-models'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tmpDir, 'ontoindex-packs', 'core', 'framework-models', 'pack.yml'),
        [
          'schema: 1',
          'id: core.framework-models',
          'name: Framework Models',
          'version: 0.1.0',
          'kind: model',
          'tier: experimental',
          'summary: Model pack fixture for dead-code tests.',
          'provides:',
          '  - route-models',
        ].join('\n'),
      );

      wireDb({
        symbols: [
          {
            id: 'routeHandler',
            name: 'getUsers',
            type: 'Function',
            filePath: 'src/routes/users.ts',
            isExported: false,
          },
        ],
        routeHandlerSeeds: ['routeHandler'],
      });

      const r = await runDeadCode(
        { id: 'dc-route-model', name: 'dc-route-model', repoPath: tmpDir },
        {},
      );
      expect(r.status).toBe('success');
      expect(r.entries.find((e) => e.name === 'getUsers')).toBeUndefined();
      expect(r.activeModelPacks).toEqual([
        {
          id: 'core.framework-models',
          tier: 'experimental',
          provides: ['route-models'],
        },
      ]);
    });
  });
});
