import { describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import Parser from 'tree-sitter';
import { rustProvider } from '../../../src/core/ingestion/languages/rust.js';
import {
  emitRustCaptures,
  interpretRustExports,
  rustDeclarationBindingScope,
} from '../../../src/core/ingestion/languages/rust-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { extractParsedFileOutcome } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';
import { resolveReferences } from '../../../src/core/ingestion/resolve-references.js';

const filePath = 'fixture.rs';
const hooks = {
  bindingScopeFor: rustDeclarationBindingScope,
  interpretExports: interpretRustExports,
  interpretImport: () => null,
};

async function parse(source: string) {
  const parser = await createParserForLanguage(SupportedLanguages.Rust, filePath);
  return { parser, root: parser.parse(source).rootNode };
}

describe('borrowed Rust source file captures', () => {
  it('binds public and private functions in the module and resolves forward, self and prior calls', async () => {
    const source = [
      '// ordinary source comment',
      'pub fn first() { _second(); first(); return; }',
      'fn _second() { /* ordinary body comment */ first(); _second(); }',
    ].join('\n');
    const { root } = await parse(source);
    expect(root.hasError).toBe(false);
    const result = extract(emitRustCaptures(root), filePath, hooks);
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
      { filePath, type: 'Function', qualifiedName: '_second' },
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
      { name: '_second', inScope: blocks[0]!.id, kind: 'call', callForm: 'free', arity: 0 },
      { name: 'first', inScope: blocks[0]!.id, kind: 'call', callForm: 'free', arity: 0 },
      { name: 'first', inScope: blocks[1]!.id, kind: 'call', callForm: 'free', arity: 0 },
      { name: '_second', inScope: blocks[1]!.id, kind: 'call', callForm: 'free', arity: 0 },
    ]);
    expect(result.parsedImports).toEqual([]);
    expect(result.exports).toEqual(new Map([['first', result.localDefs[0]!.nodeId]]));
    const resolved = resolveReferences(finalizeScopeModel([result]));
    expect(resolved.stats).toEqual({
      totalSites: 4,
      resolvedSites: 4,
      unresolvedSites: 0,
      ambiguousSites: 0,
      unsupportedSites: 0,
    });
    expect(
      result.localDefs.map((def) => resolved.referenceIndex.byTargetDef.get(def.nodeId)?.length),
    ).toEqual([2, 2]);
  });

  it.each(['', '// comment only', '/* first */\n// second\n'])(
    'accepts an empty source file: %j',
    async (source) => {
      const { root } = await parse(source);
      const result = extract(emitRustCaptures(root), filePath, hooks);
      expect(result.scopes.map((scope) => scope.kind)).toEqual(['Module']);
      expect(result.localDefs).toEqual([]);
      expect(result.referenceSites).toEqual([]);
      expect(result.exports).toEqual(new Map());
    },
  );

  it.each(['', 'return;', '/* body */'])(
    'keeps coincident module/function ranges distinct: %s',
    async (body) => {
      const { root } = await parse(`pub fn public_function() { ${body} }`);
      const result = extract(emitRustCaptures(root), filePath, hooks);
      const module = result.scopes.find((scope) => scope.kind === 'Module')!;
      const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
      const block = result.scopes.find((scope) => scope.kind === 'Block')!;
      expect(owner.range).toEqual(module.range);
      expect(owner.parent).toBe(module.id);
      expect(block.parent).toBe(owner.id);
      expect([...module.bindings.keys()]).toEqual(['public_function']);
      expect(result.exports).toEqual(new Map([['public_function', result.localDefs[0]!.nodeId]]));
    },
  );

  it('keeps private declarations bound without exporting them', async () => {
    const { root } = await parse('fn private_function() {}');
    const result = extract(emitRustCaptures(root), filePath, hooks);
    expect([
      ...result.scopes.find((scope) => scope.id === result.moduleScope)!.bindings.keys(),
    ]).toEqual(['private_function']);
    expect(result.exports).toEqual(new Map());
  });

  it('detaches deterministic captures and results before parser reuse', async () => {
    const { parser, root } = await parse('pub fn first() { second(); } fn second() {}');
    const captures = emitRustCaptures(root);
    expect(emitRustCaptures(root)).toEqual(captures);
    const saved = JSON.stringify(captures);
    const result = extract(captures, filePath, hooks);
    const detachedResult = structuredClone(result);
    parser.parse('fn replacement() {}');
    expect(JSON.stringify(captures)).toBe(saved);
    expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    expect(result).toEqual(detachedResult);
  });

  const unsupported = [
    'fn r#raw() {}',
    'fn café() {}',
    'fn _() {}',
    'fn gen() {}',
    'fn default() {}',
    'fn union() {}',
    'fn bad(value: i32) {}',
    'fn bad() -> () {}',
    'fn bad<T>() {}',
    'pub(crate) fn bad() {}',
    'pub(super) fn bad() {}',
    'pub(self) fn bad() {}',
    'pub(in crate) fn bad() {}',
    '#[inline] fn bad() {}',
    '#![allow(dead_code)]',
    '/// documentation\nfn bad() {}',
    '/** documentation */ fn bad() {}',
    '//! inner documentation',
    '/*! inner documentation */',
    'async fn bad() {}',
    'unsafe fn bad() {}',
    'const fn bad() {}',
    'extern "C" fn bad() {}',
    'macro_rules! bad { () => {} }',
    'bad!();',
    'mod bad {}',
    'mod bad;',
    'use crate::retained;',
    'struct Bad;',
    'enum Bad {}',
    'trait Bad {}',
    'impl Bad {}',
    'type Bad = ();',
    'const BAD: () = ();',
    'static BAD: () = ();',
    'fn bad() { {} }',
    'fn bad() { let value = 1; }',
    'fn bad() { if true {} }',
    'fn bad() { retained(1); }',
    'fn bad() { object.method(); }',
    'fn bad() { crate::retained(); }',
    'fn bad() { missing(); }',
    'fn bad() { retained() }',
    'fn bad() { return retained(); }',
    'fn bad() { return (); }',
    'fn bad() { return; retained(); }',
    'fn bad() { return; return; }',
    'fn bad() { ; }',
    'fn retained() {}',
    ';',
    'retained();',
  ];

  it.each(unsupported)('refuses unsupported whole files atomically: %s', async (fragment) => {
    for (const source of [`fn retained() {}\n${fragment}`, `${fragment}\nfn retained() {}`]) {
      const { root } = await parse(source);
      expect(() => emitRustCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
    }
  });

  it.each(['fn broken( {', 'fn broken() { return', 'fn broken() { retained(; }'])(
    'refuses parser-error trees: %s',
    async (source) => {
      const { root } = await parse(source);
      expect(root.hasError).toBe(true);
      expect(() => emitRustCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
    },
  );
});

describe('production Rust capture bridge', () => {
  it('requires the borrowed root without reparsing', () => {
    const parseSpy = vi.spyOn(Parser.prototype, 'parse');
    const warning = vi.fn();
    try {
      expect(rustProvider.bindingScopeFor).toBe(rustDeclarationBindingScope);
      expect(rustProvider.interpretExports).toBe(interpretRustExports);
      expect(rustProvider.interpretImport!({})).toBeNull();
      expect(() =>
        rustProvider.emitScopeCaptures!('pub fn public_function() {}', filePath),
      ).toThrow('Rust scope captures require the borrowed root');
      expect(
        extractParsedFileOutcome(rustProvider, 'pub fn public_function() {}', filePath, warning),
      ).toEqual({
        status: 'failed',
        reason: 'scope-extraction-error',
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('Rust scope captures require the borrowed root'),
      );
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('uses the borrowed production root without reparsing', async () => {
    const source = 'pub fn public_function() { public_function(); }';
    const { parser, root } = await parse(source);
    const parseSpy = vi.spyOn(parser, 'parse');
    const warning = vi.fn();
    try {
      expect(extractParsedFileOutcome(rustProvider, source, filePath, warning, root)).toEqual({
        status: 'success',
        parsedFile: extract(emitRustCaptures(root), filePath, hooks),
      });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('reports atomic refusal without a per-file warning', async () => {
    const source = 'fn retained() { retained(); } const VALUE: i32 = 1;';
    const { root } = await parse(source);
    const warning = vi.fn();
    expect(extractParsedFileOutcome(rustProvider, source, filePath, warning, root)).toEqual({
      status: 'failed',
      reason: 'unsupported-syntax',
    });
    expect(warning).not.toHaveBeenCalled();
  });
});
