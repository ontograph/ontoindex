import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import {
  IMPACT_RELATION_CONFIDENCE,
  VALID_RELATION_TYPES,
  clampImpactDepth,
  isTestFilePath,
  resolveRelationTypes,
  runImpactKernel,
  type ImpactKernelRawCounts,
} from '../../core/impact/impact-kernel.js';
import { resolveSymbolCandidates } from './backend-symbol-resolution.js';

interface ImpactRepoHandle {
  id: string;
  name: string;
  repoPath?: string;
}

export { IMPACT_RELATION_CONFIDENCE, VALID_RELATION_TYPES, isTestFilePath };

type QueryRow = Record<string, unknown> | readonly unknown[];
type ImpactSymbolRow = QueryRow;
type ProcessImpactRow = QueryRow;
type ProcessMinStepRow = QueryRow;
type ModuleImpactRow = QueryRow;

interface ImpactedNode {
  depth: number;
  id: string;
  name: unknown;
  type: unknown;
  filePath: string;
  relationType: string | undefined;
  confidence: number;
}

interface AffectedProcess {
  name: string;
  type: string;
  filePath: string;
  affected_process_count: number;
  total_hits: number;
  earliest_broken_step: number | null;
}

interface AffectedModule {
  name: string;
  hits: number;
  impact: 'direct' | 'indirect';
}

type ImpactDirection = ImpactParams['direction'];
type ImpactRisk = 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

interface ImpactCandidate {
  uid: string;
  name: string;
  kind: string;
  filePath: string;
  line: number | undefined;
  score: number;
}

interface ImpactBaseResult {
  target: {
    id?: string;
    name: unknown;
    type?: string;
    filePath?: unknown;
  };
  direction: ImpactDirection;
  impactedCount: number;
  risk: ImpactRisk;
  error?: string;
}

interface ImpactErrorResult extends ImpactBaseResult {
  risk: 'UNKNOWN';
  error: string;
  suggestion?: string;
}

interface ImpactAmbiguousResult extends ImpactBaseResult {
  status: 'ambiguous';
  message: string;
  risk: 'UNKNOWN';
  candidates: ImpactCandidate[];
}

interface ImpactSuccessResult extends ImpactBaseResult {
  target: {
    id: string;
    name: unknown;
    type: string;
    filePath: unknown;
  };
  risk: Exclude<ImpactRisk, 'UNKNOWN'>;
  partial?: true;
  warnings?: string[];
  summary: {
    direct: number;
    processes_affected: number;
    modules_affected: number;
  };
  affected_processes: AffectedProcess[];
  affected_modules: AffectedModule[];
  byDepth: Record<number, ImpactedNode[]>;
  rawCounts?: ImpactKernelRawCounts;
}

type ImpactResult = ImpactErrorResult | ImpactAmbiguousResult | ImpactSuccessResult;

function logQueryError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`OntoIndex [${context}]: ${msg}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowValueOr(row: QueryRow, key: string, index: number): unknown {
  const keyed = isRecord(row) ? row[key] : undefined;
  return keyed || (Array.isArray(row) ? row[index] : undefined);
}

function rowValueNullish(row: QueryRow, key: string, index: number): unknown {
  const keyed = isRecord(row) ? row[key] : undefined;
  return keyed ?? (Array.isArray(row) ? row[index] : undefined);
}

function rowStringOr(row: QueryRow, key: string, index: number, fallback = ''): string {
  const value = rowValueOr(row, key, index);
  return value === null || value === undefined ? fallback : String(value);
}

function numberOrInfinity(value: unknown): number {
  if (value === null || value === undefined) return Infinity;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : Infinity;
}

type ImpactParams = {
  target: string;
  target_uid?: string;
  file_path?: string;
  kind?: string;
  direction: 'upstream' | 'downstream';
  maxDepth?: number;
  relationTypes?: string[];
  includeTests?: boolean;
  minConfidence?: number;
  signal?: AbortSignal;
};

export async function runImpact(
  repo: ImpactRepoHandle,
  params: ImpactParams,
): Promise<ImpactResult> {
  try {
    return await impactImpl(repo, params);
  } catch (err: unknown) {
    return {
      error: (err instanceof Error ? err.message : String(err)) || 'Impact analysis failed',
      target: { name: params.target },
      direction: params.direction,
      impactedCount: 0,
      risk: 'UNKNOWN',
      suggestion: 'The graph query failed — try ontoindex context <symbol> as a fallback',
    };
  }
}

async function impactImpl(repo: ImpactRepoHandle, params: ImpactParams): Promise<ImpactResult> {
  throwIfAborted(params.signal);
  const { target, direction } = params;
  const maxDepth = clampImpactDepth(params.maxDepth);
  const relationTypes = resolveRelationTypes(params.relationTypes);
  const includeTests = params.includeTests ?? false;
  const minConfidence = params.minConfidence ?? 0;

  const outcome = await resolveSymbolCandidates(
    repo,
    { uid: params.target_uid, name: target },
    { file_path: params.file_path, kind: params.kind },
  );

  if (outcome.kind === 'not_found') {
    const missing = params.target_uid ?? target;
    return {
      error: `Target '${missing}' not found`,
      target: { name: target },
      direction,
      impactedCount: 0,
      risk: 'UNKNOWN',
    };
  }

  if (outcome.kind === 'ambiguous') {
    return {
      status: 'ambiguous',
      message: `Found ${outcome.candidates.length} symbols matching '${target}'. Use target_uid, file_path, or kind to disambiguate.`,
      target: { name: target },
      direction,
      impactedCount: 0,
      risk: 'UNKNOWN',
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

  const sym = {
    id: outcome.symbol.id,
    name: outcome.symbol.name,
    filePath: outcome.symbol.filePath,
  };
  const symType = outcome.resolvedLabel || outcome.symbol.type || '';

  throwIfAborted(params.signal);
  return runImpactBFS(repo, sym, symType, direction, {
    maxDepth,
    relationTypes,
    includeTests,
    minConfidence,
    signal: params.signal,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error ? signal.reason.message : signal.reason;
  throw new Error(reason ? `Impact analysis aborted: ${reason}` : 'Impact analysis aborted');
}

export async function runImpactBFS(
  repo: ImpactRepoHandle,
  sym: ImpactSymbolRow,
  symType: string,
  direction: 'upstream' | 'downstream',
  opts: {
    maxDepth: number;
    relationTypes: string[];
    includeTests: boolean;
    minConfidence: number;
    signal?: AbortSignal;
  },
): Promise<ImpactSuccessResult> {
  const symId = String(rowValueOr(sym, 'id', 0) || '');
  const kernel = await runImpactKernel(
    repo,
    {
      id: symId,
      name: rowValueOr(sym, 'name', 1),
      type: symType,
      filePath: rowValueOr(sym, 'filePath', 2),
    },
    {
      direction,
      maxDepth: opts.maxDepth,
      relationTypes: opts.relationTypes,
      includeTests: opts.includeTests,
      minConfidence: opts.minConfidence,
      signal: opts.signal,
    },
  );
  const impacted = kernel.impacted;
  const grouped = kernel.byDepth;
  const warnings = [...kernel.warnings];
  let partial = kernel.partial;
  const directCount = (grouped[1] || []).length;
  let affectedProcesses: AffectedProcess[] = [];
  let affectedModules: AffectedModule[] = [];

  if (impacted.length > 0) {
    const CHUNK_SIZE = 100;
    const MAX_CHUNKS = parseInt(process.env.IMPACT_MAX_CHUNKS || '10', 10);

    const entryPointMap = new Map<
      string,
      {
        name: string;
        type: string;
        filePath: string;
        affected_process_count: number;
        total_hits: number;
        earliest_broken_step: number;
      }
    >();

    const processToEntryPoint = new Map<string, string>();
    const processesMissingMinStep = new Set<string>();

    let chunksProcessed = 0;
    for (
      let i = 0;
      i < impacted.length && chunksProcessed < MAX_CHUNKS;
      i += CHUNK_SIZE, chunksProcessed++
    ) {
      const chunk = impacted.slice(i, i + CHUNK_SIZE);
      const ids = chunk.map((item) => String(item.id ?? ''));

      try {
        const rows = (await executeParameterized(
          repo.id,
          `
          MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE s.id IN $ids
          WITH p, COUNT(DISTINCT s.id) AS hits, MIN(r.step) AS minStep
          OPTIONAL MATCH (ep {id: p.entryPointId})
          RETURN p.id AS pId, p.heuristicLabel AS name, p.processType AS processType,
                 p.entryPointId AS entryPointId, hits, minStep, p.stepCount AS stepCount,
                 ep.name AS epName, labels(ep)[0] AS epType, ep.filePath AS epFilePath
        `,
          { ids },
        ).catch(() => [])) as ProcessImpactRow[];

        for (const row of rows) {
          const pId = rowValueNullish(row, 'pId', 0);
          const epId = rowValueNullish(row, 'entryPointId', 3) ?? rowValueNullish(row, 'pId', 0);
          if (pId) processToEntryPoint.set(String(pId), String(epId));

          const epNameRaw =
            rowValueNullish(row, 'epName', 7) ?? rowValueNullish(row, 'name', 1) ?? 'unknown';
          const epName =
            typeof epNameRaw === 'string' && epNameRaw.trim().length > 0
              ? epNameRaw.trim()
              : 'unknown';

          const epTypeRaw = rowValueNullish(row, 'epType', 8) ?? '';
          const epType =
            typeof epTypeRaw === 'string' && epTypeRaw.trim().length > 0
              ? epTypeRaw.trim()
              : 'Function';

          const epFilePathRaw = rowValueNullish(row, 'epFilePath', 9) ?? '';
          const epFilePath =
            typeof epFilePathRaw === 'string' ? epFilePathRaw : String(epFilePathRaw);
          const hitsRaw = rowValueNullish(row, 'hits', 4) ?? 0;
          const hits = typeof hitsRaw === 'number' ? hitsRaw : Number(hitsRaw) || 0;
          const minStep = rowValueNullish(row, 'minStep', 5);
          if (minStep === null || minStep === undefined) {
            if (pId) processesMissingMinStep.add(String(pId));
          }
          const entryPointId = String(epId);
          if (!entryPointMap.has(entryPointId)) {
            entryPointMap.set(entryPointId, {
              name: epName,
              type: epType,
              filePath: epFilePath,
              affected_process_count: 0,
              total_hits: 0,
              earliest_broken_step: Infinity,
            });
          }
          const ep = entryPointMap.get(entryPointId)!;
          ep.affected_process_count += 1;
          ep.total_hits += hits;
          ep.earliest_broken_step = Math.min(ep.earliest_broken_step, numberOrInfinity(minStep));
        }
      } catch (e) {
        logQueryError('impact:process-chunk', e);
      }
    }

    if (processesMissingMinStep.size > 0) {
      try {
        const pIds = Array.from(processesMissingMinStep);
        const allImpactedIds = impacted.map((it) => String(it.id ?? ''));
        const missingRows = (await executeParameterized(
          repo.id,
          `
          MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE p.id IN $pIds AND s.id IN $ids
          RETURN p.id AS pid, MIN(r.step) AS minStep
        `,
          { pIds, ids: allImpactedIds },
        ).catch(() => [])) as ProcessMinStepRow[];

        for (const mr of missingRows) {
          const pid = rowValueNullish(mr, 'pid', 0);
          const minStep = rowValueNullish(mr, 'minStep', 1);
          const epId = processToEntryPoint.get(String(pid));
          if (!epId) continue;
          const ep = entryPointMap.get(epId);
          if (!ep) continue;
          ep.earliest_broken_step = Math.min(ep.earliest_broken_step, numberOrInfinity(minStep));
        }
      } catch (e) {
        logQueryError('impact:process-chunk-backfill', e);
      }
    }

    if (chunksProcessed * CHUNK_SIZE < impacted.length) {
      partial = true;
    }

    affectedProcesses = Array.from(entryPointMap.values())
      .map((ep) => ({
        ...ep,
        earliest_broken_step: ep.earliest_broken_step === Infinity ? null : ep.earliest_broken_step,
      }))
      .sort((a, b) => b.total_hits - a.total_hits);

    const maxItems = Math.min(impacted.length, MAX_CHUNKS * CHUNK_SIZE);
    const cappedImpacted = impacted.slice(0, maxItems);
    const allIdsArr = cappedImpacted.map((i) => String(i.id ?? ''));
    const d1Items = (grouped[1] || []).slice(0, maxItems);
    const d1IdsArr = d1Items.map((i) => String(i.id ?? ''));

    const moduleHitsMap = new Map<string, number>();
    const directModuleSet = new Set<string>();

    const runModuleChunk = async (idsChunk: string[]) => {
      if (!idsChunk || idsChunk.length === 0) return;
      try {
        const rows = (await executeParameterized(
          repo.id,
          `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN $ids
          RETURN c.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits
          ORDER BY hits DESC
          LIMIT 20
        `,
          { ids: idsChunk },
        ).catch(() => [])) as ModuleImpactRow[];

        for (const r of rows) {
          const name = rowValueNullish(r, 'name', 0) ?? null;
          const hitsRaw = rowValueOr(r, 'hits', 1) || 0;
          const hits = typeof hitsRaw === 'number' ? hitsRaw : Number(hitsRaw) || 0;
          if (!name) continue;
          const moduleName = String(name);
          moduleHitsMap.set(moduleName, (moduleHitsMap.get(moduleName) || 0) + hits);
        }
      } catch (e) {
        logQueryError('impact:module-chunk', e);
      }
    };

    for (let i = 0; i < allIdsArr.length; i += CHUNK_SIZE) {
      const chunkIds = allIdsArr.slice(i, i + CHUNK_SIZE);
      await runModuleChunk(chunkIds);
    }

    const runDirectModuleChunk = async (idsChunk: string[]) => {
      if (!idsChunk || idsChunk.length === 0) return;
      try {
        const rows = (await executeParameterized(
          repo.id,
          `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN $ids
          RETURN DISTINCT c.heuristicLabel AS name
        `,
          { ids: idsChunk },
        ).catch(() => [])) as ModuleImpactRow[];
        for (const r of rows) {
          const name = rowValueNullish(r, 'name', 0) ?? null;
          if (name) directModuleSet.add(String(name));
        }
      } catch (e) {
        logQueryError('impact:direct-module-chunk', e);
      }
    };

    for (let i = 0; i < d1IdsArr.length; i += CHUNK_SIZE) {
      const chunkIds = d1IdsArr.slice(i, i + CHUNK_SIZE);
      await runDirectModuleChunk(chunkIds);
    }

    const moduleRows = Array.from(moduleHitsMap.entries())
      .map(([name, hits]) => ({ name, hits }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 20);

    const directModuleRows = Array.from(directModuleSet).map((name) => ({ name }));

    const directModuleNameSet = new Set(directModuleRows.map((r) => r.name));
    affectedModules = moduleRows.map((r) => {
      const name = r.name;
      const hits = r.hits;
      return {
        name,
        hits,
        impact: directModuleNameSet.has(name) ? 'direct' : 'indirect',
      };
    });
  }

  const processCount = affectedProcesses.length;
  const moduleCount = affectedModules.length;
  let risk: ImpactSuccessResult['risk'] = 'LOW';
  if (directCount >= 30 || processCount >= 5 || moduleCount >= 5 || impacted.length >= 200) {
    risk = 'CRITICAL';
  } else if (directCount >= 15 || processCount >= 3 || moduleCount >= 3 || impacted.length >= 100) {
    risk = 'HIGH';
  } else if (directCount >= 5 || impacted.length >= 30) {
    risk = 'MEDIUM';
  }

  return {
    target: {
      id: symId,
      name: rowValueOr(sym, 'name', 1),
      type: symType,
      filePath: rowValueOr(sym, 'filePath', 2),
    },
    direction,
    impactedCount: impacted.length,
    risk,
    ...(partial && { partial: true }),
    ...(warnings.length > 0 && { warnings }),
    summary: {
      direct: directCount,
      processes_affected: processCount,
      modules_affected: moduleCount,
    },
    affected_processes: affectedProcesses,
    affected_modules: affectedModules,
    byDepth: grouped,
    rawCounts: {
      ...kernel.rawCounts,
      riskReasons: [
        ...kernel.rawCounts.riskReasons,
        ...(processCount >= 5
          ? [`process_count>=5:${processCount}`]
          : processCount >= 3
            ? [`process_count>=3:${processCount}`]
            : []),
        ...(moduleCount >= 5
          ? [`module_count>=5:${moduleCount}`]
          : moduleCount >= 3
            ? [`module_count>=3:${moduleCount}`]
            : []),
      ],
    },
  };
}

export async function impactByUid(
  repo: ImpactRepoHandle,
  uid: string,
  direction: string,
  opts: {
    maxDepth: number;
    relationTypes: string[];
    minConfidence: number;
    includeTests: boolean;
  },
): Promise<ImpactSuccessResult | null> {
  let rows: ImpactSymbolRow[];
  try {
    rows = (await executeParameterized(
      repo.id,
      `MATCH (n) WHERE n.id = $uid
       RETURN n.id AS id, n.name AS name, n.filePath AS filePath, labels(n)[0] AS type
       LIMIT 1`,
      { uid },
    )) as ImpactSymbolRow[];
  } catch {
    return null;
  }
  if (!rows?.length) return null;

  const sym = rows[0];
  const labelRaw = rowValueNullish(sym, 'type', 3);
  const symType = typeof labelRaw === 'string' && labelRaw.trim().length > 0 ? labelRaw.trim() : '';
  const dir: 'upstream' | 'downstream' = direction === 'downstream' ? 'downstream' : 'upstream';

  const relationTypes = resolveRelationTypes(opts.relationTypes);

  try {
    return await runImpactBFS(repo, sym, symType, dir, {
      maxDepth: opts.maxDepth,
      relationTypes,
      includeTests: opts.includeTests,
      minConfidence: opts.minConfidence,
    });
  } catch {
    return null;
  }
}
