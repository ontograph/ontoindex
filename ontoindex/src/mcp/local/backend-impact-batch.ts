/**
 * Batch Impact Analysis MCP Tool
 *
 * Runs impact() for N symbols in one call, returning both per-symbol
 * results and union statistics. Useful for PRs touching many symbols
 * or multi-symbol refactors where the overlap between blast radii
 * matters as much as the individual counts.
 *
 * Output:
 *   - perSymbol[]: raw runImpact result for each target (same shape as
 *     the impact tool)
 *   - union: { totalAffectedNodes, totalRelationships, maxDepth, risk,
 *     sharedNodes } — combined stats. sharedNodes is the count of
 *     impacted ids reached by >1 target, which highlights symbols that
 *     sit at the confluence of multiple change fronts.
 */
import { runImpact } from './backend-impact.js';
// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly id: string; readonly name: string; readonly repoPath?: string };
type RunImpactResult = Awaited<ReturnType<typeof runImpact>>;
type FlattenedImpactedNode = Record<string, unknown> & { id: string; depth: number };

const MAX_IMPACT_BATCH_TARGETS = 50;
const IMPACT_BATCH_CONCURRENCY = 4;
const MAX_IMPACT_BATCH_DEPTH = 32;

interface ImpactBatchPerSymbol {
  target: string;
  result: RunImpactResult;
}

interface ImpactBatchUnion {
  totalAffectedNodes: number;
  totalRelationships: number;
  maxDepth: number;
  risk: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  sharedNodes: number;
}

interface ImpactBatchResult {
  status: 'success' | 'error';
  tool: 'impact_batch';
  repo: string;
  direction: 'upstream' | 'downstream';
  maxDepth: number;
  perSymbol: ImpactBatchPerSymbol[];
  union: ImpactBatchUnion;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImpactedNodeRecord(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && typeof value.id === 'string';
}

function flattenImpactedNodes(result: RunImpactResult): FlattenedImpactedNode[] {
  if (isRecord(result) && Array.isArray(result.impacted)) {
    return result.impacted.filter(isImpactedNodeRecord).map((item) => ({
      ...item,
      depth: typeof item.depth === 'number' ? item.depth : 0,
    }));
  }

  const byDepth = isRecord(result) ? result.byDepth : undefined;
  if (!isRecord(byDepth)) return [];

  const flattened: FlattenedImpactedNode[] = [];
  for (const [depthKey, items] of Object.entries(byDepth)) {
    if (!Array.isArray(items)) continue;
    const parsedDepth = Number(depthKey);
    const fallbackDepth = Number.isFinite(parsedDepth) ? parsedDepth : 0;
    for (const item of items) {
      if (!isImpactedNodeRecord(item)) continue;
      flattened.push({
        ...item,
        depth: typeof item.depth === 'number' ? item.depth : fallbackDepth,
      });
    }
  }
  return flattened;
}

function batchErrorDetail(err: unknown): string {
  const message = isRecord(err) ? err.message : undefined;
  return message === null || message === undefined ? String(err) : String(message);
}

function classifyRisk(total: number): ImpactBatchUnion['risk'] {
  if (total === 0) return 'NONE';
  if (total <= 5) return 'LOW';
  if (total <= 30) return 'MEDIUM';
  if (total <= 100) return 'HIGH';
  return 'CRITICAL';
}

function clampBatchDepth(value: unknown, fallback = 3): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), MAX_IMPACT_BATCH_DEPTH));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

export async function runImpactBatch(
  repo: RepoHandle,
  params: {
    targets?: string[];
    direction?: 'upstream' | 'downstream';
    maxDepth?: number;
    relationTypes?: string[];
    includeTests?: boolean;
    minConfidence?: number;
  },
): Promise<ImpactBatchResult> {
  const direction: 'upstream' | 'downstream' =
    params?.direction === 'downstream' ? 'downstream' : 'upstream';
  const maxDepth = clampBatchDepth(params?.maxDepth);

  const emptyUnion: ImpactBatchUnion = {
    totalAffectedNodes: 0,
    totalRelationships: 0,
    maxDepth: 0,
    risk: 'NONE',
    sharedNodes: 0,
  };

  if (!Array.isArray(params?.targets) || params!.targets.length === 0) {
    return {
      status: 'error',
      tool: 'impact_batch',
      repo: repo.name,
      direction,
      maxDepth,
      perSymbol: [],
      union: emptyUnion,
      error: '`targets` must be a non-empty array of symbol names.',
    };
  }

  const targets = params!.targets.filter(
    (t): t is string => typeof t === 'string' && t.trim().length > 0,
  );
  if (targets.length === 0) {
    return {
      status: 'error',
      tool: 'impact_batch',
      repo: repo.name,
      direction,
      maxDepth,
      perSymbol: [],
      union: emptyUnion,
      error: '`targets` contained no non-empty strings.',
    };
  }
  if (targets.length > MAX_IMPACT_BATCH_TARGETS) {
    return {
      status: 'error',
      tool: 'impact_batch',
      repo: repo.name,
      direction,
      maxDepth,
      perSymbol: [],
      union: emptyUnion,
      error: `impact_batch accepts at most ${MAX_IMPACT_BATCH_TARGETS} targets per call; received ${targets.length}. Split the request into smaller batches.`,
    };
  }

  try {
    const results = await mapWithConcurrency(targets, IMPACT_BATCH_CONCURRENCY, async (target) => {
      const result = await runImpact(repo, {
        target,
        direction,
        maxDepth,
        relationTypes: params?.relationTypes,
        includeTests: params?.includeTests,
        minConfidence: params?.minConfidence,
      });
      return { target, result };
    });

    // Count how many targets reached each impacted id so we can report
    // shared nodes — ids that showed up in the blast radius of more than
    // one target. These are typically the real bottlenecks in a refactor.
    const hits = new Map<string, number>();
    let totalRelationships = 0;
    let unionMaxDepth = 0;

    for (const { result } of results) {
      if (!result || result.error) continue;
      const impacted = flattenImpactedNodes(result);
      totalRelationships += impacted.length;
      for (const item of impacted) {
        const id = typeof item?.id === 'string' ? item.id : null;
        if (!id) continue;
        hits.set(id, (hits.get(id) ?? 0) + 1);
        const d = typeof item?.depth === 'number' ? item.depth : 0;
        if (d > unionMaxDepth) unionMaxDepth = d;
      }
    }

    let sharedNodes = 0;
    for (const count of hits.values()) {
      if (count > 1) sharedNodes += 1;
    }

    const totalAffectedNodes = hits.size;

    return {
      status: 'success',
      tool: 'impact_batch',
      repo: repo.name,
      direction,
      maxDepth,
      perSymbol: results,
      union: {
        totalAffectedNodes,
        totalRelationships,
        maxDepth: unionMaxDepth,
        risk: classifyRisk(totalAffectedNodes),
        sharedNodes,
      },
    };
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'impact_batch',
      repo: repo.name,
      direction,
      maxDepth,
      perSymbol: [],
      union: emptyUnion,
      error: `Batch impact analysis failed: ${batchErrorDetail(err)}`,
    };
  }
}
