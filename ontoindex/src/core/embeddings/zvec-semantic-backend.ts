import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { EMBEDDING_TABLE_NAME } from '../lbug/schema.js';
import { executeQuery } from '../lbug/pool-adapter.js';
import { getStoragePath, loadMeta } from '../../storage/repo-manager.js';
import {
  computeZvecEmbeddingRowsDigest,
  evaluateZvecMirrorFreshness,
  ZVEC_MIRROR_SCHEMA_VERSION,
} from './zvec-mirror.js';
import type {
  ZvecEmbeddingRowIdentity,
  ZvecMirrorCurrentState,
  ZvecMirrorFreshnessResult,
  ZvecMirrorMetadata,
} from './zvec-mirror.js';

type QueryRow = Record<string, unknown> | readonly unknown[];

export interface SemanticVectorSearchRepo {
  id: string;
  repoPath?: string;
  storagePath?: string;
  lastCommit?: string;
  indexedAt?: string;
}

export interface SemanticVectorSearchRow {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  distance: number;
}

export interface SemanticVectorSearchPlan {
  backend: 'lbug' | 'zvec';
  requestedBackend: 'lbug' | 'zvec' | 'auto';
  available: boolean;
  freshness: ZvecMirrorFreshnessResult['status'];
  fallbackReason?: string;
  fetchRows: (fetchLimit: number) => Promise<SemanticVectorSearchRow[]>;
}

export interface ZvecSemanticSearchDriver {
  freshness: ZvecMirrorFreshnessResult;
  queryVectorHits: (
    queryVec: readonly number[],
    fetchLimit: number,
  ) => Promise<readonly SemanticVectorSearchRow[]>;
}

export interface SemanticVectorBackendStatus {
  requestedBackend: 'lbug' | 'zvec' | 'auto';
  actualBackend: 'lbug' | 'zvec';
  freshness: ZvecMirrorFreshnessResult['status'] | 'unknown';
  fallbackReason?: string;
  circuitBroken: boolean;
}

const DEFAULT_ZVEC_INDEX_PARAMS = Object.freeze({
  m: 16,
  efConstruction: 200,
});

let zvecCircuitBroken = false;
let zvecCircuitReason: string | null = null;
let zvecDriverOverride: ZvecSemanticSearchDriver | null | undefined = undefined;
let zvecRuntimeCache = new Map<string, Promise<ZvecSemanticSearchDriver | null>>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rowIndexValue = (row: QueryRow, index: number): unknown =>
  Array.isArray(row) ? row[index] : undefined;

const rowValueNullish = (row: QueryRow, key: string, index: number): unknown => {
  const keyed = isRecord(row) ? row[key] : undefined;
  return keyed ?? rowIndexValue(row, index);
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return 'unknown error';
};

const normalizeBackendBackend = (value: unknown): 'lbug' | 'zvec' | 'auto' | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'zvec'
    ? 'zvec'
    : normalized === 'auto'
      ? 'auto'
      : normalized === 'lbug'
        ? 'lbug'
        : null;
};

const resolveRequestedVectorBackend = (): 'lbug' | 'zvec' | 'auto' => {
  return normalizeBackendBackend(process.env.ONTOINDEX_VECTOR_BACKEND) ?? 'lbug';
};

const isZvecRequested = (requestedBackend: 'lbug' | 'zvec' | 'auto'): boolean => {
  return requestedBackend !== 'lbug';
};

const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
};

const readJson = async <T>(candidate: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(candidate, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const resolveRepoStoragePath = (repo: SemanticVectorSearchRepo): string | null => {
  if (typeof repo.storagePath === 'string' && repo.storagePath.trim()) return repo.storagePath;
  if (typeof repo.repoPath === 'string' && repo.repoPath.trim())
    return getStoragePath(repo.repoPath);
  return null;
};

const resolveRelativePath = (basePath: string, candidate: string): string =>
  path.isAbsolute(candidate) ? candidate : path.resolve(basePath, candidate);

interface ZvecCollectionDescriptor {
  collectionPath: string;
  metadataPath: string;
  pointerKey: string;
}

const readZvecCollectionDescriptor = async (
  repo: SemanticVectorSearchRepo,
): Promise<ZvecCollectionDescriptor | null> => {
  const storagePath = resolveRepoStoragePath(repo);
  if (!storagePath) return null;

  const zvecRoot = path.join(storagePath, 'zvec');
  const currentPath = path.join(zvecRoot, 'current.json');
  const current = await readJson<unknown>(currentPath);
  if (!current) return null;

  const candidates: Array<{ collectionPath: string; metadataPath: string; pointerKey: string }> =
    [];
  const addCandidate = (pointerKey: string, collectionPath: string, metadataPath: string) => {
    candidates.push({ pointerKey, collectionPath, metadataPath });
  };

  if (typeof current === 'string' && current.trim()) {
    const pointer = resolveRelativePath(zvecRoot, current.trim());
    addCandidate('string', pointer, path.join(pointer, 'metadata.json'));
    addCandidate(
      'string-embeddings',
      path.join(pointer, 'embeddings'),
      path.join(pointer, 'metadata.json'),
    );
    addCandidate(
      'string-parent-metadata',
      pointer,
      path.join(path.dirname(pointer), 'metadata.json'),
    );
  } else if (isRecord(current)) {
    const collectionCandidate = [
      current.collectionPath,
      current.collection_path,
      current.path,
      current.currentPath,
    ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);

    const generationCandidate = [
      current.generationPath,
      current.generation_path,
      current.generationDir,
      current.generation_dir,
      current.generation,
      current.current,
    ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);

    const metadataCandidate = [
      current.metadataPath,
      current.metadata_path,
      current.manifestPath,
      current.manifest_path,
    ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);

    if (collectionCandidate) {
      const collectionPath = resolveRelativePath(zvecRoot, collectionCandidate.trim());
      addCandidate(
        'collectionPath',
        collectionPath,
        metadataCandidate
          ? resolveRelativePath(zvecRoot, metadataCandidate.trim())
          : path.join(path.dirname(collectionPath), 'metadata.json'),
      );
      addCandidate(
        'collectionPath-embeddings',
        path.join(collectionPath, 'embeddings'),
        metadataCandidate
          ? resolveRelativePath(zvecRoot, metadataCandidate.trim())
          : path.join(path.dirname(collectionPath), 'metadata.json'),
      );
    }

    if (generationCandidate) {
      const generationPath = resolveRelativePath(zvecRoot, generationCandidate.trim());
      addCandidate(
        'generationPath',
        path.join(generationPath, 'embeddings'),
        metadataCandidate
          ? resolveRelativePath(zvecRoot, metadataCandidate.trim())
          : path.join(generationPath, 'metadata.json'),
      );
      addCandidate(
        'generationPath-root',
        generationPath,
        metadataCandidate
          ? resolveRelativePath(zvecRoot, metadataCandidate.trim())
          : path.join(generationPath, 'metadata.json'),
      );
    }
  }

  for (const candidate of candidates) {
    if (
      (await pathExists(candidate.collectionPath)) &&
      (await pathExists(candidate.metadataPath))
    ) {
      return candidate;
    }
  }

  return null;
};

const readInstalledPackageVersion = async (packageName: string): Promise<string | null> => {
  try {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const packageJson = await readJson<{ version?: unknown }>(packageJsonPath);
    return typeof packageJson?.version === 'string' && packageJson.version.trim()
      ? packageJson.version.trim()
      : null;
  } catch {
    return null;
  }
};

const normalizeEmbeddingVector = (value: unknown): readonly number[] | null => {
  if (Array.isArray(value)) {
    const vector = value.map((entry) => Number(entry));
    return vector.every(Number.isFinite) ? vector : null;
  }

  if (value && typeof value === 'object') {
    if (Symbol.iterator in Object(value)) {
      const vector = Array.from(value as Iterable<unknown>, (entry) => Number(entry));
      return vector.every(Number.isFinite) ? vector : null;
    }

    if ('length' in Object(value)) {
      const vector = Array.from(value as ArrayLike<unknown>, (entry) => Number(entry));
      return vector.every(Number.isFinite) ? vector : null;
    }
  }

  return null;
};

const inferEmbeddingDimension = (value: unknown): number | null => {
  const vector = normalizeEmbeddingVector(value);
  return vector && vector.length > 0 ? vector.length : null;
};

const toEmbeddingRowIdentity = (row: QueryRow): ZvecEmbeddingRowIdentity | null => {
  const id = String(rowValueNullish(row, 'id', 0) ?? '').trim();
  const nodeId = String(rowValueNullish(row, 'nodeId', 1) ?? '').trim();
  const chunkIndex = Number(rowValueNullish(row, 'chunkIndex', 2) ?? 0);
  const contentHash = String(rowValueNullish(row, 'contentHash', 3) ?? '').trim();

  if (!id || !nodeId || !Number.isFinite(chunkIndex) || !contentHash) {
    return null;
  }

  return {
    id,
    nodeId,
    chunkIndex,
    contentHash,
  };
};

const toSemanticVectorSearchRow = (row: QueryRow): SemanticVectorSearchRow => ({
  nodeId: String(rowValueNullish(row, 'nodeId', 0) ?? ''),
  chunkIndex: Number(rowValueNullish(row, 'chunkIndex', 1) ?? 0),
  startLine: Number(rowValueNullish(row, 'startLine', 2) ?? 0),
  endLine: Number(rowValueNullish(row, 'endLine', 3) ?? 0),
  distance: Number(rowValueNullish(row, 'distance', 4) ?? 0),
});

const toVectorRows = (rows: unknown): SemanticVectorSearchRow[] =>
  Array.isArray(rows)
    ? rows
        .filter((row): row is QueryRow => Array.isArray(row) || isRecord(row))
        .map(toSemanticVectorSearchRow)
    : [];

async function buildCurrentState(
  repo: SemanticVectorSearchRepo,
  packageVersion: string,
): Promise<ZvecMirrorCurrentState | null> {
  const storagePath = resolveRepoStoragePath(repo);
  if (!storagePath) return null;

  const repoMeta = await loadMeta(storagePath);
  if (!repoMeta?.model_hash) return null;

  const dimensionRows = await executeQuery(
    repo.id,
    `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.embedding AS embedding LIMIT 1`,
  );
  const firstDimensionRow = dimensionRows.find((row) => Array.isArray(row) || isRecord(row));
  if (!firstDimensionRow) return null;

  const embeddingDimension = inferEmbeddingDimension(
    rowValueNullish(firstDimensionRow, 'embedding', 0),
  );
  if (!embeddingDimension) return null;

  const identityRows = await executeQuery(
    repo.id,
    `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.id AS id, e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.contentHash AS contentHash`,
  );
  const identities = identityRows
    .filter((row) => Array.isArray(row) || isRecord(row))
    .map((row) => toEmbeddingRowIdentity(row as QueryRow))
    .filter((row): row is ZvecEmbeddingRowIdentity => row !== null);

  if (identities.length === 0) return null;

  return {
    schemaVersion: ZVEC_MIRROR_SCHEMA_VERSION,
    zvecPackageVersion: packageVersion,
    embeddingDimension,
    embeddingModelHash: repoMeta.model_hash,
    sourceCommit: repo.lastCommit ?? repoMeta.lastCommit ?? '',
    currentHead: repo.lastCommit ?? repoMeta.lastCommit ?? '',
    codeEmbeddingRowCount: identities.length,
    codeEmbeddingRowDigest: computeZvecEmbeddingRowsDigest(identities),
    backendIndexType: 'hnsw',
    backendIndexParams: DEFAULT_ZVEC_INDEX_PARAMS,
  };
}

async function loadZvecMirrorMetadata(metadataPath: string): Promise<ZvecMirrorMetadata | null> {
  const raw = await readJson<unknown>(metadataPath);
  if (!raw) return null;

  if (!isRecord(raw)) return null;

  const schemaVersion = Number(raw.schemaVersion);
  const zvecPackageVersion =
    typeof raw.zvecPackageVersion === 'string' ? raw.zvecPackageVersion.trim() : '';
  const embeddingDimension = Number(raw.embeddingDimension);
  const embeddingModelHash =
    typeof raw.embeddingModelHash === 'string' ? raw.embeddingModelHash.trim() : '';
  const sourceCommit = typeof raw.sourceCommit === 'string' ? raw.sourceCommit.trim() : '';
  const currentHead = typeof raw.currentHead === 'string' ? raw.currentHead.trim() : '';
  const codeEmbeddingRowCount = Number(raw.codeEmbeddingRowCount);
  const codeEmbeddingRowDigest =
    typeof raw.codeEmbeddingRowDigest === 'string' ? raw.codeEmbeddingRowDigest.trim() : '';
  const buildTimestamp = typeof raw.buildTimestamp === 'string' ? raw.buildTimestamp.trim() : '';
  const backendIndexType =
    typeof raw.backendIndexType === 'string' ? raw.backendIndexType.trim() : '';
  const backendIndexParams = isRecord(raw.backendIndexParams) ? raw.backendIndexParams : null;

  if (
    !Number.isFinite(schemaVersion) ||
    !zvecPackageVersion ||
    !Number.isFinite(embeddingDimension) ||
    !embeddingModelHash ||
    !sourceCommit ||
    !currentHead ||
    !Number.isFinite(codeEmbeddingRowCount) ||
    !codeEmbeddingRowDigest ||
    !buildTimestamp ||
    !backendIndexType ||
    backendIndexParams === null
  ) {
    return null;
  }

  return {
    schemaVersion,
    zvecPackageVersion,
    embeddingDimension,
    embeddingModelHash,
    sourceCommit,
    currentHead,
    graphIndexId:
      typeof raw.graphIndexId === 'string' ? raw.graphIndexId.trim() || undefined : undefined,
    graphIndexHash:
      typeof raw.graphIndexHash === 'string' ? raw.graphIndexHash.trim() || undefined : undefined,
    codeEmbeddingRowCount,
    codeEmbeddingRowDigest,
    buildTimestamp,
    backendIndexType,
    backendIndexParams,
  };
}

async function loadZvecRuntime(repo: SemanticVectorSearchRepo): Promise<{
  freshness: ZvecMirrorFreshnessResult;
  queryVectorHits: (
    queryVec: readonly number[],
    fetchLimit: number,
  ) => Promise<readonly SemanticVectorSearchRow[]>;
} | null> {
  if (zvecDriverOverride !== undefined) {
    return zvecDriverOverride?.freshness.status === 'fresh' ? zvecDriverOverride : null;
  }

  const descriptor = await readZvecCollectionDescriptor(repo);
  if (!descriptor) return null;

  const cacheKey = [
    resolveRepoStoragePath(repo) ?? '',
    repo.lastCommit ?? '',
    descriptor.pointerKey,
    descriptor.collectionPath,
    descriptor.metadataPath,
  ].join('\u0000');

  const cached = zvecRuntimeCache.get(cacheKey);
  if (cached) return cached;

  const loadPromise = (async (): Promise<ZvecSemanticSearchDriver | null> => {
    const zvecPackageVersion = await readInstalledPackageVersion('@zvec/zvec');
    if (!zvecPackageVersion) return null;

    const metadata = await loadZvecMirrorMetadata(descriptor.metadataPath);
    if (!metadata) return null;

    const current = await buildCurrentState(repo, zvecPackageVersion);
    if (!current) return null;

    const freshness = evaluateZvecMirrorFreshness({ current, metadata });
    if (freshness.status !== 'fresh') {
      return null;
    }

    try {
      const zvecModuleName = '@zvec/zvec';
      const zvecModule = (await import(zvecModuleName)) as any;
      const collectionSchema = new zvecModule.ZVecCollectionSchema({
        name: 'ontoindex_embeddings',
        fields: [
          { name: 'nodeId', dataType: zvecModule.ZVecDataType.STRING },
          { name: 'chunkIndex', dataType: zvecModule.ZVecDataType.INT32, nullable: true },
          { name: 'startLine', dataType: zvecModule.ZVecDataType.INT64, nullable: true },
          { name: 'endLine', dataType: zvecModule.ZVecDataType.INT64, nullable: true },
        ],
        vectors: {
          name: 'embedding',
          dataType: zvecModule.ZVecDataType.VECTOR_FP32,
          dimension: metadata.embeddingDimension,
          indexParams: {
            indexType: zvecModule.ZVecIndexType.HNSW,
            ...DEFAULT_ZVEC_INDEX_PARAMS,
          },
        },
      });

      zvecModule.ZVecInitialize({ queryThreads: 1, optimizeThreads: 1 });
      const collection =
        typeof zvecModule.ZVecOpen === 'function'
          ? zvecModule.ZVecOpen(descriptor.collectionPath)
          : zvecModule.ZVecCreateAndOpen(descriptor.collectionPath, collectionSchema);

      return {
        freshness,
        queryVectorHits: async (queryVec: readonly number[], fetchLimit: number) => {
          const rows = collection.querySync({
            fieldName: 'embedding',
            vector: Float32Array.from(queryVec),
            topk: fetchLimit,
            outputFields: ['nodeId', 'chunkIndex', 'startLine', 'endLine'],
          });
          return toVectorRows(rows);
        },
      };
    } catch {
      return null;
    }
  })();

  zvecRuntimeCache.set(cacheKey, loadPromise);
  const runtime = await loadPromise;
  if (!runtime) {
    zvecRuntimeCache.delete(cacheKey);
  }
  return runtime;
}

export function resetZvecSemanticSearchCircuitBreakerForTests(): void {
  zvecCircuitBroken = false;
  zvecCircuitReason = null;
  zvecRuntimeCache.clear();
}

export function setZvecSemanticSearchDriverForTests(
  driver: ZvecSemanticSearchDriver | null | undefined,
): void {
  zvecDriverOverride = driver;
  zvecCircuitBroken = false;
  zvecCircuitReason = null;
  zvecRuntimeCache.clear();
}

export async function getSemanticVectorBackendStatus(
  repo: SemanticVectorSearchRepo,
): Promise<SemanticVectorBackendStatus> {
  const requestedBackend = resolveRequestedVectorBackend();

  if (!isZvecRequested(requestedBackend)) {
    return {
      requestedBackend,
      actualBackend: 'lbug',
      freshness: 'unknown',
      circuitBroken: false,
    };
  }

  if (zvecCircuitBroken) {
    return {
      requestedBackend,
      actualBackend: 'lbug',
      freshness: 'error',
      fallbackReason: zvecCircuitReason ?? 'zvec circuit breaker tripped',
      circuitBroken: true,
    };
  }

  const descriptor = await readZvecCollectionDescriptor(repo);
  if (!descriptor) {
    return {
      requestedBackend,
      actualBackend: 'lbug',
      freshness: 'missing',
      fallbackReason: 'zvec collection descriptor unavailable',
      circuitBroken: false,
    };
  }

  const zvecPackageVersion = await readInstalledPackageVersion('@zvec/zvec');
  if (!zvecPackageVersion) {
    return {
      requestedBackend,
      actualBackend: 'lbug',
      freshness: 'missing',
      fallbackReason: '@zvec/zvec package unavailable',
      circuitBroken: false,
    };
  }

  const metadata = await loadZvecMirrorMetadata(descriptor.metadataPath);
  if (!metadata) {
    return {
      requestedBackend,
      actualBackend: 'lbug',
      freshness: 'missing',
      fallbackReason: 'zvec mirror metadata unavailable',
      circuitBroken: false,
    };
  }

  const current = await buildCurrentState(repo, zvecPackageVersion);
  if (!current) {
    return {
      requestedBackend,
      actualBackend: 'lbug',
      freshness: 'missing',
      fallbackReason: 'zvec mirror current state unavailable',
      circuitBroken: false,
    };
  }

  const freshness = evaluateZvecMirrorFreshness({ current, metadata });
  if (freshness.status !== 'fresh') {
    return {
      requestedBackend,
      actualBackend: 'lbug',
      freshness: freshness.status,
      fallbackReason: `zvec mirror ${freshness.status}`,
      circuitBroken: false,
    };
  }

  const runtime = await loadZvecRuntime(repo);
  if (!runtime) {
    return {
      requestedBackend,
      actualBackend: 'lbug',
      freshness: freshness.status,
      fallbackReason: 'zvec runtime unavailable',
      circuitBroken: false,
    };
  }

  return {
    requestedBackend,
    actualBackend: 'zvec',
    freshness: runtime.freshness.status,
    circuitBroken: false,
  };
}

export async function resolveSemanticVectorRowsFetcher(
  repo: SemanticVectorSearchRepo,
  queryVec: readonly number[],
  fallbackFetchRows: (fetchLimit: number) => Promise<SemanticVectorSearchRow[]>,
): Promise<SemanticVectorSearchPlan> {
  const requestedBackend = resolveRequestedVectorBackend();
  if (!isZvecRequested(requestedBackend) || zvecCircuitBroken) {
    return {
      backend: 'lbug',
      requestedBackend,
      available: !isZvecRequested(requestedBackend),
      freshness: zvecCircuitBroken ? 'error' : 'fresh',
      fallbackReason: zvecCircuitBroken
        ? (zvecCircuitReason ?? 'zvec circuit breaker tripped')
        : undefined,
      fetchRows: fallbackFetchRows,
    };
  }

  const runtime = await loadZvecRuntime(repo);
  if (!runtime) {
    return {
      backend: 'lbug',
      requestedBackend,
      available: false,
      freshness: 'missing',
      fallbackReason: 'zvec backend unavailable, stale, or missing; using LadybugDB',
      fetchRows: fallbackFetchRows,
    };
  }

  let backendMode: 'zvec' | 'lbug' = 'zvec';
  return {
    backend: 'zvec',
    requestedBackend,
    available: true,
    freshness: runtime.freshness.status,
    fetchRows: async (fetchLimit: number) => {
      if (backendMode === 'lbug') {
        return fallbackFetchRows(fetchLimit);
      }

      try {
        return [...(await runtime.queryVectorHits(queryVec, fetchLimit))];
      } catch (error) {
        zvecCircuitBroken = true;
        zvecCircuitReason = `zvec query failed: ${errorMessage(error)}`;
        backendMode = 'lbug';
        return fallbackFetchRows(fetchLimit);
      }
    },
  };
}
