import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { typescriptProvider } from '../../../src/core/ingestion/languages/typescript.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';

describe('bounded class heritage and constructors', () => {
  it.each(['fixture.ts', 'fixture.tsx'])(
    'admits the complete invariant-error class in %s',
    async (filePath) => {
      const source = `export class ScopeTreeInvariantError extends Error {
      constructor(readonly invariant: 'parent-not-found' | 'duplicate-scope-id', message: string) {
        super(message);
        this.name = 'ScopeTreeInvariantError';
      }
    }`;
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
      const root = parser.parse(source).rootNode;
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const result = extract(captures, filePath, typescriptProvider);
      expect(result.localDefs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'Class', qualifiedName: 'ScopeTreeInvariantError' }),
          expect.objectContaining({
            type: 'Method',
            qualifiedName: 'ScopeTreeInvariantError.constructor',
            parameterCount: 2,
            requiredParameterCount: 2,
          }),
        ]),
      );
      expect(result.localDefs.filter((def) => def.type === 'Property')).toEqual([]);
      const constructor = result.scopes.find((scope) => scope.kind === 'Function')!;
      expect([...constructor.bindings.keys()]).toEqual(['invariant', 'message']);
      expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
        ['message', 'read'],
      ]);
      parser.parse('replacement();');
      expect(extract(JSON.parse(JSON.stringify(captures)), filePath, typescriptProvider)).toEqual(
        result,
      );
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'admits identifier heritage and ordinary constructors in %s',
    async (filePath) => {
      const parser = await createParserForLanguage(
        /\.jsx?$/.test(filePath) ? SupportedLanguages.JavaScript : SupportedLanguages.TypeScript,
        filePath,
      );
      for (const source of [
        'class Derived extends Base {}',
        'class Derived extends Error { constructor(message) { before(); super(message); this.name = finish(message); after(); } }',
        'class Plain { constructor(value) { this.value = value; } method() { work(); } }',
      ]) {
        const root = parser.parse(source).rootNode;
        expect(root.hasError, source).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, typescriptProvider);
        expect(
          result.localDefs.some((def) => def.type === 'Class'),
          source,
        ).toBe(true);
        if (source.includes('before'))
          expect(result.referenceSites.map(({ name }) => name)).toEqual([
            'before',
            'message',
            'finish',
            'message',
            'after',
          ]);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'refuses unsupported heritage and constructor forms atomically in %s',
    async (filePath) => {
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
      for (const source of [
        'class C extends factory() {}',
        'class C extends Base.Member {}',
        'class C extends Base<T> {}',
        'class C implements I {}',
        'class C extends Base implements I {}',
        'const C = class extends Base {};',
        'class C { constructor(); }',
        'declare class C { constructor(); }',
        'class C { constructor: Value; }',
        'class C { static constructor() {} }',
        'class C { constructor() {} constructor(value) {} }',
        'class C { constructor(public value: Value) {} }',
        'class C { constructor(private readonly value: Value) {} }',
        'class C { constructor(protected value: Value) {} }',
        'class C { constructor() { super(); } }',
        'class C extends Base { method() { super(); } }',
        'class C extends Base { constructor() { { super(); } } }',
        'class C extends Base { constructor() { (() => { super(); })(); } }',
        'function owner() { super(); }',
        'super();',
      ]) {
        const root = parser.parse(`before(); ${source} after();`).rootNode;
        expect(() => emitTypeScriptCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
      }
    },
  );
});
