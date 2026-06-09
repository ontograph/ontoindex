import {
  adaptAnnNeighborEdgesForFrontier,
  loadAnnNeighborEdges,
  type AnnNeighborLoadOptions,
} from '../embeddings/ann-neighbor-store.js';
import {
  semanticFrontierSearch,
  type SemanticFrontierSeed,
  type SemanticFrontierSearchDiagnostics,
  type SemanticFrontierSearchParams,
  type SemanticFrontierEdge,
} from './semantic-frontier-search.js';

type QueryParamValue = string | number | boolean | null;
type QueryParams = Readonly<
  Record<string, QueryParamValue | ReadonlyArray<QueryParamValue>>
>;
type ExecuteQuery = (...args: unknown[]) => Promise<unknown[]>;

type FrontEndOptions = Omit<
  SemanticFrontierSearchParams,
  'repo' | 'repoPath' | 'queryVector' | 'seeds' | 'edges' | 'neighborProvider' | 'edgeMap'
> &
  Omit<AnnNeighborLoadOptions, 'sourceIds'>;

export interface SemanticFrontierAdapterOptions extends FrontEndOptions {
  readonly enabled?: boolean;
  readonly frontierSearch?: (
    params: Omit<
      SemanticFrontierSearchParams,
      'repo' | 'repoPath' | 'queryVector' | 'seeds' | 'edges' | 'neighborProvider' | 'edgeMap'
    > & {
      readonly repo: string;
      readonly repoPath?: string;
      readonly queryVector: SemanticFrontierSearchParams['queryVector'];
      readonly seeds: readonly SemanticFrontierSeed[];
       readonly edges: readonly SemanticFrontierEdge[];
    },
  ) => Promise<SemanticFrontierSearchDiagnostics>;
}

const FRONTIER_MAX_VISITED_DEFAULT = 512;

const uniqueSortedLanes = (items: readonly string[]): string[] => {
  const out = Array.from(new Set(items.filter((item) => item.length > 0)));
  out.sort();
  return out;
};

const makeDisabledDiagnostics = (
  repo: string,
  repoPath: string | undefined,
  seeds: readonly SemanticFrontierSeed[],
  options: Pick<FrontEndOptions, 'maxVisited'>,
): SemanticFrontierSearchDiagnostics => ({
  repo,
  repoPath,
  mode: 'ann',
  embeddingReady: false,
  indexFreshness: 'not-applicable',
  visited: 0,
  maxVisited:
    Number.isFinite(options.maxVisited) && options.maxVisited > 0
      ? Math.floor(options.maxVisited)
      : FRONTIER_MAX_VISITED_DEFAULT,
  truncated: false,
  seedLanes: uniqueSortedLanes(
    seeds.flatMap((seed) => (seed.lanes ? [...seed.lanes] : [])),
  ),
  warnings: ['symbol-neighborhood frontier search disabled'],
  fallbackReason: 'symbol-neighborhood-frontier-disabled',
  results: [],
});

export async function runAnnNeighborFrontierSearch(
  executeQuery: ExecuteQuery,
  repo: string,
  repoPath: string | undefined,
  queryVector: SemanticFrontierSearchParams['queryVector'],
  seeds: readonly SemanticFrontierSeed[],
  options: SemanticFrontierAdapterOptions = {},
): Promise<SemanticFrontierSearchDiagnostics> {
  const {
    enabled = false,
    frontierSearch = semanticFrontierSearch,
    relationType,
    includeStale,
    maxOutboundDegree,
    currentContentHashByNodeId,
    currentBuildIdByNodeId,
    ...frontierOptions
  } = options;

  if (!enabled) {
    return makeDisabledDiagnostics(repo, repoPath, seeds, frontierOptions);
  }

  const seedIds = Array.from(
    new Set(seeds.map((seed) => seed.nodeId).filter((seedId): seedId is string => seedId.trim().length > 0)),
  );

  const loadedEdges = await loadAnnNeighborEdges(
    executeQuery as Parameters<typeof loadAnnNeighborEdges>[0],
    {
      sourceIds: seedIds,
      relationType,
      includeStale: includeStale === true,
      maxOutboundDegree,
      currentContentHashByNodeId,
      currentBuildIdByNodeId,
    },
  );
  const adaptedEdges = adaptAnnNeighborEdgesForFrontier(loadedEdges);

  return frontierSearch({
    repo,
    repoPath,
    queryVector,
    seeds,
    edges: adaptedEdges,
    ...frontierOptions,
  });
}
