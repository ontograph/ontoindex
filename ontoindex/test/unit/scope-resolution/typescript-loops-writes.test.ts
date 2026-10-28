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

async function captures(source: string) {
  const parser = await createParserForLanguage(SupportedLanguages.TypeScript, 'fixture.ts');
  const root = parser.parse(source).rootNode;
  return emitTypeScriptCaptures(root);
}

describe('TypeScript loops and writes', () => {
  it('visits loop headers once and retains lexical versus var binding hosts', async () => {
    const result = await captures(
      'function owner() { for (let i = start; i < end; i++) { use(i); if (ready) break; } for (var j = 0; j < end; j += step) {} while (true) { j++; break; } do { j--; continue; } while (ready); }',
    );
    const names = result
      .filter((match) => match['@reference.name'])
      .map((match) => [
        match['@reference.name']!.text,
        Object.keys(match).find((key) => /^@reference\.(read|write|call)$/.test(key)),
      ]);
    expect(names.filter(([name]) => name === 'start')).toHaveLength(1);
    expect(names.filter(([name]) => name === 'step')).toHaveLength(1);
    expect(
      names.filter(([name, kind]) => name === 'i' && kind === '@reference.write'),
    ).toHaveLength(1);
    expect(result.filter((match) => match['@scope.block'])).toHaveLength(7);
    expect(result.filter((match) => match['@declaration.name']?.text === 'i')).toHaveLength(1);
    expect(result.filter((match) => match['@declaration.name']?.text === 'j')).toHaveLength(1);
    const model = extract(result, 'fixture.ts', {
      bindingScopeFor: typeScriptDeclarationBindingScope,
      declarationNamespaceFor: typeScriptDeclarationNamespace,
      selectLocalBindings: selectTypeScriptLocalBindings,
    });
    const owner = model.scopes.find((scope) => scope.kind === 'Function')!;
    expect(owner.bindings.has('j')).toBe(true);
    expect(owner.bindings.has('i')).toBe(false);
    expect(model.scopes.some((scope) => scope.kind === 'Block' && scope.bindings.has('i'))).toBe(
      true,
    );
  });

  it('emits named member writes without reading the terminal on simple assignment', async () => {
    const result = await captures('a.b.c = rhs; a.b.c += rhs; a.b.c++; outer(value = new Map());');
    const refs = result.filter((match) => match['@reference.name']);
    expect(refs.filter((match) => match['@reference.name']!.text === 'a')).toHaveLength(3);
    expect(refs.filter((match) => match['@reference.name']!.text === 'rhs')).toHaveLength(2);
    expect(
      refs.filter((match) => match['@reference.name']!.text === 'c' && match['@reference.write']),
    ).toHaveLength(3);
    expect(
      refs.filter((match) => match['@reference.name']!.text === 'c' && match['@reference.read']),
    ).toHaveLength(2);
    expect(
      refs.find((match) => match['@reference.name']!.text === 'c')?.['@reference.receiver']
        ?.receiver,
    ).toMatchObject({ kind: 'chain', root: { name: 'a' }, steps: [{ kind: 'member', name: 'b' }] });
    expect(
      refs.filter(
        (match) => match['@reference.name']!.text === 'value' && match['@reference.write'],
      ),
    ).toHaveLength(1);
    const model = extract(result, 'fixture.ts', {});
    expect(
      model.referenceSites.filter((site) => site.name === 'c' && site.kind === 'write'),
    ).toHaveLength(3);
  });

  it.each([
    'break;',
    'continue;',
    'while (true) { break label; }',
    'for (;;) { continue label; }',
    'for (let i = 0; i < end; i++) { var i; }',
    'for (let i = 0, i = 1;;) {}',
    'a?.b = rhs;',
    'make().b = rhs;',
    'a.b %= rhs;',
    'outer(value = (() => { return this; }));',
    'for (let i = 0; i < end; i++) { function nested() { break; } }',
  ])('refuses unsupported or invalid writes and transfers: %s', async (source) => {
    await expect(captures(source)).rejects.toThrow(ScopeUnsupportedSyntaxError);
  });

  it.each([
    'for (;;) { break; }',
    'for (i = 0; test(); i--) use(i);',
    'for (;ready;) { continue; }',
  ])('accepts empty and expression headers: %s', async (source) => {
    await expect(captures(source)).resolves.toBeInstanceOf(Array);
  });
});
