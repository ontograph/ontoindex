import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { emitTypeScriptLexicalScopeCaptures } from '../../../src/core/ingestion/languages/typescript-scope-captures.js';
import { getProvider } from '../../../src/core/ingestion/languages/index.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';

async function parse(source: string, filePath: string) {
  const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
  return { parser, root: parser.parse(source).rootNode };
}

const turnError = [
  '// GENERATED CODE! Do not edit.',
  'import type { CodexErrorInfo } from "./CodexErrorInfo";',
  'export type TurnError = { message: string, codexErrorInfo: CodexErrorInfo | null, additionalDetails: string | null, };',
].join('\n');

describe.each(['fixture.ts', 'fixture.tsx'])('type-only module captures in %s', (filePath) => {
  it('retains statement and inline type reexports without value definitions or bindings', async () => {
    const { parser, root } = await parse(
      [
        'export type { A, B as Renamed } from "./types";',
        'export { Value, type C, type D as Other } from "./mixed";',
      ].join('\n'),
      filePath,
    );
    expect(root.hasError).toBe(false);
    const captures = structuredClone(emitTypeScriptCaptures(root));
    const saved = JSON.stringify(captures);
    parser.parse('export type Replacement = string;');
    expect(JSON.stringify(captures)).toBe(saved);
    const parsed = extract(captures, filePath, getProvider(SupportedLanguages.TypeScript));
    expect(parsed.parsedImports).toEqual([
      {
        kind: 'reexport',
        localName: 'A',
        importedName: 'A',
        targetRaw: './types',
        namespace: 'type',
      },
      {
        kind: 'reexport',
        localName: 'Renamed',
        importedName: 'B',
        alias: 'Renamed',
        targetRaw: './types',
        namespace: 'type',
      },
      { kind: 'reexport', localName: 'Value', importedName: 'Value', targetRaw: './mixed' },
      {
        kind: 'reexport',
        localName: 'C',
        importedName: 'C',
        targetRaw: './mixed',
        namespace: 'type',
      },
      {
        kind: 'reexport',
        localName: 'Other',
        importedName: 'D',
        alias: 'Other',
        targetRaw: './mixed',
        namespace: 'type',
      },
    ]);
    expect(parsed.parsedImports[2]).not.toHaveProperty('namespace');
    expect(parsed.parsedImports[0]).not.toHaveProperty('alias');
    expect(parsed.localDefs).toEqual([]);
    expect(parsed.exports).toEqual(new Map());
    expect(parsed.scopes).toHaveLength(1);
    expect([...parsed.scopes[0]!.bindings]).toEqual([]);
    expect([...parsed.scopes[0]!.typeBindings]).toEqual([]);
    expect(parsed.referenceSites).toEqual([]);
  });

  it('detaches imports beside nominal declarations without value references', async () => {
    const lines = [
      'import Main, { A, B as Renamed, type C, type D as Local } from "./a";',
      'import * as types from "./types.js";',
      'import type { Erased } from "./erased";',
      'export type Alias = Main | A | Renamed | C | Local | types.Value | Erased;',
      'export interface Port { value: Alias; }',
    ];
    const source = lines.join('\n');
    const { parser, root } = await parse(source, filePath);
    expect(root.hasError).toBe(false);
    const captures = emitTypeScriptCaptures(root);
    const parsed = extract(captures, filePath, getProvider(SupportedLanguages.TypeScript));
    expect(parsed.parsedImports).toEqual([
      {
        kind: 'alias',
        localName: 'Main',
        importedName: 'default',
        alias: 'Main',
        targetRaw: './a',
      },
      { kind: 'named', localName: 'A', importedName: 'A', targetRaw: './a' },
      {
        kind: 'alias',
        localName: 'Renamed',
        importedName: 'B',
        alias: 'Renamed',
        targetRaw: './a',
      },
      { kind: 'named', localName: 'C', importedName: 'C', targetRaw: './a', namespace: 'type' },
      {
        kind: 'alias',
        localName: 'Local',
        importedName: 'D',
        alias: 'Local',
        targetRaw: './a',
        namespace: 'type',
      },
      {
        kind: 'namespace',
        localName: 'types',
        importedName: './types.js',
        targetRaw: './types.js',
      },
      {
        kind: 'named',
        localName: 'Erased',
        importedName: 'Erased',
        targetRaw: './erased',
        namespace: 'type',
      },
    ]);
    const imports = captures.filter((match) => match['@import.binding']);
    expect(imports.map((match) => match['@import.binding']!.range)).toEqual([
      { startLine: 1, startCol: 7, endLine: 1, endCol: 11 },
      { startLine: 1, startCol: 15, endLine: 1, endCol: 16 },
      { startLine: 1, startCol: 23, endLine: 1, endCol: 30 },
      { startLine: 1, startCol: 37, endLine: 1, endCol: 38 },
      { startLine: 1, startCol: 50, endLine: 1, endCol: 55 },
      { startLine: 2, startCol: 12, endLine: 2, endCol: 17 },
      { startLine: 3, startCol: 14, endLine: 3, endCol: 20 },
    ]);
    expect(
      captures.filter((match) => Object.keys(match).some((key) => key.startsWith('@scope.'))),
    ).toEqual(emitTypeScriptLexicalScopeCaptures(root));
    expect(parsed.scopes.map(({ kind, range }) => ({ kind, range }))).toEqual([
      {
        kind: 'Module',
        range: { startLine: 1, startCol: 0, endLine: 5, endCol: lines[4]!.length },
      },
      { kind: 'Class', range: { startLine: 5, startCol: 7, endLine: 5, endCol: lines[4]!.length } },
    ]);
    expect(parsed.localDefs.map((def) => [def.qualifiedName, def.type])).toEqual([
      ['Alias', 'TypeAlias'],
      ['Port', 'Interface'],
    ]);
    expect(parsed.exports).toEqual(
      new Map(parsed.localDefs.map((def) => [def.qualifiedName, def.nodeId])),
    );
    expect(parsed.referenceSites).toEqual([]);
    const detached = structuredClone(parsed);
    parser.parse('export type Replacement = string;');
    expect(parsed).toEqual(detached);
  });

  it.each([
    turnError,
    [
      'import type { A, B as Renamed } from "./a";',
      "import type { C } from './c';",
      '; /* erased module */',
      'export type First = A | Renamed;',
      'export type Second = { nested: C };',
    ].join('\n'),
    'export type Only = string;',
    'import type { A } from "./a";',
  ])('retains nominal aliases and type imports for %s', async (source) => {
    const { root } = await parse(source, filePath);
    expect(root.hasError).toBe(false);
    const captures = emitTypeScriptCaptures(root);
    const parsed = extract(captures, filePath, getProvider(SupportedLanguages.TypeScript));
    expect(parsed.referenceSites).toEqual([]);
    expect(parsed.localDefs.every((def) => def.type === 'TypeAlias')).toBe(true);
    expect(parsed.exports).toEqual(
      new Map(parsed.localDefs.map((def) => [def.qualifiedName, def.nodeId])),
    );
  });

  it.each([
    'export interface TypeResolver { resolveType(expression: string, location: { filePath: string; line: number }): string | null; getFileScopeBindings(filePath: string): Array<[string, string]>; }',
    'export interface BackendPort { init(): Promise<boolean>; callTool(method: string, params: unknown): Promise<unknown>; dispose(): Promise<void>; }\nexport interface GroupBackendPort extends BackendPort { listGroups(): Promise<unknown>; syncGroup(groupName: string): Promise<unknown>; }',
    'import type { Range, ScopeId } from "./types.js";\nexport type ReferenceKind = "call" | "read";\nexport interface ReferenceSite { readonly name: string; readonly atRange: Range; readonly inScope: ScopeId; readonly kind: ReferenceKind; readonly arity?: number; }',
    'export interface Generic<T extends { name: string }> { readonly value: T; (value: T): T; new (value: T): T; [key: string]: unknown; }',
  ])('retains interface lexical ranges without value facts for %s', async (source) => {
    const { root } = await parse(source, filePath);
    expect(root.hasError).toBe(false);
    const captures = emitTypeScriptCaptures(root);
    const scopes = captures.filter((match) =>
      Object.keys(match).some((key) => key.startsWith('@scope.')),
    );
    expect(scopes).toEqual(emitTypeScriptLexicalScopeCaptures(root));
    const interfaces = root.namedChildren.flatMap((statement) => {
      const declaration = statement.childForFieldName('declaration');
      return declaration?.type === 'interface_declaration' ? [declaration] : [];
    });
    expect(scopes.map((match) => Object.keys(match))).toEqual([
      ['@scope.module'],
      ...interfaces.map(() => ['@scope.class']),
    ]);
    expect(scopes.slice(1).map((match) => match['@scope.class']!.range)).toEqual(
      interfaces.map((node) => ({
        startLine: node.startPosition.row + 1,
        startCol: node.startPosition.column,
        endLine: node.endPosition.row + 1,
        endCol: node.endPosition.column,
      })),
    );
    const parsed = extract(captures, filePath, getProvider(SupportedLanguages.TypeScript));
    expect(parsed.referenceSites).toEqual([]);
    expect(parsed.localDefs.filter((def) => def.type === 'Interface')).toHaveLength(
      interfaces.length,
    );
  });

  it.each([
    'export default interface I {}',
    'export declare interface I {}',
    'declare interface I {}',
    'export interface Broken { field: ; }',
    'export interface Broken { method(value: ): void; }',
    'export interface Broken { field: string;',
    'export interface I {}\nexport { I };',
    'export type { default as A } from "./a";',
    'export type { A };',
    'import { A, B as A } from "./a"; export type T = A;',
    'import { A } from "./a"; import A from "./other"; export type T = A;',
    'import type { Foo } from "./a"; import { Foo } from "./b"; export interface I { x: Foo; }',
    'import { Foo } from "./b"; import type { Foo } from "./a"; export interface I { x: Foo; }',
    'import type { A as Foo } from "./a"; import { B as Foo } from "./b"; export interface I { x: Foo; }',
    'import { A as Foo } from "./a"; import type { B as Foo } from "./b"; export interface I { x: Foo; }',
    'import { A, type B as A } from "./a"; export type T = A;',
    'import { A, type default as B } from "./a"; export type T = A | B;',
    'import { A, type "B" as B } from "./a"; export type T = A | B;',
    'import { A } from "./a" with { type: "json" }; export type T = A;',
    'import { A } from "./a" assert { type: "json" }; export type T = A;',
    'import { A } from "./a\\u002ejs"; export type T = A;',
    'import { A as } from "./a"; export type T = A;',
    'import type Default, { A } from "./a"; export type T = A;',
    'import type * as A from "./a"; export type T = A;',
    'import type A from "./a"; export type T = A;',
    'import "./a"; export type T = {};',
    'export type Broken = { field: ; };',
    '// c\n#!/usr/bin/env node\nexport type T = {};',
    'export enum E { A }',
    'export declare const value: string;',
    'namespace N {}',
    'import type { type A } from "./a"; export type T = A;',
    'import type { "A" as A } from "./a"; export type T = A;',
    'import type { A } from "./a" with { type: "json" }; export type T = A;',
    'import type { A } from "./a\\u002ejs"; export type T = A;',
  ])('keeps unsupported files refused: %s', async (source) => {
    const { root } = await parse(source, filePath);
    expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
  });

  it.each([
    'export interface I {}\nexport const x = 1;',
    'import { A } from "./a"; export type T = A; export const value = 1;',
  ])('retains runtime definitions beside erased declarations: %s', async (source) => {
    const { root } = await parse(source, filePath);
    expect(root.hasError).toBe(false);
    const parsed = extract(
      emitTypeScriptCaptures(root),
      filePath,
      getProvider(SupportedLanguages.TypeScript),
    );
    expect(parsed.localDefs.map(({ qualifiedName }) => qualifiedName)).toEqual([
      ...(source.includes('const x') ? ['I', 'x'] : ['T', 'value']),
    ]);
    expect([...parsed.exports!.keys()]).toEqual(
      parsed.localDefs.map(({ qualifiedName }) => qualifiedName),
    );
  });

  it('detaches mixed runtime facts while retaining only lexical scopes for erased declarations', async () => {
    const source = [
      'import { helper, type Imported, type Other as Local } from "./mixed";',
      'export type Alias = Imported | Local;',
      'export interface Port { value: Alias; }',
      'export const count = 1;',
      'export function run() { helper(); }',
    ].join('\n');
    const { parser, root } = await parse(source, filePath);
    expect(root.hasError).toBe(false);
    const captures = emitTypeScriptCaptures(root);
    const serialized = JSON.stringify(captures);
    const parsed = extract(captures, filePath, getProvider(SupportedLanguages.TypeScript));
    expect(parsed.localDefs.map(({ qualifiedName, type }) => ({ qualifiedName, type }))).toEqual([
      { qualifiedName: 'Alias', type: 'TypeAlias' },
      { qualifiedName: 'Port', type: 'Interface' },
      { qualifiedName: 'count', type: 'Variable' },
      { qualifiedName: 'run', type: 'Function' },
    ]);
    expect(parsed.exports).toEqual(
      new Map(parsed.localDefs.map((def) => [def.qualifiedName, def.nodeId])),
    );
    expect(parsed.parsedImports).toEqual([
      { kind: 'named', localName: 'helper', importedName: 'helper', targetRaw: './mixed' },
      {
        kind: 'named',
        localName: 'Imported',
        importedName: 'Imported',
        targetRaw: './mixed',
        namespace: 'type',
      },
      {
        kind: 'alias',
        localName: 'Local',
        importedName: 'Other',
        alias: 'Local',
        targetRaw: './mixed',
        namespace: 'type',
      },
    ]);
    expect(
      parsed.referenceSites.map(({ name, kind, callForm }) => ({ name, kind, callForm })),
    ).toEqual([{ name: 'helper', kind: 'call', callForm: 'free' }]);
    expect(
      captures.filter((match) => Object.keys(match).some((key) => key.startsWith('@scope.'))),
    ).toEqual(emitTypeScriptLexicalScopeCaptures(root));
    expect(parsed.scopes.some((scope) => scope.kind === 'Class')).toBe(true);
    const module = parsed.scopes.find((scope) => scope.id === parsed.moduleScope)!;
    for (const name of ['Alias', 'Port']) {
      expect(module.bindings.get(name)?.[0]?.namespace).toBe('type');
    }
    const detached = structuredClone(parsed);
    parser.parse('export const replacement = 2;');
    expect(JSON.stringify(captures)).toBe(serialized);
    expect(parsed).toEqual(detached);
    expect(
      extract(JSON.parse(serialized), filePath, getProvider(SupportedLanguages.TypeScript)),
    ).toEqual(parsed);
  });

  it.each([
    'export type Erased = string; export type Erased = number; export const value = 1;',
    'export interface Erased {} export interface Erased {} export const value = 1;',
    'export type Erased = string; export interface Erased {} export const value = 1;',
    'export type Erased = string; export const Erased = 1;',
    'export type Erased = string; const value = 1; export { value as Erased };',
    'export interface Erased {} export { remote as Erased } from "./remote";',
    'export type Erased = string; import { Erased } from "./remote"; export const value = 1;',
    'export type Erased = string; function Erased() {}',
    'export default interface Erased {} export const value = 1;',
    'export declare interface Erased {} export const value = 1;',
    'export declare type Erased = string; export const value = 1;',
    'export type Broken = { field: ; }; export const value = 1;',
    'export interface Broken { field: ; } export const value = 1;',
  ])('refuses mixed erased name ambiguity or unsupported declarations: %s', async (source) => {
    const { root } = await parse(source, filePath);
    expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
  });

  it('preserves the existing comment-only module behavior', async () => {
    const { root } = await parse('/* module */\n// trailing', filePath);
    expect(emitTypeScriptCaptures(root)).toEqual(emitTypeScriptLexicalScopeCaptures(root));
    expect(emitTypeScriptCaptures(root).map((match) => Object.keys(match))).toEqual([
      ['@scope.module'],
    ]);
  });
});
