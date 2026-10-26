import { describe, expect, it } from 'vitest';
import type { SyntaxNode } from 'tree-sitter';
import { SupportedLanguages, buildScopeTree } from 'ontoindex-shared';
import type { CaptureMatch, ParsedFile, Range, Scope } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import {
  emitTypeScriptDeclarationCaptures,
  emitTypeScriptLexicalBindingCaptures,
  emitTypeScriptParameterBindingCaptures,
  emitTypeScriptVarBindingCaptures,
  emitTypeScriptVarBindingCapturesForFile,
  selectTypeScriptLocalBindings,
  typeScriptDeclarationBindingScope,
} from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';
import { emitTypeScriptLexicalScopeCaptures } from '../../../src/core/ingestion/languages/typescript-scope-captures.js';
import {
  emitTypeScriptImportCaptures,
  interpretTypeScriptImport,
} from '../../../src/core/ingestion/languages/typescript-import-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';

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
    'interface Shape {}',
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
      for (const [index, match] of first.entries()) {
        const name = names[index]!;
        expect(Object.keys(match).sort()).toEqual([
          '@declaration.name',
          '@declaration.variable',
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

  it.each([
    'function fn(valid, invalid = 1) {}',
    'function fn(valid, ...invalid) {}',
    'function fn(valid, { invalid }) {}',
    'function fn(valid, [invalid]) {}',
    'function fn(valid, valid) {}',
    'function fn(this: object, valid: string) {}',
    'class C { constructor(public valid: string) {} }',
    'class C { method(@decorator valid: string) {} }',
    String.raw`function fn(valid, esc\u0061ped) {}`,
    'function fn(valid, invalid: ) {}',
  ])('rejects an unsupported signature atomically: %s', async (source) => {
    const { root } = await parse(source);
    const owners = root.descendantsOfType(parameterOwnerTypes).filter((node) => node.isNamed);
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
    'accepts annotations without inventing type bindings in %s',
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
    'const { value } = input;',
    'let [value] = input;',
    'const valid = 1, { invalid } = input;',
    'let valid = 1, [invalid] = input;',
    'let value = ;',
    'const = 1;',
    String.raw`let esc\u0061ped = 1;`,
    'for (let value in input) {}',
    'for (const value of input) {}',
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
    'function fn({value}) { var other; }',
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
    'function visited({ value }) { var other; }',
    'function visited() { const { unrelated } = source; var other; }',
    'const { unrelated } = source; var other;',
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
