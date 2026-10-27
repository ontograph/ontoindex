import { describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import Parser from 'tree-sitter';
import { cppProvider } from '../../../src/core/ingestion/languages/c-cpp.js';
import {
  cppDeclarationBindingScope,
  emitCppCaptures,
  interpretCppExports,
} from '../../../src/core/ingestion/languages/cpp-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { extractParsedFileOutcome } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';
import { resolveReferences } from '../../../src/core/ingestion/resolve-references.js';

const filePath = 'fixture.cpp';
const hooks = {
  bindingScopeFor: cppDeclarationBindingScope,
  interpretExports: interpretCppExports,
  interpretImport: () => null,
};

async function parse(source: string) {
  const parser = await createParserForLanguage(SupportedLanguages.CPlusPlus, filePath);
  return { parser, root: parser.parse(source).rootNode };
}

describe('borrowed C++ translation unit captures', () => {
  it('binds functions in the module and owns self and prior calls in body blocks', async () => {
    const source = [
      '// translation unit comment',
      'void first() { first(); return; }',
      'void second() { /* body comment */ first(); second(); }',
    ].join('\n');
    const { root } = await parse(source);
    expect(root.hasError).toBe(false);
    const result = extract(emitCppCaptures(root), filePath, hooks);
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    const functions = result.scopes.filter((scope) => scope.kind === 'Function');
    const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
    expect(result.scopes.map((scope) => scope.kind)).toEqual([
      'Module',
      'Function',
      'Block',
      'Function',
      'Block',
    ]);
    expect(functions.map((scope) => scope.parent)).toEqual([module.id, module.id]);
    expect(blocks.map((scope) => scope.parent)).toEqual(functions.map((scope) => scope.id));
    expect(
      result.localDefs.map(({ filePath, type, qualifiedName }) => ({
        filePath,
        type,
        qualifiedName,
      })),
    ).toEqual([
      { filePath, type: 'Function', qualifiedName: 'first' },
      { filePath, type: 'Function', qualifiedName: 'second' },
    ]);
    expect(new Set(result.localDefs.map((def) => def.nodeId)).size).toBe(2);
    expect([...module.bindings]).toEqual(
      result.localDefs.map((def) => [def.qualifiedName, [{ def, origin: 'local' }]]),
    );
    expect(module.ownedDefs).toEqual([]);
    for (const [index, owner] of functions.entries()) {
      expect(owner.ownedDefs).toEqual([result.localDefs[index]]);
      expect([...owner.bindings]).toEqual([]);
    }
    for (const block of blocks) {
      expect(block.ownedDefs).toEqual([]);
      expect([...block.bindings]).toEqual([]);
    }
    expect(
      result.referenceSites.map(({ name, inScope, kind, callForm, arity }) => ({
        name,
        inScope,
        kind,
        callForm,
        arity,
      })),
    ).toEqual([
      { name: 'first', inScope: blocks[0]!.id, kind: 'call', callForm: 'free', arity: 0 },
      { name: 'first', inScope: blocks[1]!.id, kind: 'call', callForm: 'free', arity: 0 },
      { name: 'second', inScope: blocks[1]!.id, kind: 'call', callForm: 'free', arity: 0 },
    ]);
    expect(result.parsedImports).toEqual([]);
    expect(result.exports).toEqual(
      new Map(result.localDefs.map((def) => [def.qualifiedName!, def.nodeId])),
    );
    const resolved = resolveReferences(finalizeScopeModel([result]));
    expect(resolved.stats).toEqual({
      totalSites: 3,
      resolvedSites: 3,
      unresolvedSites: 0,
      ambiguousSites: 0,
      unsupportedSites: 0,
    });
    expect(
      result.localDefs.map((def) => resolved.referenceIndex.byTargetDef.get(def.nodeId)?.length),
    ).toEqual([2, 1]);
  });

  it.each(['', '// comment only', '/* first */\n// second\n'])(
    'accepts an empty translation unit: %j',
    async (source) => {
      const { root } = await parse(source);
      const result = extract(emitCppCaptures(root), filePath, hooks);
      expect(result.scopes.map((scope) => scope.kind)).toEqual(['Module']);
      expect(result.localDefs).toEqual([]);
      expect(result.referenceSites).toEqual([]);
      expect(result.exports).toEqual(new Map());
    },
  );

  it.each(['', 'return;', '/* body */'])(
    'keeps coincident module/function ranges distinct: %s',
    async (body) => {
      const { root } = await parse(`void publicFunction() { ${body} }`);
      const result = extract(emitCppCaptures(root), filePath, hooks);
      const module = result.scopes.find((scope) => scope.kind === 'Module')!;
      const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
      const block = result.scopes.find((scope) => scope.kind === 'Block')!;
      expect(owner.range).toEqual(module.range);
      expect(owner.parent).toBe(module.id);
      expect(block.parent).toBe(owner.id);
      expect([...module.bindings.keys()]).toEqual(['publicFunction']);
      expect(result.exports).toEqual(new Map([['publicFunction', result.localDefs[0]!.nodeId]]));
    },
  );

  it('detaches deterministic captures and results before parser reuse', async () => {
    const { parser, root } = await parse('void first() {} void second() { first(); }');
    const captures = emitCppCaptures(root);
    expect(emitCppCaptures(root)).toEqual(captures);
    const saved = JSON.stringify(captures);
    const result = extract(captures, filePath, hooks);
    const detachedResult = structuredClone(result);
    parser.parse('void replacement() {}');
    expect(JSON.stringify(captures)).toBe(saved);
    expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    expect(result).toEqual(detachedResult);
  });

  const unsupported = [
    'int bad() {}',
    'void main() {}',
    'void __reserved() {}',
    'void has__reserved() {}',
    'void _Reserved() {}',
    'void _private() {}',
    'void café() {}',
    'void bad(int value) {}',
    'void bad(void) {}',
    'void bad(...) {}',
    '#include <stdio.h>',
    '#define VALUE 1',
    'void bad();',
    'static void bad() {}',
    'extern void bad() {}',
    'extern "C" { void bad() {} }',
    'inline void bad() {}',
    'constexpr void bad() {}',
    'consteval void bad() {}',
    'template <typename T> void bad() {}',
    'class Bad {};',
    'struct Bad {};',
    'namespace bad { void nested() {} }',
    'void ns::bad() {}',
    'void bad() noexcept {}',
    'auto bad() -> void {}',
    '[[nodiscard]] void bad() {}',
    'void bad() { {} }',
    'void bad() { return 1; }',
    'void bad() { return retained(); }',
    'void bad() { int value; }',
    'void bad() { if (true) {} }',
    'void bad() { retained(1); }',
    'void bad() { object.method(); }',
    'void bad() { ::retained(); }',
    'void bad() { missing(); }',
    'void bad() { later(); } void later() {}',
    'void retained() {}',
    ';',
    'void bad() { ; }',
    'retained();',
  ];

  it.each(unsupported)('refuses unsupported whole files atomically: %s', async (fragment) => {
    for (const source of [`void retained() {}\n${fragment}`, `${fragment}\nvoid retained() {}`]) {
      const { root } = await parse(source);
      expect(() => emitCppCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
    }
  });

  it('rejects unsupported top-level nodes before reading their descendants', () => {
    const unsupportedNode = {
      type: 'preproc_include',
      get children(): never[] {
        throw new Error('descendants should not be inspected');
      },
    };
    const root = {
      type: 'translation_unit',
      isNamed: true,
      hasError: false,
      isMissing: false,
      children: [unsupportedNode],
    } as unknown as Parameters<typeof emitCppCaptures>[0];
    expect(() => emitCppCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
  });

  it.each(['void broken( {', 'void broken() { return', 'void broken() { retained(; }'])(
    'refuses parser-error trees: %s',
    async (source) => {
      const { root } = await parse(source);
      expect(root.hasError).toBe(true);
      expect(() => emitCppCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
    },
  );
});

describe('production C++ capture bridge', () => {
  it('requires the borrowed root without reparsing', () => {
    const parseSpy = vi.spyOn(Parser.prototype, 'parse');
    const warning = vi.fn();
    try {
      expect(cppProvider.bindingScopeFor).toBe(cppDeclarationBindingScope);
      expect(cppProvider.interpretExports).toBe(interpretCppExports);
      expect(cppProvider.interpretImport!({})).toBeNull();
      expect(() => cppProvider.emitScopeCaptures!('void publicFunction() {}', filePath)).toThrow(
        'C++ scope captures require the borrowed root',
      );
      expect(
        extractParsedFileOutcome(cppProvider, 'void publicFunction() {}', filePath, warning),
      ).toEqual({
        status: 'failed',
        reason: 'scope-extraction-error',
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('C++ scope captures require the borrowed root'),
      );
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('uses the borrowed production root without reparsing', async () => {
    const source = 'void publicFunction() { publicFunction(); }';
    const { parser, root } = await parse(source);
    const parseSpy = vi.spyOn(parser, 'parse');
    const warning = vi.fn();
    try {
      expect(extractParsedFileOutcome(cppProvider, source, filePath, warning, root)).toEqual({
        status: 'success',
        parsedFile: extract(emitCppCaptures(root), filePath, hooks),
      });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('reports unsupported syntax with a file warning', async () => {
    const source = 'void retained() { retained(); } int value = 1;';
    const { root } = await parse(source);
    const warning = vi.fn();
    expect(extractParsedFileOutcome(cppProvider, source, filePath, warning, root)).toEqual({
      status: 'failed',
      reason: 'unsupported-syntax',
    });
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(filePath));
  });
});
