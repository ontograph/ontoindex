/**
 * Optimized PageRank for high-performance graph ranking.
 *
 * Uses TypedArrays and flat adjacency structures to minimize GC pressure
 * and object lookup overhead in the power-iteration loop.
 */

export interface PageRankOptions {
  dampingFactor?: number;
  maxIterations?: number;
  tolerance?: number;
}

/**
 * High-performance PageRank implementation using Float64Arrays.
 */
export function fastPageRank(
  nodes: string[],
  edges: { sourceIdx: number; targetIdx: number }[],
  seedIndices: Set<number>,
  options?: PageRankOptions,
): Float64Array {
  const damping = options?.dampingFactor ?? 0.85;
  const maxIter = options?.maxIterations ?? 30;
  const tolerance = options?.tolerance ?? 1e-7;

  const N = nodes.length;
  if (N === 0) return new Float64Array(0);

  const outDegree = new Uint32Array(N);
  const targetsBySource: number[][] = Array.from({ length: N }, () => []);
  const sourcesByTarget: number[][] = Array.from({ length: N }, () => []);

  for (const edge of edges) {
    outDegree[edge.sourceIdx]++;
    targetsBySource[edge.sourceIdx].push(edge.targetIdx);
    sourcesByTarget[edge.targetIdx].push(edge.sourceIdx);
  }

  // Personalization vector
  const p = new Float64Array(N);
  if (seedIndices.size > 0) {
    const weight = 1.0 / seedIndices.size;
    for (const idx of seedIndices) p[idx] = weight;
  } else {
    p.fill(1.0 / N);
  }

  let scores = new Float64Array(N);
  scores.fill(1.0 / N);

  const invOutDegree = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    invOutDegree[i] = outDegree[i] > 0 ? 1.0 / outDegree[i] : 0;
  }

  for (let iter = 0; iter < maxIter; iter++) {
    const nextScores = new Float64Array(N);
    let danglingSum = 0;

    // Handle dangling nodes (nodes with no out-edges)
    for (let i = 0; i < N; i++) {
      if (outDegree[i] === 0) danglingSum += scores[i];
    }

    let diff = 0;
    const teleportScale = 1 - damping + damping * (danglingSum / N);

    for (let i = 0; i < N; i++) {
      let incomingSum = 0;
      const sources = sourcesByTarget[i];
      for (let j = 0; j < sources.length; j++) {
        const sourceIdx = sources[j];
        incomingSum += scores[sourceIdx] * invOutDegree[sourceIdx];
      }

      nextScores[i] = damping * incomingSum + teleportScale * p[i];
      diff += Math.abs(nextScores[i] - scores[i]);
    }

    scores = nextScores;
    if (diff < tolerance) break;
  }

  return scores;
}

/**
 * Wrapper for easy integration with existing Map-based structures.
 */
export function computeOptimizedPR(
  adjacency: Map<string, Set<string>>,
  seedNodes: Set<string>,
  options?: PageRankOptions,
): Map<string, number> {
  const allNodes = Array.from(
    new Set([
      ...adjacency.keys(),
      ...Array.from(adjacency.values()).flatMap((s) => Array.from(s)),
      ...seedNodes,
    ]),
  );

  const nodeToIndex = new Map(allNodes.map((id, i) => [id, i]));
  const edges: { sourceIdx: number; targetIdx: number }[] = [];
  const seedIndices = new Set<number>();

  for (const [source, targets] of adjacency) {
    const sourceIdx = nodeToIndex.get(source)!;
    for (const target of targets) {
      const targetIdx = nodeToIndex.get(target);
      if (targetIdx !== undefined) {
        edges.push({ sourceIdx, targetIdx });
      }
    }
  }

  for (const seed of seedNodes) {
    const idx = nodeToIndex.get(seed);
    if (idx !== undefined) seedIndices.add(idx);
  }

  const scores = fastPageRank(allNodes, edges, seedIndices, options);

  const resultMap = new Map<string, number>();
  for (let i = 0; i < allNodes.length; i++) {
    resultMap.set(allNodes[i], scores[i]);
  }

  return resultMap;
}
