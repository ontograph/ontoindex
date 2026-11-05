import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { toolsPhase } from '../../src/core/ingestion/pipeline-phases/tools.js';
import type { ParseOutput } from '../../src/core/ingestion/pipeline-phases/parse.js';
import { generateId } from '../../src/lib/utils.js';

describe('toolsPhase', () => {
  it('chooses duplicate tool definitions deterministically across parse order', async () => {
    const definitions = ['z.ts', 'a.ts'].map((filePath) => ({
      filePath,
      lineNumber: 1,
      toolName: 'shared',
      description: `description from ${filePath}`,
    }));
    const run = async (reverse: boolean) => {
      const graph = createKnowledgeGraph();
      const allToolDefs = reverse ? [...definitions].reverse() : [...definitions];
      const originalOrder = [...allToolDefs];
      const parseOutput = { allPaths: [], allToolDefs } as unknown as ParseOutput;
      await toolsPhase.execute(
        { repoPath: '.', graph, onProgress: () => {}, pipelineStart: Date.now() },
        new Map([['parse', { phaseName: 'parse', output: parseOutput, durationMs: 0 }]]),
      );
      expect(allToolDefs).toEqual(originalOrder);
      return {
        node: graph.getNode(generateId('Tool', 'shared'))?.properties,
        edges: graph.relationships.filter((rel) => rel.type === 'HANDLES_TOOL'),
      };
    };

    const forward = await run(false);
    expect(await run(true)).toEqual(forward);
    expect(forward.node).toEqual({
      name: 'shared',
      filePath: 'a.ts',
      description: 'description from a.ts',
    });
    expect(forward.edges).toHaveLength(1);
    expect(forward.edges[0].sourceId).toBe(generateId('File', 'a.ts'));
    expect(forward.edges[0].targetId).toBe(generateId('Tool', 'shared'));
  });
});
