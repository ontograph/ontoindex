/**
 * Personalized PageRank for graph-ranked context budgeting.
 *
 * Runs power iteration on the call/import graph to rank symbols by
 * importance relative to a set of "focus" seed nodes. Nodes closer
 * to the seeds (in the dependency graph) get higher scores.
 *
 * Used by the `repomap` MCP tool to produce token-budget-aware context
 * summaries for AI agents.
 */

/**
 * Run personalized PageRank over a directed graph.
 *
 * @param adjacency  Map<nodeId, Set<neighborIds>> — outgoing edges (callees/imports)
 * @param reverse    Map<nodeId, Set<neighborIds>> — incoming edges (callers/importers)
 * @param seedNodes  Set of node IDs to boost (files/symbols being edited)
 * @param options    Algorithm tuning parameters
 * @returns Map<nodeId, score> — higher score = more relevant to seeds
 */
export function personalizedPageRank(
  adjacency: Map<string, Set<string>>,
  reverse: Map<string, Set<string>>,
  seedNodes: Set<string>,
  options?: {
    dampingFactor?: number; // 0.85 default — probability of following an edge
    maxIterations?: number; // 20 default — convergence limit
    tolerance?: number; // 1e-6 default — convergence threshold
  },
): Map<string, number> {
  const damping = options?.dampingFactor ?? 0.85;
  const maxIter = options?.maxIterations ?? 20;
  const tolerance = options?.tolerance ?? 1e-6;

  // Collect all node IDs from both maps
  const allNodes = new Set<string>();
  for (const id of adjacency.keys()) allNodes.add(id);
  for (const id of reverse.keys()) allNodes.add(id);
  for (const id of seedNodes) allNodes.add(id);

  const N = allNodes.size;
  if (N === 0) return new Map();

  // Personalization vector: uniform over seed nodes, zero elsewhere
  const seedWeight = seedNodes.size > 0 ? 1.0 / seedNodes.size : 1.0 / N;

  // Initialize scores uniformly
  let scores = new Map<string, number>();
  const initScore = 1.0 / N;
  for (const id of allNodes) {
    scores.set(id, initScore);
  }

  // Power iteration
  for (let iter = 0; iter < maxIter; iter++) {
    const newScores = new Map<string, number>();
    let diff = 0;

    for (const nodeId of allNodes) {
      // Sum contributions from nodes that link TO this node
      let incomingSum = 0;
      const incomingNodes = reverse.get(nodeId);
      if (incomingNodes) {
        for (const sourceId of incomingNodes) {
          const sourceScore = scores.get(sourceId) ?? 0;
          const sourceOutDegree = adjacency.get(sourceId)?.size ?? 1;
          incomingSum += sourceScore / sourceOutDegree;
        }
      }

      // Personalization: teleport to seed nodes
      const personalization = seedNodes.has(nodeId) ? seedWeight : 0;

      // PageRank formula with personalization
      const newScore = (1 - damping) * personalization + damping * incomingSum;
      newScores.set(nodeId, newScore);

      diff += Math.abs(newScore - (scores.get(nodeId) ?? 0));
    }

    scores = newScores;

    // Check convergence
    if (diff < tolerance) break;
  }

  return scores;
}

/**
 * Build full adjacency maps from LadybugDB query results.
 * Includes CALLS, IMPORTS, USES, EXTENDS, IMPLEMENTS edges for comprehensive ranking.
 */
export function buildFullAdjacency(
  relationships: Array<{ sourceId: string; targetId: string; type: string }>,
): { adjacency: Map<string, Set<string>>; reverse: Map<string, Set<string>> } {
  const adjacency = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();

  const INCLUDED_TYPES = new Set(['CALLS', 'IMPORTS', 'USES', 'EXTENDS', 'IMPLEMENTS']);

  for (const rel of relationships) {
    if (!INCLUDED_TYPES.has(rel.type)) continue;

    if (!adjacency.has(rel.sourceId)) adjacency.set(rel.sourceId, new Set());
    if (!reverse.has(rel.targetId)) reverse.set(rel.targetId, new Set());

    adjacency.get(rel.sourceId)!.add(rel.targetId);
    reverse.get(rel.targetId)!.add(rel.sourceId);
  }

  return { adjacency, reverse };
}
