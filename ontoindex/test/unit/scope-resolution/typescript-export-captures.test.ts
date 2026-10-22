import { describe, expect, it } from 'vitest';
import type { SyntaxNode } from 'tree-sitter';
import { SupportedLanguages } from 'ontoindex-shared';
import type { CaptureMatch, ParsedFile, Range } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import {
  emitTypeScriptExportCaptures,
  interpretTypeScriptExports,
} from '../../../src/core/ingestion/languages/typescript-export-captures.js';
import { emitTypeScriptLexicalScopeCaptures } from '../../../src/core/ingestion/languages/typescript-scope-captures.js';
import {
  emitTypeScriptDeclarationCaptures,
  emitTypeScriptLexicalBindingCaptures,
  emitTypeScriptVarBindingCapturesForFile,
  selectTypeScriptLocalBindings,
  typeScriptDeclarationBindingScope,
} from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';

async function parse(source: string, filePath = 'fixture.ts') {
  const language = /\.jsx?$/.test(filePath)
    ? SupportedLanguages.JavaScript
    : SupportedLanguages.TypeScript;
  const parser = await createParserForLanguage(language, filePath);
  const tree = parser.parse(source);
  return { parser, root: tree.rootNode };
}

function rangeOf(node: SyntaxNode): Range {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}

function declarations(root: SyntaxNode): CaptureMatch[] {
  return [
    ...root
      .descendantsOfType(['function_declaration', 'class_declaration'])
      .flatMap(emitTypeScriptDeclarationCaptures),
    ...root.descendantsOfType('lexical_declaration').flatMap(emitTypeScriptLexicalBindingCaptures),
    ...emitTypeScriptVarBindingCapturesForFile(root),
  ];
}

const hooks = {
  bindingScopeFor: typeScriptDeclarationBindingScope,
  selectLocalBindings: selectTypeScriptLocalBindings,
};

function contextWithBindings(
  context: ParsedFile,
  bindings: ParsedFile['scopes'][number]['bindings'],
) {
  return {
    ...context,
    scopes: context.scopes.map((scope) =>
      scope.id === context.moduleScope ? { ...scope, bindings } : scope,
    ),
  };
}

describe('borrowed TS/JS local export captures', () => {
  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'preserves source names and ranges with the real %s grammar',
    async (filePath) => {
      const { root } = await parse(
        'export /* clause */ { local, local /* alias */ as renamed, local as default, };',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const matches = emitTypeScriptExportCaptures(root.namedChildren[0]!);
      expect(
        matches.map((match) => [match['@export.local']!.text, match['@export.name']!.text]),
      ).toEqual([
        ['local', 'local'],
        ['local', 'renamed'],
        ['local', 'default'],
      ]);
      const specifiers = root.descendantsOfType('export_specifier');
      for (const [index, match] of matches.entries()) {
        expect(Object.keys(match).sort()).toEqual(['@export.local', '@export.name']);
        const specifier = specifiers[index]!;
        expect(match['@export.local']!.range).toEqual(
          rangeOf(specifier.childForFieldName('name')!),
        );
        expect(match['@export.name']!.range).toEqual(
          rangeOf(specifier.childForFieldName('alias') ?? specifier.childForFieldName('name')!),
        );
        for (const [key, capture] of Object.entries(match)) {
          expect(capture.name).toBe(key);
          expect(Object.keys(capture).sort()).toEqual(['name', 'range', 'text']);
        }
      }
    },
  );

  it('accepts type as an ordinary JavaScript local identifier and exported alias', async () => {
    const { root } = await parse(
      'const type = 1; const local = 2; export { type, type as renamed, local as typeAlias };',
      'fixture.js',
    );
    expect(root.hasError).toBe(false);
    const captures = emitTypeScriptExportCaptures(root.descendantsOfType('export_statement')[0]!);
    expect(
      captures.map((match) => [match['@export.local']!.text, match['@export.name']!.text]),
    ).toEqual([
      ['type', 'type'],
      ['type', 'renamed'],
      ['local', 'typeAlias'],
    ]);
    const result = extract(
      [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root), ...captures],
      'fixture.js',
      { ...hooks, interpretExports: interpretTypeScriptExports },
    );
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    expect(result.exports).toEqual(
      new Map([
        ['type', module.bindings.get('type')![0]!.def.nodeId],
        ['renamed', module.bindings.get('type')![0]!.def.nodeId],
        ['typeAlias', module.bindings.get('local')![0]!.def.nodeId],
      ]),
    );
  });

  it('accepts type as an ordinary JavaScript exported alias', async () => {
    const { root } = await parse('const local = 1; export { local as type };', 'fixture.js');
    expect(root.hasError).toBe(false);
    const captures = emitTypeScriptExportCaptures(root.descendantsOfType('export_statement')[0]!);
    expect(
      captures.map((match) => [match['@export.local']!.text, match['@export.name']!.text]),
    ).toEqual([['local', 'type']]);
    const result = extract(
      [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root), ...captures],
      'fixture.js',
      { ...hooks, interpretExports: interpretTypeScriptExports },
    );
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    expect(result.exports).toEqual(
      new Map([['type', module.bindings.get('local')![0]!.def.nodeId]]),
    );
  });

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'combines distinct exports from multiple statements in %s',
    async (filePath) => {
      const { root } = await parse(
        [
          'const first = 1; const second = 2;',
          'export { first };',
          'export { second as renamed };',
          'export { first as default };',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const captures = root
        .descendantsOfType('export_statement')
        .flatMap(emitTypeScriptExportCaptures);
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root), ...captures],
        filePath,
        { ...hooks, interpretExports: interpretTypeScriptExports },
      );
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      const firstId = module.bindings.get('first')![0]!.def.nodeId;
      const secondId = module.bindings.get('second')![0]!.def.nodeId;
      expect(firstId).not.toBe(secondId);
      expect(result.exports).toEqual(
        new Map([
          ['first', firstId],
          ['renamed', secondId],
          ['default', firstId],
        ]),
      );
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'rejects duplicate exported names across statements in %s',
    async (filePath) => {
      const { root } = await parse(
        [
          'const first = 1; const second = 2;',
          'export { first as repeated };',
          'export { second as repeated };',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const statements = root.descendantsOfType('export_statement');
      expect(statements).toHaveLength(2);
      const captures = statements.flatMap(emitTypeScriptExportCaptures);
      expect(captures).toHaveLength(2);
      expect(() =>
        extract(
          [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root), ...captures],
          filePath,
          { ...hooks, interpretExports: interpretTypeScriptExports },
        ),
      ).toThrow();
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'maps aliases to module-local canonical definitions without changing private definitions in %s',
    async (filePath) => {
      const source = [
        'const local = 1;',
        'const privateValue = 2;',
        'function outer() { const local = 3; return local; }',
        'export { local, local as renamed, local as default };',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const matches = [
        ...emitTypeScriptLexicalScopeCaptures(root),
        ...declarations(root),
        ...root.descendantsOfType('export_statement').flatMap(emitTypeScriptExportCaptures),
      ];
      const baseline = extract(matches, filePath, hooks);
      const result = extract(matches, filePath, {
        ...hooks,
        interpretExports: interpretTypeScriptExports,
      });
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      const id = module.bindings.get('local')![0]!.def.nodeId;
      expect(result.exports).toEqual(
        new Map([
          ['local', id],
          ['renamed', id],
          ['default', id],
        ]),
      );
      const nested = result.scopes.find(
        (scope) => scope.id !== result.moduleScope && scope.bindings.has('local'),
      )!;
      expect(nested.bindings.get('local')![0]!.def.nodeId).not.toBe(id);
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
      expect(result.exports!.has('privateValue')).toBe(false);
    },
  );

  it('uses the selected canonical module var binding after repeated declarations', async () => {
    const { root } = await parse('var local = 1; var local = 2; export { local as renamed };');
    expect(root.hasError).toBe(false);
    const result = extract(
      [
        ...emitTypeScriptLexicalScopeCaptures(root),
        ...declarations(root),
        ...root.descendantsOfType('export_statement').flatMap(emitTypeScriptExportCaptures),
      ],
      'fixture.ts',
      { ...hooks, interpretExports: interpretTypeScriptExports },
    );
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    expect(module.bindings.get('local')).toHaveLength(1);
    expect(result.localDefs).toHaveLength(2);
    expect(result.exports).toEqual(
      new Map([['renamed', module.bindings.get('local')![0]!.def.nodeId]]),
    );
  });

  it('detaches plain deterministic captures and interprets JSON data after parser reuse', async () => {
    const { parser, root } = await parse('/* 😀 */ const café = 1; export { café as λ };');
    expect(root.hasError).toBe(false);
    const statement = root.descendantsOfType('export_statement')[0]!;
    const first = emitTypeScriptExportCaptures(statement);
    const second = emitTypeScriptExportCaptures(statement);
    const serialized = JSON.stringify(first);
    const inputs = [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)];
    expect(first).toEqual(second);
    expect(first).toEqual(JSON.parse(serialized));
    const local = statement.descendantsOfType('identifier').find((node) => node.text === 'café')!;
    expect(first[0]!['@export.local']!.range).toEqual(rangeOf(local));
    for (const [key, capture] of Object.entries(first[0]!)) {
      expect(Object.getPrototypeOf(capture)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(capture.range)).toBe(Object.prototype);
      expect(capture).not.toBe(second[0]![key]);
      expect(capture.range).not.toBe(second[0]![key]!.range);
    }
    parser.parse('class Replacement {}');
    expect(JSON.stringify(first)).toBe(serialized);
    const result = extract([...inputs, ...JSON.parse(serialized)], 'fixture.ts', {
      ...hooks,
      interpretExports: interpretTypeScriptExports,
    });
    expect(result.exports).toEqual(new Map([['λ', result.localDefs[0]!.nodeId]]));
    (first[0]!['@export.local']!.range as { startLine: number }).startLine = 99;
    expect(JSON.stringify(second)).toBe(serialized);
  });

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'preserves an explicitly empty export map in %s',
    async (filePath) => {
      const { root } = await parse('const privateValue = 1; export {};', filePath);
      expect(root.hasError).toBe(false);
      expect(emitTypeScriptExportCaptures(root.descendantsOfType('export_statement')[0]!)).toEqual(
        [],
      );
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)],
        filePath,
        {
          ...hooks,
          interpretExports: interpretTypeScriptExports,
        },
      );
      expect(result.exports).toEqual(new Map());
      expect(result.localDefs).toHaveLength(1);
    },
  );

  it.each([
    'export type { Local };',
    'export { Local, type OnlyType };',
    'export { type OnlyType as Renamed };',
    'export { local as "quoted" };',
    'export { "quoted" as local };',
    'export const local = 1;',
    'export function local() {}',
    'export class Local {}',
    'export default local;',
    'export default function local() {}',
    'export * from "./other";',
    'export * as ns from "./other";',
    'export { local } from "./other";',
    'export { local } from "./other" with { type: "json" };',
    'export { local } from "./other" assert { type: "json" };',
    String.raw`export { l\u006fcal };`,
    String.raw`export { local as al\u0069as };`,
    'export { local as };',
    'export { local;',
  ])('rejects the entire unsupported statement: %s', async (source) => {
    const { root } = await parse(source);
    expect(root.namedChildren.length).toBeGreaterThan(0);
    expect(() => emitTypeScriptExportCaptures(root.namedChildren[0]!)).toThrow();
  });

  it('rejects roots, nested identifiers and nonprogram export parents', async () => {
    const { root } = await parse('export { local };');
    expect(() => emitTypeScriptExportCaptures(root)).toThrow();
    expect(() => emitTypeScriptExportCaptures(root.descendantsOfType('identifier')[0]!)).toThrow();
    const nested = await parse('namespace Nested { export { local }; }');
    const statement = nested.root.descendantsOfType('export_statement')[0]!;
    expect(statement).toBeDefined();
    expect(() => emitTypeScriptExportCaptures(statement)).toThrow();
  });

  it('ignores unrelated captures and rejects malformed owned capture data', async () => {
    const { root } = await parse('const local = 1; export { local as renamed };');
    const context = extract(
      [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)],
      'fixture.ts',
      hooks,
    );
    expect(
      interpretTypeScriptExports([{}, ...emitTypeScriptLexicalScopeCaptures(root)], context),
    ).toEqual(new Map());
    const valid = emitTypeScriptExportCaptures(root.descendantsOfType('export_statement')[0]!)[0]!;
    for (const key of Object.keys(valid)) {
      const missing = { ...valid };
      delete missing[key];
      expect(() => interpretTypeScriptExports([missing], context)).toThrow();
      const capture = valid[key]!;
      for (const replacement of [
        { ...capture, name: '@export.wrong' },
        { ...capture, text: '' },
        { ...capture, text: 'not an identifier' },
        { ...capture, range: { ...capture.range, startLine: 0 } },
        { ...capture, range: { ...capture.range, startCol: -1 } },
        { ...capture, range: { ...capture.range, endLine: capture.range.startLine - 1 } },
      ]) {
        expect(() =>
          interpretTypeScriptExports([{ ...valid, [key]: replacement }], context),
        ).toThrow();
      }
    }
    expect(() =>
      interpretTypeScriptExports(
        [
          {
            ...valid,
            '@export.unknown': { ...valid['@export.local']!, name: '@export.unknown' },
          },
        ],
        context,
      ),
    ).toThrow();
  });

  it('rejects missing, imported, namespace, ambiguous and foreign module bindings', async () => {
    const { root } = await parse('const local = 1; export { local };');
    const context = extract(
      [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)],
      'fixture.ts',
      hooks,
    );
    const captures = emitTypeScriptExportCaptures(root.descendantsOfType('export_statement')[0]!);
    const module = context.scopes.find((scope) => scope.id === context.moduleScope)!;
    const binding = module.bindings.get('local')![0]!;
    expect(() =>
      interpretTypeScriptExports(captures, contextWithBindings(context, new Map())),
    ).toThrow();
    for (const origin of ['import', 'namespace'] as const) {
      const altered = contextWithBindings(context, new Map([['local', [{ ...binding, origin }]]]));
      expect(() => interpretTypeScriptExports(captures, altered)).toThrow();
    }
    expect(() =>
      interpretTypeScriptExports(
        captures,
        contextWithBindings(context, new Map([['local', [binding, binding]]])),
      ),
    ).toThrow();
    expect(() => interpretTypeScriptExports(captures, { ...context, localDefs: [] })).toThrow();
    expect(() =>
      interpretTypeScriptExports(
        captures,
        contextWithBindings(
          context,
          new Map([['local', [{ ...binding, def: { ...binding.def, filePath: 'foreign.ts' } }]]]),
        ),
      ),
    ).toThrow();
    const outsideModule = captures.map((match) => ({
      ...match,
      '@export.local': {
        ...match['@export.local']!,
        range: { startLine: 999, startCol: 0, endLine: 999, endCol: 5 },
      },
    }));
    expect(() => interpretTypeScriptExports(outsideModule, context)).toThrow();
    expect(() => interpretTypeScriptExports([...captures, ...captures], context)).toThrow();
  });
});
