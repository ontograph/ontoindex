import { describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import * as languageProviders from '../../src/core/ingestion/languages/index.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import type { ExtractedCall } from '../../src/core/ingestion/workers/parse-worker.js';

describe('sequential call retention coverage', () => {
  it.each(['complete', 'missing extractor', 'null extraction'] as const)(
    '%s preserves graph resolution and reports whether original calls were captured',
    async (mode) => {
      const file = {
        path: 'src/coverage.ts',
        content: 'function target() {}\nfunction caller() { target(); }\n',
      };
      const setup = () => {
        const graph = createKnowledgeGraph();
        const ctx = createResolutionContext();
        ctx.model.symbols.add(file.path, 'target', `Function:${file.path}:target`, 'Function');
        ctx.model.symbols.add(file.path, 'caller', `Function:${file.path}:caller`, 'Function');
        return { graph, ctx, cache: createASTCache() };
      };
      const baseline = setup();
      const observed = setup();
      const calls: ExtractedCall[] = [];
      const onIncomplete = vi.fn();
      const originalGetProvider = languageProviders.getProvider;
      const provider = originalGetProvider(SupportedLanguages.TypeScript);
      const providerSpy =
        mode === 'complete'
          ? undefined
          : vi.spyOn(languageProviders, 'getProvider').mockImplementation((language) =>
              language === SupportedLanguages.TypeScript
                ? {
                    ...provider,
                    callExtractor:
                      mode === 'missing extractor'
                        ? undefined
                        : { language: SupportedLanguages.TypeScript, extract: () => null },
                  }
                : originalGetProvider(language),
            );
      try {
        const baselineHeritage = await processCalls(
          baseline.graph,
          [file],
          baseline.cache,
          baseline.ctx,
        );
        const observedHeritage = await processCalls(
          observed.graph,
          [file],
          observed.cache,
          observed.ctx,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (call) => calls.push(call),
          undefined,
          undefined,
          onIncomplete,
        );
        expect(observedHeritage).toEqual(baselineHeritage);
        expect(observed.graph.nodes).toEqual(baseline.graph.nodes);
        expect(observed.graph.relationships).toEqual(baseline.graph.relationships);
        expect(observed.graph.relationships.filter((edge) => edge.type === 'CALLS')).toEqual([
          expect.objectContaining({
            sourceId: `Function:${file.path}:caller`,
            targetId: `Function:${file.path}:target`,
          }),
        ]);
        if (mode === 'complete') {
          expect(onIncomplete).not.toHaveBeenCalled();
          expect(calls).toEqual([
            {
              filePath: file.path,
              sourceId: `Function:${file.path}:caller`,
              calledName: 'target',
              callForm: 'free',
              argCount: 0,
              atRange: { startLine: 2, startCol: 20, endLine: 2, endCol: 28 },
            },
          ]);
        } else {
          expect(onIncomplete).toHaveBeenCalled();
          expect(calls).toEqual([]);
        }
      } finally {
        providerSpy?.mockRestore();
        baseline.cache.clear();
        observed.cache.clear();
      }
    },
  );

  it.each([
    {
      path: 'src/builtins.ts',
      content: 'function target() {}\nparseInt("1");\ntarget();\n',
      heritage: [],
      properties: [],
    },
    {
      path: 'src/routing.rb',
      content: `require 'json'
require(dynamic_path)
class Account
  include Printable
  extend Findable
  prepend Audited
  attr_accessor :name
end
def target
end
target()
`,
      heritage: [
        { className: 'Account', parentName: 'Printable', kind: 'include' },
        { className: 'Account', parentName: 'Findable', kind: 'extend' },
        { className: 'Account', parentName: 'Audited', kind: 'prepend' },
      ],
      properties: ['name'],
    },
  ])('intentionally omitted calls remain complete in $path', async (fixture) => {
    const file = { path: fixture.path, content: fixture.content };
    const setup = () => {
      const graph = createKnowledgeGraph();
      const ctx = createResolutionContext();
      ctx.model.symbols.add(file.path, 'target', `Function:${file.path}:target`, 'Function');
      return { graph, ctx, cache: createASTCache() };
    };
    const baseline = setup();
    const observed = setup();
    const calls: ExtractedCall[] = [];
    const onIncomplete = vi.fn();
    try {
      const baselineHeritage = await processCalls(
        baseline.graph,
        [file],
        baseline.cache,
        baseline.ctx,
      );
      const observedHeritage = await processCalls(
        observed.graph,
        [file],
        observed.cache,
        observed.ctx,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (call) => calls.push(call),
        undefined,
        undefined,
        onIncomplete,
      );
      expect(onIncomplete).not.toHaveBeenCalled();
      expect(calls).toEqual([
        {
          filePath: file.path,
          sourceId: `File:${file.path}`,
          calledName: 'target',
          callForm: 'free',
          argCount: 0,
          atRange: {
            startLine: file.content.slice(0, file.content.lastIndexOf('target()')).split('\n')
              .length,
            startCol: 0,
            endLine: file.content.slice(0, file.content.lastIndexOf('target()')).split('\n').length,
            endCol: 8,
          },
        },
      ]);
      expect(observedHeritage).toEqual(
        fixture.heritage.map((item) => ({ filePath: file.path, ...item })),
      );
      expect(observedHeritage).toEqual(baselineHeritage);
      expect(observed.graph.nodes).toEqual(baseline.graph.nodes);
      expect(observed.graph.relationships).toEqual(baseline.graph.relationships);
      expect(
        observed.graph.nodes
          .filter((node) => node.label === 'Property')
          .map((node) => node.properties.name),
      ).toEqual(fixture.properties);
      expect(observed.graph.relationships.filter((edge) => edge.type === 'CALLS')).toEqual([
        expect.objectContaining({
          sourceId: `File:${file.path}`,
          targetId: `Function:${file.path}:target`,
        }),
      ]);
    } finally {
      baseline.cache.clear();
      observed.cache.clear();
    }
  });
});
