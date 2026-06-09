import { type PipelinePhase } from './index.js';
import { computeOptimizedPR } from '../../graph/fast-pagerank.js';

/**
 * pageRank phase: computes global importance scores for all code elements.
 *
 * Runs the optimized power-iteration PageRank algorithm over the full
 * call/import graph. Scores are stored on each node in the graph.
 */
export const pageRankPhase: PipelinePhase = {
  name: 'pageRank',
  deps: ['crossFile'],
  async execute(ctx) {
    const { graph, onProgress } = ctx;

    onProgress({
      phase: 'enriching',
      percent: 0,
      message: 'Computing global PageRank scores...',
    });

    const adjacency = new Map<string, Set<string>>();
    const INCLUDED_TYPES = new Set(['CALLS', 'IMPORTS', 'USES', 'EXTENDS', 'IMPLEMENTS']);

    // Build adjacency from graph
    graph.forEachRelationship((rel) => {
      if (!INCLUDED_TYPES.has(rel.type)) return;

      if (!adjacency.has(rel.sourceId)) adjacency.set(rel.sourceId, new Set());
      adjacency.get(rel.sourceId)!.add(rel.targetId);
    });

    onProgress({
      phase: 'enriching',
      percent: 30,
      message: `Built adjacency for ${adjacency.size} source nodes...`,
    });

    // Run PageRank (Global - no seed nodes)
    const scores = computeOptimizedPR(adjacency, new Set<string>());

    onProgress({
      phase: 'enriching',
      percent: 80,
      message: 'Updating graph with importance scores...',
    });

    let nodesUpdated = 0;
    scores.forEach((score, nodeId) => {
      const node = graph.getNode(nodeId);
      if (node) {
        node.properties.importance = score;
        nodesUpdated++;
      }
    });

    console.log(`[pageRank] Computed importance for ${nodesUpdated} nodes.`);
    return { status: 'success', stats: { nodesUpdated } };
  },
};
