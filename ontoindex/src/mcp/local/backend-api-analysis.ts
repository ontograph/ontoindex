import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { RepoHandle } from 'ontoindex-shared';
import { getActiveModelPacks } from '../../analysis-packs/execution.js';
import { fetchLinkedFlowsBatch, fetchRoutesWithConsumers } from './backend-overview.js';

interface EntryPointModelPackSummary {
  id: string;
  tier?: string;
  provides?: string[];
}

interface ToolRow {
  id: string | null;
  name: string | null;
  filePath: string | null;
}

interface ApiImpactConsumerResult {
  name: string;
  file: string;
  accesses: string[];
  attributionNote?: string;
}

interface ApiImpactMismatch {
  consumer: string;
  field: string;
  reason: string;
  confidence: 'high' | 'low';
}

interface ApiImpactRouteResult {
  route: string;
  handler: string;
  responseShape: {
    success: string[];
    error: string[];
  };
  middleware: string[];
  middlewareDetection?: 'partial';
  middlewareNote?: string;
  consumers: ApiImpactConsumerResult[];
  mismatches?: ApiImpactMismatch[];
  executionFlows: string[];
  impactSummary: {
    directConsumers: number;
    affectedFlows: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    warning?: string;
  };
  activeModelPacks?: EntryPointModelPackSummary[];
}

type ApiImpactResult =
  | { error: string }
  | ApiImpactRouteResult
  | {
      routes: ApiImpactRouteResult[];
      total: number;
      activeModelPacks?: EntryPointModelPackSummary[];
    };

interface ToolMapResult {
  repo: string;
  tools: Array<{
    id: string;
    name: string;
    filePath: string;
  }>;
  modelPacks: EntryPointModelPackSummary[];
}

type QueryRow = Record<string, unknown>;

function rowValue<T>(row: QueryRow, key: string, index: number): T | undefined {
  return row[key] as T | undefined;
}

async function getEntryPointModelPackSummary(
  repo: RepoHandle,
  provides: string[],
): Promise<EntryPointModelPackSummary[]> {
  const packs = await getActiveModelPacks(repo.repoPath, provides);
  return packs
    .filter((p) => provides.some((prov) => p.provides?.includes(prov)))
    .map((p) => ({
      id: p.id,
      ...(p.tier ? { tier: p.tier } : {}),
      ...(p.provides ? { provides: p.provides } : {}),
    }));
}

/**
 * tool_map — list all tools provided by the codebase.
 */
export async function toolMap(repo: RepoHandle, params: { tool?: string }): Promise<ToolMapResult> {
  const query = params.tool
    ? 'MATCH (t:Tool {name: $tool}) RETURN t.id as id, t.name as name, t.filePath as filePath'
    : 'MATCH (t:Tool) RETURN t.id as id, t.name as name, t.filePath as filePath';

  const rows = (await executeParameterized(repo.id, query, {
    tool: params.tool || '',
  })) as ToolRow[];

  const tools = rows
    .filter((r) => r.id && r.name && r.filePath)
    .map((r) => ({
      id: r.id!,
      name: r.name!,
      filePath: r.filePath!,
    }));

  return {
    repo: repo.name,
    tools,
    modelPacks: await getEntryPointModelPackSummary(repo, ['tool-models']),
  };
}

/**
 * api_impact — trace impact of API changes.
 */
export async function apiImpact(
  repo: RepoHandle,
  params: { route?: string; file?: string },
): Promise<ApiImpactResult> {
  if (!params.route && !params.file) {
    return { error: 'Either "route" or "file" parameter is required.' };
  }

  let routeFilter = '';
  const queryParams: Record<string, string> = {};
  if (params.route) {
    routeFilter = `AND n.name CONTAINS $route`;
    queryParams.route = params.route;
  } else if (params.file) {
    routeFilter = `AND n.filePath CONTAINS $file`;
    queryParams.file = params.file;
  }

  const routes = await fetchRoutesWithConsumers(repo.id, routeFilter, queryParams);
  if (routes.length === 0) {
    return { error: `No routes found matching "${params.route || params.file}".` };
  }

  const flowMap = await fetchLinkedFlowsBatch(
    repo.id,
    routes.map((r) => r.id),
  );
  const activeModelPacks = await getEntryPointModelPackSummary(repo, [
    'route-models',
    'component-models',
    'orm-models',
  ]);
  const routeCountByHandler = new Map<string, number>();
  for (const route of routes) {
    routeCountByHandler.set(route.filePath, (routeCountByHandler.get(route.filePath) ?? 0) + 1);
  }

  const results = routes.map((r) => {
    const responseKeys = r.responseKeys ?? [];
    const errorKeys = r.errorKeys ?? [];
    const allKnownKeys = new Set([...responseKeys, ...errorKeys]);
    const consumers = r.consumers.map((c) => ({
      name: c.name,
      file: c.filePath,
      accesses: c.accessedKeys ?? [],
      ...(c.fetchCount && c.fetchCount > 1
        ? {
            attributionNote: `This file fetches ${c.fetchCount} routes — accessed keys may belong to a different route.`,
          }
        : {}),
    }));
    const mismatches: ApiImpactMismatch[] = [];
    if (allKnownKeys.size > 0) {
      for (const consumer of r.consumers) {
        if (!consumer.accessedKeys) continue;
        const isMultiFetch = (consumer.fetchCount ?? 1) > 1;
        for (const key of consumer.accessedKeys) {
          if (!allKnownKeys.has(key)) {
            mismatches.push({
              consumer: consumer.filePath,
              field: key,
              reason: 'accessed but not in response shape',
              confidence: isMultiFetch ? 'low' : 'high',
            });
          }
        }
      }
    }
    const flows = flowMap.get(r.id) || [];
    const consumerCount = r.consumers.length;
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' =
      consumerCount >= 10 ? 'HIGH' : consumerCount >= 4 ? 'MEDIUM' : 'LOW';
    if (mismatches.length > 0) {
      riskLevel = riskLevel === 'LOW' ? 'MEDIUM' : 'HIGH';
    }
    const middleware = r.middleware || [];
    const middlewarePartial =
      middleware.length > 0 && (routeCountByHandler.get(r.filePath) ?? 1) > 1;

    return {
      route: r.name,
      handler: r.filePath,
      responseShape: {
        success: responseKeys,
        error: errorKeys,
      },
      middleware,
      ...(middlewarePartial
        ? {
            middlewareDetection: 'partial' as const,
            middlewareNote:
              'Middleware captured from first HTTP method export only — other methods in this handler may use different middleware chains.',
          }
        : {}),
      consumers,
      ...(mismatches.length > 0 ? { mismatches } : {}),
      executionFlows: flows,
      impactSummary: {
        directConsumers: consumerCount,
        affectedFlows: flows.length,
        riskLevel,
        ...(consumerCount > 0
          ? {
              warning: `Changing response shape will affect ${consumerCount} component${consumerCount === 1 ? '' : 's'}`,
            }
          : {}),
      },
      ...(activeModelPacks.length > 0 ? { activeModelPacks } : {}),
    };
  });

  if (results.length === 1) return results[0];
  return {
    routes: results,
    total: results.length,
    ...(activeModelPacks.length > 0 ? { activeModelPacks } : {}),
  };
}
