/**
 * Embedding Pipeline Module
 *
 * Orchestrates the background embedding process:
 * 1. Query embeddable nodes from LadybugDB
 * 2. Generate text representations with enriched metadata
 * 3. Chunk long nodes, batch embed
 * 4. Update LadybugDB with chunk-aware embeddings
 * 5. Create vector index for semantic search
 */

import { createHash } from 'crypto';
import {
  initEmbedder,
  embedBatch,
  embedText,
  embeddingToArray,
  isEmbedderReady,
} from './embedder.js';
import { generateEmbeddingText } from './text-generator.js';
import { chunkNode, characterChunk } from './chunker.js';
import { extractStructuralNames } from './structural-extractor.js';
import {
  type EmbeddingProgress,
  type EmbeddingConfig,
  type EmbeddableNode,
  type SemanticSearchResult,
  type ModelProgress,
  type EmbeddingContext,
  DEFAULT_EMBEDDING_CONFIG,
  EMBEDDABLE_LABELS,
  isShortLabel,
  LABEL_METHOD,
  LABELS_WITH_EXPORTED,
  STRUCTURAL_LABELS,
  collectBestChunks,
} from './types.js';
import {
  EMBEDDING_TABLE_NAME,
  EMBEDDING_INDEX_NAME,
  CREATE_VECTOR_INDEX_QUERY,
  STALE_HASH_SENTINEL,
} from '../lbug/schema.js';
import { loadVectorExtension } from '../lbug/lbug-adapter.js';

const isDev = process.env.NODE_ENV === 'development';
/**
 * Bump this when the embedding text template changes in a way that should
 * invalidate existing vectors, such as metadata/header shape changes,
 * structural container context changes, or preceding-context formatting rules.
 */
export const EMBEDDING_TEXT_VERSION = 'v2';

/**
 * Compute a stable content fingerprint for an embeddable node.
 * Used to detect when the underlying text has changed so stale vectors
 * can be replaced (DELETE-then-INSERT, the Kuzu-sanctioned pattern for
 * vector-indexed rows).
 */
export const contentHashForNode = (
  node: EmbeddableNode,
  config: Partial<EmbeddingConfig> = {},
): string => {
  // Hash must be deterministic across runs, so exclude methodNames/fieldNames
  // which are populated during the batch loop via AST extraction.
  // Using only node.content ensures the hash stays stable.
  // NOTE: A change to extractStructuralNames behavior requires bumping EMBEDDING_TEXT_VERSION.
  const text = generateEmbeddingText(
    { ...node, methodNames: undefined, fieldNames: undefined },
    node.content,
    config,
  );
  return createHash('sha1').update(EMBEDDING_TEXT_VERSION).update('\n').update(text).digest('hex');
};

const NODE_PAGE_SIZE = 500;
const EXTRACTION_CONCURRENCY = 4;

/**
 * Progress callback type
 */
type EmbeddingProgressCallback = (progress: EmbeddingProgress) => void;

type QueryRow = Record<string, unknown> | readonly unknown[];
type QueryRows = QueryRow[];
type ExecuteQuery = (cypher: string) => Promise<QueryRows>;

type StatementParamValue = string | number | number[];
type StatementParams = Record<string, StatementParamValue>;
type ExecuteWithReusedStatement = (cypher: string, paramsList: StatementParams[]) => Promise<void>;

type EmbeddingInsertParams = {
  id: string;
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  embedding: number[];
  contentHash: string;
};

type SemanticChunkRow = {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  distance: number;
};

export type SemanticSearchContextResult = {
  matchId: string;
  matchName: string;
  matchLabel: string;
  matchPath: string;
  distance: number;
  connectedId: null;
  connectedName: null;
  connectedLabel: null;
  relationType: null;
};

const rowField = <T>(row: QueryRow, field: string): T | undefined =>
  Array.isArray(row) ? undefined : (row[field] as T | undefined);

const rowIndex = <T>(row: QueryRow, index: number): T | undefined =>
  Array.isArray(row) ? (row[index] as T | undefined) : undefined;

const rowFieldOrIndex = <T>(row: QueryRow, field: string, index: number): T | undefined =>
  rowField<T>(row, field) ?? rowIndex<T>(row, index);

/**
 * Paged query for embeddable nodes from LadybugDB
 */
async function* queryEmbeddableNodesPaged(
  executeQuery: ExecuteQuery,
): AsyncGenerator<EmbeddableNode[]> {
  for (const label of EMBEDDABLE_LABELS) {
    let offset = 0;
    while (true) {
      try {
        let query: string;

        if (label === LABEL_METHOD) {
          query = `
            MATCH (n:Method)
            RETURN n.id AS id, n.name AS name, 'Method' AS label,
                   n.filePath AS filePath, n.content AS content,
                   n.startLine AS startLine, n.endLine AS endLine,
                   n.isExported AS isExported, n.description AS description,
                   n.parameterCount AS parameterCount, n.returnType AS returnType
            ORDER BY n.id
            SKIP ${offset} LIMIT ${NODE_PAGE_SIZE}
          `;
        } else if (LABELS_WITH_EXPORTED.has(label)) {
          query = `
            MATCH (n:\`${label}\`)
            RETURN n.id AS id, n.name AS name, '${label}' AS label,
                   n.filePath AS filePath, n.content AS content,
                   n.startLine AS startLine, n.endLine AS endLine,
                   n.isExported AS isExported, n.description AS description
            ORDER BY n.id
            SKIP ${offset} LIMIT ${NODE_PAGE_SIZE}
          `;
        } else {
          query = `
            MATCH (n:\`${label}\`)
            RETURN n.id AS id, n.name AS name, '${label}' AS label,
                   n.filePath AS filePath, n.content AS content,
                   n.startLine AS startLine, n.endLine AS endLine,
                   n.description AS description
            ORDER BY n.id
            SKIP ${offset} LIMIT ${NODE_PAGE_SIZE}
          `;
        }

        const rows = await executeQuery(query);
        if (rows.length === 0) break;

        const pageNodes: EmbeddableNode[] = rows.map((row) => {
          const hasExportedColumn = label === LABEL_METHOD || LABELS_WITH_EXPORTED.has(label);
          return {
            id: rowFieldOrIndex<string>(row, 'id', 0),
            name: rowFieldOrIndex<string>(row, 'name', 1),
            label: rowFieldOrIndex<string>(row, 'label', 2),
            filePath: rowFieldOrIndex<string>(row, 'filePath', 3),
            content: rowFieldOrIndex<string>(row, 'content', 4) ?? '',
            startLine: rowFieldOrIndex<number>(row, 'startLine', 5),
            endLine: rowFieldOrIndex<number>(row, 'endLine', 6),
            isExported: hasExportedColumn
              ? rowFieldOrIndex<boolean>(row, 'isExported', 7)
              : undefined,
            description:
              rowField<string>(row, 'description') ??
              rowIndex<string>(row, hasExportedColumn ? 8 : 7),
            ...(label === LABEL_METHOD
              ? {
                  parameterCount: rowFieldOrIndex<number>(row, 'parameterCount', 9),
                  returnType: rowFieldOrIndex<string>(row, 'returnType', 10),
                }
              : {}),
          };
        });

        yield pageNodes;
        if (pageNodes.length < NODE_PAGE_SIZE) break;
        offset += NODE_PAGE_SIZE;
      } catch (error) {
        if (isDev) {
          console.warn(`Paged query for ${label} nodes failed:`, error);
        }
        break;
      }
    }
  }
}

/**
 * Get total count of embeddable nodes
 */
const countEmbeddableNodes = async (executeQuery: ExecuteQuery): Promise<number> => {
  let total = 0;
  for (const label of EMBEDDABLE_LABELS) {
    try {
      const rows = await executeQuery(`MATCH (n:\`${label}\`) RETURN count(n) AS count`);
      const row = rows[0];
      total += Number(row ? (rowFieldOrIndex<number>(row, 'count', 0) ?? 0) : 0);
    } catch {
      // ignore
    }
  }
  return total;
};

/**
 * Batch INSERT chunk-aware embeddings into CodeEmbedding table
 */
export const batchInsertEmbeddings = async (
  executeWithReusedStatement: ExecuteWithReusedStatement,
  updates: Array<{
    nodeId: string;
    chunkIndex: number;
    startLine: number;
    endLine: number;
    embedding: number[];
    contentHash?: string;
  }>,
): Promise<void> => {
  const cypher = `CREATE (e:${EMBEDDING_TABLE_NAME} {id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, startLine: $startLine, endLine: $endLine, embedding: $embedding, contentHash: $contentHash})`;
  const paramsList: EmbeddingInsertParams[] = updates.map((u) => ({
    id: `${u.nodeId}:${u.chunkIndex}`,
    nodeId: u.nodeId,
    chunkIndex: u.chunkIndex,
    startLine: u.startLine,
    endLine: u.endLine,
    embedding: u.embedding,
    contentHash: u.contentHash ?? STALE_HASH_SENTINEL,
  }));
  await executeWithReusedStatement(cypher, paramsList);
};

/**
 * Create the vector index for semantic search

 * Now indexes the separate CodeEmbedding table.
 * Delegates extension loading to lbug-adapter's loadVectorExtension(),
 * which owns the VECTOR extension lifecycle and state tracking.

 */
const createVectorIndex = async (executeQuery: ExecuteQuery): Promise<void> => {
  // Delegate to the adapter which tracks loaded state and handles DB reconnect resets
  await loadVectorExtension();

  try {
    await executeQuery(CREATE_VECTOR_INDEX_QUERY);
  } catch (error) {
    if (isDev) {
      console.warn('Vector index creation warning:', error);
    }
  }
};

/**
 * Run the embedding pipeline
 *
 * @param executeQuery - Function to execute Cypher queries against LadybugDB
 * @param executeWithReusedStatement - Function to execute with reused prepared statement
 * @param onProgress - Callback for progress updates
 * @param config - Optional configuration override
 * @param skipNodeIds - Optional set of node IDs that already have embeddings (incremental mode)
 * @param context - Optional repo/server context for metadata enrichment
 * @param existingEmbeddings - Optional map of nodeId → contentHash for incremental mode.
 *        Nodes whose hash matches are skipped; nodes with a changed hash are DELETE'd
 *        and re-embedded; nodes not in the map are embedded fresh.

 */
export const runEmbeddingPipeline = async (
  executeQuery: ExecuteQuery,
  executeWithReusedStatement: ExecuteWithReusedStatement,
  onProgress: EmbeddingProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  skipNodeIds?: Set<string>,
  context?: EmbeddingContext,
  existingEmbeddings?: Map<string, string>,
  signal?: AbortSignal,
): Promise<void> => {
  const startTime = Date.now();
  const timings: Record<string, number> = {};
  const finalConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config };
  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    const reason = signal.reason instanceof Error ? signal.reason.message : signal.reason;
    throw new Error(reason ? `Embedding cancelled: ${reason}` : 'Embedding cancelled');
  };

  try {
    throwIfAborted();
    // Phase 1: Load embedding model
    onProgress({
      phase: 'loading-model',
      percent: 0,
      modelDownloadPercent: 0,
    });

    const modelStartTime = Date.now();
    if (!isEmbedderReady()) {
      await initEmbedder((modelProgress: ModelProgress) => {
        throwIfAborted();
        const downloadPercent = modelProgress.progress ?? 0;
        onProgress({
          phase: 'loading-model',
          percent: Math.round(downloadPercent * 0.2),
          modelDownloadPercent: downloadPercent,
        });
      }, finalConfig);
    }
    throwIfAborted();
    timings.loadModel = Date.now() - modelStartTime;

    onProgress({
      phase: 'loading-model',
      percent: 20,
      modelDownloadPercent: 100,
    });

    if (isDev) {
      console.log('🔍 Counting embeddable nodes...');
    }

    const totalNodes = await countEmbeddableNodes(executeQuery);
    throwIfAborted();
    if (totalNodes === 0) {
      await createVectorIndex(executeQuery);
      onProgress({ phase: 'ready', percent: 100, nodesProcessed: 0, totalNodes: 0 });
      return;
    }

    onProgress({
      phase: 'embedding',
      percent: 20,
      nodesProcessed: 0,
      totalNodes,
      currentBatch: 0,
      totalBatches: Math.ceil(totalNodes / NODE_PAGE_SIZE),
    });

    let processedNodes = 0;
    let totalChunks = 0;
    let pageIndex = 0;
    const embedStartTime = Date.now();

    // Process nodes using paged generator
    for await (const pageNodes of queryEmbeddableNodesPaged(executeQuery)) {
      throwIfAborted();
      pageIndex++;
      let activeNodes = pageNodes;

      // Apply context metadata
      if (context?.repoName) {
        for (const node of activeNodes) {
          node.repoName = context.repoName;
          node.serverName = context.serverName;
        }
      }

      // Incremental mode
      const computedStaleHashes = new Map<string, string>();
      if (existingEmbeddings && existingEmbeddings.size > 0) {
        const staleNodeIds: string[] = [];
        activeNodes = activeNodes.filter((n) => {
          const existingHash = existingEmbeddings.get(n.id);
          if (existingHash === undefined) return true;
          const currentHash = contentHashForNode(n, finalConfig);
          if (currentHash !== existingHash) {
            computedStaleHashes.set(n.id, currentHash);
            staleNodeIds.push(n.id);
            return true;
          }
          return false;
        });

        if (staleNodeIds.length > 0) {
          try {
            await executeWithReusedStatement(
              `MATCH (e:${EMBEDDING_TABLE_NAME} {nodeId: $nodeId}) DELETE e`,
              staleNodeIds.map((nodeId) => ({ nodeId })),
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('does not exist')) {
              throw new Error(
                `[embed] stale-delete failed — vector-index may be inconsistent: ${msg}`,
                { cause: err },
              );
            }
            // fallthrough: 'does not exist' is benign (table not yet created); ignore
          }
        }
      }

      // Phase 3: Chunk + embed page nodes in smaller batches
      const batchSize = finalConfig.batchSize;
      const chunkSize = finalConfig.chunkSize;
      const overlap = finalConfig.overlap;

      for (let batchIndex = 0; batchIndex < activeNodes.length; batchIndex += batchSize) {
        throwIfAborted();
        const batch = activeNodes.slice(batchIndex, batchIndex + batchSize);
        const allTexts: string[] = [];
        const allUpdates: Array<{
          nodeId: string;
          chunkIndex: number;
          startLine: number;
          endLine: number;
          contentHash: string;
        }> = [];

        // Bounded concurrency for structural extraction
        for (let j = 0; j < batch.length; j += EXTRACTION_CONCURRENCY) {
          throwIfAborted();
          const extractionBatch = batch.slice(j, j + EXTRACTION_CONCURRENCY);
          await Promise.all(
            extractionBatch.map(async (node) => {
              if (!isShortLabel(node.label) && STRUCTURAL_LABELS.has(node.label)) {
                try {
                  const names = await extractStructuralNames(node.content, node.filePath);
                  node.methodNames = names.methodNames;
                  node.fieldNames = names.fieldNames;
                } catch {
                  /* ignore */
                }
              }
            }),
          );
        }

        for (const node of batch) {
          throwIfAborted();
          const isShort = isShortLabel(node.label);
          const hash = computedStaleHashes.get(node.id) ?? contentHashForNode(node, finalConfig);

          let chunks: Array<{
            text: string;
            chunkIndex: number;
            startLine: number;
            endLine: number;
          }>;
          if (isShort) {
            chunks = [
              {
                text: node.content,
                chunkIndex: 0,
                startLine: node.startLine ?? 0,
                endLine: node.endLine ?? 0,
              },
            ];
          } else {
            try {
              chunks = await chunkNode(
                node.label,
                node.content,
                node.filePath,
                node.startLine ?? 0,
                node.endLine ?? 0,
                chunkSize,
                overlap,
              );
            } catch (chunkErr) {
              if (isDev) {
                console.warn(
                  `AST chunking failed for ${node.label} "${node.name}" (${node.filePath}); falling back to character chunking:`,
                  chunkErr,
                );
              }
              chunks = characterChunk(
                node.content,
                node.startLine ?? 0,
                node.endLine ?? 0,
                chunkSize,
                overlap,
              );
            }
          }

          let prevTail = '';
          for (const chunk of chunks) {
            const text = generateEmbeddingText(
              node,
              chunk.text,
              finalConfig,
              chunk.chunkIndex,
              prevTail,
            );
            allTexts.push(text);
            allUpdates.push({
              nodeId: node.id,
              chunkIndex: chunk.chunkIndex,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              contentHash: hash,
            });
            prevTail = overlap > 0 ? chunk.text.slice(-overlap) : '';
          }
        }

        // Embed in sub-batches
        const EMBED_SUB_BATCH = 8;
        for (let si = 0; si < allTexts.length; si += EMBED_SUB_BATCH) {
          throwIfAborted();
          const subTexts = allTexts.slice(si, si + EMBED_SUB_BATCH);
          const subUpdates = allUpdates.slice(si, si + EMBED_SUB_BATCH);

          let embeddings: Float32Array[];
          try {
            embeddings = await embedBatch(subTexts);
          } catch (embedErr) {
            console.error(
              `❌ embedBatch failed for ${subTexts.length} texts (first: "${subTexts[0]?.substring(0, 80)}..."):`,
              embedErr,
            );
            throw embedErr;
          }
          throwIfAborted();

          const dbUpdates = subUpdates.map((u, i) => ({
            ...u,
            embedding: embeddingToArray(embeddings[i]),
          }));
          await batchInsertEmbeddings(executeWithReusedStatement, dbUpdates);
        }

        totalChunks += allUpdates.length;
      }

      processedNodes += pageNodes.length;
      const embeddingProgress = 20 + (processedNodes / totalNodes) * 70;
      onProgress({
        phase: 'embedding',
        percent: Math.round(embeddingProgress),
        nodesProcessed: processedNodes,
        totalNodes,
        currentBatch: pageIndex,
        totalBatches: Math.ceil(totalNodes / NODE_PAGE_SIZE),
      });
    }

    timings.embedding = Date.now() - embedStartTime;

    // Phase 4: Create vector index
    throwIfAborted();
    onProgress({ phase: 'indexing', percent: 90, nodesProcessed: totalNodes, totalNodes });
    const indexStartTime = Date.now();
    await createVectorIndex(executeQuery);
    timings.indexing = Date.now() - indexStartTime;

    onProgress({ phase: 'ready', percent: 100, nodesProcessed: totalNodes, totalNodes });
    timings.total = Date.now() - startTime;

    if (isDev) {
      console.log('✅ Embedding pipeline complete!', timings);
    }
  } catch (error) {
    onProgress({
      phase: 'error',
      percent: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
};

/**
 * Perform semantic search using the vector index with chunk deduplication
 */
export const semanticSearch = async (
  executeQuery: ExecuteQuery,
  query: string,
  k: number = 10,
  maxDistance: number = 0.5,
): Promise<SemanticSearchResult[]> => {
  if (!isEmbedderReady()) {
    throw new Error('Embedding model not initialized. Run embedding pipeline first.');
  }

  const queryEmbedding = await embedText(query);
  const queryVec = embeddingToArray(queryEmbedding);
  const queryVecStr = `[${queryVec.join(',')}]`;

  const bestChunks = await collectBestChunks(k, async (fetchLimit) => {
    const vectorQuery = `
      CALL QUERY_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}',
        CAST(${queryVecStr} AS FLOAT[${queryVec.length}]), ${fetchLimit})
      YIELD node AS emb, distance
      WITH emb, distance
      WHERE distance < ${maxDistance}
      RETURN emb.nodeId AS nodeId, emb.chunkIndex AS chunkIndex,
             emb.startLine AS startLine, emb.endLine AS endLine, distance
      ORDER BY distance
    `;

    const embResults = await executeQuery(vectorQuery);
    return embResults.map(
      (row): SemanticChunkRow => ({
        nodeId: rowFieldOrIndex<string>(row, 'nodeId', 0) as string,
        chunkIndex: rowFieldOrIndex<number>(row, 'chunkIndex', 1) ?? 0,
        startLine: rowFieldOrIndex<number>(row, 'startLine', 2) ?? 0,
        endLine: rowFieldOrIndex<number>(row, 'endLine', 3) ?? 0,
        distance: rowFieldOrIndex<number>(row, 'distance', 4) as number,
      }),
    );
  });

  if (bestChunks.size === 0) {
    return [];
  }

  // Group results by label for batched metadata queries
  const byLabel = new Map<string, SemanticChunkRow[]>();
  for (const [nodeId, chunk] of Array.from(bestChunks.entries()).slice(0, k)) {
    const labelEndIdx = nodeId.indexOf(':');
    const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push({ nodeId, ...chunk });
  }

  // Batch-fetch metadata per label
  const results: SemanticSearchResult[] = [];

  for (const [label, items] of byLabel) {
    const idList = items.map((i) => `'${i.nodeId.replace(/'/g, "''")}'`).join(', ');
    try {
      const nodeQuery = `
        MATCH (n:\`${label}\`) WHERE n.id IN [${idList}]
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
               n.startLine AS startLine, n.endLine AS endLine
        LIMIT ${items.length}
      `;
      const nodeRows = await executeQuery(nodeQuery);
      const rowMap = new Map<string, QueryRow>();
      for (const row of nodeRows) {
        const id = rowFieldOrIndex<string>(row, 'id', 0);
        if (id !== undefined) {
          rowMap.set(id, row);
        }
      }
      for (const item of items) {
        const nodeRow = rowMap.get(item.nodeId);
        if (nodeRow) {
          results.push({
            nodeId: item.nodeId,
            name: rowFieldOrIndex<string>(nodeRow, 'name', 1) ?? '',
            label,
            filePath: rowFieldOrIndex<string>(nodeRow, 'filePath', 2) ?? '',
            distance: item.distance,
            startLine: item.startLine,
            endLine: item.endLine,
          });
        }
      }
    } catch {
      // Table might not exist, skip
    }
  }

  results.sort((a, b) => a.distance - b.distance);

  return results;
};

/**
 * Semantic search with graph expansion (flattened results)
 */
export const semanticSearchWithContext = async (
  executeQuery: ExecuteQuery,
  query: string,
  k: number = 5,
  _hops: number = 1,
): Promise<SemanticSearchContextResult[]> => {
  const results = await semanticSearch(executeQuery, query, k, 0.5);

  return results.map((r) => ({
    matchId: r.nodeId,
    matchName: r.name,
    matchLabel: r.label,
    matchPath: r.filePath,
    distance: r.distance,
    connectedId: null,
    connectedName: null,
    connectedLabel: null,
    relationType: null,
  }));
};
