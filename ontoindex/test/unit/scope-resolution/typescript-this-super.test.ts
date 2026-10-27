import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import {
  emitTypeScriptMemberReadCaptures,
  emitTypeScriptReferenceCaptures,
  typeScriptSuperCallArguments,
  typeScriptThisMemberWriteValue,
} from '../../../src/core/ingestion/languages/typescript-reference-captures.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';

async function parse(source: string) {
  const parser = await createParserForLanguage(SupportedLanguages.TypeScript, 'fixture.ts');
  return parser.parse(source).rootNode;
}

describe('constructor this writes and super argument evaluations', () => {
  it('returns super operands once without inventing a super call reference', async () => {
    const root = await parse(
      'class Child extends Base { constructor(message: string) { super(message, format(message)); } }',
    );
    expect(root.hasError).toBe(false);
    const call = root.descendantsOfType('call_expression')[0]!;
    expect(typeScriptSuperCallArguments(call, true).map((node) => node.text)).toEqual([
      'message',
      'format(message)',
    ]);
    expect(() => emitTypeScriptReferenceCaptures(call)).toThrow(ScopeUnsupportedSyntaxError);
  });

  it.each([
    'super(value);',
    'function unrelated() { super(value); }',
    'class Child extends Base { method() { super(value); } }',
    'class Child extends Base { constructor() { if (ok) { super(value); } } }',
    'class Child extends Base { constructor() { super.method(value); } }',
    'class Child extends Base { constructor() { super(...values); } }',
  ])('refuses unsupported super context or syntax: %s', async (source) => {
    const root = await parse(source);
    const call = root.descendantsOfType('call_expression')[0]!;
    expect(call).toBeDefined();
    expect(() => typeScriptSuperCallArguments(call, true)).toThrow(ScopeUnsupportedSyntaxError);
  });

  it('requires caller-confirmed heritage', async () => {
    const root = await parse('class Child { constructor() { super(value); } }');
    const call = root.descendantsOfType('call_expression')[0]!;
    expect(() => typeScriptSuperCallArguments(call, false)).toThrow(ScopeUnsupportedSyntaxError);
  });

  it.each(['this.name = value', 'this.a.b = compute(value)'])(
    'returns only the RHS for %s',
    async (expression) => {
      const root = await parse(`class Child extends Base { constructor() { ${expression}; } }`);
      expect(root.hasError).toBe(false);
      const assignment = root.descendantsOfType('assignment_expression')[0]!;
      expect(typeScriptThisMemberWriteValue(assignment).text).toBe(expression.split(' = ')[1]);
      expect(() => emitTypeScriptMemberReadCaptures(assignment.childForFieldName('left')!)).toThrow(
        ScopeUnsupportedSyntaxError,
      );
    },
  );

  it.each([
    'this[k] = value',
    'this.a[k] = value',
    'this[k].a = value',
    'this.x += 1',
    'this.x++',
    'this?.x = value',
    'other.x = value',
  ])('refuses unsupported constructor write: %s', async (expression) => {
    const root = await parse(`class Child { constructor() { ${expression}; } }`);
    const statement = root.descendantsOfType('expression_statement')[0]!;
    expect(() => typeScriptThisMemberWriteValue(statement.namedChildren[0]!)).toThrow(
      ScopeUnsupportedSyntaxError,
    );
  });

  it('keeps this writes outside constructors and this reads unsupported', async () => {
    const root = await parse('class Child { method() { this.x = value; return this.x; } }');
    expect(() =>
      typeScriptThisMemberWriteValue(root.descendantsOfType('assignment_expression')[0]!),
    ).toThrow(ScopeUnsupportedSyntaxError);
    for (const member of root.descendantsOfType('member_expression')) {
      expect(() => emitTypeScriptMemberReadCaptures(member)).toThrow(ScopeUnsupportedSyntaxError);
    }
  });
});
