import { describe, expect, it } from 'vitest';
import type { SyntaxNode } from 'tree-sitter';
import { SupportedLanguages, buildScopeTree } from 'ontoindex-shared';
import type { CaptureMatch, ParsedFile, Range, Scope } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import {
  emitTypeScriptCatchBindingCaptures,
  emitTypeScriptDeclarationCaptures,
  emitTypeScriptLexicalBindingCaptures,
  emitTypeScriptParameterBindingCaptures,
  emitTypeScriptVarBindingCaptures,
  emitTypeScriptVarBindingCapturesForFile,
  selectTypeScriptLocalBindings,
  typeScriptDeclarationBindingScope,
  typeScriptAnnotationType,
} from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';
import { emitTypeScriptLexicalScopeCaptures } from '../../../src/core/ingestion/languages/typescript-scope-captures.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import {
  emitTypeScriptImportCaptures,
  interpretTypeScriptImport,
} from '../../../src/core/ingestion/languages/typescript-import-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';

const nodeTypes = [
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'class_declaration',
  'abstract_class_declaration',
  'class',
];
const hooks = {
  interpretImport: interpretTypeScriptImport,
  bindingScopeFor: typeScriptDeclarationBindingScope,
  selectLocalBindings: selectTypeScriptLocalBindings,
};
const parameterOwnerTypes = [
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
];

async function parse(source: string, filePath = 'fixture.ts') {
  const language = /\.jsx?$/.test(filePath)
    ? SupportedLanguages.JavaScript
    : SupportedLanguages.TypeScript;
  const parser = await createParserForLanguage(language, filePath);
  const tree = parser.parse(source);
  return { parser, root: tree.rootNode };
}

function rangeOf(node: SyntaxNode): Range {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}

function declarationMatches(root: SyntaxNode): CaptureMatch[] {
  return root
    .descendantsOfType(nodeTypes)
    .filter((node) => node.isNamed)
    .flatMap(emitTypeScriptDeclarationCaptures);
}

function lexicalBindingMatches(root: SyntaxNode): CaptureMatch[] {
  return root
    .descendantsOfType('lexical_declaration')
    .filter((node) => node.isNamed)
    .flatMap(emitTypeScriptLexicalBindingCaptures);
}

function scopeFor(result: ParsedFile, node: SyntaxNode): Scope {
  const scope = result.scopes.find(
    (candidate) =>
      candidate.kind !== 'Module' &&
      JSON.stringify(candidate.range) === JSON.stringify(rangeOf(node)),
  );
  expect(scope).toBeDefined();
  return scope!;
}

function assertBinding(result: ParsedFile, name: string, owner: Scope, host: Scope) {
  const def = owner.ownedDefs.find((candidate) => candidate.qualifiedName === name);
  expect(def).toBeDefined();
  expect(result.localDefs).toContainEqual(def);
  expect(host.bindings.get(name)).toContainEqual({ def, origin: 'local' });
  for (const scope of result.scopes) {
    if (scope.id !== host.id) expect(scope.bindings.has(name)).toBe(false);
    if (scope.id !== owner.id) expect(scope.ownedDefs).not.toContainEqual(def);
  }
}

describe('borrowed TS/JS declaration captures', () => {
  it.each(['fixture.ts', 'fixture.tsx'])(
    'detaches exact enum anchors without class placement in %s',
    async (filePath) => {
      const { parser, root } = await parse('/* 😀 */ enum café { Ready = "ready" }', filePath);
      expect(root.hasError).toBe(false);
      const node = root.descendantsOfType('enum_declaration')[0]!;
      const name = node.childForFieldName('name')!;
      const captures = emitTypeScriptDeclarationCaptures(node);
      const fresh = emitTypeScriptDeclarationCaptures(node);
      expect(captures).toEqual([
        {
          '@declaration.enum': { name: '@declaration.enum', text: '', range: rangeOf(node) },
          '@declaration.name': { name: '@declaration.name', text: 'café', range: rangeOf(name) },
        },
      ]);
      expect(captures).toEqual(fresh);
      for (const [key, capture] of Object.entries(captures[0]!)) {
        expect(Object.keys(capture).sort()).toEqual(['name', 'range', 'text']);
        expect(capture.range).not.toBe(fresh[0]![key]!.range);
      }
      const saved = JSON.stringify(captures);
      parser.parse('class Replacement {}');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(structuredClone(captures)).toEqual(captures);
      captures[0]!['@declaration.name']!.range.startLine = 99;
      expect(JSON.stringify(fresh)).toBe(saved);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'composes declarations, lexical scopes and imports with the real %s grammar',
    async (filePath) => {
      const source = [
        "import Imported from './module';",
        'function outer(parameter) {',
        '  { function nested() {} class Nested {} }',
        '  const fn = function Internal() { return Internal; };',
        '  const cls = class InternalClass {};',
        '  const gen = function* InternalGenerator() { yield InternalGenerator; };',
        '}',
        'function* generate() { yield Imported; }',
        'class Top {}',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const matches = declarationMatches(root);
      const imports = root
        .descendantsOfType('import_statement')
        .flatMap(emitTypeScriptImportCaptures);
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...imports, ...matches],
        filePath,
        hooks,
      );
      expect(result.parsedImports).toEqual([
        {
          kind: 'alias',
          localName: 'Imported',
          importedName: 'default',
          alias: 'Imported',
          targetRaw: './module',
        },
      ]);
      expect(result.localDefs.map((def) => def.qualifiedName)).toEqual([
        'outer',
        'nested',
        'Nested',
        'Internal',
        'InternalClass',
        'InternalGenerator',
        'generate',
        'Top',
      ]);
      const tree = buildScopeTree(result.scopes);
      for (const node of root.descendantsOfType(nodeTypes).filter((node) => node.isNamed)) {
        const name = node.childForFieldName('name')!.text;
        const owner = scopeFor(result, node);
        const expression = ['function_expression', 'generator_function', 'class'].includes(
          node.type,
        );
        const host = expression ? owner : tree.getParent(owner.id)!;
        assertBinding(result, name, owner, host);
        if (name === 'nested' || name === 'Nested') expect(host.kind).toBe('Block');
      }
      expect(
        result.localDefs.some((def) =>
          ['fn', 'cls', 'gen', 'parameter'].includes(def.qualifiedName!),
        ),
      ).toBe(false);
      expect(result.scopes.find((scope) => scope.kind === 'Module')!.ownedDefs).toEqual([]);
    },
  );

  it.each(['function whole() {}', 'function* whole() {}', 'class whole {}'])(
    'binds an equal-range whole-file declaration in its Module: %s',
    async (source) => {
      const { root } = await parse(source);
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...declarationMatches(root)],
        'whole.ts',
        hooks,
      );
      const module = result.scopes.find((scope) => scope.kind === 'Module')!;
      const owner = scopeFor(result, root.namedChildren[0]!);
      expect(owner.range).toEqual(module.range);
      assertBinding(result, 'whole', owner, module);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'handles named exports and ignores anonymous expressions in %s',
    async (filePath) => {
      const source = [
        'export function exported() {}',
        'export class Exported {}',
        'export default function DefaultFunction() {}',
        'export default class DefaultClass {}',
        'const anonymous = function() {};',
        'const generator = function*() {};',
        'const cls = class {};',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...declarationMatches(root)],
        filePath,
        hooks,
      );
      expect(result.localDefs.map((def) => def.qualifiedName)).toEqual([
        'exported',
        'Exported',
        'DefaultFunction',
        'DefaultClass',
      ]);
      const module = result.scopes.find((scope) => scope.kind === 'Module')!;
      for (const node of root.descendantsOfType(nodeTypes).filter((node) => node.isNamed)) {
        const name = node.childForFieldName('name');
        if (name === null) expect(emitTypeScriptDeclarationCaptures(node)).toEqual([]);
        else assertBinding(result, name.text, scopeFor(result, node), module);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])('captures abstract classes in %s', async (filePath) => {
    const { root } = await parse('abstract class Base { abstract method(): void; }', filePath);
    expect(root.hasError).toBe(false);
    const node = root.descendantsOfType('abstract_class_declaration')[0]!;
    const result = extract(
      [...emitTypeScriptLexicalScopeCaptures(root), ...emitTypeScriptDeclarationCaptures(node)],
      filePath,
      hooks,
    );
    expect(result.localDefs).toHaveLength(1);
    assertBinding(
      result,
      'Base',
      scopeFor(result, node),
      result.scopes.find((scope) => scope.kind === 'Module')!,
    );
  });

  it('preserves native Unicode name and anchor ranges as deterministic detached data', async () => {
    const { parser, root } = await parse('/* 😀 */ function café() {}\nclass λ {}');
    expect(root.hasError).toBe(false);
    const nodes = root.descendantsOfType(nodeTypes).filter((node) => node.isNamed);
    const first = declarationMatches(root);
    const second = declarationMatches(root);
    const serialized = JSON.stringify(first);
    expect(first).toEqual(second);
    expect(first).toEqual(JSON.parse(serialized));
    for (const [index, match] of first.entries()) {
      const node = nodes[index]!;
      const name = node.childForFieldName('name')!;
      const anchorKey =
        node.type === 'class_declaration' ? '@declaration.class' : '@declaration.function';
      expect(Object.keys(match).sort()).toEqual(
        [anchorKey, '@declaration.name', '@typescript.binding_scope'].sort(),
      );
      expect(match[anchorKey]).toEqual({ name: anchorKey, text: '', range: rangeOf(node) });
      expect(match['@declaration.name']).toEqual({
        name: '@declaration.name',
        text: name.text,
        range: rangeOf(name),
      });
      expect(match['@typescript.binding_scope']).toEqual({
        name: '@typescript.binding_scope',
        text: 'parent',
        range: rangeOf(name),
      });
      for (const [key, capture] of Object.entries(match)) {
        expect(Object.keys(capture).sort()).toEqual(['name', 'range', 'text']);
        expect(Object.getPrototypeOf(capture)).toBe(Object.prototype);
        expect(capture).not.toBe(second[index]![key]);
        expect(capture.range).not.toBe(second[index]![key]!.range);
      }
    }
    parser.parse('class Replacement {}');
    expect(JSON.stringify(first)).toBe(serialized);
    first[0]!['@declaration.name']!.range.startLine = 99;
    expect(JSON.stringify(second)).toBe(serialized);
  });

  it('gives same-name declarations at distinct positions distinct definition IDs', async () => {
    const { root } = await parse('{ function repeat() {} }\n{ function repeat() {} }');
    const captures = [...emitTypeScriptLexicalScopeCaptures(root), ...declarationMatches(root)];
    const first = extract(captures, 'fixture.ts', hooks);
    const second = extract(captures, 'fixture.ts', hooks);
    expect(first.localDefs).toEqual(second.localDefs);
    expect(first.localDefs).toHaveLength(2);
    expect(new Set(first.localDefs.map((def) => def.nodeId)).size).toBe(2);
  });

  it('refuses forged callable markers', async () => {
    const { root } = await parse('const victim = 0;\nfunction outer() { const f = () => 1; }');
    const captures = [...emitTypeScriptLexicalScopeCaptures(root), ...emitTypeScriptCaptures(root)];
    const lexical = extract(emitTypeScriptLexicalScopeCaptures(root), 'fixture.ts', hooks);
    const tree = buildScopeTree(lexical.scopes);
    const callable = captures.find((match) => match['@typescript.callable_binding'])!;
    const owner = lexical.scopes.find(
      (scope) =>
        JSON.stringify(scope.range) === JSON.stringify(callable['@declaration.function']!.range),
    )!;
    expect(typeScriptDeclarationBindingScope(callable, owner, tree)).toBe(owner.parent);
    const noScope = { ...callable };
    delete noScope['@typescript.binding_scope'];
    expect(() => typeScriptDeclarationBindingScope(noScope, owner, tree)).toThrow();
    const victim = root.namedChildren[0]!.namedChildren[0]!.childForFieldName('name')!;
    const relocated = {
      ...callable,
      '@declaration.name': { ...callable['@declaration.name']!, range: rangeOf(victim) },
      '@typescript.binding_scope': {
        ...callable['@typescript.binding_scope']!,
        range: rangeOf(victim),
      },
      '@typescript.callable_binding': {
        ...callable['@typescript.callable_binding']!,
        range: {
          ...rangeOf(victim),
          endLine: callable['@declaration.function']!.range.endLine,
          endCol: callable['@declaration.function']!.range.endCol,
        },
      },
    };
    expect(() => typeScriptDeclarationBindingScope(relocated, owner, tree)).toThrow();
  });

  it('delegates unrelated matches and refuses malformed declaration metadata', async () => {
    const { root } = await parse('function complete() {}');
    const lexical = extract(emitTypeScriptLexicalScopeCaptures(root), 'fixture.ts', hooks);
    const owner = scopeFor(lexical, root.namedChildren[0]!);
    const tree = buildScopeTree(lexical.scopes);
    expect(typeScriptDeclarationBindingScope({}, owner, tree)).toBeNull();
    expect(
      typeScriptDeclarationBindingScope(emitTypeScriptLexicalScopeCaptures(root)[0]!, owner, tree),
    ).toBeNull();
    const valid = declarationMatches(root)[0]!;
    expect(typeScriptDeclarationBindingScope(valid, owner, tree)).toBe(owner.parent);
    const badText = {
      ...valid,
      '@typescript.binding_scope': { ...valid['@typescript.binding_scope']!, text: 'outermost' },
    };
    expect(() => typeScriptDeclarationBindingScope(badText, owner, tree)).toThrow();
    for (const key of ['@declaration.function', '@declaration.name']) {
      const incomplete = { ...valid };
      delete incomplete[key];
      expect(() => typeScriptDeclarationBindingScope(incomplete, owner, tree)).toThrow();
    }
    const wrongAnchor: CaptureMatch = {
      ...valid,
      '@declaration.class': { ...valid['@declaration.function']!, name: '@declaration.class' },
    };
    delete wrongAnchor['@declaration.function'];
    expect(() => typeScriptDeclarationBindingScope(wrongAnchor, owner, tree)).toThrow();
    const wrongRange = {
      ...valid,
      '@declaration.function': {
        ...valid['@declaration.function']!,
        range: { ...owner.range, endCol: owner.range.endCol - 1 },
      },
    };
    expect(() => typeScriptDeclarationBindingScope(wrongRange, owner, tree)).toThrow();
    expect(() =>
      typeScriptDeclarationBindingScope(
        valid,
        lexical.scopes.find((scope) => scope.kind === 'Module')!,
        tree,
      ),
    ).toThrow();
    expect(() => typeScriptDeclarationBindingScope(valid, owner, buildScopeTree([]))).toThrow();
    const noParent = { ...tree, getParent: () => undefined };
    expect(() => typeScriptDeclarationBindingScope(valid, owner, noParent)).toThrow();
    expect(() =>
      extract([emitTypeScriptLexicalScopeCaptures(root)[0]!, valid], 'fixture.ts', hooks),
    ).toThrow();
  });

  it.each([
    'const value = 1;',
    'function overloaded(): void;',
    String.raw`function esc\u0061ped() {}`,
    'function broken( {',
  ])('refuses unsupported or malformed input: %s', async (source) => {
    const { root } = await parse(source);
    expect(() => emitTypeScriptDeclarationCaptures(root.namedChildren[0]!)).toThrow();
    expect(() => emitTypeScriptDeclarationCaptures(root)).toThrow();
  });
});

describe('borrowed TS/JS parameter binding captures', () => {
  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches trailing empty-object defaults in every Function form in %s',
    async (filePath) => {
      const typed = /\.tsx?$/.test(filePath);
      const parameters = `required, café${typed ? ': Options' : ''} /* before */ = /* value */ { /* empty */ }, last = {}`;
      const source = [
        `function declaration(${parameters}) {}`,
        `function* generatorDeclaration(${parameters}) {}`,
        `const expression = function named(${parameters}) {};`,
        `const generatorExpression = function* namedGenerator(${parameters}) {};`,
        `const arrow = (${parameters}) => café;`,
        `const object = { method(${parameters}) {} };`,
        `class Owner { method(${parameters}) {} }`,
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError, source).toBe(false);
      const owners = root.descendantsOfType(parameterOwnerTypes).filter((node) => node.isNamed);
      expect(owners).toHaveLength(7);
      const captures = owners.flatMap(emitTypeScriptParameterBindingCaptures);
      const fresh = owners.flatMap(emitTypeScriptParameterBindingCaptures);
      const saved = JSON.stringify(captures);
      expect(captures).toEqual(fresh);
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...captures],
        filePath,
        hooks,
      );
      for (const [index, node] of owners.entries()) {
        const owner = scopeFor(result, node);
        expect(owner.kind).toBe('Function');
        expect(owner.ownedDefs.map((def) => def.qualifiedName)).toEqual([
          'required',
          'café',
          'last',
        ]);
        for (const def of owner.ownedDefs) {
          expect(owner.bindings.get(def.qualifiedName!)).toEqual([{ def, origin: 'local' }]);
          for (const scope of result.scopes.filter((scope) => scope.id !== owner.id)) {
            expect(scope.ownedDefs).not.toContainEqual(def);
            expect(scope.bindings.get(def.qualifiedName!) ?? []).not.toContainEqual({
              def,
              origin: 'local',
            });
          }
        }
        const matches = captures.slice(index * 3, index * 3 + 3);
        expect(matches.map((match) => match['@typescript.annotation']?.text)).toEqual([
          undefined,
          typed ? 'Options' : undefined,
          undefined,
        ]);
        const names = node
          .childForFieldName('parameters')!
          .descendantsOfType('identifier')
          .filter((name) => ['required', 'café', 'last'].includes(name.text));
        expect(matches.map((match) => match['@declaration.name'])).toEqual(
          names.map((name) => ({
            name: '@declaration.name',
            text: name.text,
            range: rangeOf(name),
          })),
        );
      }
      expect(result.referenceSites).toEqual([]);
      parser.parse('function replacement(other) {}');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(structuredClone(captures)).toEqual(captures);
      captures[0]!['@declaration.name']!.range.startLine = 99;
      expect(JSON.stringify(fresh)).toBe(saved);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'owns simple parameters in all six Function forms in %s',
    async (filePath) => {
      const source = [
        'function declaration(declared) { return declared; }',
        'function* generatorDeclaration(generated) { yield generated; }',
        'const expression = function named(expressed) { return expressed; };',
        'const generatorExpression = function* namedGenerator(yielded) { yield yielded; };',
        'const arrow = (arrowed) => { return arrowed; };',
        'const object = { method(methoded) { return methoded; } };',
        'const singular = singled => singled;',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const owners = root.descendantsOfType(parameterOwnerTypes).filter((node) => node.isNamed);
      expect(new Set(owners.map((node) => node.type))).toEqual(new Set(parameterOwnerTypes));
      const matches = owners.flatMap(emitTypeScriptParameterBindingCaptures);
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...matches],
        filePath,
        hooks,
      );
      expect(result.localDefs.map((def) => def.qualifiedName)).toEqual([
        'declared',
        'generated',
        'expressed',
        'yielded',
        'arrowed',
        'methoded',
        'singled',
      ]);
      for (const [index, node] of owners.entries()) {
        const owner = scopeFor(result, node);
        expect(owner.kind).toBe('Function');
        assertBinding(result, result.localDefs[index]!.qualifiedName!, owner, owner);
      }
      expect(result.referenceSites).toEqual([]);
      expect(result.scopes.every((scope) => scope.typeBindings.size === 0)).toBe(true);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'detaches deterministic typed optional Unicode parameters in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        '/* 😀 */ function typed(café: string, λ?: number) {}',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const node = root.descendantsOfType('function_declaration')[0]!;
      const parameters = node.childForFieldName('parameters')!.namedChildren;
      const names = parameters.map((parameter) => parameter.childForFieldName('pattern')!);
      const first = emitTypeScriptParameterBindingCaptures(node);
      const second = emitTypeScriptParameterBindingCaptures(node);
      const serialized = JSON.stringify(first);
      expect(first).toHaveLength(2);
      expect(first).toEqual(second);
      expect(first).toEqual(JSON.parse(serialized));
      expect(first.map((match) => match['@typescript.annotation']?.text)).toEqual([
        'string',
        'number',
      ]);
      for (const [index, match] of first.entries()) {
        const name = names[index]!;
        expect(Object.keys(match).sort()).toEqual([
          '@declaration.name',
          '@declaration.variable',
          '@typescript.annotation',
          '@typescript.binding_kind',
        ]);
        expect(match['@declaration.variable']).toEqual({
          name: '@declaration.variable',
          text: '',
          range: rangeOf(name),
        });
        expect(match['@declaration.name']).toEqual({
          name: '@declaration.name',
          text: name.text,
          range: rangeOf(name),
        });
        for (const [key, capture] of Object.entries(match)) {
          expect(Object.keys(capture).sort()).toEqual(['name', 'range', 'text']);
          expect(Object.getPrototypeOf(capture)).toBe(Object.prototype);
          expect(capture).not.toBe(second[index]![key]);
          expect(capture.range).not.toBe(second[index]![key]!.range);
        }
        expect(match['@declaration.variable']!.range).not.toBe(match['@declaration.name']!.range);
      }
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...first],
        filePath,
        hooks,
      );
      const owner = scopeFor(result, node);
      assertBinding(result, 'café', owner, owner);
      assertBinding(result, 'λ', owner, owner);
      parser.parse('function replacement(other) {}');
      expect(JSON.stringify(first)).toBe(serialized);
      first[0]!['@declaration.name']!.range.startLine = 99;
      expect(JSON.stringify(second)).toBe(serialized);
      expect(first[0]!['@declaration.variable']!.range.startLine).toBe(1);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'does not confuse a nested function var with the default parameter environment in %s',
    async (filePath) => {
      const { root } = await parse(
        'function outer(options = {}) { function inner() { var local; } }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const owner = root.descendantsOfType('function_declaration')[0]!;
      const captures = emitTypeScriptParameterBindingCaptures(owner);
      expect(captures.map((match) => match['@declaration.name']!.text)).toEqual(['options']);
    },
  );

  it('keeps same-name nested parameters distinct by definition identity', async () => {
    const { root } = await parse(
      'function outer(value) { function inner(value) { return value; } return value; }',
    );
    const owners = root.descendantsOfType('function_declaration');
    const captures = [
      ...emitTypeScriptLexicalScopeCaptures(root),
      ...owners.flatMap(emitTypeScriptParameterBindingCaptures),
    ];
    const result = extract(captures, 'fixture.ts', hooks);
    expect(result.localDefs).toEqual(extract(captures, 'fixture.ts', hooks).localDefs);
    expect(result.localDefs).toHaveLength(2);
    expect(new Set(result.localDefs.map((def) => def.nodeId)).size).toBe(2);
    for (const node of owners) {
      const owner = scopeFor(result, node);
      const def = owner.ownedDefs[0];
      expect(def).toBeDefined();
      expect(def!.qualifiedName).toBe('value');
      expect(result.localDefs).toContainEqual(def);
      expect(owner.ownedDefs).toEqual([def]);
      expect(owner.bindings.get('value')).toEqual([{ def, origin: 'local' }]);
      for (const scope of result.scopes.filter((scope) => scope.id !== owner.id)) {
        expect(scope.ownedDefs).not.toContainEqual(def);
        expect(scope.bindings.get('value') ?? []).not.toContainEqual({ def, origin: 'local' });
      }
    }
    expect(result.referenceSites).toEqual([]);
  });

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'emits no bindings for empty lists in %s',
    async (filePath) => {
      const { root } = await parse(
        'function empty() {} const arrow = () => 0; const object = { method() {} };',
        filePath,
      );
      expect(root.hasError).toBe(false);
      for (const owner of root.descendantsOfType(parameterOwnerTypes)) {
        expect(emitTypeScriptParameterBindingCaptures(owner)).toEqual([]);
      }
    },
  );

  it('keeps var for-in capture helper restricted to var declarations', async () => {
    const { root } = await parse('for (let item of items) {}');
    const loop = root.descendantsOfType('for_in_statement')[0]!;
    expect(() => emitTypeScriptVarBindingCaptures(loop)).toThrow();
  });

  it.each([
    'function fn(valid, invalid = 1) {}',
    'function fn(valid, invalid = { value: 1 }) {}',
    'function fn(valid, invalid = { ...other }) {}',
    'function fn(valid, invalid = other) {}',
    'function fn(valid, invalid = []) {}',
    'function fn(valid = {}, required) {}',
    'function fn(valid, valid = {}) {}',
    'function fn(valid, invalid? = {}) {}',
    'function fn(valid, invalid: Options = {) {}',
    'function fn(valid, ...invalid) {}',
    'function fn(valid, { invalid: { nested } }) {}',
    'function fn(valid, [[invalid]]) {}',
    'function fn(valid, valid) {}',
    'function fn(this: object, valid: string) {}',
    'class C { constructor(public valid: string) {} }',
    'class C { method(@decorator valid: string) {} }',
    String.raw`function fn(valid, esc\u0061ped) {}`,
    'function fn(valid, invalid: ) {}',
  ])('rejects an unsupported signature atomically: %s', async (source) => {
    const { root } = await parse(source);
    const owners = root.descendantsOfType(parameterOwnerTypes).filter((node) => node.isNamed);
    if (source === 'function fn(valid, invalid? = {}) {}' && owners.length === 0) {
      expect(root.hasError).toBe(true);
      expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
      return;
    }
    expect(owners.length).toBeGreaterThan(0);
    for (const owner of owners)
      expect(() => emitTypeScriptParameterBindingCaptures(owner)).toThrow();
  });

  it.each([
    'function signature(value: string): void;',
    'interface Shape { method(value: string): void; }',
    'type Callable = (value: string) => void;',
    'const value = 1;',
  ])('refuses signature-only and unrelated owners: %s', async (source) => {
    const { root } = await parse(source);
    expect(() => emitTypeScriptParameterBindingCaptures(root)).toThrow();
    expect(() => emitTypeScriptParameterBindingCaptures(root.namedChildren[0]!)).toThrow();
    for (const signature of root.descendantsOfType([
      'function_signature',
      'method_signature',
      'function_type',
      'formal_parameters',
    ])) {
      expect(() => emitTypeScriptParameterBindingCaptures(signature)).toThrow();
    }
  });
});

describe('borrowed TS/JS lexical binding captures', () => {
  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches each flat array binding at its identifier range in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        [
          '/* 😀 */ let [/* first */ café,',
          '  λ, /* trailing */] = input, ordinary = 1, [last] = other;',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const first = lexicalBindingMatches(root);
      const second = lexicalBindingMatches(root);
      const names = root
        .descendantsOfType('identifier')
        .filter((node) => ['café', 'λ', 'ordinary', 'last'].includes(node.text));
      expect(first.map((match) => match['@declaration.name']!.text)).toEqual([
        'café',
        'λ',
        'ordinary',
        'last',
      ]);
      for (const [index, name] of names.entries()) {
        expect(first[index]).toEqual({
          '@declaration.variable': {
            name: '@declaration.variable',
            text: '',
            range: rangeOf(name),
          },
          '@declaration.name': { name: '@declaration.name', text: name.text, range: rangeOf(name) },
        });
        expect(first[index]!['@declaration.variable']!.range).not.toBe(
          first[index]!['@declaration.name']!.range,
        );
        expect(first[index]!['@declaration.name']!.range).not.toBe(
          second[index]!['@declaration.name']!.range,
        );
      }
      const saved = JSON.stringify(first);
      parser.parse('const replacement = 0;');
      expect(JSON.stringify(first)).toBe(saved);
      expect(structuredClone(first)).toEqual(JSON.parse(saved));
      first[0]!['@declaration.name']!.range.startLine = 99;
      expect(JSON.stringify(second)).toBe(saved);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'refuses invalid flat array declarations atomically in %s',
    async (filePath) => {
      for (const declaration of [
        'const [] = input;',
        'let [,value] = input;',
        'const [value,,] = input;',
        'let [[value]] = input;',
        'const [{value}] = input;',
        'let [value = fallback] = input;',
        'const [...value] = input;',
        'let [value, value] = input;',
        'let [value], ordinary = 1;',
        String.raw`let [esc\u0061ped] = input;`,
        ...(/\.tsx?$/.test(filePath)
          ? ['let [value]: [A] = input;', 'const [value]: A[] = input;']
          : []),
      ]) {
        const { root } = await parse(declaration, filePath);
        let captures: CaptureMatch[] | undefined;
        expect(() => {
          captures = lexicalBindingMatches(root);
        }, declaration).toThrow(ScopeUnsupportedSyntaxError);
        expect(captures, declaration).toBeUndefined();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'composes lexical bindings, initializer scopes and imports in %s',
    async (filePath) => {
      const source = [
        "import Imported from './module';",
        'let repeat = 0, sibling = 1;',
        '{',
        '  const Imported = 2;',
        '  let repeat = 3;',
        '  { const repeat = 4; }',
        '  const f = function Inner() { return Inner; };',
        '  const C = class InnerC {};',
        '}',
        'for (let index = 0, limit = 2; index < limit; index++) { const item = index; }',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const matches = lexicalBindingMatches(root);
      const captures = [
        ...emitTypeScriptLexicalScopeCaptures(root),
        ...root
          .descendantsOfType('import_statement')
          .filter((node) => node.isNamed)
          .flatMap(emitTypeScriptImportCaptures),
        ...declarationMatches(root),
        ...matches,
      ];
      const first = extract(captures, filePath, hooks);
      const second = extract(captures, filePath, hooks);
      expect(first.localDefs).toEqual(second.localDefs);
      expect(first.parsedImports).toEqual([
        {
          kind: 'alias',
          localName: 'Imported',
          importedName: 'default',
          alias: 'Imported',
          targetRaw: './module',
        },
      ]);
      expect(first.localDefs).toHaveLength(12);
      expect(new Set(first.localDefs.map((def) => def.nodeId)).size).toBe(12);
      const module = first.scopes.find((scope) => scope.kind === 'Module')!;
      for (const statement of root
        .descendantsOfType('lexical_declaration')
        .filter((node) => node.isNamed)) {
        let hostNode = statement.parent!;
        while (!['program', 'statement_block', 'for_statement'].includes(hostNode.type))
          hostNode = hostNode.parent!;
        const host = hostNode.type === 'program' ? module : scopeFor(first, hostNode);
        for (const declarator of statement.namedChildren.filter(
          (node) => node.type === 'variable_declarator',
        )) {
          const name = declarator.childForFieldName('name')!;
          const def = host.ownedDefs.find((candidate) => candidate.qualifiedName === name.text);
          expect(def).toBeDefined();
          expect(host.ownedDefs).toContainEqual(def);
          expect(host.bindings.get(name.text)).toContainEqual({ def, origin: 'local' });
          for (const scope of first.scopes.filter((candidate) => candidate.id !== host.id)) {
            expect(scope.ownedDefs).not.toContainEqual(def);
            expect(scope.bindings.get(name.text) ?? []).not.toContainEqual({
              def,
              origin: 'local',
            });
          }
          if (name.text === 'Imported') expect(host.kind).toBe('Block');
          if (name.text === 'index' || name.text === 'limit')
            expect(host.range).toEqual(rangeOf(hostNode));
        }
      }
      expect(module.bindings.has('Imported')).toBe(false);
      expect(first.localDefs.filter((def) => def.qualifiedName === 'repeat')).toHaveLength(3);
      for (const node of root
        .descendantsOfType(['function_expression', 'class'])
        .filter((node) => node.isNamed)) {
        const owner = scopeFor(first, node);
        assertBinding(first, node.childForFieldName('name')!.text, owner, owner);
        expect(owner.bindings.has(node.type === 'class' ? 'C' : 'f')).toBe(false);
      }
      expect(first.scopes.every((scope) => scope.typeBindings.size === 0)).toBe(true);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'detaches validated annotations as metadata for the composer in %s',
    async (filePath) => {
      const { root } = await parse('let value: number; const label: string = "text";', filePath);
      expect(root.hasError).toBe(false);
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...lexicalBindingMatches(root)],
        filePath,
        hooks,
      );
      expect(result.localDefs.map((def) => def.qualifiedName)).toEqual(['value', 'label']);
      const module = result.scopes.find((scope) => scope.kind === 'Module')!;
      assertBinding(result, 'value', module, module);
      assertBinding(result, 'label', module, module);
      expect(result.scopes.every((scope) => scope.typeBindings.size === 0)).toBe(true);
      expect(
        lexicalBindingMatches(root).map((match) => match['@typescript.annotation']?.text),
      ).toEqual(['number', 'string']);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'reports exact unsupported function annotation evidence without source text in %s',
    async (filePath) => {
      const admitted = await parse('let value: () => SecretType;', filePath);
      expect(
        typeScriptAnnotationType(admitted.root.descendantsOfType('type_annotation')[0]!).text,
      ).toBe('() => SecretType');
      expect(lexicalBindingMatches(admitted.root)[0]!['@typescript.annotation']!.text).toBe(
        '() => SecretType',
      );
      const { root } = await parse('\n  let value: <T>() => SecretType;', filePath);
      expect(root.hasError).toBe(false);
      const annotation = root.descendantsOfType('type_annotation')[0]!;
      const functionType = root.descendantsOfType('function_type')[0]!;
      expect(functionType.startPosition).toEqual({ row: 1, column: 13 });
      for (const refuse of [
        () => typeScriptAnnotationType(annotation),
        () => lexicalBindingMatches(root),
      ]) {
        expect(refuse).toThrow(ScopeUnsupportedSyntaxError);
        expect(refuse).toThrowError(
          new ScopeUnsupportedSyntaxError(
            'TS/JS declaration captures require supported named syntax and an exact lexical scope [node=function_type at=2:14]',
          ),
        );
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains exact recursive composite annotation captures in %s',
    async (filePath) => {
      for (const text of [
        'A | B | null',
        'A<B>',
        'A[]',
        'readonly Models.User[]',
        'Map<string, Array<Models.User | null>>',
        'ReadonlyArray<readonly Models.User[][]>',
        'A /* preserved */ | B',
        'Map< /* argument */ string, Models.User[]>',
        '[]',
        '[A]',
        '[A,]',
        '[A, B]',
        'readonly [A, B[]]',
        'Map<string, [A, readonly [B | null, Array<A[]>]]>',
      ]) {
        const { parser, root } = await parse(`let value: ${text};`, filePath);
        expect(root.hasError, text).toBe(false);
        const annotation = root.descendantsOfType('type_annotation')[0]!;
        expect(typeScriptAnnotationType(annotation).text, text).toBe(text);
        const captures = structuredClone(lexicalBindingMatches(root));
        parser.parse('let replacement: string;');
        expect(
          captures.map((match) => match['@typescript.annotation']?.text),
          text,
        ).toEqual([text]);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'accepts lookup types as opaque annotation metadata in %s',
    async (filePath) => {
      const texts = [
        "NonNullable<FinalizeOutput['lookupExport']>",
        "LookupParams['lexicalNamespace']",
        "ReadonlySet<BindingRef['origin']>",
        "A[B['key']]",
        "A['x']['y']",
        "A /* base */ [ /* key */ 'x' ]",
        "Array<LookupParams['lexicalNamespace'] | null>",
      ];
      for (const text of texts) {
        const { parser, root } = await parse(`let value: ${text};`, filePath);
        expect(root.hasError, text).toBe(false);
        const annotation = root.descendantsOfType('type_annotation')[0]!;
        const type = typeScriptAnnotationType(annotation);
        expect(type.text, text).toBe(text);
        const captures = structuredClone(lexicalBindingMatches(root));
        expect(captures[0]!['@typescript.annotation']?.text, text).toBe(text);
        expect(captures[0]!['@typescript.annotation']?.range, text).toEqual(rangeOf(type));
        const result = extract(
          [...emitTypeScriptLexicalScopeCaptures(root), ...lexicalBindingMatches(root)],
          filePath,
          hooks,
        );
        expect(result.referenceSites, text).toEqual([]);
        expect(
          result.scopes.every((scope) => scope.typeBindings.size === 0),
          text,
        ).toBe(true);
        parser.parse('let replacement: string;');
        expect(captures[0]!['@typescript.annotation']?.text, text).toBe(text);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'rejects unsupported nested annotations through the shared validator in %s',
    async (filePath) => {
      for (const text of [
        '<T>() => A',
        '{ key(): A }',
        'typeof value',
        '[label: A, B]',
        'unique symbol',
        'Array<<T>() => A>',
        'Array<{ key(): A }>',
        'A | typeof value',
        'readonly [A, B?]',
        '[...A[]]',
        '[A, ...B[]]',
        'A & B',
        'Array<A & B>',
        'Array<+1>',
        '[<T>() => A]',
        '[{ key(): A }]',
        '[typeof value]',
        '[A & B]',
        'Array<[A?]>',
        'A[keyof B]',
        'A[typeof value]',
        'A[<T>() => B]',
        'A[{ x(): B }]',
        "{ x(): B }['x']",
      ]) {
        const { root } = await parse(`let value: ${text};`, filePath);
        expect(root.hasError, text).toBe(false);
        const annotation = root.descendantsOfType('type_annotation')[0]!;
        expect(() => typeScriptAnnotationType(annotation), text).toThrow();
        expect(() => lexicalBindingMatches(root), text).toThrow();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'rejects damaged lookup annotations atomically in %s',
    async (filePath) => {
      for (const text of ['A[', "A['key'", "A['key']]", "A[B['key']", 'A[Key, Other]']) {
        const { root } = await parse(
          `let before: string; let value: ${text}; let after: string;`,
          filePath,
        );
        expect(root.hasError, text).toBe(true);
        expect(() => emitTypeScriptCaptures(root), text).toThrow(ScopeUnsupportedSyntaxError);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'rejects damaged and sparse tuple annotations atomically in %s',
    async (filePath) => {
      for (const text of ['[,]', '[A,,B]', '[A,,]', '[A', '[A B]', '[A, B]]']) {
        const { root } = await parse(
          `let before: string; let value: ${text}; let after: string;`,
          filePath,
        );
        const annotation = root
          .descendantsOfType('type_annotation')
          .find((node) => node.text.includes('['));
        if (!root.hasError && annotation)
          expect(() => typeScriptAnnotationType(annotation), text).toThrow(
            ScopeUnsupportedSyntaxError,
          );
        expect(() => emitTypeScriptCaptures(root), text).toThrow(ScopeUnsupportedSyntaxError);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'preserves exact literal annotation metadata in %s',
    async (filePath) => {
      for (const text of [
        '"literal"',
        "'single'",
        '"escaped\\n\\u0041"',
        '""',
        '0',
        '1.5',
        '0xff',
        '1e3',
        '1n',
        '-42',
        '-1.5',
        '-0xff',
        '-1n',
        'true',
        'false',
        'null',
        'undefined',
        '"ready" | false | -1 | null',
        'Array<"literal">',
        'Map<"key", Array<true | -2 | undefined>>',
        '- /* preserved */ 42',
      ]) {
        const { parser, root } = await parse(`let value: ${text};`, filePath);
        expect(root.hasError, text).toBe(false);
        const annotation = root.descendantsOfType('type_annotation')[0]!;
        expect(typeScriptAnnotationType(annotation).text, text).toBe(text);
        const captures = structuredClone(lexicalBindingMatches(root));
        expect(Object.keys(captures[0]!).sort(), text).toEqual([
          '@declaration.name',
          '@declaration.variable',
          '@typescript.annotation',
        ]);
        parser.parse('let replacement: string;');
        expect(captures[0]!['@typescript.annotation']?.text, text).toBe(text);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'rejects damaged literal annotations atomically in %s',
    async (filePath) => {
      for (const text of [
        '"unterminated',
        '"\\uZZZZ"',
        'Array<"unterminated>',
        '-true',
        '--1',
        '-',
      ]) {
        const { root } = await parse(`let value: ${text};`, filePath);
        expect(root.hasError, text).toBe(true);
        expect(() => emitTypeScriptCaptures(root), text).toThrow(ScopeUnsupportedSyntaxError);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'rejects malformed composite annotations atomically in %s',
    async (filePath) => {
      for (const text of ['Array<>', 'Array<A,,B>', 'Array<A', 'A |', 'A[']) {
        const { root } = await parse(`let value: ${text};`, filePath);
        expect(() => lexicalBindingMatches(root), text).toThrow();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'rejects var collisions through ambient and export wrappers in %s',
    async (filePath) => {
      for (const source of [
        'declare let value: A; var value;',
        'var value; declare const value: A;',
        'export declare let value: A; var value;',
        'var value; export declare const value: A;',
        'declare const value: A; { var value; }',
      ]) {
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        expect(() => emitTypeScriptVarBindingCapturesForFile(root), source).toThrow();
      }
    },
  );

  it('detaches deterministic native Unicode identifier ranges without placement metadata', async () => {
    const { parser, root } = await parse('/* 😀 */ let café = 1, λ = 2;');
    expect(root.hasError).toBe(false);
    const names = root
      .descendantsOfType('variable_declarator')
      .filter((node) => node.isNamed)
      .map((node) => node.childForFieldName('name')!);
    const first = lexicalBindingMatches(root);
    const second = lexicalBindingMatches(root);
    const serialized = JSON.stringify(first);
    expect(first).toHaveLength(2);
    expect(first).toEqual(second);
    expect(first).toEqual(JSON.parse(serialized));
    for (const [index, match] of first.entries()) {
      const name = names[index]!;
      expect(Object.keys(match).sort()).toEqual(['@declaration.name', '@declaration.variable']);
      expect(match['@declaration.variable']).toEqual({
        name: '@declaration.variable',
        text: '',
        range: rangeOf(name),
      });
      expect(match['@declaration.name']).toEqual({
        name: '@declaration.name',
        text: name.text,
        range: rangeOf(name),
      });
      for (const [key, capture] of Object.entries(match)) {
        expect(Object.keys(capture).sort()).toEqual(['name', 'range', 'text']);
        expect(Object.getPrototypeOf(capture)).toBe(Object.prototype);
        expect(capture).not.toBe(second[index]![key]);
        expect(capture.range).not.toBe(second[index]![key]!.range);
      }
      expect(match['@declaration.variable']!.range).not.toBe(match['@declaration.name']!.range);
    }
    parser.parse('const replacement = 0;');
    expect(JSON.stringify(first)).toBe(serialized);
    first[0]!['@declaration.name']!.range.startLine = 99;
    expect(JSON.stringify(second)).toBe(serialized);
    expect(first[0]!['@declaration.variable']!.range.startLine).toBe(1);
  });

  it.each([
    'var value = 1;',
    'const { value: { nested } } = input;',
    'let [[value]] = input;',
    'const valid = 1, { invalid: { nested } } = input;',
    'let valid = 1, [[invalid]] = input;',
    'let value = ;',
    'const = 1;',
    String.raw`let esc\u0061ped = 1;`,
    'function fn(parameter) {}',
  ])('refuses unsupported statements as a whole: %s', async (source) => {
    const { root } = await parse(source);
    expect(() => emitTypeScriptLexicalBindingCaptures(root.namedChildren[0]!)).toThrow();
    expect(() => emitTypeScriptLexicalBindingCaptures(root)).toThrow();
    for (const parameters of root
      .descendantsOfType('formal_parameters')
      .filter((node) => node.isNamed)) {
      expect(() => emitTypeScriptLexicalBindingCaptures(parameters)).toThrow();
    }
  });

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches flat const for-of patterns into loop bindings in %s',
    async (filePath) => {
      for (const [pattern, names] of [
        ['[key, value]', ['key', 'value']],
        ['{ field, other: alias }', ['field', 'alias']],
        ['[/* comment */ café, λ,]', ['café', 'λ']],
        ['{ /* comment */ field, other: alias, }', ['field', 'alias']],
      ] as const) {
        const { parser, root } = await parse(
          `function run(entries) { for (const ${pattern} of entries) { let ${names[0]}; use(${names[0]}, ${names[1]}); } }`,
          filePath,
        );
        expect(root.hasError, pattern).toBe(false);
        const loop = root.descendantsOfType('for_in_statement')[0]!;
        const left = loop.childForFieldName('left')!;
        const bindingNodes = left.descendantsOfType([
          'identifier',
          'shorthand_property_identifier_pattern',
        ]);
        const captures = emitTypeScriptLexicalBindingCaptures(loop);
        const fresh = emitTypeScriptLexicalBindingCaptures(loop);
        const serialized = JSON.stringify(captures);
        expect(captures.map((match) => match['@declaration.name']!.text)).toEqual(names);
        expect(captures.map((match) => match['@declaration.name']!.range)).toEqual(
          bindingNodes.map(rangeOf),
        );
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        const loopScope = scopeFor(result, loop);
        const bodyScope = scopeFor(result, loop.childForFieldName('body')!);
        expect([...loopScope.bindings.keys()]).toEqual(names);
        expect(bodyScope.parent).toBe(loopScope.id);
        expect(bodyScope.bindings.get(names[0])![0]!.def.nodeId).not.toBe(
          loopScope.bindings.get(names[0])![0]!.def.nodeId,
        );
        expect(result.referenceSites.map((site) => site.name)).toEqual([
          'entries',
          'use',
          names[0],
          names[1],
        ]);
        const rhsSites = result.referenceSites.filter((site) => site.name === 'entries');
        expect(rhsSites).toHaveLength(1);
        expect(rhsSites[0]!.atRange).toEqual(rangeOf(loop.childForFieldName('right')!));
        parser.parse('const replacement = 0;');
        expect(JSON.stringify(captures)).toBe(serialized);
        captures[0]!['@declaration.name']!.range.startLine = 99;
        expect(JSON.stringify(fresh)).toBe(serialized);
        expect(captures[0]!['@declaration.variable']!.range.startLine).not.toBe(99);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'checks var collisions against actual flat loop binding names in %s',
    async (filePath) => {
      for (const [pattern, collisions, allowed] of [
        ['[key, value]', ['key', 'value'], ['other']],
        ['{ field, other: alias }', ['field', 'alias'], ['other', 'unrelated']],
      ] as const) {
        for (const name of [...collisions, ...allowed]) {
          const { root } = await parse(
            `function run(entries) { for (const ${pattern} of entries) { { var ${name}; } } }`,
            filePath,
          );
          expect(root.hasError).toBe(false);
          const declaration = root.descendantsOfType('variable_declaration')[0]!;
          if ((collisions as readonly string[]).includes(name)) {
            expect(() => emitTypeScriptVarBindingCaptures(declaration), name).toThrow(
              ScopeUnsupportedSyntaxError,
            );
          } else {
            expect(
              emitTypeScriptVarBindingCaptures(declaration)[0]!['@declaration.name']!.text,
            ).toBe(name);
          }
        }
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'refuses unsupported loop binding patterns atomically in %s',
    async (filePath) => {
      for (const header of [
        'const [] of entries',
        'const {} of entries',
        'const [key,, value] of entries',
        'const [,key] of entries',
        'const [key, ...value] of entries',
        'const [key = fallback] of entries',
        'const [[key]] of entries',
        'const [{key}] of entries',
        'const [key, key] of entries',
        'const {field, other: field} of entries',
        'const {field = fallback} of entries',
        'const {other: alias = fallback} of entries',
        'const {...field} of entries',
        'const {other: {field}} of entries',
        'const {[field]: alias} of entries',
        'const {"field": alias} of entries',
        'let [key, value] of entries',
        'var [key, value] of entries',
        'let {field} of entries',
        'var {field} of entries',
        'const [key, value] in entries',
        'const {field} in entries',
        'const [key, of entries',
        'const {field:} of entries',
      ]) {
        const { root } = await parse(`function run(entries) { for (${header}) {} }`, filePath);
        let captures: CaptureMatch[] | undefined;
        expect(() => {
          captures = emitTypeScriptCaptures(root);
        }, header).toThrow(ScopeUnsupportedSyntaxError);
        expect(captures, header).toBeUndefined();
        for (const loop of root.descendantsOfType('for_in_statement')) {
          expect(() => emitTypeScriptLexicalBindingCaptures(loop), header).toThrow(
            ScopeUnsupportedSyntaxError,
          );
        }
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'captures lexical loop bindings separately from body shadowing in %s',
    async (filePath) => {
      const { root } = await parse(
        'let item; for (let item of items) { let item; { let item; use(item); } } for (const key in object) { use(key); }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const loops = root.descendantsOfType('for_in_statement');
      const matches = loops.flatMap(emitTypeScriptLexicalBindingCaptures);
      expect(matches).toHaveLength(2);
      const parsed = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...lexicalBindingMatches(root), ...matches],
        filePath,
        hooks,
      );
      const [ofLoop, inLoop] = loops;
      const loopScope = scopeFor(parsed, ofLoop!);
      const bodyScope = scopeFor(parsed, ofLoop!.childForFieldName('body')!);
      expect(loopScope.parent).toBe(parsed.moduleScope);
      expect(bodyScope.parent).toBe(loopScope.id);
      expect(loopScope.bindings.get('item')).toHaveLength(1);
      expect(bodyScope.bindings.get('item')).toHaveLength(1);
      expect(loopScope.bindings.get('item')![0]!.def.nodeId).not.toBe(
        bodyScope.bindings.get('item')![0]!.def.nodeId,
      );
      const nestedBlock = ofLoop!.descendantsOfType('statement_block').at(-1)!;
      const nestedScope = scopeFor(parsed, nestedBlock);
      expect(nestedScope.bindings.get('item')![0]!.def.nodeId).not.toBe(
        loopScope.bindings.get('item')![0]!.def.nodeId,
      );
      const secondLoopScope = scopeFor(parsed, inLoop!);
      expect(secondLoopScope.bindings.get('key')).toHaveLength(1);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'keeps unbraced lexical loop bindings in loop scopes and var in its host in %s',
    async (filePath) => {
      const { root } = await parse(
        'function run(entries) { for (let item of entries) consume(item); for (const key in entries) consume(key); for (var value of entries) consume(value); }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const loops = root.descendantsOfType('for_in_statement');
      const lexicalLoops = loops.filter((loop) => loop.childForFieldName('kind')?.type !== 'var');
      const result = extract(
        [
          ...emitTypeScriptLexicalScopeCaptures(root),
          ...lexicalBindingMatches(root),
          ...lexicalLoops.flatMap(emitTypeScriptLexicalBindingCaptures),
          ...root
            .descendantsOfType('variable_declaration')
            .flatMap(emitTypeScriptVarBindingCaptures),
          ...loops
            .filter((loop) => loop.childForFieldName('kind')?.type === 'var')
            .flatMap(emitTypeScriptVarBindingCaptures),
        ],
        filePath,
        hooks,
      );
      const loopScopes = loops.map((loop) => scopeFor(result, loop));
      const functionBody = root
        .descendantsOfType('function_declaration')[0]!
        .childForFieldName('body')!;
      const functionBodyScope = scopeFor(result, functionBody);
      expect(loopScopes.map(({ parent }) => parent)).toEqual(Array(3).fill(functionBodyScope.id));
      expect(result.scopes.filter(({ kind }) => kind === 'Block')).toHaveLength(4);
      expect(loopScopes[0]!.bindings.get('item')).toHaveLength(1);
      expect(loopScopes[1]!.bindings.get('key')).toHaveLength(1);
      expect(loopScopes[2]!.bindings.has('value')).toBe(false);
      expect(
        result.scopes.find(({ kind }) => kind === 'Function')!.bindings.get('value'),
      ).toHaveLength(1);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'rejects lexical loop collisions with var declarations in %s',
    async (filePath) => {
      const { root } = await parse(
        'function run(items) { for (let item of items) { var item; } }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const declaration = root.descendantsOfType('variable_declaration')[0]!;
      expect(() => emitTypeScriptVarBindingCaptures(declaration)).toThrow();
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'hoists var loop bindings to the function scope in %s',
    async (filePath) => {
      const { root } = await parse(
        'function run(items) { for (var item of items) { use(item); } }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const result = extract(
        [
          ...emitTypeScriptLexicalScopeCaptures(root),
          ...root
            .descendantsOfType('variable_declaration')
            .flatMap(emitTypeScriptVarBindingCaptures),
          ...root.descendantsOfType('for_in_statement').flatMap(emitTypeScriptVarBindingCaptures),
        ],
        filePath,
        hooks,
      );
      const fn = scopeFor(result, root.descendantsOfType('function_declaration')[0]!);
      const loop = scopeFor(result, root.descendantsOfType('for_in_statement')[0]!);
      expect(fn.bindings.get('item')).toHaveLength(1);
      expect(loop.bindings.has('item')).toBe(false);
    },
  );
});

describe('borrowed TS/JS catch binding captures', () => {
  function catchMatches(root: SyntaxNode): CaptureMatch[] {
    if (root.hasError) throw new Error('TS/JS catch captures require a valid parse tree');
    return root.descendantsOfType('catch_clause').flatMap(emitTypeScriptCatchBindingCaptures);
  }

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'keeps nested and sibling catches distinct from outer and body bindings in %s',
    async (filePath) => {
      const { root } = await parse(
        [
          'let error;',
          'try {} catch (error) {',
          '  let local; { let error; }',
          '  try {} catch (error) {}',
          '}',
          'try {} catch (error) {}',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const matches = catchMatches(root);
      const scopes = emitTypeScriptLexicalScopeCaptures(root);
      const bindings = [...lexicalBindingMatches(root), ...matches];
      const first = extract([...scopes, ...bindings], filePath, hooks);
      const second = extract([...scopes, ...[...bindings].reverse()], filePath, hooks);
      const catches = root.descendantsOfType('catch_clause');
      expect(matches).toHaveLength(3);
      expect(first.localDefs).toHaveLength(6);
      const catchIds = catches.map((node) => {
        const owner = scopeFor(first, node);
        const body = scopeFor(first, node.childForFieldName('body')!);
        expect(owner.kind).toBe('Block');
        expect(body.parent).toBe(owner.id);
        expect(body.bindings.has('error')).toBe(false);
        expect(owner.bindings.get('error')).toHaveLength(1);
        const def = owner.bindings.get('error')![0]!.def;
        expect(owner.ownedDefs).toContainEqual(def);
        expect(first.localDefs).toContainEqual(def);
        expect(scopeFor(second, node).bindings.get('error')![0]!.def.nodeId).toBe(def.nodeId);
        return def.nodeId;
      });
      expect(new Set(catchIds).size).toBe(3);
      const module = first.scopes.find((scope) => scope.kind === 'Module')!;
      expect(module.bindings.get('error')).toHaveLength(1);
      expect(catchIds).not.toContain(module.bindings.get('error')![0]!.def.nodeId);
      expect(first.scopes.filter((scope) => scope.bindings.has('error'))).toHaveLength(5);
      expect(first.scopes.every((scope) => scope.typeBindings.size === 0)).toBe(true);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'allows import and parameter shadows and optional catch binding in %s',
    async (filePath) => {
      const { root } = await parse(
        "import error from './module'; function outer(error) { try {} catch (error) {} } try {} catch {}",
        filePath,
      );
      expect(root.hasError).toBe(false);
      const catches = root.descendantsOfType('catch_clause');
      expect(emitTypeScriptCatchBindingCaptures(catches[1]!)).toEqual([]);
      const result = extract(
        [
          ...emitTypeScriptLexicalScopeCaptures(root),
          ...root.descendantsOfType('import_statement').flatMap(emitTypeScriptImportCaptures),
          ...root
            .descendantsOfType(parameterOwnerTypes)
            .flatMap(emitTypeScriptParameterBindingCaptures),
          ...catchMatches(root),
        ],
        filePath,
        hooks,
      );
      const owner = scopeFor(result, catches[0]!);
      expect(owner.bindings.get('error')).toHaveLength(1);
      expect(result.localDefs).toHaveLength(2);
      expect(scopeFor(result, catches[1]!).ownedDefs).toEqual([]);
      expect(result.scopes.filter((scope) => scope.bindings.has('error'))).toHaveLength(2);
      expect(result.parsedImports).toHaveLength(1);
    },
  );

  it('detaches native Unicode names and independent ranges across parser reuse', async () => {
    const { parser, root } = await parse('/* 😀 */ try {} catch (café) {} try {} catch (λ) {}');
    const first = catchMatches(root);
    const second = catchMatches(root);
    const serialized = JSON.stringify(first);
    expect(first).toEqual(second);
    expect(first).toEqual(JSON.parse(serialized));
    for (const [index, node] of root.descendantsOfType('catch_clause').entries()) {
      const name = node.childForFieldName('parameter')!;
      const match = first[index]!;
      expect(Object.keys(match).sort()).toEqual(['@declaration.name', '@declaration.variable']);
      expect(match['@declaration.variable']).toEqual({
        name: '@declaration.variable',
        text: '',
        range: rangeOf(name),
      });
      expect(match['@declaration.name']).toEqual({
        name: '@declaration.name',
        text: name.text,
        range: rangeOf(name),
      });
      for (const [key, value] of Object.entries(match)) {
        expect(Object.keys(value).sort()).toEqual(['name', 'range', 'text']);
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        expect(value).not.toBe(second[index]![key]);
        expect(value.range).not.toBe(second[index]![key]!.range);
      }
    }
    parser.parse('try {} catch (replacement) {}');
    expect(JSON.stringify(first)).toBe(serialized);
    first[0]!['@declaration.name']!.range.startLine = 99;
    expect(JSON.stringify(second)).toBe(serialized);
    expect(first[0]!['@declaration.variable']!.range.startLine).toBe(1);
  });

  it.each([
    'try {} catch ({ error }) {}',
    'try {} catch ([error]) {}',
    'try {} catch (error: Error) {}',
    String.raw`try {} catch (err\u006fr) {}`,
    'try {} catch (error) { let error; }',
    'try {} catch (error) { const error = 1; }',
    'try {} catch (error) { class error {} }',
    'try {} catch (error) { function error() {} }',
    'try {} catch (error) { function* error() {} }',
    'try {} catch (error) { let valid; const { other: { nested } } = source; }',
    'try {} catch (error) { let valid; let broken = ; }',
  ])('refuses unsupported syntax or direct body conflicts atomically: %s', async (source) => {
    const { root } = await parse(source);
    const clauses = root.descendantsOfType('catch_clause');
    expect(clauses).toHaveLength(1);
    expect(() => emitTypeScriptCatchBindingCaptures(clauses[0]!)).toThrow();
    expect(() => catchMatches(root)).toThrow();
    expect(() => emitTypeScriptCatchBindingCaptures(root)).toThrow();
  });

  it('rejects an empty catch parameter when the parser produces no catch clause', async () => {
    const { root } = await parse('try {} catch () {}');
    expect(root.hasError).toBe(true);
    expect(root.descendantsOfType('catch_clause')).toHaveLength(0);
    expect(() => catchMatches(root)).toThrow();
  });

  it('refuses wrong borrowed node kinds', async () => {
    const { root } = await parse('function unrelated(error) {} try {} catch (error) {}');
    for (const node of root.descendantsOfType([
      'function_declaration',
      'statement_block',
      'identifier',
    ])) {
      expect(() => emitTypeScriptCatchBindingCaptures(node)).toThrow();
    }
  });
});

describe('borrowed TS/JS var binding captures', () => {
  function varMatches(root: SyntaxNode): CaptureMatch[] {
    return root
      .descendantsOfType(['variable_declaration', 'for_in_statement'])
      .flatMap(emitTypeScriptVarBindingCaptures);
  }

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'keeps every definition and a canonical binding across capture orders in %s',
    async (filePath) => {
      const source = [
        'var repeated = 0;',
        '{ var repeated = 1; }',
        'for (var repeated = 2; repeated < 3; repeated++) {}',
        'for (var item of items) { var item; }',
        'for (var key in object) {}',
        'function outer(repeated) {',
        '  var repeated; { var repeated; var local; }',
        '  function inner() { var repeated; var repeated; }',
        '}',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const scopes = emitTypeScriptLexicalScopeCaptures(root);
      const matches = [
        ...varMatches(root),
        ...root
          .descendantsOfType(parameterOwnerTypes)
          .flatMap(emitTypeScriptParameterBindingCaptures),
      ];
      const results = [
        matches,
        [...matches].reverse(),
        [...matches.slice(4), ...matches.slice(0, 4)],
      ].map((order) => extract([...scopes, ...order], filePath, hooks));
      for (const result of results) {
        expect(result.localDefs).toHaveLength(matches.length);
        expect(new Set(result.localDefs.map((def) => def.nodeId)).size).toBe(matches.length);
        const module = result.scopes.find((scope) => scope.kind === 'Module')!;
        expect(module.bindings.get('repeated')).toHaveLength(1);
        const first = extract([...scopes, matches[0]!], filePath, hooks).localDefs[0]!;
        expect(module.bindings.get('repeated')![0]!.def).toEqual(first);
        expect(module.bindings.get('item')).toHaveLength(1);
        expect(module.bindings.get('key')).toHaveLength(1);
        const functions = root.descendantsOfType('function_declaration');
        const outer = scopeFor(result, functions[0]!);
        const inner = scopeFor(result, functions[1]!);
        const parameter = extract([...scopes, matches.at(-1)!], filePath, hooks).localDefs[0]!;
        expect(outer.bindings.get('repeated')).toHaveLength(1);
        expect(outer.bindings.get('repeated')![0]!.def).toEqual(parameter);
        expect(outer.bindings.get('local')).toHaveLength(1);
        expect(inner.bindings.get('repeated')).toHaveLength(1);
        expect(inner.bindings.get('repeated')![0]!.def.nodeId).not.toBe(
          outer.bindings.get('repeated')![0]!.def.nodeId,
        );
      }
      const bindingIds = (result: ParsedFile) =>
        result.scopes.map((scope) => [
          scope.id,
          [...scope.bindings]
            .map(([name, refs]) => [name, refs.map((ref) => ref.def.nodeId)])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ]);
      expect(bindingIds(results[1]!)).toEqual(bindingIds(results[0]!));
      expect(bindingIds(results[2]!)).toEqual(bindingIds(results[0]!));
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'stops var at each static initialization body in %s',
    async (filePath) => {
      const { root } = await parse(
        'var value; class C { static { var value; { var value; } } static { var value; } }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...varMatches(root)],
        filePath,
        hooks,
      );
      const hosts = result.scopes.filter((scope) => scope.bindings.has('value'));
      expect(hosts.map((scope) => scope.kind).sort()).toEqual(['Block', 'Block', 'Module']);
      expect(hosts.every((scope) => scope.bindings.get('value')!.length === 1)).toBe(true);
      expect(result.localDefs).toHaveLength(4);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'keeps namespace bodies separate in %s',
    async (filePath) => {
      const { root } = await parse(
        'var value; namespace One { var value; { var value; } } namespace Two { var value; }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const matches = varMatches(root);
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...matches],
        filePath,
        hooks,
      );
      expect(result.localDefs).toHaveLength(4);
      const hosts = result.scopes.filter((scope) => scope.bindings.has('value'));
      expect(hosts.map((scope) => scope.kind).sort()).toEqual(['Block', 'Block', 'Module']);
      expect(hosts.every((scope) => scope.bindings.get('value')!.length === 1)).toBe(true);
    },
  );

  it('detaches var metadata and validates exact host ancestry', async () => {
    const { parser, root } = await parse('function outer() { { var café; } }');
    const matches = varMatches(root);
    const serialized = JSON.stringify(matches);
    expect(matches).toEqual(JSON.parse(serialized));
    const lexical = extract(emitTypeScriptLexicalScopeCaptures(root), 'fixture.ts', hooks);
    const tree = buildScopeTree(lexical.scopes);
    const inner = scopeFor(lexical, root.descendantsOfType('statement_block')[1]!);
    const host = scopeFor(lexical, root.descendantsOfType('function_declaration')[0]!);
    expect(typeScriptDeclarationBindingScope(matches[0]!, inner, tree)).toBe(host.id);
    const metadata = matches[0]!['@typescript.var_host']!;
    for (const bad of [
      { ...metadata, text: 'Namespace' },
      { ...metadata, range: { ...metadata.range, endCol: metadata.range.endCol - 1 } },
    ]) {
      expect(() =>
        typeScriptDeclarationBindingScope(
          { ...matches[0], '@typescript.var_host': bad },
          inner,
          tree,
        ),
      ).toThrow();
    }
    expect(() =>
      typeScriptDeclarationBindingScope(matches[0]!, inner, buildScopeTree([])),
    ).toThrow();
    parser.parse('var replacement;');
    expect(JSON.stringify(matches)).toBe(serialized);
    expect(matches[0]!['@declaration.name']!.range).not.toBe(
      matches[0]!['@typescript.binding_kind']!.range,
    );
  });

  it.each([
    'var valid, { invalid } = input;',
    'var [invalid] = input;',
    'for (var { invalid } of input) {}',
    'for (let value of input) {}',
    'function fn(value = 1) { var other; }',
    'function fn(...values) { var other; }',
    'function fn({value = 1}) { var other; }',
    'try {} catch (value) { var value; }',
    'try {} catch ({ value }) { var other; }',
    'const fn = function value() { var value; };',
    'function fn() { { let value; { var value; } } }',
    'for (let value of values) { var value; }',
    String.raw`var esc\u0061ped;`,
  ])('refuses unsupported declarations atomically: %s', async (source) => {
    const { root } = await parse(source);
    expect(() => varMatches(root)).toThrow();
  });

  it('ignores assignment-only loops and refuses same-host mixed declarations', async () => {
    const { root } = await parse('for (value in input) {} for (value of input) {}');
    expect(varMatches(root)).toEqual([]);
    const mixed = await parse('var value; function value() {}');
    expect(() =>
      extract(
        [
          ...emitTypeScriptLexicalScopeCaptures(mixed.root),
          ...varMatches(mixed.root),
          ...declarationMatches(mixed.root),
        ],
        'fixture.ts',
        hooks,
      ),
    ).toThrow();
  });

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'refuses exported declaration collisions in both orders in %s',
    async (filePath) => {
      for (const declaration of [
        'export const value = 1;',
        'export let value;',
        'export class value {}',
        'export function value() {}',
        'export default class value {}',
        'export default function value() {}',
      ]) {
        for (const source of [`var value; ${declaration}`, `${declaration} var value;`]) {
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          expect(
            root.descendantsOfType('export_statement')[0]!.childForFieldName('declaration'),
          ).not.toBeNull();
          expect(() => varMatches(root), source).toThrow();
          expect(() => emitTypeScriptVarBindingCapturesForFile(root), source).toThrow();
        }
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'preserves exported lexical refusal and unrelated binding parity in %s',
    async (filePath) => {
      for (const declaration of [
        'export const { other: { nested } } = input;',
        'export let [[other]] = input;',
      ]) {
        for (const source of [`var value; ${declaration}`, `${declaration} var value;`]) {
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          expect(() => varMatches(root), source).toThrow();
          expect(() => emitTypeScriptVarBindingCapturesForFile(root), source).toThrow();
        }
      }
      for (const source of [
        'var value; export const other = 1; export let another; export class Other {} export function anotherFunction() {}',
        'export const value = 1; function nested() { var value; }',
        'export class value {} export function nested() { var value; }',
        'export default function value() { var other; }',
        'var value; export { value };',
        'var value; export { other as value } from "./other";',
      ]) {
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const matches = varMatches(root);
        expect(matches, source).toHaveLength(1);
        expect(emitTypeScriptVarBindingCapturesForFile(root), source).toEqual(matches);
      }
    },
  );
});

describe('file-batch TS/JS var binding captures', () => {
  function individualMatches(root: SyntaxNode): CaptureMatch[] {
    return root
      .descendantsOfType(['variable_declaration', 'for_in_statement'])
      .flatMap(emitTypeScriptVarBindingCaptures);
  }

  // Native accessors and methods need their original receiver. Cache wrappers by
  // node ID so all parent, child, field and descendant routes share counters.
  function countNodeAccesses(root: SyntaxNode) {
    const wrappers = new Map<number, SyntaxNode>();
    const namedChildrenReads = new Map<number, number>();
    const fieldReads = new Map<string, number>();
    function wrapResult(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(wrapResult);
      if (
        value !== null &&
        typeof value === 'object' &&
        'id' in value &&
        'type' in value &&
        'childForFieldName' in value
      )
        return wrap(value as SyntaxNode);
      return value;
    }
    function wrap(node: SyntaxNode): SyntaxNode {
      const cached = wrappers.get(node.id);
      if (cached) return cached;
      const wrapper = new Proxy(node, {
        get(target, key) {
          if (key === 'namedChildren') {
            namedChildrenReads.set(target.id, (namedChildrenReads.get(target.id) ?? 0) + 1);
          }
          const value: unknown = Reflect.get(target, key, target);
          if (typeof value === 'function') {
            return (...args: unknown[]) => {
              if (key === 'childForFieldName') {
                const field = `${target.id}:${String(args[0])}`;
                fieldReads.set(field, (fieldReads.get(field) ?? 0) + 1);
              }
              return wrapResult(Reflect.apply(value, target, args));
            };
          }
          return wrapResult(value);
        },
      });
      wrappers.set(node.id, wrapper);
      return wrapper;
    }
    return { root: wrap(root), namedChildrenReads, fieldReads };
  }

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'exactly preserves individual capture order, names and hosts in %s',
    async (filePath) => {
      const { root } = await parse(
        [
          'var repeated, initialized = 1;',
          '{ var repeated; }',
          'for (var index = 0; index < 2; index++) { var repeated; }',
          'for (var item of items) { var item; }',
          'for (var key in object) {}',
          'for (assigned of items) {}',
          'function outer(parameter) {',
          '  var parameter; { var nested; }',
          '  function inner(other) { var other; var nested; }',
          '}',
          'const expression = function named(value) { var value; };',
          'const arrow = value => { var value; };',
          'const object = { method(value) { var value; } };',
          'class C { static { var repeated; { var repeated; } } static { var repeated; } }',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const expected = individualMatches(root);
      expect(expected.length).toBeGreaterThan(15);
      expect(emitTypeScriptVarBindingCapturesForFile(root)).toEqual(expected);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])('preserves namespace hosts in %s', async (filePath) => {
    const { root } = await parse(
      'var value; namespace One { var value; { var value; } } namespace Two { var value; }',
      filePath,
    );
    expect(root.hasError).toBe(false);
    expect(emitTypeScriptVarBindingCapturesForFile(root)).toEqual(individualMatches(root));
  });

  it.each([
    'function untouched(value = 1) { const { nested } = source; }',
    'function untouched(...values) {} var outside;',
    'function untouched({ value }) { const { nested } = source; } var outside;',
  ])('leaves unvisited unsupported signatures lazy: %s', async (source) => {
    const { root } = await parse(source);
    expect(root.hasError).toBe(false);
    const owner = root.descendantsOfType('function_declaration')[0]!;
    const counted = countNodeAccesses(root);
    expect(emitTypeScriptVarBindingCapturesForFile(counted.root)).toEqual(individualMatches(root));
    expect(counted.fieldReads.get(`${owner.id}:parameters`) ?? 0).toBe(0);
  });

  it.each([
    'function visited(value = 1) { var other; }',
    'function visited(...values) { var other; }',
    'function visited({ value = 1 }) { var other; }',
    'function visited() { const { unrelated: { nested } } = source; var other; }',
    'const { unrelated: { nested } } = source; var other;',
  ])('preserves refusal in a visited environment: %s', async (source) => {
    const { root } = await parse(source);
    expect(root.hasError).toBe(false);
    expect(() => individualMatches(root)).toThrow();
    expect(() => emitTypeScriptVarBindingCapturesForFile(root)).toThrow();
  });

  it.each([
    'function visited() { var first; let collision; var collision; }',
    'function visited() { var first; function collision() {} var collision; }',
    'const expression = function collision() { var first; var collision; };',
    'try {} catch (collision) { var first; var collision; }',
    'for (let collision of values) { var first; var collision; }',
  ])('checks later names after filling an environment cache: %s', async (source) => {
    const { root } = await parse(source);
    expect(root.hasError).toBe(false);
    expect(() => individualMatches(root)).toThrow();
    expect(() => emitTypeScriptVarBindingCapturesForFile(root)).toThrow();
  });

  it.each([16, 64])(
    'scans a shared block and validates its signature once for %i sibling vars',
    async (count) => {
      const { root } = await parse(
        `function shared(parameter) { ${Array.from(
          { length: count },
          (_, index) => `var value${index};`,
        ).join(' ')} }`,
      );
      expect(root.hasError).toBe(false);
      const owner = root.descendantsOfType('function_declaration')[0]!;
      const body = owner.childForFieldName('body')!;
      const counted = countNodeAccesses(root);
      expect(emitTypeScriptVarBindingCapturesForFile(counted.root)).toEqual(
        individualMatches(root),
      );
      expect(counted.namedChildrenReads.get(body.id)).toBe(1);
      expect(counted.fieldReads.get(`${owner.id}:parameters`)).toBe(1);
    },
  );

  it('revalidates the same borrowed root on separate calls and detaches each result', async () => {
    const { root } = await parse('function shared(parameter) { var first; var second; }');
    const owner = root.descendantsOfType('function_declaration')[0]!;
    const body = owner.childForFieldName('body')!;
    const counted = countNodeAccesses(root);
    const first = emitTypeScriptVarBindingCapturesForFile(counted.root);
    const second = emitTypeScriptVarBindingCapturesForFile(counted.root);
    expect(first).toEqual(individualMatches(root));
    expect(second).toEqual(first);
    expect(counted.namedChildrenReads.get(body.id)).toBe(2);
    expect(counted.fieldReads.get(`${owner.id}:parameters`)).toBe(2);
    first[0]!['@declaration.name']!.range.startLine = 99;
    expect(second).toEqual(individualMatches(root));
  });

  it('refuses a non-program root', async () => {
    const { root } = await parse('function nested() { var value; }');
    expect(() => emitTypeScriptVarBindingCapturesForFile(root.namedChildren[0]!)).toThrow();
    expect(() =>
      emitTypeScriptVarBindingCapturesForFile(root.descendantsOfType('statement_block')[0]!),
    ).toThrow();
  });
});
