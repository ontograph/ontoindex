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

const filePaths = ['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'];
const hooks = {
  bindingScopeFor: typeScriptDeclarationBindingScope,
  declarationNamespaceFor: typeScriptDeclarationNamespace,
  selectLocalBindings: selectTypeScriptLocalBindings,
};

async function parse(source: string, filePath = 'fixture.ts') {
  const language = /\.jsx?$/.test(filePath)
    ? SupportedLanguages.JavaScript
    : SupportedLanguages.TypeScript;
  const parser = await createParserForLanguage(language, filePath);
  return { parser, root: parser.parse(source).rootNode };
}

describe.each(filePaths)('literal receivers and binary admission in %s', (filePath) => {
  it.each([
    '<',
    '<=',
    '>',
    '>=',
    '==',
    '!=',
    '===',
    '!==',
    '-',
    '*',
    '/',
    '+',
    '%',
    '**',
    '<<',
    '>>',
    '>>>',
    '&',
    '|',
    '^',
    '&&',
    '||',
    '??',
    'in',
    'instanceof',
  ])('reads both operands of binary %s exactly once', async (operator) => {
    const { root } = await parse(`const result = a ${operator} b;`, filePath);
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
    expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
      ['a', 'read'],
      ['b', 'read'],
    ]);
  });

  it('reads the constructor operand of instanceof', async () => {
    const { root } = await parse('const result = a instanceof Error;', filePath);
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
    expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
      ['a', 'read'],
      ['Error', 'read'],
    ]);
  });

  it.each([
    {
      expression: "[a, b].join(',')",
      references: [
        ['join', 'call'],
        ['a', 'read'],
        ['b', 'read'],
      ],
    },
    {
      expression: '/x/.test(a)',
      references: [
        ['test', 'call'],
        ['a', 'read'],
      ],
    },
    { expression: '"s".length', references: [['length', 'read']] },
    {
      expression: '`x${a}`.length',
      references: [
        ['length', 'read'],
        ['a', 'read'],
      ],
    },
    { expression: '(1).toString()', references: [['toString', 'call']] },
    {
      expression: '[a].map(x => x)',
      references: [
        ['map', 'call'],
        ['a', 'read'],
        ['x', 'read'],
      ],
    },
  ])('captures literal receiver evaluations: $expression', async ({ expression, references }) => {
    const { root } = await parse(`const result = ${expression};`, filePath);
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
    expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual(references);
    expect(result.referenceSites[0]!.explicitReceiver).toEqual({ kind: 'unknown' });
    expect(result.referenceSites.slice(1).map((site) => site.explicitReceiver)).toEqual(
      references.slice(1).map(() => undefined),
    );
  });

  it.each([
    'const result = [a, ,b].join();',
    'const result = [delete a].join();',
    'function f() { const result = new.target; }',
    'const result = -a ** b;',
  ])('refuses unsupported syntax atomically: %s', async (statement) => {
    const { root } = await parse(`before(); ${statement} after();`, filePath);
    expect(root.hasError).toBe(false);
    expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
  });

  it('refuses a malformed instanceof expression before emitting captures', async () => {
    const { root } = await parse('before(); const result = a instanceof; after();', filePath);
    expect(root.hasError).toBe(true);
    expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
  });
});
