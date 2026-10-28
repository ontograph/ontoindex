import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { typeScriptAnnotationType } from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { typescriptProvider } from '../../../src/core/ingestion/languages/typescript.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';

describe('parenthesized readonly TypeScript annotations', () => {
  it.each(['fixture.ts', 'fixture.tsx'])(
    'preserves grouping and opaque type-binding text in %s',
    async (filePath) => {
      const types = [
        'readonly string[]',
        '(readonly string[])[]',
        'ReadonlyArray<readonly string[]>',
        'readonly (A | B)[]',
        '(A | B)[]',
        '(A[])',
        '((readonly A[]))[]',
        '( /* inner */ readonly A[] /* end */ )[]',
        'Map<ScopeId, readonly (readonly ImportEdge[])[]>',
        '(readonly ImportEdge[])[]',
        'readonly (readonly ImportEdge[])[]',
        'ReadonlyMap<ScopeId, readonly (readonly ImportEdge[])[]>',
        '((() => A))[]',
      ];
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
      const root = parser.parse(
        types.map((type, index) => `let value${index}: ${type};`).join('\n'),
      ).rootNode;
      expect(root.hasError).toBe(false);
      expect(
        root
          .descendantsOfType('type_annotation')
          .map((annotation) => typeScriptAnnotationType(annotation).text),
      ).toEqual(types);
      const captures = structuredClone(emitTypeScriptCaptures(root));
      expect(captures.flatMap((capture) => capture['@type-binding.type']?.text ?? [])).toEqual(
        types,
      );
      parser.parse('let replacement: string;');
      const result = extract(captures, filePath, typescriptProvider);
      expect(
        result.scopes.flatMap((scope) =>
          [...scope.typeBindings.values()].map((type) => type.rawName),
        ),
      ).toEqual(types);
      expect(result.referenceSites).toEqual([]);
      expect(extract(JSON.parse(JSON.stringify(captures)), filePath, typescriptProvider)).toEqual(
        result,
      );
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'recursively refuses unsupported types inside parentheses in %s',
    async (filePath) => {
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
      for (const type of [
        '(typeof value)[]',
        'readonly (keyof A)[]',
        '(A & B)[]',
        '(readonly (A & B)[])[]',
        'ReadonlyArray<({ method(): A })>',
        '((<T>() => A))[]',
        '(readonly [A, B?])[]',
        '((unique symbol))',
      ]) {
        const root = parser.parse(`let value: ${type};`).rootNode;
        expect(root.hasError, type).toBe(false);
        const annotation = root.descendantsOfType('type_annotation')[0]!;
        expect(() => typeScriptAnnotationType(annotation), type).toThrow(
          ScopeUnsupportedSyntaxError,
        );
        expect(() => emitTypeScriptCaptures(root), type).toThrow(ScopeUnsupportedSyntaxError);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'refuses malformed parentheses atomically in %s',
    async (filePath) => {
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
      for (const type of ['(readonly A[]', 'readonly (A | B[]', '(A, B)[]', '()[]']) {
        const root = parser.parse(
          `let before: string; let value: ${type}; let after: string;`,
        ).rootNode;
        expect(() => emitTypeScriptCaptures(root), type).toThrow(ScopeUnsupportedSyntaxError);
      }
    },
  );
});
