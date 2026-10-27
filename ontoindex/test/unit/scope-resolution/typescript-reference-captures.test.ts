import { describe, expect, it } from 'vitest';
import type { SyntaxNode } from 'tree-sitter';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import {
  emitTypeScriptIdentifierReadCapture,
  emitTypeScriptMemberReadCaptures,
  emitTypeScriptReferenceCaptures,
  emitTypeScriptReferenceCapturesForFile,
} from '../../../src/core/ingestion/languages/typescript-reference-captures.js';
import { emitTypeScriptLexicalScopeCaptures } from '../../../src/core/ingestion/languages/typescript-scope-captures.js';
import { emitTypeScriptDeclarationCaptures } from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';

async function parse(source: string, filePath: string) {
  const parser = await createParserForLanguage(
    /\.jsx?$/.test(filePath) ? SupportedLanguages.JavaScript : SupportedLanguages.TypeScript,
    filePath,
  );
  return { parser, root: parser.parse(source).rootNode };
}

function rangeOf(node: SyntaxNode) {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}

describe('borrowed TS/JS ordinary free call reference captures', () => {
  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'counts supported spread operands once in direct, nested and receiver calls in %s',
    async (filePath) => {
      for (const expression of [
        'prisma.user.findMany(...values)',
        'supabase.from(...values).select("*")',
        'first(other(...values))',
        'object.method(...values)',
        'new Local(...values)',
        'local(...values)',
        'a.push(first, ...ctx.edges)',
        'a.push?.(...values)',
      ]) {
        const { root } = await parse(`${expression};`, filePath);
        expect(root.hasError, expression).toBe(false);
        const calls = root.descendantsOfType(['call_expression', 'new_expression']);
        const captures = emitTypeScriptReferenceCapturesForFile(root);
        for (const call of calls) {
          const selected = emitTypeScriptReferenceCaptures(call)[0]!;
          expect(selected['@reference.arity']!.text, expression).toBe(
            String(call.childForFieldName('arguments')!.namedChildCount),
          );
          expect(captures, expression).toContainEqual(selected);
        }
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches optional property calls with ordinary static receiver steps in %s',
    async (filePath) => {
      for (const expression of [
        'obj?.method(arg)',
        'obj?.method(arg).field',
        'obj?.child.method(arg).next(outer)',
        '(obj?.child).method(arg)',
        "filePath.split('.').pop()?.toLowerCase()",
      ]) {
        const { parser, root } = await parse(`${expression};`, filePath);
        expect(root.hasError, expression).toBe(false);
        const nodes = root.descendantsOfType(['call_expression', 'member_expression']);
        const captures = emitTypeScriptReferenceCapturesForFile(root);
        const calls = root.descendantsOfType('call_expression');
        expect(
          captures
            .filter((capture) => capture['@reference.call.member'])
            .map((capture) => ({
              name: capture['@reference.name']!.text,
              range: capture['@reference.call.member']!.range,
              arity: capture['@reference.arity']!.text,
            })),
        ).toEqual(
          calls.map((call) => ({
            name: call.childForFieldName('function')!.childForFieldName('property')!.text,
            range: rangeOf(call),
            arity: String(call.childForFieldName('arguments')!.namedChildCount),
          })),
        );
        for (const capture of captures.filter((capture) => capture['@reference.receiver'])) {
          const anchor = capture['@reference.call.member'] ?? capture['@reference.read']!;
          const node = nodes.find(
            (node) => JSON.stringify(rangeOf(node)) === JSON.stringify(anchor.range),
          )!;
          const member =
            node.type === 'call_expression' ? node.childForFieldName('function')! : node;
          expect(capture['@reference.name']!.range).toEqual(
            rangeOf(member.childForFieldName('property')!),
          );
          expect(capture['@reference.receiver']!.range).toEqual(
            rangeOf(member.childForFieldName('object')!),
          );
          const receiver = capture['@reference.receiver']!.receiver;
          if (receiver?.kind === 'chain') {
            expect(
              receiver.steps.every((step) => step.kind === 'member' || step.kind === 'call'),
            ).toBe(true);
            expect(JSON.stringify(receiver)).not.toContain('optional');
          }
        }
        const ordinary = await parse(`${expression.replaceAll('?.', '.')};`, filePath);
        const identity = (matches: typeof captures) =>
          matches.map((capture) => ({
            name: capture['@reference.name']!.text,
            arity: capture['@reference.arity']?.text,
            receiver:
              capture['@reference.receiver']?.receiver ?? capture['@reference.receiver']?.text,
          }));
        const withoutRanges = (value: unknown) =>
          JSON.parse(JSON.stringify(value, (key, item) => (key === 'range' ? undefined : item)));
        expect(withoutRanges(identity(captures))).toEqual(
          withoutRanges(identity(emitTypeScriptReferenceCapturesForFile(ordinary.root))),
        );
        const saved = JSON.stringify(captures);
        const scopes = emitTypeScriptLexicalScopeCaptures(root);
        const result = extract([...scopes, ...captures], filePath, {});
        parser.parse('replacement();');
        expect(JSON.stringify(captures)).toBe(saved);
        expect(extract([...scopes, ...JSON.parse(saved)], filePath, {})).toEqual(result);
      }
      for (const count of [64, 65]) {
        const { root } = await parse(`obj${'?.child'.repeat(count)}.method();`, filePath);
        const call = root.descendantsOfType('call_expression')[0]!;
        if (count === 64) expect(emitTypeScriptReferenceCaptures(call)).toHaveLength(66);
        else
          expect(() => emitTypeScriptReferenceCaptures(call)).toThrow(ScopeUnsupportedSyntaxError);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches optional read spines with static receiver identity in %s',
    async (filePath) => {
      for (const expression of [
        'obj?.field',
        'obj?.child.field',
        'obj.child?.field',
        '(/* receiver */ obj?.child)?.field',
        '(obj?.child).field',
      ]) {
        const { parser, root } = await parse(`${expression};`, filePath);
        expect(root.hasError, expression).toBe(false);
        const members = root.descendantsOfType('member_expression');
        const captures = emitTypeScriptMemberReadCaptures(members[0]!);
        expect(
          captures.map((match) => [
            match['@reference.name']!.text,
            match['@reference.read']!.range,
          ]),
        ).toEqual([
          ...members.map((member) => [member.childForFieldName('property')!.text, rangeOf(member)]),
          ['obj', rangeOf(root.descendantsOfType('identifier')[0]!)],
        ]);
        for (const [index, member] of members.entries()) {
          const object = member.childForFieldName('object')!;
          expect(captures[index]!['@reference.receiver']!.range).toEqual(rangeOf(object));
          if (index === members.length - 1) {
            expect(captures[index]!['@reference.receiver']!.text).toBe('obj');
          } else {
            expect(captures[index]!['@reference.receiver']!.receiver).toEqual({
              kind: 'chain',
              root: { name: 'obj', range: rangeOf(root.descendantsOfType('identifier')[0]!) },
              steps: [
                {
                  kind: 'member',
                  name: 'child',
                  range: rangeOf(members[1]!.childForFieldName('property')!),
                },
              ],
            });
          }
        }
        const saved = JSON.stringify(captures);
        const independent = emitTypeScriptMemberReadCaptures(members[0]!);
        captures[0]!['@reference.receiver']!.range.startCol = 999;
        parser.parse('replacement();');
        expect(JSON.stringify(independent)).toBe(saved);
      }
      for (const count of [64, 65]) {
        const { root } = await parse(`obj${'?.field'.repeat(count)};`, filePath);
        const member = root.descendantsOfType('member_expression')[0]!;
        expect(root.hasError).toBe(false);
        if (count === 64) expect(emitTypeScriptMemberReadCaptures(member)).toHaveLength(65);
        else
          expect(() => emitTypeScriptMemberReadCaptures(member)).toThrow(
            ScopeUnsupportedSyntaxError,
          );
      }
      for (const expression of ['factory?.().field']) {
        const { root } = await parse(`${expression};`, filePath);
        expect(root.hasError, expression).toBe(false);
        const node = root.namedChildren[0]!.namedChildren[0]!;
        expect(
          () =>
            node.type === 'call_expression'
              ? emitTypeScriptReferenceCaptures(node)
              : emitTypeScriptMemberReadCaptures(node),
          expression,
        ).toThrow(ScopeUnsupportedSyntaxError);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches transparent and dynamic parenthesized receivers in %s',
    async (filePath) => {
      for (const expression of [
        '((/* receiver */ café)).μέλος()',
        '(café(/* argument */ arg)).child.μέλος()',
        '(/* left */ café ?? autre /* right */).μέλος()',
        '((café ?? autre).child).μέλος()',
        '((café ?? autre).child()).μέλος()',
      ]) {
        const { parser, root } = await parse(`${expression};`, filePath);
        expect(root.hasError, expression).toBe(false);
        const call = root.descendantsOfType('call_expression')[0]!;
        const callee = call.childForFieldName('function')!;
        const object = callee.childForFieldName('object')!;
        const matches = emitTypeScriptReferenceCaptures(call);
        expect(matches[0]!['@reference.call.member']).toEqual({
          name: '@reference.call.member',
          text: '',
          range: rangeOf(call),
        });
        expect(matches[0]!['@reference.name']).toEqual({
          name: '@reference.name',
          text: 'μέλος',
          range: rangeOf(callee.childForFieldName('property')!),
        });
        expect(matches[0]!['@reference.receiver']!.range).toEqual(rangeOf(object));
        if (expression.includes('??')) {
          expect(matches[0]!['@reference.receiver']).toEqual({
            name: '@reference.receiver',
            text: '',
            range: rangeOf(object),
            receiver: { kind: 'unknown' },
          });
          expect(matches.map((match) => match['@reference.name']!.text)).toEqual(
            expression === '((café ?? autre).child).μέλος()' ? ['μέλος', 'child'] : ['μέλος'],
          );
        } else if (expression.includes('arg')) {
          const inner = root.descendantsOfType('call_expression')[1]!;
          const member = object;
          expect(matches[0]!['@reference.receiver']!.receiver).toEqual({
            kind: 'chain',
            root: { name: 'café', range: rangeOf(inner.childForFieldName('function')!) },
            steps: [
              { kind: 'call', arity: 1, range: rangeOf(inner) },
              {
                kind: 'member',
                name: 'child',
                range: rangeOf(member.childForFieldName('property')!),
              },
            ],
          });
        } else {
          expect(matches[0]!['@reference.receiver']!.text).toBe('café');
          expect(matches[0]!['@reference.receiver']!.receiver).toBeUndefined();
          expect(matches[1]!['@reference.name']).toEqual({
            name: '@reference.name',
            text: 'café',
            range: rangeOf(root.descendantsOfType('identifier')[0]!),
          });
        }
        const saved = JSON.stringify(matches);
        const scopes = emitTypeScriptLexicalScopeCaptures(root);
        const expected = extract([...scopes, ...matches], filePath, {});
        parser.parse('replacement();');
        expect(JSON.stringify(matches)).toBe(saved);
        expect(extract([...scopes, ...JSON.parse(saved)], filePath, {})).toEqual(expected);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches conditional receivers as unknown without borrowing either branch in %s',
    async (filePath) => {
      for (const expression of [
        '(condition ? left : right).method(outer)',
        '((/* condition */ condition ? left : right)).field',
        '((condition ? first(arg) : second(arg)).child()).method(outer)',
        '(condition ? (nested ? left : right) : (left ?? right)).child.field',
        '(factory() ? first : second).field',
      ]) {
        const { parser, root } = await parse(`${expression};`, filePath);
        expect(root.hasError, expression).toBe(false);
        const node = root.namedChildren[0]!.namedChildren[0]!;
        const isCall = node.type === 'call_expression';
        const member = isCall ? node.childForFieldName('function')! : node;
        const object = member.childForFieldName('object')!;
        const property = member.childForFieldName('property')!;
        const captures = isCall
          ? emitTypeScriptReferenceCaptures(node)
          : emitTypeScriptMemberReadCaptures(node);
        const anchor = isCall ? '@reference.call.member' : '@reference.read';
        const expected = {
          [anchor]: { name: anchor, text: '', range: rangeOf(node) },
          '@reference.name': {
            name: '@reference.name',
            text: property.text,
            range: rangeOf(property),
          },
          '@reference.receiver': {
            name: '@reference.receiver',
            text: '',
            range: rangeOf(object),
            receiver: { kind: 'unknown' },
          },
          ...(isCall
            ? {
                '@reference.arity': {
                  name: '@reference.arity',
                  text: '1',
                  range: rangeOf(node.childForFieldName('arguments')!),
                },
              }
            : {}),
        };
        expect(captures[0], expression).toEqual(expected);
        if (expression.endsWith('.child.field')) {
          expect(captures).toEqual([
            expected,
            {
              '@reference.read': { name: '@reference.read', text: '', range: rangeOf(object) },
              '@reference.name': {
                name: '@reference.name',
                text: 'child',
                range: rangeOf(object.childForFieldName('property')!),
              },
              '@reference.receiver': {
                name: '@reference.receiver',
                text: '',
                range: rangeOf(object.childForFieldName('object')!),
                receiver: { kind: 'unknown' },
              },
            },
          ]);
        } else expect(captures).toHaveLength(1);
        const saved = JSON.stringify(captures);
        const scopes = emitTypeScriptLexicalScopeCaptures(root);
        const extracted = extract([...scopes, ...captures], filePath, {});
        const independent = isCall
          ? emitTypeScriptReferenceCaptures(node)
          : emitTypeScriptMemberReadCaptures(node);
        captures[0]!['@reference.receiver']!.range.startCol = 999;
        parser.parse('replacement();');
        expect(JSON.stringify(independent), expression).toBe(saved);
        expect(extract([...scopes, ...JSON.parse(saved)], filePath, {})).toEqual(extracted);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'keeps parentheses transparent at existing receiver ceilings in %s',
    async (filePath) => {
      const grouped = `${'('.repeat(128)}obj${')'.repeat(128)}`;
      for (const expression of [
        `${grouped}.method()`,
        `${grouped}.field`,
        '(factory()).field',
        '(obj).child.field',
      ]) {
        const { root } = await parse(`${expression};`, filePath);
        expect(root.hasError, expression).toBe(false);
        const node = root.namedChildren[0]!.namedChildren[0]!;
        expect(
          () =>
            node.type === 'member_expression'
              ? emitTypeScriptMemberReadCaptures(node)
              : emitTypeScriptReferenceCaptures(node),
          expression,
        ).not.toThrow();
      }
      for (const count of [64, 65]) {
        const { root } = await parse(`((obj))${'.field'.repeat(count)};`, filePath);
        const node = root.descendantsOfType('member_expression')[0]!;
        if (count === 64) expect(emitTypeScriptMemberReadCaptures(node)).toHaveLength(65);
        else
          expect(() => emitTypeScriptMemberReadCaptures(node)).toThrow(ScopeUnsupportedSyntaxError);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches direct member reads with independent exact ranges in %s',
    async (filePath) => {
      const { parser, root } = await parse('café /* receiver */ . /* property */ μέλος;', filePath);
      expect(root.hasError).toBe(false);
      const member = root.descendantsOfType('member_expression')[0]!;
      const receiver = member.childForFieldName('object')!;
      const property = member.childForFieldName('property')!;
      const matches = emitTypeScriptMemberReadCaptures(member);
      expect(matches).toEqual([
        {
          '@reference.read': { name: '@reference.read', text: '', range: rangeOf(member) },
          '@reference.name': {
            name: '@reference.name',
            text: property.text,
            range: rangeOf(property),
          },
          '@reference.receiver': {
            name: '@reference.receiver',
            text: receiver.text,
            range: rangeOf(receiver),
          },
        },
        ...emitTypeScriptIdentifierReadCapture(receiver),
      ]);
      expect(
        new Set(matches.flatMap((match) => Object.values(match).map((item) => item.range))).size,
      ).toBe(5);
      const detached = emitTypeScriptMemberReadCaptures(member);
      const scopes = emitTypeScriptLexicalScopeCaptures(root);
      const saved = JSON.stringify(detached);
      matches[0]!['@reference.receiver']!.range.startCol = 999;
      expect(matches[1]!['@reference.name']!.range).toEqual(rangeOf(receiver));
      parser.parse('replacement();');
      expect(JSON.stringify(detached)).toBe(saved);
      const result = extract([...scopes, ...JSON.parse(saved)], filePath, {});
      expect(result.referenceSites).toEqual([
        {
          name: 'μέλος',
          kind: 'read',
          atRange: detached[0]!['@reference.read']!.range,
          inScope: result.moduleScope,
          explicitReceiver: { name: 'café' },
        },
        {
          name: 'café',
          kind: 'read',
          atRange: detached[1]!['@reference.read']!.range,
          inScope: result.moduleScope,
        },
      ]);
      for (const source of [
        'obj?.[key].field;',
        'new Factory().field;',
        'this.field;',
        'obj[key];',
        'obj.#field;',
        'factory()().child.field;',
        '(obj?.[key]).child.field;',
        'undefined.child.field;',
      ]) {
        const parsed = await parse(source, filePath);
        expect(parsed.root.hasError, source).toBe(false);
        expect(
          () => emitTypeScriptMemberReadCaptures(parsed.root.namedChildren[0]!.namedChildren[0]!),
          source,
        ).toThrow(ScopeUnsupportedSyntaxError);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches call-result property prefixes without claiming the terminal call in %s',
    async (filePath) => {
      const source =
        'function owner() { return café(/* argument */ arg) /* receiver */ . enfant /* property */ . μέλος; }';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const [outer, inner] = root.descendantsOfType('member_expression');
      const call = inner!.childForFieldName('object')!;
      const callee = call.childForFieldName('function')!;
      const terminal = {
        kind: 'chain',
        root: { name: 'café', range: rangeOf(callee) },
        steps: [{ kind: 'call', arity: 1, range: rangeOf(call) }],
      };
      const captures = emitTypeScriptMemberReadCaptures(outer!);
      expect(captures).toEqual([
        {
          '@reference.read': { name: '@reference.read', text: '', range: rangeOf(outer!) },
          '@reference.name': {
            name: '@reference.name',
            text: 'μέλος',
            range: rangeOf(outer!.childForFieldName('property')!),
          },
          '@reference.receiver': {
            name: '@reference.receiver',
            text: '',
            range: rangeOf(inner!),
            receiver: {
              ...terminal,
              steps: [
                ...terminal.steps,
                {
                  kind: 'member',
                  name: 'enfant',
                  range: rangeOf(inner!.childForFieldName('property')!),
                },
              ],
            },
          },
        },
        {
          '@reference.read': { name: '@reference.read', text: '', range: rangeOf(inner!) },
          '@reference.name': {
            name: '@reference.name',
            text: 'enfant',
            range: rangeOf(inner!.childForFieldName('property')!),
          },
          '@reference.receiver': {
            name: '@reference.receiver',
            text: '',
            range: rangeOf(call),
            receiver: terminal,
          },
        },
      ]);
      const saved = JSON.stringify(captures);
      const fresh = emitTypeScriptMemberReadCaptures(outer!);
      const chain = captures[0]!['@reference.receiver']!.receiver!;
      if (chain.kind !== 'chain') throw new Error('Expected chain receiver');
      chain.root.range.startCol = 999;
      chain.steps[0]!.range.startCol = 999;
      expect(captures[1]!['@reference.receiver']!.receiver).toEqual(terminal);
      const result = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...JSON.parse(saved)],
        filePath,
        {},
      );
      const body = result.scopes.find((scope) => scope.kind === 'Block')!;
      expect(result.referenceSites).toEqual([
        {
          name: 'μέλος',
          kind: 'read',
          atRange: rangeOf(outer!),
          inScope: body.id,
          explicitReceiver: JSON.parse(saved)[0]['@reference.receiver'].receiver,
        },
        {
          name: 'enfant',
          kind: 'read',
          atRange: rangeOf(inner!),
          inScope: body.id,
          explicitReceiver: terminal,
        },
      ]);
      parser.parse('replacement();');
      expect(JSON.stringify(fresh)).toBe(saved);
      for (const count of [64, 65]) {
        const parsed = await parse(`factory()${'.field'.repeat(count)};`, filePath);
        const member = parsed.root.descendantsOfType('member_expression')[0]!;
        expect(parsed.root.hasError).toBe(false);
        if (count === 64) expect(emitTypeScriptMemberReadCaptures(member)).toHaveLength(64);
        else
          expect(() => emitTypeScriptMemberReadCaptures(member)).toThrow(
            ScopeUnsupportedSyntaxError,
          );
        const receiver = await parse(`root${'.method'.repeat(count - 1)}().field;`, filePath);
        expect(receiver.root.hasError).toBe(false);
        const outer = receiver.root.descendantsOfType('member_expression')[0]!;
        if (count === 64) expect(emitTypeScriptMemberReadCaptures(outer)).toHaveLength(1);
        else
          expect(() => emitTypeScriptMemberReadCaptures(outer)).toThrow(
            ScopeUnsupportedSyntaxError,
          );
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches bounded pure member spines and preserves their reads in %s',
    async (filePath) => {
      const source =
        'function owner(café) { return obj /* root */ . enfant /* middle */ . field; }';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const [outer, inner] = root.descendantsOfType('member_expression');
      const captures = emitTypeScriptMemberReadCaptures(outer!);
      expect(
        captures.map((match) => [
          match['@reference.name']!.text,
          match['@reference.read']!.range,
          match['@reference.name']!.range,
        ]),
      ).toEqual([
        ['field', rangeOf(outer!), rangeOf(outer!.childForFieldName('property')!)],
        ['enfant', rangeOf(inner!), rangeOf(inner!.childForFieldName('property')!)],
        [
          'obj',
          rangeOf(inner!.childForFieldName('object')!),
          rangeOf(inner!.childForFieldName('object')!),
        ],
      ]);
      const nestedReceiver = captures[0]!['@reference.receiver']!.receiver!;
      if (nestedReceiver.kind !== 'chain') throw new Error('Expected chain receiver');
      expect(nestedReceiver).toEqual({
        kind: 'chain',
        root: { name: 'obj', range: rangeOf(inner!.childForFieldName('object')!) },
        steps: [
          { kind: 'member', name: 'enfant', range: rangeOf(inner!.childForFieldName('property')!) },
        ],
      });
      const saved = JSON.stringify(captures);
      nestedReceiver.root.range.startCol = 999;
      nestedReceiver.steps[0]!.range.startCol = 999;
      expect(captures[2]!['@reference.name']!.range).toEqual(
        rangeOf(inner!.childForFieldName('object')!),
      );
      const fresh = emitTypeScriptMemberReadCaptures(outer!);
      expect(JSON.parse(JSON.stringify(fresh))).toEqual(JSON.parse(saved));
      const extracted = extract(
        [...emitTypeScriptLexicalScopeCaptures(root), ...fresh],
        filePath,
        {},
      );
      expect(
        extracted.referenceSites.map(({ name, kind, explicitReceiver }) => ({
          name,
          kind,
          explicitReceiver,
        })),
      ).toEqual([
        {
          name: 'field',
          kind: 'read',
          explicitReceiver: {
            kind: 'chain',
            root: { name: 'obj', range: rangeOf(inner!.childForFieldName('object')!) },
            steps: [
              {
                kind: 'member',
                name: 'enfant',
                range: rangeOf(inner!.childForFieldName('property')!),
              },
            ],
          },
        },
        { name: 'enfant', kind: 'read', explicitReceiver: { name: 'obj' } },
        { name: 'obj', kind: 'read', explicitReceiver: undefined },
      ]);
      parser.parse('replacement();');
      expect(JSON.stringify(fresh)).toBe(saved);

      for (const count of [64, 65]) {
        const parsed = await parse(`root${'.field'.repeat(count)};`, filePath);
        const member = parsed.root.descendantsOfType('member_expression')[0]!;
        if (count === 64) expect(emitTypeScriptMemberReadCaptures(member)).toHaveLength(65);
        else
          expect(() => emitTypeScriptMemberReadCaptures(member)).toThrow(
            ScopeUnsupportedSyntaxError,
          );
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches identifier reads and refuses other syntax in %s',
    async (filePath) => {
      const { parser, root } = await parse('function owner(café) { return ((café)); }', filePath);
      expect(root.hasError).toBe(false);
      const name = root.descendantsOfType('identifier').at(-1)!;
      const matches = emitTypeScriptIdentifierReadCapture(name);
      expect(matches).toEqual([
        {
          '@reference.read': { name: '@reference.read', text: '', range: rangeOf(name) },
          '@reference.name': { name: '@reference.name', text: 'café', range: rangeOf(name) },
        },
      ]);
      const detached = emitTypeScriptIdentifierReadCapture(name);
      const saved = JSON.stringify(detached);
      expect(matches[0]!['@reference.read']!.range).not.toBe(matches[0]!['@reference.name']!.range);
      for (const key of Object.keys(matches[0]!)) {
        expect(matches[0]![key]!.range).not.toBe(detached[0]![key]!.range);
      }
      matches[0]!['@reference.read']!.range.startLine = 999;
      expect(matches[0]!['@reference.name']!.range).toEqual(rangeOf(name));
      parser.parse('replacement();');
      expect(JSON.stringify(detached)).toBe(saved);
      for (const source of ['1;', 'object.member;', '((value));', String.raw`\u0076alue;`]) {
        const parsed = await parse(source, filePath);
        const expression = parsed.root.namedChildren[0]!.namedChildren[0]!;
        expect(() => emitTypeScriptIdentifierReadCapture(expression), source).toThrow();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'collects supported file calls once in preorder with detached captures in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        'first(new Café, receiver.save(inner())); function outer(value = initial()) { last(); }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const matches = emitTypeScriptReferenceCapturesForFile(root);
      expect(matches).toEqual(
        root
          .descendantsOfType(['call_expression', 'new_expression'])
          .flatMap(emitTypeScriptReferenceCaptures),
      );
      expect(
        matches.map((match) => [match['@reference.name']!.text, match['@reference.arity']?.text]),
      ).toEqual([
        ['first', '2'],
        ['Café', '0'],
        ['save', '1'],
        ['receiver', undefined],
        ['inner', '0'],
        ['initial', '0'],
        ['last', '0'],
      ]);
      const anchors = matches.map(
        (match) =>
          Object.entries(match).find(
            ([key]) => key.startsWith('@reference.call.') || key === '@reference.read',
          )![1],
      );
      expect(new Set(anchors.map((item) => JSON.stringify(item.range))).size).toBe(7);
      const inputs = [
        ...emitTypeScriptLexicalScopeCaptures(root),
        ...root
          .descendantsOfType('function_declaration')
          .flatMap(emitTypeScriptDeclarationCaptures),
      ];
      const baseline = extract(inputs, filePath, {});
      const saved = JSON.stringify(matches);
      const detached = emitTypeScriptReferenceCapturesForFile(root);
      for (const [index, match] of matches.entries()) {
        for (const [key, item] of Object.entries(match)) {
          expect(item.range).not.toBe(detached[index]![key]!.range);
        }
      }
      parser.parse('replacement();');
      expect(JSON.stringify(matches)).toBe(saved);
      expect(JSON.stringify(detached)).toBe(saved);
      const result = extract([...inputs, ...detached], filePath, {});
      const functionScope = baseline.scopes.find((scope) => scope.kind === 'Function')!;
      const body = baseline.scopes.find((scope) => scope.kind === 'Block')!;
      expect(result.referenceSites.map((site) => site.inScope)).toEqual([
        baseline.moduleScope,
        baseline.moduleScope,
        baseline.moduleScope,
        baseline.moduleScope,
        baseline.moduleScope,
        functionScope.id,
        body.id,
      ]);
      expect(result.referenceSites.map((site) => site.callForm)).toEqual([
        'free',
        'constructor',
        'member',
        undefined,
        'free',
        'free',
        'free',
      ]);
      expect(result.referenceSites[3]).toEqual({
        name: 'receiver',
        atRange: matches[3]!['@reference.read']!.range,
        inScope: baseline.moduleScope,
        kind: 'read',
      });
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
      for (const source of ['', '/* no calls */', 'const value = 1;']) {
        const parsed = await parse(source, filePath);
        expect(emitTypeScriptReferenceCapturesForFile(parsed.root)).toEqual([]);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'refuses unsupported ORM receiver forms atomically and recovers on a supported parse in %s',
    async (filePath) => {
      for (const source of [
        'prisma?.["user"].findMany();',
        'prisma.user.findMany(...values());',
        'supabase.from(...values()).select("*");',
        'supabase["from"]("bookings").select("*");',
        '(prisma?.["user"]).findMany();',
        'new Client().select();',
        'prisma.user.#private.findMany();',
        'factory()().save();',
      ]) {
        const { parser, root } = await parse(`first(); ${source}`, filePath);
        expect(root.hasError, source).toBe(false);
        const [first, outer] = root.descendantsOfType('call_expression');
        expect(outer?.text, source).toBe(source.slice(0, -1));
        expect(emitTypeScriptReferenceCaptures(first!)[0]!['@reference.name']!.text).toBe('first');
        expect(() => emitTypeScriptReferenceCaptures(outer!), source).toThrow(
          ScopeUnsupportedSyntaxError,
        );
        expect(() => emitTypeScriptReferenceCapturesForFile(root), source).toThrow(
          ScopeUnsupportedSyntaxError,
        );
        const recovered = parser.parse('first(); receiver.save();').rootNode;
        expect(recovered.hasError).toBe(false);
        expect(
          emitTypeScriptReferenceCapturesForFile(recovered).map(
            (match) => match['@reference.name']!.text,
          ),
        ).toEqual(['first', 'save', 'receiver']);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches exact Prisma and Supabase receiver chains in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        'prisma.user.findMany(); supabase.from("bookings").select("*");',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const [prisma, select, from] = root.descendantsOfType('call_expression');
      const prismaMember = prisma!.childForFieldName('function')!;
      const prismaReceiver = prismaMember.childForFieldName('object')!;
      const prismaRoot = prismaReceiver.childForFieldName('object')!;
      const selectMember = select!.childForFieldName('function')!;
      const fromMember = from!.childForFieldName('function')!;
      const supabaseRoot = fromMember.childForFieldName('object')!;
      const prismaMatches = emitTypeScriptReferenceCaptures(prisma!);
      expect(prismaMatches).toEqual([
        {
          '@reference.call.member': {
            name: '@reference.call.member',
            text: '',
            range: rangeOf(prisma!),
          },
          '@reference.name': {
            name: '@reference.name',
            text: 'findMany',
            range: rangeOf(prismaMember.childForFieldName('property')!),
          },
          '@reference.receiver': {
            name: '@reference.receiver',
            text: '',
            range: rangeOf(prismaReceiver),
            receiver: {
              kind: 'chain',
              root: { name: 'prisma', range: rangeOf(prismaRoot) },
              steps: [
                {
                  kind: 'member',
                  name: 'user',
                  range: rangeOf(prismaReceiver.childForFieldName('property')!),
                },
              ],
            },
          },
          '@reference.arity': {
            name: '@reference.arity',
            text: '0',
            range: rangeOf(prisma!.childForFieldName('arguments')!),
          },
        },
        ...emitTypeScriptMemberReadCaptures(prismaReceiver),
      ]);
      const selectMatches = emitTypeScriptReferenceCaptures(select!);
      expect(selectMatches).toEqual([
        {
          '@reference.call.member': {
            name: '@reference.call.member',
            text: '',
            range: rangeOf(select!),
          },
          '@reference.name': {
            name: '@reference.name',
            text: 'select',
            range: rangeOf(selectMember.childForFieldName('property')!),
          },
          '@reference.receiver': {
            name: '@reference.receiver',
            text: '',
            range: rangeOf(from!),
            receiver: {
              kind: 'chain',
              root: { name: 'supabase', range: rangeOf(supabaseRoot) },
              steps: [
                {
                  kind: 'member',
                  name: 'from',
                  range: rangeOf(fromMember.childForFieldName('property')!),
                },
                { kind: 'call', arity: 1, range: rangeOf(from!) },
              ],
            },
          },
          '@reference.arity': {
            name: '@reference.arity',
            text: '1',
            range: rangeOf(select!.childForFieldName('arguments')!),
          },
        },
      ]);
      const matches = emitTypeScriptReferenceCapturesForFile(root);
      expect(matches).toEqual([
        ...prismaMatches,
        ...selectMatches,
        ...emitTypeScriptReferenceCaptures(from!),
      ]);
      expect(matches.map((match) => match['@reference.name']!.text)).toEqual([
        'findMany',
        'user',
        'prisma',
        'select',
        'from',
        'supabase',
      ]);
      const detached = emitTypeScriptReferenceCapturesForFile(root);
      const saved = JSON.stringify(detached);
      const receiver = prismaMatches[0]!['@reference.receiver']!.receiver!;
      if (receiver.kind !== 'chain') throw new Error('Expected chain receiver');
      receiver.root.range.startCol = 999;
      receiver.steps[0]!.range.startCol = 999;
      expect(prismaMatches[2]!['@reference.name']!.range).toEqual(rangeOf(prismaRoot));
      parser.parse('replacement();');
      expect(JSON.stringify(detached)).toBe(saved);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'bounds receiver steps independently of argument nesting in %s',
    async (filePath) => {
      for (const count of [1, 64, 65]) {
        const { root } = await parse(`root${'.member'.repeat(count)}.save();`, filePath);
        expect(root.hasError).toBe(false);
        const call = root.descendantsOfType('call_expression')[0]!;
        if (count === 65)
          expect(() => emitTypeScriptReferenceCaptures(call)).toThrow(ScopeUnsupportedSyntaxError);
        else {
          const matches = emitTypeScriptReferenceCaptures(call);
          const receiver = matches[0]!['@reference.receiver']!.receiver!;
          expect(receiver.kind === 'chain' && receiver.steps.length).toBe(count);
          expect(matches.at(-1)!['@reference.name']!.text).toBe('root');
          expect(matches).toHaveLength(count + 2);
        }
      }
      const { root } = await parse(
        `root.member.save(${'inner('.repeat(128)}value${')'.repeat(128)});`,
        filePath,
      );
      expect(root.hasError).toBe(false);
      const matches = emitTypeScriptReferenceCapturesForFile(root);
      expect(matches.filter((match) => match['@reference.call.free'])).toHaveLength(128);
      expect(matches.filter((match) => match['@reference.read'])).toHaveLength(2);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'refuses unsupported nested calls and malformed file roots atomically in %s',
    async (filePath) => {
      for (const source of [
        'first(object[key]());',
        'first(other(...values()));',
        'first(); tag`template`;',
        'first(); broken = ;',
      ]) {
        const { root } = await parse(source, filePath);
        expect(() => emitTypeScriptReferenceCapturesForFile(root), source).toThrow();
      }
      const { root } = await parse('first();', filePath);
      expect(() => emitTypeScriptReferenceCapturesForFile(root.namedChildren[0]!)).toThrow();
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'refuses type-query calls and exits ordinary type-query context in %s',
    async (filePath) => {
      for (const source of ['type Result = typeof local();', 'type Result = typeof local(1);']) {
        const { root } = await parse(source, filePath);
        expect(root.hasError).toBe(false);
        expect(root.descendantsOfType('type_query')).toHaveLength(1);
        expect(root.descendantsOfType('call_expression')).toHaveLength(1);
        expect(() => emitTypeScriptReferenceCapturesForFile(root), source).toThrow();
      }
      const { root } = await parse('type Result = typeof local; runtime();', filePath);
      expect(root.hasError).toBe(false);
      expect(
        emitTypeScriptReferenceCapturesForFile(root).map((match) => match['@reference.name']!.text),
      ).toEqual(['runtime']);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches zero arity constructors without parentheses in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        'new /* constructor */ Café; new Café();\nfunction outer() { new Café(new Other); }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const nodes = root.descendantsOfType('new_expression');
      const matches = nodes.flatMap(emitTypeScriptReferenceCaptures);
      expect(
        matches.map((match) => [match['@reference.name']!.text, match['@reference.arity']!.text]),
      ).toEqual([
        ['Café', '0'],
        ['Café', '0'],
        ['Café', '1'],
        ['Other', '0'],
      ]);
      for (const [index, match] of matches.entries()) {
        const node = nodes[index]!;
        const callee = node.childForFieldName('constructor')!;
        const args = node.childForFieldName('arguments');
        expect(match).toEqual({
          '@reference.call.constructor': {
            name: '@reference.call.constructor',
            text: '',
            range: rangeOf(node),
          },
          '@reference.name': { name: '@reference.name', text: callee.text, range: rangeOf(callee) },
          '@reference.arity': {
            name: '@reference.arity',
            text: index === 2 ? '1' : '0',
            range: rangeOf(args ?? callee),
          },
        });
        expect(new Set(Object.values(match).map((item) => item.range)).size).toBe(3);
        if (!args)
          expect(match['@reference.arity']!.range).toEqual(match['@reference.name']!.range);
      }
      const inputs = [
        ...emitTypeScriptLexicalScopeCaptures(root),
        ...root
          .descendantsOfType('function_declaration')
          .flatMap(emitTypeScriptDeclarationCaptures),
      ];
      const baseline = extract(inputs, filePath, {});
      const saved = JSON.stringify(matches);
      const sibling = { ...matches[0]!['@reference.arity']!.range };
      (matches[0]!['@reference.name']!.range as { startLine: number }).startLine = 999;
      expect(matches[0]!['@reference.arity']!.range).toEqual(sibling);
      const detached = nodes.flatMap(emitTypeScriptReferenceCaptures);
      parser.parse('new Replacement;');
      expect(JSON.stringify(detached)).toBe(saved);
      const result = extract([...inputs, ...detached], filePath, {});
      const body = baseline.scopes.find((scope) => scope.kind === 'Block')!;
      expect(result.referenceSites).toEqual(
        detached.map((match, index) => ({
          name: match['@reference.name']!.text,
          atRange: match['@reference.call.constructor']!.range,
          inScope: index < 2 ? baseline.moduleScope : body.id,
          kind: 'call',
          callForm: 'constructor',
          arity: index === 2 ? 1 : 0,
        })),
      );
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
      for (const source of [
        'new namespace.Local;',
        'new object[key];',
        'new (Local);',
        'new (new Local);',
      ]) {
        const parsed = await parse(source, filePath);
        const node = parsed.root.descendantsOfType('new_expression')[0];
        expect(node, source).toBeDefined();
        expect(() => emitTypeScriptReferenceCaptures(node!), source).toThrow();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches ordinary identifier receiver member calls in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        'café.default(/* only */);\n' +
          'function outer() { café /* receiver */ . /* property */ μέθοδος(/* first */ 1, inner(), /* last */); }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const calls = root.descendantsOfType('call_expression');
      const members = calls.filter(
        (node) => node.childForFieldName('function')!.type === 'member_expression',
      );
      const pairs = members.map(emitTypeScriptReferenceCaptures);
      const matches = pairs.flat();
      for (const [index, pair] of pairs.entries()) {
        expect(pair).toHaveLength(2);
        const match = pair[0]!;
        const read = pair[1]!;
        const node = members[index]!;
        const callee = node.childForFieldName('function')!;
        const property = callee.childForFieldName('property')!;
        const receiver = callee.childForFieldName('object')!;
        expect(match).toEqual({
          '@reference.call.member': {
            name: '@reference.call.member',
            text: '',
            range: rangeOf(node),
          },
          '@reference.name': {
            name: '@reference.name',
            text: property.text,
            range: rangeOf(property),
          },
          '@reference.receiver': {
            name: '@reference.receiver',
            text: receiver.text,
            range: rangeOf(receiver),
          },
          '@reference.arity': {
            name: '@reference.arity',
            text: index === 0 ? '0' : '2',
            range: rangeOf(node.childForFieldName('arguments')!),
          },
        });
        expect(new Set(Object.values(match).map((item) => item.range)).size).toBe(4);
        expect(read).toEqual({
          '@reference.read': { name: '@reference.read', text: '', range: rangeOf(receiver) },
          '@reference.name': {
            name: '@reference.name',
            text: receiver.text,
            range: rangeOf(receiver),
          },
        });
        expect(
          new Set(pair.flatMap((item) => Object.values(item).map((capture) => capture.range))).size,
        ).toBe(6);
      }
      const inputs = [
        ...emitTypeScriptLexicalScopeCaptures(root),
        ...root
          .descendantsOfType('function_declaration')
          .flatMap(emitTypeScriptDeclarationCaptures),
      ];
      const baseline = extract(inputs, filePath, {});
      const saved = JSON.stringify(matches);
      const sibling = { ...matches[0]!['@reference.receiver']!.range };
      (matches[0]!['@reference.call.member']!.range as { startLine: number }).startLine = 999;
      expect(matches[0]!['@reference.receiver']!.range).toEqual(sibling);
      matches[0]!['@reference.receiver']!.range.startCol = 999;
      (matches[0]!['@reference.receiver']! as { text: string }).text = 'changed';
      expect(matches[1]!['@reference.read']!.range).toEqual(sibling);
      expect(matches[1]!['@reference.name']!.range).toEqual(sibling);
      expect(matches[1]!['@reference.name']!.text).toBe('café');
      matches[1]!['@reference.read']!.range.endCol = 999;
      expect(matches[1]!['@reference.name']!.range).toEqual(sibling);
      const detached = members.flatMap(emitTypeScriptReferenceCaptures);
      for (const [index, match] of detached.entries()) {
        for (const [key, item] of Object.entries(match)) {
          expect(item.range).not.toBe(matches[index]![key]!.range);
        }
      }
      const inner = emitTypeScriptReferenceCaptures(calls.at(-1)!);
      parser.parse('replacement.member();');
      expect(JSON.stringify(detached)).toBe(saved);
      const result = extract([...inputs, ...detached, ...inner], filePath, {});
      const body = baseline.scopes.find((scope) => scope.kind === 'Block')!;
      expect(result.referenceSites).toEqual([
        ...members.flatMap((_, index) => [
          {
            name: detached[index * 2]!['@reference.name']!.text,
            atRange: detached[index * 2]!['@reference.call.member']!.range,
            inScope: index === 0 ? baseline.moduleScope : body.id,
            kind: 'call',
            callForm: 'member',
            arity: index === 0 ? 0 : 2,
            explicitReceiver: { name: 'café' },
          },
          {
            name: 'café',
            atRange: detached[index * 2 + 1]!['@reference.read']!.range,
            inScope: index === 0 ? baseline.moduleScope : body.id,
            kind: 'read',
          },
        ]),
        {
          name: 'inner',
          atRange: inner[0]!['@reference.call.free']!.range,
          inScope: body.id,
          kind: 'call',
          callForm: 'free',
          arity: 0,
        },
      ]);
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'collects nested member call and receiver read pairs in preorder in %s',
    async (filePath) => {
      const { parser, root } = await parse('café.save(δέντρο.load());', filePath);
      expect(root.hasError).toBe(false);
      const calls = root.descendantsOfType('call_expression');
      const matches = emitTypeScriptReferenceCapturesForFile(root);
      expect(matches).toEqual(
        calls.flatMap((node, index) => {
          const member = node.childForFieldName('function')!;
          const receiver = member.childForFieldName('object')!;
          const property = member.childForFieldName('property')!;
          return [
            {
              '@reference.call.member': {
                name: '@reference.call.member',
                text: '',
                range: rangeOf(node),
              },
              '@reference.name': {
                name: '@reference.name',
                text: property.text,
                range: rangeOf(property),
              },
              '@reference.receiver': {
                name: '@reference.receiver',
                text: receiver.text,
                range: rangeOf(receiver),
              },
              '@reference.arity': {
                name: '@reference.arity',
                text: index === 0 ? '1' : '0',
                range: rangeOf(node.childForFieldName('arguments')!),
              },
            },
            {
              '@reference.read': { name: '@reference.read', text: '', range: rangeOf(receiver) },
              '@reference.name': {
                name: '@reference.name',
                text: receiver.text,
                range: rangeOf(receiver),
              },
            },
          ];
        }),
      );
      expect(matches.map((match) => match['@reference.name']!.text)).toEqual([
        'save',
        'café',
        'load',
        'δέντρο',
      ]);
      expect(matches[1]!['@reference.read']!.range).toEqual({
        startLine: 1,
        startCol: 0,
        endLine: 1,
        endCol: 4,
      });
      expect(matches[3]!['@reference.read']!.range).toEqual({
        startLine: 1,
        startCol: 10,
        endLine: 1,
        endCol: 16,
      });
      const saved = JSON.stringify(matches);
      parser.parse('replacement();');
      expect(JSON.stringify(matches)).toBe(saved);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'refuses unsupported member receivers, access and arguments in %s',
    async (filePath) => {
      for (const source of [
        'object[key]();',
        'object.#private();',
        'this.method();',
        'class Child extends Base { method() { super.method(); } }',
        '(object?.[key]).method();',
        'object.method(...values());',
        'object.method(,);',
        'object.method(first,,second);',
        'object.method(broken +);',
      ]) {
        const { root } = await parse(source, filePath);
        const node = root.descendantsOfType('call_expression')[0];
        expect(node, source).toBeDefined();
        expect(() => emitTypeScriptReferenceCaptures(node!), source).toThrow();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches identifier constructor calls with explicit arguments in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        'new Café(/* only */);\nfunction outer() { new Café(/* first */ 1, inner(), /* trailing */); }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const constructors = root.descendantsOfType('new_expression');
      const calls = root.descendantsOfType('call_expression');
      const matches = constructors.flatMap(emitTypeScriptReferenceCaptures);
      for (const [index, match] of matches.entries()) {
        const node = constructors[index]!;
        expect(match).toEqual({
          '@reference.call.constructor': {
            name: '@reference.call.constructor',
            text: '',
            range: rangeOf(node),
          },
          '@reference.name': {
            name: '@reference.name',
            text: 'Café',
            range: rangeOf(node.childForFieldName('constructor')!),
          },
          '@reference.arity': {
            name: '@reference.arity',
            text: index === 0 ? '0' : '2',
            range: rangeOf(node.childForFieldName('arguments')!),
          },
        });
        expect(new Set(Object.values(match).map((item) => item.range)).size).toBe(3);
      }
      const inputs = [
        ...emitTypeScriptLexicalScopeCaptures(root),
        ...root
          .descendantsOfType('function_declaration')
          .flatMap(emitTypeScriptDeclarationCaptures),
      ];
      const baseline = extract(inputs, filePath, {});
      const saved = JSON.stringify(matches);
      const sibling = { ...matches[0]!['@reference.name']!.range };
      (matches[0]!['@reference.call.constructor']!.range as { startLine: number }).startLine = 999;
      expect(matches[0]!['@reference.name']!.range).toEqual(sibling);
      const detached = constructors.flatMap(emitTypeScriptReferenceCaptures);
      const inner = calls.flatMap(emitTypeScriptReferenceCaptures);
      parser.parse('new Replacement();');
      expect(JSON.stringify(detached)).toBe(saved);
      const result = extract([...inputs, ...detached, ...inner], filePath, {});
      const body = baseline.scopes.find((scope) => scope.kind === 'Block')!;
      expect(result.referenceSites).toEqual([
        ...detached.map((match, index) => ({
          name: 'Café',
          atRange: match['@reference.call.constructor']!.range,
          inScope: index === 0 ? baseline.moduleScope : body.id,
          kind: 'call',
          callForm: 'constructor',
          arity: index === 0 ? 0 : 2,
        })),
        {
          name: 'inner',
          atRange: inner[0]!['@reference.call.free']!.range,
          inScope: body.id,
          kind: 'call',
          callForm: 'free',
          arity: 0,
        },
      ]);
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'refuses unsupported constructor targets and argument lists in %s',
    async (filePath) => {
      for (const source of [
        'new namespace.Local();',
        'new object[key]();',
        'new (Local)();',
        'new (factory())();',
        'new new Local()();',
        'new Local(...values());',
        'new Local(,);',
        'new Local(first,,second);',
        'new Local(1, broken +);',
      ]) {
        const { root } = await parse(source, filePath);
        const node = root.descendantsOfType('new_expression')[0];
        expect(node, source).toBeDefined();
        expect(() => emitTypeScriptReferenceCaptures(node!), source).toThrow();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'detaches exact names, arities and enclosing scopes in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        'café(/* only */);\nfunction outer() { café(/* first */ 1, inner(), /* last */); }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const calls = root.descendantsOfType('call_expression');
      const matches = calls.flatMap(emitTypeScriptReferenceCaptures);
      expect(
        matches.map((match) => [match['@reference.name']!.text, match['@reference.arity']!.text]),
      ).toEqual([
        ['café', '0'],
        ['café', '2'],
        ['inner', '0'],
      ]);
      for (const [index, match] of matches.entries()) {
        const call = calls[index]!;
        expect(match).toEqual({
          '@reference.call.free': { name: '@reference.call.free', text: '', range: rangeOf(call) },
          '@reference.name': {
            name: '@reference.name',
            text: call.childForFieldName('function')!.text,
            range: rangeOf(call.childForFieldName('function')!),
          },
          '@reference.arity': {
            name: '@reference.arity',
            text: index === 1 ? '2' : '0',
            range: rangeOf(call.childForFieldName('arguments')!),
          },
        });
        expect(new Set(Object.values(match).map((item) => item.range)).size).toBe(3);
      }
      const inputs = [
        ...emitTypeScriptLexicalScopeCaptures(root),
        ...root
          .descendantsOfType('function_declaration')
          .flatMap(emitTypeScriptDeclarationCaptures),
      ];
      const baseline = extract(inputs, filePath, {});
      const saved = JSON.stringify(matches);
      const sibling = { ...matches[0]!['@reference.name']!.range };
      (matches[0]!['@reference.call.free']!.range as { startLine: number }).startLine = 999;
      expect(matches[0]!['@reference.name']!.range).toEqual(sibling);
      const detached = calls.flatMap(emitTypeScriptReferenceCaptures);
      parser.parse('replacement();');
      expect(JSON.stringify(detached)).toBe(saved);
      const result = extract([...inputs, ...detached], filePath, {});
      const body = baseline.scopes.find((scope) => scope.kind === 'Block')!;
      expect(result.referenceSites).toEqual(
        detached.map((match, index) => ({
          name: match['@reference.name']!.text,
          atRange: match['@reference.call.free']!.range,
          inScope: index === 0 ? baseline.moduleScope : body.id,
          kind: 'call',
          callForm: 'free',
          arity: index === 1 ? 2 : 0,
        })),
      );
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
      const nested = await parse('local(object.method(), other(...values));', filePath);
      const nestedCalls = nested.root.descendantsOfType('call_expression');
      expect(emitTypeScriptReferenceCaptures(nestedCalls[0]!)[0]!['@reference.arity']!.text).toBe(
        '2',
      );
      expect(
        emitTypeScriptReferenceCaptures(nestedCalls[1]!)[0]!['@reference.receiver']!.text,
      ).toBe('object');
      expect(emitTypeScriptReferenceCaptures(nestedCalls[2]!)[0]!['@reference.arity']!.text).toBe(
        '1',
      );
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'refuses unsupported selected call forms and malformed argument lists in %s',
    async (filePath) => {
      for (const source of [
        'local?.();',
        'object[key]();',
        '(local)();',
        'local()();',
        'import("module");',
        'local`template`;',
        'local(...values());',
        'local(,);',
        'local(first,,second);',
        'local(1, broken +);',
      ]) {
        const { root } = await parse(source, filePath);
        const call = root.descendantsOfType('call_expression')[0];
        expect(call, source).toBeDefined();
        expect(() => emitTypeScriptReferenceCaptures(call!), source).toThrow();
      }
      const { root } = await parse('local();', filePath);
      expect(() => emitTypeScriptReferenceCaptures(root)).toThrow();
      const malformed = await parse('local(', filePath);
      expect(malformed.root.hasError).toBe(true);
      expect(() => emitTypeScriptReferenceCaptures(malformed.root.namedChildren[0]!)).toThrow();
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'reports exact unsupported spread constructor evidence without source text in %s',
    async (filePath) => {
      const { root } = await parse('\n  new SecretConstructor(...privateValues());', filePath);
      expect(root.hasError).toBe(false);
      const constructor = root.descendantsOfType('new_expression')[0]!;
      expect(constructor.startPosition).toEqual({ row: 1, column: 2 });
      for (const refuse of [
        () => emitTypeScriptReferenceCaptures(constructor),
        () => emitTypeScriptReferenceCapturesForFile(root),
      ]) {
        expect(refuse).toThrow(ScopeUnsupportedSyntaxError);
        expect(refuse).toThrowError(
          new ScopeUnsupportedSyntaxError(
            'TS/JS reference captures require an ordinary supported call with fixed arity [node=spread_element at=2:25]',
          ),
        );
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'refuses explicit call type arguments in %s',
    async (filePath) => {
      const { root } = await parse('local<string>();', filePath);
      expect(root.hasError).toBe(false);
      expect(() =>
        emitTypeScriptReferenceCaptures(root.descendantsOfType('call_expression')[0]!),
      ).toThrow();
      const member = await parse('object.method<string>();', filePath);
      expect(member.root.hasError).toBe(false);
      expect(() =>
        emitTypeScriptReferenceCaptures(member.root.descendantsOfType('call_expression')[0]!),
      ).toThrow();
      for (const source of [
        'new Local<<T>() => string>();',
        'new Local<<T>() => string>;',
        'new Local<>();',
      ]) {
        const constructor = await parse(source, filePath);
        expect(() => emitTypeScriptReferenceCapturesForFile(constructor.root), source).toThrow();
      }
      for (const source of ['new Local<() => string>();', 'new Local<() => string>;']) {
        const constructor = await parse(source, filePath);
        expect(constructor.root.hasError, source).toBe(false);
        expect(
          emitTypeScriptReferenceCapturesForFile(constructor.root)[0]!['@reference.arity']!.text,
        ).toBe('0');
      }
      for (const source of ['client.from<string>().select();', 'client.from<string>.select();']) {
        const parsed = await parse(source, filePath);
        expect(() =>
          emitTypeScriptReferenceCaptures(parsed.root.descendantsOfType('call_expression')[0]!),
        ).toThrow();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'detaches typed constructors without emitting type-only reads in %s',
    async (filePath) => {
      for (const source of [
        'new Local<string>();',
        'new Local<string>;',
        'new Local<Map<string, Array<Type | null>>>(inner(value));',
        'new Local<readonly Models.Type[]>(inner(value));',
      ]) {
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const constructor = root.descendantsOfType('new_expression')[0]!;
        const captures = emitTypeScriptReferenceCaptures(constructor);
        expect(captures).toEqual([
          {
            '@reference.call.constructor': {
              name: '@reference.call.constructor',
              text: '',
              range: rangeOf(constructor),
            },
            '@reference.name': {
              name: '@reference.name',
              text: 'Local',
              range: rangeOf(constructor.childForFieldName('constructor')!),
            },
            '@reference.arity': {
              name: '@reference.arity',
              text: source.includes('inner') ? '1' : '0',
              range: rangeOf(
                constructor.childForFieldName('arguments') ??
                  constructor.childForFieldName('constructor')!,
              ),
            },
          },
        ]);
        const all = emitTypeScriptReferenceCapturesForFile(root);
        expect(
          all.map((match) => match['@reference.name']!.text),
          source,
        ).toEqual(source.includes('inner') ? ['Local', 'inner'] : ['Local']);
        const saved = JSON.stringify(all);
        parser.parse('replacement();');
        expect(JSON.stringify(all)).toBe(saved);
      }
    },
  );
});
