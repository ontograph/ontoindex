import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { PipelineOptions } from '../../src/core/ingestion/pipeline.js';

const { embeddingPipelineMocks } = vi.hoisted(() => ({
  embeddingPipelineMocks: {
    runEmbeddingPipeline: vi.fn().mockResolvedValue(undefined),
    batchInsertEmbeddings: vi.fn().mockResolvedValue(undefined),
    EMBEDDING_TEXT_VERSION: 'v2',
  },
}));

const { execFileTextMock } = vi.hoisted(() => ({
  execFileTextMock: vi.fn().mockResolvedValue(''),
}));

const { repoManagerGenerationMockState } = vi.hoisted(() => ({
  repoManagerGenerationMockState: {
    canonicalGenerationId: null as string | null,
  },
}));

const { managedAnalysisCoordinatorMocks } = vi.hoisted(() => ({
  managedAnalysisCoordinatorMocks: {
    claimManagedAnalysisAnalyzer: vi.fn().mockResolvedValue({}),
    beginManagedAnalysisPublication: vi.fn().mockResolvedValue({}),
    commitManagedAnalysisPublication: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../src/core/ingestion/pipeline.js', () => ({
  runPipelineFromRepo: vi.fn(),
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  initLbug: vi.fn().mockResolvedValue(undefined),
  loadGraphToLbug: vi.fn().mockResolvedValue(undefined),
  getLbugStats: vi.fn().mockResolvedValue({ nodes: 3, edges: 2 }),
  executeQuery: vi.fn().mockResolvedValue([]),
  executeWithReusedStatement: vi.fn(),
  createFTSIndex: vi.fn().mockResolvedValue(undefined),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  fetchExistingEmbeddingHashes: vi
    .fn()
    .mockResolvedValue(new Map<string, { contentHash: string }>()),
  loadCachedEmbeddings: vi.fn().mockResolvedValue({
    embeddingNodeIds: new Set(),
    embeddings: [],
  }),
}));

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    createIndexGeneration: vi.fn(async (...args: unknown[]) => {
      const stagedGeneration = await (actual as any).createIndexGeneration(...args);
      return repoManagerGenerationMockState.canonicalGenerationId
        ? {
            ...stagedGeneration,
            generationId: repoManagerGenerationMockState.canonicalGenerationId,
          }
        : stagedGeneration;
    }),
    loadMeta: vi.fn().mockResolvedValue(null),
    saveMeta: vi.fn().mockResolvedValue(undefined),
    registerRepo: vi.fn().mockResolvedValue('snapshot-test'),
    addToGitignore: vi.fn().mockResolvedValue(undefined),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  };
});

vi.mock('../../src/storage/git.js', () => ({
  getCurrentCommit: vi.fn().mockReturnValue('abc123'),
  hasGitDir: vi.fn().mockReturnValue(true),
  getInferredRepoName: vi.fn().mockReturnValue('snapshot-test'),
}));

vi.mock('../../src/cli/ai-context.js', () => ({
  generateAIContextFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/search/bm25-index.js', () => ({
  FTS_INDEXES: [
    { table: 'File', indexName: 'file_fts', properties: ['name', 'content'] },
    { table: 'Function', indexName: 'function_fts', properties: ['name', 'content'] },
  ],
}));

vi.mock('../../src/core/embeddings/embedding-pipeline.js', () => embeddingPipelineMocks);

vi.mock('../../src/core/process/exec-file.js', () => ({
  execFileText: execFileTextMock,
}));

vi.mock('../../src/core/analysis/analysis-coordinator.js', () => managedAnalysisCoordinatorMocks);

import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import {
  createFTSIndex,
  executeQuery,
  executeWithReusedStatement,
  getLbugStats,
  loadGraphToLbug,
} from '../../src/core/lbug/lbug-adapter.js';
import { fetchExistingEmbeddingHashes } from '../../src/core/lbug/lbug-adapter.js';
import {
  loadSidecarStoreState,
  MARKDOWN_DOCUMENT_ANALYZER_ID,
} from '../../src/core/ingestion/enrichment/index.js';
import { addToGitignore, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import { getCurrentCommit } from '../../src/storage/git.js';
import {
  readAnalysisPublicationReceipt,
  type ManagedAnalysisContext,
} from '../../src/core/analysis/analysis-publication-receipt.js';
import {
  computeSourceManifest,
  sourceManifestDigest,
} from '../../src/core/indexing/source-manifest.js';
import {
  beginManagedAnalysisPublication,
  claimManagedAnalysisAnalyzer,
  commitManagedAnalysisPublication,
} from '../../src/core/analysis/analysis-coordinator.js';

const runPipelineMock = runPipelineFromRepo as unknown as ReturnType<typeof vi.fn>;
const createFTSIndexMock = createFTSIndex as unknown as ReturnType<typeof vi.fn>;
const executeQueryMock = executeQuery as unknown as ReturnType<typeof vi.fn>;
const executeWithReusedStatementMock = executeWithReusedStatement as unknown as ReturnType<
  typeof vi.fn
>;
const getLbugStatsMock = getLbugStats as unknown as ReturnType<typeof vi.fn>;
const loadGraphToLbugMock = loadGraphToLbug as unknown as ReturnType<typeof vi.fn>;
const fetchExistingEmbeddingHashesMock = fetchExistingEmbeddingHashes as unknown as ReturnType<
  typeof vi.fn
>;
const loadMetaMock = loadMeta as unknown as ReturnType<typeof vi.fn>;
const saveMetaMock = saveMeta as unknown as ReturnType<typeof vi.fn>;
const getCurrentCommitMock = getCurrentCommit as unknown as ReturnType<typeof vi.fn>;
const addToGitignoreMock = addToGitignore as unknown as ReturnType<typeof vi.fn>;
const claimManagedAnalysisAnalyzerMock = claimManagedAnalysisAnalyzer as unknown as ReturnType<
  typeof vi.fn
>;
const beginManagedAnalysisPublicationMock =
  beginManagedAnalysisPublication as unknown as ReturnType<typeof vi.fn>;
const commitManagedAnalysisPublicationMock =
  commitManagedAnalysisPublication as unknown as ReturnType<typeof vi.fn>;

const MANAGED_TARGET_HEAD = 'a'.repeat(40);
const MANAGED_OPTIONS_DIGEST = 'b'.repeat(64);
const MANAGED_SOURCE_IDENTITY = `commit:${MANAGED_TARGET_HEAD}`;

async function managedAnalysisContext(
  repoDir: string,
  jobId: string,
  embeddings = false,
): Promise<ManagedAnalysisContext> {
  const manifest = await computeSourceManifest(repoDir, {
    includePaths: [],
    pipelineProfile: 'full',
  });
  return {
    jobId,
    targetHead: MANAGED_TARGET_HEAD,
    optionsDigest: MANAGED_OPTIONS_DIGEST,
    sourceIdentity: MANAGED_SOURCE_IDENTITY,
    sourceManifestDigest: sourceManifestDigest(manifest),
    requestedCapabilities: {
      version: 1,
      graph: true,
      graphCapabilities: ['symbols'],
      embeddings,
      embeddingModelHash: embeddings ? 'managed-test-model' : null,
    },
  };
}

describe('runFullAnalysis snapshot persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoManagerGenerationMockState.canonicalGenerationId = null;
    embeddingPipelineMocks.runEmbeddingPipeline.mockResolvedValue(undefined);
    embeddingPipelineMocks.batchInsertEmbeddings.mockResolvedValue(undefined);
    loadMetaMock.mockResolvedValue(null);
    getLbugStatsMock.mockResolvedValue({ nodes: 3, edges: 2 });
    getCurrentCommitMock.mockReturnValue('abc123');
    execFileTextMock.mockResolvedValue('');
    claimManagedAnalysisAnalyzerMock.mockResolvedValue({});
    beginManagedAnalysisPublicationMock.mockResolvedValue({});
    commitManagedAnalysisPublicationMock.mockResolvedValue({});
  });

  it('requires force=true for managed analysis', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-managed-'));
    try {
      getCurrentCommitMock.mockReturnValue(MANAGED_TARGET_HEAD);

      await expect(
        runFullAnalysis(
          repoDir,
          {
            managedAnalysis: await managedAnalysisContext(repoDir, 'managed-job-force'),
          },
          { onProgress: vi.fn() },
        ),
      ).rejects.toThrow('Managed analysis requires force=true.');
      expect(runPipelineMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses managed publication when the current HEAD differs from the target', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-managed-'));
    try {
      getCurrentCommitMock.mockReturnValue('c'.repeat(40));

      await expect(
        runFullAnalysis(
          repoDir,
          {
            force: true,
            managedAnalysis: await managedAnalysisContext(repoDir, 'managed-job-head'),
          },
          { onProgress: vi.fn() },
        ),
      ).rejects.toThrow(
        'Managed analysis target HEAD does not match the current repository HEAD before analysis.',
      );
      expect(runPipelineMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses a dirty managed worktree before analysis starts', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-managed-'));
    try {
      getCurrentCommitMock.mockReturnValue(MANAGED_TARGET_HEAD);
      execFileTextMock.mockResolvedValueOnce(' M source.ts\n');

      await expect(
        runFullAnalysis(
          repoDir,
          {
            force: true,
            managedAnalysis: await managedAnalysisContext(repoDir, 'managed-job-dirty-input'),
          },
          { onProgress: vi.fn() },
        ),
      ).rejects.toThrow('Managed analysis requires a clean Git worktree before analysis.');
      expect(runPipelineMock).not.toHaveBeenCalled();
      expect(addToGitignoreMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses managed publication when the worktree becomes dirty during analysis', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-managed-'));
    try {
      getCurrentCommitMock.mockReturnValue(MANAGED_TARGET_HEAD);
      execFileTextMock.mockResolvedValueOnce('').mockResolvedValueOnce('?? generated-source.ts\n');
      runPipelineMock.mockResolvedValue({
        graph: createKnowledgeGraph(),
        repoPath: repoDir,
        totalFileCount: 0,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await expect(
        runFullAnalysis(
          repoDir,
          {
            force: true,
            managedAnalysis: await managedAnalysisContext(repoDir, 'managed-job-dirty-publication'),
          },
          { onProgress: vi.fn() },
        ),
      ).rejects.toThrow('Managed analysis requires a clean Git worktree before publication.');
      expect(runPipelineMock).toHaveBeenCalledTimes(1);
      expect(execFileTextMock).toHaveBeenCalledTimes(2);
      await expect(
        readAnalysisPublicationReceipt(
          path.join(repoDir, '.ontoindex', 'current'),
          'managed-job-dirty-publication',
        ),
      ).resolves.toBeNull();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses managed publication when HEAD changes during analysis', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-managed-'));
    try {
      getCurrentCommitMock
        .mockReturnValueOnce(MANAGED_TARGET_HEAD)
        .mockReturnValueOnce(MANAGED_TARGET_HEAD)
        .mockReturnValueOnce(MANAGED_TARGET_HEAD)
        .mockReturnValueOnce('c'.repeat(40));
      runPipelineMock.mockResolvedValue({
        graph: createKnowledgeGraph(),
        repoPath: repoDir,
        totalFileCount: 0,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await expect(
        runFullAnalysis(
          repoDir,
          {
            force: true,
            managedAnalysis: await managedAnalysisContext(repoDir, 'managed-job-head-publication'),
          },
          { onProgress: vi.fn() },
        ),
      ).rejects.toThrow(
        'Managed analysis target HEAD does not match the current repository HEAD before publication.',
      );
      expect(runPipelineMock).toHaveBeenCalledTimes(1);
      expect(execFileTextMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('requires an enabled embedding path when managed analysis requests embeddings', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-managed-'));
    try {
      getCurrentCommitMock.mockReturnValue(MANAGED_TARGET_HEAD);

      await expect(
        runFullAnalysis(
          repoDir,
          {
            force: true,
            managedAnalysis: await managedAnalysisContext(
              repoDir,
              'managed-job-embeddings-disabled',
              true,
            ),
          },
          { onProgress: vi.fn() },
        ),
      ).rejects.toThrow(
        'Managed analysis requested embeddings, but no embedding analysis option was enabled.',
      );
      expect(runPipelineMock).not.toHaveBeenCalled();
      expect(execFileTextMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses managed publication when required embeddings are absent', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-managed-'));
    try {
      getCurrentCommitMock.mockReturnValue(MANAGED_TARGET_HEAD);
      runPipelineMock.mockResolvedValue({
        graph: createKnowledgeGraph(),
        repoPath: repoDir,
        totalFileCount: 0,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await expect(
        runFullAnalysis(
          repoDir,
          {
            force: true,
            embeddings: true,
            managedAnalysis: await managedAnalysisContext(
              repoDir,
              'managed-job-embeddings-absent',
              true,
            ),
          },
          { onProgress: vi.fn() },
        ),
      ).rejects.toThrow(
        'Managed analysis requested embeddings, but no embeddings were successfully published.',
      );
      expect(embeddingPipelineMocks.runEmbeddingPipeline).toHaveBeenCalledTimes(1);
      expect(execFileTextMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('publishes a managed receipt through the active generation', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-managed-'));
    try {
      getCurrentCommitMock.mockReturnValue(MANAGED_TARGET_HEAD);
      runPipelineMock.mockResolvedValue({
        graph: createKnowledgeGraph(),
        repoPath: repoDir,
        totalFileCount: 0,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);
      repoManagerGenerationMockState.canonicalGenerationId = 'canonical-staged-generation';

      await runFullAnalysis(
        repoDir,
        {
          force: true,
          managedAnalysis: await managedAnalysisContext(repoDir, 'managed-job-published'),
        },
        { onProgress: vi.fn() },
      );

      const receipt = await readAnalysisPublicationReceipt(
        path.join(repoDir, '.ontoindex', 'current'),
        'managed-job-published',
      );
      expect(receipt).toMatchObject({
        version: 1,
        jobId: 'managed-job-published',
        repoPath: repoDir,
        targetHead: MANAGED_TARGET_HEAD,
        optionsDigest: MANAGED_OPTIONS_DIGEST,
        sourceIdentity: MANAGED_SOURCE_IDENTITY,
        requestedCapabilities: {
          version: 1,
          graph: true,
          graphCapabilities: ['symbols'],
          embeddings: false,
          embeddingModelHash: null,
        },
        analyzerContractVersion: 'ontoindex-source-manifest-v1',
      });
      expect(receipt?.generationId).toBe('canonical-staged-generation');
      await expect(fs.readlink(path.join(repoDir, '.ontoindex', 'current'))).resolves.toBe(
        path.join('generations', 'canonical-staged-generation'),
      );
      expect(receipt?.sourceManifestDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isFinite(Date.parse(receipt?.publishedAt ?? ''))).toBe(true);
      expect(claimManagedAnalysisAnalyzerMock).toHaveBeenCalledWith(
        repoDir,
        expect.objectContaining({ jobId: 'managed-job-published' }),
      );
      expect(beginManagedAnalysisPublicationMock).toHaveBeenCalledWith(
        repoDir,
        expect.objectContaining({ jobId: 'managed-job-published' }),
      );
      expect(commitManagedAnalysisPublicationMock).toHaveBeenCalledWith(
        repoDir,
        expect.objectContaining({ jobId: 'managed-job-published' }),
        'canonical-staged-generation',
        expect.stringMatching(/^[0-9a-f]{64}$/),
      );
      expect(execFileTextMock).toHaveBeenCalledTimes(2);
      expect(execFileTextMock).toHaveBeenCalledWith(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        expect.objectContaining({ cwd: repoDir }),
      );
      expect(addToGitignoreMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('does not publish or activate when managed publication ownership is fenced', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-managed-'));
    try {
      getCurrentCommitMock.mockReturnValue(MANAGED_TARGET_HEAD);
      runPipelineMock.mockResolvedValue({
        graph: createKnowledgeGraph(),
        repoPath: repoDir,
        totalFileCount: 0,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);
      beginManagedAnalysisPublicationMock.mockRejectedValueOnce(
        new Error('Managed analysis attempt was fenced.'),
      );

      await expect(
        runFullAnalysis(
          repoDir,
          {
            force: true,
            managedAnalysis: await managedAnalysisContext(repoDir, 'managed-job-fenced'),
          },
          { onProgress: vi.fn() },
        ),
      ).rejects.toThrow('Managed analysis attempt was fenced.');
      expect(commitManagedAnalysisPublicationMock).not.toHaveBeenCalled();

      await expect(
        readAnalysisPublicationReceipt(
          path.join(repoDir, '.ontoindex', 'current'),
          'managed-job-fenced',
        ),
      ).resolves.toBeNull();
      await expect(fs.lstat(path.join(repoDir, '.ontoindex', 'current'))).rejects.toThrow();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('rolls back activation when managed publication commit is fenced', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-managed-'));
    try {
      getCurrentCommitMock.mockReturnValue(MANAGED_TARGET_HEAD);
      runPipelineMock.mockResolvedValue({
        graph: createKnowledgeGraph(),
        repoPath: repoDir,
        totalFileCount: 0,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);
      repoManagerGenerationMockState.canonicalGenerationId = 'failed-publication-generation';
      commitManagedAnalysisPublicationMock.mockRejectedValueOnce(
        new Error('Managed analysis publication commit was fenced.'),
      );

      await expect(
        runFullAnalysis(
          repoDir,
          {
            force: true,
            managedAnalysis: await managedAnalysisContext(repoDir, 'managed-job-commit-fenced'),
          },
          { onProgress: vi.fn() },
        ),
      ).rejects.toThrow('Managed analysis publication commit was fenced.');

      await expect(fs.lstat(path.join(repoDir, '.ontoindex', 'current'))).rejects.toThrow();
      await expect(fs.lstat(path.join(repoDir, '.ontoindex', 'lbug'))).rejects.toThrow();
      await expect(
        fs.lstat(path.join(repoDir, '.ontoindex', 'generations', 'failed-publication-generation')),
      ).resolves.toBeDefined();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('writes snapshot.json for graph_diff after a successful analyze', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'func:login',
        label: 'Function',
        properties: { name: 'login', filePath: 'src/auth.ts' } as any,
      });
      graph.addNode({
        id: 'func:validate',
        label: 'Function',
        properties: { name: 'validate', filePath: 'src/auth.ts' } as any,
      });
      graph.addNode({
        id: 'file:auth',
        label: 'File',
        properties: { name: 'auth.ts', filePath: 'src/auth.ts' } as any,
      });
      graph.addRelationship({
        id: 'rel:login-validate',
        sourceId: 'func:login',
        targetId: 'func:validate',
        type: 'CALLS',
        confidence: 1,
        reason: 'direct',
      });
      graph.addRelationship({
        id: 'rel:file-login',
        sourceId: 'file:auth',
        targetId: 'func:login',
        type: 'CONTAINS',
        confidence: 1,
        reason: 'contains',
      });

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 1,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockImplementation(async (query: string) => {
        if (query.includes(`MATCH (a)-[r:CodeRelation]->(b)`)) {
          return [
            {
              sourceId: 'func:login',
              targetId: 'func:validate',
            },
          ];
        }
        if (query.includes(`MATCH (n)`)) {
          return [
            { id: 'file:auth', filePath: 'src/auth.ts' },
            { id: 'func:login', filePath: 'src/auth.ts' },
            { id: 'func:validate', filePath: 'src/auth.ts' },
          ];
        }
        if (query.includes(`MATCH (e:${'Embeddings'})`)) {
          return [];
        }
        return [];
      });

      const result = await runFullAnalysis(repoDir, {}, { onProgress: vi.fn() });
      expect(result.repoPath).toBe(repoDir);

      const snapshotRaw = await fs.readFile(
        path.join(repoDir, '.ontoindex', 'snapshot.json'),
        'utf8',
      );
      const snapshot = JSON.parse(snapshotRaw);
      expect(snapshot.lastCommit).toBe('abc123');
      expect(typeof snapshot.savedAt).toBe('string');
      expect(snapshot.calleesMap).toEqual({
        'func:login': ['func:validate'],
      });
      expect(snapshot.fileToSymbols['src/auth.ts']).toEqual([
        'file:auth',
        'func:login',
        'func:validate',
      ]);
      expect(createFTSIndexMock).toHaveBeenCalledTimes(2);
      expect(createFTSIndexMock).toHaveBeenNthCalledWith(1, 'File', 'file_fts', [
        'name',
        'content',
      ]);
      expect(createFTSIndexMock).toHaveBeenNthCalledWith(2, 'Function', 'function_fts', [
        'name',
        'content',
      ]);
      await expect(
        fs.stat(path.join(repoDir, '.ontoindex', 'analysis-checkpoint.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('passes the symbols profile through and records symbols-only metadata', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'func:lookup',
        label: 'Function',
        properties: { name: 'lookup', filePath: 'src/lookup.ts' } as any,
      });

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 1,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, { profile: 'symbols' }, { onProgress: vi.fn() });

      expect(runPipelineMock).toHaveBeenCalledWith(
        repoDir,
        expect.any(Function),
        expect.objectContaining({
          profile: 'symbols',
          onTelemetry: expect.any(Function),
        }),
      );
      expect(saveMetaMock).toHaveBeenCalledWith(
        expect.stringContaining(path.join(repoDir, '.ontoindex', 'generations', '.staging-')),
        expect.objectContaining({
          indexMode: 'symbols-only',
          pipelineProfile: 'symbols',
          skippedPhases: expect.arrayContaining(['cross-file', 'communities', 'processes']),
          capabilities: {
            symbols: true,
            impact: 'degraded',
            processes: false,
          },
        }),
      );
      await expect(
        fs.stat(path.join(repoDir, '.ontoindex', 'analysis-checkpoint.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('collects internal degradation telemetry without writing a normal-run checkpoint', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 0,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, {}, { onProgress: vi.fn() });

      expect(runPipelineMock).toHaveBeenCalledWith(
        repoDir,
        expect.any(Function),
        expect.objectContaining({ onTelemetry: expect.any(Function) }),
      );
      await expect(
        fs.stat(path.join(repoDir, '.ontoindex', 'analysis-checkpoint.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('passes embedding checkpoint options and incremental hash source to pipeline', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      loadMetaMock.mockResolvedValue({
        lastCommit: 'previous-commit',
        model_hash: '',
      });
      runPipelineMock.mockResolvedValue({
        graph: createKnowledgeGraph(),
        repoPath: repoDir,
        totalFileCount: 0,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockImplementation(async () => []);

      await runFullAnalysis(
        repoDir,
        {
          embeddings: true,
        },
        { onProgress: vi.fn() },
      );

      expect(fetchExistingEmbeddingHashesMock).toHaveBeenCalledTimes(1);
      expect(embeddingPipelineMocks.runEmbeddingPipeline).toHaveBeenCalledTimes(1);

      const embeddingCall = embeddingPipelineMocks.runEmbeddingPipeline.mock.calls.at(-1);
      expect(embeddingCall?.[6]).toBeInstanceOf(Map);
      expect(embeddingCall?.[9]).toEqual({
        path: expect.stringContaining(path.join(repoDir, '.ontoindex', 'generations', '.staging-')),
        embeddingTextVersion: 'v2',
        modelHash: '',
        headCommit: 'abc123',
      });
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('passes normalized include paths through and records scoped metadata', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      await fs.mkdir(path.join(repoDir, 'sc'), { recursive: true });
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'func:lookup',
        label: 'Function',
        properties: { name: 'lookup', filePath: 'sc/source.cxx' } as any,
      });

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 1,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, { includePaths: ['sc'] }, { onProgress: vi.fn() });

      expect(runPipelineMock).toHaveBeenCalledWith(
        repoDir,
        expect.any(Function),
        expect.objectContaining({
          includePaths: ['sc/'],
        }),
      );
      expect(saveMetaMock).toHaveBeenCalledWith(
        expect.stringContaining(path.join(repoDir, '.ontoindex', 'generations', '.staging-')),
        expect.objectContaining({
          includePaths: ['sc/'],
        }),
      );
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('does not reuse an up-to-date index when include scope changes', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      await fs.mkdir(path.join(repoDir, 'sc'), { recursive: true });
      loadMetaMock.mockResolvedValue({
        repoPath: repoDir,
        lastCommit: 'abc123',
        indexedAt: new Date().toISOString(),
        includePaths: ['svl/'],
        stats: { files: 1 },
      });
      const graph = createKnowledgeGraph();
      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 0,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      const result = await runFullAnalysis(
        repoDir,
        { includePaths: ['sc'] },
        { onProgress: vi.fn() },
      );

      expect(result.alreadyUpToDate).toBeUndefined();
      expect(runPipelineMock).toHaveBeenCalled();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('does not reuse an up-to-date index when the requested pipeline profile changes', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      loadMetaMock.mockResolvedValue({
        repoPath: repoDir,
        lastCommit: 'abc123',
        indexedAt: new Date().toISOString(),
        pipelineProfile: 'full',
        stats: { files: 1 },
      });
      const graph = createKnowledgeGraph();
      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 0,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      const result = await runFullAnalysis(
        repoDir,
        { profile: 'symbols' },
        { onProgress: vi.fn() },
      );

      expect(result.alreadyUpToDate).toBeUndefined();
      expect(runPipelineMock).toHaveBeenCalledWith(
        repoDir,
        expect.any(Function),
        expect.objectContaining({ profile: 'symbols' }),
      );
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('records degraded file telemetry and grouped aggregates in metadata', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      runPipelineMock.mockImplementation(
        async (_repoPath: string, _onProgress: unknown, options?: PipelineOptions) => {
          options?.onTelemetry?.({
            event: 'scan-degraded-files',
            phaseName: 'scan',
            elapsedMs: 10,
            rssBytes: 0,
            heapUsedBytes: 0,
            heapTotalBytes: 0,
            heapLimitBytes: 0,
            graphNodes: 0,
            graphRelationships: 0,
            degradedReason: 'scan-file-size-cap',
            degradedFiles: [
              {
                filePath: 'sc/huge.bin',
                reason: 'file exceeds scan file-size cap',
              },
              {
                filePath: 'sc/huge2.bin',
                reason: 'file exceeds scan file-size cap',
              },
              {
                filePath: 'sc/huge.py',
                reason: 'file exceeds scan file-size cap',
              },
            ],
          });
          return {
            graph,
            repoPath: repoDir,
            totalFileCount: 0,
            communityResult: undefined,
            processResult: undefined,
            usedWorkerPool: false,
          };
        },
      );
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, { profile: 'symbols' }, { onProgress: vi.fn() });

      expect(saveMetaMock).toHaveBeenCalledWith(
        expect.stringContaining(path.join(repoDir, '.ontoindex', 'generations', '.staging-')),
        expect.objectContaining({
          degradedFiles: [
            {
              filePath: 'sc/huge.bin',
              reason: 'file exceeds scan file-size cap',
              phase: 'scan',
              language: 'unknown',
            },
            {
              filePath: 'sc/huge2.bin',
              reason: 'file exceeds scan file-size cap',
              phase: 'scan',
              language: 'unknown',
            },
            {
              filePath: 'sc/huge.py',
              reason: 'file exceeds scan file-size cap',
              phase: 'scan',
              language: 'python',
            },
          ],
          degradedFileAggregates: {
            sampledDegradedCount: 3,
            groups: [
              {
                cause: 'file exceeds scan file-size cap',
                phase: 'scan',
                language: 'unknown',
                count: 2,
              },
              {
                cause: 'file exceeds scan file-size cap',
                phase: 'scan',
                language: 'python',
                count: 1,
              },
            ],
            omittedGroupCount: 0,
          },
        }),
      );
      // No duplicate nested sample list: the top-level degradedFiles carries it.
      const savedMeta = saveMetaMock.mock.calls[0][1] as {
        degradedFileAggregates: { sampleFiles?: unknown };
      };
      expect(savedMeta.degradedFileAggregates.sampleFiles).toBeUndefined();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('persists bounded relationship distributions that sum to the total', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'func:a',
        label: 'Function',
        properties: { name: 'a', filePath: 'src/a.ts' } as any,
      });
      graph.addNode({
        id: 'func:b',
        label: 'Function',
        properties: { name: 'b', filePath: 'src/a.ts' } as any,
      });
      graph.addNode({
        id: 'file:a',
        label: 'File',
        properties: { name: 'a.ts', filePath: 'src/a.ts' } as any,
      });
      graph.addRelationship({
        id: 'rel:call-strong',
        sourceId: 'func:a',
        targetId: 'func:b',
        type: 'CALLS',
        confidence: 0.9,
        reason: 'direct',
      });
      graph.addRelationship({
        id: 'rel:call-weak',
        sourceId: 'func:b',
        targetId: 'func:a',
        type: 'CALLS',
        confidence: 0.6,
        reason: 'weak',
      });
      graph.addRelationship({
        id: 'rel:contains',
        sourceId: 'file:a',
        targetId: 'func:a',
        type: 'CONTAINS',
        confidence: 0.4,
        reason: 'contains',
      });

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 1,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, {}, { onProgress: vi.fn() });

      const savedMeta = saveMetaMock.mock.calls[0][1] as {
        relationshipDistributions: {
          totalRelationships: number;
          byType: Array<{ type: string; count: number }>;
          byProvenance: { extracted: number; inferred: number; ambiguous: number };
        };
      };
      const dist = savedMeta.relationshipDistributions;
      expect(dist.totalRelationships).toBe(3);
      expect(dist.byType).toEqual([
        { type: 'CALLS', count: 2 },
        { type: 'CONTAINS', count: 1 },
      ]);
      expect(dist.byProvenance).toEqual({ extracted: 1, inferred: 1, ambiguous: 1 });

      const typeSum = dist.byType.reduce((sum, entry) => sum + entry.count, 0);
      const bandSum =
        dist.byProvenance.extracted + dist.byProvenance.inferred + dist.byProvenance.ambiguous;
      expect(typeSum).toBe(dist.totalRelationships);
      expect(bandSum).toBe(dist.totalRelationships);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('writes empty relationship distributions for a graph with no relationships', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'file:a',
        label: 'File',
        properties: { name: 'a.ts', filePath: 'src/a.ts' } as any,
      });

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 1,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, {}, { onProgress: vi.fn() });

      const savedMeta = saveMetaMock.mock.calls[0][1] as {
        relationshipDistributions: unknown;
      };
      expect(savedMeta.relationshipDistributions).toEqual({
        totalRelationships: 0,
        byType: [],
        byProvenance: { extracted: 0, inferred: 0, ambiguous: 0 },
      });
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('reads legacy meta without relationshipDistributions and writes the new field', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      // Legacy meta: an index built before this field existed. A different
      // commit forces a rebuild so the existing meta is consumed as a reader,
      // proving legacy readers/inputs tolerate the absent aggregate field.
      loadMetaMock.mockResolvedValue({
        repoPath: repoDir,
        lastCommit: 'legacy-commit',
        indexedAt: new Date().toISOString(),
        stats: { files: 1, nodes: 1, edges: 0 },
      });
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'func:a',
        label: 'Function',
        properties: { name: 'a', filePath: 'src/a.ts' } as any,
      });
      graph.addNode({
        id: 'func:b',
        label: 'Function',
        properties: { name: 'b', filePath: 'src/a.ts' } as any,
      });
      graph.addRelationship({
        id: 'rel:a-b',
        sourceId: 'func:a',
        targetId: 'func:b',
        type: 'CALLS',
        confidence: 0.9,
        reason: 'direct',
      });

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 1,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, {}, { onProgress: vi.fn() });

      const savedMeta = saveMetaMock.mock.calls[0][1] as {
        relationshipDistributions: { totalRelationships: number };
      };
      expect(savedMeta.relationshipDistributions.totalRelationships).toBe(1);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('normalizes variable-size reasons into a single stable cause group', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      runPipelineMock.mockImplementation(
        async (_repoPath: string, _onProgress: unknown, options?: PipelineOptions) => {
          options?.onTelemetry?.({
            event: 'scan-degraded-files',
            phaseName: 'scan',
            elapsedMs: 10,
            rssBytes: 0,
            heapUsedBytes: 0,
            heapTotalBytes: 0,
            heapLimitBytes: 0,
            graphNodes: 0,
            graphRelationships: 0,
            degradedReason: 'scan-file-size-cap',
            degradedFiles: [
              { filePath: 'a.py', reason: 'file exceeds scan file-size cap (1024 bytes)' },
              { filePath: 'b.py', reason: 'file exceeds scan file-size cap (999999 bytes)' },
              { filePath: 'c.py', reason: 'file exceeds scan file-size cap (42 bytes)' },
            ],
          });
          return {
            graph,
            repoPath: repoDir,
            totalFileCount: 0,
            communityResult: undefined,
            processResult: undefined,
            usedWorkerPool: false,
          };
        },
      );
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, { profile: 'symbols' }, { onProgress: vi.fn() });

      const savedMeta = saveMetaMock.mock.calls[0][1] as {
        degradedFileAggregates: {
          sampledDegradedCount: number;
          groups: Array<{ cause: string; count: number }>;
          omittedGroupCount: number;
        };
      };
      expect(savedMeta.degradedFileAggregates.sampledDegradedCount).toBe(3);
      expect(savedMeta.degradedFileAggregates.groups).toEqual([
        {
          cause: 'file exceeds scan file-size cap (N bytes)',
          phase: 'scan',
          language: 'python',
          count: 3,
        },
      ]);
      expect(savedMeta.degradedFileAggregates.omittedGroupCount).toBe(0);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('dedupes a path degraded across phases and caps persisted samples', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      runPipelineMock.mockImplementation(
        async (_repoPath: string, _onProgress: unknown, options?: PipelineOptions) => {
          // 150 scan-degraded files; the first also reappears in the parse phase.
          options?.onTelemetry?.({
            event: 'scan-degraded-files',
            phaseName: 'scan',
            elapsedMs: 10,
            rssBytes: 0,
            heapUsedBytes: 0,
            heapTotalBytes: 0,
            heapLimitBytes: 0,
            graphNodes: 0,
            graphRelationships: 0,
            degradedReason: 'scan-file-size-cap',
            degradedFiles: Array.from({ length: 150 }, (_v, i) => ({
              filePath: `src/file${i}.py`,
              reason: 'file exceeds scan file-size cap',
            })),
          });
          options?.onTelemetry?.({
            event: 'parse-degraded-files',
            phaseName: 'parse',
            elapsedMs: 20,
            rssBytes: 0,
            heapUsedBytes: 0,
            heapTotalBytes: 0,
            heapLimitBytes: 0,
            graphNodes: 0,
            graphRelationships: 0,
            degradedReason: 'parse-quarantine',
            degradedFiles: [{ filePath: 'src/file0.py', reason: 'parse quarantine' }],
          });
          return {
            graph,
            repoPath: repoDir,
            totalFileCount: 0,
            communityResult: undefined,
            processResult: undefined,
            usedWorkerPool: false,
          };
        },
      );
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, { profile: 'symbols' }, { onProgress: vi.fn() });

      const savedMeta = saveMetaMock.mock.calls[0][1] as {
        degradedFiles: unknown[];
        degradedFileAggregates: {
          sampledDegradedCount: number;
          groups: Array<{ phase: string; count: number }>;
        };
      };
      // First-seen phase wins for a duplicate path (scan before parse).
      expect(savedMeta.degradedFileAggregates.sampledDegradedCount).toBe(150);
      // Persisted samples are capped at 100.
      expect(savedMeta.degradedFiles).toHaveLength(100);
      const scanGroup = savedMeta.degradedFileAggregates.groups.find((g) => g.phase === 'scan');
      expect(scanGroup?.count).toBe(150);
      expect(savedMeta.degradedFileAggregates.groups.some((g) => g.phase === 'parse')).toBe(false);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('bounds persisted groups to top-N and records the omitted count', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      runPipelineMock.mockImplementation(
        async (_repoPath: string, _onProgress: unknown, options?: PipelineOptions) => {
          // 25 distinct non-numeric causes -> 25 distinct groups (> DEGRADED_GROUP_LIMIT of 20).
          options?.onTelemetry?.({
            event: 'scan-degraded-files',
            phaseName: 'scan',
            elapsedMs: 10,
            rssBytes: 0,
            heapUsedBytes: 0,
            heapTotalBytes: 0,
            heapLimitBytes: 0,
            graphNodes: 0,
            graphRelationships: 0,
            degradedReason: 'scan-file-size-cap',
            degradedFiles: Array.from({ length: 25 }, (_v, i) => ({
              filePath: `src/file${i}.py`,
              reason: `cause variant ${String.fromCharCode(65 + i)}`,
            })),
          });
          return {
            graph,
            repoPath: repoDir,
            totalFileCount: 0,
            communityResult: undefined,
            processResult: undefined,
            usedWorkerPool: false,
          };
        },
      );
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, { profile: 'symbols' }, { onProgress: vi.fn() });

      const savedMeta = saveMetaMock.mock.calls[0][1] as {
        degradedFileAggregates: {
          sampledDegradedCount: number;
          groups: unknown[];
          omittedGroupCount: number;
        };
      };
      expect(savedMeta.degradedFileAggregates.sampledDegradedCount).toBe(25);
      expect(savedMeta.degradedFileAggregates.groups).toHaveLength(20);
      expect(savedMeta.degradedFileAggregates.omittedGroupCount).toBe(5);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('leaves an analysis checkpoint for diagnostic-profile failure after a parse chunk', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      runPipelineMock.mockImplementation(
        async (_repoPath: string, _onProgress: unknown, options?: PipelineOptions) => {
          const telemetryBase = {
            rssBytes: 0,
            heapUsedBytes: 0,
            heapTotalBytes: 0,
            heapLimitBytes: 0,
          };
          options?.onTelemetry?.({
            ...telemetryBase,
            event: 'parse-plan',
            phaseName: 'parse',
            elapsedMs: 10,
            graphNodes: 4,
            graphRelationships: 3,
            chunkCount: 2,
            totalParseableFiles: 4,
            totalParseableBytes: 512,
            usedWorkerPool: true,
          });
          options?.onTelemetry?.({
            ...telemetryBase,
            event: 'parse-chunk-end',
            phaseName: 'parse',
            elapsedMs: 20,
            durationMs: 8,
            graphNodes: 7,
            graphRelationships: 5,
            chunkIndex: 1,
            chunkCount: 2,
            chunkFiles: 2,
            chunkBytes: 256,
            firstFilePath: 'src/a.ts',
            lastFilePath: 'src/b.ts',
            usedWorkerPool: true,
          });
          throw new Error('simulated interrupt');
        },
      );

      await expect(
        runFullAnalysis(repoDir, { profile: 'symbols' }, { onProgress: vi.fn() }),
      ).rejects.toThrow('simulated interrupt');

      const checkpointRaw = await fs.readFile(
        path.join(repoDir, '.ontoindex', 'analysis-checkpoint.json'),
        'utf8',
      );
      const checkpoint = JSON.parse(checkpointRaw);
      expect(checkpoint).toMatchObject({
        version: 1,
        status: 'failed',
        repoPath: '.',
        currentCommit: 'abc123',
        phase: 'parse',
        phaseStatus: 'failed',
        failure: {
          phase: 'parse',
          message: 'simulated interrupt',
        },
        stats: {
          graphNodes: 7,
          graphRelationships: 5,
          totalParseableFiles: 4,
          totalParseableBytes: 512,
          usedWorkerPool: true,
        },
      });
      expect(checkpoint.note).toContain('not a complete OntoIndex index');
      expect(checkpoint.completedParseChunks).toEqual([
        expect.objectContaining({
          chunkIndex: 1,
          chunkCount: 2,
          chunkFiles: 2,
          chunkBytes: 256,
          durationMs: 8,
          firstFilePath: 'src/a.ts',
          lastFilePath: 'src/b.ts',
          graphNodes: 7,
          graphRelationships: 5,
        }),
      ]);
      await expect(fs.stat(path.join(repoDir, '.ontoindex', 'meta.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('does not leave an analysis checkpoint for normal full-analysis failure', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      runPipelineMock.mockImplementation(
        async (_repoPath: string, _onProgress: unknown, options?: PipelineOptions) => {
          options?.onTelemetry?.({
            event: 'parse-plan',
            phaseName: 'parse',
            elapsedMs: 10,
            rssBytes: 0,
            heapUsedBytes: 0,
            heapTotalBytes: 0,
            heapLimitBytes: 0,
            graphNodes: 1,
            graphRelationships: 0,
          });
          throw new Error('full analyze failed');
        },
      );

      await expect(runFullAnalysis(repoDir, {}, { onProgress: vi.fn() })).rejects.toThrow(
        'full analyze failed',
      );

      await expect(
        fs.stat(path.join(repoDir, '.ontoindex', 'analysis-checkpoint.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('rejects a source mutation during analysis and leaves the active graph unchanged', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const sourcePath = path.join(repoDir, 'source.ts');
      const storagePath = path.join(repoDir, '.ontoindex');
      await fs.writeFile(sourcePath, 'export const value = 1;\n');
      await fs.mkdir(storagePath, { recursive: true });
      await fs.writeFile(path.join(storagePath, 'lbug'), 'active graph');
      await fs.writeFile(path.join(storagePath, 'meta.json'), '{}');

      runPipelineMock.mockImplementation(async () => {
        await fs.writeFile(sourcePath, 'export const value = 2;\n');
        return {
          graph: createKnowledgeGraph(),
          repoPath: repoDir,
          totalFileCount: 1,
          communityResult: undefined,
          processResult: undefined,
          usedWorkerPool: false,
        };
      });
      executeQueryMock.mockResolvedValue([]);

      await expect(runFullAnalysis(repoDir, {}, { onProgress: vi.fn() })).rejects.toThrow(
        'Source inputs changed during analysis',
      );

      expect(await fs.readFile(path.join(storagePath, 'lbug'), 'utf8')).toBe('active graph');
      const generationEntries = await fs.readdir(path.join(storagePath, 'generations'));
      expect(generationEntries.filter((entry) => entry.startsWith('.staging-'))).toEqual([]);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('updates the analysis checkpoint when diagnostic-profile analysis fails after parsing', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'file:auth',
        label: 'File',
        properties: { name: 'auth.ts', filePath: 'src/auth.ts' } as any,
      });

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 1,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      loadGraphToLbugMock.mockRejectedValueOnce(new Error('lbug load failed'));

      await expect(
        runFullAnalysis(repoDir, { profile: 'symbols' }, { onProgress: vi.fn() }),
      ).rejects.toThrow('lbug load failed');

      const checkpointRaw = await fs.readFile(
        path.join(repoDir, '.ontoindex', 'analysis-checkpoint.json'),
        'utf8',
      );
      const checkpoint = JSON.parse(checkpointRaw);
      expect(checkpoint).toMatchObject({
        version: 1,
        status: 'failed',
        phase: 'lbug',
        phaseStatus: 'failed',
        failure: {
          phase: 'lbug',
          message: 'lbug load failed',
        },
        stats: {
          graphNodes: 1,
          graphRelationships: 0,
        },
      });
      await expect(fs.stat(path.join(repoDir, '.ontoindex', 'meta.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('skips FTS indexes for empty graph labels by default', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    const previous = process.env.ONTOINDEX_CREATE_EMPTY_FTS_INDEXES;
    delete process.env.ONTOINDEX_CREATE_EMPTY_FTS_INDEXES;
    try {
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'file:auth',
        label: 'File',
        properties: { name: 'auth.ts', filePath: 'src/auth.ts' } as any,
      });

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 1,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, {}, { onProgress: vi.fn() });

      expect(createFTSIndexMock).toHaveBeenCalledTimes(1);
      expect(createFTSIndexMock).toHaveBeenCalledWith('File', 'file_fts', ['name', 'content']);
    } finally {
      if (previous === undefined) delete process.env.ONTOINDEX_CREATE_EMPTY_FTS_INDEXES;
      else process.env.ONTOINDEX_CREATE_EMPTY_FTS_INDEXES = previous;
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('indexes only File.name for large repos when file body storage is disabled', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    const previous = process.env.ONTOINDEX_MAX_FILE_CONTENT_CHARS;
    delete process.env.ONTOINDEX_MAX_FILE_CONTENT_CHARS;
    try {
      const graph = createKnowledgeGraph();
      for (let i = 0; i < 25_001; i++) {
        graph.addNode({
          id: `file:${i}`,
          label: 'File',
          properties: { name: `file-${i}.ts`, filePath: `src/file-${i}.ts` } as any,
        });
      }

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 25_001,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, {}, { onProgress: vi.fn() });

      expect(createFTSIndexMock).toHaveBeenCalledTimes(1);
      expect(createFTSIndexMock).toHaveBeenCalledWith('File', 'file_fts', ['name']);
    } finally {
      if (previous === undefined) delete process.env.ONTOINDEX_MAX_FILE_CONTENT_CHARS;
      else process.env.ONTOINDEX_MAX_FILE_CONTENT_CHARS = previous;
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('runs explicit embeddings when total graph nodes exceed the cap but embeddable nodes do not', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'file:docs',
        label: 'File',
        properties: { name: 'docs.md', filePath: 'docs.md' } as any,
      });
      graph.addNode({
        id: 'section:docs',
        label: 'Section',
        properties: { name: 'Docs', filePath: 'docs.md', content: '# Docs' } as any,
      });

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 1,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      getLbugStatsMock.mockResolvedValue({ nodes: 50_459, edges: 1 });
      executeQueryMock.mockImplementation(async (query: string) => {
        if (query.includes('RETURN count(n) AS cnt')) {
          return [{ cnt: query.includes('`Section`') ? 1 : 0 }];
        }
        if (query.includes('CodeEmbedding')) return [{ cnt: 0 }];
        return [];
      });

      const result = await runFullAnalysis(repoDir, { embeddings: true }, { onProgress: vi.fn() });

      expect(result.embeddingLifecycle).toEqual({
        mode: 'preserve',
        state: 'available',
      });
      expect(embeddingPipelineMocks.runEmbeddingPipeline).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('persists model_hash in meta.json when embeddings are generated', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    const previousModelHash = process.env.ONTOINDEX_EMBEDDING_MODEL_HASH;
    process.env.ONTOINDEX_EMBEDDING_MODEL_HASH = 'test-embedding-hash';
    try {
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'section:docs',
        label: 'Section',
        properties: { name: 'Docs', filePath: 'docs.md', content: '# Docs' } as any,
      });

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 1,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockImplementation(async (query: string) => {
        if (query.includes('RETURN count(n) AS cnt')) return [{ cnt: 1 }];
        if (query.includes('RETURN count(e) AS cnt')) return [{ cnt: 7 }];
        return [];
      });

      await runFullAnalysis(repoDir, { embeddings: true }, { onProgress: vi.fn() });

      expect(saveMetaMock).toHaveBeenCalledWith(
        expect.stringContaining(path.join(repoDir, '.ontoindex', 'generations', '.staging-')),
        expect.objectContaining({
          model_hash: 'test-embedding-hash',
          stats: expect.objectContaining({
            embeddings: 7,
          }),
        }),
      );
    } finally {
      if (previousModelHash === undefined) delete process.env.ONTOINDEX_EMBEDDING_MODEL_HASH;
      else process.env.ONTOINDEX_EMBEDDING_MODEL_HASH = previousModelHash;
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('builds and persists ANN_NEIGHBOR edges when --ann-neighbors is requested', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'func:source',
        label: 'Function',
        properties: { name: 'source', filePath: 'src/source.ts' } as any,
      });
      graph.addNode({
        id: 'func:target',
        label: 'Function',
        properties: { name: 'target', filePath: 'src/target.ts' } as any,
      });

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 2,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockImplementation(async (query: string) => {
        if (query.includes('RETURN e.nodeId AS nodeId')) {
          return [
            {
              nodeId: 'func:source',
              embedding: [1, 0],
              chunkIndex: 0,
              contentHash: 'sha1',
            },
            {
              nodeId: 'func:target',
              embedding: [0.9, 0.1],
              chunkIndex: 0,
              contentHash: 'sha2',
            },
          ];
        }
        if (query.includes('RETURN count(e) AS cnt')) {
          return [{ cnt: 2 }];
        }
        return [];
      });

      await runFullAnalysis(repoDir, { annNeighbors: true }, { onProgress: vi.fn() });

      const persistCall = executeWithReusedStatementMock.mock.calls.find(
        (call) => String(call[0]).includes('CodeRelation') && String(call[0]).includes('MERGE'),
      );
      expect(persistCall).toBeDefined();
      expect(persistCall?.[1]).toHaveLength(2);
      expect(embeddingPipelineMocks.runEmbeddingPipeline).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('fails with an actionable message when --ann-neighbors is requested but no embeddings are produced', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'func:source',
        label: 'Function',
        properties: { name: 'source', filePath: 'src/source.ts' } as any,
      });

      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 1,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockImplementation(async (query: string) => {
        if (query.includes('RETURN count(e) AS cnt')) {
          return [{ cnt: 0 }];
        }
        return [];
      });

      await expect(
        runFullAnalysis(repoDir, { annNeighbors: true }, { onProgress: vi.fn() }),
      ).rejects.toThrow(/symbol-neighborhood requested, but no embeddings were generated/);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('does not queue Markdown sidecar enrichment by default', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      await fs.writeFile(path.join(repoDir, 'README.md'), '# Docs\n', 'utf8');
      const graph = createKnowledgeGraph();
      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 1,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, {}, { onProgress: vi.fn() });

      await expect(
        fs.stat(path.join(repoDir, '.ontoindex', 'enrichment', 'sidecar-store.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('queues Markdown sidecar enrichment after indexing only when explicitly enabled', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-run-analyze-'));
    try {
      await fs.writeFile(path.join(repoDir, 'README.md'), '# Docs\n\nSee `runAnalyze`.\n', 'utf8');
      await fs.writeFile(path.join(repoDir, 'notes.mdx'), '# Notes\n', 'utf8');
      await fs.writeFile(path.join(repoDir, 'src.ts'), 'export const value = 1;\n', 'utf8');
      const graph = createKnowledgeGraph();
      runPipelineMock.mockResolvedValue({
        graph,
        repoPath: repoDir,
        totalFileCount: 3,
        communityResult: undefined,
        processResult: undefined,
        usedWorkerPool: false,
      });
      executeQueryMock.mockResolvedValue([]);

      await runFullAnalysis(repoDir, { markdownSidecar: true }, { onProgress: vi.fn() });

      const state = await loadSidecarStoreState(
        path.join(repoDir, '.ontoindex', 'enrichment', 'sidecar-store.json'),
      );
      expect(state.requests).toEqual([
        expect.objectContaining({
          repoId: 'snapshot-test',
          analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
          purpose: 'markdown-document-enrichment',
          scopeHash: expect.stringMatching(/^sha256:/),
          status: 'queued',
          durability: 'persistent',
        }),
      ]);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });
});
