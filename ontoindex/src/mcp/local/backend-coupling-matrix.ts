import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { AnalysisResult, DiagnosticFinding } from 'ontoindex-shared';

type RepoHandle = { readonly id: string; readonly name: string };

/**
 * Maps internal CouplingMatrixRow to normalized DiagnosticFinding (Phase D).
 */
function mapCouplingToFindings(entries: CouplingMatrixRow[]): DiagnosticFinding[] {
  return entries.map((e) => {
    return {
      ruleId: 'GNC-201',
      ruleName: 'High Inter-Community Coupling',
      severity: e.instability > 0.8 ? 'critical' : e.instability > 0.5 ? 'warning' : 'advisory',
      confidence: 0.9,
      message: `Community '${e.community}' has high instability (${(e.instability * 100).toFixed(1)}%).`,
      location: {
        filePath: 'Knowledge Graph',
      },
      properties: {
        community: e.community,
        ca: e.ca,
        ce: e.ce,
        instability: e.instability,
      },
      suggestion:
        'Consolidate these communities if they share a common purpose, or refactor to reduce cross-community dependencies.',
    };
  });
}

interface CouplingRow {
  sourceCommunityId: string | null;
  sourceCommunity: string | null;
  sourceSymbolId: string | null;
  targetCommunityId: string | null;
  targetCommunity: string | null;
  targetSymbolId: string | null;
  edgeType: string;
}

interface CommunityRow {
  id: string;
  heuristicLabel: string | null;
  symbolCount: number | null;
}

interface CouplingMatrixRow {
  community_id: string;
  community: string;
  symbol_count: number;
  ca: number;
  ce: number;
  instability: number;
  flagged: boolean;
  cross_edges?: Array<{
    target_community: string;
    edge_type: string;
    source_symbol_id: string;
    target_symbol_id: string;
  }>;
}

interface CouplingMatrixResult {
  status: 'success' | 'error';
  tool: 'coupling_matrix';
  repo: string;
  min_symbols: number;
  flag_threshold: number;
  include_cross_edges: boolean;
  rows: CouplingMatrixRow[];
  summary: {
    module_count: number;
    flagged_modules: number;
    isolated_modules: number;
    most_stable?: string;
    most_unstable?: string;
  };
  error?: string;
  warnings?: string[];
}

const MAX_COUPLING_EDGE_ROWS = (() => {
  const raw = Number.parseInt(process.env.ONTOINDEX_COUPLING_MATRIX_MAX_EDGES ?? '', 10);
  return Number.isFinite(raw) ? Math.max(1000, Math.min(raw, 500_000)) : 50_000;
})();

function labelForCommunity(id: string, heuristicLabel: string | null | undefined): string {
  return heuristicLabel?.trim() || id;
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function caughtErrorMessageOperand(err: unknown): unknown {
  return (err as { message?: unknown } | null | undefined)?.message ?? String(err);
}

export async function runCouplingMatrix(
  repo: RepoHandle,
  params: {
    min_symbols?: number;
    flag_threshold?: number;
    include_cross_edges?: boolean;
  },
): Promise<AnalysisResult> {
  const start = Date.now();
  const minSymbols =
    typeof params?.min_symbols === 'number' && Number.isFinite(params.min_symbols)
      ? Math.max(0, Math.trunc(params.min_symbols))
      : 5;
  const flagThreshold =
    typeof params?.flag_threshold === 'number' && Number.isFinite(params.flag_threshold)
      ? Math.max(0, Math.min(1, params.flag_threshold))
      : 0.8;
  const includeCrossEdges = params?.include_cross_edges === true;

  try {
    const [communities, edges] = await Promise.all([
      executeParameterized(
        repo.id,
        `
        MATCH (c:Community)
        RETURN c.id AS id, c.heuristicLabel AS heuristicLabel, c.symbolCount AS symbolCount
        `,
        {},
      ) as Promise<CommunityRow[]>,
      executeParameterized(
        repo.id,
        `
        MATCH (src)-[r:CodeRelation]->(dst)
        WHERE r.type IN ['CALLS', 'IMPORTS']
        OPTIONAL MATCH (src)-[:CodeRelation {type: 'MEMBER_OF'}]->(srcComm:Community)
        OPTIONAL MATCH (dst)-[:CodeRelation {type: 'MEMBER_OF'}]->(dstComm:Community)
        RETURN
          srcComm.id AS sourceCommunityId,
          srcComm.heuristicLabel AS sourceCommunity,
          src.id AS sourceSymbolId,
          dstComm.id AS targetCommunityId,
          dstComm.heuristicLabel AS targetCommunity,
          dst.id AS targetSymbolId,
          r.type AS edgeType
        LIMIT ${MAX_COUPLING_EDGE_ROWS}
        `,
        {},
      ) as Promise<CouplingRow[]>,
    ]);

    const modules = new Map<
      string,
      {
        id: string;
        community: string;
        symbolCount: number;
        incomingPeers: Set<string>;
        outgoingPeers: Set<string>;
        crossEdges: CouplingMatrixRow['cross_edges'];
      }
    >();

    for (const row of communities) {
      const id = row.id;
      modules.set(id, {
        id,
        community: labelForCommunity(id, row.heuristicLabel),
        symbolCount: toNumber(row.symbolCount, 0),
        incomingPeers: new Set<string>(),
        outgoingPeers: new Set<string>(),
        crossEdges: [],
      });
    }

    for (const edge of edges) {
      if (!edge.sourceCommunityId || !edge.targetCommunityId) continue;
      if (edge.sourceCommunityId === edge.targetCommunityId) continue;

      const source = modules.get(edge.sourceCommunityId);
      const target = modules.get(edge.targetCommunityId);
      if (!source || !target) continue;

      source.outgoingPeers.add(target.id);
      target.incomingPeers.add(source.id);

      if (includeCrossEdges && source.crossEdges && source.crossEdges.length < 5) {
        source.crossEdges.push({
          target_community: target.community,
          edge_type: edge.edgeType,
          source_symbol_id: edge.sourceSymbolId || '',
          target_symbol_id: edge.targetSymbolId || '',
        });
      }
    }

    const rows = [...modules.values()]
      .filter((module) => module.symbolCount >= minSymbols)
      .map<CouplingMatrixRow>((module) => {
        const ca = module.incomingPeers.size;
        const ce = module.outgoingPeers.size;
        const instability = ca + ce === 0 ? 0 : ce / (ca + ce);
        return {
          community_id: module.id,
          community: module.community,
          symbol_count: module.symbolCount,
          ca,
          ce,
          instability: Number(instability.toFixed(3)),
          flagged: instability >= flagThreshold && ca > 0,
          ...(includeCrossEdges ? { cross_edges: module.crossEdges } : {}),
        };
      })
      .sort((a, b) => {
        if (b.instability !== a.instability) return b.instability - a.instability;
        if (b.ca !== a.ca) return b.ca - a.ca;
        return a.community.localeCompare(b.community);
      });

    const flagged = rows.filter((row) => row.flagged);
    const stableSorted = [...rows].sort((a, b) => {
      if (a.instability !== b.instability) return a.instability - b.instability;
      return a.community.localeCompare(b.community);
    });

    const legacySummary = {
      module_count: rows.length,
      flagged_modules: flagged.length,
      isolated_modules: rows.filter((row) => row.ca === 0 && row.ce === 0).length,
      most_stable: stableSorted[0]?.community,
      most_unstable: rows[0]?.community,
    };
    const summary = `Analyzed coupling between ${communities.length} communities. Found ${flagged.length} communities exceeding instability threshold ${flagThreshold}. Most stable: ${stableSorted[0]?.community || 'N/A'}.`;

    return {
      status: 'success',
      tool: 'coupling_matrix',
      repo: repo.name,
      min_symbols: minSymbols,
      flag_threshold: flagThreshold,
      include_cross_edges: includeCrossEdges,
      rows,
      summary: legacySummary,
      findings: mapCouplingToFindings(flagged),
      stats: {
        totalFindings: flagged.length,
        durationMs: Date.now() - start,
        totalCommunities: communities.length,
        minSymbols,
        flagThreshold,
      },
      warnings:
        edges.length >= MAX_COUPLING_EDGE_ROWS
          ? [`Coupling edge scan capped at ${MAX_COUPLING_EDGE_ROWS} relationships`]
          : [],
    } as unknown as AnalysisResult & CouplingMatrixResult;
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'coupling_matrix',
      repo: repo.name,
      min_symbols: minSymbols,
      flag_threshold: flagThreshold,
      include_cross_edges: includeCrossEdges,
      rows: [],
      summary: {
        module_count: 0,
        flagged_modules: 0,
        isolated_modules: 0,
      },
      error: `Coupling matrix failed: ${caughtErrorMessageOperand(err)}`,
      findings: [],
      stats: { totalFindings: 0, durationMs: Date.now() - start },
      errors: [`Coupling matrix failed: ${caughtErrorMessageOperand(err)}`],
    } as unknown as AnalysisResult & CouplingMatrixResult;
  }
}
