import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
  executeQuery: vi.fn(),
  isLbugReady: vi.fn(),
  isWriteQuery: vi.fn(),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn(),
  getEmbeddingDims: vi.fn(),
  isEmbedderReady: vi.fn(),
}));

import {
  executeParameterized,
  executeQuery,
  isLbugReady,
} from '../../src/core/lbug/pool-adapter.js';
import { embedQuery, getEmbeddingDims, isEmbedderReady } from '../../src/mcp/core/embedder.js';
import { semanticSearch } from '../../src/mcp/local/backend-query.js';
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
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ONTOINDEX_VECTOR_BACKEND;
    mockIsLbugReady.mockReturnValue(true);
    mockEmbedQuery.mockResolvedValue([0.11, 0.22, 0.33]);
    mockGetEmbeddingDims.mockReturnValue(3);
    mockIsEmbedderReady.mockReturnValue(true);
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

  afterEach(() => {
    resetZvecSemanticSearchCircuitBreakerForTests();
    setZvecSemanticSearchDriverForTests(undefined);
    delete process.env.ONTOINDEX_VECTOR_BACKEND;
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
});
