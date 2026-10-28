import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';

async function captures(source: string, filePath = 'fixture.ts') {
  const parser = await createParserForLanguage(
    filePath.endsWith('.js') ? SupportedLanguages.JavaScript : SupportedLanguages.TypeScript,
    filePath,
  );
  const tree = parser.parse(source);
  expect(tree.rootNode.hasError).toBe(false);
  return emitTypeScriptCaptures(tree.rootNode);
}

describe('constructor parameter defaults', () => {
  it.each(['fixture.ts', 'fixture.js'])(
    'captures the constructor and supported arguments once in %s',
    async (filePath) => {
      const result = await captures(
        'function use(now = new Date(read(seed), 1)) { return now; }',
        filePath,
      );
      const calls = result.filter(
        (match) => match['@reference.call.constructor'] || match['@reference.call.free'],
      );
      expect(
        calls.map((match) => [match['@reference.name']!.text, match['@reference.arity']!.text]),
      ).toEqual([
        ['Date', '2'],
        ['read', '1'],
      ]);
      expect(
        result.filter(
          (match) => match['@reference.read'] && match['@reference.name']?.text === 'seed',
        ),
      ).toHaveLength(1);
      expect(structuredClone(result)).toEqual(result);
      const parsed = extract(result, filePath, {});
      const constructor = parsed.referenceSites.find((site) => site.name === 'Date');
      expect(constructor).toMatchObject({ kind: 'call', callForm: 'constructor', arity: 2 });
      expect(parsed.scopes.find((scope) => scope.id === constructor!.inScope)?.kind).toBe(
        'Function',
      );
    },
  );

  it.each([
    'function use(now: Date = new Date()) { return now; }',
    'function use(now = new Date) { return now; }',
    'function* use(now = new Date()) { return now; }',
    'const use = (now = new Date()) => now;',
    'const use = { method(now = new Date()) { return now; } };',
    'class Use { method(now = new Date()) { return now; } }',
    'function use(now = new Date(/* empty */)) { return now; }',
    'function use(now = new Date(...values)) { return now; }',
  ])('supports the bounded default in %s', async (source) => {
    const result = await captures(source);
    expect(result.filter((match) => match['@reference.call.constructor'])).toHaveLength(1);
  });

  it.each([
    'function use(now = new ns.Date()) {}',
    'function use(now = new Date<string>()) {}',
    'function use(now = new Date(...values())) {}',
    'function use(now = new Date(await read())) {}',
    'function use(now = new Date()) { "use strict"; }',
    'function use(now = new Date()) { var value; }',
    'function use(now = read()) {}',
  ])('fails closed for %s', async (source) => {
    await expect(captures(source)).rejects.toThrow(ScopeUnsupportedSyntaxError);
  });
});
