import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import {
  isAutomaticWorkspaceEnabled,
  getOverlaySnapshot,
  isAuthoritativePath,
  queryOverlay,
  type OverlaySnapshot,
} from './backend-overlay.js';
import { resolveSymbolCandidates, toSymbolIdentity } from './backend-symbol-resolution.js';
import { nodeKind } from '../super/_helpers/node-kind.js';

const MAX_CONTEXT_PROCESS_ROWS = (() => {
  const raw = Number.parseInt(process.env.ONTOINDEX_CONTEXT_PROCESS_LIMIT ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1_000) : 50;
})();
const MAX_CONTEXT_RELATIONSHIP_ROWS = 30;
const MAX_CONTEXT_CONCEPT_ROWS = 10;
const METHOD_METADATA_KEYS = new Set([
  'visibility',
  'isStatic',
  'isAbstract',
  'isFinal',
  'isVirtual',
  'isOverride',
  'isAsync',
  'isPartial',
  'returnType',
  'parameterCount',
  'isVariadic',
  'requiredParameterCount',
  'parameterTypes',
  'annotations',
]);

interface ContextRepoHandle {
  id: string;
  repoPath?: string;
  storagePath?: string;
}

type QueryRow = Record<string, unknown> | readonly unknown[];
type GraphQuery = (cypher: string, params: Record<string, unknown>) => Promise<QueryRow[]>;
type ContextRelationshipRow = QueryRow;
type ProcessParticipationRow = QueryRow;
type MethodMetadataRow = QueryRow;
type ResolvedContextSymbol = Extract<
  Awaited<ReturnType<typeof resolveSymbolCandidates>>,
  { kind: 'ok' }
>['symbol'];

function contextCompleteness(
  sourceIncluded: boolean,
  missingReasons: string[],
  suggestedNextCalls?: string[],
  truncated = false,
): Record<string, unknown> {
  return {
    sourceIncluded,
    truncated,
    missingReasons,
    ...(suggestedNextCalls && suggestedNextCalls.length > 0 ? { suggestedNextCalls } : {}),
  };
}

function retryCalls(repoId: string, nodeId: string, name: string): string[] {
  return [
    `inspect({ action: "context", repo: "${repoId}", uid: "${nodeId}" })`,
    `impact({ action: "symbol", repo: "${repoId}", target_uid: "${nodeId}", target: "${name}" })`,
  ];
}

function logContextQueryError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`OntoIndex [${context}]: ${msg}`);
}

function rowValue(row: QueryRow, key: string, index: number): unknown {
  const namedValue = !Array.isArray(row) ? row[key] : undefined;
  return namedValue || row[index];
}

function rowEntries(row: QueryRow): Array<[string, unknown]> {
  return Array.isArray(row)
    ? row.map((value, index) => [String(index), value])
    : Object.entries(row);
}

function symbolTupleValue(sym: ResolvedContextSymbol, index: number): unknown {
  return (sym as unknown as Partial<Record<number, unknown>>)[index];
}

function categorizeRows(rows: ContextRelationshipRow[]): Record<string, unknown[]> {
  const categories: Record<string, unknown[]> = {};
  for (const row of rows) {
    const relType = String(rowValue(row, 'relType', 0) || '').toLowerCase();
    const uid = rowValue(row, 'uid', 1);
    const rowKind = rowValue(row, 'kind', 4);
    const kind =
      (rowKind === undefined || rowKind === null || rowKind === '') && typeof uid === 'string'
        ? nodeKind('', uid) || rowKind
        : rowKind;
    const entry = {
      uid,
      name: rowValue(row, 'name', 2),
      filePath: rowValue(row, 'filePath', 3),
      kind,
      ...(rowValue(row, 'source', 5) === 'overlay' ? { source: 'overlay' } : {}),
    };
    if (!categories[relType]) categories[relType] = [];
    categories[relType].push(entry);
  }
  return categories;
}

async function resolveClassLike(
  graphQuery: GraphQuery,
  symId: string,
  resolvedLabel: string | undefined,
  sym: ResolvedContextSymbol,
): Promise<{ isClassLike: boolean; queryFailed: boolean }> {
  const symRawType = sym.type || symbolTupleValue(sym, 2) || '';
  let isClassLike = resolvedLabel === 'Class' || resolvedLabel === 'Interface';
  if (!isClassLike && symRawType === '') {
    try {
      // Single UNION query instead of two serial round-trips.
      const typeCheck = await graphQuery(
        `
        MATCH (n:Class) WHERE n.id = $symId RETURN 'Class' AS label LIMIT 1
        UNION ALL
        MATCH (n:Interface) WHERE n.id = $symId RETURN 'Interface' AS label LIMIT 1
      `,
        { symId },
      );
      isClassLike = typeCheck.length > 0;
    } catch {
      return { isClassLike: false, queryFailed: true };
    }
  } else if (!isClassLike) {
    isClassLike = symRawType === 'Class' || symRawType === 'Interface';
  }
  return { isClassLike, queryFailed: false };
}

async function expandClassLikeIncomingRefs(
  graphQuery: GraphQuery,
  symId: string,
  incomingRows: ContextRelationshipRow[],
): Promise<{ truncated: boolean; missingReasons: string[] }> {
  // Each independent query keeps its successful sibling if the other fails.
  const results = await Promise.allSettled([
    graphQuery(
      `
        MATCH (n)-[hm:CodeRelation]->(ctor:Constructor)
        WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
        MATCH (caller)-[r:CodeRelation]->(ctor)
        WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'ACCESSES']
        RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
        LIMIT ${MAX_CONTEXT_RELATIONSHIP_ROWS + 1}
      `,
      { symId },
    ),
    graphQuery(
      `
        MATCH (f:File)-[rel:CodeRelation]->(n)
        WHERE n.id = $symId AND rel.type = 'DEFINES'
        MATCH (caller)-[r:CodeRelation]->(f)
        WHERE r.type IN ['CALLS', 'IMPORTS']
        RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
        LIMIT ${MAX_CONTEXT_RELATIONSHIP_ROWS + 1}
      `,
      { symId },
    ),
  ]);

  // Deduplicate by (relType, uid) — a caller can have multiple relation
  // types to the same target (e.g. both IMPORTS and CALLS), and each
  // must be preserved so every category appears in the output.
  const extraIncomingRows: ContextRelationshipRow[] = [];
  const missingReasons: string[] = [];
  let truncated = false;
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      logContextQueryError(
        `context:class-incoming-${index === 0 ? 'constructor' : 'file'}`,
        result.reason,
      );
      missingReasons.push(`class-incoming-${index === 0 ? 'constructor' : 'file'}-query-failed`);
    } else {
      truncated ||= result.value.length > MAX_CONTEXT_RELATIONSHIP_ROWS;
      extraIncomingRows.push(...result.value.slice(0, MAX_CONTEXT_RELATIONSHIP_ROWS));
    }
  }
  const seenKeys = new Set(
    incomingRows.map((row) => `${rowValue(row, 'relType', 0)}:${rowValue(row, 'uid', 1)}`),
  );
  for (const row of extraIncomingRows) {
    const key = `${rowValue(row, 'relType', 0)}:${rowValue(row, 'uid', 1)}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      incomingRows.push(row);
    }
  }
  return { truncated, missingReasons };
}

async function fetchMethodMetadata(
  graphQuery: GraphQuery,
  symId: string,
): Promise<{ metadata?: Record<string, unknown>; queryFailed: boolean }> {
  try {
    const metaRows = (await graphQuery(
      `
      MATCH (n {id: $symId})
      RETURN n
      LIMIT 1
    `,
      { symId },
    )) as MethodMetadataRow[];
    if (metaRows.length === 0) return { queryFailed: false };

    const node = rowValue(metaRows[0], 'n', 0);
    if (!node || typeof node !== 'object') return { queryFailed: false };
    const meta: Record<string, unknown> = {};
    // Optional fields vary by node schema; never project them across all labels.
    for (const [key, val] of rowEntries(node as QueryRow)) {
      if (METHOD_METADATA_KEYS.has(key) && val !== null && val !== undefined) meta[key] = val;
    }
    return { metadata: Object.keys(meta).length > 0 ? meta : undefined, queryFailed: false };
  } catch {
    return { queryFailed: true };
  }
}

export async function context(
  repo: ContextRepoHandle,
  params: {
    name?: string;
    uid?: string;
    file_path?: string;
    kind?: string;
    include_content?: boolean;
  },
): Promise<unknown> {
  const { name, uid, file_path, kind, include_content } = params;

  if (!name && !uid) {
    return { error: 'Either "name" or "uid" parameter is required.' };
  }

  const overlayRepo =
    repo.repoPath && repo.storagePath
      ? { id: repo.id, repoPath: repo.repoPath, storagePath: repo.storagePath }
      : undefined;
  let snapshot: OverlaySnapshot | undefined;
  if (overlayRepo) {
    try {
      snapshot = await getOverlaySnapshot(overlayRepo);
    } catch (error) {
      if (isAutomaticWorkspaceEnabled()) throw error;
      /* Resolver retains base fallback. */
    }
  }
  if (
    isAutomaticWorkspaceEnabled() &&
    snapshot &&
    !snapshot.usable &&
    (snapshot.dirtyPaths.size > 0 || (snapshot.configPaths?.size ?? 0) > 0)
  ) {
    throw new Error(snapshot.reason ?? 'Automatic workspace snapshot is unavailable');
  }
  const outcome = await resolveSymbolCandidates(
    repo,
    { uid, name, include_content },
    { file_path, kind },
    { snapshot },
  );

  if (outcome.kind === 'not_found') {
    return {
      error: `Symbol '${name || uid}' not found`,
      ...(outcome.warning !== undefined && { warning: outcome.warning }),
    };
  }

  if (outcome.kind === 'ambiguous') {
    return {
      status: 'ambiguous',
      message: `Found ${outcome.candidates.length} symbols matching '${name}'. Use uid, file_path, or kind to disambiguate.`,
      candidates: outcome.candidates.map((c) => ({
        ...toSymbolIdentity(c),
        uid: c.id,
        name: c.name,
        kind: c.type,
        filePath: c.filePath,
        line: c.startLine,
        score: Number(c.score.toFixed(2)),
        ...(c.source ? { source: c.source } : {}),
        suggestedNextCalls: retryCalls(repo.id, c.id, c.name),
      })),
      contextCompleteness: contextCompleteness(false, ['ambiguous-symbol']),
    };
  }

  // Step 3: Build full context
  const sym = outcome.symbol;
  const resolvedLabel = outcome.resolvedLabel;
  const symId = sym.id;

  const workspaceGraph = sym.source === 'overlay' && sym.graph === 'workspace-graph';
  const graphQuery: GraphQuery = (cypher, queryParams) =>
    workspaceGraph && overlayRepo
      ? queryOverlay(overlayRepo, cypher, queryParams, snapshot?.generation)
      : executeParameterized(repo.id, cypher, queryParams);
  const parseErrorFile =
    workspaceGraph &&
    snapshot?.coverage === 'partial' &&
    !isAuthoritativePath(snapshot, sym.filePath);

  if (sym.source === 'overlay' && !workspaceGraph) {
    return {
      status: 'found',
      source: 'overlay',
      graphImpactAvailable: false,
      symbol: {
        ...toSymbolIdentity(sym),
        uid: sym.id,
        name: sym.name,
        kind: sym.type,
        filePath: sym.filePath,
        startLine: sym.startLine,
        endLine: sym.endLine,
        source: 'overlay',
        ...(include_content && sym.content ? { content: sym.content } : {}),
      },
      warnings: [
        'Relationships are unavailable for uncommitted symbols: the overlay contains symbols only, not callers, callees, or process membership.',
      ],
      contextCompleteness: contextCompleteness(Boolean(include_content && sym.content), [
        'relationships-unavailable-for-uncommitted-symbols',
        ...(include_content ? [] : ['source-not-requested']),
        ...(include_content && !sym.content ? ['source-unavailable'] : []),
      ]),
      incoming: {},
      outgoing: {},
      processes: [],
      concepts: [],
    };
  }

  // Categorized incoming refs
  const incomingQueryRows = (await graphQuery(
    `
    MATCH (caller)-[r:CodeRelation]->(n {id: $symId})
    WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES']
    RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
    LIMIT ${MAX_CONTEXT_RELATIONSHIP_ROWS + 1}
  `,
    { symId },
  )) as ContextRelationshipRow[];
  let truncated = incomingQueryRows.length > MAX_CONTEXT_RELATIONSHIP_ROWS;
  const incomingRows = incomingQueryRows.slice(0, MAX_CONTEXT_RELATIONSHIP_ROWS);
  const missingReasons: string[] = parseErrorFile ? ['parse-error-file'] : [];

  // Fix #480: Class/Interface nodes have no direct CALLS/IMPORTS edges —
  // those point to Constructor and File nodes respectively. Fetch those
  // extra incoming refs and merge them in so context() shows real callers.
  const classLike = await resolveClassLike(graphQuery, symId, resolvedLabel, sym);
  if (classLike.queryFailed) missingReasons.push('class-type-query-failed');
  if (classLike.isClassLike) {
    const expansion = await expandClassLikeIncomingRefs(graphQuery, symId, incomingRows);
    truncated ||= expansion.truncated;
    missingReasons.push(...expansion.missingReasons);
  }

  // Categorized outgoing refs
  const outgoingQueryRows = (await graphQuery(
    `
    MATCH (n {id: $symId})-[r:CodeRelation]->(target)
    WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES']
    RETURN r.type AS relType, target.id AS uid, target.name AS name, target.filePath AS filePath, labels(target)[0] AS kind
    LIMIT ${MAX_CONTEXT_RELATIONSHIP_ROWS + 1}
  `,
    { symId },
  )) as ContextRelationshipRow[];
  truncated ||= outgoingQueryRows.length > MAX_CONTEXT_RELATIONSHIP_ROWS;
  const outgoingRows = outgoingQueryRows.slice(0, MAX_CONTEXT_RELATIONSHIP_ROWS);

  // Process participation
  let processRows: ProcessParticipationRow[] = [];
  try {
    processRows = (await graphQuery(
      `
      MATCH (n {id: $symId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
      RETURN p.id AS pid, p.heuristicLabel AS label, r.step AS step, p.stepCount AS stepCount
      ORDER BY p.stepCount DESC
      LIMIT ${MAX_CONTEXT_PROCESS_ROWS + 1}
    `,
      { symId },
    )) as ProcessParticipationRow[];
    truncated ||= processRows.length > MAX_CONTEXT_PROCESS_ROWS;
    processRows = processRows.slice(0, MAX_CONTEXT_PROCESS_ROWS);
  } catch (e) {
    logContextQueryError('context:process-participation', e);
    missingReasons.push('process-participation-query-failed');
  }

  // Method/Function/Constructor enrichment: fetch method-specific properties
  const symKind = classLike.isClassLike ? resolvedLabel || 'Class' : sym.type;
  const isMethodLike = symKind === 'Method' || symKind === 'Function' || symKind === 'Constructor';
  const metadataResult = isMethodLike ? await fetchMethodMetadata(graphQuery, symId) : undefined;
  if (metadataResult?.queryFailed) missingReasons.push('method-metadata-query-failed');

  // Concepts (B11)
  let concepts: any[] = [];
  try {
    const conceptRows = await graphQuery(
      `
      MATCH (n {id: $symId})-[:CodeRelation {type: 'EXPLAINED_BY'}]-(c:Concept)
      RETURN c.id AS id, c.name AS name, c.authority AS authority, c.confidence AS confidence
      LIMIT ${MAX_CONTEXT_CONCEPT_ROWS + 1}
    `,
      { symId },
    );
    truncated ||= conceptRows.length > MAX_CONTEXT_CONCEPT_ROWS;
    concepts = conceptRows.slice(0, MAX_CONTEXT_CONCEPT_ROWS).map((row) => ({
      id: rowValue(row, 'id', 0),
      name: rowValue(row, 'name', 1),
      authority: rowValue(row, 'authority', 2),
      confidence: rowValue(row, 'confidence', 3),
    }));
  } catch (e) {
    logContextQueryError('context:concept-lookup', e);
    missingReasons.push('concept-lookup-query-failed');
  }

  return {
    status: 'found',
    ...(workspaceGraph
      ? {
          source: 'workspace-graph',
          graphImpactAvailable: !parseErrorFile,
          ...(parseErrorFile
            ? { warnings: ['Symbol file failed to parse; relationships may be incomplete'] }
            : {}),
        }
      : {}),
    symbol: {
      uid: sym.id,
      name: sym.name,
      kind: symKind,
      filePath: sym.filePath,
      startLine: sym.startLine,
      endLine: sym.endLine,
      ...(include_content && sym.content ? { content: sym.content } : {}),
      ...(metadataResult?.metadata ? { methodMetadata: metadataResult.metadata } : {}),
    },
    contextCompleteness: contextCompleteness(
      Boolean(include_content && sym.content),
      [
        ...(include_content ? [] : ['source-not-requested']),
        ...(include_content && !sym.content ? ['source-unavailable'] : []),
        ...missingReasons,
      ],
      undefined,
      truncated,
    ),
    incoming: categorizeRows(incomingRows),
    outgoing: categorizeRows(outgoingRows),
    processes: processRows.map((row) => ({
      id: rowValue(row, 'pid', 0),
      name: rowValue(row, 'label', 1),
      step_index: rowValue(row, 'step', 2),
      step_count: rowValue(row, 'stepCount', 3),
    })),
    concepts,
  };
}
