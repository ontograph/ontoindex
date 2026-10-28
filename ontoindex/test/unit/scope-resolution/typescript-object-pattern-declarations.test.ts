import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';
import { emitTypeScriptExportCapturesForFile } from '../../../src/core/ingestion/languages/typescript-export-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import {
  selectTypeScriptLocalBindings,
  typeScriptDeclarationBindingScope,
  typeScriptDeclarationNamespace,
} from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';

const filePaths = ['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'];
const hooks = {
  bindingScopeFor: typeScriptDeclarationBindingScope,
  declarationNamespaceFor: typeScriptDeclarationNamespace,
  selectLocalBindings: selectTypeScriptLocalBindings,
};

async function parse(source: string, filePath = 'fixture.ts') {
  const language = /\.jsx?$/.test(filePath)
    ? SupportedLanguages.JavaScript
    : SupportedLanguages.TypeScript;
  const parser = await createParserForLanguage(language, filePath);
  return { parser, root: parser.parse(source).rootNode };
}

describe.each(filePaths)('object-pattern declarations in %s', (filePath) => {
  it.each(['const', 'let', 'export const', 'export let'])(
    'binds shorthand, aliases and defaults at their names with %s',
    async (prefix) => {
      const source = `${prefix} { a, b: c, d = fallback, e: f = load() } = init;`;
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      const names = ['a', 'c', 'd', 'f'];
      const columns = ['a,', 'c,', 'd =', 'f ='].map((text) => source.indexOf(text));
      expect([...module.bindings.keys()]).toEqual(names);
      expect(result.localDefs).toEqual(
        names.map((name, index) => ({
          nodeId: `def:${filePath}#1:${columns[index]}:Variable:${name}`,
          filePath,
          type: 'Variable',
          qualifiedName: name,
        })),
      );
      expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
        ['init', 'read'],
        ['fallback', 'read'],
        ['load', 'call'],
      ]);
      const exported = emitTypeScriptExportCapturesForFile(root).map(
        (match) => match['@export.name']!.text,
      );
      expect(exported).toEqual(prefix.startsWith('export ') ? names : []);
    },
  );

  it('allows repeated property keys when the binding names differ', async () => {
    const { root } = await parse('const { a, a: b } = input;', filePath);
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    expect([...module.bindings.keys()]).toEqual(['a', 'b']);
    expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
      ['input', 'read'],
    ]);
  });

  it('traverses initializer and default call arguments exactly once', async () => {
    const source = 'const { a = load(fallback), key: b = other(value) } = make(input);';
    const { root } = await parse(source, filePath);
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    expect([...module.bindings.keys()]).toEqual(['a', 'b']);
    expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
      ['make', 'call'],
      ['input', 'read'],
      ['load', 'call'],
      ['fallback', 'read'],
      ['other', 'call'],
      ['value', 'read'],
    ]);
  });

  it('accepts comments, trailing commas and literal defaults without extra reads', async () => {
    const source = 'let { /* first */ a = 1, key: /* alias */ b = null, } = input;';
    const { root } = await parse(source, filePath);
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    expect([...module.bindings.keys()]).toEqual(['a', 'b']);
    expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
      ['input', 'read'],
    ]);
  });

  it.each(['const', 'let'])(
    'keeps %s object bindings in the function body scope',
    async (keyword) => {
      const source = `function owner() { ${keyword} { a = load(), key: b } = init; use(a, b); }`;
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const body = result.scopes.find((scope) => scope.kind === 'Block')!;
      expect([...body.bindings.keys()]).toEqual(['a', 'b']);
      expect(
        result.scopes
          .filter((scope) => scope.id !== body.id)
          .map((scope) => [scope.bindings.has('a'), scope.bindings.has('b')]),
      ).toEqual([
        [false, false],
        [false, false],
      ]);
      expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
        ['init', 'read'],
        ['load', 'call'],
        ['use', 'call'],
        ['a', 'read'],
        ['b', 'read'],
      ]);
      expect(result.referenceSites.every((site) => site.inScope === body.id)).toBe(true);
    },
  );

  it.each([
    'const { a, ...rest } = input;',
    'const { key: { a } } = input;',
    'const { key: [a] } = input;',
    'const { [key]: a } = input;',
    'const { "key": a } = input;',
    'const { a, key: a } = input;',
    'const { a = delete value } = input;',
    'const { key: a = delete value } = input;',
    'var { a } = input;',
    'function owner({ a = 1 }) {}',
    'for (const { a = 1 } of input) {}',
    'for (let { a = 1 } = input; ;) {}',
  ])('refuses unsupported patterns atomically: %s', async (statement) => {
    const { root } = await parse(`before(); ${statement} after();`, filePath);
    expect(root.hasError).toBe(false);
    expect(() => extract(emitTypeScriptCaptures(root), filePath, hooks)).toThrow(
      ScopeUnsupportedSyntaxError,
    );
  });
});

describe.each(['fixture.ts', 'fixture.tsx'])(
  'typed object-pattern restrictions in %s',
  (filePath) => {
    it.each([
      'const { a }: Shape = input;',
      'declare const { a }: Shape;',
      'export declare const { a }: Shape;',
    ])('refuses annotations and ambient forms atomically: %s', async (statement) => {
      const { root } = await parse(`before(); ${statement} after();`, filePath);
      expect(root.hasError).toBe(false);
      expect(() => extract(emitTypeScriptCaptures(root), filePath, hooks)).toThrow(
        ScopeUnsupportedSyntaxError,
      );
    });
  },
);
