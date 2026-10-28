import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { getProvider } from '../../../src/core/ingestion/languages/index.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';
import { resolveReferences } from '../../../src/core/ingestion/resolve-references.js';

async function parsed(source: string, filePath = 'fixture.ts') {
  const language = filePath.endsWith('.js')
    ? SupportedLanguages.JavaScript
    : SupportedLanguages.TypeScript;
  const parser = await createParserForLanguage(language, filePath);
  const root = parser.parse(source).rootNode;
  expect(root.hasError).toBe(false);
  return extract(emitTypeScriptCaptures(root), filePath, getProvider(language));
}

describe('TypeScript callable lexical definitions', () => {
  it.each([
    ['annotated arrow', 'const f: (x: number) => number = x => x;'],
    ['destructured parameter', 'const f = ({x}: {x: number}) => x;'],
    ['exported arrow', 'export const f = (x: number) => x;'],
    ['async arrow', 'const f = async x => x;'],
  ])('resolves caller to one Function for %s', async (_label, declaration) => {
    const result = await parsed(`${declaration} function caller() { f(1); }`);
    const definitions = result.localDefs.filter((def) => def.qualifiedName === 'f');
    expect(definitions).toEqual([expect.objectContaining({ type: 'Function', parameterCount: 1 })]);
    const def = definitions[0]!;
    expect(
      result.scopes.find((scope) => scope.id === result.moduleScope)!.bindings.get('f'),
    ).toEqual([expect.objectContaining({ def })]);
    const references = [
      ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
    ].flat();
    expect(references.filter((ref) => ref.kind === 'call')).toEqual([
      expect.objectContaining({ kind: 'call', toDef: def.nodeId }),
    ]);
  });

  it.each([
    'class C { method() { const f = (x: number) => x; f(1); } }',
    '{ const f = (x: number) => x; f(1); }',
  ])('keeps a nested callable inside its lexical scope: %s', async (declaration) => {
    const result = await parsed(`${declaration} function caller() { f(1); }`);
    const definitions = result.localDefs.filter((def) => def.qualifiedName === 'f');
    expect(definitions).toEqual([expect.objectContaining({ type: 'Function', parameterCount: 1 })]);
    const references = [
      ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
    ].flat();
    expect(references.filter((ref) => ref.kind === 'call')).toEqual([
      expect.objectContaining({ kind: 'call', toDef: definitions[0]!.nodeId }),
    ]);
  });

  it('keeps an annotated named function expression self-name private', async () => {
    const result = await parsed(
      'const f: Function = function inner(x) { return inner(x); }; function caller() { f(1); inner(1); }',
    );
    const f = result.localDefs.filter((def) => def.qualifiedName === 'f');
    const inner = result.localDefs.filter((def) => def.qualifiedName === 'inner');
    expect(f).toEqual([expect.objectContaining({ type: 'Function', parameterCount: 1 })]);
    expect(inner).toEqual([expect.objectContaining({ type: 'Function', parameterCount: 1 })]);
    const references = [
      ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
    ].flat();
    const calls = references.filter((ref) => ref.kind === 'call');
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'call', toDef: f[0]!.nodeId }),
        expect.objectContaining({ kind: 'call', toDef: inner[0]!.nodeId }),
      ]),
    );
    expect(calls).toHaveLength(2);
  });

  it.each(['const f = <T>(x: T): T => x;', 'namespace N { const f = (x: number) => x; }'])(
    'atomically refuses unsupported callable syntax: %s',
    async (source) => {
      // Generic arrows and namespaces currently fall outside the supported subset.
      await expect(parsed(`${source} function caller() { f(); }`)).rejects.toThrow(
        'TS/JS captures require the supported module subset',
      );
    },
  );

  it('keeps a declared callable as a Variable without an implementation', async () => {
    // Ambient callable declarations currently extract as Variables and produce no call edge.
    const result = await parsed('declare const f: () => void; function caller() { f(); }');
    expect(result.localDefs.filter((def) => def.qualifiedName === 'f')).toEqual([
      expect.objectContaining({ type: 'Variable' }),
    ]);
    const references = [
      ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
    ].flat();
    expect(references.filter((ref) => ref.kind === 'call')).toEqual([]);
  });

  it.each([
    ['fixture.ts', '(x: number, y?: number) => x', 2, 1],
    ['fixture.ts', 'function (x: number, y = true) { return x; }', 2, 1],
    ['fixture.js', 'x => x', 1, 1],
    ['fixture.js', 'function (x) { return x; }', 1, 1],
  ] as const)(
    'defines and resolves a const callable in %s: %s',
    async (path, initializer, count, required) => {
      const result = await parsed(`const f = ${initializer}; function caller() { f(1); }`, path);
      const definitions = result.localDefs.filter((def) => def.qualifiedName === 'f');
      expect(definitions).toHaveLength(1);
      const def = definitions[0]!;
      expect(def).toMatchObject({
        type: 'Function',
        parameterCount: count,
        requiredParameterCount: required,
      });
      expect(
        result.scopes.find((scope) => scope.id === result.moduleScope)!.bindings.get('f'),
      ).toEqual([expect.objectContaining({ def })]);
      expect(result.scopes.filter((scope) => scope.ownerDefId === def.nodeId)).toHaveLength(1);
      const references = [
        ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
      ].flat();
      expect(references).toContainEqual(
        expect.objectContaining({ kind: 'call', toDef: def.nodeId }),
      );
    },
  );

  it.each([
    'const f: any = (a: number) => a; function caller() { f(1); }',
    'type F = (a: number) => number; const f: F = (a, b) => a;',
    'function outer() { const f: Function = (a: number): number => a; return f(1); }',
  ])('keeps a type-annotated const callable extractable: %s', async (source) => {
    const result = await parsed(source);
    const def = result.localDefs.find((item) => item.qualifiedName === 'f')!;
    expect(def).toMatchObject({ type: 'Function' });
    expect(result.scopes.some((scope) => scope.typeBindings.has('f'))).toBe(true);
  });

  it('preserves a named expression private self-name without ambiguous scope ownership', async () => {
    const result = await parsed(
      'const f = function inner(x) { return inner(x); }; function caller() { f(1); }',
    );
    const f = result.localDefs.find((def) => def.qualifiedName === 'f')!;
    const inner = result.localDefs.find((def) => def.qualifiedName === 'inner')!;
    expect(f.type).toBe('Function');
    expect(inner.type).toBe('Function');
    expect(result.scopes.filter((scope) => scope.ownerDefId === inner.nodeId)).toHaveLength(1);
    const references = [
      ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
    ].flat();
    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'call', toDef: f.nodeId }),
        expect.objectContaining({ kind: 'call', toDef: inner.nodeId }),
      ]),
    );
  });

  it('keeps a noncallable inner binding as a shadow', async () => {
    const result = await parsed('const f = (x) => x; function caller() { const f = 2; f(1); }');
    const references = [
      ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
    ].flat();
    expect(references.filter((ref) => ref.kind === 'call')).toEqual([]);
  });

  it.each(['let', 'var'])('keeps reassignable %s initializers as Variables', async (kind) => {
    const result = await parsed(`${kind} f = () => 1; f = 2; function caller() { f(1); }`);
    expect(result.localDefs.filter((def) => def.qualifiedName === 'f')).toEqual([
      expect.objectContaining({ type: 'Variable' }),
    ]);
    const references = [
      ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
    ].flat();
    expect(references.filter((ref) => ref.kind === 'call')).toEqual([]);
  });
});
