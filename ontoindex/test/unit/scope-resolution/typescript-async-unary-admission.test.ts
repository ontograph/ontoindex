import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';
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

describe.each(filePaths)('async and unary admission in %s', (filePath) => {
  it.each([
    'async function f(x) { return await g(x); }',
    'export async function f(x) { return await g(x); }',
    'class Owner { async m(x) { return await g(x); } }',
  ])('captures async declarations and awaited calls: %s', async (source) => {
    const { root } = await parse(source, filePath);
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
    expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
      ['g', 'call'],
      ['x', 'read'],
    ]);
    const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
    expect(owner).toBeDefined();
    expect([...owner.bindings.keys()]).toEqual(['x']);
  });

  it('admits an await expression statement and still refuses bare unary statements', async () => {
    const admitted = await parse('async function f(x) { await g(x); }', filePath);
    expect(() => emitTypeScriptCaptures(admitted.root)).not.toThrow();
    const refused = await parse('async function f(x) { typeof x; }', filePath);
    expect(() => emitTypeScriptCaptures(refused.root)).toThrow(ScopeUnsupportedSyntaxError);
  });

  it.each(['-', '+', '~', '!', 'typeof ', 'void '])(
    'reads the operand of unary %s exactly once',
    async (operator) => {
      const { root } = await parse(`const result = ${operator}a;`, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([['a', 'read']]);
    },
  );

  it('traverses nested await and unary operands exactly once', async () => {
    const { root } = await parse('async function f(x) { return void await g(-x); }', filePath);
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
    expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
      ['g', 'call'],
      ['x', 'read'],
    ]);
  });

  it.each([
    'delete a.b;',
    'class Owner { static async m() {} }',
    'class Owner { get x() {} }',
    'class Owner { set x(value) {} }',
    'async function* g() {}',
    'async function f(x = value) {}',
    'async function f(...args) {}',
  ])('refuses unsupported syntax atomically: %s', async (statement) => {
    const { root } = await parse(`before(); ${statement} after();`, filePath);
    expect(root.hasError).toBe(false);
    expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
  });
});

describe.each(['fixture.ts', 'fixture.tsx'])('bounded TypeScript syntax in %s', (filePath) => {
  it.each(['async function f<T>() {}', 'const x = -a as const;'])(
    'refuses unsupported syntax atomically: %s',
    async (statement) => {
      const { root } = await parse(`before(); ${statement} after();`, filePath);
      expect(root.hasError).toBe(false);
      expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
    },
  );

  it('retains negated numeric literals in const assertions', async () => {
    const { root } = await parse('const x = -1 as const;', filePath);
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
    expect(result.referenceSites).toEqual([]);
  });
});
