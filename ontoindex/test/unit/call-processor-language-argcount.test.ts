import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';

describe('sequential language-specific call arity', () => {
  it.each([
    { args: '', arity: 0 },
    { args: '1, 2', arity: 2 },
  ])('resolves Foo().bar($args) to the $arity-parameter overload', async ({ args, arity }) => {
    const filePath = 'src/language-argcount.cpp';
    const sourceId = `Function:${filePath}:caller`;
    const ownerId = `Class:${filePath}:Foo`;
    const graph = createKnowledgeGraph();
    const cache = createASTCache();
    const ctx = createResolutionContext();
    ctx.model.symbols.add(filePath, 'caller', sourceId, 'Function');
    ctx.model.symbols.add(filePath, 'Foo', ownerId, 'Class');
    for (const parameterCount of [0, 2]) {
      // Distinct IDs and no return-type metadata keep the unfiltered pool
      // ambiguous: only the call's arity can select an overload.
      ctx.model.symbols.add(filePath, 'bar', `Method:${filePath}:bar:${parameterCount}`, 'Method', {
        ownerId,
        parameterCount,
        requiredParameterCount: parameterCount,
      });
    }

    try {
      // A temporary receiver uses the C++ language-specific extractor,
      // then resolveExtractedLanguageCallSite on the sequential path.
      await processCalls(
        graph,
        [
          {
            path: filePath,
            content: `
class Foo { public: void bar(); void bar(int, int); };
void caller() { Foo().bar(${args}); }
`,
          },
        ],
        cache,
        ctx,
      );

      expect(
        graph.relationships
          .filter((relationship) => relationship.type === 'CALLS')
          .map(({ sourceId, targetId }) => ({ sourceId, targetId })),
      ).toEqual([{ sourceId, targetId: `Method:${filePath}:bar:${arity}` }]);
    } finally {
      cache.clear();
      ctx.clear();
    }
  });
});
