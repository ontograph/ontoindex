import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { personalizedPageRank, buildFullAdjacency } from '../../core/graph/pagerank.js';
import { compressSymbol } from '../../core/graph/repomap-compressor.js';
import { estimateTokens } from '../../core/wiki/llm-client.js';
import { enrichCandidateLabels } from './backend-symbol-resolution.js';

// Only the fields repomap actually reads. Keeping this local avoids a
// circular type import from the flat local-backend.ts on main.
type RepoHandle = { readonly id: string };

type RepomapNodeRow = {
  id: string;
  name?: string;
  type: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  description?: string;
};

type RepomapRowKey = keyof RepomapNodeRow;
type RepomapObjectRow = Partial<Record<RepomapRowKey, unknown>>;
type RepomapTupleRow = readonly [
  id?: unknown,
  name?: unknown,
  type?: unknown,
  filePath?: unknown,
  startLine?: unknown,
  endLine?: unknown,
  content?: unknown,
  description?: unknown,
];
type RepomapRawRow = RepomapObjectRow | RepomapTupleRow;

type RepomapRelationshipRow = {
  sourceId: string;
  targetId: string;
  type: string;
};

type RepomapFormat = 'signatures' | 'outline' | 'full' | 'compressed';

type RepomapParams = {
  focus: string[];
  token_budget?: number;
  format?: RepomapFormat;
};

type RepomapSymbol = {
  uid: string;
  name?: string;
  type: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  content: string;
  isFocus: boolean;
  score: number;
};

type RepomapSuccessResult = {
  status: 'success';
  format: RepomapFormat;
  token_budget: number;
  tokens_used: number;
  symbol_count: number;
  symbols: RepomapSymbol[];
  message?: string;
};

type RepomapErrorResult = {
  error: string;
};

type RepomapResult = RepomapSuccessResult | RepomapErrorResult;

const FILE_FOCUS_FETCH_LIMIT = 200;
const SYMBOL_FOCUS_FETCH_LIMIT = 20;
const META_FETCH_LIMIT = 200;

function repomapRowValue(row: RepomapRawRow, key: RepomapRowKey, index: number): unknown {
  const keyedValue = (row as RepomapObjectRow)[key];
  return keyedValue ?? (row as { readonly [index: number]: unknown })[index];
}

function normalizeRepomapRow(row: RepomapRawRow): RepomapNodeRow {
  return {
    id: repomapRowValue(row, 'id', 0) as string,
    name: repomapRowValue(row, 'name', 1) as string | undefined,
    type: (repomapRowValue(row, 'type', 2) ?? '') as string,
    filePath: repomapRowValue(row, 'filePath', 3) as string | undefined,
    startLine: repomapRowValue(row, 'startLine', 4) as number | undefined,
    endLine: repomapRowValue(row, 'endLine', 5) as number | undefined,
    content: repomapRowValue(row, 'content', 6) as string | undefined,
    description: repomapRowValue(row, 'description', 7) as string | undefined,
  };
}

function repomapTypePriority(type: string): number {
  switch (type) {
    case 'Function':
      return 0;
    case 'Method':
      return 1;
    case 'Class':
      return 2;
    case 'Interface':
      return 3;
    case 'Constructor':
      return 4;
    case 'Enum':
      return 5;
    case 'Trait':
      return 6;
    case 'Struct':
      return 7;
    case 'Impl':
      return 8;
    case 'File':
      return 99;
    default:
      return 50;
  }
}

function sortRepomapRows(a: RepomapNodeRow, b: RepomapNodeRow): number {
  const typeDelta = repomapTypePriority(a.type) - repomapTypePriority(b.type);
  if (typeDelta !== 0) return typeDelta;
  const startA = a.startLine ?? Number.MAX_SAFE_INTEGER;
  const startB = b.startLine ?? Number.MAX_SAFE_INTEGER;
  if (startA !== startB) return startA - startB;
  const nameA = a.name ?? '';
  const nameB = b.name ?? '';
  if (nameA !== nameB) return nameA.localeCompare(nameB);
  return a.id.localeCompare(b.id);
}

function dedupeIds(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function resolveRepomapFocusRows(repo: RepoHandle, item: string): Promise<RepomapNodeRow[]> {
  const fileRowsRaw = await executeParameterized(
    repo.id,
    `
    MATCH (n)
    WHERE n.filePath = $item
    RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath,
           n.startLine AS startLine, n.endLine AS endLine, n.content AS content, n.description AS description
    LIMIT ${FILE_FOCUS_FETCH_LIMIT}
  `,
    { item },
  );
  if (fileRowsRaw.length > 0) {
    const fileRows = fileRowsRaw.map(normalizeRepomapRow);
    await enrichCandidateLabels(repo, fileRows);
    const symbolRows = fileRows.filter((row) => row.type !== 'File' && row.type !== 'Folder');
    return (symbolRows.length > 0 ? symbolRows : fileRows).sort(sortRepomapRows);
  }

  const symbolRowsRaw = await executeParameterized(
    repo.id,
    `
    MATCH (n)
    WHERE n.id = $item OR n.name = $item
    RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath,
           n.startLine AS startLine, n.endLine AS endLine, n.content AS content, n.description AS description
    LIMIT ${SYMBOL_FOCUS_FETCH_LIMIT}
  `,
    { item },
  );
  if (symbolRowsRaw.length === 0) return [];

  const symbolRows = symbolRowsRaw.map(normalizeRepomapRow);
  await enrichCandidateLabels(repo, symbolRows);
  return symbolRows.sort(sortRepomapRows);
}

/**
 * Repomap tool — graph-ranked context summary.
 *
 * 1. Resolves focus items to graph nodes (seeds)
 * 2. Fetches entire call/import graph (cached in-memory for PageRank)
 * 3. Ranks all symbols via Personalized PageRank
 * 4. Fetch signatures/code for top symbols within token budget
 * 5. Optional 'compressed' format prunes implementation bodies
 */
export async function runRepomap(repo: RepoHandle, params: RepomapParams): Promise<RepomapResult> {
  const { focus, token_budget = 4000, format = 'signatures' } = params;

  if (!focus || focus.length === 0) {
    return { error: 'At least one focus item is required.' };
  }

  // Step 1: Resolve focus seeds
  const seedRows: RepomapNodeRow[] = [];
  for (const item of focus) {
    seedRows.push(...(await resolveRepomapFocusRows(repo, item)));
  }
  const seedArray = dedupeIds(seedRows.map((row) => row.id));
  const seedIds = new Set<string>(seedArray);

  // Step 2: Fetch local graph relationships for PageRank
  // We fetch nodes and relationships within depth 2 of the seeds to keep it fast
  // but still provide good context.
  if (seedArray.length === 0) {
    return {
      status: 'success',
      format,
      token_budget,
      tokens_used: 0,
      symbol_count: 0,
      symbols: [],
      message: 'No focus items matched any indexed symbols.',
    };
  }

  const relRows = await executeParameterized<RepomapRelationshipRow>(
    repo.id,
    `
    MATCH (s)-[r:CodeRelation]->(t)
    WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
      AND (s.id IN $seedIds OR t.id IN $seedIds)
    RETURN s.id AS sourceId, t.id AS targetId, r.type AS type
    LIMIT 2000
  `,
    { seedIds: seedArray },
  );

  const { adjacency, reverse } = buildFullAdjacency(relRows);

  // Step 3: Run Personalized PageRank
  const scores = personalizedPageRank(adjacency, reverse, seedIds);

  // Step 4: Rank nodes
  const scoredNodeIds = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map((e) => e[0]);
  const rankedNodeIds = dedupeIds([...seedArray, ...scoredNodeIds]);

  // Step 5: Fetch metadata in bulk (up to some reasonable limit to keep query fast)
  const metaRows: RepomapRawRow[] = await executeParameterized(
    repo.id,
    `
    MATCH (n)
    WHERE n.id IN $nodeIds
    RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath,
           n.startLine AS startLine, n.endLine AS endLine, n.content AS content, n.description AS description
  `,
    { nodeIds: rankedNodeIds.slice(0, META_FETCH_LIMIT) },
  );
  const normalizedMetaRows = metaRows.map(normalizeRepomapRow);
  await enrichCandidateLabels(repo, normalizedMetaRows);

  const metaMap = new Map<string, RepomapNodeRow>();
  for (const row of normalizedMetaRows) metaMap.set(row.id, row);

  // Step 6: Fill budget
  const symbols: RepomapSymbol[] = [];
  let currentTokens = 0;

  for (const nodeId of rankedNodeIds) {
    if (currentTokens >= token_budget) break;

    const n = metaMap.get(nodeId);
    if (!n) continue;

    const nodeType = n.type || 'Unknown';
    let code = n.content || '';
    if (format === 'compressed' || format === 'signatures') {
      code = compressSymbol(nodeType, code);
    }

    const symbolEntry = {
      uid: n.id,
      name: n.name,
      type: nodeType,
      filePath: n.filePath,
      startLine: n.startLine,
      endLine: n.endLine,
      content: code,
      isFocus: seedIds.has(n.id),
      score: scores.get(n.id) ?? 0,
    };

    const tokens = estimateTokens(JSON.stringify(symbolEntry));
    if (currentTokens + tokens <= token_budget) {
      symbols.push(symbolEntry);
      currentTokens += tokens;
    }
  }

  return {
    status: 'success',
    format,
    token_budget,
    tokens_used: currentTokens,
    symbol_count: symbols.length,
    symbols,
  };
}
