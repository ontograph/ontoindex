import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
  executeQuery: vi.fn(),
  isLbugReady: vi.fn(),
  isWriteQuery: vi.fn(),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn(),
  getEmbeddingDims: vi.fn(),
  getMcpEmbeddingModelId: vi.fn(() => process.env.ONTOINDEX_EMBEDDING_MODEL ?? 'test-model'),
  isMcpEmbeddingModelSelected: vi.fn(() => false),
  isEmbedderReady: vi.fn(),
}));

import {
  executeParameterized,
  executeQuery,
  isLbugReady,
} from '../../src/core/lbug/pool-adapter.js';
import {
  embedQuery,
  getEmbeddingDims,
  isEmbedderReady,
  isMcpEmbeddingModelSelected,
} from '../../src/mcp/core/embedder.js';
import { semanticSearch } from '../../src/mcp/local/backend-query.js';
import { EmbeddingRevisionMismatchError } from '../../src/core/embeddings/embedding-revision.js';
import {
  computeZvecEmbeddingRowsDigest,
  createZvecMirrorMetadata,
  evaluateZvecMirrorFreshness,
  ZVEC_MIRROR_SCHEMA_VERSION,
} from '../../src/core/embeddings/zvec-mirror.js';
import type { ZvecEmbeddingRowIdentity } from '../../src/core/embeddings/zvec-mirror.js';
import {
  getSemanticVectorBackendStatus,
  resetZvecSemanticSearchCircuitBreakerForTests,
  setZvecSemanticSearchDriverForTests,
} from '../../src/core/embeddings/zvec-semantic-backend.js';

const mockExecuteQuery = vi.mocked(executeQuery);
const mockExecuteParameterized = vi.mocked(executeParameterized);
const mockIsLbugReady = vi.mocked(isLbugReady);
const mockEmbedQuery = vi.mocked(embedQuery);
const mockGetEmbeddingDims = vi.mocked(getEmbeddingDims);
const mockIsEmbedderReady = vi.mocked(isEmbedderReady);
const mockIsMcpEmbeddingModelSelected = vi.mocked(isMcpEmbeddingModelSelected);

const repo = {
  id: 'repo-1',
  repoPath: '/repo',
  storagePath: '/repo/.ontoindex',
  lastCommit: 'abc123',
} as any;

const embeddingRows: ZvecEmbeddingRowIdentity[] = [
  {
    id: 'code_embedding:1',
    nodeId: 'Function:src/core/cache.ts:CacheStore',
    chunkIndex: 0,
    contentHash: 'sha256:111',
  },
];

const baseCurrent = {
  schemaVersion: ZVEC_MIRROR_SCHEMA_VERSION,
  zvecPackageVersion: '0.0.0-test',
  embeddingDimension: 3,
  embeddingModelHash: 'sha256:model-a',
  sourceCommit: 'abc123',
  currentHead: 'abc123',
  codeEmbeddingRowCount: embeddingRows.length,
  codeEmbeddingRowDigest: computeZvecEmbeddingRowsDigest(embeddingRows),
  backendIndexType: 'hnsw',
  backendIndexParams: {
    m: 16,
    efConstruction: 200,
  },
} as const;

const freshMetadata = createZvecMirrorMetadata({
  ...baseCurrent,
  codeEmbeddingRows: embeddingRows,
  buildTimestamp: '2026-06-19T00:00:00.000Z',
});

const staleFreshness = evaluateZvecMirrorFreshness({
  current: {
    ...baseCurrent,
    codeEmbeddingRowDigest: 'sha256:stale',
  },
  metadata: freshMetadata,
});

const freshFreshness = evaluateZvecMirrorFreshness({
  current: baseCurrent,
  metadata: freshMetadata,
});

describe('zvec semantic backend routing', () => {
  let defaultStoragePath: string | undefined;

  beforeEach(async () => {
    defaultStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-semantic-meta-'));
    await fs.writeFile(
      path.join(defaultStoragePath, 'meta.json'),
      JSON.stringify({ model_hash: 'test-model' }),
    );
    repo.storagePath = defaultStoragePath;
    vi.clearAllMocks();
    delete process.env.ONTOINDEX_VECTOR_BACKEND;
    delete process.env.ONTOINDEX_EMBEDDING_REVISION;
    delete process.env.ONTOINDEX_EMBEDDING_URL;
    delete process.env.ONTOINDEX_EMBEDDING_MODEL;
    process.env.ONTOINDEX_EMBEDDING_MODEL = 'test-model';
    mockIsLbugReady.mockReturnValue(true);
    mockEmbedQuery.mockResolvedValue([0.11, 0.22, 0.33]);
    mockGetEmbeddingDims.mockReturnValue(3);
    mockIsEmbedderReady.mockReturnValue(true);
    mockIsMcpEmbeddingModelSelected.mockReturnValue(false);
    mockExecuteQuery.mockImplementation(async (_repoId, statement) => {
      const sql = String(statement);
      if (sql.includes('MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId LIMIT 1')) {
        return [{ nodeId: 'embedding:1' }];
      }
      if (sql.includes('QUERY_VECTOR_INDEX')) {
        return [
          {
            nodeId: embeddingRows[0].nodeId,
            chunkIndex: 0,
            startLine: 10,
            endLine: 40,
            distance: 0.11,
          },
        ];
      }
      return [];
    });
    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      const sql = String(statement);
      if (sql.includes('MATCH (n:File')) {
        return [{ name: 'cache.ts', filePath: 'src/core/cache.ts' }];
      }
      if (sql.includes('MATCH (n:`Function`')) {
        return [{ name: 'CacheStore', filePath: 'src/core/cache.ts' }];
      }
      return [];
    });
    resetZvecSemanticSearchCircuitBreakerForTests();
    setZvecSemanticSearchDriverForTests(undefined);
  });

  afterEach(async () => {
    resetZvecSemanticSearchCircuitBreakerForTests();
    setZvecSemanticSearchDriverForTests(undefined);
    delete process.env.ONTOINDEX_VECTOR_BACKEND;
    delete process.env.ONTOINDEX_EMBEDDING_REVISION;
    delete process.env.ONTOINDEX_EMBEDDING_MODEL;
    if (defaultStoragePath) await fs.rm(defaultStoragePath, { recursive: true, force: true });
    defaultStoragePath = undefined;
  });

  it('keeps the LadybugDB vector path when zvec is not requested', async () => {
    const result = await semanticSearch(repo, 'cache store', 5);

    expect(result).toEqual([
      {
        nodeId: 'Function:src/core/cache.ts:CacheStore',
        name: 'CacheStore',
        type: 'Function',
        filePath: 'src/core/cache.ts',
        distance: 0.11,
        startLine: 10,
        endLine: 40,
      },
    ]);
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      'repo-1',
      expect.stringContaining('QUERY_VECTOR_INDEX'),
    );
  });

  it('fails closed without querying vectors when configured and indexed revisions differ', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-revision-query-'));
    process.env.ONTOINDEX_EMBEDDING_REVISION = 'revision-b';
    try {
      await fs.writeFile(
        path.join(storagePath, 'meta.json'),
        JSON.stringify({ embedding_revision: 'revision-a', stats: { embeddings: 1 } }),
      );

      await expect(semanticSearch({ ...repo, storagePath }, 'cache store', 5)).rejects.toBeInstanceOf(
        EmbeddingRevisionMismatchError,
      );

      expect(mockEmbedQuery).not.toHaveBeenCalled();
      expect(mockExecuteQuery).not.toHaveBeenCalledWith(
        repo.id,
        expect.stringContaining('QUERY_VECTOR_INDEX'),
      );
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });

  it('does not leak a rejected intent model override into the next search', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-intent-model-'));
    process.env.ONTOINDEX_EMBEDDING_MODEL = 'configured-model';
    process.env.ONTOINDEX_EMBEDDING_REVISION = 'revision-a';
    mockIsEmbedderReady.mockReturnValue(false);
    try {
      await fs.writeFile(
        path.join(storagePath, 'meta.json'),
        JSON.stringify({
          embedding_revision: 'revision-a',
          model_hash: 'configured-model@revision-a',
          stats: { embeddings: 1 },
        }),
      );

      await expect(
        semanticSearch({ ...repo, storagePath }, 'cache store', 5, 'incompatible-model'),
      ).rejects.toBeInstanceOf(EmbeddingRevisionMismatchError);

      expect(process.env.ONTOINDEX_EMBEDDING_MODEL).toBe('configured-model');
      expect(mockEmbedQuery).not.toHaveBeenCalled();

      const result = await semanticSearch({ ...repo, storagePath }, 'cache store', 5);

      expect(result[0]?.name).toBe('CacheStore');
      expect(process.env.ONTOINDEX_EMBEDDING_MODEL).toBe('configured-model');
      expect(mockEmbedQuery).toHaveBeenCalledWith('cache store', undefined);
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });

  it('propagates a concurrent embedder model mismatch instead of returning empty results', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-concurrent-model-'));
    process.env.ONTOINDEX_EMBEDDING_MODEL = 'model-a';
    process.env.ONTOINDEX_EMBEDDING_REVISION = 'revision-a';
    mockIsEmbedderReady.mockReturnValue(false);
    mockIsMcpEmbeddingModelSelected.mockReturnValue(true);
    try {
      await fs.writeFile(
        path.join(storagePath, 'meta.json'),
        JSON.stringify({
          embedding_revision: 'revision-a',
          model_hash: 'model-a@revision-a',
          stats: { embeddings: 1 },
        }),
      );
      mockEmbedQuery.mockRejectedValueOnce(
        new EmbeddingRevisionMismatchError(
          'Embedding model mismatch: the singleton uses "model-a" but this request requires "model-b".',
        ),
      );

      await expect(
        semanticSearch({ ...repo, storagePath }, 'cache store', 5, 'model-b'),
      ).rejects.toBeInstanceOf(EmbeddingRevisionMismatchError);

      expect(mockExecuteQuery).not.toHaveBeenCalledWith(
        repo.id,
        expect.stringContaining('QUERY_VECTOR_INDEX'),
      );
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });

  it('rejects vectors with an explicit revision but no indexed model identity', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-missing-model-hash-'));
    process.env.ONTOINDEX_EMBEDDING_REVISION = 'revision-a';
    try {
      await fs.writeFile(
        path.join(storagePath, 'meta.json'),
        JSON.stringify({
          embedding_revision: 'revision-a',
          stats: { embeddings: 1 },
        }),
      );

      await expect(
        semanticSearch({ ...repo, storagePath }, 'cache store', 5),
      ).rejects.toThrow('Embedding model identity is missing from index metadata');

      expect(mockEmbedQuery).not.toHaveBeenCalled();
      expect(mockExecuteQuery).not.toHaveBeenCalledWith(
        repo.id,
        expect.stringContaining('QUERY_VECTOR_INDEX'),
      );
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });

  it('rejects vectors without either indexed identity field but permits an empty vector table', async () => {
    const storagePath = defaultStoragePath!;
    delete process.env.ONTOINDEX_EMBEDDING_REVISION;
    await fs.writeFile(
      path.join(storagePath, 'meta.json'),
      JSON.stringify({ stats: { embeddings: 1 } }),
    );

    await expect(semanticSearch({ ...repo, storagePath }, 'cache store', 5)).rejects.toThrow(
      'Embedding model identity is missing from index metadata',
    );
    expect(mockEmbedQuery).not.toHaveBeenCalled();

    mockExecuteQuery.mockResolvedValueOnce([]);
    await expect(semanticSearch({ ...repo, storagePath }, 'cache store', 5)).resolves.toEqual([]);
  });

  it('falls back to LadybugDB when a requested zvec mirror is stale', async () => {
    process.env.ONTOINDEX_VECTOR_BACKEND = 'zvec';
    const zvecQueryHits = vi.fn();
    setZvecSemanticSearchDriverForTests({
      freshness: staleFreshness,
      queryVectorHits: zvecQueryHits,
    });

    const result = await semanticSearch(repo, 'cache store', 5);

    expect(zvecQueryHits).not.toHaveBeenCalled();
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      'repo-1',
      expect.stringContaining('QUERY_VECTOR_INDEX'),
    );
    expect(result[0]?.name).toBe('CacheStore');
  });

  it('uses zvec when auto is requested and the mirror is fresh', async () => {
    process.env.ONTOINDEX_VECTOR_BACKEND = 'auto';
    const zvecQueryHits = vi.fn().mockResolvedValue([
      {
        nodeId: embeddingRows[0].nodeId,
        chunkIndex: 0,
        startLine: 10,
        endLine: 40,
        distance: 0.02,
      },
    ]);
    setZvecSemanticSearchDriverForTests({
      freshness: freshFreshness,
      queryVectorHits: zvecQueryHits,
    });

    const result = await semanticSearch(repo, 'cache store', 5);

    expect(zvecQueryHits).toHaveBeenCalledTimes(1);
    expect(mockExecuteQuery).not.toHaveBeenCalledWith(
      'repo-1',
      expect.stringContaining('QUERY_VECTOR_INDEX'),
    );
    expect(result[0]?.name).toBe('CacheStore');
  });

  it('falls back to LadybugDB when a stale zvec mirror is requested via auto', async () => {
    process.env.ONTOINDEX_VECTOR_BACKEND = 'auto';
    const zvecQueryHits = vi.fn();
    setZvecSemanticSearchDriverForTests({
      freshness: staleFreshness,
      queryVectorHits: zvecQueryHits,
    });

    const result = await semanticSearch(repo, 'cache store', 5);

    expect(zvecQueryHits).not.toHaveBeenCalled();
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      'repo-1',
      expect.stringContaining('QUERY_VECTOR_INDEX'),
    );
    expect(result[0]?.name).toBe('CacheStore');
  });

  it('trips the zvec breaker after the first runtime query failure and skips later retries until reset', async () => {
    process.env.ONTOINDEX_VECTOR_BACKEND = 'zvec';
    const zvecQueryHits = vi
      .fn()
      .mockRejectedValueOnce(new Error('zvec query failed'))
      .mockResolvedValue([
        {
          nodeId: embeddingRows[0].nodeId,
          chunkIndex: 0,
          startLine: 10,
          endLine: 40,
          distance: 0.02,
        },
      ]);
    setZvecSemanticSearchDriverForTests({
      freshness: freshFreshness,
      queryVectorHits: zvecQueryHits,
    });

    const first = await semanticSearch(repo, 'cache store', 5);
    const second = await semanticSearch(repo, 'cache store', 5);

    expect(first[0]?.name).toBe('CacheStore');
    expect(second[0]?.name).toBe('CacheStore');
    expect(zvecQueryHits).toHaveBeenCalledTimes(1);

    resetZvecSemanticSearchCircuitBreakerForTests();

    const third = await semanticSearch(repo, 'cache store', 5);

    expect(third[0]?.name).toBe('CacheStore');
    expect(zvecQueryHits).toHaveBeenCalledTimes(2);
  });

  it('reports a bounded fallback status when zvec is requested but collection metadata is unavailable', async () => {
    process.env.ONTOINDEX_VECTOR_BACKEND = 'zvec';

    const status = await getSemanticVectorBackendStatus({ id: 'repo-2' } as any);

    expect(status).toMatchObject({
      requestedBackend: 'zvec',
      actualBackend: 'lbug',
      freshness: 'missing',
      fallbackReason: expect.stringContaining('unavailable'),
      circuitBroken: false,
    });
  });

  it('reports requestedBackend as auto when auto is configured but zvec is unavailable', async () => {
    process.env.ONTOINDEX_VECTOR_BACKEND = 'auto';

    const status = await getSemanticVectorBackendStatus({ id: 'repo-2' } as any);

    expect(status).toMatchObject({
      requestedBackend: 'auto',
      actualBackend: 'lbug',
      freshness: 'missing',
      fallbackReason: expect.stringContaining('unavailable'),
      circuitBroken: false,
    });
  });
});
