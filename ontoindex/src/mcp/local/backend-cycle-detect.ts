import { minimatch } from 'minimatch';
import { tarjanSccs } from 'ontoindex-shared';
import { executeParameterized, isLbugReady } from '../../core/lbug/pool-adapter.js';
import { DiagnosticFinding } from 'ontoindex-shared';

type RepoHandle = { readonly id: string; readonly name: string };

/**
 * Maps internal DetectedCycle to normalized DiagnosticFinding (Phase D).
 */
function mapCyclesToFindings(cycles: DetectedCycle[]): DiagnosticFinding[] {
  return cycles.map((c) => {
    return {
      ruleId: 'GNC-101',
      ruleName: 'Circular Dependency',
      severity: c.cycle_length > 5 ? 'critical' : 'warning',
      confidence: 1.0,
      message: `Circular dependency detected involving ${c.cycle_length} symbols: ${c.members.map((m) => m.name).join(' -> ')}.`,
      location: {
        filePath: c.members[0].filePath,
        symbolName: c.members[0].name,
      },
      properties: {
        cycleLength: c.cycle_length,
        members: c.members,
      },
      suggestion:
        'Break the cycle by extracting shared logic into a common base or utilizing dependency injection.',
    };
  });
}

interface CycleEdgeRow {
  sourceId: string;
  sourceName: string | null;
  sourceFilePath: string | null;
  targetId: string;
  targetName: string | null;
  targetFilePath: string | null;
  edgeType: string;
}

interface CycleNode {
  id: string;
  name: string;
  filePath: string;
  kind: string;
}

interface CycleMember {
  id: string;
  name: string;
  filePath: string;
  kind: string;
}

interface DetectedCycle {
  cycle_length: number;
  affected_files: number;
  edge_types: string[];
  members: CycleMember[];
}

interface CycleDetectResult {
  status: 'success' | 'error';
  tool: 'cycle_detect';
  repo: string;
  edge_types: string[];
  min_cycle_length: number;
  limit: number;
  file_filter?: string;
  cycles: DetectedCycle[];
  summary: {
    total_cycles: number;
    largest_cycle_size: number;
    affected_files: number;
  };
  error?: string;
  warnings?: string[];
}

const DEFAULT_EDGE_TYPES = ['IMPORTS', 'CALLS'];
const MAX_CYCLE_EDGE_ROWS = (() => {
  const raw = Number.parseInt(process.env.ONTOINDEX_CYCLE_DETECT_MAX_EDGES ?? '', 10);
  return Number.isFinite(raw) ? Math.max(1000, Math.min(raw, 500_000)) : 50_000;
})();

function normalizeEdgeTypes(input: unknown): string[] {
  if (input === undefined) return DEFAULT_EDGE_TYPES.slice();
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(cleaned));
}

function parsePositiveInt(value: unknown, fallback: number, minimum = 1, maximum = 200): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return Math.min(maximum, Math.max(minimum, rounded));
}

function normalizeFilePath(filePath: string | null | undefined): string {
  return (filePath ?? '').replace(/\\/g, '/');
}

function matchesFilter(filePath: string, fileFilter: string | undefined): boolean {
  if (!fileFilter) return true;
  return minimatch(filePath, fileFilter, { dot: true });
}

function inferKindFromId(id: string): string {
  const prefix = id.split(':', 1)[0].trim();
  const lowered = prefix.toLowerCase();
  switch (lowered) {
    case 'func':
    case 'function':
      return 'Function';
    case 'method':
      return 'Method';
    case 'class':
      return 'Class';
    case 'interface':
      return 'Interface';
    case 'file':
      return 'File';
    case 'route':
      return 'Route';
    case 'tool':
      return 'Tool';
    case 'codeelement':
    case 'code':
      return 'CodeElement';
    case 'module':
      return 'Module';
    case 'property':
      return 'Property';
    case 'constructor':
      return 'Constructor';
    default:
      if (prefix.length === 0) return 'Unknown';
      return prefix[0].toUpperCase() + prefix.slice(1);
  }
}

function sortMembers(members: CycleMember[]): CycleMember[] {
  return [...members].sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.id.localeCompare(b.id);
  });
}

function buildCycleNodes(
  rows: CycleEdgeRow[],
  fileFilter?: string,
): {
  nodes: Map<string, CycleNode>;
  edges: CycleEdgeRow[];
} {
  const nodes = new Map<string, CycleNode>();
  const edges: CycleEdgeRow[] = [];

  for (const row of rows) {
    const sourceFilePath = normalizeFilePath(row.sourceFilePath);
    const targetFilePath = normalizeFilePath(row.targetFilePath);
    if (!sourceFilePath || !targetFilePath) continue;
    if (!matchesFilter(sourceFilePath, fileFilter) || !matchesFilter(targetFilePath, fileFilter)) {
      continue;
    }

    const sourceNode: CycleNode = {
      id: row.sourceId,
      name: row.sourceName || pathBasename(sourceFilePath),
      filePath: sourceFilePath,
      kind: inferKindFromId(row.sourceId),
    };
    const targetNode: CycleNode = {
      id: row.targetId,
      name: row.targetName || pathBasename(targetFilePath),
      filePath: targetFilePath,
      kind: inferKindFromId(row.targetId),
    };
    nodes.set(sourceNode.id, sourceNode);
    nodes.set(targetNode.id, targetNode);
    edges.push({
      ...row,
      sourceFilePath,
      targetFilePath,
    });
  }

  return { nodes, edges };
}

function pathBasename(filePath: string): string {
  const normalized = normalizeFilePath(filePath);
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function formatCaughtMessage(err: unknown): unknown {
  const message =
    err !== null && err !== undefined && (typeof err === 'object' || typeof err === 'function')
      ? (err as { message?: unknown }).message
      : undefined;
  return message ?? String(err);
}

export async function runCycleDetect(
  repo: RepoHandle,
  params: {
    edge_types?: string[];
    min_cycle_length?: number;
    file_filter?: string;
    limit?: number;
  },
): Promise<CycleDetectResult> {
  const edgeTypes = normalizeEdgeTypes(params?.edge_types);
  const minCycleLength = parsePositiveInt(params?.min_cycle_length, 2);
  const limit = parsePositiveInt(params?.limit, 30);
  const fileFilter =
    typeof params?.file_filter === 'string' && params.file_filter.trim().length > 0
      ? params.file_filter.trim()
      : undefined;

  const emptySummary = {
    total_cycles: 0,
    largest_cycle_size: 0,
    affected_files: 0,
  };

  if (edgeTypes.length === 0) {
    return {
      status: 'error',
      tool: 'cycle_detect',
      repo: repo.name,
      edge_types: [],
      min_cycle_length: minCycleLength,
      limit,
      ...(fileFilter ? { file_filter: fileFilter } : {}),
      cycles: [],
      summary: emptySummary,
      error: '`edge_types` must contain at least one non-empty string.',
    };
  }

  if (!isLbugReady(repo.id)) {
    return {
      status: 'error',
      tool: 'cycle_detect',
      repo: repo.name,
      edge_types: edgeTypes,
      min_cycle_length: minCycleLength,
      limit,
      ...(fileFilter ? { file_filter: fileFilter } : {}),
      cycles: [],
      summary: emptySummary,
      error: 'LadybugDB not initialized for this repo.',
    };
  }

  try {
    const rows = (await executeParameterized(
      repo.id,
      `
      MATCH (source)-[r:CodeRelation]->(target)
      WHERE r.type IN $edgeTypes
      RETURN
        source.id AS sourceId,
        source.name AS sourceName,
        source.filePath AS sourceFilePath,
        target.id AS targetId,
        target.name AS targetName,
        target.filePath AS targetFilePath,
        r.type AS edgeType
      LIMIT ${MAX_CYCLE_EDGE_ROWS}
      `,
      { edgeTypes },
    )) as CycleEdgeRow[];
    const warnings =
      rows.length >= MAX_CYCLE_EDGE_ROWS
        ? [`Cycle edge scan capped at ${MAX_CYCLE_EDGE_ROWS} relationships`]
        : [];

    const { nodes, edges } = buildCycleNodes(rows, fileFilter);
    const adjacency = new Map<string, Set<string>>();
    const edgeTypesByPair = new Map<string, Set<string>>();
    const internalEdgeSet = new Set<string>();

    for (const edge of edges) {
      let next = adjacency.get(edge.sourceId);
      if (!next) {
        next = new Set<string>();
        adjacency.set(edge.sourceId, next);
      }
      next.add(edge.targetId);
      const pairKey = `${edge.sourceId}->${edge.targetId}`;
      internalEdgeSet.add(pairKey);
      let typeSet = edgeTypesByPair.get(pairKey);
      if (!typeSet) {
        typeSet = new Set<string>();
        edgeTypesByPair.set(pairKey, typeSet);
      }
      typeSet.add(edge.edgeType);
    }

    for (const nodeId of nodes.keys()) {
      if (!adjacency.has(nodeId)) adjacency.set(nodeId, new Set<string>());
    }

    const components = tarjanSccs(adjacency).map((component) => component.nodes);
    const cycles: DetectedCycle[] = [];

    for (const component of components) {
      const hasSelfLoop =
        component.length === 1 && internalEdgeSet.has(`${component[0]}->${component[0]}`);
      if (component.length < 2 && !hasSelfLoop) continue;
      if (component.length < minCycleLength) continue;

      const memberIds = new Set(component);
      const cycleEdgeTypes = new Set<string>();
      for (const edge of edges) {
        if (!memberIds.has(edge.sourceId) || !memberIds.has(edge.targetId)) continue;
        cycleEdgeTypes.add(edge.edgeType);
      }

      const members = sortMembers(
        component
          .map((nodeId) => nodes.get(nodeId))
          .filter((node): node is CycleNode => Boolean(node))
          .map((node) => ({
            id: node.id,
            name: node.name,
            filePath: node.filePath,
            kind: node.kind,
          })),
      );
      const affectedFiles = new Set(members.map((member) => member.filePath)).size;
      cycles.push({
        cycle_length: component.length,
        affected_files: affectedFiles,
        edge_types: [...cycleEdgeTypes].sort((a, b) => a.localeCompare(b)),
        members,
      });
    }

    cycles.sort((a, b) => {
      if (b.cycle_length !== a.cycle_length) return b.cycle_length - a.cycle_length;
      if (b.affected_files !== a.affected_files) return b.affected_files - a.affected_files;
      const aKey = a.members[0]?.filePath ?? '';
      const bKey = b.members[0]?.filePath ?? '';
      return aKey.localeCompare(bKey);
    });

    const allAffectedFiles = new Set<string>();
    for (const cycle of cycles) {
      for (const member of cycle.members) allAffectedFiles.add(member.filePath);
    }

    return {
      status: 'success',
      tool: 'cycle_detect',
      repo: repo.name,
      edge_types: edgeTypes,
      min_cycle_length: minCycleLength,
      limit,
      ...(fileFilter ? { file_filter: fileFilter } : {}),
      cycles: cycles.slice(0, limit),
      warnings,
      summary: {
        total_cycles: cycles.length,
        largest_cycle_size: cycles[0]?.cycle_length ?? 0,
        affected_files: allAffectedFiles.size,
      },
    };
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'cycle_detect',
      repo: repo.name,
      edge_types: edgeTypes,
      min_cycle_length: minCycleLength,
      limit,
      ...(fileFilter ? { file_filter: fileFilter } : {}),
      cycles: [],
      summary: emptySummary,
      error: `Cycle detection failed: ${formatCaughtMessage(err)}`,
    };
  }
}
