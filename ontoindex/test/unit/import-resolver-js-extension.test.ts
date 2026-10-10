import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { resolveStandard } from '../../src/core/ingestion/import-resolvers/standard.js';
import type { ResolveCtx } from '../../src/core/ingestion/import-resolvers/types.js';
import {
  buildSuffixIndex,
  tryResolveWithExtensions,
} from '../../src/core/ingestion/import-resolvers/utils.js';

function makeCtx(
  files: string[],
  tsconfigPaths: ResolveCtx['configs']['tsconfigPaths'] = null,
): ResolveCtx {
  return {
    allFilePaths: new Set(files),
    allFileList: files,
    normalizedFileList: files,
    index: buildSuffixIndex(files, files),
    resolveCache: new Map(),
    configs: {
      tsconfigPaths,
      goModule: null,
      composerConfig: null,
      swiftPackageConfig: null,
      csharpConfigs: [],
    },
  };
}

describe('relative JS extensions resolve to TypeScript sources', () => {
  const cases = [
    ['./a.js', ['src/a.ts'], 'src/a.ts'],
    ['./a.js', ['src/a.tsx'], 'src/a.tsx'],
    ['./a.js', ['src/a.tsx', 'src/a.ts'], 'src/a.ts'],
    ['./a.js', ['src/a.ts', 'src/a.js'], 'src/a.js'],
    ['./a.jsx', ['src/a.tsx'], 'src/a.tsx'],
    ['./a.jsx', ['src/a.ts'], 'src/a.ts'],
    ['./a.jsx', ['src/a.ts', 'src/a.tsx'], 'src/a.tsx'],
    ['./a.jsx', ['src/a.tsx', 'src/a.jsx'], 'src/a.jsx'],
    ['./a.mjs', ['src/a.mts'], 'src/a.mts'],
    ['./a.mjs', ['src/a.mts', 'src/a.mjs'], 'src/a.mjs'],
    ['./a.cjs', ['src/a.cts'], 'src/a.cts'],
    ['./a.cjs', ['src/a.cts', 'src/a.cjs'], 'src/a.cjs'],
    ['./a.js', [], null],
    ['./a.mjs', ['src/a.ts'], null],
    ['./a.cjs', ['src/a.ts'], null],
    ['./a', ['src/a.ts'], 'src/a.ts'],
    ['./a', ['src/a.ts', 'src/a.tsx'], 'src/a.tsx'],
    ['./a.js', ['src/a.js.ts', 'src/a.ts'], 'src/a.js.ts'],
    ['./a.js', ['src/a.js/index.ts', 'src/a.ts'], 'src/a.js/index.ts'],
    ['../a.js', ['a.ts'], 'a.ts'],
  ] satisfies [string, string[], string | null][];

  for (const language of [SupportedLanguages.TypeScript, SupportedLanguages.JavaScript]) {
    describe(language, () => {
      it.each(cases)('%s with %j resolves to %s', (path, files, expected) => {
        const ctx = makeCtx(files);
        const result = expected ? { kind: 'files', files: [expected] } : null;
        expect(resolveStandard(path, 'src/b.ts', ctx, language)).toEqual(result);
        expect(ctx.resolveCache.get(`src/b.ts::${path}`)).toBe(expected);
        expect(resolveStandard(path, 'src/b.ts', ctx, language)).toEqual(result);
      });
    });
  }

  it.each([SupportedLanguages.TypeScript, SupportedLanguages.JavaScript])(
    'does not remap tsconfig aliases for %s',
    (language) => {
      const ctx = makeCtx(['src/a.ts'], {
        baseUrl: '.',
        aliases: new Map([['@/', 'src/']]),
      });
      expect(resolveStandard('@/a.js', 'src/b.ts', ctx, language)).toBeNull();
      expect(resolveStandard('@/a', 'src/b.ts', ctx, language)).toEqual({
        kind: 'files',
        files: ['src/a.ts'],
      });
    },
  );

  it.each([SupportedLanguages.TypeScript, SupportedLanguages.JavaScript])(
    'does not remap package suffixes for %s',
    (language) => {
      expect(
        resolveStandard('pkg/a.js', 'src/b.ts', makeCtx(['src/pkg/a.ts']), language),
      ).toBeNull();
    },
  );

  it.each(
    Object.values(SupportedLanguages).filter(
      (language) =>
        language !== SupportedLanguages.TypeScript && language !== SupportedLanguages.JavaScript,
    ),
  )('does not remap relative paths for %s', (language) => {
    expect(resolveStandard('./a.js', 'src/b.ts', makeCtx(['src/a.ts']), language)).toBeNull();
    expect(
      resolveStandard('./a.js', 'src/b.ts', makeCtx(['src/a.ts', 'src/a.js']), language),
    ).toEqual({
      kind: 'files',
      files: ['src/a.js'],
    });
  });

  it('keeps cache entries distinct for different importing files', () => {
    const ctx = makeCtx(['src/a.ts', 'other/a.js']);
    expect(resolveStandard('./a.js', 'src/b.ts', ctx, SupportedLanguages.TypeScript)).toEqual({
      kind: 'files',
      files: ['src/a.ts'],
    });
    expect(resolveStandard('./a.js', 'other/b.py', ctx, SupportedLanguages.Python)).toEqual({
      kind: 'files',
      files: ['other/a.js'],
    });
  });
});

describe('tryResolveWithExtensions opt-in compatibility', () => {
  it.each(['.js', '.jsx', '.mjs', '.cjs'])(
    'does not remap %s by default or when disabled',
    (extension) => {
      const files = new Set(['src/a.ts', 'src/a.tsx', 'src/a.mts', 'src/a.cts']);
      expect(tryResolveWithExtensions(`src/a${extension}`, files)).toBeNull();
      expect(tryResolveWithExtensions(`src/a${extension}`, files, { mapJsToTs: false })).toBeNull();
    },
  );

  it.each([undefined, { mapJsToTs: false }, { mapJsToTs: true }])(
    'preserves extensionless precedence with %j',
    (opts) => {
      expect(tryResolveWithExtensions('src/a', new Set(['src/a.ts', 'src/a.tsx']), opts)).toBe(
        'src/a.tsx',
      );
    },
  );
});
