import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatIndexCapabilityWarnings,
  formatNativeGraphWriterStatus,
  formatSemanticSearchStatus,
} from '../../src/cli/status.js';
import type { DiagnoseReport } from '../../src/mcp/super/diagnose.js';
import {
  formatRuntimeHealthDetailLines,
  formatRuntimeHealthStatusLine,
} from '../../src/core/runtime/runtime-health.js';
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

  it('formats runtime health snapshots with repair guidance', () => {
    const health = {
      version: 1 as const,
      repoLabel: 'fixture',
      repoPath: '/tmp/fixture',
      indexedCommit: 'abc123def456',
      currentCommit: 'abc123def456',
      dirtyWorktree: false,
      freshnessState: 'clean' as const,
      degradedReason: null,
      repairCommand: 'ontoindex status',
      hasRuntimeArtifacts: false,
      analyzeLock: {
        path: '/tmp/fixture/.ontoindex/analyze.lock',
        present: false,
        state: 'absent' as const,
      },
      analysisCheckpoint: {
        path: '/tmp/fixture/.ontoindex/analysis-checkpoint.json',
        present: false,
        state: 'absent' as const,
      },
      embeddingCheckpoint: {
        path: '/tmp/fixture/.ontoindex/embedding-checkpoint.json',
        present: false,
      },
      bootstrapSource: {
        path: '/tmp/fixture/.ontoindex/bootstrap-source.json',
        present: false,
      },
      warnings: [],
    };

    expect(formatRuntimeHealthStatusLine(health)).toBe('Runtime health: clean');
    expect(formatRuntimeHealthDetailLines(health)).toEqual([
      '  Indexed commit: abc123d',
      '  Current commit: abc123d',
      '  Dirty worktree: no',
      '  Analyze lock: absent',
      '  Analysis checkpoint: absent',
      '  Embedding checkpoint: absent',
      '  Repair: ontoindex status',
    ]);
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

  let fsMocks: {
    readFile: ReturnType<typeof vi.fn>;
  };

  let runtimeHealthMocks: {
    readRuntimeHealth: ReturnType<typeof vi.fn>;
  };

  let execFileMocks: {
    execFileText: ReturnType<typeof vi.fn>;
  };

  let auditFreshnessMocks: {
    computeAuditFreshness: ReturnType<typeof vi.fn>;
  };

  let diagnoseMocks: {
    gnDiagnose: ReturnType<typeof vi.fn>;
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

    fsMocks = {
      readFile: vi.fn(),
    };

    runtimeHealthMocks = {
      readRuntimeHealth: vi.fn().mockResolvedValue({
        version: 1,
        repoLabel: 'fixture',
        repoPath: '/tmp/fixture',
        indexedCommit: 'abc123def456',
        currentCommit: 'abc123def456',
        dirtyWorktree: false,
        freshnessState: 'clean',
        degradedReason: null,
        repairCommand: 'ontoindex status',
        hasRuntimeArtifacts: false,
        analyzeLock: {
          path: '/tmp/fixture/.ontoindex/analyze.lock',
          present: false,
          state: 'absent',
        },
        analysisCheckpoint: {
          path: '/tmp/fixture/.ontoindex/analysis-checkpoint.json',
          present: false,
          state: 'absent',
        },
        embeddingCheckpoint: {
          path: '/tmp/fixture/.ontoindex/embedding-checkpoint.json',
          present: false,
        },
        bootstrapSource: {
          path: '/tmp/fixture/.ontoindex/bootstrap-source.json',
          present: false,
        },
        warnings: [],
      }),
    };

    execFileMocks = {
      execFileText: vi.fn().mockResolvedValue(''),
    };

    auditFreshnessMocks = {
      computeAuditFreshness: vi.fn(),
    };

    diagnoseMocks = {
      gnDiagnose: vi.fn().mockResolvedValue(makeDiagnoseReport()),
    };

    vi.doMock('../../src/storage/repo-manager.js', () => repoManagerMocks);
    vi.doMock('../../src/storage/git.js', () => gitMocks);
    vi.doMock('../../src/native/graph-writer.js', () => nativeMocks);
    vi.doMock('node:fs/promises', () => fsMocks);
    vi.doMock('../../src/core/process/exec-file.js', () => execFileMocks);
    vi.doMock('../../src/mcp/super/diagnose.js', () => diagnoseMocks);
    vi.doMock('../../src/core/audit-lifecycle/index.js', async () => {
      const actual = await vi.importActual<any>('../../src/core/audit-lifecycle/index.js');
      return {
        ...actual,
        computeAuditFreshness: (...args: any[]) => auditFreshnessMocks.computeAuditFreshness(...args),
      };
    });
    vi.doMock('../../src/core/runtime/runtime-health.js', async () => {
      const actual = await vi.importActual<
        typeof import('../../src/core/runtime/runtime-health.js')
      >('../../src/core/runtime/runtime-health.js');
      return {
        ...actual,
        readRuntimeHealth: runtimeHealthMocks.readRuntimeHealth,
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeDiagnoseReport(
    overrides: Partial<DiagnoseReport> = {},
  ): DiagnoseReport {
    return {
      version: 1,
      classification: {
        evidenceClasses: [],
        resourceContracts: {
          definitions: 0,
          templates: 0,
          total: 0,
          byEvidenceClass: {
            graph_evidence: 0,
            docs_evidence: 0,
            audit_evidence: 0,
            runtime_diagnostic: 0,
            advisory_memory: 0,
            unknown: 0,
          },
          suitability: { auditEligible: 0, docs: 0, diagnostics: 0 },
        },
      },
      setup: {
        mcp: {
          repoFilter: null,
          autoAnalyze: 'unset',
          startupTimeoutMs: 30000,
          startupTrace: false,
        },
        auth: {
          httpApiToken: 'generated-per-process',
          enforcement: 'metadata-only',
        },
      },
      responseLimits: {
        mcpCypherLimitMax: 5000,
        processDetailStepLimit: 1000,
        httpMcpSessionCap: 32,
        truncationPolicy: 'bounded',
      },
      responseBudgetHealth: {
        guardLimitBytes: 512 * 1024,
        recentOversizedTools: [],
        guardedPreviewAvailable: true,
      },
      toolTelemetrySummary: {
        recentOversizedCount: 0,
        recentOversizedTools: [],
      },
      runtimeContextSummary: {
        repoLabel: 'fixture',
        repoPath: '/tmp/fixture',
        freshness: 'fresh',
        scopeConfidence: 'high',
        dirtyWorktree: false,
        dirtyFileCount: 0,
        embeddings: 'available',
        sidecar: 'unknown',
        qualityMode: 'fast',
        nextRepairCommands: [],
      },
      degradedContext: {
        status: 'ok',
        reasons: [],
        affectedAreas: [],
        confidence: 'full',
      },
      misconfiguration: { status: 'ok' },
      auditFreshness: { status: 'missing' },
      mcpResourceBridge: { exposed: false, exposedTo: [] },
      support: {
        lbugStore: {
          path: '/tmp/fixture/.ontoindex/lbug',
          exists: false,
          walPresent: false,
          lockPresent: false,
        },
        ladybugExtensions: {
          hintDir: '/tmp/extensions',
          ftsAvailable: true,
          vectorAvailable: true,
        },
        timeoutHints: {
          nativeGetAllMs: 30000,
        },
      },
      envVars: {},
      recommendations: [],
      warnings: [],
      ...overrides,
    };
  }

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
    fsMocks.readFile.mockRejectedValue(new Error('ENOENT'));
    gitMocks.isGitRepo.mockReturnValue(true);

    await statusCommand({ repo: 'mini-repo' });

    expect(repoManagerMocks.listRegisteredRepos).toHaveBeenCalledWith({ validate: true });
    expect(logSpy.mock.calls.map(([line]) => line)).toEqual(
      expect.arrayContaining([
        `Repository: ${repoPath}`,
        'Status: ✅ up-to-date',
        'Runtime health: clean',
        'Semantic search: available (12 embeddings recorded)',
      ]),
    );
    expect(logSpy.mock.calls.map(([line]) => line)).not.toContain('Needs update: marker present');
  });

  it('reports a passive needs-update marker as present when the file is plain text', async () => {
    const { statusCommand } = await importStatus();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const repoPath = '/tmp/indexed-repo';
    repoManagerMocks.findRepo.mockResolvedValue(
      makeRepo(repoPath, {
        indexedAt: '2026-05-27T00:00:00.000Z',
        lastCommit: 'abc123def456',
        stats: { embeddings: 12 },
      }),
    );
    fsMocks.readFile.mockResolvedValue('1\n');
    gitMocks.isGitRepo.mockReturnValue(true);

    await statusCommand({ repo: repoPath });

    expect(logSpy.mock.calls.map(([line]) => line)).toEqual(
      expect.arrayContaining(['Needs update: marker present', 'Repair: ontoindex analyze']),
    );
  });

  it('reports a passive needs-update marker reason from JSON content', async () => {
    const { statusCommand } = await importStatus();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const repoPath = '/tmp/indexed-repo';
    repoManagerMocks.findRepo.mockResolvedValue(
      makeRepo(repoPath, {
        indexedAt: '2026-05-27T00:00:00.000Z',
        lastCommit: 'abc123def456',
        stats: { embeddings: 12 },
      }),
    );
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        reason: 'docs changed',
        createdAt: '2026-06-17T00:00:00.000Z',
      }),
    );
    gitMocks.isGitRepo.mockReturnValue(true);

    await statusCommand({ repo: repoPath });

    expect(logSpy.mock.calls.map(([line]) => line)).toEqual(
      expect.arrayContaining(['Needs update: docs changed', 'Repair: ontoindex analyze']),
    );
  });

  it('prints support diagnostics for the Ladybug store, extensions, timeout, and audit replay hint', async () => {
    const { statusCommand } = await importStatus();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const repoPath = '/tmp/indexed-repo';
    repoManagerMocks.findRepo.mockResolvedValue(
      makeRepo(repoPath, {
        indexedAt: '2026-05-27T00:00:00.000Z',
        lastCommit: 'abc123def456',
        stats: { embeddings: 12 },
      }),
    );
    gitMocks.isGitRepo.mockReturnValue(true);
    fsMocks.readFile.mockRejectedValue(new Error('ENOENT'));
    diagnoseMocks.gnDiagnose.mockResolvedValue(
      makeDiagnoseReport({
        auditFreshness: {
          status: 'stale',
          targetHead: 'abc123def456',
          currentHead: 'fedcba654321',
          sessionId: 'S-1',
          repairCommand: 'gn_audit_replay({session: "S-1"})',
        },
        support: {
          lbugStore: {
            path: '/tmp/indexed-repo/.ontoindex/lbug',
            exists: true,
            sizeBytes: 2048,
            modifiedAt: '2026-06-27T12:00:00.000Z',
            walPresent: false,
            lockPresent: false,
          },
          ladybugExtensions: {
            hintDir: '/tmp/extensions',
            ftsAvailable: true,
            vectorAvailable: false,
          },
          timeoutHints: {
            nativeGetAllMs: 30000,
          },
        },
      }),
    );

    await statusCommand({ repo: repoPath });

    expect(logSpy.mock.calls.map(([line]) => line)).toEqual(
      expect.arrayContaining([
        'Ladybug store: present (2.0 KB, modified 2026-06-27T12:00:00.000Z)',
        'Ladybug sidecars: wal absent, lock absent',
        'Ladybug extensions: fts available, vector missing',
        'Ladybug timeout: native getAll 30000ms',
        'Ladybug extension hint: /tmp/extensions',
        'Audit replay: gn_audit_replay({session: "S-1"})',
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

  it('prints untrusted runtime health before healthy-looking status details', async () => {
    const { statusCommand } = await importStatus();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const repoPath = '/tmp/untrusted-repo';
    gitMocks.isGitRepo.mockReturnValue(true);
    repoManagerMocks.findRepo.mockResolvedValue(
      makeRepo(repoPath, {
        indexedAt: '2026-05-27T00:00:00.000Z',
        lastCommit: 'abc123def456',
        stats: { embeddings: 12 },
      }),
    );
    runtimeHealthMocks.readRuntimeHealth.mockResolvedValue({
      version: 1,
      repoLabel: 'fixture',
      repoPath,
      indexedCommit: 'abc123def456',
      currentCommit: 'abc123def456',
      dirtyWorktree: false,
      freshnessState: 'untrusted',
      degradedReason: 'analyze.lock is stale',
      repairCommand: 'remove the stale analyze.lock, then rerun ontoindex analyze --force',
      hasRuntimeArtifacts: true,
      analyzeLock: {
        path: `${repoPath}/.ontoindex/analyze.lock`,
        present: true,
        state: 'stale',
      },
      analysisCheckpoint: {
        path: `${repoPath}/.ontoindex/analysis-checkpoint.json`,
        present: false,
        state: 'absent',
      },
      embeddingCheckpoint: {
        path: `${repoPath}/.ontoindex/embedding-checkpoint.json`,
        present: false,
      },
      bootstrapSource: {
        path: `${repoPath}/.ontoindex/bootstrap-source.json`,
        present: false,
      },
      warnings: [],
    });

    await statusCommand({ repo: repoPath });

    const lines = logSpy.mock.calls.map(([line]) => String(line));
    expect(lines.indexOf('Runtime health: untrusted')).toBeLessThan(
      lines.findIndex((line) => line.startsWith('Status:')),
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        'Status: ⚠️ untrusted (runtime artifacts need repair)',
        '  Repair: remove the stale analyze.lock, then rerun ontoindex analyze --force',
      ]),
    );
  });

  it('surfaces diagnostics summary and audit freshness in status output', async () => {
    const { statusCommand } = await importStatus();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const repoPath = '/tmp/indexed-repo';
    repoManagerMocks.findRepo.mockResolvedValue(
      makeRepo(repoPath, {
        indexedAt: '2026-05-27T00:00:00.000Z',
        lastCommit: 'abc123def456',
        stats: { embeddings: 12 },
      }),
    );
    gitMocks.isGitRepo.mockReturnValue(true);

    diagnoseMocks.gnDiagnose.mockResolvedValue(
      makeDiagnoseReport({
        runtimeContextSummary: {
          repoLabel: 'indexed-repo',
          repoPath,
          freshness: 'fresh',
          scopeConfidence: 'medium',
          dirtyWorktree: true,
          dirtyFileCount: 2,
          embeddings: 'available',
          sidecar: 'unknown',
          qualityMode: 'fast',
          nextRepairCommands: [],
        },
        embeddings: {
          count: 12,
          populated: true,
          status: 'ok',
        },
        auditFreshness: {
          status: 'clean',
          targetHead: 'abc123def456',
          currentHead: 'abc123def456',
        },
        mcpResourceBridge: {
          exposed: false,
          exposedTo: [],
        },
      }),
    );

    await statusCommand({ repo: repoPath });

    const lines = logSpy.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual(
      expect.arrayContaining([
        'Graph index: clean',
        'Dirty worktree: yes, 2 files changed',
        'Scope confidence: medium',
        'Embeddings: available, 12 recorded',
        'Audit projection: clean, target abc123de',
        'MCP resources: not exposed',
      ]),
    );
  });
});
