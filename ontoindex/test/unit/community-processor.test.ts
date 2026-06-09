import { describe, it, expect, afterEach } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  getCommunityColor,
  COMMUNITY_COLORS,
  processCommunities,
} from '../../src/core/ingestion/community-processor.js';
import type { GraphNode, GraphRelationship } from '../../src/core/graph/types.js';

describe('community-processor', () => {
  afterEach(() => {
    delete process.env.ONTOINDEX_MAX_LEIDEN_NODES;
    delete process.env.ONTOINDEX_MAX_LEIDEN_EDGES;
  });

  describe('COMMUNITY_COLORS', () => {
    it('has 12 colors', () => {
      expect(COMMUNITY_COLORS).toHaveLength(12);
    });

    it('contains valid hex color strings', () => {
      for (const color of COMMUNITY_COLORS) {
        expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });

    it('has no duplicate colors', () => {
      const unique = new Set(COMMUNITY_COLORS);
      expect(unique.size).toBe(COMMUNITY_COLORS.length);
    });
  });

  describe('getCommunityColor', () => {
    it('returns first color for index 0', () => {
      expect(getCommunityColor(0)).toBe(COMMUNITY_COLORS[0]);
    });

    it('wraps around when index exceeds color count', () => {
      expect(getCommunityColor(12)).toBe(COMMUNITY_COLORS[0]);
      expect(getCommunityColor(13)).toBe(COMMUNITY_COLORS[1]);
    });

    it('returns different colors for different indices', () => {
      const c0 = getCommunityColor(0);
      const c1 = getCommunityColor(1);
      expect(c0).not.toBe(c1);
    });
  });

  describe('processCommunities runtime guards', () => {
    it('uses fallback communities when graph exceeds configured Leiden cap', async () => {
      process.env.ONTOINDEX_MAX_LEIDEN_NODES = '2';
      process.env.ONTOINDEX_MAX_LEIDEN_EDGES = '100';

      const graph = createKnowledgeGraph();
      for (let i = 0; i < 3; i++) {
        graph.addNode({
          id: `fn:${i}`,
          label: 'Function',
          properties: { name: `fn${i}`, filePath: `src/f${i}.ts` },
        } as GraphNode);
      }
      const rel = (id: string, sourceId: string, targetId: string): GraphRelationship => ({
        id,
        sourceId,
        targetId,
        type: 'CALLS',
        confidence: 1,
        reason: 'test',
      });
      graph.addRelationship(rel('r1', 'fn:0', 'fn:1'));
      graph.addRelationship(rel('r2', 'fn:1', 'fn:2'));

      const progress: string[] = [];
      const result = await processCommunities(graph, (message) => progress.push(message));

      expect(progress.some((message) => message.includes('too large for Leiden'))).toBe(true);
      expect(result.stats.totalCommunities).toBe(1);
      expect(new Set(result.memberships.map((m) => m.communityId))).toEqual(new Set(['comm_0']));
    });
  });
});
