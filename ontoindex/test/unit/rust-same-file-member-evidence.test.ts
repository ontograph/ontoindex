import { describe, expect, it } from 'vitest';
import { processCallsFromExtracted } from '../../src/core/ingestion/call-processor.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

describe('Rust same-file method receiver evidence', () => {
  it('rejects unknown and external receivers without losing local owners or free calls', async () => {
    const filePath = 'app/src/main.rs';
    const ctx = createResolutionContext();
    const graph = createKnowledgeGraph();
    const ownerId = `Struct:${filePath}:Other`;
    const methodId = `Function:${filePath}:Other.area`;
    const helperId = `Function:${filePath}:helper`;
    ctx.model.symbols.add(filePath, 'Other', ownerId, 'Struct');
    ctx.model.symbols.add(filePath, 'area', methodId, 'Function', {
      ownerId,
      parameterCount: 0,
    });
    ctx.model.symbols.add(filePath, 'helper', helperId, 'Function');

    await processCallsFromExtracted(
      graph,
      [
        // make_sq(2).area(): the cross-crate call-result type is not inferred.
        { filePath, sourceId: 'via_fn', calledName: 'area', callForm: 'member', argCount: 0 },
        {
          filePath,
          sourceId: 'unknown',
          calledName: 'area',
          callForm: 'member',
          receiverName: 'sq',
          argCount: 0,
        },
        {
          filePath,
          sourceId: 'external',
          calledName: 'area',
          callForm: 'member',
          receiverName: 'sq',
          receiverTypeName: 'Sq',
          argCount: 0,
        },
        {
          filePath,
          sourceId: 'unrelated',
          calledName: 'area',
          callForm: 'member',
          receiverName: 'o',
          receiverTypeName: 'Other',
          argCount: 0,
        },
        { filePath, sourceId: 'free', calledName: 'helper', callForm: 'free', argCount: 0 },
      ],
      ctx,
    );

    const calls = graph.relationships.filter((edge) => edge.type === 'CALLS');
    expect(calls.map((edge) => [edge.sourceId, edge.targetId])).toEqual([
      ['unrelated', methodId],
      ['free', helperId],
    ]);
    expect(calls.find((edge) => edge.sourceId === 'free')).toMatchObject({
      confidence: 0.95,
      reason: 'same-file',
    });
  });
});
