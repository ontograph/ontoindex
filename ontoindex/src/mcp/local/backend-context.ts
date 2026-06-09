import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { resolveSymbolCandidates } from './backend-symbol-resolution.js';

const MAX_CONTEXT_PROCESS_ROWS = (() => {
  const raw = Number.parseInt(process.env.ONTOINDEX_CONTEXT_PROCESS_LIMIT ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1_000) : 50;
})();

interface ContextRepoHandle {
  id: string;
}

type QueryRow = Record<string, unknown> | readonly unknown[];
type ContextRelationshipRow = QueryRow;
type ProcessParticipationRow = QueryRow;
type MethodMetadataRow = QueryRow;
type ResolvedContextSymbol = Extract<
  Awaited<ReturnType<typeof resolveSymbolCandidates>>,
  { kind: 'ok' }
>['symbol'];

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
    const entry = {
      uid: rowValue(row, 'uid', 1),
      name: rowValue(row, 'name', 2),
      filePath: rowValue(row, 'filePath', 3),
      kind: rowValue(row, 'kind', 4),
    };
    if (!categories[relType]) categories[relType] = [];
    categories[relType].push(entry);
  }
  return categories;
}

async function resolveClassLike(
  repoId: string,
  symId: string,
  resolvedLabel: string | undefined,
  sym: ResolvedContextSymbol,
): Promise<boolean> {
  const symRawType = sym.type || symbolTupleValue(sym, 2) || '';
  let isClassLike = resolvedLabel === 'Class' || resolvedLabel === 'Interface';
  if (!isClassLike && symRawType === '') {
    try {
      // Single UNION query instead of two serial round-trips.
      const typeCheck = await executeParameterized(
        repoId,
        `
        MATCH (n:Class) WHERE n.id = $symId RETURN 'Class' AS label LIMIT 1
        UNION ALL
        MATCH (n:Interface) WHERE n.id = $symId RETURN 'Interface' AS label LIMIT 1
      `,
        { symId },
      );
      isClassLike = typeCheck.length > 0;
    } catch {
      /* not a Class/Interface node */
    }
  } else if (!isClassLike) {
    isClassLike = symRawType === 'Class' || symRawType === 'Interface';
  }
  return isClassLike;
}

async function expandClassLikeIncomingRefs(
  repoId: string,
  symId: string,
  incomingRows: ContextRelationshipRow[],
): Promise<void> {
  try {
    // Run both incoming-ref queries in parallel — they are independent.
    const [ctorIncoming, fileIncoming] = await Promise.all([
      executeParameterized(
        repoId,
        `
        MATCH (n)-[hm:CodeRelation]->(ctor:Constructor)
        WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
        MATCH (caller)-[r:CodeRelation]->(ctor)
        WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'ACCESSES']
        RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
        LIMIT 30
      `,
        { symId },
      ),
      executeParameterized(
        repoId,
        `
        MATCH (f:File)-[rel:CodeRelation]->(n)
        WHERE n.id = $symId AND rel.type = 'DEFINES'
        MATCH (caller)-[r:CodeRelation]->(f)
        WHERE r.type IN ['CALLS', 'IMPORTS']
        RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
        LIMIT 30
      `,
        { symId },
      ),
    ]);

    // Deduplicate by (relType, uid) — a caller can have multiple relation
    // types to the same target (e.g. both IMPORTS and CALLS), and each
    // must be preserved so every category appears in the output.
    const extraIncomingRows = [
      ...(ctorIncoming as ContextRelationshipRow[]),
      ...(fileIncoming as ContextRelationshipRow[]),
    ];
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
  } catch (e) {
    logContextQueryError('context:class-incoming-expansion', e);
  }
}

async function fetchMethodMetadata(
  repoId: string,
  symId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const metaRows = (await executeParameterized(
      repoId,
      `
      MATCH (n {id: $symId})
      RETURN n.visibility AS visibility, n.isStatic AS isStatic, n.isAbstract AS isAbstract,
             n.isFinal AS isFinal, n.isVirtual AS isVirtual, n.isOverride AS isOverride,
             n.isAsync AS isAsync, n.isPartial AS isPartial, n.returnType AS returnType,
             n.parameterCount AS parameterCount, n.isVariadic AS isVariadic,
             n.requiredParameterCount AS requiredParameterCount,
             n.parameterTypes AS parameterTypes, n.annotations AS annotations
      LIMIT 1
    `,
      { symId },
    )) as MethodMetadataRow[];
    if (metaRows.length === 0) return undefined;

    const row = metaRows[0];
    const meta: Record<string, unknown> = {};
    // Only include defined properties to distinguish "not applicable" from "not enriched"
    for (const [key, val] of rowEntries(row)) {
      if (val !== null && val !== undefined) meta[key] = val;
    }
    return Object.keys(meta).length > 0 ? meta : undefined;
  } catch {
    /* method metadata unavailable — omit silently */
    return undefined;
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

  const outcome = await resolveSymbolCandidates(
    repo,
    { uid, name, include_content },
    { file_path, kind },
  );

  if (outcome.kind === 'not_found') {
    return { error: `Symbol '${name || uid}' not found` };
  }

  if (outcome.kind === 'ambiguous') {
    return {
      status: 'ambiguous',
      message: `Found ${outcome.candidates.length} symbols matching '${name}'. Use uid, file_path, or kind to disambiguate.`,
      candidates: outcome.candidates.map((c) => ({
        uid: c.id,
        name: c.name,
        kind: c.type,
        filePath: c.filePath,
        line: c.startLine,
        score: Number(c.score.toFixed(2)),
      })),
    };
  }

  // Step 3: Build full context
  const sym = outcome.symbol;
  const resolvedLabel = outcome.resolvedLabel;
  const symId = sym.id;

  // Categorized incoming refs
  const incomingRows = (await executeParameterized(
    repo.id,
    `
    MATCH (caller)-[r:CodeRelation]->(n {id: $symId})
    WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES']
    RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
    LIMIT 30
  `,
    { symId },
  )) as ContextRelationshipRow[];

  // Fix #480: Class/Interface nodes have no direct CALLS/IMPORTS edges —
  // those point to Constructor and File nodes respectively. Fetch those
  // extra incoming refs and merge them in so context() shows real callers.
  const isClassLike = await resolveClassLike(repo.id, symId, resolvedLabel, sym);
  if (isClassLike) {
    await expandClassLikeIncomingRefs(repo.id, symId, incomingRows);
  }

  // Categorized outgoing refs
  const outgoingRows = (await executeParameterized(
    repo.id,
    `
    MATCH (n {id: $symId})-[r:CodeRelation]->(target)
    WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES']
    RETURN r.type AS relType, target.id AS uid, target.name AS name, target.filePath AS filePath, labels(target)[0] AS kind
    LIMIT 30
  `,
    { symId },
  )) as ContextRelationshipRow[];

  // Process participation
  let processRows: ProcessParticipationRow[] = [];
  try {
    processRows = (await executeParameterized(
      repo.id,
      `
      MATCH (n {id: $symId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
      RETURN p.id AS pid, p.heuristicLabel AS label, r.step AS step, p.stepCount AS stepCount
      ORDER BY p.stepCount DESC
      LIMIT ${MAX_CONTEXT_PROCESS_ROWS}
    `,
      { symId },
    )) as ProcessParticipationRow[];
  } catch (e) {
    logContextQueryError('context:process-participation', e);
  }

  // Method/Function/Constructor enrichment: fetch method-specific properties
  const symKind = isClassLike ? resolvedLabel || 'Class' : sym.type;
  const isMethodLike = symKind === 'Method' || symKind === 'Function' || symKind === 'Constructor';
  const methodMetadata = isMethodLike ? await fetchMethodMetadata(repo.id, symId) : undefined;

  // Concepts (B11)
  let concepts: any[] = [];
  try {
    const conceptRows = await executeParameterized(
      repo.id,
      `
      MATCH (n {id: $symId})-[:CodeRelation {type: 'EXPLAINED_BY'}]-(c:Concept)
      RETURN c.id AS id, c.name AS name, c.authority AS authority, c.confidence AS confidence
      LIMIT 10
    `,
      { symId },
    );
    concepts = conceptRows.map((row) => ({
      id: rowValue(row, 'id', 0),
      name: rowValue(row, 'name', 1),
      authority: rowValue(row, 'authority', 2),
      confidence: rowValue(row, 'confidence', 3),
    }));
  } catch (e) {
    logContextQueryError('context:concept-lookup', e);
  }

  return {
    status: 'found',
    symbol: {
      uid: sym.id,
      name: sym.name,
      kind: symKind,
      filePath: sym.filePath,
      startLine: sym.startLine,
      endLine: sym.endLine,
      ...(include_content && sym.content ? { content: sym.content } : {}),
      ...(methodMetadata ? { methodMetadata } : {}),
    },
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
