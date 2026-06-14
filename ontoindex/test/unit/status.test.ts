import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatIndexCapabilityWarnings,
  formatNativeGraphWriterStatus,
  formatSemanticSearchStatus,
} from '../../src/cli/status.js';
import { appendIndexCapabilityWarnings } from '../../src/storage/index-capabilities.js';
import type { RepoMeta } from '../../src/storage/repo-manager.js';

const nativeModule = () => ({
  writeGraphBatchNative: vi.fn(),
});

describe('status formatting', () => {
  it('formats native graph writer visibility when disabled by default', () => {
    expect(
      formatNativeGraphWriterStatus({
        env: {},
        nativeModule: nativeModule(),
      }),
    ).toBe(
      'Native graph writer: ONTOINDEX_NATIVE_GRAPH_WRITER disabled, not configured, available (ONTOINDEX_NATIVE_GRAPH_WRITER is not set)',
    );
  });

  it('formats native graph writer visibility when enabled but unavailable', () => {
    expect(
      formatNativeGraphWriterStatus({
        env: { ONTOINDEX_NATIVE_GRAPH_WRITER: '1' },
        nativeModule: {},
      }),
    ).toBe(
      'Native graph writer: ONTOINDEX_NATIVE_GRAPH_WRITER enabled, configured, unavailable (native graph writer export is not available)',
    );
  });

  it('describes semantic search availability without vague storage language', () => {
    expect(formatSemanticSearchStatus()).toBe(
      'Semantic search: absent (no index metadata yet; run ontoindex analyze --embeddings to populate)',
    );

    expect(
      formatSemanticSearchStatus({
        stats: { embeddings: 12 },
      }),
    ).toBe('Semantic search: available (12 embeddings recorded)');

    expect(
      formatSemanticSearchStatus({
        pipelineProfile: 'symbols',
        stats: { embeddings: 0 },
      }),
    ).toBe(
      'Semantic search: absent (symbols-only index; run ontoindex analyze --embeddings to populate)',
    );
  });

  it('keeps legacy full-index metadata quiet', () => {
    const meta: RepoMeta = {
      repoPath: '.',
      lastCommit: 'abc123',
      indexedAt: '2026-05-27T00:00:00.000Z',
    };

    expect(formatIndexCapabilityWarnings(meta)).toEqual([]);
  });

  it('warns explicitly for symbols-only indexes', () => {
    const meta: RepoMeta = {
      repoPath: '.',
      lastCommit: 'abc123',
      indexedAt: '2026-05-27T00:00:00.000Z',
      indexMode: 'symbols-only',
      capabilities: {
        symbols: true,
        impact: 'degraded',
        processes: false,
      },
    };

    expect(formatIndexCapabilityWarnings(meta)).toEqual([
      'WARNING: index capabilities are degraded.',
      'Index mode: symbols-only',
      '  Symbols: available',
      '  Processes: unavailable',
      '  Impact analysis: degraded',
    ]);
  });

  it('surfaces durable degraded metadata when present', () => {
    const meta: RepoMeta = {
      repoPath: '.',
      lastCommit: 'abc123',
      indexedAt: '2026-05-27T00:00:00.000Z',
      pipelineProfile: 'symbols',
      skippedPhases: ['communities', 'processes'],
      degradedFiles: [
        { filePath: 'include/rtl/string.hxx', reason: 'scope extraction skipped' },
        { filePath: 'editeng/source/editeng/editdoc.cxx', reason: 'scope extraction skipped' },
      ],
      partialCheckpointPath: '.ontoindex/analysis-checkpoint.json',
    };

    expect(formatIndexCapabilityWarnings(meta)).toEqual([
      'WARNING: index capabilities are degraded.',
      'Index mode: symbols',
      '  Symbols: available',
      '  Processes: unavailable',
      '  Impact analysis: degraded',
      '  Skipped phases: communities, processes',
      '  Degraded files: 2',
      '  Partial checkpoint: .ontoindex/analysis-checkpoint.json',
    ]);
  });

  it('adds capability warnings to object-shaped tool results', () => {
    expect(
      appendIndexCapabilityWarnings({ status: 'success', warnings: ['pre-existing'] }, [
        'WARNING: index capabilities are degraded.',
      ]),
    ).toEqual({
      status: 'success',
      warnings: ['pre-existing', 'WARNING: index capabilities are degraded.'],
    });
  });
});

describe('status command behavior', () => {
  const nativeGraphWriterStatus = {
    flagName: 'ONTOINDEX_NATIVE_GRAPH_WRITER',
    enabled: false,
    configured: false,
    available: true,
    reason: 'mocked native graph writer status',
  };

  const makeRepo = (
    repoPath: string,
    meta: Partial<RepoMeta> & Pick<RepoMeta, 'indexedAt' | 'lastCommit'>,
  ) => ({
    repoPath,
    meta: {
      repoPath,
      indexedAt: meta.indexedAt,
      lastCommit: meta.lastCommit,
      ...meta,
    } as RepoMeta,
  });

  let repoManagerMocks: {
    findRepo: ReturnType<typeof vi.fn>;
    getStoragePaths: ReturnType<typeof vi.fn>;
    hasKuzuIndex: ReturnType<typeof vi.fn>;
    listRegisteredRepos: ReturnType<typeof vi.fn>;
    loadRepo: ReturnType<typeof vi.fn>;
  };

  let gitMocks: {
    getCurrentCommit: ReturnType<typeof vi.fn>;
    getGitRoot: ReturnType<typeof vi.fn>;
    isGitRepo: ReturnType<typeof vi.fn>;
  };

  let nativeMocks: {
    getNativeGraphWriterStatus: ReturnType<typeof vi.fn>;
  };

  const importStatus = async () => import('../../src/cli/status.js');

  beforeEach(() => {
    vi.resetModules();

    repoManagerMocks = {
      findRepo: vi.fn(),
      getStoragePaths: vi.fn((repoPath: string) => ({
        storagePath: `${repoPath}/.ontoindex`,
        lbugPath: `${repoPath}/.ontoindex/lbug`,
        metaPath: `${repoPath}/.ontoindex/meta.json`,
      })),
      hasKuzuIndex: vi.fn().mockResolvedValue(false),
      listRegisteredRepos: vi.fn().mockResolvedValue([]),
      loadRepo: vi.fn().mockResolvedValue(null),
    };

    gitMocks = {
      getCurrentCommit: vi.fn().mockReturnValue('abc123def456'),
      getGitRoot: vi.fn().mockReturnValue(null),
      isGitRepo: vi.fn().mockReturnValue(false),
    };

    nativeMocks = {
      getNativeGraphWriterStatus: vi.fn().mockReturnValue(nativeGraphWriterStatus),
    };

    vi.doMock('../../src/storage/repo-manager.js', () => repoManagerMocks);
    vi.doMock('../../src/storage/git.js', () => gitMocks);
    vi.doMock('../../src/native/graph-writer.js', () => nativeMocks);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps explicit repo paths inspectable even when they are unindexed', async () => {
    const { statusCommand } = await importStatus();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const repoPath = '/tmp/unindexed-repo';
    gitMocks.isGitRepo.mockReturnValue(true);
    gitMocks.getGitRoot.mockReturnValue(repoPath);

    await statusCommand({ repo: repoPath });

    expect(repoManagerMocks.listRegisteredRepos).not.toHaveBeenCalled();
    expect(repoManagerMocks.loadRepo).toHaveBeenCalledWith(repoPath);
    expect(logSpy.mock.calls.map(([line]) => line)).toEqual(
      expect.arrayContaining(['Repository not indexed.', 'Run: ontoindex analyze']),
    );
    expect(logSpy.mock.calls.map(([line]) => line)).toContain(
      'Semantic search: absent (no index metadata yet; run ontoindex analyze --embeddings to populate)',
    );
  });

  it('resolves registry names to indexed repo paths', async () => {
    const { statusCommand } = await importStatus();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const repoPath = '/tmp/indexed-repo';
    repoManagerMocks.listRegisteredRepos.mockResolvedValue([
      {
        name: 'mini-repo',
        path: repoPath,
        storagePath: `${repoPath}/.ontoindex`,
        indexedAt: '2026-05-27T00:00:00.000Z',
        lastCommit: 'abc123def456',
      },
    ]);
    repoManagerMocks.findRepo.mockResolvedValue(
      makeRepo(repoPath, {
        indexedAt: '2026-05-27T00:00:00.000Z',
        lastCommit: 'abc123def456',
        stats: { embeddings: 12 },
      }),
    );
    gitMocks.isGitRepo.mockReturnValue(true);

    await statusCommand({ repo: 'mini-repo' });

    expect(repoManagerMocks.listRegisteredRepos).toHaveBeenCalledWith({ validate: true });
    expect(logSpy.mock.calls.map(([line]) => line)).toEqual(
      expect.arrayContaining([
        `Repository: ${repoPath}`,
        'Status: ✅ up-to-date',
        'Semantic search: available (12 embeddings recorded)',
      ]),
    );
  });

  it('reports stale KuzuDB storage when a direct path has only legacy index files', async () => {
    const { statusCommand } = await importStatus();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const repoPath = '/tmp/stale-kuzu-repo';
    gitMocks.isGitRepo.mockReturnValue(true);
    gitMocks.getGitRoot.mockReturnValue(repoPath);
    repoManagerMocks.findRepo.mockResolvedValue(null);
    repoManagerMocks.hasKuzuIndex.mockResolvedValue(true);

    await statusCommand({ repo: repoPath });

    expect(repoManagerMocks.listRegisteredRepos).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map(([line]) => line)).toEqual(
      expect.arrayContaining([
        'Repository has a stale KuzuDB index from a previous version.',
        'Semantic search: absent (stale KuzuDB index; rebuild with ontoindex analyze --embeddings)',
        'Run: ontoindex analyze   (rebuilds the index with LadybugDB)',
      ]),
    );
  });

  it('describes indexed repos without embeddings as semantic-search absent', async () => {
    const { statusCommand } = await importStatus();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const repoPath = '/tmp/symbols-only-repo';
    gitMocks.isGitRepo.mockReturnValue(true);
    repoManagerMocks.findRepo.mockResolvedValue(
      makeRepo(repoPath, {
        indexedAt: '2026-05-27T00:00:00.000Z',
        lastCommit: 'abc123def456',
        pipelineProfile: 'symbols',
        indexMode: 'symbols-only',
        stats: { embeddings: 0 },
      }),
    );

    await statusCommand({ repo: repoPath });

    expect(logSpy.mock.calls.map(([line]) => line)).toContain(
      'Semantic search: absent (symbols-only index; run ontoindex analyze --embeddings to populate)',
    );
  });
});
