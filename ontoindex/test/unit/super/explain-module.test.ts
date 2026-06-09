/**
 * Unit tests: gnExplainModule
 *
 * All graph I/O is mocked via vi.mock. No real LadybugDB connection is opened.
 */

import { mkdir, rm, writeFile } from 'fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks — must be defined before the module under test is imported

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

vi.mock('../../../src/core/search/skeleton.js', () => ({
  getFileSkeleton: vi.fn(),
}));

vi.mock('../../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: any, callback: any) => {
    callback(null, '2024-01-15T12:00:00+00:00\n', '');
    return {};
  }),
}));

import { gnExplainModule } from '../../../src/mcp/super/explain-module.js';
import { executeParameterized } from '../../../src/core/lbug/pool-adapter.js';
import { getFileSkeleton } from '../../../src/core/search/skeleton.js';

const mockExecute = vi.mocked(executeParameterized);
const mockSkeleton = vi.mocked(getFileSkeleton);

// Helpers

/** Default file node returned by the MATCH (f:File) query. */
const FILE_NODE = {
  f: {
    filePath: 'src/foo.ts',
    lineCount: 120,
    lastModified: '2024-06-01T10:00:00Z',
  },
};

/** Make mockExecute return sensible defaults for all sub-queries. */
function setupDefaultMocks() {
  mockSkeleton.mockResolvedValue('Symbols in src/foo.ts:\n  - function bar (lines 5-20)');

  mockExecute.mockImplementation(async (_repoId, cypher, _params) => {
    // File resolution
    if (cypher.includes('MATCH (f:File') && cypher.includes('RETURN f')) {
      return [FILE_NODE];
    }
    // Exported symbols
    if (
      cypher.includes("type: 'DEFINES'") &&
      cypher.includes('RETURN s') &&
      !cypher.includes('COUNT(')
    ) {
      return [
        {
          s: { name: 'doWork', kind: 'Function', isExported: true, startLine: 10, endLine: 20 },
        },
        { s: { name: 'MyClass', kind: 'Class', isExported: true, startLine: 30, endLine: 50 } },
      ];
    }
    // Cluster
    if (cypher.includes('IN_COMMUNITY')) {
      return [{ c: { name: 'core', role: 'business-logic', fileCount: 12 } }];
    }
    // Co-change
    if (cypher.includes('CO_CHANGED_WITH')) {
      return [
        { path: 'src/bar.ts', coChangeCount: 8 },
        { path: 'src/baz.ts', coChangeCount: 3 },
      ];
    }
    // symbolCount
    if (cypher.includes('COUNT(s)')) {
      return [{ cnt: 5 }];
    }
    // importCount
    if (cypher.includes('COUNT(other)')) {
      return [{ cnt: 7 }];
    }
    return [];
  });
}

// Tests

describe('gnExplainModule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm('.vitest-explain-module', { recursive: true, force: true });
  });

  it('returns warning and empty report when file is not in the index', async () => {
    mockExecute.mockResolvedValue([]);

    const report = await gnExplainModule('test-repo', { filePath: 'src/missing.ts' });

    expect(report.version).toBe(1);
    expect(report.filePath).toBe('src/missing.ts');
    expect(report.publicAPI).toEqual([]);
    expect(report.warnings).toContain('file not in index — run ontoindex analyze');
  });

  it('populates fileSkeleton when includeSkeleton is true (default)', async () => {
    setupDefaultMocks();

    const report = await gnExplainModule('test-repo', {
      filePath: 'src/foo.ts',
      includeSkeleton: true,
    });

    expect(report.fileSkeleton).toBeDefined();
    expect(report.fileSkeleton).toContain('src/foo.ts');
  });

  it('excludes non-exported symbols from publicAPI', async () => {
    mockSkeleton.mockResolvedValue('');

    mockExecute.mockImplementation(async (_repoId, cypher, _params) => {
      if (cypher.includes('MATCH (f:File') && cypher.includes('RETURN f')) {
        return [FILE_NODE];
      }
      if (
        cypher.includes("type: 'DEFINES'") &&
        cypher.includes('RETURN s') &&
        !cypher.includes('COUNT(')
      ) {
        return [{ s: { name: 'exportedFn', kind: 'Function', isExported: true } }];
      }
      if (cypher.includes('COUNT(s)')) return [{ cnt: 1 }];
      return [];
    });

    const report = await gnExplainModule('test-repo', {
      filePath: 'src/foo.ts',
      includePublicAPI: true,
    });

    expect(report.publicAPI).toHaveLength(1);
    expect(report.publicAPI[0].name).toBe('exportedFn');
  });

  it('returns coChangedFiles ranked by coChangeCount descending', async () => {
    setupDefaultMocks();

    const report = await gnExplainModule('test-repo', {
      filePath: 'src/foo.ts',
      includeCoChange: true,
    });

    expect(report.coChangedFiles.length).toBeGreaterThan(0);
    for (let i = 1; i < report.coChangedFiles.length; i++) {
      expect(report.coChangedFiles[i - 1].coChangeCount).toBeGreaterThanOrEqual(
        report.coChangedFiles[i].coChangeCount,
      );
    }
  });

  it('estimates lineCount from exported symbols when graph and disk both fail', async () => {
    mockSkeleton.mockResolvedValue('');

    mockExecute.mockImplementation(async (_repoId, cypher, _params) => {
      if (cypher.includes('MATCH (f:File') && cypher.includes('RETURN f')) {
        return [{ f: { filePath: 'src/no-disk-2.ts' } }];
      }
      if (
        cypher.includes("type: 'DEFINES'") &&
        cypher.includes('RETURN s') &&
        !cypher.includes('COUNT(')
      ) {
        return [
          { s: { name: 'start', kind: 'Function', isExported: true, startLine: 10, endLine: 50 } },
          { s: { name: 'end', kind: 'Function', isExported: true, startLine: 100, endLine: 200 } },
        ];
      }
      if (cypher.includes('COUNT(s)')) return [{ cnt: 2 }];
      return [];
    });

    const report = await gnExplainModule('test-repo', { filePath: 'src/no-disk-2.ts' });

    expect(report.publicAPI).toHaveLength(2);
    expect(report.fileStats.lineCount).toBe(200);
    expect(report.warnings).toContain('lineCount estimated from exported symbols');
  });

  it('preserves C++ graph kinds, derives lineCount from source, and warns on empty skeleton', async () => {
    const filePath = '.vitest-explain-module/TileCache.cpp';
    await mkdir('.vitest-explain-module', { recursive: true });
    await writeFile(
      filePath,
      [
        'struct TileCache {',
        '  void saveTileAndNotify();',
        '};',
        'void TileCache::saveTileAndNotify() {}',
      ].join('\n'),
    );
    mockSkeleton.mockResolvedValue('');

    mockExecute.mockImplementation(async (_repoId, cypher, _params) => {
      if (cypher.includes('MATCH (f:File') && cypher.includes('RETURN f')) {
        return [{ f: { filePath } }];
      }
      if (
        cypher.includes("type: 'DEFINES'") &&
        cypher.includes('RETURN s') &&
        !cypher.includes('COUNT(')
      ) {
        return [
          {
            s: {
              name: 'saveTileAndNotify',
              kind: 'method_definition',
              isExported: true,
              startLine: 2,
            },
          },
          { s: { name: 'TileCache', kind: 'struct_specifier', isExported: true, startLine: 1 } },
          { s: { name: 'Widget', kind: 'class_specifier', isExported: true, startLine: 1 } },
          {
            s: {
              name: 'freeFunction',
              kind: 'function_definition',
              isExported: true,
              startLine: 4,
            },
          },
          { s: { name: 'wsd', kind: 'namespace_definition', isExported: true, startLine: 1 } },
        ];
      }
      if (cypher.includes('COUNT(s)')) return [{ cnt: 5 }];
      return [];
    });

    const report = await gnExplainModule('test-repo', { filePath });

    expect(report.publicAPI.map((entry) => [entry.name, entry.kind])).toEqual([
      ['saveTileAndNotify', 'Method'],
      ['TileCache', 'Struct'],
      ['Widget', 'Class'],
      ['freeFunction', 'Function'],
      ['wsd', 'Namespace'],
    ]);
    expect(report.fileStats.lineCount).toBe(4);
    expect(report.warnings).toContain('file skeleton unavailable for indexed file');
  });

  it('derives lineCount from skeleton ranges when graph and source lines are unavailable', async () => {
    mockSkeleton.mockResolvedValue(
      ['Symbols in src/cpp/TileCache.cpp:', '  - class TileCache (lines 7-42)'].join('\n'),
    );

    mockExecute.mockImplementation(async (_repoId, cypher, _params) => {
      if (cypher.includes('MATCH (f:File') && cypher.includes('RETURN f')) {
        return [{ f: { filePath: 'src/cpp/TileCache.cpp' } }];
      }
      if (
        cypher.includes("type: 'DEFINES'") &&
        cypher.includes('RETURN s') &&
        !cypher.includes('COUNT(')
      ) {
        return [];
      }
      if (cypher.includes('COUNT(s)')) return [{ cnt: 0 }];
      return [];
    });

    const report = await gnExplainModule('test-repo', { filePath: 'src/cpp/TileCache.cpp' });

    expect(report.fileStats.lineCount).toBe(42);
    expect(report.warnings).toContain('lineCount estimated from file skeleton');
  });
});
