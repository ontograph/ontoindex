import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import {
  extractExtractedHeritageFromFiles,
  processHeritage,
  processHeritageFromExtracted,
} from '../../src/core/ingestion/heritage-processor.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';

describe('heritage retention prepass', () => {
  it('captures Ruby declarations and each mixin once, preserving production graph edges on replay', async () => {
    const files = [
      {
        path: 'account.rb',
        content: `class Account < Base
  include Printable
  extend Findable
  prepend Audited
end
`,
      },
    ];
    const cache = createASTCache();
    const onIncomplete = vi.fn();
    try {
      const records = await extractExtractedHeritageFromFiles(files, cache, onIncomplete);
      expect(records).toEqual([
        { filePath: 'account.rb', className: 'Account', parentName: 'Base', kind: 'extends' },
        { filePath: 'account.rb', className: 'Account', parentName: 'Printable', kind: 'include' },
        { filePath: 'account.rb', className: 'Account', parentName: 'Findable', kind: 'extend' },
        { filePath: 'account.rb', className: 'Account', parentName: 'Audited', kind: 'prepend' },
      ]);
      expect(onIncomplete).not.toHaveBeenCalled();

      // The legacy production path obtains declarations and mixins independently.
      const production = createKnowledgeGraph();
      const ctx = createResolutionContext();
      await processHeritage(production, files, cache, ctx);
      const mixins = await processCalls(production, files, cache, ctx);
      expect(mixins.map(({ kind }) => kind)).toEqual(['include', 'extend', 'prepend']);
      await processHeritageFromExtracted(production, mixins, ctx);

      // Retained records must remain usable after their ASTs have been released.
      cache.clear();
      const replay = createKnowledgeGraph();
      await processHeritageFromExtracted(
        replay,
        structuredClone(records),
        createResolutionContext(),
      );
      expect(replay.relationships).toHaveLength(4);
      expect(replay.relationships).toEqual(production.relationships);
      expect(replay.relationships.map(({ type, reason }) => ({ type, reason }))).toEqual([
        { type: 'EXTENDS', reason: '' },
        { type: 'IMPLEMENTS', reason: 'include' },
        { type: 'IMPLEMENTS', reason: 'extend' },
        { type: 'IMPLEMENTS', reason: 'prepend' },
      ]);
    } finally {
      cache.clear();
    }
  });

  it('treats successfully parsed source without heritage as complete empty evidence', async () => {
    const cache = createASTCache();
    const onIncomplete = vi.fn();
    try {
      await expect(
        extractExtractedHeritageFromFiles(
          [{ path: 'empty.rb', content: 'class Plain\nend\n' }],
          cache,
          onIncomplete,
        ),
      ).resolves.toEqual([]);
      expect(onIncomplete).not.toHaveBeenCalled();
    } finally {
      cache.clear();
    }
  });
});
