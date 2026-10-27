import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import {
  emitTypeScriptParameterBindingCaptures,
  typeScriptConstructorDeclarationCaptures,
} from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';
import { typescriptProvider } from '../../../src/core/ingestion/languages/typescript.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';

async function parse(source: string, filePath = 'fixture.ts') {
  const parser = await createParserForLanguage(
    filePath.endsWith('.js') ? SupportedLanguages.JavaScript : SupportedLanguages.TypeScript,
    filePath,
  );
  const root = parser.parse(source).rootNode;
  expect(root.hasError).toBe(false);
  return root;
}

describe('TypeScript constructor declarations', () => {
  it('captures constructor ownership, arity and readonly parameter annotations without properties', async () => {
    const root = await parse(
      'class ScopeTreeInvariantError { constructor(readonly invariant: X, message: string) {} }',
    );
    const captures = emitTypeScriptCaptures(root);
    expect(structuredClone(captures)).toEqual(captures);
    const result = extract(captures, 'fixture.ts', typescriptProvider);
    const owner = result.localDefs.find((def) => def.type === 'Class')!;
    expect(result.localDefs.filter((def) => def.type === 'Method')).toMatchObject([
      {
        qualifiedName: 'ScopeTreeInvariantError.constructor',
        ownerId: owner.nodeId,
        parameterCount: 2,
        requiredParameterCount: 2,
      },
    ]);
    expect(result.localDefs.filter((def) => def.type === 'Property')).toEqual([]);
    const fn = result.scopes.find((scope) => scope.kind === 'Function')!;
    expect([...fn.bindings.keys()]).toEqual(['invariant', 'message']);
    expect([...fn.typeBindings.entries()].map(([name, type]) => [name, type.rawName])).toEqual([
      ['invariant', 'X'],
      ['message', 'string'],
    ]);
  });

  it.each(['fixture.ts', 'fixture.js'])(
    'captures an ordinary constructor in %s',
    async (filePath) => {
      const root = await parse('class C { constructor(value) {} }', filePath);
      const result = extract(emitTypeScriptCaptures(root), filePath, typescriptProvider);
      expect(result.localDefs.find((def) => def.type === 'Method')).toMatchObject({
        qualifiedName: 'C.constructor',
        parameterCount: 1,
        requiredParameterCount: 1,
      });
    },
  );

  it.each(['true', 'false'])('captures boolean default %s with optional arity', async (value) => {
    const root = await parse(`class C { constructor(value: X, allowEqual = ${value}) {} }`);
    const result = extract(emitTypeScriptCaptures(root), 'fixture.ts', typescriptProvider);
    expect(result.localDefs.find((def) => def.type === 'Method')).toMatchObject({
      qualifiedName: 'C.constructor',
      parameterCount: 2,
      requiredParameterCount: 1,
    });
    expect(result.referenceSites).toEqual([]);
    const functionRoot = await parse(`function use(allowEqual = ${value}) { return allowEqual; }`);
    expect(() =>
      extract(emitTypeScriptCaptures(functionRoot), 'fixture.ts', typescriptProvider),
    ).not.toThrow();
  });

  it.each([
    'public value: X',
    'private value: X',
    'protected value: X',
    'override value: X',
    'public readonly value: X',
    'override readonly value: X',
    '@decorator value: X',
    'value = false, ...rest: X[]',
  ])('refuses unsupported constructor parameters: %s', async (parameters) => {
    const root = await parse(`class C { constructor(${parameters}) {} }`);
    const constructor = root.descendantsOfType('method_definition')[0]!;
    expect(() => emitTypeScriptParameterBindingCaptures(constructor)).toThrow(
      ScopeUnsupportedSyntaxError,
    );
    expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
  });

  it.each([
    'class C { static constructor(readonly value: X) {} }',
    'class C { ["constructor"](value: X) {} }',
    'class C { method(readonly value: X) {} }',
    'const object = { constructor(readonly value: X) {} };',
  ])('refuses unsupported constructor headers and readonly hosts: %s', async (source) => {
    const root = await parse(source);
    const constructor = root.descendantsOfType('method_definition')[0]!;
    const owner = root.descendantsOfType('class_declaration')[0] ?? root;
    expect(() => typeScriptConstructorDeclarationCaptures(constructor, owner)).toThrow(
      ScopeUnsupportedSyntaxError,
    );
    expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
  });
});
