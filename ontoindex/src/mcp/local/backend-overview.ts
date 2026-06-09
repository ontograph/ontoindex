import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { RepoHandle } from 'ontoindex-shared';
import { getActiveModelPacks } from '../../analysis-packs/execution.js';
import { normalizeLimit } from './tool-utils.js';
import {
  queryClusters as queryClustersImpl,
  queryProcesses as queryProcessesImpl,
} from './backend-resources.js';

interface EntryPointModelPackSummary {
  id: string;
  name: string;
}

interface EntryPointConsumer {
  name: string;
  filePath: string;
  accessedKeys?: string[];
  fetchCount?: number;
}

interface EntryPointRoute {
  id: string;
  name: string;
  filePath: string;
  responseKeys: string[] | null;
  errorKeys: string[] | null;
  middleware: string[] | null;
  consumers: EntryPointConsumer[];
}

interface RouteMapResult {
  repo: string;
  routes: Array<{
    route: string;
    handler: string;
    middleware: string[];
    consumers: EntryPointConsumer[];
    flows: string[];
  }>;
  total: number;
  message?: string;
  modelPacks: EntryPointModelPackSummary[];
}

export type OverviewResult = {
  repo: string;
  repoPath: string;
  stats: Record<string, number> | undefined;
  indexedAt?: string;
  lastCommit?: string;
  clusters?: any[];
  processes?: any[];
};

interface ShapeCheckConsumerResult {
  name: string;
  filePath: string;
  accessedKeys?: string[];
  mismatched?: string[];
  mismatchConfidence?: 'high' | 'low';
  errorPathKeys?: string[];
  attributionNote?: string;
}

interface ShapeCheckRouteResult {
  route: string;
  handler: string;
  responseKeys?: string[];
  errorKeys?: string[];
  consumers: ShapeCheckConsumerResult[];
  status?: 'MISMATCH';
}

interface ShapeCheckResult {
  repo: string;
  routes: ShapeCheckRouteResult[];
  total: number;
  routesWithShapes: number;
  mismatches?: number;
  message: string;
  modelPacks: EntryPointModelPackSummary[];
}

type QueryRow = Record<string, unknown> | readonly unknown[];

function rowValue<T>(row: QueryRow, key: string, index: number): T | undefined {
  if (row && typeof row === 'object' && key in row) {
    const value = (row as Record<string, unknown>)[key];
    if (value !== null && value !== undefined) return value as T;
  }
  if (Array.isArray(row)) {
    const value = row[index];
    return value === null || value === undefined ? undefined : (value as T);
  }
  if (row && typeof row === 'object' && String(index) in row) {
    const value = (row as Record<string, unknown>)[String(index)];
    if (value !== null && value !== undefined) return value as T;
  }
  return undefined;
}

async function getEntryPointModelPackSummary(
  repo: RepoHandle,
  provides: string[],
): Promise<EntryPointModelPackSummary[]> {
  const packs = await getActiveModelPacks(repo.repoPath, provides);
  return packs
    .filter((p) => provides.some((prov) => p.provides?.includes(prov)))
    .map((p) => ({ id: p.id, name: p.name }));
}

export async function fetchRoutesWithConsumers(
  repoId: string,
  routeFilter: string,
  params: Record<string, string>,
): Promise<EntryPointRoute[]> {
  const rows = await executeParameterized(
    repoId,
    `
    MATCH (n:Route)
    WHERE n.id STARTS WITH 'Route:' ${routeFilter}
    OPTIONAL MATCH (consumer)-[r:CodeRelation]->(n)
    WHERE r.type = 'FETCHES'
    RETURN n.id AS routeId, n.name AS routeName, n.filePath AS handlerFile,
           n.responseKeys AS responseKeys, n.errorKeys AS errorKeys, n.middleware AS middleware,
           consumer.name AS consumerName, consumer.filePath AS consumerFile,
           r.reason AS fetchReason
  `,
    params,
  );

  const stripQuotes = (keys: string[] | null): string[] | null =>
    keys ? keys.map((k) => k.replace(/^['"]|['"]$/g, '')) : null;

  const routeMap = new Map<string, EntryPointRoute>();
  for (const row of rows as QueryRow[]) {
    const id = rowValue<string>(row, 'routeId', 0);
    if (!id) continue;
    const name = rowValue<string>(row, 'routeName', 1) ?? '';
    const filePath = rowValue<string>(row, 'handlerFile', 2) ?? '';
    const responseKeys = stripQuotes(rowValue<string[]>(row, 'responseKeys', 3) ?? null);
    const errorKeys = stripQuotes(rowValue<string[]>(row, 'errorKeys', 4) ?? null);
    const middleware = stripQuotes(rowValue<string[]>(row, 'middleware', 5) ?? null);
    const consumerName = rowValue<string>(row, 'consumerName', 6);
    const consumerFile = rowValue<string>(row, 'consumerFile', 7);
    const fetchReason = rowValue<string>(row, 'fetchReason', 8);

    if (!routeMap.has(id)) {
      routeMap.set(id, {
        id,
        name,
        filePath,
        responseKeys,
        errorKeys,
        middleware,
        consumers: [],
      });
    }

    if (consumerName && consumerFile) {
      const keysMatch = fetchReason?.match(/\|keys:([^|]+)/);
      const fetchesMatch = fetchReason?.match(/\|fetches:(\d+)/);
      const accessedKeys = keysMatch?.[1].split(',').filter((k) => k.length > 0);
      const fetchCount = fetchesMatch ? Number.parseInt(fetchesMatch[1], 10) : undefined;
      routeMap.get(id)!.consumers.push({
        name: consumerName,
        filePath: consumerFile,
        ...(accessedKeys && accessedKeys.length > 0 ? { accessedKeys } : {}),
        ...(fetchCount && fetchCount > 1 ? { fetchCount } : {}),
      });
    }
  }

  return [...routeMap.values()];
}

export async function fetchLinkedFlowsBatch(
  repoId: string,
  nodeIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (nodeIds.length === 0) return result;
  try {
    const rows = await executeParameterized(
      repoId,
      `
      MATCH (source)-[r:CodeRelation]->(proc:Process)
      WHERE r.type = 'ENTRY_POINT_OF'
        AND list_contains($nodeIds, source.id)
      RETURN source.id AS sourceId, proc.label AS name
    `,
      { nodeIds },
    );
    for (const row of rows as QueryRow[]) {
      const sourceId = rowValue<string>(row, 'sourceId', 0);
      const name = rowValue<string>(row, 'name', 1);
      if (!sourceId || !name) continue;
      const list = result.get(sourceId) ?? [];
      list.push(name);
      result.set(sourceId, list);
    }
  } catch {
    /* no ENTRY_POINT_OF edges yet */
  }
  return result;
}

/**
 * overview — high-level summary of the repository.
 */
export async function runOverview(
  repo: RepoHandle,
  params: { showClusters?: boolean; showProcesses?: boolean; limit?: number },
): Promise<OverviewResult> {
  const limit = normalizeLimit(params.limit, 20);
  const result: OverviewResult = {
    repo: repo.name,
    repoPath: repo.repoPath,
    stats: repo.stats,
    indexedAt: repo.indexedAt,
    lastCommit: repo.lastCommit,
  };

  if (params.showClusters !== false) {
    const clusterResult = await queryClustersImpl(repo, limit);
    result.clusters = clusterResult.clusters;
  }

  if (params.showProcesses !== false) {
    const processResult = await queryProcessesImpl(repo, limit);
    result.processes = processResult.processes;
  }

  return result;
}

/**
 * route_map — list all routes and their consumers.
 */
export async function routeMap(
  repo: RepoHandle,
  params: { route?: string },
): Promise<RouteMapResult> {
  const routeFilter = params.route ? `AND n.name CONTAINS $route` : '';
  const routes = await fetchRoutesWithConsumers(
    repo.id,
    routeFilter,
    params.route ? { route: params.route } : {},
  );

  if (routes.length === 0) {
    return {
      repo: repo.name,
      routes: [],
      total: 0,
      message: params.route
        ? `No routes matching "${params.route}"`
        : 'No routes found in this project.',
      modelPacks: await getEntryPointModelPackSummary(repo, ['route-models']),
    };
  }

  const flowMap = await fetchLinkedFlowsBatch(
    repo.id,
    routes.map((r) => r.id),
  );

  return {
    repo: repo.name,
    routes: routes.map((r) => ({
      route: r.name,
      handler: r.filePath,
      middleware: r.middleware || [],
      consumers: r.consumers,
      flows: flowMap.get(r.id) || [],
    })),
    total: routes.length,
    modelPacks: await getEntryPointModelPackSummary(repo, ['route-models']),
  };
}

/**
 * shape_check — check API shape consistency across consumers.
 */
export async function shapeCheck(
  repo: RepoHandle,
  params: { route?: string },
): Promise<ShapeCheckResult> {
  const routeFilter = params.route ? `AND n.name CONTAINS $route` : '';
  const allRoutes = await fetchRoutesWithConsumers(
    repo.id,
    routeFilter,
    params.route ? { route: params.route } : {},
  );

  const routes = allRoutes
    .filter(
      (r) =>
        ((r.responseKeys && r.responseKeys.length > 0) ||
          (r.errorKeys && r.errorKeys.length > 0)) &&
        r.consumers.length > 0,
    )
    .map((r) => {
      const responseKeys = r.responseKeys ?? [];
      const errorKeys = r.errorKeys ?? [];
      const allKnownKeys = new Set([...responseKeys, ...errorKeys]);
      const responseKeySet = new Set(responseKeys);
      const consumers: ShapeCheckConsumerResult[] = r.consumers.map((c) => {
        if (!c.accessedKeys || c.accessedKeys.length === 0) {
          return { name: c.name, filePath: c.filePath };
        }
        const mismatched = c.accessedKeys.filter((k) => !allKnownKeys.has(k));
        const errorPathKeys = c.accessedKeys.filter(
          (k) => allKnownKeys.has(k) && !responseKeySet.has(k),
        );
        const isMultiFetch = (c.fetchCount ?? 1) > 1;
        return {
          name: c.name,
          filePath: c.filePath,
          accessedKeys: c.accessedKeys,
          ...(mismatched.length > 0
            ? {
                mismatched,
                mismatchConfidence: isMultiFetch ? ('low' as const) : ('high' as const),
              }
            : {}),
          ...(errorPathKeys.length > 0 ? { errorPathKeys } : {}),
          ...(isMultiFetch
            ? {
                attributionNote: `This file fetches ${c.fetchCount} routes — accessed keys may belong to a different route.`,
              }
            : {}),
        };
      });
      const hasMismatches = consumers.some((c) => c.mismatched && c.mismatched.length > 0);
      return {
        route: r.name,
        handler: r.filePath,
        ...(responseKeys.length > 0 ? { responseKeys } : {}),
        ...(errorKeys.length > 0 ? { errorKeys } : {}),
        consumers,
        ...(hasMismatches ? { status: 'MISMATCH' as const } : {}),
      };
    });
  const mismatchCount = routes.filter((r) => r.status === 'MISMATCH').length;

  return {
    repo: repo.name,
    routes,
    total: routes.length,
    routesWithShapes: routes.length,
    ...(mismatchCount > 0 ? { mismatches: mismatchCount } : {}),
    message:
      routes.length === 0
        ? 'No routes with both response shapes and consumers found.'
        : mismatchCount > 0
          ? `Found ${routes.length} route(s) with response shape data. ${mismatchCount} route(s) have consumer/shape mismatches.`
          : `Found ${routes.length} route(s) with response shape data and consumers.`,
    modelPacks: await getEntryPointModelPackSummary(repo, ['route-models']),
  };
}
