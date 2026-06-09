/**
 * Pipeline Phase Runner
 *
 * Executes pipeline phases in dependency order using Kahn's topological sort.
 * Each phase receives typed outputs from its upstream dependencies.
 *
 * The runner is intentionally simple:
 * - No dynamic phase loading
 * - No plugin system
 * - Static phase graph, compile-time type safety
 * - Sequential execution (parallel support is architecturally possible
 *   but most phases have linear dependencies)
 */

import type {
  PipelinePhase,
  PipelineContext,
  PhaseResult,
  DisposablePhaseOutput,
} from './types.js';
import { isDev } from '../utils/env.js';
import v8 from 'node:v8';

/**
 * Validate that the phases form a valid dependency graph (no cycles, all deps present).
 * Returns phases in topological execution order.
 */
function topologicalSort(phases: readonly PipelinePhase[]): PipelinePhase[] {
  const phaseMap = new Map<string, PipelinePhase>();
  for (const phase of phases) {
    if (phaseMap.has(phase.name)) {
      throw new Error(`Duplicate phase name: '${phase.name}'`);
    }
    phaseMap.set(phase.name, phase);
  }

  // Validate all deps exist
  for (const phase of phases) {
    for (const dep of phase.deps) {
      if (!phaseMap.has(dep)) {
        throw new Error(`Phase '${phase.name}' depends on '${dep}', which is not registered`);
      }
    }
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  const reverseDeps = new Map<string, string[]>();

  for (const phase of phases) {
    inDegree.set(phase.name, phase.deps.length);
    for (const dep of phase.deps) {
      let rev = reverseDeps.get(dep);
      if (!rev) {
        rev = [];
        reverseDeps.set(dep, rev);
      }
      rev.push(phase.name);
    }
  }

  const sorted: PipelinePhase[] = [];
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([name]) => name);

  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(phaseMap.get(name)!);

    for (const dependent of reverseDeps.get(name) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  if (sorted.length !== phases.length) {
    const remaining = new Set(
      [...inDegree.entries()].filter(([, d]) => d > 0).map(([name]) => name),
    );
    const cyclePath = findCyclePath(remaining, phaseMap);
    const dependentsBlocked = remaining.size - new Set(cyclePath).size;
    let message = `Cycle detected in pipeline phases: ${cyclePath.join(' -> ')}`;
    if (dependentsBlocked > 0) {
      message += ` (and ${dependentsBlocked} transitive dependent${dependentsBlocked === 1 ? '' : 's'} blocked)`;
    }
    throw new Error(message);
  }

  return sorted;
}

/**
 * Find a concrete cycle path among the phases that Kahn's algorithm could not drain.
 *
 * Kahn's leftovers include both true cycle members AND phases transitively dependent
 * on them. To produce an actionable error message, we DFS over the leftovers (using
 * each leftover's `deps` as edges) until we hit a back-edge — that closes the cycle.
 * The returned list is the cycle in order with the entry node repeated at the end:
 * `[A, B, C, A]` for `A -> B -> C -> A`.
 *
 * Falls back to the raw remaining set (sorted) if no back-edge is found, which
 * should be unreachable but keeps the error informative.
 */
function findCyclePath(
  remaining: ReadonlySet<string>,
  phaseMap: ReadonlyMap<string, PipelinePhase>,
): string[] {
  for (const start of remaining) {
    const stack: string[] = [];
    const onStack = new Set<string>();
    const visited = new Set<string>();

    const dfs = (name: string): string[] | null => {
      stack.push(name);
      onStack.add(name);
      visited.add(name);

      const phase = phaseMap.get(name);
      if (phase) {
        for (const dep of phase.deps) {
          if (!remaining.has(dep)) continue; // dep already drained — not part of cycle
          if (onStack.has(dep)) {
            // Back-edge — slice from the first occurrence of `dep` and close the loop.
            const cycleStart = stack.indexOf(dep);
            return [...stack.slice(cycleStart), dep];
          }
          if (!visited.has(dep)) {
            const found = dfs(dep);
            if (found) return found;
          }
        }
      }

      stack.pop();
      onStack.delete(name);
      return null;
    };

    const cycle = dfs(start);
    if (cycle) return cycle;
  }
  // Unreachable in practice (Kahn proved a cycle exists), but stay defensive.
  return [...remaining].sort();
}

function emitTelemetry(
  ctx: PipelineContext,
  event: 'phase-start' | 'phase-end' | 'phase-error',
  phaseName: string,
  durationMs?: number,
  error?: unknown,
): void {
  const onTelemetry = ctx.options?.onTelemetry;
  if (!onTelemetry) return;

  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  try {
    onTelemetry({
      event,
      phaseName,
      elapsedMs: Date.now() - ctx.pipelineStart,
      durationMs,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      heapLimitBytes: heap.heap_size_limit,
      graphNodes: ctx.graph.nodeCount,
      graphRelationships: ctx.graph.relationshipCount,
      error:
        error instanceof Error ? error.message : error === undefined ? undefined : String(error),
    });
  } catch {
    // Telemetry must never change pipeline behavior.
  }
}

function hasDisposableOutput(output: unknown): output is DisposablePhaseOutput {
  return (
    typeof output === 'object' &&
    output !== null &&
    'dispose' in output &&
    typeof (output as { dispose?: unknown }).dispose === 'function'
  );
}

function disposePhaseResult(
  result: PhaseResult<unknown> | undefined,
  disposedOutputs: WeakSet<DisposablePhaseOutput>,
): void {
  if (!result || !hasDisposableOutput(result.output)) return;
  if (disposedOutputs.has(result.output)) return;
  disposedOutputs.add(result.output);
  try {
    result.output.dispose();
  } catch (err) {
    if (isDev) {
      console.warn(
        `Phase '${result.phaseName}' output dispose failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function disposeCompletedResults(
  results: ReadonlyMap<string, PhaseResult<unknown>>,
  disposedOutputs: WeakSet<DisposablePhaseOutput>,
): void {
  for (const result of results.values()) {
    disposePhaseResult(result, disposedOutputs);
  }
}

function countRemainingDependents(phases: readonly PipelinePhase[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const phase of phases) {
    for (const depName of phase.deps) {
      counts.set(depName, (counts.get(depName) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Execute a set of pipeline phases in dependency order.
 *
 * @param phases  All phases to execute (order doesn't matter — sorted internally)
 * @param ctx     Shared pipeline context
 * @returns       Map of phase name → PhaseResult (all completed phases)
 */
export async function runPipeline(
  phases: readonly PipelinePhase[],
  ctx: PipelineContext,
): Promise<ReadonlyMap<string, PhaseResult<unknown>>> {
  let sorted: PipelinePhase[];
  try {
    sorted = topologicalSort(phases);
  } catch (err) {
    // Emit a terminal 'error' progress event for graph-validation failures
    // (cycle detected, duplicate phase, missing dep) so CLI/MCP consumers see
    // the failure before the rejection propagates. Symmetric with the
    // per-phase error path below. Best-effort: a throwing handler must not
    // mask the underlying validation error.
    const message = err instanceof Error ? err.message : String(err);
    try {
      ctx.onProgress({
        phase: 'error',
        percent: 100,
        message: 'Pipeline graph validation failed',
        detail: message,
      });
    } catch {
      // Swallow handler errors — preserving the original cause is more important.
    }
    throw err;
  }
  const results = new Map<string, PhaseResult<unknown>>();
  const remainingDependents = countRemainingDependents(sorted);
  const disposedOutputs = new WeakSet<DisposablePhaseOutput>();

  for (const phase of sorted) {
    const start = Date.now();
    emitTelemetry(ctx, 'phase-start', phase.name);

    if (isDev) {
      console.log(`▶ Phase: ${phase.name}`);
    }

    // Only expose declared dependencies — prevents hidden coupling to undeclared phases.
    const declaredDeps = new Map<string, PhaseResult<unknown>>();
    for (const depName of phase.deps) {
      const depResult = results.get(depName);
      if (depResult) declaredDeps.set(depName, depResult);
    }

    let output: unknown;
    try {
      output = await phase.execute(ctx, declaredDeps);
    } catch (err) {
      emitTelemetry(ctx, 'phase-error', phase.name, Date.now() - start, err);
      const originalMessage = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(`Phase '${phase.name}' failed: ${originalMessage}`, {
        cause: err,
      });

      // Emit a terminal 'error' progress event so CLI/MCP consumers see the failure
      // before the rejection propagates. Best-effort: a throwing handler must not
      // mask the underlying phase error.
      try {
        ctx.onProgress({
          phase: 'error',
          percent: 100,
          message: `Phase '${phase.name}' failed`,
          detail: originalMessage,
        });
      } catch {
        // Swallow handler errors — preserving the original cause is more important.
      }

      disposeCompletedResults(results, disposedOutputs);
      throw wrapped;
    }
    const durationMs = Date.now() - start;
    emitTelemetry(ctx, 'phase-end', phase.name, durationMs);

    results.set(phase.name, {
      phaseName: phase.name,
      output,
      durationMs,
    });

    for (const depName of phase.deps) {
      const remaining = (remainingDependents.get(depName) ?? 0) - 1;
      remainingDependents.set(depName, remaining);
      if (remaining === 0) {
        disposePhaseResult(results.get(depName), disposedOutputs);
      }
    }

    if (isDev) {
      console.log(`✓ Phase: ${phase.name} (${durationMs}ms)`);
    }
  }

  return results;
}
