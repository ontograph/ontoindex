import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';

async function captures(source: string) {
  const parser = await createParserForLanguage(SupportedLanguages.TypeScript, 'fixture.ts');
  return emitTypeScriptCaptures(parser.parse(source).rootNode);
}

describe('TypeScript computed writes', () => {
  it.each(['a[k] = value();', 'a.b[k] = value();', 'a.b[key()] = value();'])(
    'evaluates operands once without inventing an element write: %s',
    async (source) => {
      const result = await captures(source);
      const refs = result.filter((match) => match['@reference.name']);
      const names = refs.map((match) => match['@reference.name']!.text);
      expect(names).toEqual(
        source.includes('a.b')
          ? ['b', 'a', source.includes('key()') ? 'key' : 'k', 'value']
          : ['a', 'k', 'value'],
      );
      expect(
        refs.find((match) => match['@reference.name']!.text === 'value')?.['@reference.call.free'],
      ).toBeDefined();
      if (source.includes('key()')) {
        expect(
          refs.find((match) => match['@reference.name']!.text === 'key')?.['@reference.call.free'],
        ).toBeDefined();
      }
      expect(
        result.some((match) => match['@reference.write'] || match['@reference.read.computed']),
      ).toBe(false);
    },
  );

  it('captures the frozen meanings assignment shape', async () => {
    const result = await captures("meanings[0] = { def: meanings[0].def, namespace: 'both' };");
    expect(result.filter((match) => match['@reference.name']?.text === 'meanings')).toHaveLength(2);
    expect(result.filter((match) => match['@reference.name']?.text === 'def')).toHaveLength(1);
    expect(result.filter((match) => match['@reference.read.computed'])).toHaveLength(1);
    expect(result.some((match) => match['@reference.write'])).toBe(false);
  });

  it.each(['a.b[key()] += value();', 'a.b[key()] ??= value();', 'a.b[key()]++;', '++a.b[key()];'])(
    'reuses the element read once for read-modify-write: %s',
    async (source) => {
      const result = await captures(source);
      expect(result.filter((match) => match['@reference.read.computed'])).toHaveLength(1);
      expect(result.some((match) => match['@reference.write'])).toBe(false);
      for (const name of ['a', 'b', 'key']) {
        expect(result.filter((match) => match['@reference.name']?.text === name)).toHaveLength(1);
      }
      expect(result.filter((match) => match['@reference.name']?.text === 'value')).toHaveLength(
        source.includes('value()') ? 1 : 0,
      );
    },
  );

  it.each([
    'a?.[k] = value;',
    'a?.b[k] = value;',
    'a.#private[k] = value;',
    'a[k] = this;',
    '[a[k]] = value;',
    '({ key: a[k] } = value);',
    'make()[k] = value;',
    'make().b[k] = value;',
    'this[k] = value;',
    'a[k] %= value;',
  ])('refuses unsupported targets or operands: %s', async (source) => {
    await expect(captures(source)).rejects.toThrow(ScopeUnsupportedSyntaxError);
  });
});
