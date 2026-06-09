export interface ReachabilityEdgeRow {
  readonly sourceId: string;
  readonly targetId: string;
}

export type ReachabilityTargetRow =
  | { readonly id?: unknown; readonly 0?: unknown }
  | readonly unknown[];

export function buildReachabilityAdjacency(
  rows: readonly ReachabilityEdgeRow[],
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const row of rows) {
    let targets = adjacency.get(row.sourceId);
    if (targets === undefined) {
      targets = [];
      adjacency.set(row.sourceId, targets);
    }
    targets.push(row.targetId);
  }
  return adjacency;
}

export function collectReachableIds(
  seeds: ReadonlySet<string>,
  adjacency: ReadonlyMap<string, readonly string[]>,
  maxIterations = 64,
): Set<string> {
  const visited = new Set<string>(seeds);
  let frontier = Array.from(seeds);

  for (let depth = 0; depth < maxIterations && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const sourceId of frontier) {
      const targets = adjacency.get(sourceId) ?? [];
      for (const targetId of targets) {
        if (visited.has(targetId)) continue;
        visited.add(targetId);
        next.push(targetId);
      }
    }
    frontier = next;
  }

  return visited;
}

export function collectNextFrontierFromRows(
  rows: readonly ReachabilityTargetRow[],
  visited: Set<string>,
): string[] {
  const next: string[] = [];
  for (const row of rows) {
    const record = row as { readonly id?: unknown; readonly 0?: unknown };
    const id = Array.isArray(row) ? row[0] : (record.id ?? record[0]);
    if (typeof id !== 'string') continue;
    if (visited.has(id)) continue;
    visited.add(id);
    next.push(id);
  }
  return next;
}
