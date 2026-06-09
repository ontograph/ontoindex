import { executeParameterized, executeQuery } from '../lbug/pool-adapter.js';

export type ImpactKernelDirection = 'upstream' | 'downstream';
export type ImpactKernelCountScope = 'unique-direct-nodes' | 'unique-transitive-nodes';

export interface ImpactKernelRepoHandle {
  id: string;
  name?: string;
  repoPath?: string;
  storagePath?: string;
  indexedAt?: string;
  lastCommit?: string;
}

export interface ImpactKernelSymbol {
  id: string;
  name?: unknown;
  type?: string;
  filePath?: unknown;
}

export interface ImpactKernelNode {
  depth: number;
  id: string;
  name: unknown;
  type: unknown;
  filePath: string;
  relationType: string | undefined;
  confidence: number;
}

export interface ImpactKernelGraphSnapshot {
  repoId: string;
  repoName?: string;
  repoPath?: string;
  storagePath?: string;
  indexedAt?: string;
  lastCommit?: string;
}

export interface ImpactKernelFilters {
  includeTests: boolean;
  minConfidence: number;
  classSeedExpansion: boolean;
  mentionsMinConfidence: number;
}

export interface ImpactKernelRawCounts {
  resolvedUid: string;
  graphSnapshot: ImpactKernelGraphSnapshot;
  direction: ImpactKernelDirection;
  traversalDepth: number;
  relationshipSet: string[];
  filters: ImpactKernelFilters;
  countScope: ImpactKernelCountScope;
  total: number;
  direct: number;
  byDepth: Record<number, number>;
  seedUids: string[];
  riskReasons: string[];
}

export interface ImpactKernelResult {
  rawCounts: ImpactKernelRawCounts;
  impacted: ImpactKernelNode[];
  byDepth: Record<number, ImpactKernelNode[]>;
  partial: boolean;
  warnings: string[];
}

export interface RunImpactKernelOptions {
  direction: ImpactKernelDirection;
  maxDepth?: number;
  relationTypes?: string[];
  includeTests?: boolean;
  minConfidence?: number;
  countScope?: ImpactKernelCountScope;
  classSeedExpansion?: boolean;
  signal?: AbortSignal;
}

type QueryRow = Record<string, unknown> | readonly unknown[];
type ImpactRelatedRow = QueryRow;
type ImpactSymbolRow = QueryRow;

/** Quick test-file detection for filtering raw graph impact counts. */
export function isTestFilePath(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    p.includes('.test.') ||
    p.includes('.spec.') ||
    p.includes('__tests__/') ||
    p.includes('__mocks__/') ||
    p.includes('/test/') ||
    p.includes('/tests/') ||
    p.includes('/testing/') ||
    p.includes('/fixtures/') ||
    p.endsWith('_test.go') ||
    p.endsWith('_test.py') ||
    p.endsWith('_spec.rb') ||
    p.endsWith('_test.rb') ||
    p.includes('/spec/') ||
    p.includes('/test_') ||
    p.includes('/conftest.')
  );
}

/** Valid relation types for impact analysis filtering. */
export const VALID_RELATION_TYPES = new Set([
  'CALLS',
  'REFERENCES',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'METHOD_OVERRIDES',
  'OVERRIDES',
  'METHOD_IMPLEMENTS',
  'ACCESSES',
  'HANDLES_ROUTE',
  'FETCHES',
  'HANDLES_TOOL',
  'ENTRY_POINT_OF',
  'WRAPS',
]);

/** Per-relation-type confidence floor for impact analysis. */
export const IMPACT_RELATION_CONFIDENCE: Readonly<Record<string, number>> = {
  CALLS: 0.9,
  REFERENCES: 0.8,
  IMPORTS: 0.9,
  EXTENDS: 0.85,
  IMPLEMENTS: 0.85,
  METHOD_OVERRIDES: 0.85,
  METHOD_IMPLEMENTS: 0.85,
  HAS_METHOD: 0.95,
  HAS_PROPERTY: 0.95,
  ACCESSES: 0.8,
  CONTAINS: 0.95,
};

export const DEFAULT_IMPACT_RELATION_TYPES = [
  'CALLS',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'METHOD_OVERRIDES',
  'OVERRIDES',
  'METHOD_IMPLEMENTS',
];

// Safe-edit and diff tools intentionally use direct blast-radius probes:
// upstream is callers/references; downstream is callees/references/imports.
export const SAFE_EDIT_UPSTREAM_RELATION_TYPES = ['CALLS', 'REFERENCES'];
export const SAFE_EDIT_DOWNSTREAM_RELATION_TYPES = ['CALLS', 'REFERENCES', 'IMPORTS'];

export const MAX_IMPACT_DEPTH = 32;
export const MAX_IMPACT_FRONTIER_IDS = 500;
export const MAX_IMPACT_RESULTS_PER_DEPTH = 1000;
export const MENTIONS_MIN_CONFIDENCE = 0.5;

export function confidenceForRelType(relType: string | undefined): number {
  return IMPACT_RELATION_CONFIDENCE[relType ?? ''] ?? 0.5;
}

export function resolveRelationTypes(types: string[] | undefined): string[] {
  const mapped = types?.flatMap((t) =>
    t === 'OVERRIDES' ? ['OVERRIDES', 'METHOD_OVERRIDES'] : [t],
  );
  const filtered =
    mapped && mapped.length > 0
      ? mapped.filter((t) => VALID_RELATION_TYPES.has(t))
      : DEFAULT_IMPACT_RELATION_TYPES;
  return filtered.length > 0 ? filtered : DEFAULT_IMPACT_RELATION_TYPES;
}

export function clampImpactDepth(value: unknown, fallback = 3): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), MAX_IMPACT_DEPTH));
}

function rowValueOr(row: QueryRow, key: string, index: number): unknown {
  const keyed =
    typeof row === 'object' && row !== null && !Array.isArray(row)
      ? (row as Record<string, unknown>)[key]
      : undefined;
  return keyed || (Array.isArray(row) ? row[index] : undefined);
}

function rowValueNullish(row: QueryRow, key: string, index: number): unknown {
  const keyed =
    typeof row === 'object' && row !== null && !Array.isArray(row)
      ? (row as Record<string, unknown>)[key]
      : undefined;
  return keyed ?? (Array.isArray(row) ? row[index] : undefined);
}

function rowStringOr(row: QueryRow, key: string, index: number, fallback = ''): string {
  const value = rowValueOr(row, key, index);
  return value === null || value === undefined ? fallback : String(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error ? signal.reason.message : signal.reason;
  throw new Error(reason ? `Impact analysis aborted: ${reason}` : 'Impact analysis aborted');
}

function isImpactAbortError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Impact analysis aborted');
}

function graphSnapshot(repo: ImpactKernelRepoHandle): ImpactKernelGraphSnapshot {
  return {
    repoId: repo.id,
    ...(repo.name ? { repoName: repo.name } : {}),
    ...(repo.repoPath ? { repoPath: repo.repoPath } : {}),
    ...(repo.storagePath ? { storagePath: repo.storagePath } : {}),
    ...(repo.indexedAt ? { indexedAt: repo.indexedAt } : {}),
    ...(repo.lastCommit ? { lastCommit: repo.lastCommit } : {}),
  };
}

function buildRiskReasons(total: number, direct: number, partial: boolean): string[] {
  const reasons: string[] = [];
  if (direct >= 30) reasons.push(`direct_count>=30:${direct}`);
  else if (direct >= 15) reasons.push(`direct_count>=15:${direct}`);
  else if (direct >= 5) reasons.push(`direct_count>=5:${direct}`);
  if (total >= 200) reasons.push(`total_count>=200:${total}`);
  else if (total >= 100) reasons.push(`total_count>=100:${total}`);
  else if (total >= 30) reasons.push(`total_count>=30:${total}`);
  if (partial) reasons.push('traversal_partial');
  return reasons;
}

async function expandClassSeeds(
  repo: ImpactKernelRepoHandle,
  symId: string,
  symType: string,
  signal?: AbortSignal,
): Promise<{ seedIds: string[]; warnings: string[] }> {
  const seedIds = [symId];
  const warnings: string[] = [];
  if (symType !== 'Class' && symType !== 'Interface') return { seedIds, warnings };

  try {
    throwIfAborted(signal);
    const [ctorRows, fileRows] = await Promise.all([
      executeParameterized(
        repo.id,
        `
        MATCH (n)-[hm:CodeRelation]->(c:Constructor)
        WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
        RETURN c.id AS id, c.name AS name, labels(c)[0] AS type, c.filePath AS filePath
        LIMIT 100
      `,
        { symId },
      ),
      executeParameterized(
        repo.id,
        `
        MATCH (f:File)-[rel:CodeRelation]->(n)
        WHERE n.id = $symId AND rel.type = 'DEFINES'
        RETURN f.id AS id, f.name AS name, labels(f)[0] AS type, f.filePath AS filePath
        LIMIT 100
      `,
        { symId },
      ),
    ]);
    throwIfAborted(signal);
    for (const row of [...(ctorRows as ImpactSymbolRow[]), ...(fileRows as ImpactSymbolRow[])]) {
      const id = rowStringOr(row, 'id', 0);
      if (id && !seedIds.includes(id)) seedIds.push(id);
    }
  } catch (err) {
    if (isImpactAbortError(err)) throw err;
    warnings.push(
      `class seed expansion failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { seedIds, warnings };
}

export async function runImpactKernel(
  repo: ImpactKernelRepoHandle,
  sym: ImpactKernelSymbol,
  opts: RunImpactKernelOptions,
): Promise<ImpactKernelResult> {
  const relationTypes = resolveRelationTypes(opts.relationTypes);
  const includeTests = opts.includeTests ?? false;
  const minConfidence = opts.minConfidence ?? 0;
  const maxDepth = clampImpactDepth(opts.maxDepth);
  const countScope =
    opts.countScope ?? (maxDepth === 1 ? 'unique-direct-nodes' : 'unique-transitive-nodes');
  const symId = String(sym.id || '');
  const symType = typeof sym.type === 'string' ? sym.type : '';
  const impacted: ImpactKernelNode[] = [];
  const warnings: string[] = [];
  let traversalComplete = true;

  throwIfAborted(opts.signal);
  const expansion =
    opts.classSeedExpansion === false
      ? { seedIds: [symId], warnings: [] }
      : await expandClassSeeds(repo, symId, symType, opts.signal);
  warnings.push(...expansion.warnings);

  const visited = new Set<string>(expansion.seedIds);
  let frontier = [...expansion.seedIds];
  const relTypeFilter = relationTypes.map((t) => `'${t}'`).join(', ');
  const confidenceFilter = minConfidence > 0 ? ` AND r.confidence >= ${minConfidence}` : '';

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    throwIfAborted(opts.signal);
    const nextFrontier: string[] = [];
    if (frontier.length > MAX_IMPACT_FRONTIER_IDS) {
      traversalComplete = false;
      warnings.push(
        `Impact traversal depth ${depth} frontier capped at ${MAX_IMPACT_FRONTIER_IDS} nodes`,
      );
      frontier = frontier.slice(0, MAX_IMPACT_FRONTIER_IDS);
    }

    const idList = frontier.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
    const query =
      opts.direction === 'upstream'
        ? `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, caller.id AS id, caller.name AS name, labels(caller)[0] AS type, caller.filePath AS filePath, r.type AS relType, r.confidence AS confidence LIMIT ${MAX_IMPACT_RESULTS_PER_DEPTH}`
        : `MATCH (n)-[r:CodeRelation]->(callee) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, callee.id AS id, callee.name AS name, labels(callee)[0] AS type, callee.filePath AS filePath, r.type AS relType, r.confidence AS confidence LIMIT ${MAX_IMPACT_RESULTS_PER_DEPTH}`;

    try {
      const related = (await executeQuery(repo.id, query)) as ImpactRelatedRow[];
      throwIfAborted(opts.signal);
      if (related.length >= MAX_IMPACT_RESULTS_PER_DEPTH) {
        traversalComplete = false;
        warnings.push(
          `Impact traversal depth ${depth} result set capped at ${MAX_IMPACT_RESULTS_PER_DEPTH} rows`,
        );
      }

      for (let i = 0; i < related.length; i++) {
        if (i % 100 === 0) throwIfAborted(opts.signal);
        const rel = related[i];
        const relId = rowStringOr(rel, 'id', 1);
        const filePath = rowStringOr(rel, 'filePath', 4);
        if (!includeTests && isTestFilePath(filePath)) continue;

        const storedConfidence = rowValueNullish(rel, 'confidence', 6);
        const relationTypeRaw = rowValueOr(rel, 'relType', 5);
        const relationType = typeof relationTypeRaw === 'string' ? relationTypeRaw : undefined;
        if (
          relationType === 'MENTIONS' &&
          typeof storedConfidence === 'number' &&
          storedConfidence < MENTIONS_MIN_CONFIDENCE
        ) {
          continue;
        }

        if (!visited.has(relId)) {
          visited.add(relId);
          nextFrontier.push(relId);
          const effectiveConfidence =
            typeof storedConfidence === 'number' && storedConfidence > 0
              ? storedConfidence
              : confidenceForRelType(relationType);
          impacted.push({
            depth,
            id: relId,
            name: rowValueOr(rel, 'name', 2),
            type: rowValueOr(rel, 'type', 3),
            filePath,
            relationType,
            confidence: effectiveConfidence,
          });
        }
      }
    } catch (err) {
      if (isImpactAbortError(err)) throw err;
      traversalComplete = false;
      warnings.push(`depth traversal failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    frontier = nextFrontier;
  }

  const byDepth: Record<number, ImpactKernelNode[]> = {};
  for (const item of impacted) {
    if (!byDepth[item.depth]) byDepth[item.depth] = [];
    byDepth[item.depth].push(item);
  }
  const countByDepth: Record<number, number> = {};
  for (const [depth, items] of Object.entries(byDepth)) {
    countByDepth[Number(depth)] = items.length;
  }
  const direct = countByDepth[1] ?? 0;
  const partial = !traversalComplete;

  return {
    rawCounts: {
      resolvedUid: symId,
      graphSnapshot: graphSnapshot(repo),
      direction: opts.direction,
      traversalDepth: maxDepth,
      relationshipSet: relationTypes,
      filters: {
        includeTests,
        minConfidence,
        classSeedExpansion: opts.classSeedExpansion !== false,
        mentionsMinConfidence: MENTIONS_MIN_CONFIDENCE,
      },
      countScope,
      total: impacted.length,
      direct,
      byDepth: countByDepth,
      seedUids: expansion.seedIds,
      riskReasons: buildRiskReasons(impacted.length, direct, partial),
    },
    impacted,
    byDepth,
    partial,
    warnings,
  };
}
