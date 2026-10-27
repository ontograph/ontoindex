import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import {
  emitTypeScriptMemberReadCaptures,
  emitTypeScriptReferenceCaptures,
} from '../../../src/core/ingestion/languages/typescript-reference-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';

async function parse(source: string, filePath = 'fixture.ts') {
  const parser = await createParserForLanguage(
    /\.jsx?$/.test(filePath) ? SupportedLanguages.JavaScript : SupportedLanguages.TypeScript,
    filePath,
  );
  return { parser, root: parser.parse(source).rootNode };
}

// Compare semantic identity while retaining range checks separately.
function identity(value: unknown) {
  return JSON.parse(JSON.stringify(value, (key, item) => (key === 'range' ? undefined : item)));
}

describe('validated TypeScript assertion receivers and optional member calls', () => {
  it.each(['fixture.ts', 'fixture.tsx'])(
    'preserves assertion receiver identity in %s',
    async (filePath) => {
      for (const [asserted, ordinary] of [
        ['(receiver as { readonly name: string }).name', 'receiver.name'],
        ['(receiver as string).length', 'receiver.length'],
        ['(x as T).method(arg)', 'x.method(arg)'],
        ['((ctx.providers as T)!).method(arg)', 'ctx.providers.method(arg)'],
        ['(factory(arg) as T).method()', 'factory(arg).method()'],
        ['(items[key] as T).method()', 'items[key].method()'],
      ]) {
        const { parser, root } = await parse(`${asserted};`, filePath);
        expect(root.hasError, asserted).toBe(false);
        const plain = await parse(`${ordinary};`, filePath);
        const actual = emitTypeScriptCaptures(root);
        const expected = emitTypeScriptCaptures(plain.root);
        expect(identity(actual), asserted).toEqual(identity(expected));
        const members = root.descendantsOfType('member_expression');
        const selected = asserted.includes('.method(')
          ? emitTypeScriptReferenceCaptures(root.descendantsOfType('call_expression')[0]!)
          : emitTypeScriptMemberReadCaptures(members[0]!);
        const receiver = selected[0]!['@reference.receiver']!;
        const member = asserted.includes('.method(')
          ? root.descendantsOfType('call_expression')[0]!.childForFieldName('function')!
          : members[0]!;
        const operand = member.childForFieldName('object')!;
        expect(receiver.range.startCol).toBe(operand.startPosition.column);
        expect(receiver.range.endCol).toBe(operand.endPosition.column);
        const saved = JSON.stringify(actual);
        parser.parse('replacement();');
        expect(JSON.stringify(actual)).toBe(saved);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'normalizes optional member calls in %s',
    async (filePath) => {
      for (const [source, ordinary] of [
        ['ctx.providers.arityCompatibility?.(args)', 'ctx.providers.arityCompatibility(args)'],
        ['ctx?.providers.method?.(args).next()', 'ctx.providers.method(args).next()'],
        ['ctx.method /* before */ ?. /* after */ (args)', 'ctx.method(args)'],
        ['obj?.method?.().field', 'obj.method().field'],
        ['obj.method?.().field', 'obj.method().field'],
        ['(obj.method?.()).field', '(obj.method()).field'],
        ['(obj?.field).method?.()', '(obj.field).method()'],
        ['prisma.user?.findMany?.()', 'prisma.user.findMany()'],
        ['supabase.from("bookings").select?.("*")', 'supabase.from("bookings").select("*")'],
        ['supabase?.from?.("bookings").select("*")', 'supabase.from("bookings").select("*")'],
        ['object?.method?.()', 'object.method()'],
        ['object.method?.()', 'object.method()'],
      ]) {
        const { root } = await parse(`${source};`, filePath);
        const plain = await parse(`${ordinary};`, filePath);
        expect(root.hasError).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        expect(identity(captures)).toEqual(identity(emitTypeScriptCaptures(plain.root)));
        const result = extract(captures, filePath, {});
        expect(
          result.referenceSites
            .filter((site) => site.kind === 'call')
            .every(
              (site) =>
                site.callForm === 'member' &&
                typeof site.arity === 'number' &&
                !!site.explicitReceiver,
            ),
        ).toBe(true);
      }
    },
  );

  it('keeps unsupported assertion types and receiver operands fail-closed', async () => {
    for (const source of [
      '(x as const).method();',
      '(x as T<U>).method();',
      '(x as T | U).method();',
      '(x as { method(): void }).method();',
      '(x as { [key: string]: T }).method();',
      '(x satisfies T).method();',
      '(<T>x).method();',
      '(1 as T).method();',
      '((x + y) as T).method();',
      '(x as).method();',
    ]) {
      const { root } = await parse(source);
      const call = root.descendantsOfType('call_expression')[0];
      expect(call, source).toBeDefined();
      expect(() => emitTypeScriptReferenceCaptures(call!), source).toThrow(
        ScopeUnsupportedSyntaxError,
      );
    }
  });

  it('keeps optional free/computed calls and complex spread operands refused', async () => {
    for (const source of [
      'local?.();',
      'object[key]?.();',
      'f(...group());',
      'a.push(...edges());',
      'a.push(first, ...ctx.edges());',
      'a.push?.(...edges());',
    ]) {
      const { root } = await parse(source);
      expect(root.hasError).toBe(false);
      const call = root.descendantsOfType('call_expression')[0]!;
      expect(() => emitTypeScriptReferenceCaptures(call), source).toThrow(
        ScopeUnsupportedSyntaxError,
      );
      expect(() => emitTypeScriptCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
    }
  });
});
