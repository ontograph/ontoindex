import { describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import Parser from 'tree-sitter';
import { pythonProvider } from '../../../src/core/ingestion/languages/python.js';
import {
  emitPythonCaptures,
  interpretPythonExports,
  pythonDeclarationBindingScope,
} from '../../../src/core/ingestion/languages/python-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { extractParsedFileOutcome } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';

const filePath = 'fixture.py';
const hooks = {
  bindingScopeFor: pythonDeclarationBindingScope,
  interpretExports: interpretPythonExports,
  interpretImport: () => null,
};

async function parse(source: string) {
  const parser = await createParserForLanguage(SupportedLanguages.Python, filePath);
  return { parser, root: parser.parse(source).rootNode };
}

describe('borrowed Python module captures', () => {
  it('binds public functions in the module and owns zero-argument calls in lexical scopes', async () => {
    const source = [
      '# module comment',
      'def first():',
      '    first() # self recursion',
      '    return 1',
      'pass',
      'first()',
      'def second():',
      '    # body comment',
      '    first()',
      '    return',
      'second()',
    ].join('\n');
    const { root } = await parse(source);
    expect(root.hasError).toBe(false);
    const result = extract(emitPythonCaptures(root), filePath, hooks);
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    const functions = result.scopes.filter((scope) => scope.kind === 'Function');
    expect(result.scopes.map((scope) => scope.kind)).toEqual(['Module', 'Function', 'Function']);
    expect(functions.map((scope) => scope.parent)).toEqual([module.id, module.id]);
    expect(result.localDefs).toEqual([
      {
        nodeId: 'def:fixture.py#2:0:Function:first',
        filePath,
        type: 'Function',
        qualifiedName: 'first',
      },
      {
        nodeId: 'def:fixture.py#7:0:Function:second',
        filePath,
        type: 'Function',
        qualifiedName: 'second',
      },
    ]);
    expect([...module.bindings]).toEqual(
      result.localDefs.map((def) => [def.qualifiedName, [{ def, origin: 'local' }]]),
    );
    expect(module.ownedDefs).toEqual([]);
    for (const [index, owner] of functions.entries()) {
      expect(owner.ownedDefs).toEqual([result.localDefs[index]]);
      expect([...owner.bindings]).toEqual([]);
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
      { name: 'first', inScope: functions[0]!.id, kind: 'call', callForm: 'free', arity: 0 },
      { name: 'first', inScope: module.id, kind: 'call', callForm: 'free', arity: 0 },
      { name: 'first', inScope: functions[1]!.id, kind: 'call', callForm: 'free', arity: 0 },
      { name: 'second', inScope: module.id, kind: 'call', callForm: 'free', arity: 0 },
    ]);
    expect(result.parsedImports).toEqual([]);
    expect(result.exports).toEqual(
      new Map(result.localDefs.map((def) => [def.qualifiedName!, def.nodeId])),
    );
  });

  it.each(['', '# comment only', '# first\n# second\n', 'pass\n'])(
    'accepts an empty module: %j',
    async (source) => {
      const { root } = await parse(source);
      const result = extract(emitPythonCaptures(root), filePath, hooks);
      expect(result.scopes.map((scope) => scope.kind)).toEqual(['Module']);
      expect(result.localDefs).toEqual([]);
      expect(result.referenceSites).toEqual([]);
      expect(result.exports).toEqual(new Map());
    },
  );

  it.each([
    'pass',
    'return',
    'return 0',
    'return 123',
    'return 1.5',
    'return True',
    'return False',
    'return None',
  ])('accepts a single function with a module-equal range and body %s', async (body) => {
    const { root } = await parse(`def public():\n    ${body}`);
    const result = extract(emitPythonCaptures(root), filePath, hooks);
    const module = result.scopes.find((scope) => scope.kind === 'Module')!;
    const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
    expect(owner.range).toEqual(module.range);
    expect(owner.parent).toBe(module.id);
    expect([...module.bindings.keys()]).toEqual(['public']);
    expect(result.exports).toEqual(new Map([['public', result.localDefs[0]!.nodeId]]));
    expect(result.referenceSites).toEqual([]);
  });

  it('detaches deterministic captures and extracted artifacts before parser reuse', async () => {
    const source = 'def first():\n    pass\ndef second():\n    first()\nsecond()';
    const { parser, root } = await parse(source);
    const captures = emitPythonCaptures(root);
    expect(emitPythonCaptures(root)).toEqual(captures);
    const saved = JSON.stringify(captures);
    const result = extract(captures, filePath, hooks);
    const detachedResult = structuredClone(result);
    parser.parse('def replacement():\n    return None');
    expect(JSON.stringify(captures)).toBe(saved);
    expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    expect(result).toEqual(detachedResult);
  });

  const unsupported = [
    'def bad(value):\n    pass',
    'def bad(value=1):\n    pass',
    'def bad(*args):\n    pass',
    'def bad() -> int:\n    pass',
    '@decorate\ndef bad():\n    pass',
    'async def bad():\n    pass',
    'def bad():\n    def nested():\n        pass',
    'class Bad:\n    pass',
    'import math',
    'from math import sqrt',
    'value = 1',
    'value: int',
    'def bad():\n    global value',
    'def bad():\n    nonlocal value',
    'if True:\n    pass',
    'def bad():\n    while True:\n        pass',
    'lambda: None',
    '[value for value in []]',
    'f"value"',
    '"module docstring"',
    'def bad():\n    "function docstring"',
    'def _private():\n    pass',
    'def café():\n    pass',
    'def bad():\n    return -1',
    'def bad():\n    return +1',
    'def bad():\n    return "text"',
    'def bad():\n    return 1j',
    'def bad():\n    return 2.5j',
    'def bad():\n',
    'def bad():\n    return retained()',
    'retained(1)',
    'retained(*[])',
    'retained(value=1)',
    'retained.other()',
    'print()',
    'missing()',
    'def bad():\n    missing()',
    'def bad():\n    later()\ndef later():\n    pass',
    'later()\ndef later():\n    pass',
    'def retained():\n    pass',
  ];

  it.each(unsupported)('rejects unsupported whole files atomically: %s', async (fragment) => {
    for (const source of [
      `def retained():\n    pass\n${fragment}`,
      `${fragment}\ndef retained():\n    pass`,
    ]) {
      const { root } = await parse(source);
      expect(() => emitPythonCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
    }
  });

  it.each(['def broken(:\n    pass', 'def broken():\n    return ('])(
    'rejects parser-error trees: %s',
    async (source) => {
      const { root } = await parse(source);
      expect(root.hasError).toBe(true);
      expect(() => emitPythonCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
    },
  );
});

describe('production Python capture bridge', () => {
  const provider = pythonProvider;

  it('requires a borrowed root without reparsing', () => {
    const parseSpy = vi.spyOn(Parser.prototype, 'parse');
    const warning = vi.fn();
    try {
      expect(provider.bindingScopeFor).toBe(pythonDeclarationBindingScope);
      expect(provider.interpretExports).toBe(interpretPythonExports);
      expect(provider.interpretImport!({})).toBeNull();
      expect(() => provider.emitScopeCaptures!('def public():\n    pass', filePath)).toThrow(
        'Python scope captures require the borrowed root',
      );
      expect(
        extractParsedFileOutcome(provider, 'def public():\n    pass', filePath, warning),
      ).toEqual({
        status: 'failed',
        reason: 'scope-extraction-error',
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('Python scope captures require the borrowed root'),
      );
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('extracts a borrowed root through the production provider without reparsing', async () => {
    const source = 'def public():\n    public()\npublic()';
    const { parser, root } = await parse(source);
    const parseSpy = vi.spyOn(parser, 'parse');
    const warning = vi.fn();
    try {
      expect(extractParsedFileOutcome(provider, source, filePath, warning, root)).toEqual({
        status: 'success',
        parsedFile: extract(emitPythonCaptures(root), filePath, hooks),
      });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('reports whole-file refusal through the production bridge', async () => {
    const source = 'def retained():\n    pass\nvalue = 1';
    const { root } = await parse(source);
    const warning = vi.fn();
    expect(extractParsedFileOutcome(provider, source, filePath, warning, root)).toEqual({
      status: 'failed',
      reason: 'unsupported-syntax',
    });
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(filePath));
  });
});
