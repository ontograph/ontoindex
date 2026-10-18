import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type {
  PhaseResult,
  PipelineContext,
} from '../../src/core/ingestion/pipeline-phases/types.js';

vi.mock('../../src/core/ingestion/community-processor.js', () => ({
  processCommunities: vi.fn(async () => ({
    communities: [
      { id: 'comm_1', label: 'Auth', heuristicLabel: 'Auth', cohesion: 0.5, symbolCount: 2 },
    ],
    // comm_7 is a skipped singleton: no Community node exists for it.
    memberships: [
      { nodeId: 'Function:a', communityId: 'comm_1' },
      { nodeId: 'Function:b', communityId: 'comm_1' },
      { nodeId: 'Function:c', communityId: 'comm_7' },
    ],
    stats: { totalCommunities: 2, modularity: 0.4, nodesProcessed: 3 },
  })),
}));

const { communitiesPhase } =
  await import('../../src/core/ingestion/pipeline-phases/communities.js');

describe('communitiesPhase', () => {
  it('writes MEMBER_OF edges only for communities that received a node', async () => {
    const graph = createKnowledgeGraph();
    const ctx = {
      repoPath: '/tmp/x',
      graph,
      onProgress: () => undefined,
    } as unknown as PipelineContext;
    const deps = new Map<string, PhaseResult<unknown>>([
      ['structure', { phaseName: 'structure', output: { totalFiles: 1 }, durationMs: 0 }],
    ]);

    const out = await communitiesPhase.execute(ctx, deps);

    const edges = [...graph.iterRelationships()].filter((r) => r.type === 'MEMBER_OF');
    expect(edges.map((e) => e.targetId).sort()).toEqual(['comm_1', 'comm_1']);
    for (const e of edges) expect(graph.getNode(e.targetId)).toBeDefined();
    // processes still consume the full membership list, singletons included.
    expect(out.communityResult.memberships).toHaveLength(3);
  });
});
