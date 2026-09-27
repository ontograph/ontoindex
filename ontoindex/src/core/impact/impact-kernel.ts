import { executeParameterized } from '../lbug/pool-adapter.js';
import { relationTypePredicate } from '../lbug/relation-type-predicate.js';
import { classifyGraphFactProvenance, type GraphFactProvenance } from '../graph/fact-provenance.js';

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
  provenance?: GraphFactProvenance;
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
  /** How a container target (class, struct, impl, ...) was expanded into seeds. */
  seedExpansion?: ImpactKernelSeedExpansion;
}

export interface ImpactKernelSeedExpansion {
  /** Target kind used for expansion: the graph label, or the id prefix when the label is empty. */
  kind: string;
  /** Container nodes whose HAS_METHOD members were read (target plus related impl/type nodes). */
  ownerUids: string[];
  /** HAS_METHOD members found on the owners (bounded by the member query limit). */
  ownedMethods: number;
  /** Members added as traversal seeds. */
  seededMembers: number;
  /** Members that exist but were not traversed (not seeded by kind, or over the seed cap). */
  unseededMembers: number;
}

export interface ImpactKernelResult {
  rawCounts: ImpactKernelRawCounts;
  impacted: ImpactKernelNode[];
  byDepth: Record<number, ImpactKernelNode[]>;
  partial: boolean;
  /** A depth query errored, so impacted nodes beyond that depth were never read. */
  traversalFailed: boolean;
  /**
   * Set when the traversal found nothing but the target owns method members
   * that were never traversed, so 0 impacted nodes does not show the edit is
   * safe. Callers should report risk UNKNOWN.
   */
  unknownReason?: string;
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
/** Upper bound on HAS_METHOD members added as seeds for one container target. */
export const MAX_CONTAINER_MEMBER_SEEDS = 200;
const CONTAINER_MEMBER_QUERY_LIMIT = 1000;
const CLASS_KINDS = new Set(['Class', 'Interface']);
/** Kinds whose callers attach to member methods (Rust impl blocks, C++/Rust structs, traits). */
const MEMBER_SEEDED_KINDS = new Set(['Struct', 'Enum', 'Trait', 'Impl', 'Union']);
const KNOWN_ID_PREFIX_KINDS = new Set([...CLASS_KINDS, ...MEMBER_SEEDED_KINDS]);

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

/**
 * Cypher predicate matching `r.type` against a set of relation types, as an
 * OR chain of `=` comparisons. See relation-type-predicate.ts for the
 * LadybugDB `IN` defect this avoids. Types come from VALID_RELATION_TYPES.
 */
export function buildRelationTypePredicate(relationTypes: readonly string[]): string {
  return relationTypePredicate('r', relationTypes);
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

/** Target kind from its label, or from the `Kind:` id prefix when the label is empty. */
export function resolveImpactTargetKind(symType: string, symId: string): string {
  if (symType) return symType;
  const prefix = symId.slice(0, Math.max(0, symId.indexOf(':')));
  return KNOWN_ID_PREFIX_KINDS.has(prefix) ? prefix : '';
}

function idSuffixName(symId: string): string {
  return symId.slice(symId.lastIndexOf(':') + 1);
}

function idFilePath(symId: string): string {
  const first = symId.indexOf(':');
  const last = symId.lastIndexOf(':');
  return first >= 0 && last > first ? symId.slice(first + 1, last) : '';
}

interface SeedExpansionOutcome {
  seedIds: string[];
  warnings: string[];
  partial: boolean;
  expansion?: ImpactKernelSeedExpansion;
}

/**
 * Related container ids whose members belong to the same type. Rust stores
 * inherent methods under `Impl:<file>:<Name>` and trait-impl methods under
 * `Struct:<file>:<Name>`, with no edge between the two nodes. Same-file ids
 * are built directly; impl blocks in other files are added only when the type
 * name is unique in the graph, because name matches across crates are ambiguous.
 */
async function relatedContainerOwners(
  repo: ImpactKernelRepoHandle,
  symId: string,
  kind: string,
  name: string,
  filePath: string,
  warnings: string[],
): Promise<string[]> {
  if (!name || !filePath) return [];
  if (kind === 'Impl') return [`Struct:${filePath}:${name}`, `Enum:${filePath}:${name}`];
  if (kind !== 'Struct' && kind !== 'Enum' && kind !== 'Union') return [];

  const owners = [`Impl:${filePath}:${name}`];
  const [typeRows, implRows] = await Promise.all([
    executeParameterized(
      repo.id,
      `MATCH (t) WHERE t.name = $name AND (label(t) = 'Struct' OR label(t) = 'Enum' OR label(t) = 'Trait' OR label(t) = 'Union') RETURN t.id AS id LIMIT 50`,
      { name },
    ),
    executeParameterized(
      repo.id,
      `MATCH (i:Impl) WHERE i.name = $name RETURN i.id AS id LIMIT 50`,
      { name },
    ),
  ]);
  const implIds = (implRows as QueryRow[])
    .map((row) => rowStringOr(row, 'id', 0))
    .filter((id) => id && !owners.includes(id));
  if (implIds.length === 0) return owners;
  if (typeRows.length <= 1) return [...owners, ...implIds];
  warnings.push(
    `${implIds.length} impl block(s) named ${name} in other files were not expanded: ${typeRows.length} types share that name (target ${symId})`,
  );
  return owners;
}

async function expandContainerSeeds(
  repo: ImpactKernelRepoHandle,
  sym: ImpactKernelSymbol,
  symId: string,
  kind: string,
  signal?: AbortSignal,
): Promise<SeedExpansionOutcome> {
  const seedIds = [symId];
  const warnings: string[] = [];
  const isClass = CLASS_KINDS.has(kind);
  if (!isClass && !MEMBER_SEEDED_KINDS.has(kind)) return { seedIds, warnings, partial: false };

  const name = typeof sym.name === 'string' && sym.name ? sym.name : idSuffixName(symId);
  const filePath =
    typeof sym.filePath === 'string' && sym.filePath ? sym.filePath : idFilePath(symId);
  let partial = false;

  try {
    throwIfAborted(signal);
    const ownerUids = [
      symId,
      ...(isClass ? [] : await relatedContainerOwners(repo, symId, kind, name, filePath, warnings)),
    ];
    throwIfAborted(signal);
    const [memberRows, fileRows] = await Promise.all([
      executeParameterized(
        repo.id,
        `
        MATCH (n)-[hm:CodeRelation]->(m)
        WHERE n.id IN $ownerIds AND hm.type = 'HAS_METHOD'
        RETURN DISTINCT m.id AS id, label(m) AS type
        LIMIT ${CONTAINER_MEMBER_QUERY_LIMIT}
      `,
        { ownerIds: ownerUids },
      ),
      isClass
        ? executeParameterized(
            repo.id,
            `
        MATCH (f:File)-[rel:CodeRelation]->(n)
        WHERE n.id = $symId AND rel.type = 'DEFINES'
        RETURN f.id AS id
        LIMIT 100
      `,
            { symId },
          )
        : Promise.resolve([]),
    ]);
    throwIfAborted(signal);

    const members = (memberRows as QueryRow[])
      .map((row) => ({ id: rowStringOr(row, 'id', 0), type: rowStringOr(row, 'type', 1) }))
      .filter((m) => m.id && m.id !== symId);
    // Classes keep their established expansion: constructors plus the defining file.
    // Other methods of a class are reached through their own callers, not the class node.
    const eligible = isClass ? members.filter((m) => m.type === 'Constructor') : members;
    const limit = isClass ? 100 : MAX_CONTAINER_MEMBER_SEEDS;
    const chosen = eligible.slice(0, limit);
    if (eligible.length > limit) {
      partial = true;
      warnings.push(
        `Impact seed expansion capped at ${limit} of ${eligible.length} members of ${kind} ${name}`,
      );
    }
    for (const m of chosen) if (!seedIds.includes(m.id)) seedIds.push(m.id);
    for (const row of fileRows as QueryRow[]) {
      const id = rowStringOr(row, 'id', 0);
      if (id && !seedIds.includes(id)) seedIds.push(id);
    }
    if (members.length >= CONTAINER_MEMBER_QUERY_LIMIT) {
      partial = true;
      warnings.push(
        `Impact member lookup for ${kind} ${name} stopped at ${CONTAINER_MEMBER_QUERY_LIMIT} members`,
      );
    }

    return {
      seedIds,
      warnings,
      partial,
      expansion: {
        kind,
        ownerUids,
        ownedMethods: members.length,
        seededMembers: chosen.length,
        unseededMembers: members.length - chosen.length,
      },
    };
  } catch (err) {
    if (isImpactAbortError(err)) throw err;
    warnings.push(
      `${isClass ? 'class' : 'container'} seed expansion failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { seedIds, warnings, partial: true };
  }
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
  let traversalFailed = false;

  throwIfAborted(opts.signal);
  const targetKind = resolveImpactTargetKind(symType, symId);
  const expansion: SeedExpansionOutcome =
    opts.classSeedExpansion === false
      ? { seedIds: [symId], warnings: [], partial: false }
      : await expandContainerSeeds(repo, sym, symId, targetKind, opts.signal);
  warnings.push(...expansion.warnings);
  if (expansion.partial) traversalComplete = false;

  const visited = new Set<string>(expansion.seedIds);
  let frontier = [...expansion.seedIds];
  const relTypeFilter = buildRelationTypePredicate(relationTypes);
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

    const query =
      opts.direction === 'upstream'
        ? `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN $frontierIds AND ${relTypeFilter}${confidenceFilter} RETURN n.id AS sourceId, caller.id AS id, caller.name AS name, label(caller) AS type, caller.filePath AS filePath, r.type AS relType, r.confidence AS confidence LIMIT ${MAX_IMPACT_RESULTS_PER_DEPTH}`
        : `MATCH (n)-[r:CodeRelation]->(callee) WHERE n.id IN $frontierIds AND ${relTypeFilter}${confidenceFilter} RETURN n.id AS sourceId, callee.id AS id, callee.name AS name, label(callee) AS type, callee.filePath AS filePath, r.type AS relType, r.confidence AS confidence LIMIT ${MAX_IMPACT_RESULTS_PER_DEPTH}`;

    try {
      // Node ids are bound as a parameter: they are data, never Cypher text.
      const related = (await executeParameterized(repo.id, query, {
        frontierIds: frontier,
      })) as ImpactRelatedRow[];
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
            provenance: classifyGraphFactProvenance({
              relationType,
              confidence: effectiveConfidence,
            }),
          });
        }
      }
    } catch (err) {
      if (isImpactAbortError(err)) throw err;
      traversalComplete = false;
      traversalFailed = true;
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
  const riskReasons = buildRiskReasons(impacted.length, direct, partial);
  let unknownReason: string | undefined;
  if (impacted.length === 0 && !traversalFailed) {
    const unseeded = expansion.expansion?.unseededMembers ?? 0;
    if (unseeded > 0) {
      unknownReason = `container_members_not_traversed:${unseeded}`;
      warnings.push(
        `0 impacted nodes, but ${targetKind} ${String(sym.name ?? symId)} owns ${unseeded} method(s) that were not traversed; run impact on those methods before treating this edit as safe`,
      );
    } else {
      riskReasons.push('no_impacted_nodes');
    }
  }
  if (unknownReason) riskReasons.push(unknownReason);

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
      riskReasons,
      ...(expansion.expansion ? { seedExpansion: expansion.expansion } : {}),
    },
    impacted,
    byDepth,
    partial,
    traversalFailed,
    ...(unknownReason ? { unknownReason } : {}),
    warnings,
  };
}
