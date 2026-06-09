import type {
  QueryFreshnessStatus,
  QueryCapabilityHealth,
  QueryFreshnessState,
} from '../../core/runtime/query-diagnostics.js';
import {
  createQueryTokenCostSnapshot,
  type QueryTokenCostSnapshot,
  type QueryTokenCostSnapshotInput,
} from '../../core/runtime/query-budget.js';
import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { PhaseTimer } from '../../core/search/phase-timer.js';
import {
  type GraphPathEdge,
  type GraphPathReport,
  computeGraphPathWithDiagnostics,
} from '../../core/search/graph-path.js';
import {
  bm25Search as bm25SearchImpl,
  semanticSearch as semanticSearchImpl,
} from './backend-query.js';
import {
  mergeSymbolsWithRRF,
  type EnrichedSymbolRow,
  type RRFTraceEntry,
} from '../../core/search/symbol-merge.js';
import { applyEnsemble, MIN_VEC_POOL_SIZE } from '../../core/search/per-intent-ensemble.js';
import { graphTraversalRank, type GraphEdgeType } from '../../core/search/graph-traversal-rank.js';
import { appendQueryLog } from './query-log.js';
import { getFileSkeleton } from '../../core/search/skeleton.js';
import { SemanticRetrievalCache } from '../../core/search/semantic-cache.js';
import { semanticFrontierSearch, type SemanticFrontierSearchDiagnostics } from '../../core/search/semantic-frontier-search.js';
import {
  adaptAnnNeighborEdgesForFrontier,
  loadAnnNeighborEdges,
} from '../../core/embeddings/ann-neighbor-store.js';
import { classifyIntent, type Intent } from '../../core/search/intent-classifier.js';
import { lspBridge } from '../../core/lsp/bridge.js';
import { EMBEDDING_TABLE_NAME } from '../../core/lbug/schema.js';
import type {
  SearchableTypedQueryLineType,
  TypedQueryLine,
  TypedQueryRequest,
} from '../../core/search/typed-query-document.js';
import { RepoHandle } from './tool-params.js';

type SearchRepoHandle = RepoHandle;

type QueryTuple = {
  [index: number]: unknown;
};

type LookupRow = Record<string, unknown> | readonly unknown[];

interface ProcessLookupRow extends QueryTuple {
  pid?: string;
  label?: string;
  heuristicLabel?: string;
  processType?: string;
  stepCount?: number;
  step?: number;
}

interface CohesionLookupRow extends QueryTuple {
  cohesion?: number;
  module?: string;
}

interface ContentLookupRow extends QueryTuple {
  content?: string;
}

interface CitationLookupRow extends QueryTuple {
  caller?: string;
  type?: string;
  callerPath?: string;
}

interface CitationEntry {
  symbolId: string | null;
  lineSpan: {
    start: number;
    end: number;
  };
  fileSha: string | null;
  graphPath: GraphPathEdge[];
  passiveFacts?: GraphPathEdge[];
  traversalStrategy?: string;
  diagnostics?: GraphPathReport;
  confidence?: number;
}

interface SymbolEntry {
  id: string;
  name?: string;
  type?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  citation_path?: string;
  module?: string;
  content?: string;
  ceScore?: number;
  citations?: CitationEntry[];
  passiveFacts?: GraphPathEdge[];
}

interface ProcessSymbolEntry extends SymbolEntry {
  process_id: string;
  step_index?: number;
}

interface DefinitionEntry {
  name?: string;
  type: string;
  filePath: string;
}

interface ProcessBucket {
  id: string;
  label?: string;
  heuristicLabel?: string;
  processType?: string;
  stepCount?: number;
  totalScore: number;
  cohesionBoost: number;
  symbols: ProcessSymbolEntry[];
}

type LspReferences = Awaited<ReturnType<typeof lspBridge.resolveSymbol>>;

interface MutableEnrichedSymbolRow extends EnrichedSymbolRow {
  ceScore?: number;
  fileSha?: string | null;
  lspRefs?: LspReferences;
}

interface BackendSearchOptions {
  task_context?: string;
  goal?: string;
  limit?: number;
  max_symbols?: number;
  include_content?: boolean;
  include_skeleton?: boolean;
  include_citations?: boolean;
  intent_ensemble?: boolean;
  include_lsp_refs?: boolean;
  structured_output?: boolean;
  retrieval_policy?: string;
  token_cost?: QueryTokenCostSnapshotInput;
}

interface PlainBackendSearchParams extends BackendSearchOptions {
  query: string;
  typedQuery?: never;
}

interface TypedBackendSearchParams extends BackendSearchOptions {
  typedQuery: TypedQueryRequest;
  query?: never;
}

export type BackendSearchParams = PlainBackendSearchParams | TypedBackendSearchParams;

export type BackendSearchInput =
  | { mode: 'plain'; query: string }
  | { mode: 'typed'; document: TypedQueryRequest };

type MergedSymbolEntry = [
  string,
  { score: number; data: MutableEnrichedSymbolRow; trace?: RRFTraceEntry[] },
];

interface RetrievalEvidenceReference {
  kind: 'typed-query-line' | 'plain-query';
  query: string;
  source: SearchableTypedQueryLineType;
  lineNumber?: number;
  retrieval: 'exact' | 'bm25' | 'vector' | 'graph' | 'hybrid';
}

export interface RetrievalCandidate {
  id: string;
  kind: 'symbol' | 'file' | 'process' | 'doc' | 'route' | 'module';
  label: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  source: SearchableTypedQueryLineType;
  rawScore?: number;
  evidence: RetrievalEvidenceReference[];
  freshness: QueryFreshnessStatus;
  trace?: RRFTraceEntry[];
  passiveFacts?: GraphPathEdge[];
}

export interface RetrievalCapabilityState extends QueryCapabilityHealth {
  freshness: QueryFreshnessState;
  traversalStrategy?: string;
}

export interface StructuredRetrievalResult {
  candidates: RetrievalCandidate[];
  rows: Record<string, unknown>[];
  capabilityState: RetrievalCapabilityState;
}

type SearchResult =
  | { error: string }
  | {
      abstained: true;
      processes: [];
      process_symbols: [];
      definitions: [];
      timing: {};
    }
  | {
      processes: Array<{
        id: string;
        summary?: string;
        priority: number;
        symbol_count: number;
        process_type?: string;
        step_count?: number;
      }>;
      process_symbols: ProcessSymbolEntry[];
      definitions: Array<DefinitionEntry | SymbolEntry>;
      timing: Record<string, number>;
      query_intent: Intent;
      abstained?: false;
      skeletons?: Record<string, string>;
      warning?: string;
      structured_retrieval?: StructuredRetrievalResult;
    };

interface TypedLaneSearchState {
  bm25Results: EnrichedSymbolRow[];
  semanticResults: EnrichedSymbolRow[];
  graphResults: EnrichedSymbolRow[];
  lockedResults: EnrichedSymbolRow[];
  warnings: string[];
  ftsUsed: boolean;
  capabilitiesUsed: Set<string>;
  capabilitiesMissing: Set<string>;
  candidateMap: Map<string, RetrievalCandidate>;
}

interface FrontierSearchInput {
  nodeId: string;
  vector: number[];
  lanes: string[];
}

interface VectorCarrier {
  vector: number[];
  freshness: QueryFreshnessStatus;
}

interface SymbolNeighborhoodFrontierSearchResult {
  bm25Results: EnrichedSymbolRow[];
  semanticResults: EnrichedSymbolRow[];
  warnings: string[];
  diagnostics?: SemanticFrontierSearchDiagnostics;
  fallbackToDefaultVector: boolean;
}

interface IndexedSymbolNode {
  nodeId: string;
  freshness: QueryFreshnessStatus;
  vector: number[];
}

function logSearchQueryError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`OntoIndex [${context}]: ${msg}`);
}

function logQueryTiming(query: string, phases: Record<string, number>): void {
  const totalMs = phases.wall ?? Object.values(phases).reduce((a, b) => a + b, 0);
  const truncated = query.length > 80 ? `${query.slice(0, 80)}…` : query;
  console.error(
    `OntoIndex [query:timing] query=${JSON.stringify(truncated)} totalMs=${totalMs} phases=${JSON.stringify(phases)}`,
  );
}

function toBackendSearchInput(params: BackendSearchParams): BackendSearchInput {
  if ('typedQuery' in params) {
    return { mode: 'typed', document: params.typedQuery };
  }
  return { mode: 'plain', query: params.query };
}

function rowValue(row: LookupRow, key: string, index: number): unknown {
  if (Array.isArray(row)) {
    return row[index];
  }
  return row[key] ?? row[index];
}

function toEnrichedSymbolRow(row: LookupRow): EnrichedSymbolRow {
  return {
    nodeId: String(rowValue(row, 'id', 0) ?? ''),
    name: String(rowValue(row, 'name', 1) ?? ''),
    type: String(rowValue(row, 'type', 2) ?? ''),
    filePath: String(rowValue(row, 'filePath', 3) ?? ''),
    startLine:
      rowValue(row, 'startLine', 4) === undefined
        ? undefined
        : Number(rowValue(row, 'startLine', 4)),
    endLine:
      rowValue(row, 'endLine', 5) === undefined ? undefined : Number(rowValue(row, 'endLine', 5)),
  };
}

function parseIntEnvVar(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const parseFiniteNumber = (value: unknown): number | undefined => {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
};

const parseEmbeddingVector = (value: unknown): number[] | undefined => {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    const numbers = value
      .map((entry) => parseFiniteNumber(entry))
      .filter((entry): entry is number => entry !== undefined);
    return numbers.length > 0 ? numbers : undefined;
  }
  if (typeof value === 'string') {
    try {
      return parseEmbeddingVector(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'object' && 'length' in (value as { length?: unknown })) {
    const length = parseFiniteNumber((value as { length?: unknown }).length);
    if (!length || length <= 0) return undefined;
    const vector: number[] = [];
    const arrayLike = value as ArrayLike<unknown>;
    for (let index = 0; index < length; index += 1) {
      const entry = parseFiniteNumber(arrayLike[index]);
      if (entry !== undefined) {
        vector.push(entry);
      }
    }
    return vector.length > 0 ? vector : undefined;
  }
  return undefined;
};

function mapSymbolNodeMetadata(row: LookupRow): EnrichedSymbolRow {
  return {
    nodeId: String(rowValue(row, 'nodeId', 0) ?? ''),
    name: String(rowValue(row, 'name', 1) ?? ''),
    type: String(rowValue(row, 'type', 2) ?? ''),
    filePath: String(rowValue(row, 'filePath', 3) ?? ''),
    startLine: parseFiniteNumber(rowValue(row, 'startLine', 4)),
    endLine: parseFiniteNumber(rowValue(row, 'endLine', 5)),
  };
}

function summarizeFrontierDiagnostics(frontier: SemanticFrontierSearchDiagnostics): string[] {
  const lines = [
    `symbol-neighborhood frontier repo=${frontier.repo}`,
    `symbol-neighborhood frontier repoPath=${frontier.repoPath ?? '(unknown)'}`,
    `symbol-neighborhood frontier mode=${frontier.mode}`,
    `symbol-neighborhood frontier freshness=${frontier.indexFreshness}`,
    `symbol-neighborhood frontier visited=${frontier.visited}/${frontier.maxVisited}`,
    `symbol-neighborhood frontier truncated=${frontier.truncated}`,
    `symbol-neighborhood frontier fallback=${frontier.fallbackReason ?? 'none'}`,
  ];
  if (frontier.warnings.length > 0) {
    lines.push(...frontier.warnings.map((warning) => `symbol-neighborhood frontier warning: ${warning}`));
  }
  return lines;
}

async function loadIndexedSymbolVectors(
  repoId: string,
  nodeIds: readonly string[],
): Promise<Map<string, VectorCarrier>> {
  if (nodeIds.length === 0) return new Map();
  const rows = await executeParameterized(
    repoId,
    `
      MATCH (e:${EMBEDDING_TABLE_NAME})
      WHERE e.nodeId IN $nodeIds
      RETURN e.nodeId AS nodeId, e.embedding AS embedding
    `,
    { nodeIds: [...nodeIds] },
  );

  const out = new Map<string, VectorCarrier>();
  for (const row of rows) {
    const nodeId = String(rowValue(row, 'nodeId', 0) ?? '');
    if (!nodeId || out.has(nodeId)) continue;
    const vector = parseEmbeddingVector(rowValue(row, 'embedding', 1));
    if (!vector || vector.length === 0) continue;
    out.set(nodeId, { freshness: 'fresh', vector });
  }
  return out;
}

async function loadSymbolNodesByIds(
  repoId: string,
  nodeIds: readonly string[],
): Promise<Map<string, EnrichedSymbolRow>> {
  if (nodeIds.length === 0) return new Map();
  const rows = await executeParameterized(
    repoId,
    `
      MATCH (n)
      WHERE n.id IN $nodeIds
      RETURN n.id AS nodeId, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
    `,
    { nodeIds: [...nodeIds] },
  );

  const out = new Map<string, EnrichedSymbolRow>();
  for (const row of rows) {
    const mapped = mapSymbolNodeMetadata(row);
    if (!mapped.nodeId) continue;
    out.set(mapped.nodeId, mapped);
  }
  return out;
}

async function runSymbolNeighborhoodFrontierSearch(
  repo: SearchRepoHandle,
  searchQuery: string,
  seedRows: EnrichedSymbolRow[],
  searchLimit: number,
  intentModelOverride: string | undefined,
): Promise<SymbolNeighborhoodFrontierSearchResult> {
  const fallback = (reason: string, details: string[]): SymbolNeighborhoodFrontierSearchResult => ({
    bm25Results: seedRows,
    semanticResults: [],
    warnings: [`symbol-neighborhood skipped: ${reason}`, ...details.filter((line) => line.length > 0)],
    fallbackToDefaultVector: true,
  });

  const seedIds = seedRows
    .map((row) => row.nodeId)
    .filter((nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.length > 0);
  if (seedIds.length === 0) {
    return fallback('no bm25 seed node IDs available', []);
  }

  let queryVector: number[];
  try {
    const { embedQuery, isEmbedderReady } = await import('../core/embedder.js');
    if (intentModelOverride && !isEmbedderReady()) {
      process.env.ONTOINDEX_EMBEDDING_MODEL = intentModelOverride;
    }
    queryVector = await embedQuery(searchQuery);
  } catch {
    return fallback('embedding model unavailable', []);
  }

  const indexedSeedVectors = await loadIndexedSymbolVectors(repo.id, seedIds);
  const frontierSeeds = seedRows
    .map((seed) => {
      if (!seed.nodeId) return undefined;
      const indexed = indexedSeedVectors.get(seed.nodeId);
      if (!indexed?.vector) return undefined;
      return {
        nodeId: seed.nodeId,
        vector: indexed.vector,
        lanes: [seed.type || 'symbol'],
      } satisfies FrontierSearchInput;
    })
    .filter((seed): seed is FrontierSearchInput => seed !== undefined);

  if (frontierSeeds.length === 0) {
    return fallback('no seed embeddings available', []);
  }

  const loadedEdges = await loadAnnNeighborEdges((cypher, params) => {
    return executeParameterized(repo.id, cypher, params ?? {});
  }, {
    sourceIds: frontierSeeds.map((seed) => seed.nodeId),
    includeStale: false,
    maxOutboundDegree: parseIntEnvVar('ONTOINDEX_ANN_MAX_OUTBOUND_DEGREE', 8),
  });
  if (loadedEdges.length === 0) {
    return fallback('no ANN edges found for retrieved seeds', []);
  }

  const frontier = await semanticFrontierSearch({
    repo: repo.id,
    repoPath: repo.repoPath,
    queryVector,
    topK: searchLimit,
    ef: parseIntEnvVar('ONTOINDEX_ANN_FRONTIER_EF', 64),
    maxVisited: parseIntEnvVar('ONTOINDEX_ANN_FRONTIER_MAX_VISITED', 512),
    seeds: frontierSeeds,
    edges: adaptAnnNeighborEdgesForFrontier(loadedEdges),
    freshnessRequired: false,
  });

  const nodeMetadata = await loadSymbolNodesByIds(
    repo.id,
    frontier.results.map((result) => result.nodeId),
  );
  const semanticRows = frontier.results
    .map((result) => {
      const row = nodeMetadata.get(result.nodeId);
      return {
        nodeId: result.nodeId,
        name: result.name || row?.name || '',
        type: row?.type || '',
        filePath: result.filePath || row?.filePath || '',
        startLine: result.startLine ?? row?.startLine,
        endLine: result.endLine ?? row?.endLine,
      } satisfies EnrichedSymbolRow;
    })
    .filter((row) => row.nodeId || row.filePath);

  if (semanticRows.length === 0) {
    return {
      bm25Results: seedRows,
      semanticResults: [],
      diagnostics: frontier,
      warnings: [`symbol-neighborhood frontier produced no merged rows`, ...summarizeFrontierDiagnostics(frontier)],
      fallbackToDefaultVector: true,
    };
  }

  return {
    bm25Results: seedRows,
    semanticResults: semanticRows,
    diagnostics: frontier,
    warnings: summarizeFrontierDiagnostics(frontier),
    fallbackToDefaultVector: false,
  };
}

function dedupeSymbolRows(rows: EnrichedSymbolRow[]): EnrichedSymbolRow[] {
  const seen = new Set<string>();
  const deduped: EnrichedSymbolRow[] = [];
  for (const row of rows) {
    const key = row.nodeId || row.filePath;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function combineWarnings(...warnings: Array<string | undefined>): string | undefined {
  const unique = Array.from(
    new Set(warnings.filter((warning): warning is string => Boolean(warning))),
  );
  return unique.length > 0 ? unique.join(' | ') : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function retrievalKeyForRow(row: EnrichedSymbolRow): string | null {
  const key = row.nodeId || row.filePath;
  return key ? String(key) : null;
}

function retrievalCandidateId(key: string): string {
  return `retrieval:${key}`;
}

function inferRetrievalCandidateKind(row: EnrichedSymbolRow): RetrievalCandidate['kind'] {
  return !row.nodeId || row.type === 'File' ? 'file' : 'symbol';
}

function preferredRetrievalSource(
  current: SearchableTypedQueryLineType,
  next: SearchableTypedQueryLineType,
): SearchableTypedQueryLineType {
  const priority: Record<SearchableTypedQueryLineType, number> = {
    symbol: 5,
    file: 5,
    graph: 4,
    vec: 3,
    hyde: 3,
    lex: 2,
  };
  return priority[next] > priority[current] ? next : current;
}

function createTypedEvidenceReference(
  line: TypedQueryLine,
  retrieval: RetrievalEvidenceReference['retrieval'],
): RetrievalEvidenceReference {
  return {
    kind: 'typed-query-line',
    query: line.query,
    source: line.type,
    lineNumber: line.lineNumber,
    retrieval,
  };
}

function createPlainEvidenceReference(query: string): RetrievalEvidenceReference {
  return {
    kind: 'plain-query',
    query,
    source: 'lex',
    retrieval: 'hybrid',
  };
}

function mergeRetrievalEvidence(
  existing: RetrievalEvidenceReference[],
  next: RetrievalEvidenceReference,
): RetrievalEvidenceReference[] {
  const nextKey = `${next.kind}:${next.source}:${next.lineNumber ?? 0}:${next.retrieval}:${next.query}`;
  for (const entry of existing) {
    const entryKey = `${entry.kind}:${entry.source}:${entry.lineNumber ?? 0}:${entry.retrieval}:${entry.query}`;
    if (entryKey === nextKey) {
      return existing;
    }
  }
  return [...existing, next];
}

function recordRetrievalRows(
  candidateMap: Map<string, RetrievalCandidate>,
  rows: EnrichedSymbolRow[],
  source: SearchableTypedQueryLineType,
  evidence: RetrievalEvidenceReference,
): void {
  for (const row of rows) {
    const key = retrievalKeyForRow(row);
    if (!key) continue;

    const existing = candidateMap.get(key);
    if (existing) {
      existing.source = preferredRetrievalSource(existing.source, source);
      existing.label = existing.label || row.name || row.filePath || key;
      existing.filePath = existing.filePath ?? row.filePath;
      existing.startLine = existing.startLine ?? row.startLine;
      existing.endLine = existing.endLine ?? row.endLine;
      existing.evidence = mergeRetrievalEvidence(existing.evidence, evidence);
      continue;
    }

    candidateMap.set(key, {
      id: retrievalCandidateId(key),
      kind: inferRetrievalCandidateKind(row),
      label: row.name || row.filePath || key,
      filePath: row.filePath,
      startLine: row.startLine,
      endLine: row.endLine,
      source,
      evidence: [evidence],
      freshness: 'unknown',
    });
  }
}

function fallbackRetrievalCandidate(
  row: EnrichedSymbolRow,
  searchQuery: string,
  freshness: QueryFreshnessStatus,
): RetrievalCandidate {
  const key = retrievalKeyForRow(row) ?? `${row.name ?? row.filePath ?? 'candidate'}`;
  return {
    id: retrievalCandidateId(key),
    kind: inferRetrievalCandidateKind(row),
    label: row.name || row.filePath || key,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    source: 'lex',
    evidence: [createPlainEvidenceReference(searchQuery)],
    freshness,
  };
}

function buildStructuredCandidates(
  merged: MergedSymbolEntry[],
  candidateMap: Map<string, RetrievalCandidate> | undefined,
  searchQuery: string,
  freshness: QueryFreshnessStatus,
): RetrievalCandidate[] {
  const seen = new Set<string>();
  const candidates: RetrievalCandidate[] = [];

  for (const [key, item] of merged) {
    if (seen.has(key)) continue;
    seen.add(key);
    const base =
      candidateMap?.get(key) ?? fallbackRetrievalCandidate(item.data, searchQuery, freshness);
    candidates.push({
      ...base,
      rawScore: item.score,
      freshness,
      evidence: [...base.evidence],
      trace: item.trace,
    });
  }

  return candidates;
}

function structuredRowsForCandidates(candidates: RetrievalCandidate[]): Record<string, unknown>[] {
  return candidates.map((candidate) => {
    const row: Record<string, unknown> = {
      id: candidate.id,
      kind: candidate.kind,
      label: candidate.label,
      source: candidate.source,
      freshness: candidate.freshness,
    };
    if (candidate.filePath) row.filePath = candidate.filePath;
    if (candidate.startLine !== undefined) row.startLine = candidate.startLine;
    if (candidate.endLine !== undefined) row.endLine = candidate.endLine;
    if (candidate.rawScore !== undefined) row.rawScore = candidate.rawScore;
    return row;
  });
}

function cachedCandidateSymbolId(candidate: RetrievalCandidate): string | undefined {
  return candidate.id.startsWith('retrieval:')
    ? candidate.id.slice('retrieval:'.length)
    : undefined;
}

function cachedCandidateType(candidate: RetrievalCandidate): string {
  const symbolId = cachedCandidateSymbolId(candidate);
  if (symbolId?.includes(':')) {
    return symbolId.split(':', 1)[0] || candidate.kind;
  }
  return candidate.kind === 'file'
    ? 'File'
    : candidate.kind.charAt(0).toUpperCase() + candidate.kind.slice(1);
}

function definitionsForCachedCandidates(
  candidates: RetrievalCandidate[],
): Array<DefinitionEntry | SymbolEntry> {
  return candidates
    .filter((candidate) => Boolean(candidate.filePath))
    .map((candidate) => {
      const symbolId = cachedCandidateSymbolId(candidate);
      const entry = {
        name: candidate.label,
        type: cachedCandidateType(candidate),
        filePath: candidate.filePath!,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
      };
      return symbolId ? { id: symbolId, ...entry } : entry;
    });
}

function formatCapabilityWarning(
  freshness: RetrievalCapabilityState['freshness'],
  missingCapabilities: Set<string>,
  warnings: string[],
): string[] {
  const combined = [...warnings];
  if (missingCapabilities.has('embeddings')) {
    combined.push('Embeddings unavailable; typed retrieval downgraded vector lanes.');
  }
  if (missingCapabilities.has('fts')) {
    combined.push(
      'FTS extension unavailable - keyword search degraded. Run: ontoindex analyze --force to rebuild indexes.',
    );
  }
  if (freshness.status === 'stale') {
    combined.push(`Index freshness stale: ${freshness.reason}.`);
  } else if (freshness.status === 'degraded' || freshness.status === 'unknown') {
    combined.push(`Index freshness ${freshness.status}: ${freshness.reason}.`);
  }
  return uniqueStrings(combined);
}

async function buildStructuredRetrievalResult(input: {
  repo: SearchRepoHandle;
  merged: MergedSymbolEntry[];
  searchQuery: string;
  warnings: string[];
  capabilitiesUsed: Iterable<string>;
  capabilitiesMissing: Iterable<string>;
  candidateMap?: Map<string, RetrievalCandidate>;
  filters?: TypedQueryRequest['filters'];
  tokenCost: QueryTokenCostSnapshot;
}): Promise<StructuredRetrievalResult> {
  let freshness: RetrievalCapabilityState['freshness'] = {
    status: 'unknown',
    actionable: false,
    reason: 'target-context-unavailable',
  };
  const targetWarnings: string[] = [];
  const usedCapabilities = new Set(input.capabilitiesUsed);
  const missingCapabilities = new Set(input.capabilitiesMissing);
  const tokenCost = input.tokenCost;

  try {
    const [{ resolveTargetContext }, { deriveEnvelopeFreshness }] = await Promise.all([
      import('../shared/target-context.js'),
      import('../shared/response-envelope.js'),
    ]);
    const targetContext = await resolveTargetContext({ repo: input.repo.id });
    freshness = deriveEnvelopeFreshness(targetContext);
    targetWarnings.push(...targetContext.warnings);
    if (targetContext.embeddings.status !== 'available') {
      missingCapabilities.add('embeddings');
    }
  } catch (err) {
    targetWarnings.push(
      `Structured retrieval target context unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const capabilityState: RetrievalCapabilityState = {
    freshness,
    capabilitiesUsed: uniqueStrings([...input.capabilitiesUsed]),
    capabilitiesMissing: uniqueStrings([...missingCapabilities]),
    warnings: formatCapabilityWarning(freshness, missingCapabilities, [
      ...input.warnings,
      ...targetWarnings,
      ...tokenCost.warnings,
    ]),
    lanes: {
      lex: { status: 'available' },
      graph: { status: 'available' },
      vector: {
        status: usedCapabilities.has('embeddings')
          ? 'available'
          : missingCapabilities.has('embeddings')
            ? 'unavailable'
            : 'not-used',
        reason: missingCapabilities.has('embeddings') ? 'embeddings-not-populated' : undefined,
      },
    },
    traversalStrategy: 'weighted-bfs',
    tokenCost,
  };

  try {
    const { loadMeta } = await import('../../storage/repo-manager.js');
    const meta = await loadMeta(input.repo.id);
    if (meta?.model_hash) {
      capabilityState.embeddingModelHash = meta.model_hash;
    }
  } catch {
    // ignore meta load failures for health reporting
  }

  const allCandidates = buildStructuredCandidates(
    input.merged,
    input.candidateMap,
    input.searchQuery,
    capabilityState.freshness.status,
  );

  let filteredCandidates = allCandidates;
  if (input.filters && input.filters.length > 0) {
    filteredCandidates = allCandidates.filter((candidate) => {
      for (const filter of input.filters!) {
        let value: any = undefined;
        if (filter.field === 'kind' || filter.field === 'filePath') {
          value = candidate[filter.field];
        } else if (filter.field === 'repo') {
          value = input.repo.id;
        } else if (filter.field === 'language') {
          if (candidate.filePath) {
            const ext = candidate.filePath.split('.').pop()?.toLowerCase();
            if (ext === 'ts' || ext === 'tsx') value = 'typescript';
            else if (ext === 'js' || ext === 'jsx') value = 'javascript';
            else if (ext === 'py') value = 'python';
            else if (ext === 'rs') value = 'rust';
            else if (ext === 'go') value = 'go';
            else if (ext === 'md') value = 'markdown';
            else if (
              ext === 'cpp' ||
              ext === 'cc' ||
              ext === 'cxx' ||
              ext === 'c' ||
              ext === 'h' ||
              ext === 'hpp'
            )
              value = 'cpp';
            else value = ext;
          }
        } else if (filter.field === 'freshness') {
          value = candidate.freshness;
        } else if (filter.field === 'capability') {
          value = candidate.evidence.map((e) => e.retrieval);
        }

        const stringValue = String(value);
        if (filter.operator === '=') {
          if (filter.field === 'capability' && Array.isArray(value)) {
            if (!value.includes(filter.value)) return false;
          } else {
            if (stringValue !== filter.value) return false;
          }
        } else if (filter.operator === '!=') {
          if (filter.field === 'capability' && Array.isArray(value)) {
            if (value.includes(filter.value)) return false;
          } else {
            if (stringValue === filter.value) return false;
          }
        } else if (filter.operator === '~') {
          if (filter.field === 'capability' && Array.isArray(value)) {
            if (!value.some((v) => v.includes(filter.value))) return false;
          } else {
            if (!stringValue.includes(filter.value)) return false;
          }
        }
      }
      return true;
    });
  }

  const rows = structuredRowsForCandidates(filteredCandidates);

  return {
    candidates: filteredCandidates,
    rows,
    capabilityState,
  };
}

function classificationQueryForTypedInput(document: TypedQueryRequest): string {
  if (document.intent?.trim()) {
    return document.intent.trim();
  }
  return document.lines
    .map((line) => line.query.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function embeddingsAvailable(repoId: string): Promise<boolean> {
  try {
    const rows = await executeParameterized(
      repoId,
      `MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId LIMIT 1`,
      {},
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function exactSymbolLookup(
  repoId: string,
  symbolQuery: string,
  limit: number,
): Promise<EnrichedSymbolRow[]> {
  const rows = await executeParameterized(
    repoId,
    `
      MATCH (n)
      WHERE n.id = $symbolQuery OR n.name = $symbolQuery
      RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
      LIMIT ${Math.max(1, Math.min(limit, 20))}
    `,
    { symbolQuery },
  );
  return dedupeSymbolRows(
    (rows as LookupRow[]).map(toEnrichedSymbolRow).filter((row) => row.filePath),
  );
}

async function exactFileLookup(
  repoId: string,
  fileQuery: string,
  limit: number,
): Promise<EnrichedSymbolRow[]> {
  const fileName = fileQuery.split('/').pop() || fileQuery;
  const rows = await executeParameterized(
    repoId,
    `
      MATCH (n:File)
      WHERE n.filePath = $fileQuery OR n.name = $fileName OR n.filePath ENDS WITH $suffix
      RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine,
             CASE
               WHEN n.filePath = $fileQuery THEN 0
               WHEN n.name = $fileName THEN 1
               ELSE 2
             END AS matchRank
      ORDER BY matchRank ASC, n.filePath ASC
      LIMIT ${Math.max(1, Math.min(limit, 20))}
    `,
    { fileQuery, fileName, suffix: `/${fileName}` },
  );
  return dedupeSymbolRows(
    (rows as LookupRow[]).map(toEnrichedSymbolRow).filter((row) => row.filePath),
  );
}

function prependLockedResults(
  merged: MergedSymbolEntry[],
  lockedResults: EnrichedSymbolRow[],
): MergedSymbolEntry[] {
  if (lockedResults.length === 0) return merged;

  const lockedKeys = new Set(lockedResults.map((row) => row.nodeId || row.filePath));
  const unlocked = merged.filter(([key]) => !lockedKeys.has(key));
  const prefixScoreBase = (unlocked[0]?.[1].score ?? 0) + lockedResults.length + 1;

  const lockedEntries = lockedResults.map(
    (row, index): MergedSymbolEntry => [
      row.nodeId || row.filePath,
      {
        score: prefixScoreBase - index * 0.000001,
        data: row,
      },
    ],
  );

  return [...lockedEntries, ...unlocked];
}

async function routeTypedQuery(
  repo: SearchRepoHandle,
  document: TypedQueryRequest,
  timer: PhaseTimer,
  searchLimit: number,
  queryIntent: Intent,
  intentConfidence: number | undefined,
  intentEnsembleEnabled: boolean,
  intentModelOverride: string | undefined,
): Promise<TypedLaneSearchState> {
  const state: TypedLaneSearchState = {
    bm25Results: [],
    semanticResults: [],
    graphResults: [],
    lockedResults: [],
    warnings: [],
    ftsUsed: true,
    capabilitiesUsed: new Set(['typed-query']),
    capabilitiesMissing: new Set<string>(),
    candidateMap: new Map<string, RetrievalCandidate>(),
  };

  let cachedEmbeddingsAvailable: boolean | undefined;
  const getEmbeddingsAvailability = async (): Promise<boolean> => {
    if (cachedEmbeddingsAvailable !== undefined) {
      return cachedEmbeddingsAvailable;
    }
    cachedEmbeddingsAvailable = await embeddingsAvailable(repo.id);
    return cachedEmbeddingsAvailable;
  };

  const graphIntentAllowed =
    intentEnsembleEnabled &&
    ['calls-of', 'cross-file-impact'].includes(queryIntent) &&
    (intentConfidence === undefined || intentConfidence >= 0.7);

  for (const line of document.lines) {
    if (line.type === 'lex') {
      const bm25SearchResult = await timer.time(
        'bm25',
        bm25SearchImpl(repo, line.query, searchLimit),
      );
      state.bm25Results.push(...(bm25SearchResult.results as EnrichedSymbolRow[]));
      state.ftsUsed &&= bm25SearchResult.ftsUsed;
      state.capabilitiesUsed.add('bm25');
      recordRetrievalRows(
        state.candidateMap,
        bm25SearchResult.results as EnrichedSymbolRow[],
        line.type,
        createTypedEvidenceReference(line, 'bm25'),
      );
      continue;
    }

    if (line.type === 'vec' || line.type === 'hyde') {
      const hasEmbeddings = await getEmbeddingsAvailability();
      if (!hasEmbeddings) {
        state.capabilitiesMissing.add('embeddings');
        state.warnings.push(
          `Typed ${line.type} line ${line.lineNumber} downgraded: embeddings unavailable.`,
        );
        continue;
      }
      const semanticRows = (await timer.time(
        'vector',
        semanticSearchImpl(repo, line.query, searchLimit, intentModelOverride),
      )) as EnrichedSymbolRow[];
      state.semanticResults.push(...semanticRows);
      state.capabilitiesUsed.add('embeddings');
      state.capabilitiesUsed.add('vector');
      recordRetrievalRows(
        state.candidateMap,
        semanticRows,
        line.type,
        createTypedEvidenceReference(line, 'vector'),
      );
      continue;
    }

    if (line.type === 'symbol') {
      state.capabilitiesUsed.add('exact-symbol-lookup');
      const exactMatches = await exactSymbolLookup(repo.id, line.query, searchLimit);
      if (exactMatches.length > 0) {
        state.lockedResults.push(...exactMatches);
        recordRetrievalRows(
          state.candidateMap,
          exactMatches,
          line.type,
          createTypedEvidenceReference(line, 'exact'),
        );
        continue;
      }

      const hasEmbeddings = await getEmbeddingsAvailability();
      state.warnings.push(
        `Typed symbol line ${line.lineNumber} exact lookup returned no results; falling back to ${hasEmbeddings ? 'BM25 and vector' : 'BM25'}.`,
      );
      const bm25SearchResult = await timer.time(
        'bm25',
        bm25SearchImpl(repo, line.query, searchLimit),
      );
      state.bm25Results.push(...(bm25SearchResult.results as EnrichedSymbolRow[]));
      state.ftsUsed &&= bm25SearchResult.ftsUsed;
      state.capabilitiesUsed.add('bm25');
      recordRetrievalRows(
        state.candidateMap,
        bm25SearchResult.results as EnrichedSymbolRow[],
        line.type,
        createTypedEvidenceReference(line, 'bm25'),
      );
      if (hasEmbeddings) {
        const semanticRows = (await timer.time(
          'vector',
          semanticSearchImpl(repo, line.query, searchLimit, intentModelOverride),
        )) as EnrichedSymbolRow[];
        state.semanticResults.push(...semanticRows);
        state.capabilitiesUsed.add('embeddings');
        state.capabilitiesUsed.add('vector');
        recordRetrievalRows(
          state.candidateMap,
          semanticRows,
          line.type,
          createTypedEvidenceReference(line, 'vector'),
        );
      } else {
        state.capabilitiesMissing.add('embeddings');
      }
      continue;
    }

    if (line.type === 'file') {
      state.capabilitiesUsed.add('exact-file-lookup');
      const exactMatches = await exactFileLookup(repo.id, line.query, searchLimit);
      if (exactMatches.length > 0) {
        state.lockedResults.push(...exactMatches);
        recordRetrievalRows(
          state.candidateMap,
          exactMatches,
          line.type,
          createTypedEvidenceReference(line, 'exact'),
        );
        continue;
      }

      state.warnings.push(
        `Typed file line ${line.lineNumber} exact lookup returned no results; falling back to BM25.`,
      );
      const bm25SearchResult = await timer.time(
        'bm25',
        bm25SearchImpl(repo, line.query, searchLimit),
      );
      state.bm25Results.push(...(bm25SearchResult.results as EnrichedSymbolRow[]));
      state.ftsUsed &&= bm25SearchResult.ftsUsed;
      state.capabilitiesUsed.add('bm25');
      recordRetrievalRows(
        state.candidateMap,
        bm25SearchResult.results as EnrichedSymbolRow[],
        line.type,
        createTypedEvidenceReference(line, 'bm25'),
      );
      continue;
    }

    if (line.type === 'graph') {
      const seedSearch = await timer.time('bm25', bm25SearchImpl(repo, line.query, searchLimit));
      const seedRows = seedSearch.results as EnrichedSymbolRow[];
      state.ftsUsed &&= seedSearch.ftsUsed;
      state.capabilitiesUsed.add('bm25');

      if (!graphIntentAllowed) {
        state.warnings.push(
          `Typed graph line ${line.lineNumber} skipped graph traversal for intent ${queryIntent}; falling back to BM25.`,
        );
        state.bm25Results.push(...seedRows);
        recordRetrievalRows(
          state.candidateMap,
          seedRows,
          line.type,
          createTypedEvidenceReference(line, 'bm25'),
        );
        continue;
      }

      const edgeTypes: GraphEdgeType[] =
        queryIntent === 'calls-of' ? ['CALLS'] : ['IMPORTS', 'CALLS'];
      const graphMatches = await timer.time(
        'graph_traversal',
        graphTraversalRank(repo.id, seedRows.slice(0, 10), edgeTypes, 2, 50),
      );
      if (graphMatches.length === 0) {
        state.warnings.push(
          `Typed graph line ${line.lineNumber} produced no traversal hits; falling back to BM25 seeds.`,
        );
        state.bm25Results.push(...seedRows);
        recordRetrievalRows(
          state.candidateMap,
          seedRows,
          line.type,
          createTypedEvidenceReference(line, 'bm25'),
        );
        continue;
      }

      state.graphResults.push(...graphMatches);
      state.capabilitiesUsed.add('graph-traversal');
      recordRetrievalRows(
        state.candidateMap,
        graphMatches,
        line.type,
        createTypedEvidenceReference(line, 'graph'),
      );
    }
  }

  return {
    ...state,
    bm25Results: dedupeSymbolRows(state.bm25Results),
    semanticResults: dedupeSymbolRows(state.semanticResults),
    graphResults: dedupeSymbolRows(state.graphResults),
    lockedResults: dedupeSymbolRows(state.lockedResults),
  };
}

function backendSearchInputToQuery(input: BackendSearchInput): string {
  if (input.mode === 'plain') {
    return input.query.trim();
  }

  return input.document.lines
    .map((line) =>
      line.type === 'symbol' || line.type === 'file' ? `${line.type}: ${line.query}` : line.query,
    )
    .join('\n')
    .trim();
}

async function loadEmbeddingModelHash(repoId: string): Promise<string | undefined> {
  try {
    const { loadMeta } = await import('../../storage/repo-manager.js');
    const meta = await loadMeta(repoId);
    return meta?.model_hash;
  } catch {
    return undefined;
  }
}

function cacheableFreshnessStatus(status: QueryFreshnessStatus): boolean {
  return status === 'fresh' || status === 'not-applicable';
}

export async function query(
  repo: SearchRepoHandle,
  params: BackendSearchParams,
): Promise<SearchResult> {
  if (!('typedQuery' in params) && (typeof params.query !== 'string' || !params.query.trim())) {
    return { error: 'query parameter is required and cannot be empty.' };
  }

  const searchInput = toBackendSearchInput(params);
  const searchQuery = backendSearchInputToQuery(searchInput);

  if (!searchQuery) {
    return { error: 'query parameter is required and cannot be empty.' };
  }

  const processLimit = params.limit || 5;
  const maxSymbolsPerProcess = params.max_symbols || 10;
  const includeContent = params.include_content ?? false;
  const skeletonDefault = process.env.ONTOINDEX_SKELETON_DEFAULT !== '0';
  const SKELETON_DEPTH_BY_INTENT: Record<string, number> = {
    'cross-file-impact': 2,
    'calls-of': 2,
    'nl-conceptual': 3,
    ambiguous: 3,
    identifier: 1,
  };
  const timer = new PhaseTimer();
  const wallStart = performance.now();
  const searchLimit = processLimit * maxSymbolsPerProcess;

  // ONTOINDEX_INTENT_ENSEMBLE=1 activates per-intent weighted-RRF (v13 P1 W1b-step-1).
  // Default OFF — existing v12 RRF code path runs unchanged for all production users.
  const intentEnsembleEnabled =
    params.intent_ensemble ?? process.env.ONTOINDEX_INTENT_ENSEMBLE === '1';

  const classifierQuery =
    searchInput.mode === 'typed'
      ? classificationQueryForTypedInput(searchInput.document)
      : searchQuery;

  // Intent-conditional embedder routing (W1a-v8, defensive).
  // ONTOINDEX_EMBEDDING_MODEL_IMPACT — model for cross-file-impact intent.
  // ONTOINDEX_EMBEDDING_MODEL_DEFAULT — model for ambiguous / nl-conceptual / calls-of intents.
  // Both unset = no routing (existing single-model behaviour preserved).
  const intentResult = classifyIntent(classifierQuery);
  const queryIntent: Intent = intentResult.intent;
  const intentModelOverride: string | undefined = (() => {
    if (queryIntent === 'cross-file-impact') {
      return process.env.ONTOINDEX_EMBEDDING_MODEL_IMPACT ?? process.env.ONTOINDEX_EMBEDDING_MODEL;
    }
    return process.env.ONTOINDEX_EMBEDDING_MODEL_DEFAULT ?? process.env.ONTOINDEX_EMBEDDING_MODEL;
  })();
  const embeddingModelHash = await loadEmbeddingModelHash(repo.id);
  const requestedTokenCost = createQueryTokenCostSnapshot(params.token_cost);
  const cache = new SemanticRetrievalCache(repo.repoPath);
  const cacheKey = SemanticRetrievalCache.computeKey({
    query: searchQuery,
    retrievalPolicy: params.retrieval_policy,
    capabilities: [
      ...(intentEnsembleEnabled ? ['intent-ensemble'] : []),
      ...(params.include_citations ? ['citations'] : []),
      ...(params.include_lsp_refs ? ['lsp-refs'] : []),
      ...(intentModelOverride ? [`embedding-model:${intentModelOverride}`] : []),
      ...(params.token_cost ? [`token-cost:${JSON.stringify(requestedTokenCost)}`] : []),
    ],
    indexedHead: repo.lastCommit,
    embeddingModelHash,
    filters: searchInput.mode === 'typed' ? searchInput.document.filters : undefined,
  });
  let cacheStatus: 'hit' | 'miss' | 'stale' | 'expired' | undefined;
  let cacheAgeMs: number | undefined;
  let cacheEvictedEntries = 0;

  if (params.structured_output === true) {
    const cacheLookup = await cache.lookup(cacheKey, repo.lastCommit);
    cacheStatus = cacheLookup.status;
    cacheAgeMs = cacheLookup.ageMs;
    const cached = cacheLookup.result;
    if (
      cached?.diagnostics.freshness &&
      cached.diagnostics.capabilityHealth &&
      cacheableFreshnessStatus(cached.diagnostics.freshness.status)
    ) {
      const cachedTokenCost = cached.diagnostics.capabilityHealth.tokenCost ?? requestedTokenCost;
      return {
        processes: [],
        process_symbols: [],
        definitions: definitionsForCachedCandidates(cached.candidates),
        timing: cached.diagnostics.timing || {},
        query_intent: queryIntent,
        structured_retrieval: {
          candidates: cached.candidates,
          rows: structuredRowsForCandidates(cached.candidates),
          capabilityState: {
            ...cached.diagnostics.capabilityHealth,
            warnings: uniqueStrings([
              ...cached.diagnostics.capabilityHealth.warnings,
              ...cachedTokenCost.warnings,
            ]),
            freshness: cached.diagnostics.freshness,
            cacheHit: true,
            cacheStatus: 'hit',
            cacheAgeMs: cacheLookup.ageMs ?? Date.now() - cached.timestamp,
            tokenCost: cachedTokenCost,
          },
        },
      };
    } else if (cached) {
      cacheStatus = 'stale';
    }
  }

  let bm25Results: EnrichedSymbolRow[];
  let semanticResults: EnrichedSymbolRow[];
  let graphResults: EnrichedSymbolRow[] = [];
  let lockedResults: EnrichedSymbolRow[] = [];
  let typedWarnings: string[] = [];
  let ftsUsed = true;
  let typedCapabilitiesUsed = new Set<string>();
  let typedCapabilitiesMissing = new Set<string>();
  let typedCandidateMap: Map<string, RetrievalCandidate> | undefined;
  const graphConfidenceOk = intentResult.confidence === undefined || intentResult.confidence >= 0.7;

  if (searchInput.mode === 'typed') {
    const routed = await routeTypedQuery(
      repo,
      searchInput.document,
      timer,
      searchLimit,
      queryIntent,
      intentResult.confidence,
      intentEnsembleEnabled,
      intentModelOverride,
    );
    bm25Results = routed.bm25Results;
    semanticResults = routed.semanticResults;
    graphResults = routed.graphResults;
    lockedResults = routed.lockedResults;
    typedWarnings = routed.warnings;
    ftsUsed = routed.ftsUsed;
    typedCapabilitiesUsed = routed.capabilitiesUsed;
    typedCapabilitiesMissing = routed.capabilitiesMissing;
    typedCandidateMap = routed.candidateMap;
  } else {
    const [bm25SearchResult, semanticSearchResults] = await Promise.all([
      timer.time('bm25', bm25SearchImpl(repo, searchQuery, searchLimit)),
      timer.time('vector', semanticSearchImpl(repo, searchQuery, searchLimit, intentModelOverride)),
    ]);

    bm25Results = bm25SearchResult.results as EnrichedSymbolRow[];
    semanticResults = semanticSearchResults as EnrichedSymbolRow[];
    ftsUsed = bm25SearchResult.ftsUsed;

    if (params.retrieval_policy === 'symbol-neighborhood') {
      const frontierResult = await timer.time(
        'semantic_frontier',
        runSymbolNeighborhoodFrontierSearch(
          repo,
          searchQuery,
          bm25Results,
          searchLimit,
          intentModelOverride,
        ),
      );
      typedWarnings = uniqueStrings([...typedWarnings, ...frontierResult.warnings]);
      if (!frontierResult.fallbackToDefaultVector) {
        bm25Results = frontierResult.bm25Results;
        semanticResults = frontierResult.semanticResults;
      }
    }

    // --- Graph leg (W1b-step-2) ---
    // Gate: ONTOINDEX_INTENT_ENSEMBLE=1 AND intent is calls-of or cross-file-impact
    // AND confidence >= 0.7. Other intents (nl-conceptual, ambiguous) skip the graph leg
    // per design §D (w_graph=0 for those intents). Low-confidence routes to ambiguous
    // weights anyway, so there is no benefit to running the graph leg.
    const graphIntents: Intent[] = ['calls-of', 'cross-file-impact'];
    if (intentEnsembleEnabled && graphIntents.includes(queryIntent) && graphConfidenceOk) {
      const graphEdgeTypes: GraphEdgeType[] =
        queryIntent === 'calls-of' ? ['CALLS'] : ['IMPORTS', 'CALLS'];
      const graphSeeds = bm25Results.slice(0, 10);
      graphResults = await timer.time(
        'graph_traversal',
        graphTraversalRank(repo.id, graphSeeds, graphEdgeTypes, 2, 50),
      );
    }
  }

  // --- CE leg (W1b-step-3) ---
  // Gate: ONTOINDEX_INTENT_ENSEMBLE=1 AND intent==nl-conceptual AND confidence>=0.7
  // AND semanticResults.length >= MIN_VEC_POOL_SIZE (G2 thin-pool mitigation).
  // All other intents pass empty arrays (ceScores=[], ceResults=[]) so the CE
  // leg in applyEnsemble is a no-op for calls-of, cross-file-impact, ambiguous.
  let ceScoresEnsemble: number[] = [];
  let ceResultsEnsemble: EnrichedSymbolRow[] = [];
  const minVecPool =
    parseInt(process.env.ONTOINDEX_VEC_POOL_MIN ?? String(MIN_VEC_POOL_SIZE), 10) ||
    MIN_VEC_POOL_SIZE;
  if (
    intentEnsembleEnabled &&
    queryIntent === 'nl-conceptual' &&
    graphConfidenceOk &&
    semanticResults.length >= minVecPool
  ) {
    // ceResults = top-50 from semanticResults (already EnrichedSymbolRow; just slice).
    ceResultsEnsemble = semanticResults.slice(0, 50);
    const ceDocs = ceResultsEnsemble.map((sym) => `${sym.filePath ?? ''}\n${sym.name ?? ''}`);
    try {
      const { scoreCEBatch } = await import('../core/ce-reranker.js');
      ceScoresEnsemble = await timer.time('ce_rerank', scoreCEBatch(searchQuery, ceDocs));
    } catch (err) {
      console.error(`[ce-rerank-ensemble] error: ${err}; CE leg skipped`);
      ceScoresEnsemble = [];
      ceResultsEnsemble = [];
    }
  }

  timer.start('merge');
  const mergedCore: MergedSymbolEntry[] = intentEnsembleEnabled
    ? (applyEnsemble(
        queryIntent,
        bm25Results,
        semanticResults,
        searchLimit,
        intentResult.confidence,
        graphResults,
        ceScoresEnsemble,
        ceResultsEnsemble,
        { includeTrace: true },
      ) as MergedSymbolEntry[])
    : (mergeSymbolsWithRRF(bm25Results, semanticResults, searchLimit, {
        includeTrace: true,
      }) as MergedSymbolEntry[]);
  const mergedRaw = prependLockedResults(mergedCore, lockedResults);
  timer.stop();

  // Graph-path citations (Pillar 3 / W3a-v10)
  // Gate: ONTOINDEX_CITATIONS=1 (default unset — current behavior preserved)
  // Schema-change risk mitigated by env-gate + additive-only fields.
  const citationsEnabled = params.include_citations ?? process.env.ONTOINDEX_CITATIONS === '1';

  // W2-v8: env-gated score-based abstention filter.
  // ONTOINDEX_ABSTENTION_THRESHOLD=<float> — if set, filter out symbols whose RRF
  // score is below the threshold. If ALL symbols are filtered, return abstained=true.
  // Default (env unset / NaN): no abstention, behaviour unchanged.
  //
  // NOTE (v13 W1b-step-1, 2026-04-30): when ONTOINDEX_INTENT_ENSEMBLE=1, ensemble scores
  // are multiplied by intent weights (ambiguous: 0.5/0.5 sum=1.0; nl-conceptual:
  // 0.2 bm25 + 0.5 vec + 0.3 ce). Any ONTOINDEX_ABSTENTION_THRESHOLD calibrated against
  // v12 RRF (unweighted, score sum~2.0) will OVER-ABSTAIN under ensemble. Re-calibrate
  // the threshold or apply a scale correction when both env vars are set together.
  const abstentionThreshold = parseFloat(process.env.ONTOINDEX_ABSTENTION_THRESHOLD ?? 'NaN');
  const abstentionEnabled = !isNaN(abstentionThreshold) && abstentionThreshold > 0;
  const merged = abstentionEnabled
    ? mergedRaw.filter(([, item]) => item.score >= abstentionThreshold)
    : mergedRaw;

  if (abstentionEnabled && merged.length === 0) {
    return { abstained: true, processes: [], process_symbols: [], definitions: [], timing: {} };
  }

  timer.start('symbol_lookup');
  const processMap = new Map<string, ProcessBucket>();
  const definitions: Array<DefinitionEntry | SymbolEntry> = [];

  for (const [, item] of merged) {
    const sym = item.data;
    if (!sym.nodeId) {
      definitions.push({
        name: sym.name,
        type: sym.type || 'File',
        filePath: sym.filePath,
      });
      continue;
    }

    let processRows: ProcessLookupRow[] = [];
    try {
      processRows = (await executeParameterized(
        repo.id,
        `
        MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
        RETURN p.id AS pid, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
      `,
        { nodeId: sym.nodeId },
      )) as ProcessLookupRow[];
    } catch (e) {
      logSearchQueryError('query:process-lookup', e);
    }

    let cohesion = 0;
    let module: string | undefined;
    try {
      const cohesionRows = (await executeParameterized(
        repo.id,
        `
        MATCH (n {id: $nodeId})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
        RETURN c.cohesion AS cohesion, c.heuristicLabel AS module
        LIMIT 1
      `,
        { nodeId: sym.nodeId },
      )) as CohesionLookupRow[];
      if (cohesionRows.length > 0) {
        cohesion = ((cohesionRows[0].cohesion ?? cohesionRows[0][0]) as number) || 0;
        module = (cohesionRows[0].module ?? cohesionRows[0][1]) as string | undefined;
      }
    } catch (e) {
      logSearchQueryError('query:cluster-info', e);
    }

    let content: string | undefined;
    if (includeContent) {
      try {
        const contentRows = (await executeParameterized(
          repo.id,
          `
          MATCH (n {id: $nodeId})
          RETURN n.content AS content
        `,
          { nodeId: sym.nodeId },
        )) as ContentLookupRow[];
        if (contentRows.length > 0) {
          content = (contentRows[0].content ?? contentRows[0][0]) as string | undefined;
        }
      } catch (e) {
        logSearchQueryError('query:content-fetch', e);
      }
    }

    let citationPath: string | undefined;
    try {
      const citationRows = (await executeParameterized(
        repo.id,
        `
        MATCH (m)-[r:CodeRelation]->(n {id: $nodeId})
        WHERE r.type IN ['CALLS', 'IMPORTS']
        RETURN m.name AS caller, r.type AS type, m.filePath AS callerPath
        LIMIT 1
      `,
        { nodeId: sym.nodeId },
      )) as CitationLookupRow[];
      if (citationRows.length > 0) {
        const r = citationRows[0];
        citationPath = `${r.callerPath}:${r.caller} -> ${r.type} -> ${sym.name}`;
      }
    } catch (e) {
      // citation is best-effort
    }

    const symbolEntry = {
      id: sym.nodeId,
      name: sym.name,
      type: sym.type,
      filePath: sym.filePath,
      startLine: sym.startLine,
      endLine: sym.endLine,
      ...(citationPath ? { citation_path: citationPath } : {}),
      ...(module ? { module } : {}),
      ...(includeContent && content ? { content } : {}),
      // ceScore: additive field present only when CE rerank is active (W2b-v10).
      ...(sym.ceScore !== undefined ? { ceScore: sym.ceScore } : {}),
      // citations: additive field present only when ONTOINDEX_CITATIONS=1 (W3a-v10).
      // graphPath populated by BFS in W3b-v11 post-dedup block below ([] until then).
      // fileSha is null until lbug schema exposes it.
      // confidence auto-populates from ceScore when CE rerank is also active.
      ...(citationsEnabled && {
        citations: [
          {
            symbolId: sym.nodeId ?? null,
            lineSpan: { start: sym.startLine ?? 0, end: sym.endLine ?? 0 },
            fileSha: sym.fileSha ?? null,
            graphPath: [],
            ...(sym.ceScore !== undefined ? { confidence: sym.ceScore } : {}),
          },
        ],
      }),
    } satisfies SymbolEntry;

    if (processRows.length === 0) {
      definitions.push(symbolEntry);
    } else {
      for (const row of processRows) {
        const pid = (row.pid ?? row[0]) as string;
        const label = (row.label ?? row[1]) as string | undefined;
        const heuristicLabel = (row.heuristicLabel ?? row[2]) as string | undefined;
        const processType = (row.processType ?? row[3]) as string | undefined;
        const stepCount = (row.stepCount ?? row[4]) as number | undefined;
        const step = (row.step ?? row[5]) as number | undefined;

        if (!processMap.has(pid)) {
          processMap.set(pid, {
            id: pid,
            label,
            heuristicLabel,
            processType,
            stepCount,
            totalScore: 0,
            cohesionBoost: 0,
            symbols: [],
          });
        }

        const proc = processMap.get(pid)!;
        proc.totalScore += item.score;
        proc.cohesionBoost = Math.max(proc.cohesionBoost, cohesion);
        proc.symbols.push({
          ...symbolEntry,
          process_id: pid,
          step_index: step,
        });
      }
    }
  }

  timer.stop();

  timer.start('ranking');
  const rankedProcesses = Array.from(processMap.values())
    .map((p) => ({
      ...p,
      priority: p.totalScore + p.cohesionBoost * 0.1,
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, processLimit);
  timer.stop();

  timer.start('formatting');
  const processes = rankedProcesses.map((p) => ({
    id: p.id,
    summary: p.heuristicLabel || p.label,
    priority: Math.round(p.priority * 1000) / 1000,
    symbol_count: p.symbols.length,
    process_type: p.processType,
    step_count: p.stepCount,
  }));

  const processSymbols = rankedProcesses.flatMap((p) =>
    p.symbols.slice(0, maxSymbolsPerProcess).map((s) => ({
      ...s,
    })),
  );

  const seen = new Set<string>();
  const dedupedSymbols = processSymbols.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  timer.stop();

  const structuredWarnings = uniqueStrings([
    !ftsUsed
      ? 'FTS extension unavailable - keyword search degraded. Run: ontoindex analyze --force to rebuild indexes.'
      : undefined,
    ...typedWarnings,
  ]);
  const structuredCapabilitiesUsed =
    searchInput.mode === 'typed'
      ? typedCapabilitiesUsed
      : new Set<string>([
          'bm25',
          ...(semanticResults.length > 0 ? ['vector'] : []),
          ...(graphResults.length > 0 ? ['graph-traversal'] : []),
        ]);
  const structuredCapabilitiesMissing =
    searchInput.mode === 'typed' ? typedCapabilitiesMissing : new Set<string>();
  if (!ftsUsed) {
    structuredCapabilitiesMissing.add('fts');
  }
  const structuredRetrieval =
    params.structured_output === true
      ? await buildStructuredRetrievalResult({
          repo,
          merged,
          searchQuery,
          warnings: structuredWarnings,
          capabilitiesUsed: structuredCapabilitiesUsed,
          capabilitiesMissing: structuredCapabilitiesMissing,
          candidateMap: typedCandidateMap,
          filters: searchInput.mode === 'typed' ? searchInput.document.filters : undefined,
          tokenCost: requestedTokenCost,
        })
      : undefined;
  if (structuredRetrieval) {
    structuredRetrieval.capabilityState.cacheHit = false;
    structuredRetrieval.capabilityState.cacheStatus = cacheStatus ?? 'miss';
    if (cacheAgeMs !== undefined) {
      structuredRetrieval.capabilityState.cacheAgeMs = cacheAgeMs;
    }
  }

  // BFS graphPath population (W3b-v11).
  // Gate: ONTOINDEX_CITATIONS=1 only — preserves default behaviour when unset.
  // Bounded to top-10 deduped symbols to stay under 200ms p95 budget.
  if (citationsEnabled) {
    const TOP_N_FOR_BFS = Math.min(dedupedSymbols.length, 10);
    const graphResults = await timer.time(
      'citations-bfs',
      Promise.all(
        dedupedSymbols
          .slice(0, TOP_N_FOR_BFS)
          .map((s) => computeGraphPathWithDiagnostics(repo.id, s.id)),
      ),
    );
    for (let i = 0; i < TOP_N_FOR_BFS; i++) {
      const sym = dedupedSymbols[i];
      const res = graphResults[i];
      if (sym.citations?.[0]) {
        sym.citations[0].graphPath = res.edges;
        sym.citations[0].passiveFacts = res.passiveFacts;
        sym.citations[0].traversalStrategy = res.traversalStrategy;
        sym.citations[0].diagnostics = res.report;
      }
      sym.passiveFacts = res.passiveFacts;

      // Also attach to candidate if present
      const candidate = structuredRetrieval?.candidates.find(
        (c) => c.id === retrievalCandidateId(sym.id),
      );
      if (candidate) {
        candidate.passiveFacts = res.passiveFacts;
      }
    }
  }

  // Kill-switch (W0b-v8): if completion-rate drops >5pp post-skeleton OR any integration test fails, set include_skeleton default to false and remove the env-gate.
  const includeSkeleton = params.include_skeleton ?? skeletonDefault;
  const skeletons: Record<string, string> = {};
  let skeletonDepth = 3;
  if (includeSkeleton) {
    skeletonDepth = process.env.ONTOINDEX_SKELETON_DEPTH
      ? parseInt(process.env.ONTOINDEX_SKELETON_DEPTH, 10)
      : (SKELETON_DEPTH_BY_INTENT[queryIntent] ?? 3);
    if (dedupedSymbols.length > 0 || definitions.length > 0) {
      timer.start('skeleton');
      const topFilePaths = Array.from(
        new Set(
          [
            ...dedupedSymbols.map((s) => s.filePath),
            ...definitions.map((entry) => entry.filePath),
          ].filter(Boolean),
        ),
      ).slice(0, 5);
      await Promise.all(
        topFilePaths.map(async (fp) => {
          const text = await getFileSkeleton(repo.id, fp, skeletonDepth);
          if (text) skeletons[fp] = text;
        }),
      );
      timer.stop();
    }
  }

  timer.mark('wall', performance.now() - wallStart);
  const timing = timer.summary();
  logQueryTiming(searchQuery, timing);

  // LSP find-references enrichment (Pillar 2 / W1c-pivot)
  // Gate: ONTOINDEX_LSP_REFERENCES=1 (default off — consistent with v8 env-gate pattern).
  // Best-effort: never blocks query, never alters RRF ranking.
  if (params.include_lsp_refs ?? process.env.ONTOINDEX_LSP_REFERENCES === '1') {
    timer.start('lsp');
    const topEntry = mergedRaw[0];
    const topResult = topEntry?.[1]?.data;
    if (topResult?.filePath && topResult.startLine !== undefined) {
      try {
        const refs = await lspBridge.resolveSymbol(
          topResult.filePath,
          (topResult.startLine ?? 1) - 1, // convert 1-indexed to 0-indexed
          0,
        );
        if (refs) {
          topResult.lspRefs = refs;
        }
      } catch {
        // best-effort — LSP may not be available
      }
    }
    timer.stop();
  }

  // CE rerank (Pillar 2 / W2b-v10) — calibrated confidence.
  // Gate: ONTOINDEX_CE_RERANK=<model-id> (default unset — current behavior preserved).
  // Default off per v8 env-gate convention; production opt-in only.
  // Uses AutoTokenizer + AutoModelForSequenceClassification + sigmoid forward pass
  // (NOT pipeline('text-classification') which saturates to 1.0 silently per W2a-v10).
  const ceRerankModel = process.env.ONTOINDEX_CE_RERANK;
  if (ceRerankModel) {
    timer.start('ce-rerank');
    try {
      const { scoreCEBatch } = await import('../core/ce-reranker.js');
      // Take top-50 from RRF (or fewer if mergedRaw is shorter); score each.
      const candidates = mergedRaw.slice(0, 50);
      const docs = candidates.map(([, item]) => {
        const sym = item.data;
        return `${sym.filePath ?? ''}\n${sym.name ?? ''}`;
      });
      const ceScores = await scoreCEBatch(searchQuery, docs);
      candidates.forEach(([, item], i) => {
        item.data.ceScore = ceScores[i];
      });
      // Re-sort by ceScore descending; splice back into mergedRaw.
      candidates.sort(([, a], [, b]) => (b.data.ceScore ?? 0) - (a.data.ceScore ?? 0));
      mergedRaw.splice(0, candidates.length, ...candidates);
    } catch (err) {
      console.error(`[ce-rerank] error: ${err}; falling back to RRF order`);
    }
    timer.stop();
  }

  // v6 W0d: durable per-query log for production-data collection.
  // Captures top-10 result IDs alongside timing/fts info. Opt-out via
  // ONTOINDEX_QUERY_LOG=0. See ontoindex/src/mcp/local/query-log.ts.
  appendQueryLog(repo.id, {
    query: searchQuery,
    resultIds: dedupedSymbols.slice(0, 10).map((s) => String(s.id)),
    phases: timing,
    ftsUsed,
  }).catch(() => {});

  const warning = combineWarnings(
    !ftsUsed
      ? 'FTS extension unavailable - keyword search degraded. Run: ontoindex analyze --force to rebuild indexes.'
      : undefined,
    ...typedWarnings,
  );

  if (
    structuredRetrieval &&
    cacheableFreshnessStatus(structuredRetrieval.capabilityState.freshness.status)
  ) {
    try {
      const cacheSet = await cache.set(cacheKey, {
        candidates: structuredRetrieval.candidates,
        diagnostics: {
          timing,
          capabilityHealth: structuredRetrieval.capabilityState,
          freshness: structuredRetrieval.capabilityState.freshness,
        },
        indexedHead: repo.lastCommit,
      });
      cacheEvictedEntries = cacheSet.evicted;
      structuredRetrieval.capabilityState.cacheEvictedEntries = cacheEvictedEntries;
    } catch {
      // Best-effort
    }
  }

  const result = {
    processes,
    process_symbols: dedupedSymbols,
    definitions: definitions.slice(0, 20),
    timing,
    query_intent: queryIntent,
    ...(abstentionEnabled ? { abstained: false as const } : {}),
    ...(Object.keys(skeletons).length > 0 && { skeletons }),
    ...(warning && { warning }),
    ...(structuredRetrieval && { structured_retrieval: structuredRetrieval }),
  };

  if (includeSkeleton) {
    const approxTokens = JSON.stringify(result).length / 4;
    console.error(
      `OntoIndex [skeleton:tokens] intent=${queryIntent} depth=${skeletonDepth} approxTokens=${Math.round(approxTokens)}`,
    );
  }

  return result;
}
