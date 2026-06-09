import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { generateId } from '../../lib/utils.js';

type GraphWalkAction = 'start' | 'step' | 'status';
type GraphWalkPolicy = 'follow-calls' | 'follow-imports' | 'expand-outward';

export interface GraphWalkParams {
  action: GraphWalkAction;
  walkId?: string;
  seedSymbol?: string;
  navigationPolicy?: GraphWalkPolicy;
  maxSteps?: number;
  maxFrontier?: number;
  maxExpansionPerStep?: number;
}

export interface GraphWalkState {
  id: string;
  repoId: string;
  seedSymbol: string;
  seedNodeId: string;
  navigationPolicy: GraphWalkPolicy;
  frontier: string[];
  visited: string[];
  discoveryPath: any[];
  stepsTaken: number;
  maxSteps: number;
  maxFrontier: number;
  maxExpansionPerStep: number;
  status: 'active' | 'completed' | 'error';
  createdAt: string;
  updatedAt: string;
}

type GraphWalkErrorCode =
  | 'INVALID_PARAMS'
  | 'SEED_SYMBOL_REQUIRED'
  | 'SEED_NOT_FOUND'
  | 'WALK_ID_REQUIRED'
  | 'WALK_NOT_FOUND';

interface GraphWalkLimits {
  maxSteps: number;
  maxFrontier: number;
  maxExpansionPerStep: number;
  maxActiveWalks: number;
  walkTtlMs: number;
}

const DEFAULT_MAX_STEPS = 10;
const HARD_MAX_STEPS = 50;
const DEFAULT_MAX_FRONTIER = 100;
const HARD_MAX_FRONTIER = 250;
const DEFAULT_MAX_EXPANSION_PER_STEP = 5;
const HARD_MAX_EXPANSION_PER_STEP = 25;
const MAX_ACTIVE_WALKS = 100;
const WALK_TTL_MS = 30 * 60 * 1000;
const VALID_ACTIONS = new Set<GraphWalkAction>(['start', 'step', 'status']);
const VALID_POLICIES = new Set<GraphWalkPolicy>([
  'follow-calls',
  'follow-imports',
  'expand-outward',
]);

const activeWalks = new Map<string, GraphWalkState>();

export async function gnGraphWalk(repoId: string, params: GraphWalkParams): Promise<any> {
  pruneActiveWalks();

  const validation = validateParams(params);
  if (validation.ok === false) return validation.error;

  const { action, walkId, seedSymbol } = params;
  const { navigationPolicy, maxSteps, maxFrontier, maxExpansionPerStep, warnings } =
    validation.options;

  if (action === 'start') {
    if (!seedSymbol) {
      return graphWalkError(action, 'SEED_SYMBOL_REQUIRED', 'start action requires a seedSymbol');
    }

    const seed = await resolveSeedSymbol(repoId, seedSymbol);
    if (!seed) {
      return graphWalkError(action, 'SEED_NOT_FOUND', `Seed symbol not found: ${seedSymbol}`);
    }

    const id = generateId('Walk', seedSymbol);
    const state: GraphWalkState = {
      id,
      repoId,
      seedSymbol,
      seedNodeId: seed.id,
      navigationPolicy,
      frontier: [seed.id],
      visited: [],
      discoveryPath: [],
      stepsTaken: 0,
      maxSteps,
      maxFrontier,
      maxExpansionPerStep,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    registerWalkState(id, state);
    return {
      version: 1,
      ok: true,
      message: `Started graph walk ${id} from ${seedSymbol}`,
      state,
      warnings,
      limits: graphWalkLimits(),
    };
  }

  if (action === 'status') {
    if (!walkId)
      return graphWalkError(action, 'WALK_ID_REQUIRED', 'status action requires a walkId');
    const state = activeWalks.get(walkId);
    if (!state) return graphWalkError(action, 'WALK_NOT_FOUND', `Walk ${walkId} not found`);
    state.updatedAt = new Date().toISOString();
    return { version: 1, ok: true, state, warnings, limits: graphWalkLimits() };
  }

  if (action === 'step') {
    if (!walkId) return graphWalkError(action, 'WALK_ID_REQUIRED', 'step action requires a walkId');
    const state = activeWalks.get(walkId);
    if (!state) return graphWalkError(action, 'WALK_NOT_FOUND', `Walk ${walkId} not found`);
    if (state.status !== 'active') {
      state.updatedAt = new Date().toISOString();
      return {
        version: 1,
        ok: true,
        message: 'Walk is no longer active',
        state,
        warnings,
        limits: graphWalkLimits(),
      };
    }

    if (state.stepsTaken >= state.maxSteps) {
      state.status = 'completed';
      state.updatedAt = new Date().toISOString();
      return {
        version: 1,
        ok: true,
        message: 'Max steps reached',
        state,
        warnings,
        limits: graphWalkLimits(),
      };
    }

    if (state.frontier.length === 0) {
      state.status = 'completed';
      state.updatedAt = new Date().toISOString();
      return {
        version: 1,
        ok: true,
        message: 'Frontier exhausted',
        state,
        warnings,
        limits: graphWalkLimits(),
      };
    }

    // Process one node from frontier
    const currentNode = state.frontier.shift()!;
    state.visited.push(currentNode);

    // Expand based on policy
    let cypher = '';
    if (state.navigationPolicy === 'follow-calls') {
      cypher = `MATCH (n {id: $id})-[:CodeRelation {type: 'CALLS'}]->(target) RETURN target.id as tid, target.name as tname, 'CALLS' as rel LIMIT ${state.maxExpansionPerStep}`;
    } else if (state.navigationPolicy === 'follow-imports') {
      cypher = `MATCH (n {id: $id})-[:CodeRelation {type: 'IMPORTS'}]->(target) RETURN target.id as tid, target.name as tname, 'IMPORTS' as rel LIMIT ${state.maxExpansionPerStep}`;
    } else {
      cypher = `MATCH (n {id: $id})-[r:CodeRelation]->(target) RETURN target.id as tid, target.name as tname, r.type as rel LIMIT ${state.maxExpansionPerStep}`;
    }

    const rows = await executeParameterized(repoId, cypher, { id: currentNode });

    const newDiscoveries: any[] = [];
    let truncatedDiscoveries = 0;
    for (const row of rows) {
      const tid = (row as any).tid ?? (row as any)[0];
      const tname = (row as any).tname ?? (row as any)[1];
      const rel = (row as any).rel ?? (row as any)[2];

      if (tid && !state.visited.includes(tid) && !state.frontier.includes(tid)) {
        if (state.frontier.length >= state.maxFrontier) {
          truncatedDiscoveries++;
          continue;
        }
        state.frontier.push(tid);
        newDiscoveries.push({ from: currentNode, to: tid, toName: tname, rel });
      }
    }

    state.discoveryPath.push({
      step: state.stepsTaken,
      node: currentNode,
      discovered: newDiscoveries,
    });
    state.stepsTaken++;
    state.updatedAt = new Date().toISOString();

    if (state.frontier.length === 0) {
      state.status = 'completed';
    }

    const stepWarnings = [...warnings];
    if (truncatedDiscoveries > 0) {
      stepWarnings.push(
        `Dropped ${truncatedDiscoveries} discoveries because maxFrontier=${state.maxFrontier} was reached.`,
      );
    }

    return {
      version: 1,
      ok: true,
      message: `Step ${state.stepsTaken} completed. Discovered ${newDiscoveries.length} new nodes.`,
      newDiscoveries,
      truncatedDiscoveries,
      state,
      warnings: stepWarnings,
      limits: graphWalkLimits(),
    };
  }

  return graphWalkError('status', 'INVALID_PARAMS', `Unknown action: ${String(action)}`);
}

async function resolveSeedSymbol(
  repoId: string,
  seedSymbol: string,
): Promise<{ id: string; name?: string } | undefined> {
  const rows = await executeParameterized(repoId, `MATCH (n {id: $sym}) RETURN n LIMIT 1`, {
    sym: seedSymbol,
  });
  const direct = firstNode(rows);
  if (direct) return direct;

  const nameRows = await executeParameterized(
    repoId,
    `MATCH (n) WHERE n.name = $sym RETURN n LIMIT 1`,
    { sym: seedSymbol },
  );
  return firstNode(nameRows);
}

function firstNode(rows: unknown[]): { id: string; name?: string } | undefined {
  for (const row of rows) {
    const record = row as any;
    const node = record.n ?? record[0] ?? record;
    const id = node?.id ?? record.id;
    if (typeof id === 'string' && id.length > 0) {
      return { id, name: typeof node?.name === 'string' ? node.name : undefined };
    }
  }
  return undefined;
}

function validateParams(params: GraphWalkParams):
  | {
      ok: true;
      options: {
        navigationPolicy: GraphWalkPolicy;
        maxSteps: number;
        maxFrontier: number;
        maxExpansionPerStep: number;
        warnings: string[];
      };
    }
  | { ok: false; error: Record<string, unknown> } {
  const action = (params as any)?.action;
  if (!VALID_ACTIONS.has(action)) {
    return {
      ok: false,
      error: graphWalkError('status', 'INVALID_PARAMS', `Invalid action: ${String(action)}`),
    };
  }

  const policy = params.navigationPolicy ?? 'follow-calls';
  if (!VALID_POLICIES.has(policy)) {
    return {
      ok: false,
      error: graphWalkError(
        action,
        'INVALID_PARAMS',
        `Invalid navigationPolicy: ${String(policy)}`,
      ),
    };
  }

  const warnings: string[] = [];
  const maxSteps = boundedPositiveInteger(
    params.maxSteps,
    DEFAULT_MAX_STEPS,
    HARD_MAX_STEPS,
    'maxSteps',
    warnings,
  );
  const maxFrontier = boundedPositiveInteger(
    params.maxFrontier,
    DEFAULT_MAX_FRONTIER,
    HARD_MAX_FRONTIER,
    'maxFrontier',
    warnings,
  );
  const maxExpansionPerStep = boundedPositiveInteger(
    params.maxExpansionPerStep,
    DEFAULT_MAX_EXPANSION_PER_STEP,
    HARD_MAX_EXPANSION_PER_STEP,
    'maxExpansionPerStep',
    warnings,
  );

  if (maxSteps === undefined || maxFrontier === undefined || maxExpansionPerStep === undefined) {
    return {
      ok: false,
      error: graphWalkError(
        action,
        'INVALID_PARAMS',
        'Graph walk numeric limits must be positive integers.',
      ),
    };
  }

  return {
    ok: true,
    options: {
      navigationPolicy: policy,
      maxSteps,
      maxFrontier,
      maxExpansionPerStep,
      warnings,
    },
  };
}

function boundedPositiveInteger(
  value: number | undefined,
  defaultValue: number,
  hardMax: number,
  name: string,
  warnings: string[],
): number | undefined {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1) return undefined;
  if (value > hardMax) {
    warnings.push(`${name} capped at ${hardMax}.`);
    return hardMax;
  }
  return value;
}

function graphWalkError(
  action: GraphWalkAction,
  code: GraphWalkErrorCode,
  message: string,
): Record<string, unknown> {
  return {
    version: 1,
    action,
    ok: false,
    status: 'error',
    code,
    message,
    warnings: [],
    limits: graphWalkLimits(),
  };
}

function graphWalkLimits(): GraphWalkLimits {
  return {
    maxSteps: HARD_MAX_STEPS,
    maxFrontier: HARD_MAX_FRONTIER,
    maxExpansionPerStep: HARD_MAX_EXPANSION_PER_STEP,
    maxActiveWalks: MAX_ACTIVE_WALKS,
    walkTtlMs: WALK_TTL_MS,
  };
}

function registerWalkState(id: string, state: GraphWalkState): void {
  activeWalks.set(id, state);
  pruneActiveWalks();
}

function pruneActiveWalks(nowMs = Date.now()): void {
  for (const [id, state] of activeWalks) {
    if (nowMs - Date.parse(state.updatedAt) > WALK_TTL_MS) {
      activeWalks.delete(id);
    }
  }

  if (activeWalks.size <= MAX_ACTIVE_WALKS) return;

  const candidates = [...activeWalks.entries()].sort(([, a], [, b]) => {
    if (a.status !== b.status) {
      if (a.status === 'completed') return -1;
      if (b.status === 'completed') return 1;
    }
    return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  });

  for (const [id] of candidates.slice(0, activeWalks.size - MAX_ACTIVE_WALKS)) {
    activeWalks.delete(id);
  }
}
