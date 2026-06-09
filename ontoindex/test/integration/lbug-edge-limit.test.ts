import { describe, it, expect } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import fs from 'fs/promises';
import path from 'path';

describe('relationship fallback limit', () => {
  withTestLbugDB('edge-limit', (handle) => {
    it('throws error when more than 1000 edges fail schema preflight', async () => {
      const { loadGraphToLbug } = await import('../../src/core/lbug/lbug-adapter.js');
      const graph = createKnowledgeGraph();

      // Add two nodes that are NOT in a valid relationship pair in the schema.
      // Community is a Leiden cluster node; it is never directly connected to
      // File by design, making Community->File a semantically impossible pair.

      const communityNode = {
        id: 'comm_test_1',
        label: 'Community',
        properties: { name: 'C1', filePath: '' },
      };
      const fileNode = {
        id: 'File:b.ts',
        label: 'File',
        properties: { name: 'b.ts', filePath: 'b.ts' },
      };

      graph.addNode(communityNode as any);
      graph.addNode(fileNode as any);

      // Add 1001 edges between them
      for (let i = 0; i < 1001; i++) {
        graph.addRelationship({
          id: `rel_${i}`,
          sourceId: communityNode.id,
          targetId: fileNode.id,
          type: 'CONTAINS',
          confidence: 1.0,
          reason: 'test',
        } as any);
      }

      const storagePath = path.join(handle.tmpHandle.dbPath, 'storage');
      await fs.mkdir(storagePath, { recursive: true });

      await expect(loadGraphToLbug(graph, '/test/repo', storagePath)).rejects.toThrow(
        /Bulk edge COPY failed for 1001 edges/,
      );
    });
  });
});
