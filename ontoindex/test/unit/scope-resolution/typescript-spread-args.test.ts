import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { typescriptProvider } from '../../../src/core/ingestion/languages/typescript.js';
import { countCallArguments } from '../../../src/core/ingestion/utils/call-analysis.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';

describe('TypeScript spread call arguments', () => {
  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'matches legacy arity and evaluates operands once in %s',
    async (filePath) => {
      const language = /\.jsx?$/.test(filePath)
        ? SupportedLanguages.JavaScript
        : SupportedLanguages.TypeScript;
      const parser = await createParserForLanguage(language, filePath);
      const root = parser.parse(
        'before(); f(...group); edges.push(...x); target(first, ...obj.values, ...tail); new Box(...items); factory(...args).method(...values); after();',
      ).rootNode;
      expect(root.hasError).toBe(false);
      const calls = root.descendantsOfType(['call_expression', 'new_expression']);
      const captures = structuredClone(emitTypeScriptCaptures(root));
      const result = extract(captures, filePath, typescriptProvider);
      for (const call of calls) {
        const site = result.referenceSites.find(
          (site) => site.kind === 'call' && site.atRange.startCol === call.startPosition.column,
        );
        // Outer and inner receiver calls share their start; their names distinguish them.
        const name = call.childForFieldName('function') ?? call.childForFieldName('constructor');
        const calledName = name?.childForFieldName('property')?.text ?? name?.text;
        expect(
          result.referenceSites.find(
            (candidate) => candidate.kind === 'call' && candidate.name === calledName,
          )?.arity,
        ).toBe(countCallArguments(call));
        expect(site).toBeDefined();
      }
      for (const name of ['group', 'x', 'first', 'obj', 'values', 'tail', 'items', 'args']) {
        const expected = name === 'values' ? 2 : 1;
        expect(
          result.referenceSites.filter((site) => site.kind === 'read' && site.name === name),
          name,
        ).toHaveLength(expected);
      }
    },
  );

  it.each([
    'f(...make())',
    'f(...[values])',
    'f(...obj?.[key])',
    'f(...)',
    'f(...values ...other)',
  ])('refuses unsupported or malformed spreads %s atomically', async (expression) => {
    const parser = await createParserForLanguage(SupportedLanguages.TypeScript, 'fixture.ts');
    let captures;
    expect(() => {
      captures = emitTypeScriptCaptures(parser.parse(`before(); ${expression}; after();`).rootNode);
    }).toThrow(ScopeUnsupportedSyntaxError);
    expect(captures).toBeUndefined();
  });
});
