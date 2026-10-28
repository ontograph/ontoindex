import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { typescriptProvider } from '../../../src/core/ingestion/languages/typescript.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';

describe('TypeScript function type annotations', () => {
  it.each(['fixture.ts', 'fixture.tsx'])(
    'preserves exact type text without value names in %s',
    async (filePath) => {
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
      const type =
        "(moduleScope: ScopeId, name: string, namespace?: 'type' | 'value',) => readonly SymbolDefinition[]";
      const root = parser.parse(
        `interface Output { readonly lookupExport?: ${type}; }\ntype FindExport = ${type};\ndeclare const lookup: ${type};\ndeclare const nested: Wrapper<(name: string) => Value>;`,
      ).rootNode;
      expect(root.hasError).toBe(false);
      const captures = structuredClone(emitTypeScriptCaptures(root));
      parser.parse('replacement();');
      const result = extract(captures, filePath, typescriptProvider);
      expect(result.referenceSites).toEqual([]);
      expect(
        result.scopes.flatMap((scope) =>
          [...scope.typeBindings.values()].map((binding) => binding.rawName),
        ),
      ).toEqual([type, 'Wrapper<(name: string) => Value>']);
      expect(result.localDefs.map((def) => def.qualifiedName)).toEqual([
        'Output',
        'FindExport',
        'lookup',
        'nested',
      ]);
    },
  );

  it.each([
    '<T>(name: T) => T',
    '(...args: Value[]) => Value',
    '({name}: Value) => Value',
    '(name = value) => Value',
    '(name: typeof value) => Value',
    '(name: Value) => typeof value',
  ])('refuses unsupported function type %s atomically', async (type) => {
    const parser = await createParserForLanguage(SupportedLanguages.TypeScript, 'fixture.ts');
    let captures;
    expect(() => {
      captures = emitTypeScriptCaptures(
        parser.parse(`before(); declare const value: ${type}; after();`).rootNode,
      );
    }).toThrow(ScopeUnsupportedSyntaxError);
    expect(captures).toBeUndefined();
  });
});
