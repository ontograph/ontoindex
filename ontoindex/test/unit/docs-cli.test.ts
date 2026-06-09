import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sidecarStatusCommand, sidecarRunCommand, knowledgeCommand } from '../../src/cli/docs.js';
import * as repoManager from '../../src/storage/repo-manager.js';
import * as git from '../../src/storage/git.js';
import { LocalSidecarStore } from '../../src/core/ingestion/enrichment/sidecar-store.js';
import * as sidecarRunner from '../../src/core/ingestion/enrichment/sidecar-runner.js';
import * as markdownCollector from '../../src/core/ingestion/enrichment/markdown-sidecar-collector.js';
import { hashText } from '../../src/core/ingestion/enrichment/markdown-sidecar-producer.js';

vi.mock('../../src/storage/repo-manager.js');
vi.mock('../../src/storage/git.js');
vi.mock('../../src/core/ingestion/enrichment/sidecar-runner.js');
vi.mock('../../src/core/ingestion/enrichment/markdown-sidecar-collector.js');
vi.mock('../../src/core/ingestion/enrichment/markdown-sidecar-runner.js', () => ({
  createMarkdownSidecarRunnerExecutor: vi.fn(),
  MARKDOWN_DOCUMENT_DEFAULT_ANALYZER_VERSION: '0.1.0',
}));
vi.mock('../../src/core/ingestion/enrichment/markdown-sidecar-request.js', () => ({
  MARKDOWN_DOCUMENT_ANALYZER_ID: 'markdown-document-sidecar',
  createMarkdownDocumentEnrichmentQueueRequest: vi.fn((input) => ({
    queued: true,
    request: {
      repoId: input.repoId,
      sourceIndexId: input.sourceIndexId,
      analyzerId: 'markdown-document-sidecar',
      analyzerVersion: input.analyzerVersion ?? '0.1.0',
      purpose: 'markdown-document-enrichment',
      scopeHash: input.scopeHash,
      priority: input.priority ?? 'background-remainder',
      requestedAt: input.requestedAt,
      durability: 'persistent',
    },
  })),
}));
vi.mock('fs/promises');

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('mockExit');
}) as any);
const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

const indexedRepo = {
  repoPath: '/test/repo',
  meta: {
    repoPath: '/test/repo',
    indexedAt: '2026-01-01T00:00:00.000Z',
    lastCommit: 'abc1234',
    stats: {
      nodes: 10,
      relationships: 20,
      processes: 3,
    },
  },
} as any;

const mockIndexedRepo = () => {
  vi.mocked(repoManager.findRepo).mockResolvedValue(indexedRepo);
};

const parseJsonOutput = () => JSON.parse(mockLog.mock.calls[0][0]);

const markdownRecord = (overrides: Record<string, unknown> = {}) => ({
  sourceIndexId: '2026-01-01T00:00:00.000Z',
  sourceCommitHash: 'abc1234',
  schemaVersion: 1,
  analyzerId: 'markdown-document-sidecar',
  analyzerVersion: '0.1.0',
  filePath: 'docs/a.md',
  fileHash: hashText('fresh content'),
  status: 'complete',
  records: [],
  ...overrides,
});

describe('docs CLI', () => {
  let mockLoad: any;
  let mockSubmitRequest: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(git.isGitRepo).mockReturnValue(true);
    vi.mocked(git.getGitRoot).mockReturnValue('/test/repo');
    vi.mocked(git.getCurrentCommit).mockReturnValue('abc1234');
    vi.mocked(repoManager.getStoragePaths).mockReturnValue({
      storagePath: '/test/repo/.ontoindex',
      lbugPath: '',
      metaPath: '',
    });
    vi.mocked(markdownCollector.collectMarkdownSidecarDocuments).mockResolvedValue({
      documents: [],
      scopeHash: 'empty-scope',
    });

    mockLoad = vi.spyOn(LocalSidecarStore.prototype, 'load');
    mockSubmitRequest = vi.spyOn(LocalSidecarStore.prototype, 'submitRequest').mockResolvedValue({
      status: 'queued',
      request: {} as any,
    });
  });

  afterEach(() => {
    mockExit.mockClear();
    mockLog.mockClear();
    mockError.mockClear();
    mockLoad.mockRestore();
    mockSubmitRequest.mockRestore();
  });

  describe('sidecar status', () => {
    it('returns missing status when repo not indexed', async () => {
      vi.mocked(repoManager.findRepo).mockResolvedValue(null);

      try {
        await sidecarStatusCommand({ json: true, strict: false });
      } catch (e: any) {
        if (e.message !== 'mockExit') throw e;
      }

      expect(mockExit).toHaveBeenCalledWith(0);
      const output = JSON.parse(mockLog.mock.calls[0][0]);
      expect(output.sidecar.status).toBe('missing');
    });

    it('returns complete status when sidecar state has complete enrichments', async () => {
      mockIndexedRepo();

      mockLoad.mockResolvedValue({
        requests: [],
        lock: null,
        enrichments: [markdownRecord()],
      });

      await sidecarStatusCommand({ json: true, strict: true });

      expect(mockExit).not.toHaveBeenCalled();
      const output = parseJsonOutput();
      expect(output.sidecar.status).toBe('complete');
      expect(output.summary.complete).toBe(1);
      expect(output.repo).toMatchObject({
        id: '/test/repo',
        path: '/test/repo',
        sourceIndexId: '2026-01-01T00:00:00.000Z',
        indexedAt: '2026-01-01T00:00:00.000Z',
        sourceCommitHash: 'abc1234',
        graphStats: indexedRepo.meta.stats,
      });
      expect(output.repo.graphSchemaVersion).toEqual(expect.any(Number));
    });

    it('treats an empty readable sidecar store as missing without strict failure', async () => {
      mockIndexedRepo();

      mockLoad.mockResolvedValue({
        requests: [],
        lock: null,
        enrichments: [],
      });

      await sidecarStatusCommand({ json: true, strict: true });

      expect(mockExit).not.toHaveBeenCalled();
      const output = parseJsonOutput();
      expect(output.sidecar.status).toBe('missing');
      expect(output.summary).toMatchObject({
        queued: 0,
        running: 0,
        complete: 0,
        partial: 0,
        failed: 0,
        stale: 0,
        cancelled: 0,
        superseded: 0,
        lock: null,
      });
      expect(output.warnings).toEqual([]);
    });

    it('falls back to empty state when the sidecar store is unreadable', async () => {
      mockIndexedRepo();

      mockLoad.mockRejectedValue(new Error('ENOENT: no sidecar store'));

      await sidecarStatusCommand({ json: true, strict: true });

      expect(mockExit).not.toHaveBeenCalled();
      const output = parseJsonOutput();
      expect(output.sidecar.status).toBe('missing');
      expect(output.warnings).toEqual(['sidecar store unreadable: ENOENT: no sidecar store']);
      expect(output.summary.lock).toBeNull();
    });

    it('returns stale status when commit mismatch', async () => {
      vi.mocked(git.getCurrentCommit).mockReturnValue('def5678'); // Mismatch
      vi.mocked(repoManager.findRepo).mockResolvedValue({
        repoPath: '/test/repo',
        meta: {
          repoPath: '/test/repo',
          indexedAt: '2026-01-01T00:00:00.000Z',
          lastCommit: 'abc1234',
        },
      } as any);

      mockLoad.mockResolvedValue({
        requests: [],
        lock: null,
        enrichments: [
          markdownRecord({
            filePath: 'alpha.md',
            fileHash: hashText('alpha content'),
          }),
          markdownRecord({
            filePath: 'zeta.md',
            fileHash: hashText('zeta content'),
          }),
        ],
      });

      try {
        await sidecarStatusCommand({ json: true, strict: true });
      } catch (e: any) {
        if (e.message !== 'mockExit') throw e;
      }

      expect(mockExit).toHaveBeenCalledWith(1); // Strict mode exits 1 for stale
      const output = JSON.parse(mockLog.mock.calls[0][0]);
      expect(output.sidecar.status).toBe('stale');
    });

    it('returns stale status when stored markdown identity belongs to an old source index', async () => {
      mockIndexedRepo();
      mockLoad.mockResolvedValue({
        requests: [],
        lock: null,
        enrichments: [
          markdownRecord({
            sourceIndexId: '2025-12-31T00:00:00.000Z',
          }),
        ],
      });

      await sidecarStatusCommand({ json: true });

      const output = parseJsonOutput();
      expect(output.sidecar.status).toBe('stale');
      expect(output.sidecar.staleReasons).toContain('source index mismatch');
      expect(output.sidecar.degradedReasons['source-index-mismatch']).toBe(1);
      expect(output.summary.manifest.sourceIndexMismatches).toBe(1);
    });

    it('returns stale status when stored markdown file hash differs from current manifest', async () => {
      mockIndexedRepo();
      vi.mocked(markdownCollector.collectMarkdownSidecarDocuments).mockResolvedValue({
        documents: [{ docPath: 'docs/a.md', source: 'fresh content', sourceCommitHash: 'abc1234' }],
        scopeHash: 'docs-scope',
      });
      mockLoad.mockResolvedValue({
        requests: [],
        lock: null,
        enrichments: [markdownRecord({ fileHash: 'old-hash' })],
      });

      await sidecarStatusCommand({ json: true });

      const output = parseJsonOutput();
      expect(output.sidecar.status).toBe('stale');
      expect(output.sidecar.staleReasons).toContain('doc hash mismatch');
      expect(output.sidecar.degradedReasons['doc-hash-mismatch']).toBe(1);
      expect(output.summary.manifest.docHashMismatches).toBe(1);
      expect(output.manifest.files).toEqual([
        { docPath: 'docs/a.md', fileHash: hashText('fresh content') },
      ]);
    });

    it('returns partial status when current manifest has missing markdown coverage', async () => {
      mockIndexedRepo();
      vi.mocked(markdownCollector.collectMarkdownSidecarDocuments).mockResolvedValue({
        documents: [
          { docPath: 'docs/a.md', source: 'fresh content', sourceCommitHash: 'abc1234' },
          { docPath: 'docs/b.md', source: 'missing content', sourceCommitHash: 'abc1234' },
        ],
        scopeHash: 'docs-scope',
      });
      mockLoad.mockResolvedValue({
        requests: [],
        lock: null,
        enrichments: [markdownRecord()],
      });

      try {
        await sidecarStatusCommand({ json: true, strict: true });
      } catch (e: any) {
        if (e.message !== 'mockExit') throw e;
      }

      expect(mockExit).toHaveBeenCalledWith(1);
      const output = parseJsonOutput();
      expect(output.sidecar.status).toBe('partial');
      expect(output.sidecar.degradedReasons['missing-manifest-coverage']).toBe(1);
      expect(output.summary.manifest).toMatchObject({
        files: 2,
        coveredFiles: 1,
        missingFiles: 1,
      });
    });

    it('does not crash on legacy markdown records without manifest identity', async () => {
      mockIndexedRepo();
      vi.mocked(markdownCollector.collectMarkdownSidecarDocuments).mockResolvedValue({
        documents: [{ docPath: 'docs/a.md', source: 'fresh content', sourceCommitHash: 'abc1234' }],
        scopeHash: 'docs-scope',
      });
      mockLoad.mockResolvedValue({
        requests: [],
        lock: null,
        enrichments: [{ status: 'complete' }],
      });

      try {
        await sidecarStatusCommand({ json: true, strict: true });
      } catch (e: any) {
        if (e.message !== 'mockExit') throw e;
      }

      expect(mockExit).toHaveBeenCalledWith(1);
      const output = parseJsonOutput();
      expect(output.sidecar.status).toBe('partial');
      expect(output.sidecar.degradedReasons['missing-manifest-identity']).toBe(1);
      expect(output.warnings).toContain(
        'missing manifest identity on 1 markdown sidecar record(s)',
      );
    });

    it('returns queued status with request counts', async () => {
      vi.mocked(repoManager.findRepo).mockResolvedValue({
        repoPath: '/test/repo',
        meta: {
          repoPath: '/test/repo',
          indexedAt: '2026-01-01T00:00:00.000Z',
          lastCommit: 'abc1234',
        },
      } as any);

      mockLoad.mockResolvedValue({
        requests: [{ status: 'queued' }],
        lock: null,
        enrichments: [],
      });

      await sidecarStatusCommand({ json: true });

      const output = JSON.parse(mockLog.mock.calls[0][0]);
      expect(output.sidecar.status).toBe('queued');
      expect(output.summary.queued).toBe(1);
      expect(output.summary.requests.queued).toBe(1);
    });

    it('returns running status with lock metadata', async () => {
      vi.mocked(repoManager.findRepo).mockResolvedValue({
        repoPath: '/test/repo',
        meta: {
          repoPath: '/test/repo',
          indexedAt: '2026-01-01T00:00:00.000Z',
          lastCommit: 'abc1234',
        },
      } as any);

      mockLoad.mockResolvedValue({
        requests: [{ status: 'running' }],
        lock: {
          ownerId: 'runner-1',
          pid: 123,
          analyzerId: 'markdown-document-sidecar',
          sourceIndexId: '2026-01-01T00:00:00.000Z',
          startedAt: '2026-01-01T00:00:01.000Z',
          heartbeatAt: '2026-01-01T00:00:02.000Z',
          leaseExpiresAt: '2026-01-01T00:01:02.000Z',
        },
        enrichments: [],
      });

      await sidecarStatusCommand({ json: true });

      const output = JSON.parse(mockLog.mock.calls[0][0]);
      expect(output.sidecar.status).toBe('running');
      expect(output.summary.lock.ownerId).toBe('runner-1');
      expect(output.summary.running).toBe(1);
    });

    it('reports running when a lock exists even if only queued requests are stored', async () => {
      mockIndexedRepo();

      mockLoad.mockResolvedValue({
        requests: [{ status: 'queued' }],
        lock: {
          ownerId: 'runner-2',
          pid: 456,
          analyzerId: 'markdown-document-sidecar',
          sourceIndexId: '2026-01-01T00:00:00.000Z',
          startedAt: '2026-01-01T00:00:01.000Z',
          heartbeatAt: '2026-01-01T00:00:02.000Z',
          leaseExpiresAt: '2026-01-01T00:01:02.000Z',
        },
        enrichments: [],
      });

      await sidecarStatusCommand({ json: true, strict: true });

      expect(mockExit).not.toHaveBeenCalled();
      const output = parseJsonOutput();
      expect(output.sidecar.status).toBe('running');
      expect(output.summary.queued).toBe(1);
      expect(output.summary.running).toBe(1);
      expect(output.summary.lock.ownerId).toBe('runner-2');
    });

    it('returns partial status and strict exits nonzero', async () => {
      vi.mocked(repoManager.findRepo).mockResolvedValue({
        repoPath: '/test/repo',
        meta: {
          repoPath: '/test/repo',
          indexedAt: '2026-01-01T00:00:00.000Z',
          lastCommit: 'abc1234',
        },
      } as any);

      mockLoad.mockResolvedValue({
        requests: [],
        lock: null,
        enrichments: [{ status: 'partial' }],
      });

      try {
        await sidecarStatusCommand({ json: true, strict: true });
      } catch (e: any) {
        if (e.message !== 'mockExit') throw e;
      }

      expect(mockExit).toHaveBeenCalledWith(1);
      const output = JSON.parse(mockLog.mock.calls[0][0]);
      expect(output.sidecar.status).toBe('partial');
      expect(output.sidecar.degradedReasons.partial).toBe(1);
    });

    it('returns failed status and strict exits nonzero', async () => {
      vi.mocked(repoManager.findRepo).mockResolvedValue({
        repoPath: '/test/repo',
        meta: {
          repoPath: '/test/repo',
          indexedAt: '2026-01-01T00:00:00.000Z',
          lastCommit: 'abc1234',
        },
      } as any);

      mockLoad.mockResolvedValue({
        requests: [],
        lock: null,
        enrichments: [{ status: 'failed' }],
      });

      try {
        await sidecarStatusCommand({ json: true, strict: true });
      } catch (e: any) {
        if (e.message !== 'mockExit') throw e;
      }

      expect(mockExit).toHaveBeenCalledWith(1);
      const output = JSON.parse(mockLog.mock.calls[0][0]);
      expect(output.sidecar.status).toBe('failed');
      expect(output.sidecar.degradedReasons.failed).toBe(1);
    });

    it('returns failed status and strict exits nonzero when a request failed before enrichment', async () => {
      mockIndexedRepo();

      mockLoad.mockResolvedValue({
        requests: [{ status: 'failed' }],
        lock: null,
        enrichments: [],
      });

      try {
        await sidecarStatusCommand({ json: true, strict: true });
      } catch (e: any) {
        if (e.message !== 'mockExit') throw e;
      }

      expect(mockExit).toHaveBeenCalledWith(1);
      const output = parseJsonOutput();
      expect(output.sidecar.status).toBe('failed');
      expect(output.summary.failed).toBe(1);
      expect(output.sidecar.degradedReasons.failed).toBe(0);
    });
  });

  describe('sidecar run markdown', () => {
    it('executes runner and returns complete with manifest and fileHash', async () => {
      mockIndexedRepo();

      vi.mocked(markdownCollector.collectMarkdownSidecarDocuments).mockResolvedValue({
        documents: [
          { docPath: 'zeta.md', source: 'zeta content', sourceCommitHash: 'abc1234' },
          { docPath: 'alpha.md', source: 'alpha content', sourceCommitHash: 'abc1234' },
        ],
        scopeHash: 'hash123',
      });

      mockLoad.mockResolvedValue({
        requests: [],
        lock: null,
        enrichments: [
          markdownRecord({
            filePath: 'alpha.md',
            fileHash: hashText('alpha content'),
          }),
          markdownRecord({
            filePath: 'zeta.md',
            fileHash: hashText('zeta content'),
          }),
        ],
      });

      vi.mocked(sidecarRunner.runSidecarRunnerOnce)
        .mockResolvedValueOnce({
          executed: true,
          status: 'complete',
          request: {} as any,
          decision: {
            action: 'continue',
            reason: 'within-budget',
            maxCpuPercent: 10,
            maxWorkerCount: 1,
            observedCpuPercent: null,
            workerCount: null,
            logicalCpuCount: null,
            foregroundActive: false,
            errors: [],
          },
        })
        .mockResolvedValueOnce({
          executed: false,
          reason: 'idle',
          decision: {
            action: 'stop',
            reason: 'invalid-input',
            maxCpuPercent: 10,
            maxWorkerCount: 1,
            observedCpuPercent: null,
            workerCount: null,
            logicalCpuCount: null,
            foregroundActive: false,
            errors: [],
          },
        });

      await sidecarRunCommand('markdown', { json: true });

      expect(mockExit).not.toHaveBeenCalled();
      const output = parseJsonOutput();
      expect(output.sidecar.status).toBe('complete');
      expect(mockSubmitRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          analyzerId: 'markdown-document-sidecar',
          purpose: 'markdown-document-enrichment',
          scopeHash: 'hash123',
          priority: 'user-requested',
        }),
      );
      expect(output.manifest).toMatchObject({
        repoId: '/test/repo',
        repoPath: '/test/repo',
        sourceIndexId: '2026-01-01T00:00:00.000Z',
        sourceCommitHash: 'abc1234',
        graphSchemaVersion: output.repo.graphSchemaVersion,
        analyzerId: 'markdown-document-sidecar',
        analyzerVersion: '0.1.0',
      });
      expect(output.manifest.files.map((file: any) => file.docPath)).toEqual([
        'alpha.md',
        'zeta.md',
      ]);
      expect(output.manifest.files[0].fileHash).not.toBe('unknown');
    });

    it('exits with 1 when sidecar run fails', async () => {
      vi.mocked(repoManager.findRepo).mockResolvedValue({
        repoPath: '/test/repo',
        meta: {
          repoPath: '/test/repo',
          indexedAt: '2026-01-01T00:00:00.000Z',
          lastCommit: 'abc1234',
        },
      } as any);

      vi.mocked(markdownCollector.collectMarkdownSidecarDocuments).mockResolvedValue({
        documents: [{ docPath: 'test.md', source: 'test content', sourceCommitHash: 'abc1234' }],
        scopeHash: 'hash123',
      });

      mockLoad.mockResolvedValue({
        requests: [],
        lock: null,
        enrichments: [{ status: 'failed' }],
      });

      vi.mocked(sidecarRunner.runSidecarRunnerOnce)
        .mockResolvedValueOnce({
          executed: true,
          status: 'failed',
          request: {} as any,
          decision: {
            action: 'continue',
            reason: 'within-budget',
            maxCpuPercent: 10,
            maxWorkerCount: 1,
            observedCpuPercent: null,
            workerCount: null,
            logicalCpuCount: null,
            foregroundActive: false,
            errors: [],
          },
        })
        .mockResolvedValueOnce({
          executed: false,
          reason: 'idle',
          decision: {
            action: 'stop',
            reason: 'invalid-input',
            maxCpuPercent: 10,
            maxWorkerCount: 1,
            observedCpuPercent: null,
            workerCount: null,
            logicalCpuCount: null,
            foregroundActive: false,
            errors: [],
          },
        });

      try {
        await sidecarRunCommand('markdown', { json: true });
      } catch (e: any) {
        if (e.message !== 'mockExit') throw e;
      }

      expect(mockExit).toHaveBeenCalledWith(1);
      const output = JSON.parse(mockLog.mock.calls[0][0]);
      expect(output.sidecar.status).toBe('failed');
    });

    it('does not submit a duplicate request when matching markdown work is already queued', async () => {
      mockIndexedRepo();

      vi.mocked(markdownCollector.collectMarkdownSidecarDocuments).mockResolvedValue({
        documents: [{ docPath: 'test.md', source: 'test content', sourceCommitHash: 'abc1234' }],
        scopeHash: 'hash123',
      });

      const queuedState = {
        requests: [
          {
            status: 'queued',
            sourceIndexId: '2026-01-01T00:00:00.000Z',
            analyzerId: 'markdown-document-sidecar',
            purpose: 'markdown-document-enrichment',
          },
        ],
        lock: null,
        enrichments: [],
      };
      mockLoad.mockResolvedValue(queuedState);

      vi.mocked(sidecarRunner.runSidecarRunnerOnce).mockResolvedValueOnce({
        executed: false,
        reason: 'idle',
        decision: {
          action: 'stop',
          reason: 'invalid-input',
          maxCpuPercent: 10,
          maxWorkerCount: 1,
          observedCpuPercent: null,
          workerCount: null,
          logicalCpuCount: null,
          foregroundActive: false,
          errors: [],
        },
      });

      await sidecarRunCommand('markdown', { json: true });

      expect(mockSubmitRequest).not.toHaveBeenCalled();
      expect(sidecarRunner.runSidecarRunnerOnce).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sidecarRunner.runSidecarRunnerOnce).mock.calls[0][1]).toMatchObject({
        sourceIndexId: '2026-01-01T00:00:00.000Z',
        analyzerId: 'markdown-document-sidecar',
      });
      const output = parseJsonOutput();
      expect(output.sidecar.status).toBe('queued');
      expect(output.warnings).toEqual([]);
    });

    it('submits markdown work and keeps idle runner completion warning-free', async () => {
      mockIndexedRepo();

      vi.mocked(markdownCollector.collectMarkdownSidecarDocuments).mockResolvedValue({
        documents: [],
        scopeHash: 'empty-scope',
      });

      mockLoad
        .mockResolvedValueOnce({ requests: [], lock: null, enrichments: [] })
        .mockResolvedValueOnce({ requests: [{ status: 'queued' }], lock: null, enrichments: [] });

      vi.mocked(sidecarRunner.runSidecarRunnerOnce).mockResolvedValueOnce({
        executed: false,
        reason: 'idle',
        decision: {
          action: 'stop',
          reason: 'invalid-input',
          maxCpuPercent: 10,
          maxWorkerCount: 1,
          observedCpuPercent: null,
          workerCount: null,
          logicalCpuCount: null,
          foregroundActive: false,
          errors: [],
        },
      });

      await sidecarRunCommand('markdown', { json: true });

      expect(mockSubmitRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          repoId: '/test/repo',
          sourceIndexId: '2026-01-01T00:00:00.000Z',
          analyzerId: 'markdown-document-sidecar',
          analyzerVersion: '0.1.0',
          purpose: 'markdown-document-enrichment',
          scopeHash: 'empty-scope',
          priority: 'user-requested',
        }),
      );
      expect(sidecarRunner.runSidecarRunnerOnce).toHaveBeenCalledTimes(1);
      const output = parseJsonOutput();
      expect(output.sidecar.status).toBe('queued');
      expect(output.warnings).toEqual([]);
      expect(output.manifest.files).toEqual([]);
    });
  });

  describe('knowledge', () => {
    it('returns a missing-sidecar knowledge report when repo is not indexed', async () => {
      vi.mocked(repoManager.findRepo).mockResolvedValue(null);

      await knowledgeCommand({ json: true, repo: '/missing/repo' });

      expect(mockExit).not.toHaveBeenCalled();
      const output = parseJsonOutput();
      expect(output.summary.report).toBe('knowledge');
      expect(output.sidecar.status).toBe('missing');
      expect(output.items).toEqual([]);
      expect(output.warnings).toContain('knowledge report degraded by sidecar status missing');
      expect(output.summary.knowledge.suggestedNextChecks).toContain(
        'generate markdown sidecar facts before interpreting concept coverage',
      );
    });

    it('prints compact advisory concept lines from Markdown sidecar facts', async () => {
      mockIndexedRepo();
      const chunkFact = markdownChunkFact('chunk-profile', ['MCP Startup Profile']);
      const entityFact = markdownEntityFact(
        'entity-profile',
        chunkFact.chunkKey,
        'MCP Startup Profile',
      );
      const mentionFact = markdownCodeMentionFact(chunkFact.chunkKey, 'startMcpServer');
      mockLoad.mockResolvedValue({
        requests: [],
        lock: null,
        enrichments: [
          markdownRecord({
            records: [
              chunkFact,
              entityFact,
              mentionFact,
              markdownResolutionRecord(mentionFact, codeMentionFactKey(mentionFact)),
            ],
          }),
        ],
      });

      await knowledgeCommand({ maxItems: '5', maxCandidatesPerFact: '1' });

      expect(mockExit).not.toHaveBeenCalled();
      const lines = mockLog.mock.calls.map((call) => call[0]);
      expect(lines).toContain('Status: complete');
      expect(lines).toContain('Diagnostic sidecar status: complete');
      expect(lines).toContain('Concepts: 1/1 (advisory, facts: 3)');
      expect(lines).toContain(
        'Flags: stale=0, disconnected=0, overloaded=0, orphanAdrLike=0, hub=0',
      );
      expect(lines).toContainEqual(
        expect.stringContaining('MCP Startup Profile: fresh/high/docs_evidence flags=none docs=1'),
      );
      expect(lines).toContainEqual(
        expect.stringContaining(
          'rationale: docs/adr/0029-native-knowledge-graph-document-sidecar.md:1-3 MCP Startup Profile',
        ),
      );
    });
  });
});

function markdownChunkFact(chunkKey: string, headingPath: string[]) {
  return {
    kind: 'markdown-chunk',
    docPath: 'docs/adr/0029-native-knowledge-graph-document-sidecar.md',
    fileHash: 'hash:docs',
    sourceCommitHash: 'abc1234',
    headingPath,
    lineSpan: { start: 1, end: 3 },
    chunkIndex: 0,
    normalizedAnchor: headingPath.at(-1)?.toLowerCase().replace(/\s+/g, '-') ?? '',
    contentHash: `hash:${chunkKey}`,
    chunkKey,
    excerpt: headingPath.at(-1),
  } as any;
}

function markdownEntityFact(entityKey: string, sourceChunkKey: string, label: string) {
  return {
    kind: 'markdown-entity',
    entityKey,
    label,
    normalizedLabel: label.toLowerCase().replace(/\s+/g, '-'),
    entityType: 'concept',
    sourceChunkKey,
    evidence: { text: label, lineSpan: { start: 2, end: 2 } },
  } as any;
}

function markdownCodeMentionFact(chunkKey: string, text: string) {
  return {
    kind: 'markdown-code-mention',
    chunkKey,
    target: {
      type: 'symbol',
      id: `Function:${text}`,
      filePath: 'src/mcp/server.ts',
    },
    confidence: 0.8,
    resolutionStatus: 'resolved',
    evidence: { text, lineSpan: { start: 2, end: 2 } },
  } as any;
}

function markdownResolutionRecord(fact: any, factKey: string) {
  return {
    kind: 'markdown-doc-resolution',
    schemaVersion: 1,
    resolverId: 'ontoindex.markdown-doc-resolver',
    resolverVersion: '1.0.0',
    sourceIndexId: '2026-01-01T00:00:00.000Z',
    sourceCommitHash: 'abc1234',
    graphSchemaVersion: 7,
    docPath: 'docs/adr/0029-native-knowledge-graph-document-sidecar.md',
    factKey,
    factKind: fact.kind,
    subjectKind: 'code-mention',
    resolutionKey: 'resolution:symbol:start',
    status: 'resolved',
    confidence: 0.95,
    evidenceKind: 'graph-structural',
    reasons: ['single-candidate'],
    targetGraphIdentity: {
      type: 'symbol',
      id: 'Function:startMcpServer',
      name: 'startMcpServer',
      filePath: 'src/mcp/server.ts',
      confidence: 0.95,
    },
    candidates: [],
    lineSpan: fact.evidence.lineSpan,
  } as any;
}

function codeMentionFactKey(fact: any): string {
  return [
    'markdown-code-mention',
    fact.chunkKey,
    fact.evidence.lineSpan.start,
    fact.evidence.lineSpan.end,
    fact.evidence.text,
  ].join(':');
}
