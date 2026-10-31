import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildImportResolutionContext,
  processImports,
  processImportsFromExtracted,
} from '../../src/core/ingestion/import-processor.js';
import type {
  ImportConfigs,
  ImportResolutionContext,
} from '../../src/core/ingestion/import-resolvers/types.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import * as languageConfig from '../../src/core/ingestion/language-config.js';
import { SupportedLanguages } from 'ontoindex-shared';

describe('import configuration ownership', () => {
  const configs: ImportConfigs = {
    tsconfigPaths: { aliases: new Map([['@/', 'original/']]), baseUrl: '.' },
    goModule: null,
    composerConfig: null,
    swiftPackageConfig: null,
    csharpConfigs: [],
  };

  afterEach(() => vi.restoreAllMocks());

  it.each(['sequential', 'extracted'] as const)(
    'uses supplied configs without loading them in the %s path',
    async (mode) => {
      const loader = vi
        .spyOn(languageConfig, 'loadImportConfigs')
        .mockRejectedValue(new Error('unexpected config reload'));
      const graph = createKnowledgeGraph();
      const ctx = createResolutionContext();
      if (mode === 'sequential') {
        await processImports(graph, [], createASTCache(0), ctx, undefined, '/unused', [], configs);
      } else {
        await processImportsFromExtracted(
          graph,
          [{ path: 'original/value.ts' }],
          [
            {
              filePath: 'entry.ts',
              rawImportPath: '@/value',
              language: SupportedLanguages.TypeScript,
            },
          ],
          ctx,
          undefined,
          '/unused',
          undefined,
          configs,
        );
        expect(ctx.importMap.get('entry.ts')).toEqual(new Set(['original/value.ts']));
      }
      expect(loader).not.toHaveBeenCalled();
    },
  );

  it.each(['sequential', 'extracted'] as const)(
    'loads configs for standalone %s calls',
    async (mode) => {
      const loader = vi.spyOn(languageConfig, 'loadImportConfigs').mockResolvedValue(configs);
      const graph = createKnowledgeGraph();
      const ctx = createResolutionContext();
      if (mode === 'sequential') {
        await processImports(graph, [], createASTCache(0), ctx, undefined, '/standalone');
      } else {
        await processImportsFromExtracted(graph, [], [], ctx, undefined, '/standalone');
      }
      // The second argument is the (empty) file inventory used for Cargo discovery.
      expect(loader).toHaveBeenCalledExactlyOnceWith('/standalone', []);
    },
  );
});

describe('ResolutionContext.importMap', () => {
  it('extracts public names in the sequential path without self imports', async () => {
    const ctx = createResolutionContext();
    const graph = createKnowledgeGraph();
    const cache = createASTCache(10);
    const files = [
      {
        path: 'base.ts',
        content: 'class Local {} export { Local as Public }; export default Local;',
      },
      { path: 'app.ts', content: "import * as models from './base';" },
    ];
    try {
      ctx.model.symbols.add('base.ts', 'Local', 'class:local', 'Class');
      await processImports(graph, files, cache, ctx);
      expect(ctx.resolve('models.Public', 'app.ts')?.candidates.map((def) => def.nodeId)).toEqual([
        'class:local',
      ]);
      expect(ctx.resolve('models.default', 'app.ts')?.candidates.map((def) => def.nodeId)).toEqual([
        'class:local',
      ]);
      expect(ctx.resolve('models.Local', 'app.ts')).toBeNull();
      expect(ctx.importMap.get('base.ts')).toBeUndefined();
      expect(graph.relationships.filter((edge) => edge.sourceId === edge.targetId)).toEqual([]);
    } finally {
      cache.clear();
      ctx.clear();
    }
  });

  it('creates an empty Map', () => {
    const map = createResolutionContext().importMap;
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it('can be used to store import relationships', () => {
    const map = createResolutionContext().importMap;
    map.set('src/index.ts', new Set(['src/utils.ts', 'src/types.ts']));
    expect(map.get('src/index.ts')!.size).toBe(2);
    expect(map.get('src/index.ts')!.has('src/utils.ts')).toBe(true);
  });
});

describe('buildImportResolutionContext', () => {
  let ctx: ImportResolutionContext;
  const testPaths = [
    'src/index.ts',
    'src/utils.ts',
    'src/components/Button.tsx',
    'src/lib/helpers.ts',
  ];

  beforeEach(() => {
    ctx = buildImportResolutionContext(testPaths);
  });

  it('creates a Set of all file paths', () => {
    expect(ctx.allFilePaths).toBeInstanceOf(Set);
    expect(ctx.allFilePaths.size).toBe(4);
    expect(ctx.allFilePaths.has('src/index.ts')).toBe(true);
  });

  it('stores the original file list', () => {
    expect(ctx.allFileList).toBe(testPaths);
  });

  it('creates normalized file list with forward slashes', () => {
    const winPaths = ['src\\index.ts', 'src\\utils.ts'];
    const winCtx = buildImportResolutionContext(winPaths);
    expect(winCtx.normalizedFileList[0]).toBe('src/index.ts');
    expect(winCtx.normalizedFileList[1]).toBe('src/utils.ts');
  });

  it('creates a suffix index for O(1) lookups', () => {
    expect(ctx.index).toBeDefined();
    expect(typeof ctx.index.get).toBe('function');
  });

  it('initializes empty resolve cache', () => {
    expect(ctx.resolveCache).toBeInstanceOf(Map);
    expect(ctx.resolveCache.size).toBe(0);
  });

  it('handles empty paths array', () => {
    const emptyCtx = buildImportResolutionContext([]);
    expect(emptyCtx.allFilePaths.size).toBe(0);
    expect(emptyCtx.allFileList).toHaveLength(0);
  });

  describe('suffix index', () => {
    it('resolves file by suffix', () => {
      const result = ctx.index.get('utils.ts');
      expect(result).toBeDefined();
    });

    it('resolves file by full path', () => {
      const result = ctx.index.get('src/index.ts');
      expect(result).toBeDefined();
    });

    it('resolves nested component path', () => {
      const result = ctx.index.get('components/Button.tsx');
      expect(result).toBeDefined();
    });

    it('returns undefined for non-existent suffix', () => {
      const result = ctx.index.get('nonexistent.ts');
      expect(result).toBeUndefined();
    });
  });
});
