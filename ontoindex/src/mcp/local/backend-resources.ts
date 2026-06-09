import { executeQuery, executeParameterized } from '../../core/lbug/pool-adapter.js';

interface ResourceRepoHandle {
  id: string;
}

type QueryRow = Record<string, unknown> | readonly unknown[];
type ClusterQueryRow = QueryRow;
type ProcessQueryRow = QueryRow;
type ClusterMemberQueryRow = QueryRow;
type ProcessStepQueryRow = QueryRow;

interface RawCluster {
  id: unknown;
  label: string | undefined;
  heuristicLabel: string | undefined;
  cohesion: number | undefined;
  symbolCount: number | undefined;
}

interface AggregatedCluster {
  id: unknown;
  label: string;
  heuristicLabel: string;
  symbolCount: number;
  cohesion: number;
  subCommunities: number;
}

interface ProcessSummary {
  id: unknown;
  label: unknown;
  heuristicLabel: unknown;
  processType: unknown;
  stepCount: unknown;
}

interface ClusterMember {
  name: unknown;
  type: unknown;
  filePath: unknown;
}

interface ClusterDetailResult {
  cluster: {
    id: unknown;
    label: string | undefined;
    heuristicLabel: string | undefined;
    cohesion: number;
    symbolCount: number;
    subCommunities: number;
  };
  members: ClusterMember[];
}

interface ProcessStep {
  step: unknown;
  name: unknown;
  type: unknown;
  filePath: unknown;
}

interface ProcessDetailResult {
  process: {
    id: unknown;
    label: unknown;
    heuristicLabel: unknown;
    processType: unknown;
    stepCount: number;
    truncated: boolean;
  };
  truncated: boolean;
  stepLimit: number;
  steps: ProcessStep[];
}

type NotFoundResult = { error: string };

const MAX_PROCESS_DETAIL_STEPS = (() => {
  const raw = Number.parseInt(process.env.ONTOINDEX_PROCESS_DETAIL_STEP_LIMIT ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 10_000) : 1_000;
})();

function rowValueOr(row: QueryRow, key: string, index: number): unknown {
  const record = row as Record<string, unknown>;
  const indexed = Array.isArray(row) ? row[index] : record[String(index)];
  return record[key] || indexed;
}

function toClusterRow(row: ClusterQueryRow): RawCluster {
  return {
    id: rowValueOr(row, 'id', 0),
    label: rowValueOr(row, 'label', 1) as string | undefined,
    heuristicLabel: rowValueOr(row, 'heuristicLabel', 2) as string | undefined,
    cohesion: rowValueOr(row, 'cohesion', 3) as number | undefined,
    symbolCount: rowValueOr(row, 'symbolCount', 4) as number | undefined,
  };
}

function toProcessSummary(row: ProcessQueryRow): ProcessSummary {
  return {
    id: rowValueOr(row, 'id', 0),
    label: rowValueOr(row, 'label', 1),
    heuristicLabel: rowValueOr(row, 'heuristicLabel', 2),
    processType: rowValueOr(row, 'processType', 3),
    stepCount: rowValueOr(row, 'stepCount', 4),
  };
}

function toClusterMember(row: ClusterMemberQueryRow): ClusterMember {
  return {
    name: rowValueOr(row, 'name', 0),
    type: rowValueOr(row, 'type', 1),
    filePath: rowValueOr(row, 'filePath', 2),
  };
}

function toProcessStep(row: ProcessStepQueryRow): ProcessStep {
  return {
    step: rowValueOr(row, 'step', 3),
    name: rowValueOr(row, 'name', 0),
    type: rowValueOr(row, 'type', 1),
    filePath: rowValueOr(row, 'filePath', 2),
  };
}

/**
 * Aggregate same-named clusters: group by heuristicLabel, sum symbols,
 * weighted-average cohesion, filter out tiny clusters (<5 symbols).
 * Raw communities stay intact in LadybugDB for Cypher queries.
 */
export function aggregateClusters(clusters: RawCluster[]): AggregatedCluster[] {
  const groups = new Map<
    string,
    { ids: unknown[]; totalSymbols: number; weightedCohesion: number; largest: RawCluster }
  >();

  for (const c of clusters) {
    const label = c.heuristicLabel || c.label || 'Unknown';
    const symbols = c.symbolCount || 0;
    const cohesion = c.cohesion || 0;
    const existing = groups.get(label);

    if (!existing) {
      groups.set(label, {
        ids: [c.id],
        totalSymbols: symbols,
        weightedCohesion: cohesion * symbols,
        largest: c,
      });
    } else {
      existing.ids.push(c.id);
      existing.totalSymbols += symbols;
      existing.weightedCohesion += cohesion * symbols;
      if (symbols > (existing.largest.symbolCount || 0)) {
        existing.largest = c;
      }
    }
  }

  return Array.from(groups.entries())
    .map(([label, g]) => ({
      id: g.largest.id,
      label,
      heuristicLabel: label,
      symbolCount: g.totalSymbols,
      cohesion: g.totalSymbols > 0 ? g.weightedCohesion / g.totalSymbols : 0,
      subCommunities: g.ids.length,
    }))
    .filter((c) => c.symbolCount >= 5)
    .sort((a, b) => b.symbolCount - a.symbolCount);
}

export async function queryClusters(
  repo: ResourceRepoHandle,
  limit = 100,
): Promise<{ clusters: AggregatedCluster[] }> {
  try {
    const rawLimit = Math.max(limit * 5, 200);
    const clusters = (await executeQuery(
      repo.id,
      `
      MATCH (c:Community)
      RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
      ORDER BY c.symbolCount DESC
      LIMIT ${rawLimit}
    `,
    )) as ClusterQueryRow[];
    const rawClusters = clusters.map(toClusterRow);
    return { clusters: aggregateClusters(rawClusters).slice(0, limit) };
  } catch {
    return { clusters: [] };
  }
}

export async function queryProcesses(
  repo: ResourceRepoHandle,
  limit = 50,
): Promise<{ processes: ProcessSummary[] }> {
  try {
    const processes = (await executeQuery(
      repo.id,
      `
      MATCH (p:Process)
      RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
      ORDER BY p.stepCount DESC
      LIMIT ${limit}
    `,
    )) as ProcessQueryRow[];
    return {
      processes: processes.map(toProcessSummary),
    };
  } catch {
    return { processes: [] };
  }
}

export async function queryClusterDetail(
  repo: ResourceRepoHandle,
  name: string,
): Promise<ClusterDetailResult | NotFoundResult> {
  const clusters = (await executeParameterized(
    repo.id,
    `
    MATCH (c:Community)
    WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
    RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
  `,
    { clusterName: name },
  )) as ClusterQueryRow[];
  if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

  const rawClusters = clusters.map(toClusterRow);

  let totalSymbols = 0;
  let weightedCohesion = 0;
  for (const c of rawClusters) {
    const symbolCount = c.symbolCount || 0;
    totalSymbols += symbolCount;
    weightedCohesion += (c.cohesion || 0) * symbolCount;
  }

  const members = (await executeParameterized(
    repo.id,
    `
    MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
    WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
    RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
    LIMIT 30
  `,
    { clusterName: name },
  )) as ClusterMemberQueryRow[];

  return {
    cluster: {
      id: rawClusters[0].id,
      label: rawClusters[0].heuristicLabel || rawClusters[0].label,
      heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
      cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
      symbolCount: totalSymbols,
      subCommunities: rawClusters.length,
    },
    members: members.map(toClusterMember),
  };
}

export async function queryProcessDetail(
  repo: ResourceRepoHandle,
  name: string,
): Promise<ProcessDetailResult | NotFoundResult> {
  const processes = (await executeParameterized(
    repo.id,
    `
    MATCH (p:Process)
    WHERE p.label = $processName OR p.heuristicLabel = $processName
    RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
    LIMIT 1
  `,
    { processName: name },
  )) as ProcessQueryRow[];
  if (processes.length === 0) return { error: `Process '${name}' not found` };

  const proc = processes[0];
  const procId = rowValueOr(proc, 'id', 0);
  const steps = (await executeParameterized(
    repo.id,
    `
    MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
    RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
    ORDER BY r.step
    LIMIT ${MAX_PROCESS_DETAIL_STEPS}
  `,
    { procId },
  )) as ProcessStepQueryRow[];
  const declaredStepCount = Number(rowValueOr(proc, 'stepCount', 4) || 0);
  const truncated = steps.length >= MAX_PROCESS_DETAIL_STEPS || declaredStepCount > steps.length;

  return {
    process: {
      id: procId,
      label: rowValueOr(proc, 'label', 1),
      heuristicLabel: rowValueOr(proc, 'heuristicLabel', 2),
      processType: rowValueOr(proc, 'processType', 3),
      stepCount: declaredStepCount,
      truncated,
    },
    truncated,
    stepLimit: MAX_PROCESS_DETAIL_STEPS,
    steps: steps.map(toProcessStep),
  };
}
