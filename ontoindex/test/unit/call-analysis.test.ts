import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { SupportedLanguages } from 'ontoindex-shared';
import {
  createParserForLanguage,
  isLanguageAvailable,
} from '../../src/core/tree-sitter/parser-loader.js';
import {
  extractMixedChain,
  extractReceiverName,
  extractReceiverNode,
} from '../../src/core/ingestion/utils/call-analysis.js';

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Swift))('Swift literal receiver', () => {
  it('preserves self as a simple receiver', async () => {
    const parser = await createParserForLanguage(SupportedLanguages.Swift);
    const tree = parser.parse('class Service { func run() { self.save() } }');
    const name = tree.rootNode
      .descendantsOfType('simple_identifier')
      .find((node) => node.text === 'save')!;

    expect(tree.rootNode.hasError).toBe(false);
    expect(extractReceiverNode(name)?.type).toBe('self_expression');
    expect(extractReceiverName(name)).toBe('self');
  });
});

describe('transparent receiver parentheses', () => {
  const extract = (receiver: string) => {
    const parser = new Parser();
    parser.setLanguage(TypeScript.typescript as Parser.Language);
    const tree = parser.parse(`${receiver}.save();`);
    const name = tree.rootNode
      .descendantsOfType('property_identifier')
      .find((node) => node.text === 'save')!;
    return { name, receiver: extractReceiverNode(name)! };
  };

  it.each(['value', '(value)', '(((value)))', '(/* receiver */ value)'])(
    'preserves a simple receiver: %s',
    (expression) => {
      expect(extractReceiverName(extract(expression).name)).toBe('value');
    },
  );

  it.each(['(value.child)', '((value)).child', '((value).child)'])(
    'preserves the base of a field chain: %s',
    (expression) => {
      expect(extractMixedChain(extract(expression).receiver)).toEqual({
        chain: [{ kind: 'field', name: 'child' }],
        baseReceiverName: 'value',
      });
    },
  );

  it('preserves the base beneath an intermediate call', () => {
    const result = extractMixedChain(extract('((value)).load()').receiver);
    expect(result?.baseReceiverName).toBe('value');
    expect(result?.chain.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: 'call', name: 'load' },
    ]);
  });

  it('keeps an over-depth field chain unresolved', () => {
    expect(extractMixedChain(extract('(value.a.b.c.d)').receiver)).toEqual({
      chain: [
        { kind: 'field', name: 'b' },
        { kind: 'field', name: 'c' },
        { kind: 'field', name: 'd' },
      ],
      baseReceiverName: undefined,
    });
  });

  it.each([
    '(value as Service)',
    '(<Service>value)',
    '(value!)',
    '(value, other)',
    '(value || other)',
  ])('does not infer a simple receiver through a nontransparent expression: %s', (expression) => {
    expect(extractReceiverName(extract(expression).name)).toBeUndefined();
    expect(extractMixedChain(extract(expression).receiver)).toBeUndefined();
  });

  it('bounds deeply nested parentheses', () => {
    const expression = `${'('.repeat(33)}value${')'.repeat(33)}`;
    expect(extractReceiverName(extract(expression).name)).toBeUndefined();
    expect(extractMixedChain(extract(expression).receiver)).toBeUndefined();
  });

  it('rejects a malformed parenthesized receiver', () => {
    const { receiver } = extract('(value)');
    expect(
      extractMixedChain({
        ...receiver,
        type: 'parenthesized_expression',
        hasError: true,
      } as Parser.SyntaxNode),
    ).toBeUndefined();
  });
});
