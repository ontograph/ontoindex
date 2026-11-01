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
import {
  createResolutionContext,
  restoreImportResolutionState,
  snapshotImportResolutionState,
} from '../../src/core/ingestion/model/resolution-context.js';
import { restoreSemanticModelRegistrations } from '../../src/core/ingestion/model/semantic-model.js';
import { extractTsLocalExportBindings } from '../../src/core/ingestion/named-bindings/typescript.js';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import * as languageConfig from '../../src/core/ingestion/language-config.js';
import { SupportedLanguages } from 'ontoindex-shared';

describe.each([
  ['ts', SupportedLanguages.TypeScript],
  ['js', SupportedLanguages.JavaScript],
] as const)('destructured %s export authority', (extension, language) => {
  it.each([
    ['export const { value } = source;', ['value']],
    ['export let [first, , third, ...rest] = source;', ['first', 'third', 'rest']],
    ['export var { key: local = fallback, direct = other } = source;', ['local', 'direct']],
    [
      'export const { [key()]: { nested }, "label": [element = fallback], ...rest } = source;',
      ['nested', 'element', 'rest'],
    ],
    ['export const [ /* comment */ ...[inner]] = source, plain = other;', ['inner', 'plain']],
    ['export const {} = source, [] = other;', []],
    ['const { privateName } = source;', []],
    ['const { local } = source; export { local as Public };', ['Public']],
    ['export { value } from "./other";', []],
  ])('collects only binding positions: %s', async (content, expected) => {
    const parser = await createParserForLanguage(language, `base.${extension}`);
    const tree = parser.parse(content);
    expect(tree.rootNode.hasError).toBe(false);
    expect(extractTsLocalExportBindings(tree.rootNode).map(({ local }) => local)).toEqual(
      expected.map((name) => `#local-export:${name}`),
    );
  });

  it('ignores a malformed pattern without losing a separate valid declaration', async () => {
    const parser = await createParserForLanguage(language, `base.${extension}`);
    const tree = parser.parse('export const { good, broken: } = source; export const valid = 1;');
    expect(tree.rootNode.hasError).toBe(true);
    expect(extractTsLocalExportBindings(tree.rootNode)).toEqual([
      { local: '#local-export:valid', exported: 'valid' },
    ]);
  });

  it.each([false, true])(
    'preserves visibility through parsing and replay (cached=%s)',
    async (cached) => {
      const base = `base.${extension}`;
      const app = `app.${extension}`;
      const publicNames = ['value', 'local', 'item'];
      const privateNames = ['privateName', 'key', 'fallback', 'source'];
      const retained = createResolutionContext();
      for (const name of [...publicNames, ...privateNames]) {
        retained.model.symbols.add(base, name, `variable:${name}`, 'Variable');
      }
      // The resolver contract is conditional on symbol registration; no type inference is asserted.
      for (const exported of [true, false]) {
        const ctx = createResolutionContext({ captureRegistrations: true });
        const cache = createASTCache(10);
        const graph = createKnowledgeGraph();
        const files = [
          {
            path: base,
            content: `${exported ? 'export ' : ''}const { value, key: local = fallback } = source;\n${exported ? 'export ' : ''}const [item] = source;\nconst { privateName } = source;`,
          },
          { path: app, content: "import * as ns from './base';" },
        ];
        try {
          for (const name of [...publicNames, ...privateNames]) {
            ctx.model.symbols.add(base, name, `variable:${name}`, 'Variable');
          }
          // A same-name definition in another file cannot supply local export authority.
          ctx.model.symbols.add(
            `other.${extension}`,
            'privateName',
            'other:privateName',
            'Variable',
          );
          if (cached) {
            for (const file of files) {
              const parser = await createParserForLanguage(language, file.path);
              cache.set(file.path, parser.parse(file.content));
            }
          }
          await processImports(graph, files, cache, ctx);
          const assertVisibility = (context: ReturnType<typeof createResolutionContext>) => {
            for (const name of [...publicNames, ...privateNames]) {
              const ids =
                context.resolve(`ns.${name}`, app)?.candidates.map((def) => def.nodeId) ?? [];
              expect(ids, name).toEqual(
                exported && publicNames.includes(name) ? [`variable:${name}`] : [],
              );
            }
          };
          assertVisibility(ctx);
          ctx.clearCache();
          assertVisibility(ctx);
          for (const limits of [undefined, { maxBytes: 1_000_000, maxEntries: 1_000 }]) {
            // Replace earlier public authority with the next producer's private-only state.
            const restored = restoreImportResolutionState(
              JSON.parse(JSON.stringify(snapshotImportResolutionState(ctx, limits))),
            );
            retained.namedImportMap.clear();
            retained.moduleAliasMap.clear();
            for (const [file, bindings] of restored.namedImportMap) {
              retained.namedImportMap.set(file, bindings);
            }
            for (const [file, aliases] of restored.moduleAliasMap) {
              retained.moduleAliasMap.set(file, aliases);
            }
            retained.clearCache();
            assertVisibility(retained);
            const replay = createResolutionContext({
              model: restoreSemanticModelRegistrations(
                JSON.parse(JSON.stringify(ctx.model.snapshotRegistrations())),
              ),
              importState: JSON.parse(JSON.stringify(snapshotImportResolutionState(ctx, limits))),
            });
            try {
              assertVisibility(replay);
            } finally {
              replay.clear();
            }
          }
          expect(ctx.importMap.get(base)).toBeUndefined();
          expect(graph.relationships.filter((edge) => edge.sourceId === edge.targetId)).toEqual([]);
        } finally {
          cache.clear();
          ctx.clear();
        }
      }
      retained.clear();
    },
  );
});

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
