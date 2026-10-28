import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';
import {
  selectTypeScriptLocalBindings,
  typeScriptDeclarationBindingScope,
  typeScriptDeclarationNamespace,
} from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';

const hooks = {
  bindingScopeFor: typeScriptDeclarationBindingScope,
  declarationNamespaceFor: typeScriptDeclarationNamespace,
  selectLocalBindings: selectTypeScriptLocalBindings,
};

async function captures(source: string, filePath = 'fixture.ts') {
  const parser = await createParserForLanguage(
    filePath.endsWith('.js') ? SupportedLanguages.JavaScript : SupportedLanguages.TypeScript,
    filePath,
  );
  const tree = parser.parse(source);
  expect(tree.rootNode.hasError).toBe(false);
  return emitTypeScriptCaptures(tree.rootNode);
}

describe('flat destructured parameters and bounded operators', () => {
  it.each(['fixture.ts', 'fixture.js'])(
    'binds each name while counting positional parameters in %s',
    async (filePath) => {
      const result = await captures(
        'function compare([language, counts], {a, key: b}) { return language / counts; }',
        filePath,
      );
      const parsed = extract(result, filePath, hooks);
      expect(parsed.localDefs.find((def) => def.qualifiedName === 'compare')).toMatchObject({
        parameterCount: 2,
        requiredParameterCount: 2,
      });
      const scope = parsed.scopes.find((scope) => scope.kind === 'Function')!;
      expect([...scope.bindings.keys()]).toEqual(['language', 'counts', 'a', 'b']);
      expect(parsed.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
        ['language', 'read'],
        ['counts', 'read'],
      ]);
      expect(structuredClone(result)).toEqual(result);
    },
  );

  it.each([
    'const compare = ([a], [b]) => a / b;',
    'items.map(([language, counts]) => language / counts);',
    'items.map(({a, b}) => a / b);',
    'items.map(function ({a, b}) { return a / b; });',
    'items.map(function compare({a, b}) { return a / b; });',
    'const compare = { method({a, b}) { return a / b; } };',
    'function compare([a, b]: [number, number]) { return a / b; }',
    'function compare({a, b}) { var scratch; return a / b; }',
  ])('captures flat patterns in %s', async (source) => {
    const parsed = extract(await captures(source), 'fixture.ts', hooks);
    const scope = parsed.scopes.find((scope) => scope.kind === 'Function')!;
    const names = [...scope.bindings.keys()];
    expect(names).toEqual(
      source.includes('language')
        ? ['language', 'counts']
        : source.includes('function compare(') && source.startsWith('items')
          ? ['compare', 'a', 'b']
          : source.includes('var scratch')
            ? ['a', 'b', 'scratch']
            : ['a', 'b'],
    );
    expect(
      parsed.referenceSites.filter((site) => site.kind === 'read' && site.name !== 'items'),
    ).toHaveLength(2);
  });

  it.each(['+=', '-=', '*=', '??=', '||=', '&&='])(
    'captures both sides of %s writes',
    async (operator) => {
      const parsed = extract(
        await captures(`workspaceDefs ${operator} fallback; state.value ${operator} next;`),
        'fixture.ts',
        hooks,
      );
      expect(parsed.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
        ['workspaceDefs', 'read'],
        ['workspaceDefs', 'write'],
        ['fallback', 'read'],
        ['value', 'read'],
        ['value', 'write'],
        ['state', 'read'],
        ['next', 'read'],
      ]);
    },
  );

  it('evaluates computed compound assignment operands once', async () => {
    const result = await captures('state[key] ??= fallback;');
    expect(result.filter((match) => match['@reference.read.computed'])).toHaveLength(1);
    expect(result.some((match) => match['@reference.write'])).toBe(false);
    const parsed = extract(result, 'fixture.ts', hooks);
    expect(parsed.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
      [undefined, 'read'],
      ['state', 'read'],
      ['key', 'read'],
      ['fallback', 'read'],
    ]);
  });

  it.each([
    'const f = ([[a]]) => a;',
    'const f = ([a = 1]) => a;',
    'const f = ([...a]) => a;',
    'const f = ([, a]) => a;',
    'const f = ({a: {b}}) => b;',
    'const f = ({a = 1}) => a;',
    'const f = ({...a}) => a;',
    'const f = ({[key]: a}) => a;',
    'const f = ([a], {a}) => a;',
    'function f({a} = {}) {}',
    'function f({a}) { "use strict"; }',
    'function f({a}) { let a; }',
    'items.map(async function ({a}) { return a; });',
    'items.map(function* ({a}) { return a; });',
    'state()[key] ??= fallback;',
    'state?.value ??= fallback;',
    'workspaceDefs %= fallback;',
    'workspaceDefs /= fallback;',
    'const value = (workspaceDefs ??= fallback);',
    'const value = a % b;',
  ])('fails closed for %s', async (source) => {
    await expect(captures(source)).rejects.toThrow(ScopeUnsupportedSyntaxError);
  });
});
