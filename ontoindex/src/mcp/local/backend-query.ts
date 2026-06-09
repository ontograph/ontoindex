import {
  executeParameterized,
  executeQuery,
  isLbugReady,
  isWriteQuery,
} from '../../core/lbug/pool-adapter.js';
import { collectBestChunks } from '../../core/embeddings/types.js';
import { EMBEDDING_INDEX_NAME, EMBEDDING_TABLE_NAME } from '../../core/lbug/schema.js';
import { findTopLevelResultLimit } from '../../core/cypher-limit.js';

interface QueryRepoHandle {
  id: string;
}

type QueryErrorResponse = { error: string };
type QueryRow = Record<string, unknown> | readonly unknown[];
type CypherQueryResult = unknown[] | QueryErrorResponse;
type MarkdownCypherResult = { markdown: string; row_count: number };

interface SymbolSearchResult {
  nodeId?: unknown;
  name: unknown;
  type: unknown;
  filePath: unknown;
  startLine?: unknown;
  endLine?: unknown;
  bm25Score?: number;
  distance?: unknown;
}

interface SymbolLookupRow {
  id: unknown;
  name: unknown;
  type: unknown;
  filePath: unknown;
  startLine: unknown;
  endLine: unknown;
}

interface EmbeddingSearchRow {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  distance: number;
}

interface NodeLookupRow {
  name: unknown;
  filePath: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isQueryRow = (value: unknown): value is QueryRow => Array.isArray(value) || isRecord(value);

const rowKeys = (row: QueryRow): string[] => Object.keys(row);

const rowKeyValue = (row: QueryRow, key: string): unknown =>
  (row as unknown as Record<string, unknown>)[key];

const rowIndexValue = (row: QueryRow, index: number): unknown =>
  Array.isArray(row) ? row[index] : undefined;

const rowValueOr = (row: QueryRow, key: string, index: number): unknown => {
  const keyed = isRecord(row) ? row[key] : undefined;
  return keyed || rowIndexValue(row, index);
};

const rowValueNullish = (row: QueryRow, key: string, index: number): unknown => {
  const keyed = isRecord(row) ? row[key] : undefined;
  return keyed ?? rowIndexValue(row, index);
};

const stringifyRowValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const errorMessage = (err: unknown, fallback: string): string => {
  if (err instanceof Error) return err.message || fallback;
  const message = isRecord(err) ? err['message'] : undefined;
  return typeof message === 'string' && message ? message : fallback;
};

const toSymbolLookupRow = (row: QueryRow): SymbolLookupRow => ({
  id: rowValueOr(row, 'id', 0),
  name: rowValueOr(row, 'name', 1),
  type: rowValueOr(row, 'type', 2),
  filePath: rowValueOr(row, 'filePath', 3),
  startLine: rowValueOr(row, 'startLine', 4),
  endLine: rowValueOr(row, 'endLine', 5),
});

const toEmbeddingSearchRow = (row: QueryRow): EmbeddingSearchRow => ({
  nodeId: String(rowValueNullish(row, 'nodeId', 0) ?? ''),
  chunkIndex: Number(rowValueNullish(row, 'chunkIndex', 1) ?? 0),
  startLine: Number(rowValueNullish(row, 'startLine', 2) ?? 0),
  endLine: Number(rowValueNullish(row, 'endLine', 3) ?? 0),
  distance: Number(rowValueNullish(row, 'distance', 4)),
});

const toNodeLookupRow = (row: QueryRow): NodeLookupRow => ({
  name: rowValueNullish(row, 'name', 0) ?? '',
  filePath: rowValueNullish(row, 'filePath', 1) ?? '',
});

/** Valid LadybugDB node labels for safe Cypher query construction */
export const VALID_NODE_LABELS = new Set([
  'File',
  'Folder',
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
  'Community',
  'Process',
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
  'Route',
  'Tool',
]);

/** Vector distance threshold for semantic search. Wider = more recall; narrower = more precision.
 *  Override at runtime via ONTOINDEX_VECTOR_THRESHOLD env var (e.g. set to 0.6 to restore old behaviour).
 */
const VECTOR_DISTANCE_THRESHOLD = (() => {
  const raw = process.env['ONTOINDEX_VECTOR_THRESHOLD'];
  if (!raw) return 0.85;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 2) return 0.85;
  return parsed;
})();

const MAX_MCP_CYPHER_LIMIT = (() => {
  const raw = Number.parseInt(
    process.env.ONTOINDEX_MCP_CYPHER_LIMIT_MAX ?? process.env.ONTOINDEX_API_QUERY_LIMIT_MAX ?? '',
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 50_000) : 5_000;
})();

export function validateMcpCypherLimit(cypher: string): string | null {
  const resultLimit = findTopLevelResultLimit(cypher);
  if (resultLimit.kind === 'missing') {
    return `MCP Cypher queries must include LIMIT ${MAX_MCP_CYPHER_LIMIT} or lower`;
  }

  if (resultLimit.kind === 'invalid') {
    return 'MCP Cypher query LIMIT must be a positive integer';
  }

  if (resultLimit.limit > MAX_MCP_CYPHER_LIMIT) {
    return `MCP Cypher query LIMIT ${resultLimit.limit} exceeds maximum ${MAX_MCP_CYPHER_LIMIT}`;
  }

  return null;
}

const isExpectedEmbeddingUnavailableError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /CodeEmbedding.*(does not exist|not found)/i.test(msg) ||
    /(table|relation).*CodeEmbedding.*(does not exist|not found)/i.test(msg) ||
    msg.includes('Embedding model not initialized')
  );
};

export async function queryCypher(
  repo: QueryRepoHandle,
  params: { query: string },
): Promise<CypherQueryResult> {
  if (!isLbugReady(repo.id)) {
    return { error: 'LadybugDB not ready. Index may be corrupted.' };
  }

  if (isWriteQuery(params.query)) {
    return {
      error:
        'Write operations (CREATE, DELETE, SET, MERGE, REMOVE, DROP, ALTER, COPY, DETACH) are not allowed. The knowledge graph is read-only.',
    };
  }

  const limitError = validateMcpCypherLimit(params.query);
  if (limitError) return { error: limitError };

  try {
    return await executeQuery(repo.id, params.query);
  } catch (err) {
    return { error: errorMessage(err, 'Query failed') };
  }
}

/**
 * Format raw Cypher result rows as a markdown table for LLM readability.
 * Falls back to raw result if rows aren't tabular objects.
 */
export function formatCypherAsMarkdown(
  result: unknown,
): MarkdownCypherResult | QueryErrorResponse | unknown {
  if (!Array.isArray(result) || result.length === 0) return result;

  const firstRow = result[0];
  if (!isQueryRow(firstRow)) return result;

  const keys = rowKeys(firstRow);
  if (keys.length === 0) return result;

  const header = '| ' + keys.join(' | ') + ' |';
  const separator = '| ' + keys.map(() => '---').join(' | ') + ' |';
  const dataRows = result.map((row) => {
    if (!isQueryRow(row)) return '| ' + keys.map(() => '').join(' | ') + ' |';
    return '| ' + keys.map((key) => stringifyRowValue(rowKeyValue(row, key))).join(' | ') + ' |';
  });

  return {
    markdown: [header, separator, ...dataRows].join('\n'),
    row_count: result.length,
  };
}

/**
 * BM25 keyword search helper - uses LadybugDB FTS for always-fresh results
 */
export async function bm25Search(
  repo: QueryRepoHandle,
  query: string,
  limit: number,
): Promise<{ results: SymbolSearchResult[]; ftsUsed: boolean }> {
  const { searchFTSFromLbug } = await import('../../core/search/bm25-index.js');
  let bm25Results;
  try {
    bm25Results = await searchFTSFromLbug(query, limit, repo.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('OntoIndex: BM25/FTS search failed (FTS indexes may not exist) -', msg);
    return { results: [], ftsUsed: false };
  }

  const ftsUsed = bm25Results.length === 0 || bm25Results[0]?.ftsUsed !== false;

  const results: SymbolSearchResult[] = [];

  for (const bm25Result of bm25Results) {
    const fullPath = bm25Result.filePath;
    try {
      // Prefer direct nodeId lookup (exact FTS-matched nodes) over filePath fallback.
      // Without this, LIMIT 3 on filePath returns arbitrary symbols rather than
      // the nodes that actually scored highest in the BM25 index.
      const nodeIds = bm25Result.nodeIds?.length ? bm25Result.nodeIds : null;
      const symbols = nodeIds
        ? await executeParameterized(
            repo.id,
            `
            MATCH (n)
            WHERE n.id IN $nodeIds
            RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
          `,
            { nodeIds },
          )
        : await executeParameterized(
            repo.id,
            `
            MATCH (n)
            WHERE n.filePath = $filePath
            RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
            LIMIT 3
          `,
            { filePath: fullPath },
          );

      const symbolRows = symbols.filter(isQueryRow).map(toSymbolLookupRow);
      if (symbolRows.length > 0) {
        for (const sym of symbolRows) {
          results.push({
            nodeId: sym.id,
            name: sym.name,
            type: sym.type,
            filePath: sym.filePath,
            startLine: sym.startLine,
            endLine: sym.endLine,
            bm25Score: bm25Result.score,
          });
        }
      } else {
        const fileName = fullPath.split('/').pop() || fullPath;
        results.push({
          name: fileName,
          type: 'File',
          filePath: bm25Result.filePath,
          bm25Score: bm25Result.score,
        });
      }
    } catch {
      const fileName = fullPath.split('/').pop() || fullPath;
      results.push({
        name: fileName,
        type: 'File',
        filePath: bm25Result.filePath,
        bm25Score: bm25Result.score,
      });
    }
  }

  return { results, ftsUsed };
}

/**
 * Semantic vector search helper
 *
 * @param intentModelOverride  Optional model id selected by the intent router.
 *   When provided and the embedder has not yet been initialised, temporarily
 *   sets ONTOINDEX_EMBEDDING_MODEL so that initEmbedder() picks the right model
 *   on its first (lazy) load.  Has no effect once the singleton is warm.
 */
export async function semanticSearch(
  repo: QueryRepoHandle,
  query: string,
  limit: number,
  intentModelOverride?: string,
): Promise<SymbolSearchResult[]> {
  try {
    // Check if embedding table exists before loading the model. Use an existence
    // probe instead of COUNT(*) so every MCP query does not scan the full table.
    const tableCheck = await executeQuery(
      repo.id,
      `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId LIMIT 1`,
    );
    if (!tableCheck.length) return [];

    const { embedQuery, getEmbeddingDims, isEmbedderReady } = await import('../core/embedder.js');

    // Apply intent-based model override on cold-start path only.
    // Once the singleton embedder is warm, the model is fixed for the process
    // lifetime — the override is a no-op but is still captured in query_intent.
    if (intentModelOverride && !isEmbedderReady()) {
      process.env.ONTOINDEX_EMBEDDING_MODEL = intentModelOverride;
    }

    const queryVec = await embedQuery(query);
    const dims = getEmbeddingDims();
    const queryVecStr = `[${queryVec.join(',')}]`;

    const bestChunks = await collectBestChunks(limit, async (fetchLimit) => {
      const vectorQuery = `
        CALL QUERY_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}',
          CAST(${queryVecStr} AS FLOAT[${dims}]), ${fetchLimit})
        YIELD node AS emb, distance
        WITH emb, distance
        WHERE distance < ${VECTOR_DISTANCE_THRESHOLD}
        RETURN emb.nodeId AS nodeId, emb.chunkIndex AS chunkIndex,
               emb.startLine AS startLine, emb.endLine AS endLine, distance
        ORDER BY distance
      `;

      const embResults = await executeQuery(repo.id, vectorQuery);
      return embResults.filter(isQueryRow).map(toEmbeddingSearchRow);
    });

    if (bestChunks.size === 0) return [];

    const results: SymbolSearchResult[] = [];

    for (const [nodeId, chunk] of Array.from(bestChunks.entries()).slice(0, limit)) {
      const labelEndIdx = nodeId.indexOf(':');
      const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';

      if (!VALID_NODE_LABELS.has(label)) continue;

      try {
        const nodeQuery =
          label === 'File'
            ? `MATCH (n:File {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`
            : `MATCH (n:\`${label}\` {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`;

        const nodeRows = await executeParameterized(repo.id, nodeQuery, { nodeId });
        const nodeRow = nodeRows.find(isQueryRow);
        if (nodeRow) {
          const node = toNodeLookupRow(nodeRow);
          results.push({
            nodeId,
            name: node.name,
            type: label,
            filePath: node.filePath,
            distance: chunk.distance,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
          });
        }
      } catch {}
    }

    return results;
  } catch (err) {
    // Expected when embeddings are disabled — fall back to BM25-only.
    // Unexpected vector/DB/model errors are logged so degraded search is visible.
    if (!isExpectedEmbeddingUnavailableError(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`OntoIndex [semantic-search]: ${msg}`);
    }
    return [];
  }
}
