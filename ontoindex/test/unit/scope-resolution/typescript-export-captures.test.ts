import { describe, expect, it } from 'vitest';
import type { SyntaxNode } from 'tree-sitter';
import { SupportedLanguages } from 'ontoindex-shared';
import type { CaptureMatch, ParsedFile, Range } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import {
  emitTypeScriptExportCaptures,
  emitTypeScriptExportCapturesForFile,
  interpretTypeScriptExports,
} from '../../../src/core/ingestion/languages/typescript-export-captures.js';
import { emitTypeScriptLexicalScopeCaptures } from '../../../src/core/ingestion/languages/typescript-scope-captures.js';
import {
  emitTypeScriptDeclarationCaptures,
  emitTypeScriptLexicalBindingCaptures,
  emitTypeScriptVarBindingCapturesForFile,
  emitTypeScriptVarBindingCapturesForNodes,
  selectTypeScriptLocalBindings,
  typeScriptDeclarationBindingScope,
  typeScriptDeclarationNamespace,
} from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { interpretTypeScriptImport } from '../../../src/core/ingestion/languages/typescript-import-captures.js';

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

function declarations(root: SyntaxNode): CaptureMatch[] {
  return [
    ...root
      .descendantsOfType([
        'function_declaration',
        'generator_function_declaration',
        'class_declaration',
        'abstract_class_declaration',
        'interface_declaration',
        'type_alias_declaration',
      ])
      .filter(
        (node) =>
          !['interface_declaration', 'type_alias_declaration'].includes(node.type) ||
          node.parent?.type === 'program' ||
          (node.parent?.type === 'export_statement' && node.parent.parent?.type === 'program'),
      )
      .flatMap(emitTypeScriptDeclarationCaptures),
    ...root.descendantsOfType('lexical_declaration').flatMap(emitTypeScriptLexicalBindingCaptures),
    ...emitTypeScriptVarBindingCapturesForFile(root),
  ];
}

const hooks = {
  bindingScopeFor: typeScriptDeclarationBindingScope,
  declarationNamespaceFor: typeScriptDeclarationNamespace,
  selectLocalBindings: selectTypeScriptLocalBindings,
};

function contextWithBindings(
  context: ParsedFile,
  bindings: ParsedFile['scopes'][number]['bindings'],
) {
  return {
    ...context,
    scopes: context.scopes.map((scope) =>
      scope.id === context.moduleScope ? { ...scope, bindings } : scope,
    ),
  };
}

describe('borrowed TS/JS local export captures', () => {
  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains nominal and runtime exports in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        [
          'export type Alias = string;',
          'export interface Port { value: Alias; }',
          'export const count = 1;',
          'export function run() {}',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const statements = root.descendantsOfType('export_statement');
      const captures = emitTypeScriptExportCapturesForFile(root);
      expect(captures).toEqual(statements.flatMap(emitTypeScriptExportCaptures));
      expect(captures.map((match) => match['@export.name']!.text)).toEqual([
        'Alias',
        'Port',
        'count',
        'run',
      ]);
      const inputs = [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)];
      const serialized = JSON.stringify(captures);
      parser.parse('export const replacement = 2;');
      expect(JSON.stringify(captures)).toBe(serialized);
      const parsed = extract([...inputs, ...JSON.parse(serialized)], filePath, {
        ...hooks,
        interpretExports: interpretTypeScriptExports,
      });
      expect(parsed.localDefs.map(({ qualifiedName }) => qualifiedName)).toEqual([
        'Alias',
        'Port',
        'run',
        'count',
      ]);
      expect(parsed.exports).toEqual(
        new Map(parsed.localDefs.map((def) => [def.qualifiedName, def.nodeId])),
      );
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'rejects duplicate erased names and collisions with published names in %s',
    async (filePath) => {
      for (const [first, second] of [
        ['export type Erased = string;', 'export type Erased = number;'],
        ['export interface Erased {}', 'export interface Erased {}'],
        ['export type Erased = string;', 'export interface Erased {}'],
        ['export type Erased = string;', 'export const Erased = 1;'],
        ['export interface Erased {}', 'export function Erased() {}'],
        ['export type Erased = string;', 'const value = 1; export { value as Erased };'],
        ['export interface Erased {}', 'export { remote as Erased } from "./remote";'],
        ['export type Erased = string;', 'export type { Remote as Erased } from "./remote";'],
      ]) {
        for (const source of [`${first}\n${second}`, `${second}\n${first}`]) {
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          expect(() => emitTypeScriptExportCapturesForFile(root), source).toThrow();
        }
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'refuses default, ambient and malformed erased export declarations in %s',
    async (filePath) => {
      for (const source of [
        'export default interface Erased {}',
        'export declare interface Erased {}',
        'export declare type Erased = string;',
        'export interface Broken { field: ; }',
        'export type Broken = { field: ; };',
        'export interface Broken { field: string;',
      ]) {
        const { root } = await parse(source, filePath);
        expect(() => emitTypeScriptExportCaptures(root.namedChildren[0]!), source).toThrow();
        expect(() => emitTypeScriptExportCapturesForFile(root), source).toThrow();
      }
    },
  );

  it('rejects local export fields injected into otherwise valid reexport captures', async () => {
    const { root } = await parse('export { Value } from "./module";');
    const captures = emitTypeScriptExportCaptures(root.namedChildren[0]!);
    const context = extract(emitTypeScriptLexicalScopeCaptures(root), 'fixture.ts', hooks);
    const match = captures[0]!;
    expect(interpretTypeScriptExports(captures, context)).toEqual(new Map());
    for (const key of ['@export.local', '@export.name', '@export.unknown']) {
      const poisoned = { ...match, [key]: { ...match['@import.binding']!, name: key } };
      expect(() => interpretTypeScriptExports([poisoned], context), key).toThrow();
    }
    const poisoned = {
      ...match,
      '@export.local': { ...match['@import.binding']!, name: '@export.local' },
      '@export.name': { ...match['@import.binding']!, name: '@export.name' },
    };
    expect(() => interpretTypeScriptExports([poisoned], context)).toThrow();
  });

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches named reexports with source and published-name ranges in %s',
    async (filePath) => {
      const { parser, root } = await parse('export { café, café as λ } from "./module";', filePath);
      expect(root.hasError).toBe(false);
      const statement = root.namedChildren[0]!;
      const captures = emitTypeScriptExportCaptures(statement);
      const repeated = emitTypeScriptExportCaptures(statement);
      const source = statement.childForFieldName('source')!;
      expect(captures).toEqual(
        statement.descendantsOfType('export_specifier').map((specifier) => {
          const name = specifier.childForFieldName('name')!;
          const published = specifier.childForFieldName('alias') ?? name;
          return {
            '@import.binding': {
              name: '@import.binding',
              text: published.text,
              range: rangeOf(published),
            },
            '@import.source': { name: '@import.source', text: './module', range: rangeOf(source) },
            '@import.name': { name: '@import.name', text: name.text, range: rangeOf(name) },
            '@import.kind': { name: '@import.kind', text: 'reexport', range: rangeOf(published) },
          };
        }),
      );
      const serialized = JSON.stringify(captures);
      const lexical = emitTypeScriptLexicalScopeCaptures(root);
      for (const [index, match] of captures.entries()) {
        for (const [key, capture] of Object.entries(match)) {
          expect(Object.getPrototypeOf(capture)).toBe(Object.prototype);
          expect(Object.getPrototypeOf(capture.range)).toBe(Object.prototype);
          expect(capture).not.toBe(repeated[index]![key]);
          expect(capture.range).not.toBe(repeated[index]![key]!.range);
        }
      }
      parser.parse('export class Replacement {}');
      expect(JSON.stringify(captures)).toBe(serialized);
      const result = extract([...lexical, ...JSON.parse(serialized)], filePath, {
        ...hooks,
        interpretImport: interpretTypeScriptImport,
        interpretExports: interpretTypeScriptExports,
      });
      expect(result.parsedImports).toEqual([
        { kind: 'reexport', localName: 'café', importedName: 'café', targetRaw: './module' },
        {
          kind: 'reexport',
          localName: 'λ',
          importedName: 'café',
          alias: 'λ',
          targetRaw: './module',
        },
      ]);
      expect(result.localDefs).toEqual([]);
      expect(result.exports).toEqual(new Map());
      expect(result.scopes).toHaveLength(1);
      expect([...result.scopes[0]!.bindings]).toEqual([]);
      expect(result.referenceSites).toEqual([]);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'detaches direct enum exports to module definitions in %s',
    async (filePath) => {
      const { parser, root } = await parse('export enum Public { Ready = "ready" }', filePath);
      expect(root.hasError).toBe(false);
      const declaration = root.descendantsOfType('enum_declaration')[0]!;
      const name = declaration.childForFieldName('name')!;
      const captures = emitTypeScriptExportCapturesForFile(root);
      expect(captures).toEqual([
        {
          '@export.local': { name: '@export.local', text: 'Public', range: rangeOf(name) },
          '@export.name': { name: '@export.name', text: 'Public', range: rangeOf(name) },
        },
      ]);
      expect(captures[0]!['@export.local']!.range).not.toBe(captures[0]!['@export.name']!.range);
      const inputs = [
        ...emitTypeScriptLexicalScopeCaptures(root),
        ...emitTypeScriptDeclarationCaptures(declaration),
      ];
      const saved = JSON.stringify(captures);
      parser.parse('export class Replacement {}');
      expect(JSON.stringify(captures)).toBe(saved);
      const result = extract([...inputs, ...structuredClone(captures)], filePath, {
        ...hooks,
        interpretExports: interpretTypeScriptExports,
      });
      expect(result.localDefs).toEqual([
        {
          nodeId: `def:${filePath}#1:7:Enum:Public`,
          filePath,
          type: 'Enum',
          qualifiedName: 'Public',
        },
      ]);
      expect(result.exports).toEqual(new Map([['Public', result.localDefs[0]!.nodeId]]));
      expect(result.scopes).toHaveLength(1);
      expect(result.referenceSites).toEqual([]);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'resolves named abstract class exports to canonical bindings in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        'export abstract class Local<T> { abstract value(): T; }\n' +
          'export { Local as Renamed };\n' +
          'function outer() { abstract class Local<T> { abstract value(): T; } }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const captures = root
        .descendantsOfType('export_statement')
        .flatMap(emitTypeScriptExportCaptures);
      expect(emitTypeScriptExportCapturesForFile(root)).toEqual(captures);
      expect(captures.map((match) => match['@export.name']!.text)).toEqual(['Local', 'Renamed']);
      const name = root
        .descendantsOfType('abstract_class_declaration')[0]!
        .childForFieldName('name')!;
      for (const [key, item] of Object.entries(captures[0]!)) {
        expect(item).toEqual({ name: key, text: name.text, range: rangeOf(name) });
      }
      expect(captures[0]!['@export.local']!.range).not.toBe(captures[0]!['@export.name']!.range);
      const inputs = [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)];
      const baseline = extract(inputs, filePath, hooks);
      const saved = JSON.stringify(captures);
      const siblingRange = { ...captures[0]!['@export.name']!.range };
      (captures[0]!['@export.local']!.range as { startLine: number }).startLine = 999;
      expect(captures[0]!['@export.name']!.range).toEqual(siblingRange);
      const detached = emitTypeScriptExportCapturesForFile(root);
      parser.parse('export abstract class Replacement {}');
      expect(JSON.stringify(detached)).toBe(saved);
      const result = extract([...inputs, ...detached], filePath, {
        ...hooks,
        interpretExports: interpretTypeScriptExports,
      });
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      const binding = module.bindings.get('Local')![0]!.def;
      expect(binding.type).toBe('Class');
      expect(result.exports).toEqual(
        new Map([
          ['Local', binding.nodeId],
          ['Renamed', binding.nodeId],
        ]),
      );
      const nested = result.scopes.find(
        (scope) => scope.id !== result.moduleScope && scope.bindings.has('Local'),
      )!;
      expect(nested.bindings.get('Local')![0]!.def.nodeId).not.toBe(binding.nodeId);
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
      const duplicate = await parse('export abstract class Local {}\nexport { Local };', filePath);
      expect(() =>
        extract(
          [
            ...emitTypeScriptLexicalScopeCaptures(duplicate.root),
            ...declarations(duplicate.root),
            ...emitTypeScriptExportCapturesForFile(duplicate.root),
          ],
          filePath,
          { ...hooks, interpretExports: interpretTypeScriptExports },
        ),
      ).toThrow();
      for (const source of [
        'export default abstract class Local {}',
        'export declare abstract class Local {}',
        'export @decorator abstract class Local {}',
        'export abstract class {}',
        'export abstract class Local {',
      ]) {
        const parsed = await parse(source, filePath);
        expect(() => emitTypeScriptExportCaptures(parsed.root.namedChildren[0]!), source).toThrow();
        expect(() => emitTypeScriptExportCapturesForFile(parsed.root), source).toThrow();
      }
    },
  );

  it.each(['fixture.js', 'fixture.jsx'])(
    'refuses TypeScript abstract class export syntax in %s',
    async (filePath) => {
      const { root } = await parse(
        'export abstract class Local<T> { abstract value(): T; }',
        filePath,
      );
      expect(root.hasError).toBe(true);
      expect(() => emitTypeScriptExportCaptures(root.namedChildren[0]!)).toThrow();
      expect(() => emitTypeScriptExportCapturesForFile(root)).toThrow();
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'resolves named sync and async generator exports to canonical bindings in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        'export /* generator */ function* café() { yield 1; }\n' +
          'export async function* pending() { yield 2; }\n' +
          'export { café as renamed };\n' +
          'function outer() { function* café() { yield 3; } }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const statements = root.descendantsOfType('export_statement');
      const captures = statements.flatMap(emitTypeScriptExportCaptures);
      expect(emitTypeScriptExportCapturesForFile(root)).toEqual(captures);
      expect(captures.map((match) => match['@export.name']!.text)).toEqual([
        'café',
        'pending',
        'renamed',
      ]);
      for (const [index, statement] of statements.slice(0, 2).entries()) {
        const name = statement.childForFieldName('declaration')!.childForFieldName('name')!;
        const match = captures[index]!;
        expect(Object.keys(match).sort()).toEqual(['@export.local', '@export.name']);
        for (const [key, item] of Object.entries(match)) {
          expect(item).toEqual({ name: key, text: name.text, range: rangeOf(name) });
        }
        expect(match['@export.local']!.range).not.toBe(match['@export.name']!.range);
      }
      const inputs = [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)];
      const baseline = extract(inputs, filePath, hooks);
      const saved = JSON.stringify(captures);
      const siblingRange = { ...captures[0]!['@export.name']!.range };
      (captures[0]!['@export.local']!.range as { startLine: number }).startLine = 999;
      expect(captures[0]!['@export.name']!.range).toEqual(siblingRange);
      const detached = emitTypeScriptExportCapturesForFile(root);
      parser.parse('export function* replacement() {}');
      expect(JSON.stringify(detached)).toBe(saved);
      const result = extract([...inputs, ...detached], filePath, {
        ...hooks,
        interpretExports: interpretTypeScriptExports,
      });
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      const id = (name: string) => module.bindings.get(name)![0]!.def.nodeId;
      expect(result.exports).toEqual(
        new Map([
          ['café', id('café')],
          ['pending', id('pending')],
          ['renamed', id('café')],
        ]),
      );
      const nested = result.scopes.find(
        (scope) => scope.id !== result.moduleScope && scope.bindings.has('café'),
      )!;
      expect(nested.bindings.get('café')![0]!.def.nodeId).not.toBe(id('café'));
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
      for (const declaration of ['function* local() {}', 'async function* local() {}']) {
        const parsed = await parse(`export ${declaration}\nexport { local };`, filePath);
        expect(() => emitTypeScriptExportCapturesForFile(parsed.root)).toThrow();
        const duplicate = parsed.root
          .descendantsOfType('export_statement')
          .flatMap(emitTypeScriptExportCaptures);
        expect(() =>
          extract(
            [
              ...emitTypeScriptLexicalScopeCaptures(parsed.root),
              ...declarations(parsed.root),
              ...duplicate,
            ],
            filePath,
            { ...hooks, interpretExports: interpretTypeScriptExports },
          ),
        ).toThrow();
      }
      for (const source of [
        'export default function* local() {}',
        'export default function* () {}',
        'export default async function* local() {}',
        'export default async function* () {}',
        'export function* local( {}',
        'export async function* local() {',
      ]) {
        const parsed = await parse(source, filePath);
        expect(() => emitTypeScriptExportCaptures(parsed.root.namedChildren[0]!), source).toThrow();
        expect(() => emitTypeScriptExportCapturesForFile(parsed.root), source).toThrow();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'shares one export var collision scan per invocation in %s',
    async (filePath) => {
      for (const count of [16, 64]) {
        const { parser, root } = await parse(
          Array.from({ length: count }, (_, index) => `export var value${index} = ${index};`).join(
            '\n',
          ),
          filePath,
        );
        const expected = root.namedChildren.flatMap(emitTypeScriptExportCaptures);
        const wrappers = new Map<number, SyntaxNode>();
        let rootReads = 0;
        function wrapResult(value: unknown): unknown {
          if (Array.isArray(value)) return value.map(wrapResult);
          if (value && typeof value === 'object' && 'id' in value && 'childForFieldName' in value)
            return wrap(value as SyntaxNode);
          return value;
        }
        function wrap(node: SyntaxNode): SyntaxNode {
          const cached = wrappers.get(node.id);
          if (cached) return cached;
          const wrapper = new Proxy(node, {
            get(target, key) {
              if (key === 'namedChildren' && target.id === root.id) rootReads++;
              const value: unknown = Reflect.get(target, key, target);
              return typeof value === 'function'
                ? (...args: unknown[]) => wrapResult(Reflect.apply(value, target, args))
                : wrapResult(value);
            },
          });
          wrappers.set(node.id, wrapper);
          return wrapper;
        }
        const first = emitTypeScriptExportCapturesForFile(wrap(root));
        expect(first).toEqual(expected);
        expect(rootReads).toBe(2);
        const second = emitTypeScriptExportCapturesForFile(wrap(root));
        expect(second).toEqual(expected);
        expect(rootReads).toBe(4);
        expect(first[0]!['@export.local']!.range).not.toBe(first[0]!['@export.name']!.range);
        expect(first[0]!['@export.local']!.range).not.toBe(second[0]!['@export.local']!.range);
        const saved = JSON.stringify(first);
        parser.parse('export var replacement;');
        expect(JSON.stringify(first)).toBe(saved);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'batches only direct exports without validating unrelated nested var syntax in %s',
    async (filePath) => {
      const { root } = await parse(
        'export var local; export const other = 1; export { local as renamed };\n' +
          'function nested(...rest) { var { value } = source; }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      expect(emitTypeScriptExportCapturesForFile(root)).toEqual(
        root.namedChildren
          .filter((node) => node.type === 'export_statement')
          .flatMap(emitTypeScriptExportCaptures),
      );
      for (const source of [
        'let local; export var local;',
        'export var local; const local = 1;',
        'export var local; export var { value } = source;',
        'export var local; export * from "./other";',
        'export var local; export var broken = ;',
      ]) {
        const parsed = await parse(source, filePath);
        expect(() => emitTypeScriptExportCapturesForFile(parsed.root), source).toThrow();
      }
      expect(() => emitTypeScriptExportCapturesForFile(root.namedChildren[0]!)).toThrow();
    },
  );

  it('refuses selected var batches spanning different trees', async () => {
    const first = await parse('var local;');
    const second = await parse('var other;');
    expect(() =>
      emitTypeScriptVarBindingCapturesForNodes([
        first.root.namedChildren[0]!,
        second.root.namedChildren[0]!,
      ]),
    ).toThrow();
    expect(emitTypeScriptVarBindingCapturesForNodes([])).toEqual([]);
  });

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'resolves ordinary var exports with detached ranges and canonical identities in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        'var café = 0;\nexport /* names */ var café = 1, other = 2, pending;\n' +
          'function outer() { var café = 3; }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const statement = root.descendantsOfType('export_statement')[0]!;
      const captures = emitTypeScriptExportCaptures(statement);
      const names = statement
        .descendantsOfType('variable_declarator')
        .map((node) => node.childForFieldName('name')!);
      expect(captures.map((match) => match['@export.name']!.text)).toEqual([
        'café',
        'other',
        'pending',
      ]);
      for (const [index, match] of captures.entries()) {
        expect(Object.keys(match).sort()).toEqual(['@export.local', '@export.name']);
        for (const [key, item] of Object.entries(match)) {
          expect(item).toEqual({
            name: key,
            text: names[index]!.text,
            range: rangeOf(names[index]!),
          });
        }
        expect(match['@export.local']!.range).not.toBe(match['@export.name']!.range);
      }
      const inputs = [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)];
      const baseline = extract(inputs, filePath, hooks);
      const first = extract(
        [
          ...emitTypeScriptLexicalScopeCaptures(root),
          inputs.find((match) => match['@declaration.name']?.text === 'café')!,
        ],
        filePath,
        hooks,
      ).localDefs[0]!;
      const saved = JSON.stringify(captures);
      const siblingRange = { ...captures[0]!['@export.name']!.range };
      (captures[0]!['@export.local']!.range as { startLine: number }).startLine = 999;
      expect(captures[0]!['@export.name']!.range).toEqual(siblingRange);
      const detached = emitTypeScriptExportCaptures(statement);
      parser.parse('export var replacement = 0;');
      expect(JSON.stringify(detached)).toBe(saved);
      const result = extract([...inputs, ...detached], filePath, {
        ...hooks,
        interpretExports: interpretTypeScriptExports,
      });
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      expect(result.exports).toEqual(
        new Map(
          ['café', 'other', 'pending'].map((name) => [
            name,
            module.bindings.get(name)![0]!.def.nodeId,
          ]),
        ),
      );
      const canonical = module.bindings.get('café')![0]!.def;
      expect(canonical).toEqual(first);
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'rejects unsupported var statements and duplicate var exports in %s',
    async (filePath) => {
      for (const source of [
        'export var local = 1, { value } = source;',
        'export var { value } = source, local = 1;',
        'export var local = 1, [value] = source;',
        'export var [value] = source, local = 1;',
        'export var local = 1, broken = ;',
        'const local = 0; export var local = 1;',
        'export var local = 1; let local;',
      ]) {
        const { root } = await parse(source, filePath);
        const statement = root.descendantsOfType('export_statement')[0]!;
        expect(statement).toBeDefined();
        expect(() => emitTypeScriptExportCaptures(statement), source).toThrow();
      }
      for (const source of [
        'export var local = 1; export { local };',
        'export var local = 1; export var local = 2;',
        'export var local = 1, local = 2;',
      ]) {
        const { root } = await parse(source, filePath);
        expect(root.hasError).toBe(false);
        const captures = root
          .descendantsOfType('export_statement')
          .flatMap(emitTypeScriptExportCaptures);
        expect(
          () =>
            extract(
              [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root), ...captures],
              filePath,
              { ...hooks, interpretExports: interpretTypeScriptExports },
            ),
          source,
        ).toThrow();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'resolves lexical exports with independent detached ranges in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        'export /* names */ const café = 1, other = 2;\nexport let pending;\n' +
          'function outer() { const café = 3; }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const statements = root.descendantsOfType('export_statement');
      const captures = statements.flatMap(emitTypeScriptExportCaptures);
      const names = statements.flatMap((statement) =>
        statement
          .descendantsOfType('variable_declarator')
          .map((node) => node.childForFieldName('name')!),
      );
      expect(captures.map((match) => match['@export.name']!.text)).toEqual([
        'café',
        'other',
        'pending',
      ]);
      for (const [index, match] of captures.entries()) {
        expect(match['@export.local']!.range).toEqual(rangeOf(names[index]!));
        expect(match['@export.name']!.range).toEqual(rangeOf(names[index]!));
        expect(match['@export.local']!.range).not.toBe(match['@export.name']!.range);
      }
      const inputs = [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)];
      const baseline = extract(inputs, filePath, hooks);
      const saved = JSON.stringify(captures);
      const siblingRange = { ...captures[0]!['@export.name']!.range };
      (captures[0]!['@export.local']!.range as { startLine: number }).startLine = 999;
      expect(captures[0]!['@export.name']!.range).toEqual(siblingRange);
      const detached = statements.flatMap(emitTypeScriptExportCaptures);
      parser.parse('export const replacement = 0;');
      expect(JSON.stringify(detached)).toBe(saved);
      const result = extract([...inputs, ...detached], filePath, {
        ...hooks,
        interpretExports: interpretTypeScriptExports,
      });
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      expect(result.exports).toEqual(
        new Map(
          ['café', 'other', 'pending'].map((name) => [
            name,
            module.bindings.get(name)![0]!.def.nodeId,
          ]),
        ),
      );
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'allows lexical annotations and initializer type syntax in %s',
    async (filePath) => {
      const { root } = await parse(
        'export const local: number = 1 satisfies number, fn = () => { type Label = string; return 1; };',
        filePath,
      );
      expect(root.hasError).toBe(false);
      expect(
        root
          .descendantsOfType('export_statement')
          .flatMap(emitTypeScriptExportCaptures)
          .map((match) => match['@export.name']!.text),
      ).toEqual(['local', 'fn']);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'resolves named declaration exports to canonical module definitions in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        [
          'export /* declaration */ function café() { return 1; }',
          'export class Local {}',
          'export async function pending() {}',
          'function outer() { function café() {} class Local {} }',
          'export { café as renamed };',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const statements = root.descendantsOfType('export_statement');
      const captures = statements.flatMap(emitTypeScriptExportCaptures);
      expect(captures.map((match) => match['@export.name']!.text)).toEqual([
        'café',
        'Local',
        'pending',
        'renamed',
      ]);
      for (const [index, statement] of statements.slice(0, 3).entries()) {
        const name = statement.childForFieldName('declaration')!.childForFieldName('name')!;
        const match = captures[index]!;
        expect(Object.keys(match).sort()).toEqual(['@export.local', '@export.name']);
        for (const [key, item] of Object.entries(match)) {
          expect(item).toEqual({ name: key, range: rangeOf(name), text: name.text });
        }
        expect(match['@export.local']!.range).not.toBe(match['@export.name']!.range);
      }
      const inputs = [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)];
      const baseline = extract(inputs, filePath, hooks);
      const serialized = JSON.stringify(captures);
      parser.parse('export class Replacement {}');
      expect(JSON.stringify(captures)).toBe(serialized);
      const result = extract([...inputs, ...JSON.parse(serialized)], filePath, {
        ...hooks,
        interpretExports: interpretTypeScriptExports,
      });
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      const id = (name: string) => module.bindings.get(name)![0]!.def.nodeId;
      expect(result.exports).toEqual(
        new Map([
          ['café', id('café')],
          ['Local', id('Local')],
          ['pending', id('pending')],
          ['renamed', id('café')],
        ]),
      );
      for (const name of ['café', 'Local']) {
        const nested = result.scopes.find(
          (scope) => scope.id !== result.moduleScope && scope.bindings.has(name),
        )!;
        expect(nested.bindings.get(name)![0]!.def.nodeId).not.toBe(id(name));
      }
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'allows type syntax within exported declarations in %s',
    async (filePath) => {
      const { root } = await parse(
        'export function local(): string { type Label = string; return "ok"; }\n' +
          'export class Local { method(): void { type Label = string; } }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const captures = root
        .descendantsOfType('export_statement')
        .flatMap(emitTypeScriptExportCaptures);
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root), ...captures],
        filePath,
        { ...hooks, interpretExports: interpretTypeScriptExports },
      );
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      expect(result.exports).toEqual(
        new Map(
          ['local', 'Local'].map((name) => [name, module.bindings.get(name)![0]!.def.nodeId]),
        ),
      );
    },
  );

  it.each([
    'export function local() {}',
    'export class local {}',
    'export const local = 1;',
    'export let local;',
  ])('rejects duplicate declaration and clause exports: %s', async (declaration) => {
    const { root } = await parse(`${declaration}\nexport { local };`);
    expect(root.hasError).toBe(false);
    const captures = root
      .descendantsOfType('export_statement')
      .flatMap(emitTypeScriptExportCaptures);
    expect(() =>
      extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root), ...captures],
        'fixture.ts',
        { ...hooks, interpretExports: interpretTypeScriptExports },
      ),
    ).toThrow();
  });

  it.each([
    'export const local = 1, { value } = source;',
    'export const { value } = source, local = 1;',
    'export let local = 1, [[value]] = source;',
    'export let [[value]] = source, local = 1;',
  ])(
    'rejects mixed supported and unsupported lexical declarators atomically: %s',
    async (source) => {
      const { root } = await parse(source);
      expect(root.hasError).toBe(false);
      const statement = root.descendantsOfType('export_statement')[0]!;
      expect(() => emitTypeScriptExportCaptures(statement)).toThrow();
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'preserves source names and ranges with the real %s grammar',
    async (filePath) => {
      const { root } = await parse(
        'export /* clause */ { local, local /* alias */ as renamed, local as default, };',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const matches = emitTypeScriptExportCaptures(root.namedChildren[0]!);
      expect(
        matches.map((match) => [match['@export.local']!.text, match['@export.name']!.text]),
      ).toEqual([
        ['local', 'local'],
        ['local', 'renamed'],
        ['local', 'default'],
      ]);
      const specifiers = root.descendantsOfType('export_specifier');
      for (const [index, match] of matches.entries()) {
        expect(Object.keys(match).sort()).toEqual(['@export.local', '@export.name']);
        const specifier = specifiers[index]!;
        expect(match['@export.local']!.range).toEqual(
          rangeOf(specifier.childForFieldName('name')!),
        );
        expect(match['@export.name']!.range).toEqual(
          rangeOf(specifier.childForFieldName('alias') ?? specifier.childForFieldName('name')!),
        );
        for (const [key, capture] of Object.entries(match)) {
          expect(capture.name).toBe(key);
          expect(Object.keys(capture).sort()).toEqual(['name', 'range', 'text']);
        }
      }
    },
  );

  it('accepts type as an ordinary JavaScript local identifier and exported alias', async () => {
    const { root } = await parse(
      'const type = 1; const local = 2; export { type, type as renamed, local as typeAlias };',
      'fixture.js',
    );
    expect(root.hasError).toBe(false);
    const captures = emitTypeScriptExportCaptures(root.descendantsOfType('export_statement')[0]!);
    expect(
      captures.map((match) => [match['@export.local']!.text, match['@export.name']!.text]),
    ).toEqual([
      ['type', 'type'],
      ['type', 'renamed'],
      ['local', 'typeAlias'],
    ]);
    const result = extract(
      [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root), ...captures],
      'fixture.js',
      { ...hooks, interpretExports: interpretTypeScriptExports },
    );
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    expect(result.exports).toEqual(
      new Map([
        ['type', module.bindings.get('type')![0]!.def.nodeId],
        ['renamed', module.bindings.get('type')![0]!.def.nodeId],
        ['typeAlias', module.bindings.get('local')![0]!.def.nodeId],
      ]),
    );
  });

  it('accepts type as an ordinary JavaScript exported alias', async () => {
    const { root } = await parse('const local = 1; export { local as type };', 'fixture.js');
    expect(root.hasError).toBe(false);
    const captures = emitTypeScriptExportCaptures(root.descendantsOfType('export_statement')[0]!);
    expect(
      captures.map((match) => [match['@export.local']!.text, match['@export.name']!.text]),
    ).toEqual([['local', 'type']]);
    const result = extract(
      [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root), ...captures],
      'fixture.js',
      { ...hooks, interpretExports: interpretTypeScriptExports },
    );
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    expect(result.exports).toEqual(
      new Map([['type', module.bindings.get('local')![0]!.def.nodeId]]),
    );
  });

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'combines distinct exports from multiple statements in %s',
    async (filePath) => {
      const { root } = await parse(
        [
          'const first = 1; const second = 2;',
          'export { first };',
          'export { second as renamed };',
          'export { first as default };',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const captures = root
        .descendantsOfType('export_statement')
        .flatMap(emitTypeScriptExportCaptures);
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root), ...captures],
        filePath,
        { ...hooks, interpretExports: interpretTypeScriptExports },
      );
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      const firstId = module.bindings.get('first')![0]!.def.nodeId;
      const secondId = module.bindings.get('second')![0]!.def.nodeId;
      expect(firstId).not.toBe(secondId);
      expect(result.exports).toEqual(
        new Map([
          ['first', firstId],
          ['renamed', secondId],
          ['default', firstId],
        ]),
      );
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'rejects duplicate exported names across statements in %s',
    async (filePath) => {
      const { root } = await parse(
        [
          'const first = 1; const second = 2;',
          'export { first as repeated };',
          'export { second as repeated };',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const statements = root.descendantsOfType('export_statement');
      expect(statements).toHaveLength(2);
      const captures = statements.flatMap(emitTypeScriptExportCaptures);
      expect(captures).toHaveLength(2);
      expect(() =>
        extract(
          [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root), ...captures],
          filePath,
          { ...hooks, interpretExports: interpretTypeScriptExports },
        ),
      ).toThrow();
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'maps aliases to module-local canonical definitions without changing private definitions in %s',
    async (filePath) => {
      const source = [
        'const local = 1;',
        'const privateValue = 2;',
        'function outer() { const local = 3; return local; }',
        'export { local, local as renamed, local as default };',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const matches = [
        ...emitTypeScriptLexicalScopeCaptures(root),
        ...declarations(root),
        ...root.descendantsOfType('export_statement').flatMap(emitTypeScriptExportCaptures),
      ];
      const baseline = extract(matches, filePath, hooks);
      const result = extract(matches, filePath, {
        ...hooks,
        interpretExports: interpretTypeScriptExports,
      });
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      const id = module.bindings.get('local')![0]!.def.nodeId;
      expect(result.exports).toEqual(
        new Map([
          ['local', id],
          ['renamed', id],
          ['default', id],
        ]),
      );
      const nested = result.scopes.find(
        (scope) => scope.id !== result.moduleScope && scope.bindings.has('local'),
      )!;
      expect(nested.bindings.get('local')![0]!.def.nodeId).not.toBe(id);
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
      expect(result.exports!.has('privateValue')).toBe(false);
    },
  );

  it('uses the selected canonical module var binding after repeated declarations', async () => {
    const { root } = await parse('var local = 1; var local = 2; export { local as renamed };');
    expect(root.hasError).toBe(false);
    const result = extract(
      [
        ...emitTypeScriptLexicalScopeCaptures(root),
        ...declarations(root),
        ...root.descendantsOfType('export_statement').flatMap(emitTypeScriptExportCaptures),
      ],
      'fixture.ts',
      { ...hooks, interpretExports: interpretTypeScriptExports },
    );
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    expect(module.bindings.get('local')).toHaveLength(1);
    expect(result.localDefs).toHaveLength(2);
    expect(result.exports).toEqual(
      new Map([['renamed', module.bindings.get('local')![0]!.def.nodeId]]),
    );
  });

  it('detaches plain deterministic captures and interprets JSON data after parser reuse', async () => {
    const { parser, root } = await parse('/* 😀 */ const café = 1; export { café as λ };');
    expect(root.hasError).toBe(false);
    const statement = root.descendantsOfType('export_statement')[0]!;
    const first = emitTypeScriptExportCaptures(statement);
    const second = emitTypeScriptExportCaptures(statement);
    const serialized = JSON.stringify(first);
    const inputs = [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)];
    expect(first).toEqual(second);
    expect(first).toEqual(JSON.parse(serialized));
    const local = statement.descendantsOfType('identifier').find((node) => node.text === 'café')!;
    expect(first[0]!['@export.local']!.range).toEqual(rangeOf(local));
    for (const [key, capture] of Object.entries(first[0]!)) {
      expect(Object.getPrototypeOf(capture)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(capture.range)).toBe(Object.prototype);
      expect(capture).not.toBe(second[0]![key]);
      expect(capture.range).not.toBe(second[0]![key]!.range);
    }
    parser.parse('class Replacement {}');
    expect(JSON.stringify(first)).toBe(serialized);
    const result = extract([...inputs, ...JSON.parse(serialized)], 'fixture.ts', {
      ...hooks,
      interpretExports: interpretTypeScriptExports,
    });
    expect(result.exports).toEqual(new Map([['λ', result.localDefs[0]!.nodeId]]));
    (first[0]!['@export.local']!.range as { startLine: number }).startLine = 99;
    expect(JSON.stringify(second)).toBe(serialized);
  });

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'preserves an explicitly empty export map in %s',
    async (filePath) => {
      const { root } = await parse('const privateValue = 1; export {};', filePath);
      expect(root.hasError).toBe(false);
      expect(emitTypeScriptExportCaptures(root.descendantsOfType('export_statement')[0]!)).toEqual(
        [],
      );
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)],
        filePath,
        {
          ...hooks,
          interpretExports: interpretTypeScriptExports,
        },
      );
      expect(result.exports).toEqual(new Map());
      expect(result.localDefs).toHaveLength(1);
    },
  );

  it.each([
    'export type { Local };',
    'export { Local, type OnlyType };',
    'export { type OnlyType as Renamed };',
    'export { local as "quoted" };',
    'export { "quoted" as local };',
    'export const local = 1, broken = ;',
    'export const \\u0061 = 1;',
    'export declare function local(): void;',
    'export function () {}',
    'export class {}',
    'export function local( {}',
    'export class Local {',
    'export default local;',
    'export default function local() {}',
    'export default function () {}',
    'export default class Local {}',
    'export default class {}',
    'export * from "./other";',
    'export * as ns from "./other";',
    'export { default } from "./other";',
    'export { local as default } from "./other";',
    'export { "quoted" as local } from "./other";',
    'export { local as "quoted" } from "./other";',
    String.raw`export { local } from "./oth\u0065r";`,
    'export { local } from "./other" with { type: "json" };',
    'export { local } from "./other" assert { type: "json" };',
    String.raw`export { l\u006fcal };`,
    String.raw`export { local as al\u0069as };`,
    'export { local as };',
    'export { local;',
  ])('rejects the entire unsupported statement: %s', async (source) => {
    const { root } = await parse(source);
    expect(root.namedChildren.length).toBeGreaterThan(0);
    expect(() => emitTypeScriptExportCaptures(root.namedChildren[0]!)).toThrow();
  });

  it('rejects roots, nested identifiers and nonprogram export parents', async () => {
    const { root } = await parse('export { local };');
    expect(() => emitTypeScriptExportCaptures(root)).toThrow();
    expect(() => emitTypeScriptExportCaptures(root.descendantsOfType('identifier')[0]!)).toThrow();
    const nested = await parse('namespace Nested { export { local }; }');
    const statement = nested.root.descendantsOfType('export_statement')[0]!;
    expect(statement).toBeDefined();
    expect(() => emitTypeScriptExportCaptures(statement)).toThrow();
  });

  it('ignores unrelated captures and rejects malformed owned capture data', async () => {
    const { root } = await parse('const local = 1; export { local as renamed };');
    const context = extract(
      [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)],
      'fixture.ts',
      hooks,
    );
    expect(
      interpretTypeScriptExports([{}, ...emitTypeScriptLexicalScopeCaptures(root)], context),
    ).toEqual(new Map());
    const valid = emitTypeScriptExportCaptures(root.descendantsOfType('export_statement')[0]!)[0]!;
    for (const key of Object.keys(valid)) {
      const missing = { ...valid };
      delete missing[key];
      expect(() => interpretTypeScriptExports([missing], context)).toThrow();
      const capture = valid[key]!;
      for (const replacement of [
        { ...capture, name: '@export.wrong' },
        { ...capture, text: '' },
        { ...capture, text: 'not an identifier' },
        { ...capture, range: { ...capture.range, startLine: 0 } },
        { ...capture, range: { ...capture.range, startCol: -1 } },
        { ...capture, range: { ...capture.range, endLine: capture.range.startLine - 1 } },
      ]) {
        expect(() =>
          interpretTypeScriptExports([{ ...valid, [key]: replacement }], context),
        ).toThrow();
      }
    }
    expect(() =>
      interpretTypeScriptExports(
        [
          {
            ...valid,
            '@export.unknown': { ...valid['@export.local']!, name: '@export.unknown' },
          },
        ],
        context,
      ),
    ).toThrow();
  });

  it('rejects missing, imported, namespace, ambiguous and foreign module bindings', async () => {
    const { root } = await parse('const local = 1; export { local };');
    const context = extract(
      [...emitTypeScriptLexicalScopeCaptures(root), ...declarations(root)],
      'fixture.ts',
      hooks,
    );
    const captures = emitTypeScriptExportCaptures(root.descendantsOfType('export_statement')[0]!);
    const module = context.scopes.find((scope) => scope.id === context.moduleScope)!;
    const binding = module.bindings.get('local')![0]!;
    expect(() =>
      interpretTypeScriptExports(captures, contextWithBindings(context, new Map())),
    ).toThrow();
    for (const origin of ['import', 'namespace'] as const) {
      const altered = contextWithBindings(context, new Map([['local', [{ ...binding, origin }]]]));
      expect(() => interpretTypeScriptExports(captures, altered)).toThrow();
    }
    expect(() =>
      interpretTypeScriptExports(
        captures,
        contextWithBindings(context, new Map([['local', [binding, binding]]])),
      ),
    ).toThrow();
    expect(() => interpretTypeScriptExports(captures, { ...context, localDefs: [] })).toThrow();
    expect(() =>
      interpretTypeScriptExports(
        captures,
        contextWithBindings(
          context,
          new Map([['local', [{ ...binding, def: { ...binding.def, filePath: 'foreign.ts' } }]]]),
        ),
      ),
    ).toThrow();
    const outsideModule = captures.map((match) => ({
      ...match,
      '@export.local': {
        ...match['@export.local']!,
        range: { startLine: 999, startCol: 0, endLine: 999, endCol: 5 },
      },
    }));
    expect(() => interpretTypeScriptExports(outsideModule, context)).toThrow();
    expect(() => interpretTypeScriptExports([...captures, ...captures], context)).toThrow();
  });
});
