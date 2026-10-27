import { describe, expect, it } from 'vitest';
import type { SyntaxNode } from 'tree-sitter';
import { SupportedLanguages } from 'ontoindex-shared';
import type { ParsedImport, Range } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import {
  emitTypeScriptImportCaptures,
  interpretTypeScriptImport,
} from '../../../src/core/ingestion/languages/typescript-import-captures.js';
import { emitTypeScriptLexicalScopeCaptures } from '../../../src/core/ingestion/languages/typescript-scope-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';

async function parse(source: string, filePath = 'fixture.ts') {
  const language = /\.jsx?$/.test(filePath)
    ? SupportedLanguages.JavaScript
    : SupportedLanguages.TypeScript;
  const parser = await createParserForLanguage(language, filePath);
  const tree = parser.parse(source);
  return { parser, tree, root: tree.rootNode };
}

function rangeOf(node: SyntaxNode): Range {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}

const named = (localName: string, targetRaw = './module'): ParsedImport => ({
  kind: 'named',
  localName,
  importedName: localName,
  targetRaw,
});
const alias = (localName: string, importedName: string, targetRaw = './module'): ParsedImport => ({
  kind: 'alias',
  localName,
  importedName,
  alias: localName,
  targetRaw,
});
const namespace = (localName: string, targetRaw = './module'): ParsedImport => ({
  kind: 'namespace',
  localName,
  importedName: targetRaw,
  targetRaw,
});

describe('borrowed TS/JS static import captures', () => {
  it('interprets reexports without conflating aliases and type namespaces with local imports', async () => {
    const { root } = await parse("import { Value } from './module';");
    const ordinary = emitTypeScriptImportCaptures(root.namedChildren[0]!)[0]!;
    const reexport = {
      ...ordinary,
      '@import.kind': { ...ordinary['@import.kind']!, text: 'reexport' },
    };
    expect(interpretTypeScriptImport(reexport)).toEqual({
      kind: 'reexport',
      localName: 'Value',
      importedName: 'Value',
      targetRaw: './module',
    });
    const typed = {
      ...reexport,
      '@import.namespace': {
        ...ordinary['@import.kind']!,
        name: '@import.namespace',
        text: 'type',
      },
    };
    expect(interpretTypeScriptImport(typed)).toEqual({
      kind: 'reexport',
      localName: 'Value',
      importedName: 'Value',
      targetRaw: './module',
      namespace: 'type',
    });
    const renamed = {
      ...typed,
      '@import.binding': { ...typed['@import.binding']!, text: 'Renamed' },
    };
    expect(interpretTypeScriptImport(renamed)).toEqual({
      kind: 'reexport',
      localName: 'Renamed',
      importedName: 'Value',
      alias: 'Renamed',
      targetRaw: './module',
      namespace: 'type',
    });
    for (const malformed of [
      {
        ...ordinary,
        '@import.kind': { ...ordinary['@import.kind']!, text: 'namespace' },
        '@import.namespace': typed['@import.namespace'],
      },
      { ...typed, '@import.namespace': { ...typed['@import.namespace'], text: 'value' } },
      { ...typed, '@import.namespace': { ...typed['@import.namespace'], name: '@import.wrong' } },
      {
        ...typed,
        '@import.namespace': {
          ...typed['@import.namespace'],
          range: { startLine: 0, startCol: 0, endLine: 1, endCol: 1 },
        },
      },
      { ...reexport, '@import.name': { ...reexport['@import.name']!, text: 'default' } },
      { ...reexport, '@import.binding': { ...reexport['@import.binding']!, text: 'default' } },
      { ...reexport, '@import.name': { ...reexport['@import.name']!, text: 'not an identifier' } },
    ])
      expect(() => interpretTypeScriptImport(malformed)).toThrow();
  });

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'captures only the default binding beside empty named imports in %s',
    async (filePath) => {
      const { root: defaultRoot } = await parse("import Main from './module';", filePath);
      const defaultCaptures = emitTypeScriptImportCaptures(defaultRoot.namedChildren[0]!);
      const fields = (matches: typeof defaultCaptures) =>
        matches.map((match) =>
          Object.fromEntries(
            Object.entries(match).map(([key, value]) => [
              key,
              {
                name: value.name,
                text: value.text,
              },
            ]),
          ),
        );
      for (const source of [
        "import Main, {} from './module';",
        "/* leading */ import Main, { /* empty */\n // still empty\n } from './module';",
      ]) {
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const statement = root.namedChildren.find((node) => node.type === 'import_statement')!;
        const captures = emitTypeScriptImportCaptures(statement);
        const repeated = emitTypeScriptImportCaptures(statement);
        const local = statement.descendantsOfType('identifier')[0]!;
        const moduleSource = statement.childForFieldName('source')!;
        expect(captures, source).toHaveLength(1);
        expect(fields(captures), source).toEqual(fields(defaultCaptures));
        expect(captures[0], source).toEqual({
          '@import.binding': { name: '@import.binding', text: 'Main', range: rangeOf(local) },
          '@import.source': {
            name: '@import.source',
            text: './module',
            range: rangeOf(moduleSource),
          },
          '@import.name': { name: '@import.name', text: 'default', range: rangeOf(local) },
          '@import.kind': { name: '@import.kind', text: 'alias', range: rangeOf(local) },
        });
        expect(captures.map(interpretTypeScriptImport), source).toEqual([alias('Main', 'default')]);
        const lexical = emitTypeScriptLexicalScopeCaptures(root);
        const serialized = JSON.stringify(captures);
        for (const [key, capture] of Object.entries(captures[0]!)) {
          expect(Object.getPrototypeOf(capture)).toBe(Object.prototype);
          expect(Object.getPrototypeOf(capture.range)).toBe(Object.prototype);
          expect(capture).not.toBe(repeated[0]![key]);
          expect(capture.range).not.toBe(repeated[0]![key]!.range);
        }
        parser.parse('class Replacement {}');
        expect(JSON.stringify(captures)).toBe(serialized);
        const result = extract([...lexical, ...JSON.parse(serialized)], filePath, {
          interpretImport: interpretTypeScriptImport,
        });
        expect(result.parsedImports).toEqual([alias('Main', 'default')]);
        expect(result.localDefs).toEqual([]);
        expect(result.scopes).toHaveLength(1);
        expect([...result.scopes[0]!.bindings]).toEqual([]);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'accepts runtime default and aliased local bindings named type in %s',
    async (filePath) => {
      for (const [source, expected] of [
        ["import type from './module';", [alias('type', 'default')]],
        [
          "import { Value as type, default as typeDefault } from './module';",
          [alias('type', 'Value'), alias('typeDefault', 'default')],
        ],
      ] as const) {
        const { root } = await parse(source, filePath);
        expect(root.hasError).toBe(false);
        const captures = emitTypeScriptImportCaptures(root.namedChildren[0]!);
        expect(captures.map(interpretTypeScriptImport)).toEqual(expected);
        for (const [index, binding] of expected.entries()) {
          const local = root
            .descendantsOfType('identifier')
            .find((node) => node.text === binding.localName)!;
          expect(captures[index]!['@import.binding']!.range).toEqual(rangeOf(local));
        }
        const result = extract(
          [...emitTypeScriptLexicalScopeCaptures(root), ...captures],
          filePath,
          { interpretImport: interpretTypeScriptImport },
        );
        expect(result.parsedImports).toEqual(expected);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'detaches statement type named imports and aliases in %s',
    async (filePath) => {
      for (const source of [
        "import type { A, B as C, type as TypeName } from './module';",
        "import /* before */ type /* after */ { A, /* alias */ B as C, type as TypeName, } from './module'",
      ]) {
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const statement = root.namedChildren[0]!;
        const captures = emitTypeScriptImportCaptures(statement);
        const repeated = emitTypeScriptImportCaptures(statement);
        const modifier = statement.children.find((node) => node.type === 'type' && !node.isNamed)!;
        const expected = [named('A'), alias('C', 'B'), alias('TypeName', 'type')].map(
          (binding) => ({ ...binding, namespace: 'type' }),
        );
        expect(captures.map(interpretTypeScriptImport), source).toEqual(expected);
        for (const [index, match] of captures.entries()) {
          expect(match['@import.namespace']).toEqual({
            name: '@import.namespace',
            text: 'type',
            range: rangeOf(modifier),
          });
          for (const [key, capture] of Object.entries(match)) {
            expect(Object.getPrototypeOf(capture)).toBe(Object.prototype);
            expect(Object.getPrototypeOf(capture.range)).toBe(Object.prototype);
            expect(capture).not.toBe(repeated[index]![key]);
            expect(capture.range).not.toBe(repeated[index]![key]!.range);
          }
        }
        expect(captures[0]!['@import.namespace']).not.toBe(captures[1]!['@import.namespace']);
        const lexical = emitTypeScriptLexicalScopeCaptures(root);
        const detached = structuredClone(captures);
        parser.parse('class Replacement {}');
        expect(captures).toEqual(detached);
        expect(
          extract([...lexical, ...detached], filePath, {
            interpretImport: interpretTypeScriptImport,
          }).parsedImports,
        ).toEqual(expected);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'rejects grammar-valid typeof modifiers for the whole import in %s',
    async (filePath) => {
      for (const source of [
        "import typeof Main from './module';",
        "import { Value, typeof Other as Local } from './module';",
      ]) {
        const { root } = await parse(source, filePath);
        expect(root.hasError).toBe(false);
        expect(root.namedChildren[0]!.type).toBe('import_statement');
        expect(() => emitTypeScriptImportCaptures(root.namedChildren[0]!), source).toThrow();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'preserves exact bindings and source order with the real %s grammar',
    async (filePath) => {
      const source = [
        "import { Direct, Original as Renamed } from './module';",
        "import DefaultOnly from './module';",
        "import * as NamespaceOnly from './module';",
        "import CombinedDefault, { CombinedNamed, Other as CombinedAlias } from './module';",
        "import NamespaceDefault, * as CombinedNamespace from './module';",
        "import { default as NamedDefault, type, type as RenamedType } from './module';",
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = root.namedChildren.flatMap(emitTypeScriptImportCaptures);
      const expected = [
        named('Direct'),
        alias('Renamed', 'Original'),
        alias('DefaultOnly', 'default'),
        namespace('NamespaceOnly'),
        alias('CombinedDefault', 'default'),
        named('CombinedNamed'),
        alias('CombinedAlias', 'Other'),
        alias('NamespaceDefault', 'default'),
        namespace('CombinedNamespace'),
        alias('NamedDefault', 'default'),
        named('type'),
        alias('RenamedType', 'type'),
      ];
      expect(captures.map(interpretTypeScriptImport)).toEqual(expected);
      for (const [index, match] of captures.entries()) {
        const binding = expected[index]!;
        expect(Object.keys(match).sort()).toEqual([
          '@import.binding',
          '@import.kind',
          '@import.name',
          '@import.source',
        ]);
        expect(match['@import.binding']!.text).toBe(binding.localName);
        expect(match['@import.name']!.text).toBe(binding.importedName);
        expect(match['@import.source']!.text).toBe(binding.targetRaw);
        expect(match['@import.kind']!.text).toBe(binding.kind);
        const localNodes = root
          .descendantsOfType('identifier')
          .filter((node) => node.text === binding.localName);
        // `type` is also used as the imported name of RenamedType.
        expect(match['@import.binding']!.range).toEqual(rangeOf(localNodes[0]!));
        for (const [key, capture] of Object.entries(match)) {
          expect(capture.name).toBe(key);
          expect(Object.keys(capture).sort()).toEqual(['name', 'range', 'text']);
        }
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'accepts comments, multiline clauses, trailing commas and plain quoted names in %s',
    async (filePath) => {
      const source = `import /* clause */ Main, {
  First, // keep order
  Second as LocalSecond,
  'plain-name' as PlainName,
  "double-name" as DoubleName,
} /* source */ from "pkg/name";`;
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptImportCaptures(root.namedChildren[0]!);
      expect(captures.map(interpretTypeScriptImport)).toEqual([
        alias('Main', 'default', 'pkg/name'),
        named('First', 'pkg/name'),
        alias('LocalSecond', 'Second', 'pkg/name'),
        alias('PlainName', 'plain-name', 'pkg/name'),
        alias('DoubleName', 'double-name', 'pkg/name'),
      ]);
      const local = root
        .descendantsOfType('identifier')
        .find((node) => node.text === 'LocalSecond')!;
      expect(captures[2]!['@import.binding']!.range).toEqual(rangeOf(local));
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'detaches mixed value and inline type bindings in source order in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        "import Main, { Value, type /* named */ T, type U as Local, type as RuntimeType } from './module';",
        filePath,
      );
      expect(root.hasError).toBe(false);
      const statement = root.namedChildren[0]!;
      const captures = emitTypeScriptImportCaptures(statement);
      const repeated = emitTypeScriptImportCaptures(statement);
      const expected = [
        alias('Main', 'default'),
        named('Value'),
        { ...named('T'), namespace: 'type' },
        { ...alias('Local', 'U'), namespace: 'type' },
        alias('RuntimeType', 'type'),
      ];
      expect(captures.map(interpretTypeScriptImport)).toEqual(expected);
      expect(
        captures
          .filter((match) => match['@import.namespace'])
          .map((match) => match['@import.namespace']),
      ).toEqual([
        {
          name: '@import.namespace',
          text: 'type',
          range: { startLine: 1, startCol: 22, endLine: 1, endCol: 26 },
        },
        {
          name: '@import.namespace',
          text: 'type',
          range: { startLine: 1, startCol: 42, endLine: 1, endCol: 46 },
        },
      ]);
      for (const [index, binding] of expected.entries()) {
        const local = root
          .descendantsOfType('identifier')
          .find((node) => node.text === binding.localName)!;
        expect(captures[index]!['@import.binding']!.range).toEqual(rangeOf(local));
        expect(captures[index]!['@import.namespace']?.text).toBe(
          'namespace' in binding ? 'type' : undefined,
        );
        for (const [key, capture] of Object.entries(captures[index]!)) {
          expect(Object.getPrototypeOf(capture)).toBe(Object.prototype);
          expect(Object.getPrototypeOf(capture.range)).toBe(Object.prototype);
          expect(capture).not.toBe(repeated[index]![key]);
          expect(capture.range).not.toBe(repeated[index]![key]!.range);
        }
      }
      const detached = JSON.parse(JSON.stringify(captures));
      const lexical = emitTypeScriptLexicalScopeCaptures(root);
      parser.parse('class Replacement {}');
      expect(captures).toEqual(detached);
      expect(
        extract([...lexical, ...detached], filePath, {
          interpretImport: interpretTypeScriptImport,
        }).parsedImports,
      ).toEqual(expected);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains all-inline type imports and rejects malformed named and alias metadata in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        "import { type T, type U as Local } from './module';",
        filePath,
      );
      expect(root.hasError).toBe(false);
      const captures = structuredClone(emitTypeScriptImportCaptures(root.namedChildren[0]!));
      const lexical = emitTypeScriptLexicalScopeCaptures(root);
      parser.parse('class Replacement {}');
      const expected = [
        { ...named('T'), namespace: 'type' },
        { ...alias('Local', 'U'), namespace: 'type' },
      ];
      expect(captures.map(interpretTypeScriptImport)).toEqual(expected);
      expect(
        extract([...lexical, ...captures], filePath, {
          interpretImport: interpretTypeScriptImport,
        }).parsedImports,
      ).toEqual(expected);
      for (const match of captures) {
        const metadata = match['@import.namespace']!;
        for (const malformed of [
          { ...metadata, name: '@import.wrong' },
          { ...metadata, text: 'value' },
          {
            ...metadata,
            range: {
              ...metadata.range,
              endLine: metadata.range.startLine,
              endCol: metadata.range.startCol,
            },
          },
        ]) {
          expect(() =>
            interpretTypeScriptImport({ ...match, '@import.namespace': malformed }),
          ).toThrow();
        }
      }
    },
  );

  it('uses native Unicode positions for local bindings', async () => {
    const { root } = await parse('/* 😀 */ import { café as λ } from "./é";');
    expect(root.hasError).toBe(false);
    const captures = emitTypeScriptImportCaptures(root.descendantsOfType('import_statement')[0]!);
    const local = root.descendantsOfType('identifier').find((node) => node.text === 'λ')!;
    expect(captures[0]!['@import.binding']!.range).toEqual(rangeOf(local));
    expect(captures.map(interpretTypeScriptImport)).toEqual([alias('λ', 'café', './é')]);
  });

  it('detaches deterministic plain data and feeds imports alongside lexical captures to extract', async () => {
    const source =
      "import Main, { Value as Local } from './module';\nfunction use() { return Main(Local); }";
    const { parser, root } = await parse(source);
    const statement = root.namedChildren[0]!;
    const first = emitTypeScriptImportCaptures(statement);
    const second = emitTypeScriptImportCaptures(statement);
    const lexical = emitTypeScriptLexicalScopeCaptures(root);
    const serialized = JSON.stringify(first);
    expect(first).toEqual(second);
    expect(first).toEqual(JSON.parse(serialized));
    for (const [index, match] of first.entries()) {
      for (const [key, capture] of Object.entries(match)) {
        expect(capture).not.toBe(second[index]![key]);
        expect(capture.range).not.toBe(second[index]![key]!.range);
        expect(Object.getPrototypeOf(capture)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(capture.range)).toBe(Object.prototype);
      }
    }
    // Native tree-sitter Tree has no delete API; reuse the parser after detachment.
    parser.parse('class Replacement {}');
    expect(JSON.stringify(first)).toBe(serialized);
    const result = extract([...lexical, ...JSON.parse(serialized)], 'fixture.ts', {
      interpretImport: interpretTypeScriptImport,
    });
    expect(result.parsedImports).toEqual([alias('Main', 'default'), alias('Local', 'Value')]);
    expect(result.scopes.map((scope) => scope.kind)).toEqual(['Module', 'Function', 'Block']);
    expect(result.localDefs).toEqual([]);
    first[0]!['@import.binding']!.range.startLine = 99;
    expect(JSON.stringify(second)).toBe(serialized);
  });

  it.each([
    "import type {} from './module';",
    "import type DefaultType from './module';",
    "import type * as Types from './module';",
    "import type Main, { OnlyType } from './module';",
    "import type type { OnlyType } from './module';",
    "import type { type OnlyType } from './module';",
    "import type { type OnlyType as Local } from './module';",
    "import type { typeof OnlyType } from './module';",
    "import type { default as Local } from './module';",
    "import type { 'OnlyType' as Local } from './module';",
    "import type { OnlyType as } from './module';",
    "import type { OnlyType } from './module' with { type: 'json' };",
    "import { Value, type default as LocalType } from './module';",
    "import { Value, type 'OnlyType' as LocalType } from './module';",
    "import { Value, type OnlyType as } from './module';",
    "import { Value, type OnlyType } from './module' with { type: 'json' };",
    "import './module';",
    "import {} from './module';",
    "import Main from './module' with { type: 'json' };",
    "import Main from './module' assert { type: 'json' };",
    String.raw`import Main from './mod\u0075le';`,
    String.raw`import { 'na\u006de' as Local } from './module';`,
    String.raw`import { N\u0061me } from './module';`,
    String.raw`import { Name as L\u006fcal } from './module';`,
    "import Equals = require('./module');",
    'import Equals = Other.Namespace;',
    "import('./module');",
    "export { Value } from './module';",
    "import { Value as } from './module';",
    "import { Value from './module';",
  ])('rejects the entire unsupported statement: %s', async (source) => {
    const { root } = await parse(source);
    expect(root.namedChildren.length).toBeGreaterThan(0);
    expect(() => emitTypeScriptImportCaptures(root.namedChildren[0]!)).toThrow();
  });

  it('refuses roots and nested identifiers instead of treating them as import statements', async () => {
    const { root } = await parse("import { Value } from './module';");
    expect(() => emitTypeScriptImportCaptures(root)).toThrow();
    expect(() => emitTypeScriptImportCaptures(root.descendantsOfType('identifier')[0]!)).toThrow();
  });

  it('ignores unrelated captures and rejects malformed owned captures', async () => {
    expect(interpretTypeScriptImport({})).toBeNull();
    expect(
      interpretTypeScriptImport({
        '@scope.module': {
          name: '@scope.module',
          text: '',
          range: { startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
        },
      }),
    ).toBeNull();
    const { root } = await parse("import { Value } from './module';");
    const valid = emitTypeScriptImportCaptures(root.namedChildren[0]!)[0]!;
    for (const key of Object.keys(valid)) {
      const incomplete = { ...valid };
      delete incomplete[key];
      expect(() => interpretTypeScriptImport(incomplete)).toThrow();
    }
    for (const [key, text] of [
      ['@import.kind', 'wildcard'],
      ['@import.binding', ''],
      ['@import.source', String.raw`./mod\u0075le`],
    ] as const) {
      const malformed = { ...valid, [key]: { ...valid[key]!, text } };
      expect(() => interpretTypeScriptImport(malformed)).toThrow();
    }
  });
});
