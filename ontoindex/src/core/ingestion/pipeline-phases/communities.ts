/**
 * Phase: communities
 *
 * Detects code communities via Leiden algorithm and creates
 * Community nodes + MEMBER_OF edges.
 *
 * @deps    mro
 * @reads   graph (all nodes and relationships)
 * @writes  graph (Community nodes, MEMBER_OF edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';
import { processCommunities, type CommunityDetectionResult } from '../community-processor.js';
import { isDev } from '../utils/env.js';

export interface CommunitiesOutput {
  communityResult: CommunityDetectionResult;
}

export const communitiesPhase: PipelinePhase<CommunitiesOutput> = {
  name: 'communities',
  deps: ['mro', 'structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<CommunitiesOutput> {
    const { totalFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');

    ctx.onProgress({
      phase: 'communities',
      percent: 84,
      message: 'Detecting code communities...',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: ctx.graph.nodeCount },
    });

    const communityResult = await processCommunities(ctx.graph, (message, progress) => {
      const communityProgress = 84 + progress * 0.09;
      ctx.onProgress({
        phase: 'communities',
        percent: Math.round(communityProgress),
        message,
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: ctx.graph.nodeCount },
      });
    });

    if (isDev) {
      console.log(
        `🏘️ Community detection: ${communityResult.stats.totalCommunities} communities found (modularity: ${communityResult.stats.modularity.toFixed(3)})`,
      );
    }

    const communityIds = new Set<string>();
    communityResult.communities.forEach((comm) => {
      communityIds.add(comm.id);
      ctx.graph.addNode({
        id: comm.id,
        label: 'Community' as const,
        properties: {
          name: comm.label,
          filePath: '',
          heuristicLabel: comm.heuristicLabel,
          cohesion: comm.cohesion,
          symbolCount: comm.symbolCount,
        },
      });
    });

    // Singleton communities get no node; an edge to one would dangle and the bulk
    // edge COPY can abort on it. The full membership list still feeds `processes`.
    communityResult.memberships.forEach((membership) => {
      if (!communityIds.has(membership.communityId)) return;
      ctx.graph.addRelationship({
        id: `${membership.nodeId}_member_of_${membership.communityId}`,
        type: 'MEMBER_OF',
        sourceId: membership.nodeId,
        targetId: membership.communityId,
        confidence: 1.0,
        reason: 'leiden-algorithm',
      });
    });

    return { communityResult };
  },
};
