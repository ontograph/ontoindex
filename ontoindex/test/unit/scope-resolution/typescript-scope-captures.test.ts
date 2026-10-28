import { describe, expect, it, vi } from 'vitest';
import type { SyntaxNode } from 'tree-sitter';
import { SupportedLanguages, buildScopeTree } from 'ontoindex-shared';
import type { CaptureMatch, Range, Scope, ScopeKind } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptLexicalScopeCaptures } from '../../../src/core/ingestion/languages/typescript-scope-captures.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import {
  selectTypeScriptLocalBindings,
  typeScriptDeclarationBindingScope,
  typeScriptDeclarationNamespace,
} from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';
import { interpretTypeScriptImport } from '../../../src/core/ingestion/languages/typescript-import-captures.js';
import { interpretTypeScriptExports } from '../../../src/core/ingestion/languages/typescript-export-captures.js';
import {
  javascriptProvider,
  typescriptProvider,
} from '../../../src/core/ingestion/languages/typescript.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';

const hooks = { interpretImport: () => null };

async function parse(source: string, filePath = 'fixture.ts') {
  const language = /\.jsx?$/.test(filePath)
    ? SupportedLanguages.JavaScript
    : SupportedLanguages.TypeScript;
  const parser = await createParserForLanguage(language, filePath);
  const tree = parser.parse(source);
  return { parser, tree, root: tree.rootNode };
}

function rangeOf(node: SyntaxNode): Range {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}

function sourceRange(source: string, text: string): Range {
  const start = source.indexOf(text);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(text, start + 1)).toBe(-1);
  const before = source.slice(0, start).split('\n');
  const through = source.slice(0, start + text.length).split('\n');
  return {
    startLine: before.length,
    startCol: before.at(-1)!.length,
    endLine: through.length,
    endCol: through.at(-1)!.length,
  };
}

type ExpectedScope = [kind: ScopeKind, text: string, parentText: string | null];

function assertHierarchy(source: string, captures: CaptureMatch[], expected: ExpectedScope[]) {
  const result = extract(captures, 'fixture.ts', hooks);
  expect(result.scopes).toHaveLength(expected.length);
  const lookup = (text: string): Scope => {
    const range = sourceRange(source, text);
    const matches = result.scopes.filter(
      (scope) => JSON.stringify(scope.range) === JSON.stringify(range),
    );
    // A whole-file declaration shares its range with the Module.
    return matches.find((scope) => scope.kind !== 'Module') ?? matches[0]!;
  };
  const module = result.scopes.find((scope) => scope.kind === 'Module')!;
  for (const [kind, text, parentText] of expected) {
    const scope = kind === 'Module' ? module : lookup(text);
    expect(scope.kind).toBe(kind);
    expect(scope.range).toEqual(sourceRange(source, text));
    const parent = parentText === null ? null : parentText === source ? module : lookup(parentText);
    expect(scope.parent).toBe(parent?.id ?? null);
  }
  expect(result.moduleScope).toBe(module.id);
  expect(() => buildScopeTree(result.scopes)).not.toThrow();
  return result;
}

describe('borrowed TS/JS lexical scope captures', () => {
  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'extracts nested lexical scopes with the real %s grammar',
    async (filePath) => {
      const block = '{ const inner = () => value; }';
      const body = `{ if (value) ${block} }`;
      const method = `method(value = 1) ${body}`;
      const cls = `class Example { ${method} }`;
      const source = `${cls}\nconst sibling = () => 2;`;
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      assertHierarchy(source, emitTypeScriptLexicalScopeCaptures(root), [
        ['Module', source, null],
        ['Class', cls, source],
        ['Function', method, cls],
        ['Block', body, method],
        ['Block', block, body],
        ['Function', '() => value', block],
        ['Function', '() => 2', source],
      ]);
    },
  );

  it.each(['function whole() {}', 'class Whole {}'])(
    'keeps the equal-range Module parent for %s',
    async (source) => {
      const { root } = await parse(source);
      const result = extract(emitTypeScriptLexicalScopeCaptures(root), 'whole.ts', hooks);
      const module = result.scopes.find((scope) => scope.kind === 'Module')!;
      const declaration = result.scopes.find(
        (scope) => scope.kind === (source.startsWith('class') ? 'Class' : 'Function'),
      )!;
      expect(declaration.range).toEqual(module.range);
      expect(declaration.parent).toBe(module.id);
      expect(result.scopes).toHaveLength(source.startsWith('class') ? 2 : 3);
      expect(() => buildScopeTree(result.scopes)).not.toThrow();
    },
  );

  it('emits a single zero-width Module for an empty program', async () => {
    const { root } = await parse('');
    const result = extract(emitTypeScriptLexicalScopeCaptures(root), 'empty.ts', hooks);
    expect(result.scopes).toHaveLength(1);
    expect(result.scopes[0]).toMatchObject({
      kind: 'Module',
      parent: null,
      range: { startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
    });
  });

  it('contains default-parameter arrows in the entire function, outside its body block', async () => {
    const arrow = '(x = 1) => x';
    const body = '{ return callback(); }';
    const fn = `function outer(callback = ${arrow}) ${body}`;
    const source = `${fn}\nfunction sibling() { return 3; }`;
    const { root } = await parse(source);
    assertHierarchy(source, emitTypeScriptLexicalScopeCaptures(root), [
      ['Module', source, null],
      ['Function', fn, source],
      ['Function', arrow, fn],
      ['Block', body, fn],
      ['Function', 'function sibling() { return 3; }', source],
      ['Block', '{ return 3; }', 'function sibling() { return 3; }'],
    ]);
  });

  it('captures function and generator expressions, declarations and anonymous classes', async () => {
    const expression = 'function named() { return 1; }';
    const generator = 'function* generate() { yield 2; }';
    const generatorExpression = 'function* () { yield 3; }';
    const anonymousClass = 'class { method() { return 4; } }';
    const source = `const fn = ${expression};\n${generator}\nconst gen = ${generatorExpression};\nconst C = ${anonymousClass};`;
    const { root } = await parse(source);
    expect(root.hasError).toBe(false);
    assertHierarchy(source, emitTypeScriptLexicalScopeCaptures(root), [
      ['Module', source, null],
      ['Function', expression, source],
      ['Block', '{ return 1; }', expression],
      ['Function', generator, source],
      ['Block', '{ yield 2; }', generator],
      ['Function', generatorExpression, source],
      ['Block', '{ yield 3; }', generatorExpression],
      ['Class', anonymousClass, source],
      ['Function', 'method() { return 4; }', anonymousClass],
      ['Block', '{ return 4; }', 'method() { return 4; }'],
    ]);
  });

  it('distinguishes loop, catch, switch and static-block ranges', async () => {
    const forLoop = 'for (let i = 0; i < 1; i++) { use(i); }';
    const forIn = 'for (const key in object) use(key);';
    const forOf = 'for (const item of items) use(item);';
    const catchClause = 'catch (error) { handle(error); }';
    const switchBody = '{ case 1: { stop(); } break; default: break; }';
    const cls = 'class Static { static { initialize(); } }';
    const source = `${forLoop}\n${forIn}\n${forOf}\ntry { risky(); } ${catchClause}\nswitch (value) ${switchBody}\n${cls}`;
    const { root } = await parse(source);
    expect(root.hasError).toBe(false);
    assertHierarchy(source, emitTypeScriptLexicalScopeCaptures(root), [
      ['Module', source, null],
      ['Block', forLoop, source],
      ['Block', '{ use(i); }', forLoop],
      ['Block', forIn, source],
      ['Block', forOf, source],
      ['Block', '{ risky(); }', source],
      ['Block', catchClause, source],
      ['Block', '{ handle(error); }', catchClause],
      ['Block', switchBody, source],
      ['Block', '{ stop(); }', switchBody],
      ['Class', cls, source],
      ['Block', '{ initialize(); }', cls],
    ]);
  });

  it('captures namespace and class-like declarations without adding ambient or overload scopes', async () => {
    const iface = 'interface Shape { method(): void; }';
    const abstract = 'abstract class Base { abstract method(): void; }';
    const nsBody = `{ ${iface} ${abstract} }`;
    const ns = `namespace API ${nsBody}`;
    const implementation = 'function overloaded(value: string) { return value; }';
    const source = `declare ${ns}\nfunction overloaded(value: string): string;\n${implementation}`;
    const { root } = await parse(source);
    expect(root.hasError).toBe(false);
    assertHierarchy(source, emitTypeScriptLexicalScopeCaptures(root), [
      ['Module', source, null],
      ['Namespace', ns, source],
      ['Block', nsBody, ns],
      ['Class', iface, nsBody],
      ['Class', abstract, nsBody],
      ['Function', implementation, source],
      ['Block', '{ return value; }', implementation],
    ]);
  });

  it.each(['fixture.tsx', 'fixture.jsx'])(
    'traverses arrows embedded in JSX for %s',
    async (filePath) => {
      const arrow = '() => <span />';
      const source = `const component = <Widget render={${arrow}} />;`;
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      assertHierarchy(source, emitTypeScriptLexicalScopeCaptures(root), [
        ['Module', source, null],
        ['Function', arrow, source],
      ]);
    },
  );

  it('uses native Unicode positions with one-based lines and unchanged columns', async () => {
    const source = 'const label = "😀é"; const λ = () => "🌍";\nfunction café() {}';
    const { root } = await parse(source);
    const captures = emitTypeScriptLexicalScopeCaptures(root);
    for (const node of [
      root,
      ...root.descendantsOfType(['arrow_function', 'function_declaration', 'statement_block']),
    ]) {
      const matches = captures
        .flatMap((match) => Object.values(match))
        .filter((capture) => JSON.stringify(capture.range) === JSON.stringify(rangeOf(node)));
      expect(matches).toHaveLength(1);
    }
    const result = extract(captures, 'unicode.ts', hooks);
    expect(result.scopes.filter((scope) => scope.kind === 'Function')).toHaveLength(2);
  });

  it('returns deterministic plain captures that survive subsequent parsing and caller mutation', async () => {
    const { parser, root } = await parse('function outer() { return () => 1; }');
    const first = emitTypeScriptLexicalScopeCaptures(root);
    const second = emitTypeScriptLexicalScopeCaptures(root);
    expect(first).toEqual(second);
    const serialized = JSON.stringify(first);
    expect(first).toEqual(JSON.parse(serialized));
    for (const [index, match] of first.entries()) {
      expect(Object.keys(match)).toHaveLength(1);
      const capture = Object.values(match)[0]!;
      const other = Object.values(second[index]!)[0]!;
      expect(Object.keys(capture).sort()).toEqual(['name', 'range', 'text']);
      expect(capture.text).toBe('');
      expect(capture).not.toBe(other);
      expect(capture.range).not.toBe(other.range);
    }
    parser.parse('class Replacement {}');
    expect(JSON.stringify(first)).toBe(serialized);
    Object.values(first[0]!)[0]!.range.startLine = 99;
    expect(JSON.stringify(second)).toBe(serialized);
  });

  it.each(['function broken( {', 'function broken() {'])(
    'refuses malformed syntax: %s',
    async (source) => {
      const { root } = await parse(source);
      expect(root.hasError).toBe(true);
      expect(() => emitTypeScriptLexicalScopeCaptures(root)).toThrow();
    },
  );

  it('refuses a borrowed subtree instead of silently inventing a Module', async () => {
    const { root } = await parse('function complete() {}');
    expect(() => emitTypeScriptLexicalScopeCaptures(root.namedChildren[0]!)).toThrow();
  });

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'registers detached borrowed-root captures and interpretation hooks for %s',
    async (filePath) => {
      const provider = /\.jsx?$/.test(filePath) ? javascriptProvider : typescriptProvider;
      expect(provider.bindingScopeFor).toBe(typeScriptDeclarationBindingScope);
      expect(provider.declarationNamespaceFor).toBe(typeScriptDeclarationNamespace);
      expect(provider.selectLocalBindings).toBe(selectTypeScriptLocalBindings);
      expect(provider.interpretImport).toBe(interpretTypeScriptImport);
      expect(provider.interpretExports).toBe(interpretTypeScriptExports);
      expect(() => provider.emitScopeCaptures!('', filePath)).toThrow(
        'TS/JS scope captures require the borrowed root',
      );

      const source = "import Main from './module';\nexport function local() { Main(); }\nlocal();";
      const { parser, root } = await parse(source, filePath);
      const expected = emitTypeScriptCaptures(root);
      const parseSpy = vi.spyOn(parser, 'parse');
      let captures: readonly CaptureMatch[];
      try {
        captures = provider.emitScopeCaptures!(source, filePath, root);
        expect(parseSpy).not.toHaveBeenCalled();
      } finally {
        parseSpy.mockRestore();
      }
      expect(captures).toEqual(expected);
      expect(extract(captures, filePath, provider)).toEqual(
        extract(expected, filePath, {
          bindingScopeFor: typeScriptDeclarationBindingScope,
          declarationNamespaceFor: typeScriptDeclarationNamespace,
          selectLocalBindings: selectTypeScriptLocalBindings,
          interpretImport: interpretTypeScriptImport,
          interpretExports: interpretTypeScriptExports,
        }),
      );
      const serialized = JSON.stringify(captures);
      expect(captures).toEqual(JSON.parse(serialized));
      Object.values(expected[0]!)[0]!.range.startLine = 99;
      parser.parse('class Replacement {}');
      expect(JSON.stringify(captures)).toBe(serialized);
    },
  );
});
