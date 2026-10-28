import { describe, expect, it } from 'vitest';
import { buildFieldRegistry, resolveTypeRef, SupportedLanguages } from 'ontoindex-shared';
import { resolveReferences } from '../../../src/core/ingestion/resolve-references.js';
import {
  buildScopeRegistryContext,
  finalizeScopeModel,
} from '../../../src/core/ingestion/finalize-orchestrator.js';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';
import {
  selectTypeScriptLocalBindings,
  typeScriptDeclarationBindingScope,
  typeScriptDeclarationNamespace,
} from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';
import { interpretTypeScriptImport } from '../../../src/core/ingestion/languages/typescript-import-captures.js';
import { interpretTypeScriptExports } from '../../../src/core/ingestion/languages/typescript-export-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import {
  interpretTypeScriptTypeBinding,
  typescriptProvider,
  javascriptProvider,
} from '../../../src/core/ingestion/languages/typescript.js';

const filePaths = ['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'];
const hooks = {
  bindingScopeFor: typeScriptDeclarationBindingScope,
  declarationNamespaceFor: typeScriptDeclarationNamespace,
  selectLocalBindings: selectTypeScriptLocalBindings,
  interpretImport: interpretTypeScriptImport,
  interpretExports: interpretTypeScriptExports,
  interpretTypeBinding: interpretTypeScriptTypeBinding,
};

async function parse(source: string, filePath = 'fixture.ts') {
  const language = /\.jsx?$/.test(filePath)
    ? SupportedLanguages.JavaScript
    : SupportedLanguages.TypeScript;
  const parser = await createParserForLanguage(language, filePath);
  return { parser, root: parser.parse(source).rootNode };
}

describe('borrowed TS/JS module captures', () => {
  it.each(filePaths)('admits async arrows in supported value contexts in %s', async (filePath) => {
    for (const arrow of [
      'async x => x',
      'async (x) => x',
      'async () => { return value; }',
      'async /* parameters */ (x) /* arrow */ => /* body */ x',
      ...(/\.tsx?$/.test(filePath)
        ? ['async (x: number) => x', 'async (x): Promise<number> => x']
        : []),
    ]) {
      for (const statement of [`const f = ${arrow};`, `consume(${arrow});`, `(${arrow})(value);`]) {
        const source = `before(); ${statement} after();`;
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
        expect(owner, source).toBeDefined();
        const body = result.scopes.find(
          (scope) => scope.kind === 'Block' && scope.parent === owner.id,
        );
        expect([...owner.bindings.keys()], source).toEqual(
          arrow.startsWith('async ()') ? [] : ['x'],
        );
        expect(result.referenceSites, source).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'before', kind: 'call' }),
            expect.objectContaining({ name: 'after', kind: 'call' }),
            expect.objectContaining({
              name: arrow.startsWith('async ()') ? 'value' : 'x',
              kind: 'read',
              inScope: body?.id ?? owner.id,
            }),
          ]),
        );
      }
    }
  });

  it.each(filePaths)('refuses malformed async arrows atomically in %s', async (filePath) => {
    const { root } = await parse('before(); const f = async (x) =>; after();', filePath);
    expect(root.hasError).toBe(true);
    expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
  });

  it.each(['fixture.ts', 'fixture.tsx'])(
    'still refuses generic async arrows atomically in %s',
    async (filePath) => {
      const { root } = await parse('before(); const f = async <T,>(x: T) => x; after();', filePath);
      expect(root.hasError).toBe(false);
      expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
    },
  );

  it.each(filePaths)(
    'retains newly supported optional member calls across nested value contexts in %s',
    async (filePath) => {
      for (const expression of [
        'obj.m?.()',
        'obj?.method?.().field',
        'obj.method?.().field',
        '(obj.method?.()).field',
        '(obj?.field).method?.()',
        'obj?.child.method?.().field',
        '(condition ? left : right).method?.()',
      ]) {
        for (const statement of [
          `${expression};`,
          `const result = ${expression};`,
          `outer(${expression});`,
          `return ${expression};`,
          `throw ${expression};`,
          `const result = !(${expression});`,
          `const result = good() < (${expression});`,
          ...(/\.tsx?$/.test(filePath) ? [`const result = (${expression})!;`] : []),
        ]) {
          const source = `function owner() { before(); ${statement} after(); }`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
          expect(result.referenceSites, source).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: expression === 'obj.m?.()' ? 'm' : 'method',
                kind: 'call',
                callForm: 'member',
                arity: 0,
              }),
              expect.objectContaining({ name: 'before', kind: 'call' }),
              expect.objectContaining({ name: 'after', kind: 'call' }),
            ]),
          );
        }
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains asserted receivers and flat destructured signatures in %s',
    async (filePath) => {
      for (const expression of [
        '(obj as Type).field',
        '(obj as Type).method()',
        '(factory() as Type).field',
        '(obj as unknown as Type).field',
      ]) {
        const { root } = await parse(`before(); const result = ${expression}; after();`, filePath);
        expect(root.hasError, expression).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        expect(result.referenceSites, expression).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: expression.includes('method') ? 'method' : 'field',
              kind: expression.includes('method') ? 'call' : 'read',
            }),
            expect.objectContaining({ name: expression.includes('factory') ? 'factory' : 'obj' }),
          ]),
        );
        expect(result.referenceSites.some(({ name }) => name === 'Type')).toBe(false);
      }
      for (const declaration of [
        'class Owner { method({ value }: A) { use(value); } }',
        'function owner({ value }, other?) { use(value); }',
        'function owner([value], other?) { use(value); }',
      ]) {
        const { root } = await parse(declaration, filePath);
        expect(root.hasError, declaration).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        expect(
          result.localDefs.map(({ qualifiedName }) => qualifiedName),
          declaration,
        ).toContain('value');
        expect(result.referenceSites, declaration).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'value', kind: 'read' })]),
        );
      }
    },
  );

  it.each(filePaths)(
    'keeps computed receiver calls unknown and visits each operand once in %s',
    async (filePath) => {
      const source =
        'function get(name) {} let file = 1; let space = 1; let name = 1; ' +
        'file.exportsByNamespace[space].get(name);';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const start = source.indexOf('file.exports');
      const rangeOf = (text: string, within = text) => {
        const startCol = source.indexOf(text, start) + text.indexOf(within);
        return { startLine: 1, startCol, endLine: 1, endCol: startCol + within.length };
      };
      const read = (name: string, text = name) => ({
        name,
        kind: 'read',
        inScope: result.moduleScope,
        atRange: rangeOf(text),
      });
      expect(result.referenceSites).toEqual([
        {
          name: 'get',
          kind: 'call',
          callForm: 'member',
          arity: 1,
          inScope: result.moduleScope,
          atRange: rangeOf('file.exportsByNamespace[space].get(name)'),
          explicitReceiver: { kind: 'unknown' },
        },
        {
          kind: 'read',
          inScope: result.moduleScope,
          atRange: rangeOf('file.exportsByNamespace[space]'),
          selection: {
            kind: 'computed',
            objectRange: rangeOf('file.exportsByNamespace'),
            indexRange: rangeOf('[space]', 'space'),
          },
        },
        {
          ...read('exportsByNamespace', 'file.exportsByNamespace'),
          explicitReceiver: { name: 'file' },
        },
        read('file'),
        {
          name: 'space',
          kind: 'read',
          inScope: result.moduleScope,
          atRange: rangeOf('[space]', 'space'),
        },
        {
          name: 'name',
          kind: 'read',
          inScope: result.moduleScope,
          atRange: rangeOf('get(name)', 'name'),
        },
      ]);
      const resolved = [
        ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
      ].flat();
      const decoy = result.scopes[0]!.bindings.get('get')![0]!.def.nodeId;
      expect(resolved.some((reference) => reference.toDef === decoy)).toBe(false);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'preserves asserted receiver identity and computed argument ranges in %s',
    async (filePath) => {
      const source =
        'startIsAtOrBefore(arr[mid]!.range, line, col); obj!.field; obj!.method(); arr[mid]!.method();';
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const result = extract(captures, filePath, hooks);
      const rangeOf = (text: string, from = 0) => ({
        startLine: 1,
        startCol: source.indexOf(text, from),
        endLine: 1,
        endCol: source.indexOf(text, from) + text.length,
      });
      expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
        ['startIsAtOrBefore', 'call'],
        ['range', 'read'],
        [undefined, 'read'],
        ['arr', 'read'],
        ['mid', 'read'],
        ['line', 'read'],
        ['col', 'read'],
        ['field', 'read'],
        ['obj', 'read'],
        ['method', 'call'],
        ['obj', 'read'],
        ['method', 'call'],
        [undefined, 'read'],
        ['arr', 'read'],
        ['mid', 'read'],
      ]);
      expect(result.referenceSites[0]).toMatchObject({
        callForm: 'free',
        arity: 3,
        atRange: rangeOf('startIsAtOrBefore(arr[mid]!.range, line, col)'),
      });
      expect(result.referenceSites[1]).toMatchObject({
        explicitReceiver: { kind: 'unknown' },
        atRange: rangeOf('arr[mid]!.range'),
      });
      for (const [index, text] of [
        [2, 'arr[mid]'],
        [3, 'arr'],
        [4, 'mid'],
        [5, 'line'],
        [6, 'col'],
      ] as const) {
        expect(result.referenceSites[index]!.atRange).toEqual(rangeOf(text));
      }
      expect(result.referenceSites[7]).toMatchObject({
        explicitReceiver: { name: 'obj' },
        atRange: rangeOf('obj!.field'),
      });
      expect(result.referenceSites[9]).toMatchObject({
        explicitReceiver: { name: 'obj' },
        atRange: rangeOf('obj!.method()'),
      });
      expect(result.referenceSites[11]).toMatchObject({
        explicitReceiver: { kind: 'unknown' },
        arity: 0,
      });
      expect(
        new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
          .size,
      ).toBe(result.referenceSites.length);
      expect(extract(JSON.parse(JSON.stringify(captures)), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'visits grouped arrow IIFE bodies and arguments without a named invocation in %s',
    async (filePath) => {
      const source =
        'let outer = 1; before(); (((parameter) => { body(parameter, outer); return parameter; }))(argument); after();';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const arrow = result.scopes.find((scope) => scope.kind === 'Function')!;
      const block = result.scopes.find((scope) => scope.kind === 'Block')!;
      const rangeOf = (text: string, from = 0) => ({
        startLine: 1,
        startCol: source.indexOf(text, from),
        endLine: 1,
        endCol: source.indexOf(text, from) + text.length,
      });
      const bodyStart = source.indexOf('body(');
      expect(arrow.bindings.has('parameter')).toBe(true);
      expect(result.referenceSites).toEqual([
        {
          name: 'before',
          kind: 'call',
          callForm: 'free',
          arity: 0,
          inScope: result.moduleScope,
          atRange: rangeOf('before()'),
        },
        {
          name: 'body',
          kind: 'call',
          callForm: 'free',
          arity: 2,
          inScope: block.id,
          atRange: rangeOf('body(parameter, outer)'),
        },
        {
          name: 'parameter',
          kind: 'read',
          inScope: block.id,
          atRange: rangeOf('parameter', bodyStart),
        },
        { name: 'outer', kind: 'read', inScope: block.id, atRange: rangeOf('outer', bodyStart) },
        {
          name: 'parameter',
          kind: 'read',
          inScope: block.id,
          atRange: rangeOf('parameter', source.indexOf('return')),
        },
        {
          name: 'argument',
          kind: 'read',
          inScope: result.moduleScope,
          atRange: rangeOf('argument'),
        },
        {
          name: 'after',
          kind: 'call',
          callForm: 'free',
          arity: 0,
          inScope: result.moduleScope,
          atRange: rangeOf('after()'),
        },
      ]);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'refuses unsafe invocation forms before and after valid siblings in %s',
    async (filePath) => {
      for (const expression of [
        'value?.()',
        'obj[key]?.()',
        'obj[key]()',
        'factory()()',
        '(condition ? left : right)()',
        '(function () {})()',
        '(() => value)(...make())',
        '(() => this)()',
        '(() => value)?.()',
        '(() => value)(,)',
      ]) {
        for (const source of [`before(); ${expression};`, `${expression}; after();`]) {
          const { root } = await parse(source, filePath);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'accepts regex leaves without pattern references or inferred bindings in %s',
    async (filePath) => {
      for (const literal of [
        '/pattern/',
        String.raw`/escaped\/slash/`,
        '/[a-z/]+/',
        '/(?:pattern|other)+/',
        ...['d', 'g', 'i', 'm', 's', 'u', 'v', 'y', 'dgimsuy', 'dgimsvy', 'yusmigd'].map(
          (flags) => `/pattern/${flags}`,
        ),
      ]) {
        const source = `const result = ${literal};`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        expect(result.referenceSites, source).toEqual([]);
        expect(
          result.localDefs.map((def) => def.qualifiedName),
          source,
        ).toEqual(['result']);
        expect([...result.scopes[0]!.bindings.keys()], source).toEqual(['result']);
        expect(result.localDefs[0]!.declaredType, source).toBeUndefined();
        expect(
          result.scopes.flatMap((scope) => [...scope.typeBindings.values()]),
          source,
        ).toEqual([]);
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'preserves surrounding reference order, ranges and scopes for regex rvalues in %s',
    async (filePath) => {
      const literal = String.raw`/[pattern\/]+/giy`;
      const cases = [
        { statement: `const result = ${literal};`, refs: [] },
        {
          statement: `consume(${literal}, value);`,
          refs: [
            { name: 'consume', text: `consume(${literal}, value)`, form: 'free', arity: 2 },
            { name: 'value' },
          ],
        },
        {
          statement: `obj.method(value, ${literal});`,
          refs: [
            { name: 'method', text: `obj.method(value, ${literal})`, form: 'member', arity: 2 },
            { name: 'obj' },
            { name: 'value' },
          ],
        },
        {
          statement: `new Box(${literal}, value);`,
          refs: [
            { name: 'Box', text: `new Box(${literal}, value)`, form: 'constructor', arity: 2 },
            { name: 'value' },
          ],
        },
        { statement: `return ${literal};`, refs: [] },
        { statement: `throw ${literal};`, refs: [] },
        {
          statement: `const result = [first, ${literal}, last];`,
          refs: [{ name: 'first' }, { name: 'last' }],
        },
        {
          statement: `const result = {first, pattern: ${literal}, last};`,
          refs: [{ name: 'first' }, { name: 'last' }],
        },
        {
          statement: 'const result = `${first} ${' + literal + '} ${last}`;',
          refs: [{ name: 'first' }, { name: 'last' }],
        },
        {
          statement: `const result = condition ? ${literal} : fallback;`,
          refs: [{ name: 'condition' }, { name: 'fallback' }],
        },
        {
          statement: `while (${literal}) { branch(); }`,
          refs: [{ name: 'branch', text: 'branch()', form: 'free', arity: 0, branch: true }],
        },
        { statement: `const callback = () => ${literal};`, refs: [] },
        { statement: `result = ${literal};`, refs: [{ name: 'result', write: true }] },
        { statement: `const result = !(((${literal})));`, refs: [] },
        { statement: `const result = ${literal} === value;`, refs: [{ name: 'value' }] },
        {
          statement: `consume([${literal}], {pattern: ((${literal}))});`,
          refs: [
            {
              name: 'consume',
              text: `consume([${literal}], {pattern: ((${literal}))})`,
              form: 'free',
              arity: 2,
            },
          ],
        },
        ...(/\.tsx?$/.test(filePath)
          ? [
              { statement: `const result = ((${literal}) as Shape) satisfies Other;`, refs: [] },
              { statement: `const result = (${literal})!;`, refs: [] },
            ]
          : []),
      ];
      for (const { statement, refs } of cases) {
        const source = `function owner() { { before(); ${statement} after(); } }`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
        const lexical = blocks[1]!;
        const rangeOf = (text: string, from = source.indexOf(statement)) => {
          const startCol = source.indexOf(text, from);
          expect(startCol, text).toBeGreaterThanOrEqual(from);
          return { startLine: 1, startCol, endLine: 1, endCol: startCol + text.length };
        };
        const call = (name: string, from: number) => ({
          name,
          kind: 'call',
          callForm: 'free',
          arity: 0,
          inScope: lexical.id,
          atRange: rangeOf(`${name}()`, from),
        });
        expect(result.referenceSites, source).toEqual([
          call('before', 0),
          ...refs.map((ref) => ({
            name: ref.name,
            kind: 'form' in ref ? 'call' : 'write' in ref ? 'write' : 'read',
            atRange: rangeOf('text' in ref ? ref.text! : ref.name),
            inScope: 'branch' in ref ? blocks.at(-1)!.id : lexical.id,
            ...('form' in ref ? { callForm: ref.form, arity: ref.arity } : {}),
            ...('form' in ref && ref.form === 'member'
              ? { explicitReceiver: { name: 'obj' } }
              : {}),
          })),
          call('after', source.indexOf(statement) + statement.length),
        ]);
        expect(
          result.scopes.flatMap((scope) => [...scope.typeBindings.values()]),
          source,
        ).toEqual([]);
        expect(
          result.localDefs.some((def) =>
            ['pattern', 'giy', 'Shape', 'Other'].includes(def.qualifiedName),
          ),
          source,
        ).toBe(false);
        expect(
          result.scopes.some((scope) =>
            ['pattern', 'giy', 'Shape', 'Other'].some((name) => scope.bindings.has(name)),
          ),
          source,
        ).toBe(false);
        expect(
          result.localDefs.find((def) => def.qualifiedName === 'result')?.declaredType,
          source,
        ).toBeUndefined();
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'rejects invalid regex flags and unsupported regex reference positions atomically in %s',
    async (filePath) => {
      const statements = [
        ...['z', 'gg', 'ii', 'uv', 'vu', 'dgimsuvy'].flatMap((flags) => [
          `const result = /pattern/${flags};`,
          `consume(good(), /pattern/${flags});`,
          `return /pattern/${flags};`,
          'const result = `${' + `/pattern/${flags}` + '}`;',
        ]),
        '/pattern/;',
        '(/pattern/)();',
        '/pattern/();',
        'delete /pattern/;',
        ...(/\.tsx?$/.test(filePath) ? ['const result = /pattern/ as const;'] : []),
      ];
      for (const statement of statements) {
        for (const contents of [`before(); ${statement}`, `${statement} after();`]) {
          const source = `function owner() { ${contents} }`;
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
          const recovered = parser.parse('consume(/pattern/g);').rootNode;
          expect(
            extract(emitTypeScriptCaptures(recovered), filePath, hooks).referenceSites.map(
              ({ name }) => name,
            ),
          ).toEqual(['consume']);
        }
      }
    },
  );

  it.each(filePaths)(
    'rejects regex parse errors before or after supported code in %s',
    async (filePath) => {
      for (const statement of ['const result = /pattern;', 'const result = /pat\ntern/;']) {
        for (const source of [`before(); ${statement}`, `${statement}\nafter();`]) {
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(true);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'preserves computed selections and visits operands once with exact ranges and scopes in %s',
    async (filePath) => {
      const cases = [
        { expression: 'table[0]', operands: [{ name: 'table', text: 'table' }] },
        {
          expression: 'table[mroDepth]',
          operands: [
            { name: 'table', text: 'table' },
            { name: 'mroDepth', text: 'mroDepth' },
          ],
        },
        {
          expression: 'table[table.length - 1]',
          operands: [
            { name: 'table', text: 'table' },
            { name: 'length', text: 'table.length', receiver: 'table' },
            { name: 'table', text: 'table', from: 6 },
          ],
        },
        {
          expression: 'ORIGIN_PRIORITY[ka.origin]',
          operands: [
            { name: 'ORIGIN_PRIORITY', text: 'ORIGIN_PRIORITY' },
            { name: 'origin', text: 'ka.origin', receiver: 'ka' },
            { name: 'ka', text: 'ka' },
          ],
        },
        {
          expression: 'table[indexes[key]]',
          operands: [
            { name: 'table', text: 'table' },
            { name: 'indexes', text: 'indexes' },
            { name: 'key', text: 'key' },
          ],
        },
        {
          expression: 'factory(arg)[indexer(key)]',
          operands: [
            { name: 'factory', text: 'factory(arg)', call: true },
            { name: 'arg', text: 'arg' },
            { name: 'indexer', text: 'indexer(key)', call: true },
            { name: 'key', text: 'key' },
          ],
        },
        { expression: 'table[/* key */ "index"]', operands: [{ name: 'table', text: 'table' }] },
      ];
      for (const { expression, operands } of cases) {
        for (const position of [
          'declaration',
          'standalone',
          'parenthesized',
          'not',
          'binary',
          'return',
          'argument',
          'array',
          'assignment',
          'arrow',
          ...(/\.tsx?$/.test(filePath) ? ['non-null'] : []),
        ]) {
          const statements: Record<string, string> = {
            declaration: `const result = ${expression};`,
            standalone: `${expression};`,
            parenthesized: `((${expression}));`,
            not: `const result = !(${expression});`,
            binary: `const result = (${expression}) + 1;`,
            return: `return ${expression};`,
            argument: `consume(${expression});`,
            array: `const result = [${expression}];`,
            assignment: `result = ${expression};`,
            arrow: `const callback = value => ${expression};`,
            'non-null': `const result = (${expression})!;`,
          };
          const statement = statements[position]!;
          const source = `function owner() { { ${statement} } }`;
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const captures = emitTypeScriptCaptures(root);
          const saved = JSON.stringify(captures);
          const result = extract(captures, filePath, hooks);
          const scope =
            position === 'arrow'
              ? result.scopes.find(
                  (scope) =>
                    scope.ownerDefId ===
                    result.localDefs.find((def) => def.qualifiedName === 'callback')?.nodeId,
                )!
              : result.scopes.filter((scope) => scope.kind === 'Block').at(-1)!;
          const start = source.indexOf(expression);
          const rangeOf = (text: string, from = start) => {
            const offset = source.indexOf(text, from);
            expect(offset, text).toBeGreaterThanOrEqual(from);
            return { startLine: 1, startCol: offset, endLine: 1, endCol: offset + text.length };
          };
          const selectedSite = (text: string, object: string, index: string, from = start) => ({
            kind: 'read',
            atRange: rangeOf(text, from),
            inScope: scope.id,
            selection: {
              kind: 'computed',
              objectRange: rangeOf(object, from),
              indexRange: rangeOf(index, from + object.length + 1),
            },
          });
          const bracket = expression.indexOf('[');
          const indexText =
            expression === 'table[/* key */ "index"]'
              ? '"index"'
              : expression.slice(bracket + 1, -1);
          const computed = captures.filter((match) => match['@reference.read.computed']);
          expect(computed, source).toEqual([
            ...[expression, ...(expression === 'table[indexes[key]]' ? ['indexes[key]'] : [])].map(
              (text) => {
                const open = text.indexOf('[');
                const object = text.slice(0, open);
                const index = text === expression ? indexText : text.slice(open + 1, -1);
                const from = text === expression ? start : start + bracket + 1;
                return {
                  '@reference.read.computed': {
                    name: '@reference.read.computed',
                    text: '',
                    range: rangeOf(text, from),
                  },
                  '@reference.object': {
                    name: '@reference.object',
                    text: '',
                    range: rangeOf(object, from),
                  },
                  '@reference.index': {
                    name: '@reference.index',
                    text: '',
                    range: rangeOf(index, from + object.length + 1),
                  },
                };
              },
            ),
          ]);
          expect(result.referenceSites, source).toEqual([
            ...(position === 'assignment'
              ? [
                  {
                    name: 'result',
                    kind: 'write',
                    atRange: rangeOf('result', source.indexOf(statement)),
                    inScope: scope.id,
                  },
                ]
              : []),
            ...(position === 'argument'
              ? [
                  {
                    name: 'consume',
                    kind: 'call',
                    callForm: 'free',
                    arity: 1,
                    atRange: rangeOf(`consume(${expression})`, source.indexOf(statement)),
                    inScope: scope.id,
                  },
                ]
              : []),
            selectedSite(expression, expression.slice(0, bracket), indexText),
            ...operands.flatMap((operand) => [
              ...(expression === 'table[indexes[key]]' && operand.name === 'indexes'
                ? [selectedSite('indexes[key]', 'indexes', 'key', start + bracket + 1)]
                : []),
              {
                name: operand.name,
                kind: 'call' in operand ? 'call' : 'read',
                inScope: scope.id,
                atRange: rangeOf(operand.text, start + ('from' in operand ? operand.from! : 0)),
                ...('call' in operand ? { callForm: 'free', arity: 1 } : {}),
                ...('receiver' in operand ? { explicitReceiver: { name: operand.receiver } } : {}),
              },
            ]),
          ]);
          expect(
            new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
              .size,
          ).toBe(result.referenceSites.length);
          parser.parse('replacement();');
          expect(JSON.stringify(captures), source).toBe(saved);
          expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
        }
      }
    },
  );

  it.each(filePaths)(
    'refuses computed receivers, targets and unsupported operands atomically in %s',
    async (filePath) => {
      const statements = [
        'obj[key]();',
        'factory()[key] = value;',
        'factory()[key]++;',
        '++factory()[key];',
        'const result = obj?.[key];',
        'const result = obj[value = 1];',
        'const result = obj[value++];',
        'const result = obj[() => { return this; }];',
        'const result = obj[delete value];',
        'const result = obj[obj?.[key]];',
        'const result = obj?.[key][other];',
        'const result = factory(obj?.[key])[indexer(key)];',
        'const result = factory(arg)[indexer(obj?.[key])];',
      ];
      for (const statement of statements) {
        for (const contents of [`before(); ${statement}`, `${statement} after();`]) {
          const source = `function owner() { ${contents} }`;
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
          const recovered = parser.parse('const result = table[key];').rootNode;
          const recoveredResult = extract(emitTypeScriptCaptures(recovered), filePath, hooks);
          expect(recoveredResult.referenceSites).toEqual([
            {
              kind: 'read',
              atRange: { startLine: 1, startCol: 15, endLine: 1, endCol: 25 },
              inScope: recoveredResult.moduleScope,
              selection: {
                kind: 'computed',
                objectRange: { startLine: 1, startCol: 15, endLine: 1, endCol: 20 },
                indexRange: { startLine: 1, startCol: 21, endLine: 1, endCol: 24 },
              },
            },
            ...[
              ['table', 15, 20],
              ['key', 21, 24],
            ].map(([name, startCol, endCol]) => ({
              name,
              kind: 'read',
              inScope: recoveredResult.moduleScope,
              atRange: { startLine: 1, startCol, endLine: 1, endCol },
            })),
          ]);
        }
      }
    },
  );

  it.each(filePaths)(
    'visits optional read receivers and terminal operands exactly once in %s',
    async (filePath) => {
      for (const [expression, names] of [
        ['obj?.field', ['field', 'obj']],
        ['obj?.child.field', ['field', 'child', 'obj']],
        ['obj.child?.field', ['field', 'child', 'obj']],
        ['(/* receiver */ obj?.child)?.field', ['field', 'child', 'obj']],
        ['(obj?.child).field', ['field', 'child', 'obj']],
        ['factory(arg)?.child.field', ['field', 'child', 'factory', 'arg']],
        ['(left ?? get(alias))?.child.field', ['field', 'child', 'left', 'get', 'alias']],
        [
          'factory(inner(arg)).child.method(other)?.field',
          ['field', 'method', 'child', 'factory', 'inner', 'arg', 'other'],
        ],
      ] as const) {
        for (const value of [
          expression,
          `!(${expression})`,
          `(${expression}) + 1`,
          ...(/\.tsx?$/.test(filePath) ? [`(${expression})!`] : []),
        ]) {
          const source = `function owner(obj, arg, left, alias, other) { const value = ${value}; }`;
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const captures = emitTypeScriptCaptures(root);
          const saved = JSON.stringify(captures);
          const result = extract(captures, filePath, hooks);
          const body = result.scopes.find((scope) => scope.kind === 'Block')!;
          expect(
            result.referenceSites.map((site) => site.name),
            source,
          ).toEqual(names);
          expect(
            result.referenceSites.every((site) => site.inScope === body.id),
            source,
          ).toBe(true);
          expect(
            new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
              .size,
          ).toBe(names.length);
          expect(
            result.referenceSites
              .filter((site) => site.kind === 'call')
              .map(({ name, arity }) => [name, arity]),
          ).toEqual(
            names
              .filter((name) => ['factory', 'inner', 'get', 'method'].includes(name))
              .map((name) => [name, 1]),
          );
          const outer = root.descendantsOfType('member_expression')[0]!;
          expect(result.referenceSites[0]!.atRange).toEqual({
            startLine: outer.startPosition.row + 1,
            startCol: outer.startPosition.column,
            endLine: outer.endPosition.row + 1,
            endCol: outer.endPosition.column,
          });
          if (expression.includes('??'))
            expect(result.referenceSites[0]!.explicitReceiver).toEqual({ kind: 'unknown' });
          else if (expression === 'obj?.field')
            expect(result.referenceSites[0]!.explicitReceiver).toEqual({ name: 'obj' });
          else
            expect(result.referenceSites[0]!.explicitReceiver).toMatchObject({
              kind: 'chain',
              root: { name: expression.includes('factory') ? 'factory' : 'obj' },
            });
          parser.parse('replacement();');
          expect(JSON.stringify(captures)).toBe(saved);
          expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
        }
      }
    },
  );

  it.each(filePaths)(
    'refuses optional calls atomically under reads and value wrappers in %s',
    async (filePath) => {
      for (const expression of [
        'factory?.().field',
        'obj?.[key]?.().field',
        'obj[key]?.().field',
        '(factory?.()).field',
        '(obj?.[key]).method?.()',
        'obj?.child[key]?.().field',
      ]) {
        for (const value of [
          expression,
          `!(${expression})`,
          `(${expression}) + 1`,
          ...(/\.tsx?$/.test(filePath) ? [`(${expression})!`] : []),
        ]) {
          for (const source of [
            `before(); const value = ${value};`,
            `const value = ${value}; after();`,
          ]) {
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
            expect(() => {
              captures = emitTypeScriptCaptures(root);
            }, source).toThrow(ScopeUnsupportedSyntaxError);
            expect(captures).toBeUndefined();
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'visits optional property calls and arrow arguments once with exact ownership in %s',
    async (filePath) => {
      for (const { expression, refs } of [
        {
          expression: 'obj?.method(arg).field',
          refs: [
            ['field', 'obj?.method(arg).field'],
            ['method', 'obj?.method(arg)', 1],
            ['obj'],
            ['arg'],
          ],
        },
        {
          expression: 'obj?.child.method(arg).next(outer)',
          refs: [
            ['next', 'obj?.child.method(arg).next(outer)', 1],
            ['method', 'obj?.child.method(arg)', 1],
            ['child', 'obj?.child'],
            ['obj'],
            ['arg'],
            ['outer'],
          ],
        },
        {
          expression: '(obj?.child).method(value => value)',
          refs: [
            ['method', '(obj?.child).method(value => value)', 1],
            ['child', 'obj?.child'],
            ['obj'],
            ['value'],
          ],
        },
        {
          expression: "filePath.split('.').pop()?.toLowerCase()",
          refs: [
            ['toLowerCase', "filePath.split('.').pop()?.toLowerCase()", 0],
            ['pop', "filePath.split('.').pop()", 0],
            ['split', "filePath.split('.')", 1],
            ['filePath'],
          ],
        },
      ] as const) {
        const prefix = 'function owner(obj, arg, outer, filePath) { const result = ';
        const source = `${prefix}${expression}; }`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, expression).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const body = result.scopes.find((scope) => scope.kind === 'Block')!;
        const arrow = result.scopes.find(
          (scope) => scope.kind === 'Function' && scope.ownerDefId === null,
        );
        const arrowNode = root.descendantsOfType('arrow_function')[0];
        expect(
          result.referenceSites.map(({ name, kind, atRange, inScope, arity }) => ({
            name,
            kind,
            atRange,
            inScope,
            arity,
          })),
        ).toEqual(
          refs.map((reference) => {
            const [name, text = name, arity] = reference as readonly [string, string?, number?];
            const from =
              name === 'value'
                ? arrowNode!.childForFieldName('body')!.startPosition.column
                : prefix.length;
            const startCol = source.indexOf(text, from);
            expect(startCol, text).toBeGreaterThanOrEqual(from);
            return {
              name,
              kind: arity === undefined ? 'read' : 'call',
              arity,
              atRange: { startLine: 1, startCol, endLine: 1, endCol: startCol + text.length },
              inScope: name === 'value' ? arrow!.id : body.id,
            };
          }),
        );
        expect(
          new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
            .size,
        ).toBe(refs.length);
        expect(
          result.referenceSites
            .filter((site) => site.kind === 'call')
            .every((site) => site.callForm === 'member'),
        ).toBe(true);
        const ordinary = await parse(source.replaceAll('?.', '.'), filePath);
        const ordinaryResult = extract(emitTypeScriptCaptures(ordinary.root), filePath, hooks);
        const withoutRanges = (value: unknown) =>
          JSON.parse(
            JSON.stringify(value, (key, item) =>
              key === 'range' || key === 'atRange' || key === 'inScope' ? undefined : item,
            ),
          );
        expect(withoutRanges(result.referenceSites)).toEqual(
          withoutRanges(ordinaryResult.referenceSites),
        );
        const resolved = [
          ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
        ].flat();
        for (const site of result.referenceSites.filter((site) => site.explicitReceiver)) {
          expect(
            resolved.find(
              (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
            ),
          ).toBeUndefined();
        }
        parser.parse('replacement();');
        expect(JSON.stringify(captures)).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'resolves optional property calls to the ordinary typed target without lexical fallback in %s',
    async (filePath) => {
      const source = [
        'class Owner { method(value: number) {} }',
        'function method(value: number) {}',
        'declare const typed: Owner;',
        'let unknown;',
        'typed.method(1); typed?.method(1); (typed)?.method(1);',
        'unknown.method(1); unknown?.method(1);',
        '(typed ?? unknown)?.method(1);',
        '(unknown ? typed : unknown)?.method(1);',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, typescriptProvider);
      const calls = result.referenceSites.filter((site) => site.kind === 'call');
      expect(calls).toHaveLength(7);
      const target = result.localDefs.find((def) => def.qualifiedName === 'Owner.method')!;
      const decoy = result.localDefs.find((def) => def.qualifiedName === 'method')!;
      const resolved = [
        ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
      ].flat();
      expect(
        resolved
          .filter((reference) => reference.toDef === target.nodeId)
          .map((reference) => reference.atRange),
      ).toEqual(calls.slice(0, 3).map((site) => site.atRange));
      expect(resolved.some((reference) => reference.toDef === decoy.nodeId)).toBe(false);
      for (const site of calls.slice(3)) {
        expect(
          resolved.find(
            (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
          ),
        ).toBeUndefined();
      }
      expect(calls.slice(5).map((site) => site.explicitReceiver)).toEqual([
        { kind: 'unknown' },
        { kind: 'unknown' },
      ]);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, typescriptProvider)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'keeps dynamic nullish receivers unresolved while preserving operands and argument scopes in %s',
    async (filePath) => {
      const source = [
        'function filter(value) {}',
        'let field = 1; let left = 1; let alias = 1;',
        'function get(value) { return value; }',
        '(/* café */ left ?? get(alias)).filter(value => value);',
        '((left ?? get(alias)).child).field;',
        '((left ?? get(alias)).child()).filter(alias);',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const arrowNode = root.descendantsOfType('arrow_function')[0]!;
      const arrow = result.scopes.find(
        (scope) =>
          scope.kind === 'Function' &&
          scope.range.startLine === arrowNode.startPosition.row + 1 &&
          scope.range.startCol === arrowNode.startPosition.column,
      )!;
      expect(arrow).toBeDefined();
      expect(
        result.referenceSites.map(({ name, kind, explicitReceiver }) => ({
          name,
          kind,
          explicitReceiver,
        })),
      ).toEqual([
        { name: 'value', kind: 'read', explicitReceiver: undefined },
        { name: 'filter', kind: 'call', explicitReceiver: { kind: 'unknown' } },
        { name: 'left', kind: 'read', explicitReceiver: undefined },
        { name: 'get', kind: 'call', explicitReceiver: undefined },
        { name: 'alias', kind: 'read', explicitReceiver: undefined },
        { name: 'value', kind: 'read', explicitReceiver: undefined },
        { name: 'field', kind: 'read', explicitReceiver: { kind: 'unknown' } },
        { name: 'child', kind: 'read', explicitReceiver: { kind: 'unknown' } },
        { name: 'left', kind: 'read', explicitReceiver: undefined },
        { name: 'get', kind: 'call', explicitReceiver: undefined },
        { name: 'alias', kind: 'read', explicitReceiver: undefined },
        { name: 'filter', kind: 'call', explicitReceiver: { kind: 'unknown' } },
        { name: 'child', kind: 'call', explicitReceiver: { kind: 'unknown' } },
        { name: 'left', kind: 'read', explicitReceiver: undefined },
        { name: 'get', kind: 'call', explicitReceiver: undefined },
        { name: 'alias', kind: 'read', explicitReceiver: undefined },
        { name: 'alias', kind: 'read', explicitReceiver: undefined },
      ]);
      expect(result.referenceSites.filter((site) => site.name === 'get')).toHaveLength(3);
      expect(
        result.referenceSites.filter((site) => site.inScope === arrow.id).map((site) => site.name),
      ).toEqual(['value']);
      const indexes = finalizeScopeModel([result]);
      const fields = buildFieldRegistry(buildScopeRegistryContext(indexes));
      expect(fields.lookup('field', result.moduleScope)).toHaveLength(1);
      expect(
        fields.lookup('field', result.moduleScope, { explicitReceiver: { kind: 'unknown' } }),
      ).toEqual([]);
      const resolved = [...resolveReferences(indexes).referenceIndex.bySourceScope.values()].flat();
      const unresolvedMembers = result.referenceSites.filter(
        (site) => site.explicitReceiver !== undefined,
      );
      for (const site of unresolvedMembers) {
        expect(
          resolved.find(
            (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
          ),
        ).toBeUndefined();
      }
      for (const site of result.referenceSites.filter(
        (site) => site.explicitReceiver === undefined,
      )) {
        expect(
          resolved.find(
            (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
          ),
        ).toBeDefined();
      }
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'keeps conditional receivers unknown with exact operand order and lexical ownership in %s',
    async (filePath) => {
      const cases = [
        {
          expression: '(condition ? left : right).method(outer)',
          refs: [
            {
              name: 'method',
              text: '(condition ? left : right).method(outer)',
              arity: 1,
              member: true,
            },
            { name: 'condition' },
            { name: 'left' },
            { name: 'right' },
            { name: 'outer' },
          ],
        },
        {
          expression: '((/* choice */ condition ? first(arg) : second(outer))).field',
          refs: [
            {
              name: 'field',
              text: '((/* choice */ condition ? first(arg) : second(outer))).field',
              member: true,
            },
            { name: 'condition' },
            { name: 'first', text: 'first(arg)', arity: 1 },
            { name: 'arg' },
            { name: 'second', text: 'second(outer)', arity: 1 },
            { name: 'outer' },
          ],
        },
        {
          expression: '(condition ? first(arg) : second(outer)).child().method(value => value)',
          refs: [
            {
              name: 'method',
              text: '(condition ? first(arg) : second(outer)).child().method(value => value)',
              arity: 1,
              member: true,
            },
            {
              name: 'child',
              text: '(condition ? first(arg) : second(outer)).child()',
              arity: 0,
              member: true,
            },
            { name: 'condition' },
            { name: 'first', text: 'first(arg)', arity: 1 },
            { name: 'arg' },
            { name: 'second', text: 'second(outer)', arity: 1 },
            { name: 'outer' },
            { name: 'value', arrow: true },
          ],
        },
        {
          expression: '((condition ? (nested ? left : right) : fallback) ?? backup).field',
          refs: [
            {
              name: 'field',
              text: '((condition ? (nested ? left : right) : fallback) ?? backup).field',
              member: true,
            },
            { name: 'condition' },
            { name: 'nested' },
            { name: 'left' },
            { name: 'right' },
            { name: 'fallback' },
            { name: 'backup' },
          ],
        },
        {
          expression: '(first(arg) ? left : right).field',
          refs: [
            { name: 'field', text: '(first(arg) ? left : right).field', member: true },
            { name: 'first', text: 'first(arg)', arity: 1 },
            { name: 'arg' },
            { name: 'left' },
            { name: 'right' },
          ],
        },
      ];
      for (const { expression, refs } of cases) {
        const prefix =
          'function method(value) {} function child() {} let field = 1; ' +
          'function first(value) {} function second(value) {} ' +
          'function owner(condition, nested, left, right, fallback, backup, arg, outer) { ';
        const source = `${prefix}${expression}; }`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, expression).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const ownerNode = root
          .descendantsOfType('function_declaration')
          .find((node) => node.childForFieldName('name')!.text === 'owner')!;
        const rangeOf = (node: typeof root) => ({
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column,
        });
        const scopeFor = (node: typeof root, kind: 'Block' | 'Function') => {
          const scope = result.scopes.find(
            (candidate) =>
              candidate.kind === kind &&
              JSON.stringify(candidate.range) === JSON.stringify(rangeOf(node)),
          );
          expect(scope, expression).toBeDefined();
          return scope!;
        };
        const body = scopeFor(ownerNode.childForFieldName('body')!, 'Block');
        const owner = scopeFor(ownerNode, 'Function');
        const arrowNode = root.descendantsOfType('arrow_function')[0];
        const arrow = arrowNode ? scopeFor(arrowNode, 'Function') : undefined;
        const expected = refs.map((reference) => {
          const {
            name,
            text = name,
            arity,
            member,
            arrow: inArrow,
          } = reference as {
            name: string;
            text?: string;
            arity?: number;
            member?: boolean;
            arrow?: boolean;
          };
          const from = inArrow
            ? arrowNode!.childForFieldName('body')!.startPosition.column
            : prefix.length;
          const startCol = source.indexOf(text, from);
          expect(startCol, text).toBeGreaterThanOrEqual(from);
          return {
            name,
            kind: arity === undefined ? 'read' : 'call',
            atRange: { startLine: 1, startCol, endLine: 1, endCol: startCol + text.length },
            inScope: inArrow ? arrow!.id : body.id,
            ...(arity === undefined ? {} : { callForm: member ? 'member' : 'free', arity }),
            ...(member ? { explicitReceiver: { kind: 'unknown' } } : {}),
          };
        });
        expect(result.referenceSites, expression).toEqual(expected);
        const resolution = resolveReferences(finalizeScopeModel([result]));
        const resolved = [...resolution.referenceIndex.bySourceScope.values()].flat();
        for (const site of result.referenceSites) {
          const reference = resolved.find(
            (candidate) => JSON.stringify(candidate.atRange) === JSON.stringify(site.atRange),
          );
          if (site.explicitReceiver) expect(reference, expression).toBeUndefined();
          else {
            const binding =
              site.name === 'value'
                ? arrow!.bindings.get('value')![0]!
                : site.kind === 'call'
                  ? result.scopes[0]!.bindings.get(site.name)![0]!
                  : owner.bindings.get(site.name)![0]!;
            expect(reference, expression).toMatchObject({
              toDef: binding.def.nodeId,
              fromScope: site.inScope,
              atRange: site.atRange,
            });
          }
        }
        expect(
          new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
            .size,
        ).toBe(expected.length);
        parser.parse('replacement();');
        expect(JSON.stringify(captures)).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'refuses malformed and unsupported conditional receivers atomically in %s',
    async (filePath) => {
      for (const expression of [
        '(condition ? left : ).method()',
        '(condition ? : right).field',
        '(condition left : right).field',
        '(this ? left : right).method()',
        '(condition ? this : right).field',
        '(condition ? left : this).field',
        '(condition ? obj?.[key].deep : right).field',
        '(condition ? left : obj?.[key]).method()',
        '(condition ? first(...make()) : right).field',
        '(condition ? left : second?.()).field',
        '(condition ? left : right)()',
        '(condition ? left : right)[key]?.()',
        ...(/\.tsx?$/.test(filePath)
          ? [
              '(condition ? left : right).method<Type>()',
              '(condition ? (obj as typeof Type) : right).field',
            ]
          : []),
      ]) {
        for (const source of [`before(); ${expression};`, `${expression}; after();`]) {
          const { parser, root } = await parse(source, filePath);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
          const recovered = parser.parse('(condition ? left : right).field;').rootNode;
          expect(
            extract(emitTypeScriptCaptures(recovered), filePath, hooks).referenceSites.map(
              (site) => site.name,
            ),
          ).toEqual(['field', 'condition', 'left', 'right']);
        }
      }
    },
  );

  it.each(filePaths)(
    'visits a nullish registry-call receiver and arrow argument once in %s',
    async (filePath) => {
      const source =
        'function filter(value) {} let scope = 1; let alias = 1; ' +
        '(scope.bindings.get(alias) ?? []).filter(value => value);';
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      expect(result.referenceSites.map((site) => [site.name, site.kind])).toEqual([
        ['filter', 'call'],
        ['get', 'call'],
        ['bindings', 'read'],
        ['scope', 'read'],
        ['alias', 'read'],
        ['value', 'read'],
      ]);
      expect(result.referenceSites[0]).toMatchObject({ explicitReceiver: { kind: 'unknown' } });
      const bindings = root
        .descendantsOfType('member_expression')
        .find((node) => node.text === 'scope.bindings')!;
      expect(result.referenceSites[2]).toEqual({
        name: 'bindings',
        kind: 'read',
        inScope: result.moduleScope,
        explicitReceiver: { name: 'scope' },
        atRange: {
          startLine: bindings.startPosition.row + 1,
          startCol: bindings.startPosition.column,
          endLine: bindings.endPosition.row + 1,
          endCol: bindings.endPosition.column,
        },
      });
      expect(
        new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
          .size,
      ).toBe(result.referenceSites.length);
      const resolution = resolveReferences(finalizeScopeModel([result]));
      const resolved = [...resolution.referenceIndex.bySourceScope.values()].flat();
      const decoy = result.scopes[0]!.bindings.get('filter')![0]!.def;
      expect(resolved.some((reference) => reference.toDef === decoy.nodeId)).toBe(false);
      for (const name of ['scope', 'alias', 'value']) {
        const site = result.referenceSites.find((reference) => reference.name === name)!;
        expect(
          resolved.some(
            (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
          ),
        ).toBe(true);
      }
    },
  );

  it.each(filePaths)(
    'visits parenthesized terminal receiver calls and outer arguments once in %s',
    async (filePath) => {
      const { root } = await parse('(factory(arg)).method(outer);', filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      expect(result.referenceSites.map((site) => [site.name, site.kind])).toEqual([
        ['method', 'call'],
        ['factory', 'call'],
        ['arg', 'read'],
        ['outer', 'read'],
      ]);
      const inner = root.descendantsOfType('call_expression')[1]!;
      const callee = inner.childForFieldName('function')!;
      const rangeOf = (node: typeof inner) => ({
        startLine: node.startPosition.row + 1,
        startCol: node.startPosition.column,
        endLine: node.endPosition.row + 1,
        endCol: node.endPosition.column,
      });
      expect(result.referenceSites[0]!.explicitReceiver).toEqual({
        kind: 'chain',
        root: { name: 'factory', range: rangeOf(callee) },
        steps: [{ kind: 'call', arity: 1, range: rangeOf(inner) }],
      });
    },
  );

  it.each(filePaths)('refuses excluded dynamic receivers atomically in %s', async (filePath) => {
    for (const receiver of [
      '(left ? this : second)',
      '(left || right)',
      '(left && right)',
      '(left + right)',
      '(obj?.[key])',
      '(() => value)',
      ...(/\.tsx?$/.test(filePath) ? ['(obj as const)'] : []),
    ]) {
      for (const expression of [`${receiver}.method()`, `${receiver}.field`]) {
        const { parser, root } = await parse(
          `before(); const result = ${expression}; after();`,
          filePath,
        );
        expect(root.hasError, expression).toBe(false);
        let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
        expect(() => {
          captures = emitTypeScriptCaptures(root);
        }, expression).toThrow(ScopeUnsupportedSyntaxError);
        expect(captures).toBeUndefined();
        const recovered = parser.parse('(left ?? right).method();').rootNode;
        expect(emitTypeScriptCaptures(recovered).length).toBeGreaterThan(0);
      }
    }
  });

  it.each(filePaths)(
    'resolves individual array bindings and visits initializers once in %s',
    async (filePath) => {
      const source = [
        'let source = 1;',
        'const [first, second,] = pair(source); use(first, second);',
        '{ let [first] = pair(source); use(first); }',
        'function owner(input) { const [local] = pair(input); use(local); }',
        'after(first);',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const module = result.scopes[0]!;
      const [block, body] = result.scopes.filter((scope) => scope.kind === 'Block');
      expect([...module.bindings.keys()]).toEqual(['source', 'first', 'second', 'owner']);
      expect([...block!.bindings.keys()]).toEqual(['first']);
      expect([...body!.bindings.keys()]).toEqual(['local']);
      expect(result.referenceSites.map((site) => [site.name, site.kind])).toEqual([
        ['pair', 'call'],
        ['source', 'read'],
        ['use', 'call'],
        ['first', 'read'],
        ['second', 'read'],
        ['pair', 'call'],
        ['source', 'read'],
        ['use', 'call'],
        ['first', 'read'],
        ['pair', 'call'],
        ['input', 'read'],
        ['use', 'call'],
        ['local', 'read'],
        ['after', 'call'],
        ['first', 'read'],
      ]);
      const resolution = resolveReferences(finalizeScopeModel([result]));
      expect(resolution.stats).toEqual({
        totalSites: 15,
        resolvedSites: 8,
        unresolvedSites: 7,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      const resolved = [...resolution.referenceIndex.bySourceScope.values()].flat();
      for (const site of result.referenceSites.filter((site) => site.kind === 'read')) {
        const scope = result.scopes.find((scope) => scope.id === site.inScope)!;
        const binding =
          scope.bindings.get(site.name)?.[0] ??
          result.scopes
            .find((candidate) => candidate.id === scope.parent)
            ?.bindings.get(site.name)?.[0] ??
          module.bindings.get(site.name)![0]!;
        expect(
          resolved.find(
            (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
          ),
        ).toMatchObject({
          toDef: binding.def.nodeId,
          fromScope: site.inScope,
          atRange: site.atRange,
        });
      }
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'exports array identifiers and keeps initializer arrows in their own scope in %s',
    async (filePath) => {
      const source =
        'export const [/* first */ café, second,] = value => value, ordinary = 1; use(café, second, ordinary);';
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const module = result.scopes[0]!;
      const arrow = result.scopes.find((scope) => scope.kind === 'Function')!;
      expect([...module.bindings.keys()]).toEqual(['café', 'second', 'ordinary']);
      expect([...arrow.bindings.keys()]).toEqual(['value']);
      expect(arrow.parent).toBe(module.id);
      expect(result.exports).toEqual(
        new Map(
          ['café', 'second', 'ordinary'].map((name) => [
            name,
            module.bindings.get(name)![0]!.def.nodeId,
          ]),
        ),
      );
      expect(result.scopes.every((scope) => scope.typeBindings.size === 0)).toBe(true);
      expect(result.referenceSites.map((site) => [site.name, site.inScope])).toEqual([
        ['value', arrow.id],
        ['use', module.id],
        ['café', module.id],
        ['second', module.id],
        ['ordinary', module.id],
      ]);
      expect(resolveReferences(finalizeScopeModel([result])).stats).toEqual({
        totalSites: 5,
        resolvedSites: 4,
        unresolvedSites: 1,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
    },
  );

  it.each(filePaths)(
    'refuses array collisions and excluded binding positions without partial captures in %s',
    async (filePath) => {
      for (const statement of [
        'let [value, value] = input;',
        'const [value] = input; let value;',
        'let [value] = input, value = 1;',
        'let value = 1, [value] = input;',
        'let value; const [value] = input;',
        '{ let [value] = input; const value = 1; }',
        "import value from './module'; const [value] = input;",
        "let [value] = input; import value from './module';",
        'var value; let [value] = input;',
        'let [value] = input; { var value; }',
        'function owner() { let [value] = input; { var value; } }',
        'try {} catch (value) { let [value] = input; }',
        'var [value] = input;',
        'for (let [value] = input; ready; next()) {}',
        'for (let [value] of input) {}',
        'function owner([[value]]) {}',
        'try {} catch ([value]) {}',
        '([value] = input);',
        'let [] = input;',
        'const [,value] = input;',
        'let [value,,] = input;',
        'const [value = fallback] = input;',
        'let [...value] = input;',
        'const [[value]] = input;',
        'let [{value}] = input;',
        ...(/\.tsx?$/.test(filePath)
          ? ['let [value]: [A] = input;', 'declare const [value]: A[];']
          : []),
      ]) {
        for (const source of [`before(); ${statement}`, `${statement} after();`]) {
          const { root } = await parse(source, filePath);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'owns expression arrow parameters, nested closures and outer siblings in %s',
    async (filePath) => {
      const source =
        'let value; let closed; const callback = value => pair(value, other => pair(value, other, closed)); after(value, callback);';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const [module, outer, inner] = result.scopes;
      const rangeOf = (node: typeof root) => ({
        startLine: node.startPosition.row + 1,
        startCol: node.startPosition.column,
        endLine: node.endPosition.row + 1,
        endCol: node.endPosition.column,
      });
      const arrows = root.descendantsOfType('arrow_function');
      expect(result.scopes.map((scope) => scope.kind)).toEqual(['Module', 'Function', 'Function']);
      expect([outer!.parent, inner!.parent]).toEqual([module!.id, outer!.id]);
      expect([outer!.range, inner!.range]).toEqual(arrows.map(rangeOf));
      expect([outer!.ownerDefId, inner!.ownerDefId]).toEqual([
        module!.bindings.get('callback')![0]!.def.nodeId,
        null,
      ]);
      expect([...module!.bindings.keys()]).toEqual(['value', 'closed', 'callback']);
      expect([...outer!.bindings.keys()]).toEqual(['value']);
      expect([...inner!.bindings.keys()]).toEqual(['other']);
      expect(result.localDefs.filter((def) => def.type === 'Function')).toEqual([
        module!.bindings.get('callback')![0]!.def,
      ]);
      const calls = root.descendantsOfType('call_expression');
      const firstArguments = calls[0]!.childForFieldName('arguments')!.namedChildren;
      const innerArguments = calls[1]!.childForFieldName('arguments')!.namedChildren;
      const afterArguments = calls[2]!.childForFieldName('arguments')!.namedChildren;
      const ordered = [
        [calls[0]!, outer!],
        [firstArguments[0]!, outer!],
        [calls[1]!, inner!],
        ...innerArguments.map((node) => [node, inner!] as const),
        [calls[2]!, module!],
        ...afterArguments.map((node) => [node, module!] as const),
      ] as const;
      expect(result.referenceSites).toEqual(
        ordered.map(([node, scope]) =>
          node.type === 'call_expression'
            ? {
                name: node.childForFieldName('function')!.text,
                kind: 'call',
                callForm: 'free',
                arity: node.childForFieldName('arguments')!.namedChildCount,
                atRange: rangeOf(node),
                inScope: scope.id,
              }
            : { name: node.text, kind: 'read', atRange: rangeOf(node), inScope: scope.id },
        ),
      );
      const resolution = resolveReferences(finalizeScopeModel([result]));
      expect(resolution.stats).toEqual({
        totalSites: 9,
        resolvedSites: 5,
        unresolvedSites: 4,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      const resolved = [...resolution.referenceIndex.bySourceScope.values()].flat();
      const targets = [
        outer!.bindings.get('value')![0]!.def,
        outer!.bindings.get('value')![0]!.def,
        inner!.bindings.get('other')![0]!.def,
        module!.bindings.get('closed')![0]!.def,
        module!.bindings.get('value')![0]!.def,
        module!.bindings.get('callback')![0]!.def,
      ];
      for (const [index, site] of result.referenceSites
        .filter((site) => site.kind === 'read')
        .entries()) {
        // Function values are outside the field registry's supported read kinds.
        if (site.name === 'callback') {
          expect(
            resolved.some(
              (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
            ),
          ).toBe(false);
          continue;
        }
        expect(
          resolved.find(
            (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
          ),
        ).toMatchObject({
          kind: 'read',
          toDef: targets[index]!.nodeId,
          fromScope: site.inScope,
          atRange: site.atRange,
        });
      }
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'admits expression arrows recursively in supported value contexts in %s',
    async (filePath) => {
      const arrow = '(first, second) => pair(first, second, closed)';
      for (const statement of [
        `const callback = ${arrow};`,
        `consume(${arrow});`,
        `return (${arrow});`,
        `throw (${arrow});`,
        `if (${arrow}) { branch(); }`,
        `const array = [${arrow}];`,
        `const object = {callback: ${arrow}};`,
        `target = (${arrow});`,
        `const binary = good + (${arrow});`,
        'const template = `text ${' + arrow + '}`;',
        ...(/\.tsx?$/.test(filePath) ? [`const asserted = (${arrow})!;`] : []),
      ]) {
        const source = `function owner(closed) { before(); ${statement} after(closed); }`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const functions = result.scopes.filter((scope) => scope.kind === 'Function');
        const expressionOwner = functions[1]!;
        const body = result.scopes.find((scope) => scope.kind === 'Block')!;
        expect(functions, source).toHaveLength(2);
        expect(expressionOwner.parent, source).toBe(body.id);
        expect(expressionOwner.ownerDefId, source).toBe(
          statement.startsWith('const callback =')
            ? result.localDefs.find((def) => def.qualifiedName === 'callback')!.nodeId
            : null,
        );
        expect([...expressionOwner.bindings.keys()], source).toEqual(['first', 'second']);
        expect(
          result.scopes.filter((scope) => scope.parent === expressionOwner.id),
          source,
        ).toEqual([]);
        const pair = root
          .descendantsOfType('call_expression')
          .find((node) => node.text === 'pair(first, second, closed)')!;
        const rangeOf = (node: typeof root) => ({
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column,
        });
        expect(
          result.referenceSites.filter((site) => site.inScope === expressionOwner.id),
          source,
        ).toEqual([
          {
            name: 'pair',
            kind: 'call',
            callForm: 'free',
            arity: 3,
            atRange: rangeOf(pair),
            inScope: expressionOwner.id,
          },
          ...pair.childForFieldName('arguments')!.namedChildren.map((node) => ({
            name: node.text,
            kind: 'read',
            atRange: rangeOf(node),
            inScope: expressionOwner.id,
          })),
        ]);
        const arrowStart = result.referenceSites.findIndex(
          (site) => site.inScope === expressionOwner.id,
        );
        expect(
          result.referenceSites.slice(arrowStart, arrowStart + 4).map((site) => site.name),
          source,
        ).toEqual(['pair', 'first', 'second', 'closed']);
        expect(result.referenceSites.at(-1), source).toMatchObject({
          name: 'closed',
          inScope: body.id,
        });
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'keeps arrow parameter imports separate and accepts empty and annotated signatures in %s',
    async (filePath) => {
      for (const arrow of [
        'Imported => Imported',
        '(Imported) => Imported',
        '() => Imported',
        '(Imported, other) => pair(Imported, other)',
        '(/* parameter */ Imported /* trailing */) /* arrow */ => /* body */ Imported',
        ...(/\.tsx?$/.test(filePath)
          ? [
              '(Imported: string): string => Imported',
              '(Imported?: string): string => Imported',
              '(Imported: string, other?: string): string => pair(Imported, other)',
            ]
          : []),
      ]) {
        for (const importedFirst of [false, true]) {
          const imported = "import Imported from './module';";
          const source = `${importedFirst ? imported : ''} const callback = ${arrow}; ${importedFirst ? '' : imported} after(Imported);`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
          const module = result.scopes[0]!;
          const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
          expect([...module.bindings.keys()], source).toEqual(['callback']);
          expect(owner.ownerDefId, source).toBe(module.bindings.get('callback')![0]!.def.nodeId);
          expect([...owner.bindings.keys()], source).toEqual(
            arrow.startsWith('()')
              ? []
              : arrow.includes('other')
                ? ['Imported', 'other']
                : ['Imported'],
          );
          expect(result.parsedImports, source).toEqual([
            {
              kind: 'alias',
              localName: 'Imported',
              importedName: 'default',
              alias: 'Imported',
              targetRaw: './module',
            },
          ]);
          expect(result.referenceSites.at(-1), source).toMatchObject({
            name: 'Imported',
            kind: 'read',
            inScope: module.id,
          });
        }
      }
    },
  );

  it.each(filePaths)(
    'handles nested expression arrow depth with distinct anonymous owners in %s',
    async (filePath) => {
      const depth = 128;
      const source = `const callback = ${Array.from({ length: depth }, (_, index) => `p${index} => `).join('')}consume(p0, p127);`;
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const owners = result.scopes.filter((scope) => scope.kind === 'Function');
      expect(owners).toHaveLength(depth);
      expect(owners.map((scope) => scope.parent)).toEqual([
        result.moduleScope,
        ...owners.slice(0, -1).map((scope) => scope.id),
      ]);
      expect(owners.map((scope) => [...scope.bindings.keys()])).toEqual(
        Array.from({ length: depth }, (_, index) => [`p${index}`]),
      );
      expect(owners[0]!.ownerDefId).toBe(
        result.localDefs.find((def) => def.qualifiedName === 'callback')!.nodeId,
      );
      expect(owners.slice(1).every((scope) => scope.ownerDefId === null)).toBe(true);
      expect(result.referenceSites.map((site) => [site.name, site.inScope])).toEqual(
        ['consume', 'p0', 'p127'].map((name) => [name, owners.at(-1)!.id]),
      );
      expect(resolveReferences(finalizeScopeModel([result])).stats).toEqual({
        totalSites: 3,
        resolvedSites: 2,
        unresolvedSites: 1,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
    },
  );

  it.each(filePaths)(
    'owns block arrow parameters, body locals and returned closures with detached captures in %s',
    async (filePath) => {
      const source =
        'let closed; const callback = value => { const local = value; { let value = local; consume(value); } return other => { return pair(value, other, closed); }; }; after(closed, callback);';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const [module, outer, body, shadow, inner, innerBody] = result.scopes;
      expect(result.scopes.map((scope) => scope.kind)).toEqual([
        'Module',
        'Function',
        'Block',
        'Block',
        'Function',
        'Block',
      ]);
      expect(result.scopes.slice(1).map((scope) => scope.parent)).toEqual([
        module!.id,
        outer!.id,
        body!.id,
        body!.id,
        inner!.id,
      ]);
      expect(result.scopes.map((scope) => [...scope.bindings.keys()])).toEqual([
        ['closed', 'callback'],
        ['value'],
        ['local'],
        ['value'],
        ['other'],
        [],
      ]);
      expect([outer!.ownerDefId, inner!.ownerDefId]).toEqual([
        module!.bindings.get('callback')![0]!.def.nodeId,
        null,
      ]);
      expect(result.localDefs.filter((def) => def.type === 'Function')).toEqual([
        module!.bindings.get('callback')![0]!.def,
      ]);
      const rangeOf = (node: typeof root) => ({
        startLine: node.startPosition.row + 1,
        startCol: node.startPosition.column,
        endLine: node.endPosition.row + 1,
        endCol: node.endPosition.column,
      });
      expect([outer!.range, inner!.range]).toEqual(
        root.descendantsOfType('arrow_function').map(rangeOf),
      );
      expect([body!.range, shadow!.range, innerBody!.range]).toEqual(
        root.descendantsOfType('statement_block').map(rangeOf),
      );
      const declarations = root.descendantsOfType('variable_declarator');
      const calls = root.descendantsOfType('call_expression');
      const ordered = [
        [
          declarations.find((node) => node.text === 'local = value')!.childForFieldName('value')!,
          body!,
        ],
        [
          declarations.find((node) => node.text === 'value = local')!.childForFieldName('value')!,
          shadow!,
        ],
        [calls[0]!, shadow!],
        ...calls[0]!
          .childForFieldName('arguments')!
          .namedChildren.map((node) => [node, shadow!] as const),
        [calls[1]!, innerBody!],
        ...calls[1]!
          .childForFieldName('arguments')!
          .namedChildren.map((node) => [node, innerBody!] as const),
        [calls[2]!, module!],
        ...calls[2]!
          .childForFieldName('arguments')!
          .namedChildren.map((node) => [node, module!] as const),
      ] as const;
      expect(result.referenceSites).toEqual(
        ordered.map(([node, scope]) =>
          node.type === 'call_expression'
            ? {
                name: node.childForFieldName('function')!.text,
                kind: 'call',
                callForm: 'free',
                arity: node.childForFieldName('arguments')!.namedChildCount,
                atRange: rangeOf(node),
                inScope: scope.id,
              }
            : { name: node.text, kind: 'read', atRange: rangeOf(node), inScope: scope.id },
        ),
      );
      expect(
        new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
          .size,
      ).toBe(result.referenceSites.length);
      const resolved = [
        ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
      ].flat();
      const targets = [
        outer!.bindings.get('value')![0]!.def,
        body!.bindings.get('local')![0]!.def,
        shadow!.bindings.get('value')![0]!.def,
        outer!.bindings.get('value')![0]!.def,
        inner!.bindings.get('other')![0]!.def,
        module!.bindings.get('closed')![0]!.def,
        module!.bindings.get('closed')![0]!.def,
        module!.bindings.get('callback')![0]!.def,
      ];
      for (const [index, site] of result.referenceSites
        .filter((site) => site.kind === 'read')
        .entries()) {
        // Function values are outside the field registry's supported read kinds.
        if (site.name === 'callback') {
          expect(
            resolved.some(
              (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
            ),
          ).toBe(false);
          continue;
        }
        expect(
          resolved.find(
            (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
          ),
        ).toMatchObject({
          kind: 'read',
          toDef: targets[index]!.nodeId,
          fromScope: site.inScope,
          atRange: site.atRange,
        });
      }
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'admits block arrows in callbacks and resets return and loop context in %s',
    async (filePath) => {
      for (const statement of [
        'const callback = value => { return value; };',
        'consume(value => { return value; });',
        'while (ready) { consume(value => { return value; }); }',
        'const callback = value => { while (ready) { continue; } return value; };',
        'const callback = (options = {}) => { return options; };',
        'const callback = () => { return; };',
      ]) {
        const { root } = await parse(statement, filePath);
        expect(root.hasError, statement).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
        const body = result.scopes.find(
          (scope) => scope.kind === 'Block' && scope.parent === owner.id,
        )!;
        expect(owner.ownerDefId, statement).toBe(
          statement.startsWith('const callback =')
            ? result.localDefs.find((def) => def.qualifiedName === 'callback')!.nodeId
            : null,
        );
        expect(body, statement).toBeDefined();
        const name = statement.includes('options') ? 'options' : 'value';
        expect([...owner.bindings.keys()], statement).toEqual(
          statement.includes('() =>') ? [] : [name],
        );
        expect(
          result.referenceSites.filter((site) => site.name === name).map((site) => site.inScope),
          statement,
        ).toEqual(statement.includes('() =>') ? [] : [body.id]);
      }
      for (const body of ['continue;', 'if (ready) { continue; }']) {
        const source = `while (ready) { consume(() => { ${body} }); }`;
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        expect(() => emitTypeScriptCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
      }
      const { root } = await parse('return value;', filePath);
      expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
    },
  );

  it.each(filePaths)(
    'hoists block arrow var declarations while retaining lexical collision guards in %s',
    async (filePath) => {
      const source =
        'let value; const callback = value => { var value; { var repeated = value; } var repeated; return repeated; }; after(value);';
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
      expect([...owner.bindings.keys()]).toEqual(['value', 'repeated']);
      expect(owner.bindings.get('value')).toHaveLength(1);
      expect(owner.bindings.get('repeated')).toHaveLength(1);
      expect(
        result.scopes
          .filter((scope) => scope.kind === 'Block')
          .map((scope) => [...scope.bindings.keys()]),
      ).toEqual([[], []]);
      const resolved = [
        ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
      ].flat();
      const targets = [
        owner.bindings.get('value')![0]!.def,
        owner.bindings.get('repeated')![0]!.def,
        result.scopes[0]!.bindings.get('value')![0]!.def,
      ];
      for (const [index, site] of result.referenceSites
        .filter((site) => site.kind === 'read')
        .entries()) {
        expect(
          resolved.find(
            (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
          ),
        ).toMatchObject({ toDef: targets[index]!.nodeId, fromScope: site.inScope });
      }
      for (const arrow of [
        'value => { let value; }',
        'value => { const value = outer; }',
        'value => { let local; { var local; } }',
        '(options = {}) => { var options; }',
        '(options = {}) => { var other; }',
        '(options = {}) => { "use strict"; }',
        '() => { return super.value; }',
        '() => { target = value = other; }',
        '(...values) => { return values; }',
        ...(/\.tsx?$/.test(filePath) ? ['<T,>(value: T) => { return value; }'] : []),
      ]) {
        const { root: rejected } = await parse(
          `before(); const callback = ${arrow}; after();`,
          filePath,
        );
        let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
        expect(() => {
          captures = emitTypeScriptCaptures(rejected);
        }, arrow).toThrow(ScopeUnsupportedSyntaxError);
        expect(captures, arrow).toBeUndefined();
      }
    },
  );

  it.each(filePaths)(
    'retains distinct owners through nested block arrow returns in %s',
    async (filePath) => {
      const depth = 32;
      const source = `const callback = ${Array.from({ length: depth }, (_, index) => `p${index} => { return `).join('')}pair(p0, p31)${'; }'.repeat(depth)};`;
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const owners = result.scopes.filter((scope) => scope.kind === 'Function');
      const bodies = result.scopes.filter((scope) => scope.kind === 'Block');
      expect(owners).toHaveLength(depth);
      expect(bodies).toHaveLength(depth);
      expect(owners.map((scope) => scope.parent)).toEqual([
        result.moduleScope,
        ...bodies.slice(0, -1).map((scope) => scope.id),
      ]);
      expect(bodies.map((scope) => scope.parent)).toEqual(owners.map((scope) => scope.id));
      expect(owners.map((scope) => [...scope.bindings.keys()])).toEqual(
        Array.from({ length: depth }, (_, index) => [`p${index}`]),
      );
      expect(result.referenceSites.map((site) => [site.name, site.inScope])).toEqual(
        ['pair', 'p0', 'p31'].map((name) => [name, bodies.at(-1)!.id]),
      );
      expect(resolveReferences(finalizeScopeModel([result])).stats).toEqual({
        totalSites: 3,
        resolvedSites: 2,
        unresolvedSites: 1,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
    },
  );

  it.each(filePaths)(
    'rejects unsupported arrow signatures, bodies and reference positions atomically in %s',
    async (filePath) => {
      const arrows = [
        '() => { return this; }',
        '(value = 1) => value',
        '(...values) => values',
        '({value: {nested}}) => nested',
        '([[value]]) => value',
        '(value, value) => value',
        'value => obj?.[key]',
        'value => value = 1',
        'value => value++',
        ...(/\.tsx?$/.test(filePath)
          ? [
              '<T,>(value: T) => value',
              '(value: () => typeof value) => value',
              '(first?: string, second: string) => second',
              '(value): (() => typeof value) => value',
            ]
          : []),
      ];
      const statements = [
        ...arrows.flatMap((arrow) => [
          `const callback = ${arrow};`,
          `consume(good(), ${arrow});`,
          `consume(${arrow}, good());`,
        ]),
        '(value => value);',
        '(() => value)?.();',
        '(value => value).field;',
        ...(/\.tsx?$/.test(filePath) ? ['(value => value)!;'] : []),
      ];
      for (const statement of statements) {
        for (const source of [`before(); ${statement}`, `${statement} after();`]) {
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'captures braced while conditions in the enclosing scope and resolves body shadows in %s',
    async (filePath) => {
      const source =
        'function owner(value) { before(); while (check(value)) { let value = inner(); use(value); } after(value); }';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const rangeOf = (node: typeof root) => ({
        startLine: node.startPosition.row + 1,
        startCol: node.startPosition.column,
        endLine: node.endPosition.row + 1,
        endCol: node.endPosition.column,
      });
      const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
      const [body, loopBody] = result.scopes.filter((scope) => scope.kind === 'Block');
      expect(result.scopes.map((scope) => scope.kind)).toEqual([
        'Module',
        'Function',
        'Block',
        'Block',
      ]);
      expect(owner.parent).toBe(result.moduleScope);
      expect(body!.parent).toBe(owner.id);
      expect(loopBody!.parent).toBe(body!.id);
      expect([body!.range, loopBody!.range]).toEqual(
        root.descendantsOfType('statement_block').map(rangeOf),
      );
      expect(result.localDefs.map((def) => def.qualifiedName)).toEqual(['owner', 'value', 'value']);
      const parameter = owner.bindings.get('value')![0]!.def;
      const shadow = loopBody!.bindings.get('value')![0]!.def;
      expect(shadow.nodeId).not.toBe(parameter.nodeId);
      expect(body!.bindings.has('value')).toBe(false);
      const calls = root.descendantsOfType('call_expression');
      const nodes = calls.flatMap((call) => [
        call,
        ...call.childForFieldName('arguments')!.namedChildren,
      ]);
      expect(result.referenceSites).toEqual(
        nodes.map((node) => {
          const inScope =
            node.startIndex >=
              root.descendantsOfType('while_statement')[0]!.childForFieldName('body')!.startIndex &&
            node.endIndex <= root.descendantsOfType('while_statement')[0]!.endIndex
              ? loopBody!.id
              : body!.id;
          return node.type === 'call_expression'
            ? {
                name: node.childForFieldName('function')!.text,
                kind: 'call',
                callForm: 'free',
                arity: node.childForFieldName('arguments')!.namedChildCount,
                atRange: rangeOf(node),
                inScope,
              }
            : { name: node.text, kind: 'read', atRange: rangeOf(node), inScope };
        }),
      );
      expect(result.referenceSites.map((site) => site.name)).toEqual([
        'before',
        'check',
        'value',
        'inner',
        'use',
        'value',
        'after',
        'value',
      ]);
      const resolution = resolveReferences(finalizeScopeModel([result]));
      expect(resolution.stats).toEqual({
        totalSites: 8,
        resolvedSites: 3,
        unresolvedSites: 5,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      const resolved = [...resolution.referenceIndex.bySourceScope.values()].flat();
      for (const [index, target] of [
        [2, parameter],
        [5, shadow],
        [7, parameter],
      ] as const) {
        const site = result.referenceSites[index]!;
        expect(
          resolved.find(
            (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
          ),
        ).toMatchObject({
          kind: 'read',
          toDef: target.nodeId,
          fromScope: site.inScope,
          atRange: site.atRange,
        });
      }
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'retains nested while order, block ownership and bounded continues in %s',
    async (filePath) => {
      for (const [statement, names] of [
        ['while (check(value)) { /* empty */ }', ['check', 'value']],
        [
          'while (/* condition */ (check(value))) { continue /* transfer */; later(value); }',
          ['check', 'value', 'later', 'value'],
        ],
        [
          'while (check(value)) { while (again(value)) { continue; inner(value); } later(value); }',
          ['check', 'value', 'again', 'value', 'inner', 'value', 'later', 'value'],
        ],
        [
          '{ if (check(value)) { while (again(value)) { if (value) continue; else fallback(value); } } }',
          ['check', 'value', 'again', 'value', 'value', 'fallback', 'value'],
        ],
        [
          'try { while (check(value)) { try { continue; } finally { cleanup(value); } } } catch (error) { while (again(error)) { continue; } }',
          ['check', 'value', 'cleanup', 'value', 'again', 'error'],
        ],
        [
          'while (check(value)) { for (const item of items) { continue; use(item); } continue; }',
          ['check', 'value', 'items', 'use', 'item'],
        ],
        [
          'for (const item in items) { while (check(item)) { continue; use(item); } continue; }',
          ['items', 'check', 'item', 'use', 'item'],
        ],
      ] as const) {
        for (const functionScope of [false, true]) {
          const statements = `before(); ${statement} after(value);`;
          const source = functionScope ? `function owner(value) { ${statements} }` : statements;
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const captures = emitTypeScriptCaptures(root);
          const saved = JSON.stringify(captures);
          const result = extract(captures, filePath, hooks);
          const rangeOf = (node: typeof root) => ({
            startLine: node.startPosition.row + 1,
            startCol: node.startPosition.column,
            endLine: node.endPosition.row + 1,
            endCol: node.endPosition.column,
          });
          const lexicalNodes = root.descendantsOfType([
            'statement_block',
            'for_in_statement',
            'catch_clause',
          ]);
          expect(
            result.scopes.filter((scope) => scope.kind === 'Block').map((scope) => scope.range),
            source,
          ).toEqual(lexicalNodes.map(rangeOf));
          for (const node of lexicalNodes) {
            let parent = node.parent!;
            while (
              ![
                'statement_block',
                'for_in_statement',
                'catch_clause',
                'function_declaration',
                'program',
              ].includes(parent.type)
            )
              parent = parent.parent!;
            const scope = result.scopes.find(
              (candidate) => JSON.stringify(candidate.range) === JSON.stringify(rangeOf(node)),
            )!;
            const parentKind =
              parent.type === 'program'
                ? 'Module'
                : parent.type === 'function_declaration'
                  ? 'Function'
                  : 'Block';
            const parentScope = result.scopes.find(
              (candidate) =>
                candidate.kind === parentKind &&
                JSON.stringify(candidate.range) === JSON.stringify(rangeOf(parent)),
            )!;
            expect(scope.parent, source).toBe(parentScope.id);
          }
          expect(
            result.referenceSites.map((site) => site.name),
            source,
          ).toEqual(['before', ...names, 'after', 'value']);
          parser.parse('replacement();');
          expect(JSON.stringify(captures), source).toBe(saved);
          expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
        }
      }
    },
  );

  it.each(filePaths)(
    'hoists while var bindings to function and module owners in %s',
    async (filePath) => {
      for (const functionScope of [false, true]) {
        const statements =
          'while (check(value)) { var value = first(); var repeated = second(); } var repeated = third(); after(value, repeated);';
        const source = functionScope
          ? `function owner(value) { ${statements} }`
          : `${statements} export var repeated; export { value };`;
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        const owner = result.scopes.find(
          (scope) => scope.kind === (functionScope ? 'Function' : 'Module'),
        )!;
        const loopBody = result.scopes.filter((scope) => scope.kind === 'Block').at(-1)!;
        expect([...loopBody.bindings]).toEqual([]);
        expect(loopBody.ownedDefs.map((def) => def.qualifiedName)).toEqual(['value', 'repeated']);
        expect(owner.bindings.get('value')![0]!.def).toBe(
          functionScope
            ? owner.ownedDefs.find((def) => def.qualifiedName === 'value')
            : loopBody.ownedDefs[0],
        );
        expect(owner.bindings.get('repeated')![0]!.def).toBe(loopBody.ownedDefs[1]);
        expect(result.localDefs.filter((def) => def.qualifiedName === 'repeated')).toHaveLength(
          functionScope ? 2 : 3,
        );
        expect(result.exports).toEqual(
          new Map(
            functionScope
              ? []
              : [
                  ['repeated', loopBody.ownedDefs[1]!.nodeId],
                  ['value', loopBody.ownedDefs[0]!.nodeId],
                ],
          ),
        );
        const resolution = resolveReferences(finalizeScopeModel([result]));
        expect(resolution.stats).toMatchObject({
          totalSites: 8,
          resolvedSites: 3,
          ambiguousSites: 0,
          unsupportedSites: 0,
        });
      }
    },
  );

  it.each(filePaths)(
    'refuses malformed and unsupported while syntax atomically in %s',
    async (filePath) => {
      for (const statement of [
        'while (obj?.[key].deep) {}',
        'while (check(obj?.[key])) {}',
        'while (value = next()) {}',
        'while (() => { return this; }) {}',
        'while (check()) use(value);',
        'while (check());',
        'while (check()) { break label; }',
        'while (check()) { continue label; }',
        'label: while (check()) { continue; }',
        'while (check()) { function nested() {} }',
        'while (check()) { obj?.[key].deep; }',
        'while (check()) { while (obj?.[key].deep) {} }',
        'while (check()) { let same; let same; }',
        'while (check()) { let same; var same; }',
        'let same; while (check()) { var same; }',
        'while (check()) { var same; } let same;',
        'do { continue label; } while (check());',
        'while (check()) {} continue;',
      ]) {
        for (const functionScope of [false, true]) {
          for (const contents of [`before(); ${statement}`, `${statement} after();`]) {
            const source = functionScope ? `function owner(value) { ${contents} }` : contents;
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
            expect(() => {
              captures = emitTypeScriptCaptures(root);
            }, source).toThrow(ScopeUnsupportedSyntaxError);
            expect(captures, source).toBeUndefined();
          }
        }
      }
      for (const malformed of ['while () {}', 'while (check() {}', 'while (check()) {']) {
        for (const source of [`before(); ${malformed}`, `${malformed}\nafter();`]) {
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(true);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'retains ordered references around bounded loop continues in %s',
    async (filePath) => {
      for (const operator of ['in', 'of']) {
        for (const functionScope of [false, true]) {
          for (const [body, expectedNames] of [
            ['first(item); continue; later(item);', ['first', 'item', 'later', 'item']],
            [
              'first(item); continue /* comment */\n later(item);',
              ['first', 'item', 'later', 'item'],
            ],
            [
              'if (check(item)) continue; else fallback(item); later(item);',
              ['check', 'item', 'fallback', 'item', 'later', 'item'],
            ],
            [
              'if (check(item)) first(item); else continue /* comment */; later(item);',
              ['check', 'item', 'first', 'item', 'later', 'item'],
            ],
            [
              '{ first(item); { continue; later(item); } resume(item); }',
              ['first', 'item', 'later', 'item', 'resume', 'item'],
            ],
            [
              'try { first(item); continue; later(item); } catch (error) { recover(error); continue; caught(item); } finally { cleanup(item); continue; final(item); }',
              [
                'first',
                'item',
                'later',
                'item',
                'recover',
                'error',
                'caught',
                'item',
                'cleanup',
                'item',
                'final',
                'item',
              ],
            ],
          ] as const) {
            const statements = `before(); for (const item ${operator} items) { ${body} } after();`;
            const source = functionScope ? `function owner(items) { ${statements} }` : statements;
            const { parser, root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            const captures = emitTypeScriptCaptures(root);
            const saved = JSON.stringify(captures);
            const result = extract(captures, filePath, hooks);
            const rangeOf = (node: typeof root) => ({
              startLine: node.startPosition.row + 1,
              startCol: node.startPosition.column,
              endLine: node.endPosition.row + 1,
              endCol: node.endPosition.column,
            });
            const lexicalNodes = root.descendantsOfType([
              'statement_block',
              'for_in_statement',
              'catch_clause',
            ]);
            const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
            expect(
              blocks.map((scope) => scope.range),
              source,
            ).toEqual(lexicalNodes.map(rangeOf));
            for (const node of lexicalNodes) {
              let parent = node.parent!;
              while (
                ![
                  'statement_block',
                  'for_in_statement',
                  'catch_clause',
                  'function_declaration',
                  'program',
                ].includes(parent.type)
              ) {
                parent = parent.parent!;
              }
              const scope = result.scopes.find(
                (candidate) => JSON.stringify(candidate.range) === JSON.stringify(rangeOf(node)),
              )!;
              const parentKind =
                parent.type === 'program'
                  ? 'Module'
                  : parent.type === 'function_declaration'
                    ? 'Function'
                    : 'Block';
              const parentScope = result.scopes.find(
                (candidate) =>
                  candidate.kind === parentKind &&
                  JSON.stringify(candidate.range) === JSON.stringify(rangeOf(parent)),
              )!;
              expect(scope.parent, source).toBe(parentScope.id);
            }
            const calls = root.descendantsOfType('call_expression');
            const iterable = root
              .descendantsOfType('for_in_statement')[0]!
              .childForFieldName('right')!;
            const nodes = [
              calls[0]!,
              iterable,
              ...calls
                .slice(1)
                .flatMap((call) => [call, ...call.childForFieldName('arguments')!.namedChildren]),
            ];
            expect(
              nodes.map((node) =>
                node.type === 'call_expression'
                  ? node.childForFieldName('function')!.text
                  : node.text,
              ),
              source,
            ).toEqual(['before', 'items', ...expectedNames, 'after']);
            expect(result.referenceSites, source).toEqual(
              nodes.map((node) => {
                let lexical = node.parent!;
                while (!['statement_block', 'for_in_statement', 'program'].includes(lexical.type))
                  lexical = lexical.parent!;
                const scope = result.scopes.find(
                  (candidate) =>
                    JSON.stringify(candidate.range) === JSON.stringify(rangeOf(lexical)),
                )!;
                return node.type === 'call_expression'
                  ? {
                      name: node.childForFieldName('function')!.text,
                      kind: 'call',
                      callForm: 'free',
                      arity: node.childForFieldName('arguments')!.namedChildCount,
                      atRange: rangeOf(node),
                      inScope: scope.id,
                    }
                  : { name: node.text, kind: 'read', atRange: rangeOf(node), inScope: scope.id };
              }),
            );
            parser.parse('replacement();');
            expect(JSON.stringify(captures), source).toBe(saved);
            expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'refuses unsupported continue transfers atomically in %s',
    async (filePath) => {
      for (const statement of [
        'continue;',
        'for (const item of items) { continue label; }',
        'label: for (const item of items) { continue label; }',
        'for (const item of items) { continue; } continue;',
        'for (const item of items) { continue; } { continue; }',
        'for (const item of items) { continue; } if (check()) continue;',
        'for (const item of items) { function nested() { continue; } }',
        'for (const item of items) { break label; }',
        'for (const item of items) { if (check()) break label; }',
        'for (;;) { continue label; }',
        'while (check()) { continue label; }',
        'do { continue label; } while (check());',
        'for (const item of items) return;',
      ]) {
        for (const functionScope of [false, true]) {
          const statements = `before(); ${statement} after();`;
          const source = functionScope ? `function owner(items) { ${statements} }` : statements;
          const { root } = await parse(source, filePath);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'retains statement assignment writes before supported RHS evidence in %s',
    async (filePath) => {
      for (const [statement, rhsSites] of [
        ['value = 1;', []],
        ['value = value;', [['value', 'read', 'value']]],
        ['((/* statement */ value = ((/* RHS */ café))));', [['café', 'read', 'café']]],
        [
          'value = inner(café);',
          [
            ['inner', 'call', 'inner(café)', 'free', 1],
            ['café', 'read', 'café'],
          ],
        ],
        [
          'value = new Box(café);',
          [
            ['Box', 'call', 'new Box(café)', 'constructor', 1],
            ['café', 'read', 'café'],
          ],
        ],
        [
          'value = obj.field;',
          [
            ['field', 'read', 'obj.field', 'member'],
            ['obj', 'read', 'obj'],
          ],
        ],
        [
          'value = obj.method(café);',
          [
            ['method', 'call', 'obj.method(café)', 'member', 1],
            ['obj', 'read', 'obj'],
            ['café', 'read', 'café'],
          ],
        ],
      ] as Array<[string, Array<[string, string, string, string?, number?]>]>) {
        const source = `function owner(value, café, obj) {\n  {\n    ${statement}\n  }\n}`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const [body, lexical] = result.scopes.filter((scope) => scope.kind === 'Block');
        expect(lexical, source).toMatchObject({
          parent: body!.id,
          range: {
            startLine: 2,
            startCol: 2,
            endLine: 4,
            endCol: 3,
          },
        });
        const rangeOf = (text: string, from = 0) => {
          const column = statement.indexOf(text, from);
          expect(column, text).toBeGreaterThanOrEqual(from);
          return {
            startLine: 3,
            startCol: 4 + column,
            endLine: 3,
            endCol: 4 + column + text.length,
          };
        };
        const writeRange = rangeOf('value');
        const rhsStart = statement.indexOf('=') + 1;
        expect(result.referenceSites, source).toEqual([
          { name: 'value', kind: 'write', atRange: writeRange, inScope: lexical!.id },
          ...rhsSites.map(([name, kind, text, callForm, arity]) => ({
            name,
            kind,
            atRange: rangeOf(text, rhsStart),
            inScope: lexical!.id,
            ...(kind === 'call' ? { callForm, arity } : {}),
            ...(callForm === 'member' ? { explicitReceiver: { name: 'obj' } } : {}),
          })),
        ]);
        expect(
          captures.filter((match) => match['@reference.write']),
          source,
        ).toEqual([
          {
            '@reference.write': { name: '@reference.write', text: '', range: writeRange },
            '@reference.name': { name: '@reference.name', text: 'value', range: writeRange },
          },
        ]);
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'resolves assignment reads and writes to their lexical shadows in %s',
    async (filePath) => {
      const source = [
        'let café;',
        'café = café;',
        'function owner() {',
        '  let café;',
        '  café = café;',
        '  { let café; café = café; }',
        '}',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const [body, lexical] = result.scopes.filter((scope) => scope.kind === 'Block');
      const expected = [result.moduleScope, body!.id, lexical!.id].flatMap((inScope, index) => {
        const lineNumber = [2, 5, 6][index]!;
        const line = source.split('\n')[lineNumber - 1]!;
        const writeColumn = line.indexOf('café', index === 2 ? line.indexOf(';') + 1 : 0);
        const readColumn = line.indexOf('café', line.indexOf('=') + 1);
        return (
          [
            ['write', writeColumn],
            ['read', readColumn],
          ] as const
        ).map(([kind, column]) => ({
          name: 'café',
          kind,
          inScope,
          atRange: {
            startLine: lineNumber,
            startCol: column,
            endLine: lineNumber,
            endCol: column + 4,
          },
        }));
      });
      expect(result.referenceSites).toEqual(expected);
      const indexes = finalizeScopeModel([result]);
      const fields = buildFieldRegistry(buildScopeRegistryContext(indexes));
      const targets = [result.moduleScope, body!.id, lexical!.id].map((scopeId) => {
        const scope = result.scopes.find((candidate) => candidate.id === scopeId)!;
        const target = scope.ownedDefs.find((def) => def.qualifiedName === 'café')!.nodeId;
        expect(fields.lookup('café', scopeId)[0]!.def.nodeId).toBe(target);
        return target;
      });
      expect(new Set(targets).size).toBe(3);
      const resolution = resolveReferences(indexes);
      expect(resolution.stats).toEqual({
        totalSites: 6,
        resolvedSites: 6,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      const resolved = [...resolution.referenceIndex.bySourceScope.values()].flat();
      expect(
        resolved.map(({ kind, toDef, fromScope, atRange }) => ({
          kind,
          toDef,
          fromScope,
          atRange,
        })),
      ).toEqual(
        expected.map((site, index) => ({
          kind: site.kind,
          toDef: targets[Math.floor(index / 2)],
          fromScope: site.inScope,
          atRange: site.atRange,
        })),
      );
      for (const target of targets) {
        expect(resolution.referenceIndex.byTargetDef.get(target)?.map(({ kind }) => kind)).toEqual([
          'write',
          'read',
        ]);
      }
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'captures standalone identifier updates as detached reads then writes in %s',
    async (filePath) => {
      for (const statement of [
        'value++;',
        'value--;',
        '++value;',
        '--value;',
        '((/* statement */ value /* operand */ ++));',
        '(++ /* operand */ value);',
      ]) {
        const source = `let value;\n${statement}\nfunction owner() {\n let value;\n ${statement}\n { let value; ${statement} }\n}`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const [body, lexical] = result.scopes.filter((scope) => scope.kind === 'Block');
        const scopeIds = [result.moduleScope, body!.id, lexical!.id];
        const expected = scopeIds.flatMap((inScope, index) => {
          const lineNumber = [2, 5, 6][index]!;
          const line = source.split('\n')[lineNumber - 1]!;
          const startCol = line.indexOf('value', index === 2 ? line.indexOf(';') + 1 : 0);
          return (['read', 'write'] as const).map((kind) => ({
            name: 'value',
            kind,
            inScope,
            atRange: { startLine: lineNumber, startCol, endLine: lineNumber, endCol: startCol + 5 },
          }));
        });
        expect(result.referenceSites, source).toEqual(expected);
        const references = captures.filter(
          (match) => match['@reference.read'] || match['@reference.write'],
        );
        expect(references, source).toEqual(
          expected.map(({ kind, atRange }) => ({
            [`@reference.${kind}`]: { name: `@reference.${kind}`, text: '', range: atRange },
            '@reference.name': { name: '@reference.name', text: 'value', range: atRange },
          })),
        );
        for (let index = 0; index < references.length; index += 2) {
          const read = references[index]!;
          const write = references[index + 1]!;
          expect(read['@reference.name']).not.toBe(write['@reference.name']);
          expect(read['@reference.name']!.range).not.toBe(write['@reference.name']!.range);
          expect(read['@reference.read']!.range).not.toBe(read['@reference.name']!.range);
          expect(write['@reference.write']!.range).not.toBe(write['@reference.name']!.range);
        }
        const targets = scopeIds.map(
          (scopeId) =>
            result.scopes
              .find((scope) => scope.id === scopeId)!
              .ownedDefs.find((def) => def.qualifiedName === 'value')!.nodeId,
        );
        expect(new Set(targets).size).toBe(3);
        const resolution = resolveReferences(finalizeScopeModel([result]));
        expect(resolution.stats).toEqual({
          totalSites: 6,
          resolvedSites: 6,
          unresolvedSites: 0,
          ambiguousSites: 0,
          unsupportedSites: 0,
        });
        for (const [index, target] of targets.entries()) {
          expect(
            resolution.referenceIndex.byTargetDef
              .get(target)
              ?.map(({ kind, fromScope, atRange }) => ({ kind, fromScope, atRange })),
          ).toEqual(
            expected
              .slice(index * 2, index * 2 + 2)
              .map(({ kind, inScope, atRange }) => ({ kind, fromScope: inScope, atRange })),
          );
        }
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'refuses unsupported assignment forms and nested expression contexts atomically in %s',
    async (filePath) => {
      for (const statement of [
        'factory()[key] = value;',
        '({ value } = obj);',
        '[value] = items;',
        'value %= 1;',
        'value = other = 1;',
        '((value))++;',
        '++((value));',
        'const result = value++;',
        'outer(++value);',
        'return value--;',
        'throw --value;',
        'if (value++) {}',
        'const result = [value++];',
        'const result = { field: ++value };',
        'const result = (value = 1);',
        'return value = 1;',
        'throw value = 1;',
        'if (value = 1) {}',
        'const result = [value = 1];',
        'const result = { field: value = 1 };',
        'value = (other += 1);',
        'value = (other++);',
        'value = gate ? (other = 1) : 0;',
        'value = obj?.[key];',
        'value = inner(obj?.[key]);',
        'value = (() => { return this; });',
      ]) {
        for (const contents of [`before(); ${statement}`, `${statement} after();`]) {
          const source = `function owner() { ${contents} }`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'captures standalone identifier += as a read and write followed by RHS reads in %s',
    async (filePath) => {
      const source = 'function owner(value, other) { value += other.field; }';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const result = extract(captures, filePath, hooks);
      const body = result.scopes.find(({ kind }) => kind === 'Block')!;
      const start = source.indexOf('value +=');
      expect(result.referenceSites).toEqual([
        {
          name: 'value',
          kind: 'read',
          inScope: body.id,
          atRange: { startLine: 1, startCol: start, endLine: 1, endCol: start + 5 },
        },
        {
          name: 'value',
          kind: 'write',
          inScope: body.id,
          atRange: { startLine: 1, startCol: start, endLine: 1, endCol: start + 5 },
        },
        {
          name: 'field',
          kind: 'read',
          inScope: body.id,
          atRange: { startLine: 1, startCol: start + 9, endLine: 1, endCol: start + 20 },
          explicitReceiver: { name: 'other' },
        },
        {
          name: 'other',
          kind: 'read',
          inScope: body.id,
          atRange: { startLine: 1, startCol: start + 9, endLine: 1, endCol: start + 14 },
        },
      ]);
      const saved = JSON.stringify(captures);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
      for (const unsupported of [
        'obj.value %= other;',
        'value += (other = 1);',
        'factory()[key] += other;',
        'value %= 2;',
      ]) {
        const { root: badRoot } = await parse(
          `function owner(value, other, obj) { ${unsupported} }`,
          filePath,
        );
        expect(() => emitTypeScriptCaptures(badRoot), unsupported).toThrow(
          ScopeUnsupportedSyntaxError,
        );
      }
    },
  );

  it.each(filePaths)(
    'retains computed write operands and selected reads without an element write in %s',
    async (filePath) => {
      for (const statement of [
        'obj[key] = value;',
        'obj[key]++;',
        '++obj[key];',
        'obj[key] += other;',
      ]) {
        const source = `function owner() { before(); ${statement} after(); }`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const scope = result.scopes.find(({ kind }) => kind === 'Block')!;
        const rangeOf = (text: string) => {
          const startCol = source.indexOf(text);
          return { startLine: 1, startCol, endLine: 1, endCol: startCol + text.length };
        };
        const simpleAssignment = statement === 'obj[key] = value;';
        expect(result.referenceSites, source).toEqual([
          {
            name: 'before',
            kind: 'call',
            callForm: 'free',
            arity: 0,
            inScope: scope.id,
            atRange: rangeOf('before()'),
          },
          ...(!simpleAssignment
            ? [
                {
                  kind: 'read',
                  inScope: scope.id,
                  atRange: rangeOf('obj[key]'),
                  selection: {
                    kind: 'computed',
                    objectRange: rangeOf('obj'),
                    indexRange: rangeOf('key'),
                  },
                },
              ]
            : []),
          ...[
            'obj',
            'key',
            ...(simpleAssignment ? ['value'] : statement.includes('+=') ? ['other'] : []),
          ].map((name) => ({ name, kind: 'read', inScope: scope.id, atRange: rangeOf(name) })),
          {
            name: 'after',
            kind: 'call',
            callForm: 'free',
            arity: 0,
            inScope: scope.id,
            atRange: rangeOf('after()'),
          },
        ]);
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'retains undefined reads in exact order, ranges and scopes in %s',
    async (filePath) => {
      for (const statement of [
        'const result = undefined;',
        'outer(undefined);',
        'return undefined;',
        'throw undefined;',
        'if (value !== undefined) { branch(); }',
        'const result = [undefined];',
        'const result = {value: undefined};',
      ]) {
        const source = `function owner(value) {\n  {\n    ${statement}\n  }\n}`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const [body, lexical, branch] = result.scopes.filter((scope) => scope.kind === 'Block');
        expect(lexical, source).toMatchObject({
          parent: body!.id,
          range: {
            startLine: 2,
            startCol: 2,
            endLine: 4,
            endCol: 3,
          },
        });
        const rangeOf = (text: string) => {
          const startCol = 4 + statement.indexOf(text);
          expect(statement.indexOf(text), text).toBeGreaterThanOrEqual(0);
          return { startLine: 3, startCol, endLine: 3, endCol: startCol + text.length };
        };
        const read = (name: string) => ({
          name,
          kind: 'read',
          atRange: rangeOf(name),
          inScope: lexical!.id,
        });
        expect(result.referenceSites, source).toEqual([
          ...(statement.startsWith('outer')
            ? [
                {
                  name: 'outer',
                  kind: 'call',
                  callForm: 'free',
                  arity: 1,
                  atRange: rangeOf('outer(undefined)'),
                  inScope: lexical!.id,
                },
              ]
            : []),
          ...(statement.startsWith('if') ? [read('value')] : []),
          read('undefined'),
          ...(statement.startsWith('if')
            ? [
                {
                  name: 'branch',
                  kind: 'call',
                  callForm: 'free',
                  arity: 0,
                  atRange: rangeOf('branch()'),
                  inScope: branch!.id,
                },
              ]
            : []),
        ]);
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'resolves shadowed undefined reads and direct member roots in %s',
    async (filePath) => {
      const source =
        'let undefined;\nfunction owner() {\n let undefined;\n { let undefined; const value = undefined; undefined.field; }\n}';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const [body, lexical] = result.scopes.filter((scope) => scope.kind === 'Block');
      const line = source.split('\n')[3]!;
      const rangeOf = (text: string, from = 0) => {
        const startCol = line.indexOf(text, from);
        expect(startCol, text).toBeGreaterThanOrEqual(from);
        return { startLine: 4, startCol, endLine: 4, endCol: startCol + text.length };
      };
      expect(result.referenceSites).toEqual([
        {
          name: 'undefined',
          kind: 'read',
          atRange: rangeOf('undefined', line.indexOf('=') + 1),
          inScope: lexical!.id,
        },
        {
          name: 'field',
          kind: 'read',
          atRange: rangeOf('undefined.field'),
          inScope: lexical!.id,
          explicitReceiver: { name: 'undefined' },
        },
        {
          name: 'undefined',
          kind: 'read',
          atRange: rangeOf('undefined', line.indexOf('undefined.field')),
          inScope: lexical!.id,
        },
      ]);
      const fields = buildFieldRegistry(buildScopeRegistryContext(finalizeScopeModel([result])));
      for (const scope of [result.scopes[0]!, body!, lexical!]) {
        expect(fields.lookup('undefined', scope.id)[0]!.def.nodeId).toBe(
          scope.ownedDefs.find((def) => def.qualifiedName === 'undefined')!.nodeId,
        );
      }
      expect(
        new Set(
          [result.scopes[0]!, body!, lexical!].map(
            (scope) => fields.lookup('undefined', scope.id)[0]!.def.nodeId,
          ),
        ).size,
      ).toBe(3);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'refuses unsupported undefined uses and siblings atomically in %s',
    async (filePath) => {
      for (const statement of [
        'undefined;',
        'undefined();',
        'undefined.method();',
        'undefined.x.y;',
        'new undefined;',
        'const value = [undefined, obj?.[key]];',
        'const value = [obj?.[key], undefined];',
        ...(/\.tsx?$/.test(filePath) ? ['const value = undefined as const;'] : []),
      ]) {
        for (const contents of [`before(); ${statement}`, `${statement} after();`]) {
          const source = `function owner() { ${contents} }`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'retains bounded binary operands in exact order, ranges and scopes in %s',
    async (filePath) => {
      for (const operator of [
        '<',
        '<=',
        '>',
        '>=',
        '==',
        '!=',
        '===',
        '!==',
        '+',
        '-',
        '*',
        '>>>',
        '&&',
        '||',
        '??',
        'in',
      ]) {
        const expression = `((/* left */ left ${operator} inner(obj.field))) ${operator} (obj.method(right) - -1)`;
        for (const position of [
          'initializer',
          'argument',
          'return',
          'throw',
          'if',
          'array',
          'object',
        ] as const) {
          const statement = {
            initializer: `const result = ${expression};`,
            argument: `outer(${expression});`,
            return: `return ${expression};`,
            throw: `throw ${expression};`,
            if: `if (${expression}) { branch(); }`,
            array: `const result = [${expression}];`,
            object: `const result = {value: ${expression}};`,
          }[position];
          const source = `function owner(left, right, obj) {\n  {\n    ${statement}\n  }\n}`;
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const captures = emitTypeScriptCaptures(root);
          const saved = JSON.stringify(captures);
          const result = extract(captures, filePath, hooks);
          const [body, nested, branch] = result.scopes.filter((scope) => scope.kind === 'Block');
          expect(body, source).toBeDefined();
          expect(nested, source).toMatchObject({
            parent: body!.id,
            range: {
              startLine: 2,
              startCol: 2,
              endLine: 4,
              endCol: 3,
            },
          });
          const rangeOf = (text: string, from = source.indexOf(statement)) => {
            const offset = source.indexOf(text, from);
            expect(offset, text).toBeGreaterThanOrEqual(from);
            const before = source.slice(0, offset).split('\n');
            return {
              startLine: before.length,
              startCol: before.at(-1)!.length,
              endLine: before.length,
              endCol: before.at(-1)!.length + text.length,
            };
          };
          const read = (name: string, from?: number) => ({
            name,
            kind: 'read',
            atRange: rangeOf(name, from),
            inScope: nested!.id,
          });
          const call = (text: string, name: string, arity: number, inScope = nested!.id) => ({
            name,
            kind: 'call',
            callForm: name === 'method' ? 'member' : 'free',
            arity,
            atRange: rangeOf(text),
            inScope,
            ...(name === 'method' ? { explicitReceiver: { name: 'obj' } } : {}),
          });
          expect(result.referenceSites, source).toEqual([
            ...(position === 'argument' ? [call(`outer(${expression})`, 'outer', 1)] : []),
            read('left', source.indexOf('*/') + 2),
            call('inner(obj.field)', 'inner', 1),
            {
              name: 'field',
              kind: 'read',
              atRange: rangeOf('obj.field'),
              inScope: nested!.id,
              explicitReceiver: { name: 'obj' },
            },
            read('obj', source.indexOf('obj.field')),
            call('obj.method(right)', 'method', 1),
            read('obj', source.indexOf('obj.method')),
            read('right'),
            ...(position === 'if' ? [call('branch()', 'branch', 0, branch!.id)] : []),
          ]);
          parser.parse('replacement();');
          expect(JSON.stringify(captures), source).toBe(saved);
          expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
        }
      }
    },
  );

  it.each(filePaths)(
    'retains membership operands once without inventing key or member reads in %s',
    async (filePath) => {
      for (const expression of [
        'key in registry',
        "'key' in registry",
        'key && key in registry',
        'keys[index()] in registry[name()]',
        'key /* left */ in /* right */ registry',
      ]) {
        const source = `function owner(key, registry, keys) { { const result = ${expression}; } }`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const [body, lexical] = result.scopes.filter((scope) => scope.kind === 'Block');
        expect(lexical!.parent).toBe(body!.id);
        const start = source.indexOf(expression);
        const rangeOf = (text: string, from = start) => {
          const startCol = source.indexOf(text, from);
          expect(startCol, text).toBeGreaterThanOrEqual(from);
          return { startLine: 1, startCol, endLine: 1, endCol: startCol + text.length };
        };
        const read = (name: string, from = start) => ({
          name,
          kind: 'read',
          atRange: rangeOf(name, from),
          inScope: lexical!.id,
        });
        expect(result.referenceSites, source).toEqual(
          expression.startsWith('keys[')
            ? ['keys[index()]', 'registry[name()]'].flatMap((text) => {
                const [object, index] = text.slice(0, -1).split('[') as [string, string];
                const from = source.indexOf(text, start);
                return [
                  {
                    kind: 'read',
                    atRange: rangeOf(text),
                    inScope: lexical!.id,
                    selection: {
                      kind: 'computed',
                      objectRange: rangeOf(object, from),
                      indexRange: rangeOf(index, from),
                    },
                  },
                  read(object, from),
                  {
                    name: index.slice(0, -2),
                    kind: 'call',
                    callForm: 'free',
                    arity: 0,
                    atRange: rangeOf(index, from),
                    inScope: lexical!.id,
                  },
                ];
              })
            : [
                ...(expression.startsWith("'") ? [] : [read('key')]),
                ...(expression.startsWith('key &&') ? [read('key', start + 'key && '.length)] : []),
                read('registry'),
              ],
        );
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'keeps membership in arrow arguments under the parameter shadow in %s',
    async (filePath) => {
      const source =
        'let key; let registry; consume(key => key in registry); const result = key in registry;';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const [module, arrow] = result.scopes;
      expect(arrow!.parent).toBe(module!.id);
      expect([...arrow!.bindings.keys()]).toEqual(['key']);
      const rangeOf = (text: string, from = 0) => {
        const startCol = source.indexOf(text, from);
        expect(startCol, text).toBeGreaterThanOrEqual(from);
        return { startLine: 1, startCol, endLine: 1, endCol: startCol + text.length };
      };
      const membership = source.indexOf('key in registry');
      const sibling = source.lastIndexOf('key in registry');
      expect(result.referenceSites).toEqual([
        {
          name: 'consume',
          kind: 'call',
          callForm: 'free',
          arity: 1,
          atRange: rangeOf('consume(key => key in registry)'),
          inScope: module!.id,
        },
        ...(
          [
            [membership, arrow!.id],
            [sibling, module!.id],
          ] as const
        ).flatMap(([from, inScope]) =>
          ['key', 'registry'].map((name) => ({
            name,
            kind: 'read',
            atRange: rangeOf(name, from),
            inScope,
          })),
        ),
      ]);
      const fields = buildFieldRegistry(buildScopeRegistryContext(finalizeScopeModel([result])));
      expect(fields.lookup('key', arrow!.id)[0]!.def.nodeId).toBe(
        arrow!.bindings.get('key')![0]!.def.nodeId,
      );
      expect(fields.lookup('key', module!.id)[0]!.def.nodeId).toBe(
        module!.bindings.get('key')![0]!.def.nodeId,
      );
      expect(arrow!.bindings.get('key')![0]!.def.nodeId).not.toBe(
        module!.bindings.get('key')![0]!.def.nodeId,
      );
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'refuses private and missing membership operands atomically in %s',
    async (filePath) => {
      for (const expression of ['#key in registry', 'key in', 'in registry', 'key in ()']) {
        const source = `before(); const result = ${expression}; after();`;
        const { root } = await parse(source, filePath);
        let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
        expect(() => {
          captures = emitTypeScriptCaptures(root);
        }, source).toThrow(ScopeUnsupportedSyntaxError);
        expect(captures, source).toBeUndefined();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'unwraps non-null values with exact ordered evidence across runtime contexts in %s',
    async (filePath) => {
      const expression = '((/* operand */ left!)!) + inner(obj.field!)! + obj.method(right!)!';
      for (const position of [
        'initializer',
        'argument',
        'return',
        'throw',
        'if',
        'array',
        'object',
        'assignment',
      ] as const) {
        const statement = {
          initializer: `const result = ${expression};`,
          argument: `outer(${expression});`,
          return: `return ${expression};`,
          throw: `throw ${expression};`,
          if: `if (${expression}) { branch(); }`,
          array: `const result = [${expression}];`,
          object: `const result = {value: ${expression}};`,
          assignment: `result = ${expression};`,
        }[position];
        const source = `function owner(left, right, obj) {\n  {\n    ${statement}\n  }\n}`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const [body, lexical, branch] = result.scopes.filter((scope) => scope.kind === 'Block');
        expect(lexical, source).toMatchObject({
          parent: body!.id,
          range: {
            startLine: 2,
            startCol: 2,
            endLine: 4,
            endCol: 3,
          },
        });
        const rangeOf = (text: string, from = 0) => {
          const column = statement.indexOf(text, from);
          expect(column, text).toBeGreaterThanOrEqual(from);
          return {
            startLine: 3,
            startCol: column + 4,
            endLine: 3,
            endCol: column + 4 + text.length,
          };
        };
        const read = (name: string, from = 0) => ({
          name,
          kind: 'read',
          atRange: rangeOf(name, from),
          inScope: lexical!.id,
        });
        const call = (text: string, name: string, inScope = lexical!.id) => ({
          name,
          kind: 'call',
          callForm: name === 'method' ? 'member' : 'free',
          arity: name === 'branch' ? 0 : 1,
          atRange: rangeOf(text),
          inScope,
          ...(name === 'method' ? { explicitReceiver: { name: 'obj' } } : {}),
        });
        expect(result.referenceSites, source).toEqual([
          ...(position === 'assignment'
            ? [{ name: 'result', kind: 'write', atRange: rangeOf('result'), inScope: lexical!.id }]
            : []),
          ...(position === 'argument' ? [call(`outer(${expression})`, 'outer')] : []),
          read('left'),
          call('inner(obj.field!)', 'inner'),
          {
            name: 'field',
            kind: 'read',
            atRange: rangeOf('obj.field'),
            inScope: lexical!.id,
            explicitReceiver: { name: 'obj' },
          },
          read('obj'),
          call('obj.method(right!)', 'method'),
          read('obj', statement.indexOf('obj.method')),
          read('right'),
          ...(position === 'if' ? [call('branch()', 'branch', branch!.id)] : []),
        ]);
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'refuses unsupported non-null operands and asserted reference positions atomically in %s',
    async (filePath) => {
      for (const statement of [
        'value!;',
        '((value!));',
        'value!();',
        '(value!)();',
        'value! = other;',
        '(value!) = other;',
        'value!++;',
        '++value!;',
        ...[
          'obj?.[key]',
          'obj[key]?.()',
          '() => { return this; }',
          'value = 1',
          'value++',
          'delete value',
          'value as typeof Shape',
        ].map((operand) => `const result = good() + (${operand})!;`),
      ]) {
        for (const contents of [`before(); ${statement}`, `${statement} after();`]) {
          const source = `function owner() { ${contents} }`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'retains nested NOT and composed operands in exact order, ranges and scopes in %s',
    async (filePath) => {
      const expression = '!(!!gate ? !(left * -2) : !inner(obj.field))';
      for (const position of [
        'initializer',
        'argument',
        'return',
        'throw',
        'if',
        'array',
        'object',
      ] as const) {
        const statement = {
          initializer: `const result = ${expression};`,
          argument: `outer(${expression}, !true);`,
          return: `return ${expression};`,
          throw: `throw ${expression};`,
          if: `if (${expression}) { branch(); }`,
          array: `const result = [${expression}];`,
          object: `const result = {value: ${expression}};`,
        }[position];
        const source = `function owner() {\n  {\n    ${statement}\n  }\n}`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const [body, lexical, branch] = result.scopes.filter((scope) => scope.kind === 'Block');
        expect(lexical, source).toMatchObject({
          parent: body!.id,
          range: {
            startLine: 2,
            startCol: 2,
            endLine: 4,
            endCol: 3,
          },
        });
        const rangeOf = (text: string) => {
          const startCol = 4 + statement.indexOf(text);
          expect(statement.indexOf(text), text).toBeGreaterThanOrEqual(0);
          return { startLine: 3, startCol, endLine: 3, endCol: startCol + text.length };
        };
        const read = (name: string) => ({
          name,
          kind: 'read',
          atRange: rangeOf(name),
          inScope: lexical!.id,
        });
        const call = (text: string, name: string, arity: number, inScope = lexical!.id) => ({
          name,
          kind: 'call',
          callForm: 'free',
          arity,
          atRange: rangeOf(text),
          inScope,
        });
        expect(result.referenceSites, source).toEqual([
          ...(position === 'argument' ? [call(`outer(${expression}, !true)`, 'outer', 2)] : []),
          read('gate'),
          read('left'),
          call('inner(obj.field)', 'inner', 1),
          {
            name: 'field',
            kind: 'read',
            atRange: rangeOf('obj.field'),
            inScope: lexical!.id,
            explicitReceiver: { name: 'obj' },
          },
          read('obj'),
          ...(position === 'if' ? [call('branch()', 'branch', 0, branch!.id)] : []),
        ]);
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)('retains statically short-circuited calls in %s', async (filePath) => {
    for (const expression of ['false && call()', 'true || call()', '1 ?? call()']) {
      const source = `const result = ${expression};`;
      const { root } = await parse(source, filePath);
      expect(root.hasError, source).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const startCol = source.indexOf('call()');
      expect(result.referenceSites, source).toEqual([
        {
          name: 'call',
          kind: 'call',
          callForm: 'free',
          arity: 0,
          inScope: result.moduleScope,
          atRange: { startLine: 1, startCol, endLine: 1, endCol: startCol + 'call()'.length },
        },
      ]);
    }
  });

  it.each(filePaths)('refuses unsupported NOT operands atomically in %s', async (filePath) => {
    for (const operand of [
      'obj?.[key]',
      'obj?.[key].field',
      'obj[key]?.()',
      'obj.#field',
      'obj[key]()',
      '() => { return this; }',
      'value = 1',
      'value++',
      'delete value',
      'delete value',
      'delete value.x',
      'delete (value)',
      '--1',
      ...(/\.tsx?$/.test(filePath) ? ['value as typeof Shape', 'value as const'] : []),
    ]) {
      for (const statement of [
        `const result = [good(), !(${operand})];`,
        `outer(!(${operand}), good());`,
      ]) {
        const source = `before(); function owner() { ${statement} } after();`;
        const { root } = await parse(source, filePath);
        let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
        expect(() => {
          captures = emitTypeScriptCaptures(root);
        }, source).toThrow(ScopeUnsupportedSyntaxError);
        expect(captures, source).toBeUndefined();
      }
    }
  });

  it.each(['fixture.ts', 'fixture.tsx'])(
    'keeps NOT within const containers and refuses root assertions in %s',
    async (filePath) => {
      for (const expression of ['[!value] as const', '{value: !value} as const']) {
        const source = `const result = ${expression};`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const startCol = source.indexOf('!value') + 1;
        expect(result.referenceSites, source).toEqual([
          {
            name: 'value',
            kind: 'read',
            inScope: result.moduleScope,
            atRange: { startLine: 1, startCol, endLine: 1, endCol: startCol + 'value'.length },
          },
        ]);
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
      for (const expression of ['(!value) as const', '(!true) as const', '!!value as const']) {
        const source = `before(); const result = ${expression}; after();`;
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
        expect(() => {
          captures = emitTypeScriptCaptures(root);
        }, source).toThrow(ScopeUnsupportedSyntaxError);
        expect(captures, source).toBeUndefined();
      }
    },
  );

  it.each(filePaths)(
    'refuses unsupported binary operands on either side atomically in %s',
    async (filePath) => {
      const unsupported = [
        'obj?.[key].field',
        'obj?.[key]',
        'obj[key]?.()',
        'obj.#field',
        'obj[key]()',
        '() => { return this; }',
        'value = 1',
        'value++',
        'delete value',
        'delete value.box',
        ...(/\.tsx?$/.test(filePath) ? ['(value < other) as const', 'value as typeof Shape'] : []),
      ];
      for (const operator of ['<', '-', 'in']) {
        for (const bad of unsupported) {
          for (const expression of [`good() ${operator} (${bad})`, `(${bad}) ${operator} good()`]) {
            for (const statement of [
              `const result = ${expression};`,
              `return outer(${expression});`,
            ]) {
              const { root } = await parse(
                `before(); function owner(value, obj) { ${statement} } after();`,
                filePath,
              );
              let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
              expect(() => {
                captures = emitTypeScriptCaptures(root);
              }, statement).toThrow(ScopeUnsupportedSyntaxError);
              expect(captures, statement).toBeUndefined();
            }
          }
        }
      }
      for (const expression of [
        'left < right',
        'left <= right',
        'left > right',
        'left >= right',
        'left == right',
        'left != right',
        'left === right',
        'left !== right',
        'left - right',
        'left + right',
        'left * right',
        'left >>> right',
        'left && right',
        'left || right',
        'left ?? right',
        'left in right',
        '!value',
        '!!value',
      ]) {
        for (const source of [`before(); ${expression};`, `((${expression})); after();`]) {
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          expect(() => emitTypeScriptCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
        }
      }
    },
  );

  it.each(filePaths)(
    'retains static ternary reads in exact order, ranges and scopes in %s',
    async (filePath) => {
      const expression =
        '((/* condition */ gate ? ready : fallback)) ? (true ? obj.field : inner(left)) : (false ? obj.method(right) : tail)';
      for (const position of [
        'initializer',
        'argument',
        'return',
        'throw',
        'if',
        'array',
        'object',
      ] as const) {
        const statement = {
          initializer: `const result = ${expression};`,
          argument: `outer(${expression});`,
          return: `return ${expression};`,
          throw: `throw ${expression};`,
          if: `if (${expression}) { branch(); }`,
          array: `const result = [${expression}];`,
          object: `const result = {value: ${expression}};`,
        }[position];
        const source = `function owner() {\n  {\n    ${statement}\n  }\n}`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const [body, lexical, branch] = result.scopes.filter((scope) => scope.kind === 'Block');
        expect(lexical, source).toMatchObject({
          parent: body!.id,
          range: {
            startLine: 2,
            startCol: 2,
            endLine: 4,
            endCol: 3,
          },
        });
        const rangeOf = (text: string, from = 0) => {
          const startCol = 4 + statement.indexOf(text, from);
          expect(statement.indexOf(text, from), text).toBeGreaterThanOrEqual(from);
          return { startLine: 3, startCol, endLine: 3, endCol: startCol + text.length };
        };
        const read = (name: string, from = 0) => ({
          name,
          kind: 'read',
          atRange: rangeOf(name, from),
          inScope: lexical!.id,
        });
        const call = (text: string, name: string, arity: number, inScope = lexical!.id) => ({
          name,
          kind: 'call',
          callForm: name === 'method' ? 'member' : 'free',
          arity,
          atRange: rangeOf(text),
          inScope,
          ...(name === 'method' ? { explicitReceiver: { name: 'obj' } } : {}),
        });
        expect(result.referenceSites, source).toEqual([
          ...(position === 'argument' ? [call(`outer(${expression})`, 'outer', 1)] : []),
          read('gate'),
          read('ready'),
          read('fallback'),
          {
            name: 'field',
            kind: 'read',
            atRange: rangeOf('obj.field'),
            inScope: lexical!.id,
            explicitReceiver: { name: 'obj' },
          },
          read('obj'),
          call('inner(left)', 'inner', 1),
          read('left'),
          call('obj.method(right)', 'method', 1),
          read('obj', statement.indexOf('obj.method')),
          read('right'),
          read('tail'),
          ...(position === 'if' ? [call('branch()', 'branch', 0, branch!.id)] : []),
        ]);
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'composes ternaries with binary operands on either side in %s',
    async (filePath) => {
      for (const expression of [
        '(value ? first : second) < other',
        'other - (value ? first : second)',
      ]) {
        const { root } = await parse(`const result = ${expression};`, filePath);
        expect(root.hasError, expression).toBe(false);
        expect(
          extract(emitTypeScriptCaptures(root), filePath, hooks).referenceSites.map(
            ({ name, kind }) => [name, kind],
          ),
        ).toEqual(
          (expression.startsWith('other')
            ? ['other', 'value', 'first', 'second']
            : ['value', 'first', 'second', 'other']
          ).map((name) => [name, 'read']),
        );
      }
    },
  );

  it.each(filePaths)(
    'refuses unsupported ternary fields and wrappers atomically in %s',
    async (filePath) => {
      for (const bad of [
        'obj?.[key]',
        'obj?.[key].field',
        '() => { return this; }',
        'value = 1',
        'delete value',
      ]) {
        for (const expression of [
          `(${bad}) ? first() : second()`,
          `good() ? (${bad}) : second()`,
          `good() ? first() : (${bad})`,
        ]) {
          for (const statement of [
            `before(); const result = ${expression};`,
            `const result = ${expression}; after();`,
          ]) {
            const { root } = await parse(`function owner() { ${statement} }`, filePath);
            expect(root.hasError, statement).toBe(false);
            let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
            expect(() => {
              captures = emitTypeScriptCaptures(root);
            }, statement).toThrow(ScopeUnsupportedSyntaxError);
            expect(captures, statement).toBeUndefined();
          }
        }
      }
      for (const statement of [
        'value ? first() : second();',
        '((value ? first() : second()));',
        ...(/\.tsx?$/.test(filePath)
          ? [
              'const result = (value ? first : second) as const;',
              'const result = (value ? first : second) as typeof Shape;',
              'const result = good ? (first as typeof Shape) : second;',
            ]
          : []),
      ]) {
        const { root } = await parse(
          `before(); function owner() { ${statement} } after();`,
          filePath,
        );
        expect(root.hasError, statement).toBe(false);
        let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
        expect(() => {
          captures = emitTypeScriptCaptures(root);
        }, statement).toThrow(ScopeUnsupportedSyntaxError);
        expect(captures, statement).toBeUndefined();
      }
    },
  );

  it.each(filePaths)(
    'preserves direct member reads across expression contexts in %s',
    async (filePath) => {
      for (const statement of [
        'obj.field;',
        'const value = obj.field;',
        'outer(obj.field);',
        'return obj.field;',
        'throw obj.field;',
        'if (obj.field) { after(); }',
        'for (const item of obj.field) { use(item); }',
        'for (const key in obj.field) { use(key); }',
      ]) {
        const source = `function owner(obj) { ${statement} }`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const member = root.descendantsOfType('member_expression')[0]!;
        const rangeOf = (node: typeof member) => ({
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column,
        });
        const captures = emitTypeScriptCaptures(root);
        const result = extract(captures, filePath, hooks);
        const expectedScopeNode = statement.startsWith('for')
          ? root.descendantsOfType('for_in_statement')[0]!
          : root.descendantsOfType('statement_block')[0]!;
        const expectedScope = result.scopes.find(
          (scope) =>
            scope.kind === 'Block' &&
            JSON.stringify(scope.range) === JSON.stringify(rangeOf(expectedScopeNode)),
        )!;
        expect(expectedScope, source).toBeDefined();
        const property = result.referenceSites.find((site) => site.name === 'field')!;
        expect(property, source).toEqual({
          name: 'field',
          kind: 'read',
          atRange: rangeOf(member),
          inScope: expectedScope.id,
          explicitReceiver: { name: 'obj' },
        });
        const memberIndex = result.referenceSites.indexOf(property);
        expect(result.referenceSites[memberIndex + 1], source).toEqual({
          name: 'obj',
          kind: 'read',
          atRange: rangeOf(member.childForFieldName('object')!),
          inScope: expectedScope.id,
        });
        expect(result.referenceSites.filter((site) => site.name === 'field')).toHaveLength(1);
        expect(result.referenceSites.filter((site) => site.name === 'obj')).toHaveLength(1);
        const expectedCalls = statement.startsWith('outer')
          ? ['outer']
          : statement.startsWith('if')
            ? ['after']
            : statement.startsWith('for')
              ? ['use']
              : [];
        expect(
          result.referenceSites.filter((site) => site.kind === 'call').map((site) => site.name),
          source,
        ).toEqual(expectedCalls);
        const saved = JSON.stringify(captures);
        parser.parse('replacement();');
        expect(JSON.stringify(captures)).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'preserves nested member reads across expression contexts in %s',
    async (filePath) => {
      const expressions = [
        'obj.child.field',
        'outer(obj.child.field)',
        'return obj.child.field;',
        'throw obj.child.field;',
        'if (obj.child.field) { after(); }',
        'for (const item of obj.child.field) { use(item); }',
        'const value = `${obj.child.field}`;',
        'const value = obj.child.field - 1;',
        'const value = !obj.child.field;',
        'const value = gate ? obj.child.field : fallback;',
      ];
      for (const expression of expressions) {
        const statement =
          expression.includes('return ') ||
          expression.includes('throw ') ||
          expression.startsWith('if ') ||
          expression.startsWith('for ') ||
          expression.startsWith('const ')
            ? expression
            : `${expression};`;
        const source = `function owner(obj, gate, fallback) { ${statement} }`;
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        const names = result.referenceSites.map(({ name }) => name);
        expect(
          names.filter((name) => name === 'field'),
          source,
        ).toHaveLength(1);
        expect(
          names.filter((name) => name === 'child'),
          source,
        ).toHaveLength(1);
        expect(
          names.filter((name) => name === 'obj'),
          source,
        ).toHaveLength(1);
        const field = result.referenceSites.find(({ name }) => name === 'field')!;
        const child = result.referenceSites.find(({ name }) => name === 'child')!;
        const obj = result.referenceSites.find(({ name }) => name === 'obj')!;
        for (const [site, text] of [
          [field, 'obj.child.field'],
          [child, 'obj.child'],
        ] as const) {
          const startCol = source.indexOf('obj.child.field');
          expect(site.atRange, source).toEqual({
            startLine: 1,
            startCol,
            endLine: 1,
            endCol: startCol + text.length,
          });
        }
        expect(field.explicitReceiver).toEqual({
          kind: 'chain',
          root: { name: 'obj', range: obj.atRange },
          steps: [
            {
              kind: 'member',
              name: 'child',
              range: {
                startLine: 1,
                startCol: source.indexOf('child'),
                endLine: 1,
                endCol: source.indexOf('child') + 5,
              },
            },
          ],
        });
        expect(child.explicitReceiver).toEqual({ name: 'obj' });
        expect(obj.atRange).toEqual({
          startLine: 1,
          startCol: source.indexOf('obj.child.field'),
          endLine: 1,
          endCol: source.indexOf('obj.child.field') + 3,
        });
      }
    },
  );

  it.each(filePaths)(
    'captures call-result members and each call argument once in %s',
    async (filePath) => {
      for (const statement of [
        'factory(arg).child.field;',
        'const value = factory(arg).child.field;',
        'outer(factory(arg).child.field);',
        'return factory(arg).child.field;',
        'throw factory(arg).child.field;',
        'if (factory(arg).child.field) { after(); }',
        'for (const item of factory(arg).child.field) { use(item); }',
        'const value = `${factory(arg).child.field}`;',
      ]) {
        const source = `function owner(arg) { ${statement} }`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const result = extract(captures, filePath, hooks);
        const members = root.descendantsOfType('member_expression');
        const call = root
          .descendantsOfType('call_expression')
          .find((node) => node.text === 'factory(arg)')!;
        const rangeOf = (node: typeof root) => ({
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column,
        });
        const scopeNode = statement.startsWith('for')
          ? root.descendantsOfType('for_in_statement')[0]!
          : root.descendantsOfType('statement_block')[0]!;
        const scope = result.scopes.find(
          (item) =>
            item.kind === 'Block' &&
            JSON.stringify(item.range) === JSON.stringify(rangeOf(scopeNode)),
        )!;
        const receiver = {
          kind: 'chain',
          root: { name: 'factory', range: rangeOf(call.childForFieldName('function')!) },
          steps: [{ kind: 'call', arity: 1, range: rangeOf(call) }],
        };
        expect(
          result.referenceSites.filter(({ name }) =>
            ['field', 'child', 'factory', 'arg'].includes(name),
          ),
          source,
        ).toEqual([
          {
            name: 'field',
            kind: 'read',
            atRange: rangeOf(members[0]!),
            inScope: scope.id,
            explicitReceiver: {
              ...receiver,
              steps: [
                ...receiver.steps,
                {
                  kind: 'member',
                  name: 'child',
                  range: rangeOf(members[1]!.childForFieldName('property')!),
                },
              ],
            },
          },
          {
            name: 'child',
            kind: 'read',
            atRange: rangeOf(members[1]!),
            inScope: scope.id,
            explicitReceiver: receiver,
          },
          {
            name: 'factory',
            kind: 'call',
            callForm: 'free',
            arity: 1,
            atRange: rangeOf(call),
            inScope: scope.id,
          },
          {
            name: 'arg',
            kind: 'read',
            atRange: rangeOf(call.childForFieldName('arguments')!.namedChildren[0]!),
            inScope: scope.id,
          },
        ]);
        const saved = JSON.stringify(captures);
        parser.parse('replacement();');
        expect(JSON.stringify(captures)).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'preserves exact traversal order and receivers in mixed call-result chains in %s',
    async (filePath) => {
      const source = 'factory(inner(arg)).child.method(other).field;';
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const rangeOf = (text: string) => ({
        startLine: 1,
        startCol: source.indexOf(text),
        endLine: 1,
        endCol: source.indexOf(text) + text.length,
      });
      const rootReceiver = { name: 'factory', range: rangeOf('factory') };
      const factoryStep = { kind: 'call', arity: 1, range: rangeOf('factory(inner(arg))') };
      const childStep = { kind: 'member', name: 'child', range: rangeOf('child') };
      expect(result.referenceSites).toEqual([
        {
          name: 'field',
          kind: 'read',
          atRange: rangeOf(source.slice(0, -1)),
          inScope: result.moduleScope,
          explicitReceiver: {
            kind: 'chain',
            root: rootReceiver,
            steps: [
              factoryStep,
              childStep,
              { kind: 'member', name: 'method', range: rangeOf('method') },
              { kind: 'call', arity: 1, range: rangeOf('factory(inner(arg)).child.method(other)') },
            ],
          },
        },
        {
          name: 'method',
          kind: 'call',
          callForm: 'member',
          arity: 1,
          atRange: rangeOf('factory(inner(arg)).child.method(other)'),
          inScope: result.moduleScope,
          explicitReceiver: { kind: 'chain', root: rootReceiver, steps: [factoryStep, childStep] },
        },
        {
          name: 'child',
          kind: 'read',
          atRange: rangeOf('factory(inner(arg)).child'),
          inScope: result.moduleScope,
          explicitReceiver: { kind: 'chain', root: rootReceiver, steps: [factoryStep] },
        },
        {
          name: 'factory',
          kind: 'call',
          callForm: 'free',
          arity: 1,
          atRange: rangeOf('factory(inner(arg))'),
          inScope: result.moduleScope,
        },
        {
          name: 'inner',
          kind: 'call',
          callForm: 'free',
          arity: 1,
          atRange: rangeOf('inner(arg)'),
          inScope: result.moduleScope,
        },
        { name: 'arg', kind: 'read', atRange: rangeOf('arg'), inScope: result.moduleScope },
        { name: 'other', kind: 'read', atRange: rangeOf('other'), inScope: result.moduleScope },
      ]);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'preserves non-null call-result property reads in %s',
    async (filePath) => {
      const source = 'const result = candidates.values().next().value!;';
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const rangeOf = (text: string) => ({
        startLine: 1,
        startCol: source.indexOf(text),
        endLine: 1,
        endCol: source.indexOf(text) + text.length,
      });
      const receiver = {
        kind: 'chain',
        root: { name: 'candidates', range: rangeOf('candidates') },
        steps: [
          { kind: 'member', name: 'values', range: rangeOf('values') },
          { kind: 'call', arity: 0, range: rangeOf('candidates.values()') },
        ],
      };
      expect(result.referenceSites).toEqual([
        {
          name: 'value',
          kind: 'read',
          atRange: rangeOf('candidates.values().next().value'),
          inScope: result.moduleScope,
          explicitReceiver: {
            ...receiver,
            steps: [
              ...receiver.steps,
              { kind: 'member', name: 'next', range: rangeOf('next') },
              { kind: 'call', arity: 0, range: rangeOf('candidates.values().next()') },
            ],
          },
        },
        {
          name: 'next',
          kind: 'call',
          callForm: 'member',
          arity: 0,
          atRange: rangeOf('candidates.values().next()'),
          inScope: result.moduleScope,
          explicitReceiver: receiver,
        },
        {
          name: 'values',
          kind: 'call',
          callForm: 'member',
          arity: 0,
          atRange: rangeOf('candidates.values()'),
          inScope: result.moduleScope,
          explicitReceiver: { name: 'candidates' },
        },
        {
          name: 'candidates',
          kind: 'read',
          atRange: rangeOf('candidates'),
          inScope: result.moduleScope,
        },
      ]);
    },
  );

  it.each(filePaths)(
    'rejects unsupported member reads atomically in nested contexts in %s',
    async (filePath) => {
      for (const value of [
        'obj?.[key].field',
        'new Factory().field',
        'this.field',
        'obj?.[key]',
        'obj.#field',
        'factory()().field',
        '(factory() ? this : second).field',
        'factory(...make()).field',
        'factory(obj?.[key]).child.field',
        'factory(() => { return this; }).field',
        'factory(arg).child.method(obj?.[key]).field',
        ...(/\.tsx?$/.test(filePath) ? ['(factory() as typeof Type).field'] : []),
      ]) {
        for (const statement of [
          `${value};`,
          `const value = ${value};`,
          `outer(${value});`,
          `return ${value};`,
          `throw ${value};`,
          `if (${value}) { after(); }`,
          `for (const item of ${value}) { use(item); }`,
        ]) {
          for (const contents of [`before(); ${statement}`, `${statement} after();`]) {
            const source = `function owner(obj) { ${contents} }`;
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
            expect(() => {
              captures = emitTypeScriptCaptures(root);
            }, source).toThrow(ScopeUnsupportedSyntaxError);
            expect(captures, source).toBeUndefined();
          }
        }
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'preserves typed constructor runtime references in %s',
    async (filePath) => {
      for (const expression of [
        'new Local<string>()',
        'new Local<string>',
        'new Local<Map<string, Array<Type | null>>>(inner(value))',
        'new Local<readonly Models.Type[]>(inner(value))',
        'new Local<Models.Type["member"]>(inner(value))',
        'new Local<Array<Models.Type[Key["name"]]>>()',
      ]) {
        for (const statement of [
          `${expression};`,
          `const initialized = ${expression};`,
          `return ${expression};`,
          `throw ${expression};`,
          `outer(${expression});`,
        ]) {
          const source = `class Local {} function owner(value) { ${statement} }`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
          expect(
            result.referenceSites.map(({ name, kind, callForm, arity }) => ({
              name,
              kind,
              callForm,
              arity,
            })),
            source,
          ).toEqual([
            ...(statement.startsWith('outer(')
              ? [{ name: 'outer', kind: 'call', callForm: 'free', arity: 1 }]
              : []),
            {
              name: 'Local',
              kind: 'call',
              callForm: 'constructor',
              arity: expression.includes('inner') ? 1 : 0,
            },
            ...(expression.includes('inner')
              ? [
                  { name: 'inner', kind: 'call', callForm: 'free', arity: 1 },
                  { name: 'value', kind: 'read', callForm: undefined, arity: undefined },
                ]
              : []),
          ]);
          const constructor = root.descendantsOfType('new_expression')[0]!;
          expect(
            result.referenceSites.find(({ name }) => name === 'Local')!.atRange,
            source,
          ).toEqual({
            startLine: constructor.startPosition.row + 1,
            startCol: constructor.startPosition.column,
            endLine: constructor.endPosition.row + 1,
            endCol: constructor.endPosition.column,
          });
        }
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'resolves nominal annotation identity while isolating value uses in %s',
    async (filePath) => {
      const { root: libRoot } = await parse(
        [
          'export interface Port { method(): void; }',
          'export type Alias = string;',
          'export class Runtime {}',
          'export enum Choice { A = "a" }',
          'export function run() {}',
        ].join('\n'),
        'lib.ts',
      );
      const { root } = await parse(
        [
          'import type { Port, Alias } from "./lib";',
          'let local: Port; let alias: Alias;',
          'function check(Port: string) { let nested: Port; }',
          'Port(); Alias();',
        ].join('\n'),
        filePath,
      );
      const lib = extract(emitTypeScriptCaptures(libRoot), 'lib.ts', typescriptProvider);
      const app = extract(emitTypeScriptCaptures(root), filePath, typescriptProvider);
      const module = lib.scopes.find((scope) => scope.id === lib.moduleScope)!;
      expect(lib.localDefs.map((def) => [def.qualifiedName, def.type])).toEqual([
        ['Port', 'Interface'],
        ['Alias', 'TypeAlias'],
        ['Runtime', 'Class'],
        ['Choice', 'Enum'],
        ['run', 'Function'],
      ]);
      expect(
        ['Port', 'Alias', 'Runtime', 'Choice', 'run'].map(
          (name) => module.bindings.get(name)?.[0]?.namespace,
        ),
      ).toEqual(['type', 'type', 'both', 'both', 'value']);
      expect(lib.localDefs.some((def) => def.qualifiedName === 'Port.method')).toBe(false);
      const indexes = finalizeScopeModel([app, lib], {
        hooks: { resolveImportTarget: (targetRaw) => (targetRaw === './lib' ? 'lib.ts' : null) },
      });
      const context = buildScopeRegistryContext(indexes);
      const annotations = app.scopes.flatMap((scope) => [...scope.typeBindings.values()]);
      expect(annotations.filter((ref) => ref.rawName === 'Port')).toHaveLength(2);
      expect(annotations.filter((ref) => ref.rawName === 'Alias')).toHaveLength(1);
      for (const ref of annotations.filter((ref) => ['Port', 'Alias'].includes(ref.rawName))) {
        expect(
          resolveTypeRef(ref, {
            scopes: context.scopes,
            defIndex: context.defs,
            qualifiedNameIndex: context.qualifiedNames,
            lookupExport: context.lookupExport,
          })?.nodeId,
        ).toBe(lib.localDefs.find((def) => def.qualifiedName === ref.rawName)!.nodeId);
      }
      expect(resolveReferences(indexes).stats).toEqual({
        totalSites: 2,
        resolvedSites: 0,
        unresolvedSites: 2,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'preserves composite evidence without resolving nominal constituents in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        [
          'interface Port {}',
          'class Models {}',
          'let generic: Map<string, Array<Port | null>>;',
          'let dotted: Models.User[];',
          'let nominal: Port;',
          'let lookup: Port["member"];',
          'declare const ambientLookup: Models.User[Key["name"]];',
          'function owner(value: readonly Models.User[], selected: Array<Port["member"]>): Array<Port | null> {}',
          'function select(value: Port[Key]): Models.User["member"] {}',
          'class Holder { field: Map<string, Port[]>; selected: Port["member"][]; method(input: Port | null): readonly Models.User[] {} lookup(input: Port[Key]): Map<string, Port["member"]> {} }',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const captures = structuredClone(emitTypeScriptCaptures(root));
      const serialized = JSON.stringify(captures);
      parser.parse('let replacement: string;');
      const result = extract(captures, filePath, typescriptProvider);
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      expect([...module.typeBindings].map(([name, ref]) => [name, ref.rawName])).toEqual([
        ['generic', 'Map<string, Array<Port | null>>'],
        ['dotted', 'Models.User[]'],
        ['nominal', 'Port'],
        ['lookup', 'Port["member"]'],
        ['ambientLookup', 'Models.User[Key["name"]]'],
      ]);
      const annotations = result.scopes.flatMap((scope) => [...scope.typeBindings.values()]);
      expect(annotations.map((ref) => ref.rawName)).toEqual([
        'Map<string, Array<Port | null>>',
        'Models.User[]',
        'Port',
        'Port["member"]',
        'Models.User[Key["name"]]',
        'readonly Models.User[]',
        'Array<Port["member"]>',
        'Port[Key]',
        'Port | null',
        'Port[Key]',
      ]);
      expect(result.localDefs.find((def) => def.qualifiedName === 'owner')).toMatchObject({
        returnType: 'Array<Port | null>',
        parameterCount: 2,
        requiredParameterCount: 2,
      });
      expect(result.localDefs.find((def) => def.qualifiedName === 'Holder.field')).toMatchObject({
        declaredType: 'Map<string, Port[]>',
      });
      expect(result.localDefs.find((def) => def.qualifiedName === 'Holder.method')).toMatchObject({
        returnType: 'readonly Models.User[]',
      });
      expect(result.localDefs.find((def) => def.qualifiedName === 'select')).toMatchObject({
        returnType: 'Models.User["member"]',
      });
      expect(result.localDefs.find((def) => def.qualifiedName === 'Holder.selected')).toMatchObject(
        {
          declaredType: 'Port["member"][]',
        },
      );
      expect(result.localDefs.find((def) => def.qualifiedName === 'Holder.lookup')).toMatchObject({
        returnType: 'Map<string, Port["member"]>',
      });
      expect(JSON.stringify(captures)).toBe(serialized);
      expect(extract(JSON.parse(serialized), filePath, typescriptProvider)).toEqual(result);
      const indexes = finalizeScopeModel([result]);
      const context = buildScopeRegistryContext(indexes);
      for (const ref of annotations) {
        const target = resolveTypeRef(ref, {
          scopes: context.scopes,
          defIndex: context.defs,
          qualifiedNameIndex: context.qualifiedNames,
          lookupExport: context.lookupExport,
        });
        if (ref.rawName === 'Port') {
          expect(target?.nodeId).toBe(
            result.localDefs.find((def) => def.qualifiedName === 'Port')!.nodeId,
          );
        } else {
          expect(target, ref.rawName).toBeNull();
        }
      }
      expect(result.referenceSites).toEqual([]);
      expect(resolveReferences(indexes).stats).toEqual({
        totalSites: 0,
        resolvedSites: 0,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'does not dispatch indexed access receivers to their nominal base in %s',
    async (filePath) => {
      const { root } = await parse(
        [
          'class Base { method() {} }',
          'declare const lookup: Base["member"];',
          'declare const nominal: Base;',
          'lookup.method(); nominal.method();',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, typescriptProvider);
      expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
        ['method', 'call'],
        ['lookup', 'read'],
        ['method', 'call'],
        ['nominal', 'read'],
      ]);
      const indexes = finalizeScopeModel([result]);
      const resolution = resolveReferences(indexes);
      const method = result.localDefs.find((def) => def.qualifiedName === 'Base.method')!;
      const resolved = [...resolution.referenceIndex.bySourceScope.values()].flat();
      expect(
        resolved.filter((site) => site.toDef === method.nodeId).map((site) => site.atRange),
      ).toEqual([result.referenceSites.filter((site) => site.kind === 'call')[1]!.atRange]);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'preserves plain tuple annotations through declaration metadata in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        [
          'let empty: [];',
          'let single: [Shape,];',
          'declare const nested: readonly [Shape[], Map<string, [Other | null]>];',
          'function owner(input: [Shape, readonly Other[]]): readonly [Other, Shape] {}',
          'class Holder { field: [Shape, Other]; method(input: readonly [Shape]): [Other] {} }',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, typescriptProvider);
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      expect([...module.typeBindings].map(([name, ref]) => [name, ref.rawName])).toEqual([
        ['empty', '[]'],
        ['single', '[Shape,]'],
        ['nested', 'readonly [Shape[], Map<string, [Other | null]>]'],
      ]);
      expect(
        result.scopes.flatMap((scope) =>
          [...scope.typeBindings.values()].map((ref) => ref.rawName),
        ),
      ).toEqual([
        '[]',
        '[Shape,]',
        'readonly [Shape[], Map<string, [Other | null]>]',
        '[Shape, readonly Other[]]',
        'readonly [Shape]',
      ]);
      expect(result.localDefs.find((def) => def.qualifiedName === 'owner')?.returnType).toBe(
        'readonly [Other, Shape]',
      );
      expect(
        result.localDefs.find((def) => def.qualifiedName === 'Holder.field')?.declaredType,
      ).toBe('[Shape, Other]');
      expect(
        result.localDefs.find((def) => def.qualifiedName === 'Holder.method')?.returnType,
      ).toBe('[Other]');
      expect(result.referenceSites).toEqual([]);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, typescriptProvider)).toEqual(result);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'reports only bounded node context for unsupported syntax in %s',
    async (filePath) => {
      for (const { source, suffix } of [
        {
          source:
            'const privateRuntime = "private-string:/private/source.ts";\nnamespace PrivateNamespace {}',
          suffix: 'internal_module at=2:1',
        },
        {
          source: '// private-marker /private/source.ts\nconst items = {__proto__: privateItems};',
          suffix: 'pair at=2:16',
        },
        {
          source:
            '// private-marker /private/source.ts\nconst items = /private-string/zz as NamedType;',
          suffix: 'regex at=2:15',
        },
        {
          source:
            '// private-marker /private/source.ts\nfunction privateOwner() {\n  privateValue + "private-string";\n}',
          suffix: 'binary_expression at=3:3',
        },
      ]) {
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        let error: unknown;
        try {
          emitTypeScriptCaptures(root);
        } catch (caught) {
          error = caught;
        }
        expect(error, source).toBeInstanceOf(ScopeUnsupportedSyntaxError);
        expect(error, source).toHaveProperty(
          'message',
          `TS/JS captures require the supported module subset [node=${suffix}]`,
        );
      }
    },
  );

  it.each([
    { type: '', startPosition: { row: 0, column: 0 } },
    { type: '/private/source.ts', startPosition: { row: 0, column: 0 } },
    { type: 'private\nmarker', startPosition: { row: 0, column: 0 } },
    { type: 'invalid_root\n', startPosition: { row: 0, column: 0 } },
    { type: 'x'.repeat(65), startPosition: { row: 0, column: 0 } },
    { type: undefined, startPosition: { row: 0, column: 0 } },
    { type: 'invalid_root', startPosition: undefined },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER].flatMap((coordinate) => [
      { type: 'invalid_root', startPosition: { row: coordinate, column: 0 } },
      { type: 'invalid_root', startPosition: { row: 0, column: coordinate } },
    ]),
  ])('omits context for unsafe root metadata: %j', (metadata) => {
    const root = metadata as unknown as Parameters<typeof emitTypeScriptCaptures>[0];
    expect(() => emitTypeScriptCaptures(root)).toThrowError(ScopeUnsupportedSyntaxError);
    expect(() => emitTypeScriptCaptures(root)).toThrowError(
      new ScopeUnsupportedSyntaxError('TS/JS captures require the supported module subset'),
    );
  });

  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains mixed import namespaces beside executable code in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        [
          'import { value, type T, type U as Local } from "./mixed";',
          'function caller() { value(); }',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const captures = structuredClone(emitTypeScriptCaptures(root));
      parser.parse('class Replacement {}');
      const parsed = extract(captures, filePath, hooks);
      expect(parsed.parsedImports).toEqual([
        { kind: 'named', localName: 'value', importedName: 'value', targetRaw: './mixed' },
        {
          kind: 'named',
          localName: 'T',
          importedName: 'T',
          targetRaw: './mixed',
          namespace: 'type',
        },
        {
          kind: 'alias',
          localName: 'Local',
          importedName: 'U',
          alias: 'Local',
          targetRaw: './mixed',
          namespace: 'type',
        },
      ]);
      expect(parsed.localDefs.map(({ qualifiedName }) => qualifiedName)).toEqual(['caller']);
      expect(
        parsed.referenceSites.map(({ name, kind, callForm }) => ({ name, kind, callForm })),
      ).toEqual([{ name: 'value', kind: 'call', callForm: 'free' }]);
    },
  );

  it.each(filePaths)(
    'keeps reexport names separate from private local bindings in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        ['const forwarded = 1;', 'export { helper as forwarded, other } from "./util";'].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const captures = JSON.parse(JSON.stringify(emitTypeScriptCaptures(root)));
      parser.parse('export class Replacement {}');
      const result = extract(captures, filePath, hooks);
      expect(result.parsedImports).toEqual([
        {
          kind: 'reexport',
          localName: 'forwarded',
          importedName: 'helper',
          alias: 'forwarded',
          targetRaw: './util',
        },
        { kind: 'reexport', localName: 'other', importedName: 'other', targetRaw: './util' },
      ]);
      expect(result.localDefs.map(({ qualifiedName }) => qualifiedName)).toEqual(['forwarded']);
      expect([...result.scopes[0]!.bindings.keys()]).toEqual(['forwarded']);
      expect(result.scopes[0]!.bindings.get('forwarded')![0]!.origin).toBe('local');
      expect(result.exports).toEqual(new Map());
      expect(result.referenceSites).toEqual([]);
    },
  );

  it.each(filePaths)(
    'rejects duplicate public reexport names across statements in %s',
    async (filePath) => {
      for (const source of [
        'export { A as repeated } from "./a"; export { B as repeated } from "./b";',
        'export const repeated = 1; export { A as repeated } from "./a";',
        'export { A as repeated } from "./a"; export const repeated = 1;',
        'const local = 1; export { local as repeated }; export { A as repeated } from "./a";',
        'export { A as repeated } from "./a"; const local = 1; export { local as repeated };',
      ]) {
        const { root } = await parse(source, filePath);
        expect(() => emitTypeScriptCaptures(root), source).toThrow();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains only module enum definitions and direct exports in %s',
    async (filePath) => {
      const source =
        'enum Private { First = "first", Second = \'second\', }\n' +
        'export enum Public { Ready = "ready" }';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = structuredClone(emitTypeScriptCaptures(root));
      parser.parse('class Replacement {}');
      const result = extract(captures, filePath, hooks);
      const expected = [
        {
          nodeId: `def:${filePath}#1:0:Enum:Private`,
          filePath,
          type: 'Enum',
          qualifiedName: 'Private',
        },
        {
          nodeId: `def:${filePath}#2:7:Enum:Public`,
          filePath,
          type: 'Enum',
          qualifiedName: 'Public',
        },
      ];
      expect(result.localDefs).toEqual(expected);
      expect(result.scopes).toHaveLength(1);
      const module = result.scopes[0]!;
      expect(module.kind).toBe('Module');
      expect(module.ownedDefs).toEqual(expected);
      expect([...module.bindings]).toEqual(
        expected.map((def) => [
          def.qualifiedName,
          [
            {
              def,
              origin: 'local',
              namespace: ['Class', 'Enum'].includes(def.type) ? 'both' : 'value',
            },
          ],
        ]),
      );
      expect([...module.typeBindings]).toEqual([]);
      expect(result.exports).toEqual(new Map([['Public', expected[1]!.nodeId]]));
      expect(result.parsedImports).toEqual([]);
      expect(result.referenceSites).toEqual([]);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'refuses enum syntax outside the explicit string subset in %s',
    async (filePath) => {
      for (const source of [
        'const enum E { A = "a" }',
        'declare enum E { A = "a" }',
        'export declare enum E { A = "a" }',
        'enum E { A }',
        'enum E { A = 1 }',
        'enum E { A = "a", B }',
        'enum E { A = value }',
        'enum E { A = "a" + "b" }',
        'enum E { "A" = "a" }',
        'enum E { [name] = "a" }',
        'enum E { A = `a` }',
        'enum E { A = "a\\nb" }',
        'enum E { A = "a\\u0062" }',
        'enum E { A = "a", A = "b" }',
        'enum E { A = "a"',
        'function owner() { enum E { A = "a" } }',
        '{ enum E { A = "a" } }',
        'enum E { A = "a" } enum E { B = "b" }',
        'class E {} enum E { A = "a" }',
        'enum E { A = "a" } class E {}',
        'import E from "./other"; enum E { A = "a" }',
        'enum E { A = "a" } import { Other as E } from "./other";',
        'let E = 1; enum E { A = "a" }',
        'enum E { A = "a" } function E() {}',
      ]) {
        const { root } = await parse(`const before = 1; ${source} after();`, filePath);
        expect(() => emitTypeScriptCaptures(root), source).toThrow();
      }
    },
  );

  it.each(['fixture.js', 'fixture.jsx'])(
    'shares exact signature arity compatibility in %s',
    async (filePath) => {
      const { root } = await parse(
        'class Owner { zero() {} method(value) { return value; } }',
        filePath,
      );
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const zero = result.localDefs.find((def) => def.qualifiedName === 'Owner.zero')!;
      const method = result.localDefs.find((def) => def.qualifiedName === 'Owner.method')!;
      expect(javascriptProvider.arityCompatibility).toBe(typescriptProvider.arityCompatibility);
      expect(javascriptProvider.arityCompatibility!(zero, { arity: 0 })).toBe('compatible');
      expect(javascriptProvider.arityCompatibility!(zero, { arity: 1 })).toBe('incompatible');
      expect(javascriptProvider.arityCompatibility!(method, { arity: 1 })).toBe('compatible');
      expect(javascriptProvider.arityCompatibility!(method, { arity: 0 })).toBe('incompatible');
    },
  );
  it.each(['fixture.ts', 'fixture.tsx'])(
    'detaches typed members with exact class owners and signature counts in %s',
    async (filePath) => {
      const source = [
        'class First { field: Models.User; same(value: Models.User, optional?: number): Models.User { return value; } zero(): void {} }',
        'class Second { field: string; same(): string { return "ok"; } }',
        'function typed(value: Models.User, optional?: number): Models.User { return value; }',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = structuredClone(emitTypeScriptCaptures(root));
      parser.parse('class Replacement {}');
      const result = extract(captures, filePath, hooks);
      const first = result.localDefs.find((def) => def.qualifiedName === 'First')!;
      const second = result.localDefs.find((def) => def.qualifiedName === 'Second')!;
      const members = result.localDefs.filter((def) => def.ownerId);
      expect(
        members.map(
          ({
            qualifiedName,
            type,
            ownerId,
            parameterCount,
            requiredParameterCount,
            returnType,
            declaredType,
          }) => ({
            qualifiedName,
            type,
            ownerId,
            parameterCount,
            requiredParameterCount,
            returnType,
            declaredType,
          }),
        ),
      ).toEqual(
        [
          {
            qualifiedName: 'First.field',
            type: 'Property',
            ownerId: first.nodeId,
            declaredType: 'Models.User',
          },
          {
            qualifiedName: 'First.same',
            type: 'Method',
            ownerId: first.nodeId,
            parameterCount: 2,
            requiredParameterCount: 1,
            returnType: 'Models.User',
          },
          {
            qualifiedName: 'First.zero',
            type: 'Method',
            ownerId: first.nodeId,
            parameterCount: 0,
            requiredParameterCount: 0,
            returnType: 'void',
          },
          {
            qualifiedName: 'Second.field',
            type: 'Property',
            ownerId: second.nodeId,
            declaredType: 'string',
          },
          {
            qualifiedName: 'Second.same',
            type: 'Method',
            ownerId: second.nodeId,
            parameterCount: 0,
            requiredParameterCount: 0,
            returnType: 'string',
          },
        ].map((member) => ({
          parameterCount: undefined,
          requiredParameterCount: undefined,
          returnType: undefined,
          declaredType: undefined,
          ...member,
        })),
      );
      const typed = result.localDefs.find((def) => def.qualifiedName === 'typed')!;
      expect(typed).toMatchObject({
        parameterCount: 2,
        requiredParameterCount: 1,
        returnType: 'Models.User',
      });
      for (const owner of result.scopes.filter(
        (scope) => scope.kind === 'Function' && scope.typeBindings.has('value'),
      )) {
        expect([...owner.typeBindings]).toEqual([
          ['value', { rawName: 'Models.User', declaredAtScope: owner.id, source: 'annotation' }],
          ['optional', { rawName: 'number', declaredAtScope: owner.id, source: 'annotation' }],
        ]);
      }
      expect(result.scopes.filter((scope) => scope.typeBindings.has('value'))).toHaveLength(2);
      expect(result.referenceSites.map(({ name }) => name)).toEqual(['value', 'value']);
      expect(
        [0, 1, 2, 3].map((arity) => typescriptProvider.arityCompatibility!(typed, { arity })),
      ).toEqual(['incompatible', 'compatible', 'compatible', 'incompatible']);
      const zero = members.find((def) => def.qualifiedName === 'First.zero')!;
      expect(typescriptProvider.arityCompatibility!(zero, { arity: 0 })).toBe('compatible');
      expect(typescriptProvider.arityCompatibility!(zero, { arity: 1 })).toBe('incompatible');
      expect(typescriptProvider.arityCompatibility!(first, { arity: 0 })).toBe('unknown');
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'refuses unsupported class members and signatures atomically in %s',
    async (filePath) => {
      for (const member of [
        'static constructor() {}',
        'static method() {}',
        'private method() {}',
        '#method() {}',
        '[name]() {}',
        'get value() {}',
        'set value(v: A) {}',
        '@decorator method() {}',
        'field = value;',
        'field?: A;',
        'readonly field: A;',
        'field: A & B;',
        'method<T>() {}',
        'method(value = 1) {}',
        'method(...values: A[]) {}',
        'method({ value: { nested } }: A) {}',
        'method(value?: A, required: B) {}',
        'method(): A<() => typeof value> {}',
        'method(value: A | typeof other) {}',
        'method() {} method() {}',
      ]) {
        const { root } = await parse(
          `const before = 1; class Owner { ${member} } after();`,
          filePath,
        );
        expect(() => emitTypeScriptCaptures(root), member).toThrow();
      }
    },
  );
  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains ambient and ordinary annotation bindings in %s',
    async (filePath) => {
      const source = [
        'declare const prisma: any;',
        'declare let value: Models.User;',
        'declare let untyped;',
        'const label: string = "ok";',
        'let local: number = 1;',
        'function owner() { { var hoisted: Models.User = new Value; let value: boolean = true; } }',
        'prisma.user.findMany();',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = structuredClone(emitTypeScriptCaptures(root));
      parser.parse('let replacement = 0;');
      const result = extract(captures, filePath, hooks);
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      expect([...module.typeBindings]).toEqual([
        ['prisma', { rawName: 'any', declaredAtScope: module.id, source: 'annotation' }],
        ['value', { rawName: 'Models.User', declaredAtScope: module.id, source: 'annotation' }],
        ['label', { rawName: 'string', declaredAtScope: module.id, source: 'annotation' }],
        ['local', { rawName: 'number', declaredAtScope: module.id, source: 'annotation' }],
      ]);
      const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
      expect([...owner.typeBindings]).toEqual([
        ['hoisted', { rawName: 'Models.User', declaredAtScope: owner.id, source: 'annotation' }],
      ]);
      const block = result.scopes.find(
        (scope) => scope.typeBindings.has('value') && scope.id !== module.id,
      )!;
      expect([...block.typeBindings]).toEqual([
        ['value', { rawName: 'boolean', declaredAtScope: block.id, source: 'annotation' }],
      ]);
      expect(result.referenceSites.map(({ name }) => name)).toEqual([
        'Value',
        'findMany',
        'user',
        'prisma',
      ]);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'bounds ambient declarations and annotation syntax in %s',
    async (filePath) => {
      for (const type of [
        'any',
        'unknown',
        'never',
        'void',
        'boolean',
        'number',
        'string',
        'object',
        'undefined',
        'null',
        'symbol',
        'bigint',
        'Value',
        'A.B.C',
        'A | B',
        'A<B>',
        'A[]',
        'readonly A[]',
        'Map<string, Array<Models.User | null>>',
      ]) {
        const { root } = await parse(`declare const value: ${type};`, filePath);
        expect(root.hasError, type).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        expect(result.scopes[0]!.typeBindings.get('value')?.rawName).toBe(type);
        expect(result.referenceSites).toEqual([]);
      }
      for (const source of [
        'declare const value = 1;',
        'declare let value: A & B;',
        'declare let value: { method(): A };',
        'declare let value: readonly [A, B?];',
        'declare var value: A;',
        'declare function value(): void;',
        'declare class Value {}',
        'declare namespace Value {}',
        'export declare const value: A;',
        'function owner() { declare let value: A; }',
        'const value: A;',
        'declare let value: A; var value;',
        'var value; declare const value: A;',
        'declare let value: A; { var value; }',
        'declare let value: A; let value;',
        'let value: A | typeof other = other;',
        'let value: A<{ method(): B }> = other;',
        'declare let value: A[typeof other];',
        'declare let value: A[keyof B];',
        'declare let value: (typeof other)[Key];',
        'declare let value: (keyof B)[Key];',
      ]) {
        const { root } = await parse(source, filePath);
        expect(() => emitTypeScriptCaptures(root), source).toThrow();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains typed initializers and exports in %s',
    async (filePath) => {
      for (const source of [
        'let typed: number = 1;',
        'const typed: number = value();',
        'export let typed: number = object.method();',
        'var typed: Value = new Value;',
        'var typed: number = 1;',
        'export var typed: number = 1;',
      ]) {
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
        expect([...module.typeBindings], source).toEqual([
          [
            'typed',
            {
              rawName: source.includes(': Value') ? 'Value' : 'number',
              declaredAtScope: module.id,
              source: 'annotation',
            },
          ],
        ]);
        expect(
          result.localDefs.map(({ qualifiedName }) => qualifiedName),
          source,
        ).toEqual(['typed']);
        expect(result.exports.has('typed'), source).toBe(source.startsWith('export '));
      }
    },
  );
  it.each(filePaths)(
    'composes default imports with empty named lists and local calls in %s',
    async (filePath) => {
      for (const list of ['{}', '{ /* empty */\n // still empty\n }']) {
        const source = [
          `import Main, ${list} from './module';`,
          'export const retained = 1;',
          'function local() { Main(); }',
          'local();',
        ].join('\n');
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const result = extract(captures, filePath, hooks);
        expect(
          captures.filter((match) => match['@import.binding']),
          source,
        ).toHaveLength(1);
        expect(result.parsedImports, source).toEqual([
          {
            kind: 'alias',
            localName: 'Main',
            importedName: 'default',
            alias: 'Main',
            targetRaw: './module',
          },
        ]);
        expect(
          result.localDefs.map((def) => def.qualifiedName),
          source,
        ).toEqual(['retained', 'local']);
        const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
        expect([...module.bindings.keys()], source).toEqual(['retained', 'local']);
        expect(result.exports, source).toEqual(
          new Map([['retained', result.localDefs[0]!.nodeId]]),
        );
        const body = result.scopes.find((scope) => scope.kind === 'Block')!;
        expect(
          result.referenceSites.map(({ name, inScope, callForm, arity }) => ({
            name,
            inScope,
            callForm,
            arity,
          })),
          source,
        ).toEqual([
          { name: 'Main', inScope: body.id, callForm: 'free', arity: 0 },
          { name: 'local', inScope: module.id, callForm: 'free', arity: 0 },
        ]);
      }
    },
  );

  it.each(filePaths)(
    'extracts canonical local definitions, imports and exports in %s',
    async (filePath) => {
      const source = [
        "import Main, { Value as Imported } from './module';",
        "import * as Namespace from './other';",
        'function local() {}',
        'function* generator() {}',
        'export class Public {}',
        'export function exposed() {}',
        'export function* sequence() {}',
        'export { local as renamed, generator };',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const expected = [
        {
          nodeId: `def:${filePath}#3:0:Function:local`,
          filePath,
          type: 'Function',
          qualifiedName: 'local',
          parameterCount: 0,
          requiredParameterCount: 0,
        },
        {
          nodeId: `def:${filePath}#4:0:Function:generator`,
          filePath,
          type: 'Function',
          qualifiedName: 'generator',
          parameterCount: 0,
          requiredParameterCount: 0,
        },
        {
          nodeId: `def:${filePath}#5:7:Class:Public`,
          filePath,
          type: 'Class',
          qualifiedName: 'Public',
        },
        {
          nodeId: `def:${filePath}#6:7:Function:exposed`,
          filePath,
          type: 'Function',
          qualifiedName: 'exposed',
          parameterCount: 0,
          requiredParameterCount: 0,
        },
        {
          nodeId: `def:${filePath}#7:7:Function:sequence`,
          filePath,
          type: 'Function',
          qualifiedName: 'sequence',
          parameterCount: 0,
          requiredParameterCount: 0,
        },
      ];
      expect(result.localDefs).toEqual(expected);
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      for (const def of expected) {
        expect(module.bindings.get(def.qualifiedName)).toEqual([
          {
            def,
            origin: 'local',
            namespace: ['Class', 'Enum'].includes(def.type) ? 'both' : 'value',
          },
        ]);
      }
      expect(result.parsedImports).toEqual([
        {
          kind: 'alias',
          localName: 'Main',
          importedName: 'default',
          alias: 'Main',
          targetRaw: './module',
        },
        {
          kind: 'alias',
          localName: 'Imported',
          importedName: 'Value',
          alias: 'Imported',
          targetRaw: './module',
        },
        {
          kind: 'namespace',
          localName: 'Namespace',
          importedName: './other',
          targetRaw: './other',
        },
      ]);
      expect(result.exports).toEqual(
        new Map([
          ['Public', expected[2]!.nodeId],
          ['exposed', expected[3]!.nodeId],
          ['sequence', expected[4]!.nodeId],
          ['renamed', expected[0]!.nodeId],
          ['generator', expected[1]!.nodeId],
        ]),
      );
    },
  );

  it.each(filePaths)(
    'accepts empty, comment-only and semicolon-only programs in %s',
    async (filePath) => {
      for (const source of ['', '/* module */\n// trailing', '; /* module */ ;\n;']) {
        const { root } = await parse(source, filePath);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        expect(result.scopes.map((scope) => scope.kind)).toEqual(['Module']);
        expect(result.localDefs).toEqual([]);
        expect(result.parsedImports).toEqual([]);
        expect(result.exports).toEqual(new Map());
      }
    },
  );

  it.each(filePaths)(
    'owns trailing empty-object defaults without initializer references in %s',
    async (filePath) => {
      const typed = /\.tsx?$/.test(filePath);
      const parameters = `required, options${typed ? ': Options' : ''} /* before */ = /* value */ { /* empty */ }, last = {}`;
      for (const source of [
        `function owner(${parameters}) { use(required, options, last); }`,
        `function* owner(${parameters}) { use(required, options, last); }`,
        `const owner = (${parameters}) => use(required, options, last);`,
        `const object = { method(${parameters}) { use(required, options, last); } };`,
        `class Owner { method(${parameters}) { use(required, options, last); } }`,
      ]) {
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
        expect(
          [...owner.bindings.keys()].filter((name) => name !== 'named'),
          source,
        ).toEqual(['required', 'options', 'last']);
        expect(
          owner.ownedDefs.filter((def) => def.type === 'Variable').map((def) => def.qualifiedName),
          source,
        ).toEqual(['required', 'options', 'last']);
        expect([...owner.typeBindings], source).toEqual(
          typed
            ? [['options', { rawName: 'Options', declaredAtScope: owner.id, source: 'annotation' }]]
            : [],
        );
        expect(
          result.referenceSites.map(({ name, kind, arity }) => ({ name, kind, arity })),
          source,
        ).toEqual([
          { name: 'use', kind: 'call', arity: 3 },
          ...['required', 'options', 'last'].map((name) => ({
            name,
            kind: 'read',
            arity: undefined,
          })),
        ]);
        const body = result.scopes.find((scope) => scope.kind === 'Block');
        expect(
          result.referenceSites.every((site) => site.inScope === (body ?? owner).id),
          source,
        ).toBe(true);
        const signature = result.localDefs.find((def) => ['Function', 'Method'].includes(def.type));
        if (signature) {
          expect(signature, source).toMatchObject({ parameterCount: 3, requiredParameterCount: 1 });
          expect(
            [0, 1, 2, 3, 4].map((arity) =>
              typescriptProvider.arityCompatibility!(signature, { arity }),
            ),
            source,
          ).toEqual(['incompatible', 'compatible', 'compatible', 'compatible', 'incompatible']);
        }
        parser.parse('function replacement() {}');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'keeps registry methods at arity two through three in %s',
    async (filePath) => {
      const source =
        'class Registry { get(target: Target, name: string, options: Options = {}) { use(target, name, options); } set(target: Target, name: string, options: Options = {}) { use(target, name, options); } remove(target: Target, name: string, options: Options = {}) { use(target, name, options); } }';
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const methods = result.localDefs.filter((def) => def.type === 'Method');
      expect(
        methods.map(({ qualifiedName, parameterCount, requiredParameterCount }) => ({
          qualifiedName,
          parameterCount,
          requiredParameterCount,
        })),
      ).toEqual(
        ['get', 'set', 'remove'].map((name) => ({
          qualifiedName: `Registry.${name}`,
          parameterCount: 3,
          requiredParameterCount: 2,
        })),
      );
      for (const method of methods) {
        expect(
          [1, 2, 3, 4].map((arity) => typescriptProvider.arityCompatibility!(method, { arity })),
        ).toEqual(['incompatible', 'compatible', 'compatible', 'incompatible']);
      }
      expect(result.referenceSites.map((site) => site.name)).toEqual(
        Array.from({ length: 3 }, () => ['use', 'target', 'name', 'options']).flat(),
      );
      for (const owner of result.scopes.filter((scope) => scope.kind === 'Function')) {
        expect([...owner.bindings.keys()]).toEqual(['target', 'name', 'options']);
        expect([...owner.typeBindings]).toEqual([
          ['target', { rawName: 'Target', declaredAtScope: owner.id, source: 'annotation' }],
          ['name', { rawName: 'string', declaredAtScope: owner.id, source: 'annotation' }],
          ['options', { rawName: 'Options', declaredAtScope: owner.id, source: 'annotation' }],
        ]);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'allows only optional and default parameters after the required prefix in %s',
    async (filePath) => {
      for (const parameters of [
        'required: string, options: Options = {}, extra?: number',
        'required: string, extra?: number, options: Options = {}',
        'options: Options = {}, extra?: number, last: Options = {}',
      ]) {
        const { root } = await parse(`function owner(${parameters}) {}`, filePath);
        expect(root.hasError).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        expect(result.localDefs[0]).toMatchObject({
          parameterCount: 3,
          requiredParameterCount: parameters.startsWith('required') ? 1 : 0,
        });
        expect(result.referenceSites).toEqual([]);
      }
    },
  );

  it.each(filePaths)(
    'refuses unsupported defaults and parameter environments atomically in %s',
    async (filePath) => {
      const parameters = [
        'value = 1',
        'value = other',
        'value = []',
        'value = ({})',
        'value = { key: 1 }',
        'value = { ...other }',
        'value = {}, required',
        'value, value = {}',
        '{ value } = {}',
        '[value] = {}',
        '...value = {}',
        ...(/\.tsx?$/.test(filePath) ? ['value?: Options = {}', 'value: A & B = {}'] : []),
      ];
      for (const signature of parameters) {
        for (const declaration of [
          `function bad(${signature}) {}`,
          `const bad = (${signature}) => 0;`,
          `class Bad { method(${signature}) {} }`,
          `const bad = { method(${signature}) {} };`,
        ]) {
          const { root } = await parse(`before(); ${declaration} after();`, filePath);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, declaration).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, declaration).toBeUndefined();
        }
      }
      for (const body of [
        'var value;',
        'var other;',
        '{ var other; }',
        'if (value) { var other; }',
        '"use strict";',
        '"other directive"; "use strict";',
      ]) {
        for (const declaration of [
          `function bad(value = {}) { ${body} }`,
          `const bad = (value = {}) => { ${body} };`,
          `class Bad { method(value = {}) { ${body} } }`,
          `const bad = { method(value = {}) { ${body} } };`,
        ]) {
          const { root } = await parse(`before(); ${declaration} after();`, filePath);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, declaration).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, declaration).toBeUndefined();
        }
      }
      for (const source of ['function bad(value = {) {}', 'const bad = (value = {}) => {']) {
        const { root } = await parse(source, filePath);
        expect(() => emitTypeScriptCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
      }
    },
  );

  it.each(filePaths)(
    'owns identifier parameters in empty functions and generators in %s',
    async (filePath) => {
      for (const prefix of ['', 'export ']) {
        for (const token of ['function', 'function*']) {
          for (const parameters of [
            'value',
            'first, second',
            '/* before */ café /* name */,\n λ, /* trailing */',
            ...(/\.tsx?$/.test(filePath)
              ? [
                  'value?',
                  'first, second?',
                  'first?, second?',
                  '/* before */ café?,\n λ?, /* trailing */',
                ]
              : []),
          ]) {
            const source = `${prefix}${token} owner(${parameters}) { /* empty */ }`;
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            const declaration = prefix
              ? root.namedChildren[0]!.childForFieldName('declaration')!
              : root.namedChildren[0]!;
            const names = declaration
              .childForFieldName('parameters')!
              .descendantsOfType('identifier');
            const captures = emitTypeScriptCaptures(root);
            const result = extract(captures, filePath, hooks);
            const rangeOf = (node: typeof declaration) => ({
              startLine: node.startPosition.row + 1,
              startCol: node.startPosition.column,
              endLine: node.endPosition.row + 1,
              endCol: node.endPosition.column,
            });
            const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
            const body = result.scopes.find((scope) => scope.kind === 'Block')!;
            const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
            expect(owner.range, source).toEqual(rangeOf(declaration));
            expect(owner.parent, source).toBe(module.id);
            expect(body.range, source).toEqual(rangeOf(declaration.childForFieldName('body')!));
            expect(body.parent, source).toBe(owner.id);
            const expected = names.map((name) => ({
              nodeId: `def:${filePath}#${name.startPosition.row + 1}:${name.startPosition.column}:Variable:${name.text}`,
              filePath,
              type: 'Variable',
              qualifiedName: name.text,
            }));
            expect(expected, source).not.toHaveLength(0);
            expect(result.localDefs.slice(1), source).toEqual(expected);
            expect(owner.ownedDefs, source).toEqual([result.localDefs[0], ...expected]);
            expect([...owner.bindings], source).toEqual(
              expected.map((def) => [
                def.qualifiedName,
                [
                  {
                    def,
                    origin: 'local',
                    namespace: ['Class', 'Enum'].includes(def.type) ? 'both' : 'value',
                  },
                ],
              ]),
            );
            expect(body.ownedDefs, source).toEqual([]);
            expect([...body.bindings], source).toEqual([]);
            expect([...module.bindings.keys()], source).toEqual(['owner']);
            expect(
              captures
                .filter((match) => match['@declaration.variable'])
                .map((match) => ({
                  name: match['@declaration.name']!.text,
                  range: match['@declaration.name']!.range,
                })),
              source,
            ).toEqual(names.map((name) => ({ name: name.text, range: rangeOf(name) })));
            expect(result.exports, source).toEqual(
              new Map(prefix ? [['owner', result.localDefs[0]!.nodeId]] : []),
            );
            expect(result.referenceSites, source).toEqual([]);
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'keeps parameter shadowing out of module collision checks in %s',
    async (filePath) => {
      const parameters = ['Imported', 'constant', 'lexical', 'repeated', 'sibling', 'owner']
        .map((name) => `${name}${/\.tsx?$/.test(filePath) ? '?' : ''}`)
        .join(', ');
      const source = [
        "import Imported from './module';",
        'const constant = 1; let lexical; var repeated;',
        'function sibling() {}',
        `export function owner(${parameters}) {}`,
        `export function* generator(${parameters}) {}`,
        'export { owner as renamed };',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const owners = result.scopes.filter(
        (scope) => scope.kind === 'Function' && scope.bindings.size > 0,
      );
      expect(owners).toHaveLength(2);
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      const names = ['Imported', 'constant', 'lexical', 'repeated', 'sibling', 'owner'];
      for (const owner of owners) {
        const parameters = owner.ownedDefs.filter((def) => def.type === 'Variable');
        const functions = owner.ownedDefs.filter((def) => def.type === 'Function');
        expect(functions).toHaveLength(1);
        expect(module.bindings.get(functions[0]!.qualifiedName!)).toEqual([
          { def: functions[0], origin: 'local', namespace: 'value' },
        ]);
        expect([...owner.bindings.keys()]).toEqual(names);
        expect(parameters.map((def) => def.qualifiedName)).toEqual(names);
        for (const def of parameters) {
          expect(owner.bindings.get(def.qualifiedName!)).toEqual([
            {
              def,
              origin: 'local',
              namespace: ['Class', 'Enum'].includes(def.type) ? 'both' : 'value',
            },
          ]);
          for (const scope of result.scopes.filter((scope) => scope.id !== owner.id)) {
            expect(scope.ownedDefs).not.toContainEqual(def);
            expect(scope.bindings.get(def.qualifiedName!) ?? []).not.toContainEqual({
              def,
              origin: 'local',
              namespace: ['Class', 'Enum'].includes(def.type) ? 'both' : 'value',
            });
          }
        }
      }
      expect(
        new Set(
          owners.flatMap((owner) =>
            owner.ownedDefs.filter((def) => def.type === 'Variable').map((def) => def.nodeId),
          ),
        ).size,
      ).toBe(12);
      expect([...module.bindings.keys()]).toEqual([
        'constant',
        'lexical',
        'repeated',
        'sibling',
        'owner',
        'generator',
      ]);
      expect(result.parsedImports.map((binding) => binding.localName)).toEqual(['Imported']);
      expect(result.exports).toEqual(
        new Map([
          ['owner', module.bindings.get('owner')![0]!.def.nodeId],
          ['generator', module.bindings.get('generator')![0]!.def.nodeId],
          ['renamed', module.bindings.get('owner')![0]!.def.nodeId],
        ]),
      );
    },
  );

  it.each(filePaths)(
    'rejects unsupported parameterized functions atomically in %s',
    async (filePath) => {
      const unsupported = [
        'function bad(value, value) {}',
        'function bad(value = 1) {}',
        'function bad(good, bad = 1) {}',
        'function bad(bad = 1, good) {}',
        'function bad(...values) {}',
        'function bad({ value: {nested} }) {}',
        'function bad([[value]]) {}',
        'async function* bad(value) {}',
        'async function* bad(value) {}',
        'function* bad(value) { yield 1; }',
        String.raw`function bad(\u0076alue) {}`,
        ...(/\.tsx?$/.test(filePath)
          ? [
              'function bad(value: A | typeof other) {}',
              'function bad(value?: A<() => typeof value>) {}',
              'function bad(value?, value?) {}',
              'function bad(value, value?) {}',
              'function bad(good?, bad = 1) {}',
              'function bad(bad = 1, good?) {}',
              'function bad(good?, ...bad) {}',
              'function bad(good?, { bad }) {}',
              'function bad({ bad: { nested } }, good?) {}',
              'function bad(good?, [bad]) {}',
              'function bad([[bad]], good?) {}',
              'function bad(good?, bad?: A | typeof other) {}',
              'function bad(bad?: A<() => typeof value>, good?) {}',
              'function bad<T>(value) {}',
              'function bad(value): A | typeof other {}',
            ]
          : []),
      ];
      for (const declaration of unsupported) {
        for (const prefix of ['', 'export ']) {
          for (const source of [
            `export function retained(before) {}\n${prefix}${declaration}`,
            `${prefix}${declaration}\nexport function retained(after) {}`,
          ]) {
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            expect(() => emitTypeScriptCaptures(root), source).toThrow();
          }
        }
      }
    },
  );

  it.each(['fixture.js', 'fixture.jsx'])(
    'rejects TypeScript optional parameters in %s',
    async (filePath) => {
      for (const prefix of ['', 'export ']) {
        for (const token of ['function', 'function*']) {
          for (const parameters of ['value?', 'first, second?', 'first?, second?']) {
            const { root } = await parse(
              `${prefix}${token} owner(${parameters}) { call(); }`,
              filePath,
            );
            expect(() => emitTypeScriptCaptures(root)).toThrow();
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'owns supported plain and returned call trees in body blocks in %s',
    async (filePath) => {
      for (const prefix of ['', 'export ']) {
        for (const token of ['function', 'function*']) {
          for (const [grouped, returned] of [
            [false, false],
            [true, false],
            [false, true],
            [true, true],
          ] as const) {
            const group = (expression: string) =>
              grouped ? `(/* grouped */ (${expression}))` : expression;
            const inner = `inner(/* literal */ ${group('1')},)`;
            const member = `obj /* receiver */ .method(${group('new Box')}, ${group('true')})`;
            const wrap = `new Wrap(${group('last(null)')},)`;
            const outer = `outer(${group(inner)},\n ${group(member)}, ${group(wrap)})`;
            const statements = `; /* body */ ${group('free()')};\n${returned ? 'return ' : ''}${group(outer)};\n${group('new Bare')}; ;`;
            const parameters = /\.tsx?$/.test(filePath) ? 'value, other?' : 'value, other';
            const source = [
              "import { Value } from './module';",
              'export const retained = 1;',
              'before();',
              `${prefix}${token} first(${parameters}) { ${statements} }`,
              `${prefix}${token} second(${parameters}) { ${statements} }`,
              'after(new Tail);',
              'export { first as renamed };',
            ].join('\n');
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
            const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
            const functions = result.scopes.filter((scope) => scope.kind === 'Function');
            const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
            expect(functions, source).toHaveLength(2);
            expect(blocks, source).toHaveLength(2);
            expect(new Set([...functions, ...blocks].map((scope) => scope.id)).size, source).toBe(
              4,
            );
            const rangeFor = (expression: string, from = 0) => {
              const start = source.indexOf(expression, from);
              expect(start, expression).toBeGreaterThanOrEqual(from);
              const before = source.slice(0, start).split('\n');
              const through = source.slice(0, start + expression.length).split('\n');
              return {
                startLine: before.length,
                startCol: before[before.length - 1]!.length,
                endLine: through.length,
                endCol: through[through.length - 1]!.length,
              };
            };
            const calls = [
              ['free()', 'free', 'free', 0],
              [outer, 'outer', 'free', 3],
              [inner, 'inner', 'free', 1],
              [member, 'method', 'member', 2],
              ['new Box', 'Box', 'constructor', 0],
              [wrap, 'Wrap', 'constructor', 1],
              ['last(null)', 'last', 'free', 1],
              ['new Bare', 'Bare', 'constructor', 0],
            ] as const;
            const expectedBodySites = functions.flatMap((owner, index) => {
              const name = index === 0 ? 'first' : 'second';
              const declaration = root.namedChildren
                .map((node) =>
                  node.type === 'export_statement' ? node.childForFieldName('declaration') : node,
                )
                .find((node) => node?.childForFieldName('name')?.text === name)!;
              const body = blocks.find((scope) => scope.parent === owner.id)!;
              const def = result.localDefs.find(
                (def) => def.type === 'Function' && def.qualifiedName === name,
              )!;
              const parameters = owner.ownedDefs.filter((def) => def.type === 'Variable');
              expect(owner.parent, source).toBe(module.id);
              expect(owner.range, source).toEqual(rangeFor(declaration.text));
              expect(body.range, source).toEqual(
                rangeFor(declaration.childForFieldName('body')!.text, declaration.startIndex),
              );
              expect(owner.ownedDefs, source).toEqual([def, ...parameters]);
              expect(
                parameters.map((def) => def.qualifiedName),
                source,
              ).toEqual(['value', 'other']);
              expect([...owner.bindings], source).toEqual(
                parameters.map((def) => [
                  def.qualifiedName,
                  [
                    {
                      def,
                      origin: 'local',
                      namespace: ['Class', 'Enum'].includes(def.type) ? 'both' : 'value',
                    },
                  ],
                ]),
              );
              expect(module.bindings.get(name), source).toEqual([
                {
                  def,
                  origin: 'local',
                  namespace: ['Class', 'Enum'].includes(def.type) ? 'both' : 'value',
                },
              ]);
              expect(body.ownedDefs, source).toEqual([]);
              expect([...body.bindings], source).toEqual([]);
              return calls.flatMap(([expression, name, callForm, arity]) => [
                {
                  name,
                  atRange: rangeFor(expression, declaration.startIndex),
                  inScope: body.id,
                  kind: 'call',
                  callForm,
                  arity,
                  ...(callForm === 'member' ? { explicitReceiver: { name: 'obj' } } : {}),
                },
                ...(callForm === 'member'
                  ? [
                      {
                        name: 'obj',
                        kind: 'read',
                        atRange: rangeFor(
                          'obj',
                          source.indexOf(expression, declaration.startIndex),
                        ),
                        inScope: body.id,
                      },
                    ]
                  : []),
              ]);
            });
            expect(result.referenceSites, source).toEqual([
              {
                name: 'before',
                atRange: rangeFor('before()'),
                inScope: module.id,
                kind: 'call',
                callForm: 'free',
                arity: 0,
              },
              ...expectedBodySites,
              {
                name: 'after',
                atRange: rangeFor('after(new Tail)'),
                inScope: module.id,
                kind: 'call',
                callForm: 'free',
                arity: 1,
              },
              {
                name: 'Tail',
                atRange: rangeFor('new Tail'),
                inScope: module.id,
                kind: 'call',
                callForm: 'constructor',
                arity: 0,
              },
            ]);
            expect([...module.bindings.keys()], source).toEqual(['retained', 'first', 'second']);
            expect(result.parsedImports, source).toEqual([
              { kind: 'named', localName: 'Value', importedName: 'Value', targetRaw: './module' },
            ]);
            const exportedNames = prefix
              ? ['retained', 'first', 'second', 'renamed']
              : ['retained', 'renamed'];
            expect(result.exports, source).toEqual(
              new Map(
                exportedNames.map((name) => [
                  name,
                  module.bindings.get(name === 'renamed' ? 'first' : name)![0]!.def.nodeId,
                ]),
              ),
            );
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'owns direct and grouped identifier return reads in the innermost block in %s',
    async (filePath) => {
      for (const prefix of ['', 'export ']) {
        for (const token of ['function', 'function*']) {
          const source = [
            "import Imported from './module';",
            `${prefix}${token} owner(value, café) {`,
            '  return value;',
            '  { let value = 1; return ((/* grouped */ value));',
            '    { return (\n café\n); return Imported; return ((missing)); }',
            '  }',
            '}',
          ].join('\n');
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const captures = emitTypeScriptCaptures(root);
          const detached = emitTypeScriptCaptures(root);
          const saved = JSON.stringify(detached);
          const result = extract(detached, filePath, hooks);
          const baseline = extract(
            detached.filter((match) => !match['@reference.read']),
            filePath,
            hooks,
          );
          const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
          expect(blocks, source).toHaveLength(3);
          const names = root
            .descendantsOfType('return_statement')
            .map((node) => node.descendantsOfType('identifier')[0]!);
          const reads = captures.filter((match) => match['@reference.read']);
          expect(reads, source).toEqual(
            names.map((name) => {
              const range = {
                startLine: name.startPosition.row + 1,
                startCol: name.startPosition.column,
                endLine: name.endPosition.row + 1,
                endCol: name.endPosition.column,
              };
              return {
                '@reference.read': { name: '@reference.read', text: '', range },
                '@reference.name': { name: '@reference.name', text: name.text, range },
              };
            }),
          );
          expect(result.referenceSites, source).toEqual(
            reads.map((match, index) => ({
              name: match['@reference.name']!.text,
              kind: 'read',
              atRange: match['@reference.read']!.range,
              inScope: blocks[index === 0 ? 0 : index === 1 ? 1 : 2]!.id,
            })),
          );
          const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
          expect([...owner.bindings.keys()], source).toEqual(['value', 'café']);
          expect([...blocks[1]!.bindings.keys()], source).toEqual(['value']);
          expect(blocks[1]!.bindings.get('value')![0]!.def.nodeId, source).not.toBe(
            owner.bindings.get('value')![0]!.def.nodeId,
          );
          expect(
            result.parsedImports.map((binding) => binding.localName),
            source,
          ).toEqual(['Imported']);
          expect(result.localDefs, source).toEqual(baseline.localDefs);
          expect(result.scopes, source).toEqual(baseline.scopes);
          for (const match of reads) {
            expect(match['@reference.read']!.range).not.toBe(match['@reference.name']!.range);
          }
          reads[0]!['@reference.read']!.range.startLine = 999;
          expect(reads[0]!['@reference.name']!.range.startLine).toBe(3);
          parser.parse('replacement();');
          expect(JSON.stringify(detached), source).toBe(saved);
          expect(extract(detached, filePath, hooks), source).toEqual(result);
        }
      }
    },
  );

  it.each(filePaths)(
    'accepts bare, literal and constructor returns in declared functions in %s',
    async (filePath) => {
      const values = ['', '0', '1.5', '0xff', '123n', "'text'", '"text"', 'true', 'false', 'null'];
      for (const prefix of ['', 'export ']) {
        for (const token of ['function', 'function*']) {
          for (const value of [
            ...values,
            ...values.slice(1).map((literal) => `(/* grouped */ (${literal}))`),
            '((new Box(child(1))))',
          ]) {
            const source = `${prefix}${token} owner(value) { return /* value */ ${value}; after(); }`;
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
            const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
            const body = result.scopes.find((scope) => scope.kind === 'Block')!;
            expect(body.parent, source).toBe(owner.id);
            expect([...owner.bindings.keys()], source).toEqual(['value']);
            expect([...body.bindings], source).toEqual([]);
            expect(
              result.referenceSites.map(({ name, callForm, arity, inScope }) => ({
                name,
                callForm,
                arity,
                inScope,
              })),
              source,
            ).toEqual(
              (value.includes('new Box')
                ? [
                    { name: 'Box', callForm: 'constructor', arity: 1, inScope: body.id },
                    { name: 'child', callForm: 'free', arity: 1, inScope: body.id },
                  ]
                : []
              ).concat([{ name: 'after', callForm: 'free', arity: 0, inScope: body.id }]),
            );
            expect(result.exports, source).toEqual(
              new Map(prefix ? [['owner', result.localDefs[0]!.nodeId]] : []),
            );
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'preserves call ranges across return automatic semicolon insertion in %s',
    async (filePath) => {
      for (const prefix of ['', 'export ']) {
        for (const token of ['function', 'function*']) {
          for (const separator of [' ', '\n', '\r\n', '/* same line */ ', '// comment\n']) {
            const source = `${prefix}${token} owner(value) { return${separator}outer(inner(1), obj.method(new Box)); after(); }`;
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
            const body = result.scopes.find((scope) => scope.kind === 'Block')!;
            const expected = [
              ['outer(inner(1), obj.method(new Box))', 'outer', 'free', 2],
              ['inner(1)', 'inner', 'free', 1],
              ['obj.method(new Box)', 'method', 'member', 1],
              ['new Box', 'Box', 'constructor', 0],
              ['after()', 'after', 'free', 0],
            ] as const;
            expect(result.referenceSites, source).toEqual(
              expected.flatMap(([expression, name, callForm, arity]) => {
                const start = source.indexOf(expression);
                const before = source.slice(0, start).split('\n');
                const through = source.slice(0, start + expression.length).split('\n');
                return [
                  {
                    name,
                    kind: 'call',
                    callForm,
                    arity,
                    inScope: body.id,
                    atRange: {
                      startLine: before.length,
                      startCol: before[before.length - 1]!.length,
                      endLine: through.length,
                      endCol: through[through.length - 1]!.length,
                    },
                    ...(callForm === 'member' ? { explicitReceiver: { name: 'obj' } } : {}),
                  },
                  ...(callForm === 'member'
                    ? [
                        {
                          name: 'obj',
                          kind: 'read',
                          inScope: body.id,
                          atRange: {
                            startLine: before.length,
                            startCol: before[before.length - 1]!.length,
                            endLine: before.length,
                            endCol: before[before.length - 1]!.length + 'obj'.length,
                          },
                        },
                      ]
                    : []),
                ];
              }),
            );
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'refuses return expressions attached across multiline comments in %s',
    async (filePath) => {
      for (const prefix of ['', 'export ']) {
        for (const token of ['function', 'function*']) {
          const source = `${prefix}${token} owner(value) { return /* comment\nnewline */ call(); after(); }`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const returned = root.descendantsOfType('return_statement')[0]!;
          const attached = returned.namedChildren.some((node) => node.type !== 'comment');
          expect(attached, source).toBe(/\.tsx?$/.test(filePath));
          if (attached) {
            expect(() => emitTypeScriptCaptures(root), source).toThrow();
          } else {
            const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
            const body = result.scopes.find((scope) => scope.kind === 'Block')!;
            expect(
              result.referenceSites.map(({ name, callForm, arity, inScope }) => ({
                name,
                callForm,
                arity,
                inScope,
              })),
              source,
            ).toEqual(
              ['call', 'after'].map((name) => ({
                name,
                callForm: 'free',
                arity: 0,
                inScope: body.id,
              })),
            );
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'accepts returns before closing braces and grouped multiline values in %s',
    async (filePath) => {
      for (const prefix of ['', 'export ']) {
        for (const token of ['function', 'function*']) {
          for (const value of ['', 'true', 'call()', '(\ncall()\n)']) {
            const source = `${prefix}${token} owner(value) { return ${value} }`;
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
            const body = result.scopes.find((scope) => scope.kind === 'Block')!;
            expect(
              result.referenceSites.map(({ name, callForm, arity, inScope }) => ({
                name,
                callForm,
                arity,
                inScope,
              })),
              source,
            ).toEqual(
              value.includes('call()')
                ? [{ name: 'call', callForm: 'free', arity: 0, inScope: body.id }]
                : [],
            );
          }
        }
      }
    },
  );

  it.each(filePaths)('rejects unsupported returned values atomically in %s', async (filePath) => {
    const values = [
      'delete value',
      'delete value',
      '{...value?.[key].deep}',
      '[...values?.[key].deep]',
      'tag`text`',
      '/pattern/zz',
      'obj?.[key].deep',
      'value = 1',
      String.raw`\u0076alue`,
      'value?.()',
      'obj?.[key]?.()',
      'obj[key]?.()',
      'obj[key]()',
      'outer(good(1), bad(value?.[key].deep))',
      'outer(bad(value?.[key].deep), good(1))',
      'new Box(good(1), bad(value?.[key].deep))',
      'new Box(bad(value?.[key].deep), good(1))',
      ...(/\.tsx?$/.test(filePath)
        ? ['value<Type>()', 'obj.method<Type>()', 'new Box<() => typeof Type>()']
        : []),
    ];
    for (const prefix of ['', 'export ']) {
      for (const token of ['function', 'function*']) {
        for (const statement of [
          ...values.map((value) => `return ((${value}));`),
          'return\n1;',
          'return /* comment\nnewline */ true;',
        ]) {
          for (const body of [`${statement}\nvalid(new Box);`, `valid(new Box);\n${statement}`]) {
            const source = `export const retained = 1;\nbefore();\n${prefix}${token} owner(value) { ${body} }\nafter();`;
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            expect(() => emitTypeScriptCaptures(root), source).toThrow();
          }
        }
      }
    }
  });

  it.each(filePaths)(
    'owns throw call trees and identifier reads in the innermost block in %s',
    async (filePath) => {
      for (const token of ['function', 'function*']) {
        for (const wrapper of ['{}', '{ { CONTENT } }', '{ if (true) { CONTENT } }']) {
          const statements =
            'before(); throw ((value)); throw (\n outer(value, new Box(inner(café)), obj.method(missing))\n); after();';
          const body =
            wrapper === '{}' ? `{ ${statements} }` : wrapper.replace('CONTENT', statements);
          const source = `export ${token} owner(value, café) ${body}`;
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const captures = emitTypeScriptCaptures(root);
          const saved = JSON.stringify(captures);
          const result = extract(captures, filePath, hooks);
          const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
          expect(blocks, source).toHaveLength(wrapper === '{}' ? 1 : 2);
          const scope = blocks[blocks.length - 1]!;
          const rangeOf = (expression: string, from = 0) => {
            const start = source.indexOf(expression, from);
            expect(start, expression).toBeGreaterThanOrEqual(from);
            const before = source.slice(0, start).split('\n');
            const through = source.slice(0, start + expression.length).split('\n');
            return {
              startLine: before.length,
              startCol: before[before.length - 1]!.length,
              endLine: through.length,
              endCol: through[through.length - 1]!.length,
            };
          };
          const thrown = source.indexOf('throw');
          const outer = source.indexOf('outer(');
          const member = source.indexOf('obj.method');
          const call = (expression: string, name: string, callForm: string, arity: number) => ({
            name,
            kind: 'call',
            callForm,
            arity,
            inScope: scope.id,
            atRange: rangeOf(expression),
            ...(callForm === 'member' ? { explicitReceiver: { name: 'obj' } } : {}),
          });
          const read = (name: string, from: number) => ({
            name,
            kind: 'read',
            inScope: scope.id,
            atRange: rangeOf(name, from),
          });
          expect(result.referenceSites, source).toEqual([
            call('before()', 'before', 'free', 0),
            read('value', thrown),
            call('outer(value, new Box(inner(café)), obj.method(missing))', 'outer', 'free', 3),
            read('value', outer),
            call('new Box(inner(café))', 'Box', 'constructor', 1),
            call('inner(café)', 'inner', 'free', 1),
            read('café', outer),
            call('obj.method(missing)', 'method', 'member', 1),
            read('obj', member),
            read('missing', member),
            call('after()', 'after', 'free', 0),
          ]);
          const independent = emitTypeScriptCaptures(root);
          independent.find((match) => match['@reference.read'])![
            '@reference.read'
          ]!.range.startLine = 999;
          parser.parse('function replacement() {}');
          expect(JSON.stringify(captures), source).toBe(saved);
          expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
        }
      }
    },
  );

  it.each(filePaths)(
    'owns module throw references without changing declarations, imports or exports in %s',
    async (filePath) => {
      const source = [
        "import Imported from './module';",
        'export const value = 1;',
        'before();',
        'throw /* same line */ ((Imported));',
        'throw (\n outer(value, new Box(inner(café)), obj.method(missing))\n);',
        'throw ((new Bare));',
        'after();',
      ].join('\n');
      const { root } = await parse(source, filePath);
      const { root: baselineRoot } = await parse(source.replace(/\bthrow/g, '     '), filePath);
      expect(root.hasError, source).toBe(false);
      expect(baselineRoot.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const baseline = extract(emitTypeScriptCaptures(baselineRoot), filePath, hooks);
      const rangeOf = (expression: string, from = 0) => {
        const start = source.indexOf(expression, from);
        expect(start, expression).toBeGreaterThanOrEqual(from);
        const before = source.slice(0, start).split('\n');
        const through = source.slice(0, start + expression.length).split('\n');
        return {
          startLine: before.length,
          startCol: before[before.length - 1]!.length,
          endLine: through.length,
          endCol: through[through.length - 1]!.length,
        };
      };
      const call = (expression: string, name: string, callForm: string, arity: number) => ({
        name,
        kind: 'call',
        callForm,
        arity,
        inScope: result.moduleScope,
        atRange: rangeOf(expression),
        ...(callForm === 'member' ? { explicitReceiver: { name: 'obj' } } : {}),
      });
      const read = (name: string, from: number) => ({
        name,
        kind: 'read',
        inScope: result.moduleScope,
        atRange: rangeOf(name, from),
      });
      const outer = source.indexOf('outer(');
      const member = source.indexOf('obj.method');
      expect(result.referenceSites, source).toEqual([
        call('before()', 'before', 'free', 0),
        read('Imported', source.indexOf('throw')),
        call('outer(value, new Box(inner(café)), obj.method(missing))', 'outer', 'free', 3),
        read('value', outer),
        call('new Box(inner(café))', 'Box', 'constructor', 1),
        call('inner(café)', 'inner', 'free', 1),
        read('café', outer),
        call('obj.method(missing)', 'method', 'member', 1),
        read('obj', member),
        read('missing', member),
        call('new Bare', 'Bare', 'constructor', 0),
        call('after()', 'after', 'free', 0),
      ]);
      expect(result.referenceSites).toEqual(baseline.referenceSites);
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.parsedImports).toEqual(baseline.parsedImports);
      expect(result.exports).toEqual(baseline.exports);
      expect(result.scopes).toEqual(baseline.scopes);
    },
  );

  it.each(filePaths)('accepts module throw literals between calls in %s', async (filePath) => {
    for (const value of [
      '0',
      '1.5',
      '0xff',
      '123n',
      "'text'",
      'true',
      'false',
      'null',
      '(\ntrue\n)',
    ]) {
      const source = `before(); throw /* same line */ ${value}; after();`;
      const { root } = await parse(source, filePath);
      expect(root.hasError, source).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      expect(
        result.referenceSites.map(({ name, kind, callForm, arity, inScope }) => ({
          name,
          kind,
          callForm,
          arity,
          inScope,
        })),
        source,
      ).toEqual(
        ['before', 'after'].map((name) => ({
          name,
          kind: 'call',
          callForm: 'free',
          arity: 0,
          inScope: result.moduleScope,
        })),
      );
    }
  });

  it.each(filePaths)(
    'rejects malformed and unsupported module throws atomically in %s',
    async (filePath) => {
      const statements = [
        'throw;',
        'throw',
        ...['\n', '\r', '\r\n', '\u2028', '\u2029'].flatMap((newline) => [
          `throw${newline}call();`,
          `throw /* comment${newline}newline */ call();`,
        ]),
        ...[
          'delete value',
          'delete value',
          '{...value?.[key].deep}',
          '[...values?.[key].deep]',
          'tag`text`',
          '/pattern/zz',
          'obj?.[key].deep',
          'value = 1',
          String.raw`\u0076alue`,
          'value?.()',
          'obj?.[key]?.()',
          'obj[key]?.()',
          'obj[key]()',
          'outer(...make())',
          'outer(good(), bad(value?.[key].deep))',
          'outer(bad(value?.[key].deep), good())',
          'new Box(...make())',
          ...(/\.tsx?$/.test(filePath) ? ['value<Type>()', 'new Box<() => typeof Type>()'] : []),
        ].map((value) => `throw ((${value}));`),
        'return;',
        'return value;',
        'return call();',
      ];
      const valid =
        "import Imported from './module'; export const retained = 1; before(); throw valid(); after();";
      for (const statement of statements) {
        for (const source of [`${statement}\n${valid}`, `${valid}\n${statement}`]) {
          const { root } = await parse(source, filePath);
          expect(() => emitTypeScriptCaptures(root), source).toThrow();
        }
      }
    },
  );

  it.each(filePaths)(
    'accepts throw literals, constructors and grouped multiline expressions in %s',
    async (filePath) => {
      for (const token of ['function', 'function*']) {
        for (const value of [
          '0',
          '1.5',
          '0xff',
          '123n',
          "'text'",
          'true',
          'false',
          'null',
          '(\ntrue\n)',
          '((new Box))',
        ]) {
          const source = `${token} owner() { before(); throw /* same line */ ${value}; after(); }`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
          const body = result.scopes.find((scope) => scope.kind === 'Block')!;
          expect(
            result.referenceSites.map(({ name, callForm, arity, inScope }) => ({
              name,
              callForm,
              arity,
              inScope,
            })),
            source,
          ).toEqual([
            { name: 'before', callForm: 'free', arity: 0, inScope: body.id },
            ...(value.includes('new Box')
              ? [{ name: 'Box', callForm: 'constructor', arity: 0, inScope: body.id }]
              : []),
            { name: 'after', callForm: 'free', arity: 0, inScope: body.id },
          ]);
        }
      }
    },
  );

  it.each(filePaths)(
    'rejects bare, line-broken and unsupported throws atomically in %s',
    async (filePath) => {
      const statements = [
        'throw;',
        ...['\n', '\r', '\r\n', '\u2028', '\u2029'].flatMap((newline) => [
          `throw${newline}call();`,
          `throw /* comment${newline}newline */ call();`,
        ]),
        ...[
          'delete value',
          'delete value',
          '{...value?.[key].deep}',
          '[...values?.[key].deep]',
          'tag`text`',
          '/pattern/zz',
          'obj?.[key].deep',
          'value = 1',
          String.raw`\u0076alue`,
          'value?.()',
          'obj?.[key]?.()',
          'obj[key]?.()',
          'obj[key]()',
          'outer(...make())',
          'outer(good(), bad(value?.[key].deep))',
          'outer(bad(value?.[key].deep), good())',
          'new Box(...make())',
          ...(/\.tsx?$/.test(filePath) ? ['value<Type>()', 'new Box<() => typeof Type>()'] : []),
        ].map((value) => `throw ((${value}));`),
      ];
      for (const token of ['function', 'function*']) {
        for (const statement of statements) {
          for (const body of [`${statement} valid();`, `valid(); ${statement}`]) {
            const source = `export const retained = 1; before(); ${token} owner(value) { ${body} } after();`;
            const { root } = await parse(source, filePath);
            expect(() => emitTypeScriptCaptures(root), source).toThrow();
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'rejects unsupported function-body statements before or after calls in %s',
    async (filePath) => {
      const unsupported = [
        'yield 1;',
        'if (true) while (obj?.[key].deep) {}',
        '1;',
        '"use strict";',
        'function nested() {}',
        'value?.();',
        'object?.[key]?.();',
        'object[key]?.();',
        'object[key]();',
        'outer(value?.[key].deep);',
        'outer(good(1), bad(value?.[key].deep));',
        'outer(bad(value?.[key].deep), good(1));',
        ...(/\.tsx?$/.test(filePath)
          ? ['value<Type>();', 'object.method<Type>();', 'new Value<() => typeof Type>();']
          : []),
      ];
      for (const statement of unsupported) {
        for (const prefix of ['', 'export ']) {
          for (const token of ['function', 'function*']) {
            // Yield is a statement only in generators; ordinary-function parsing is already rejected.
            if (statement.startsWith('yield') && token === 'function') continue;
            for (const body of [`${statement}\nvalid(new Box);`, `valid(new Box);\n${statement}`]) {
              const source = `export const retained = 1;\nbefore();\n${prefix}${token} owner(value) { ${body} }\nafter();`;
              const { root } = await parse(source, filePath);
              expect(root.hasError, source).toBe(false);
              expect(() => emitTypeScriptCaptures(root), source).toThrow();
            }
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'owns direct body locals and initializer call trees in %s',
    async (filePath) => {
      const bodyText = [
        'const Imported = ((outer(inner(1), obj.method(new Box), new Wrap(last(null))))), constant = true;',
        'let lexical, sibling = ((1));',
        'var repeated, owner = new Bare;',
      ].join('\n');
      const source = [
        "import Imported from './module';",
        'export const constant = 1; let lexical; var repeated;',
        'function sibling() {}',
        `function owner(value) { ${bodyText} }`,
        `function* generator(value) { ${bodyText} }`,
        `export function exposed(value) { ${bodyText} }`,
        `export function* sequence(value) { ${bodyText} }`,
        'export { owner as renamed };',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      const declarations = root.namedChildren
        .map((node) =>
          node.type === 'export_statement' ? node.childForFieldName('declaration') : node,
        )
        .filter((node) => node?.childForFieldName('parameters'));
      const expectedCalls = declarations.flatMap((declaration) => {
        const name = declaration!.childForFieldName('name')!.text;
        const def = result.localDefs.find(
          (candidate) => candidate.type === 'Function' && candidate.qualifiedName === name,
        )!;
        const owner = result.scopes.find(
          (scope) =>
            scope.kind === 'Function' &&
            scope.ownedDefs.some((candidate) => candidate.nodeId === def.nodeId),
        )!;
        const body = result.scopes.find(
          (scope) => scope.kind === 'Block' && scope.parent === owner.id,
        )!;
        expect(module.bindings.get(name)![0]!.def).toBe(def);
        expect(owner.parent).toBe(module.id);
        if (name === 'sibling') {
          expect(body.ownedDefs).toEqual([]);
          return [];
        }
        const locals = declaration!
          .childForFieldName('body')!
          .descendantsOfType('variable_declarator')
          .map((node) => {
            const identifier = node.childForFieldName('name')!;
            return {
              nodeId: `def:${filePath}#${identifier.startPosition.row + 1}:${identifier.startPosition.column}:Variable:${identifier.text}`,
              filePath,
              type: 'Variable',
              qualifiedName: identifier.text,
            };
          });
        expect(body.ownedDefs).toEqual(locals);
        expect([...body.bindings.keys()]).toEqual(['Imported', 'constant', 'lexical', 'sibling']);
        expect([...owner.bindings.keys()]).toEqual(['value', 'repeated', 'owner']);
        expect(owner.ownedDefs.map((candidate) => candidate.qualifiedName)).toEqual([
          name,
          'value',
        ]);
        for (const expected of locals) {
          const local = result.localDefs.find((candidate) => candidate.nodeId === expected.nodeId)!;
          expect(local).toEqual(expected);
          expect(body.ownedDefs.find((candidate) => candidate.nodeId === expected.nodeId)).toBe(
            local,
          );
          const bindingScope = ['repeated', 'owner'].includes(expected.qualifiedName)
            ? owner
            : body;
          expect(bindingScope.bindings.get(expected.qualifiedName)![0]!.def).toBe(local);
          expect(module.ownedDefs).not.toContainEqual(local);
          expect(module.bindings.get(expected.qualifiedName) ?? []).not.toContainEqual({
            def: local,
            origin: 'local',
            namespace: 'value',
          });
        }
        return [
          ['outer', 'free', 3],
          ['inner', 'free', 1],
          ['method', 'member', 1],
          ['obj', undefined, undefined],
          ['Box', 'constructor', 0],
          ['Wrap', 'constructor', 1],
          ['last', 'free', 1],
          ['Bare', 'constructor', 0],
        ].map(([name, callForm, arity]) => ({ name, callForm, arity, inScope: body.id }));
      });
      expect(
        result.referenceSites.map(({ name, callForm, arity, inScope }) => ({
          name,
          callForm,
          arity,
          inScope,
        })),
      ).toEqual(expectedCalls);
      expect([...module.bindings.keys()]).toEqual([
        'constant',
        'lexical',
        'repeated',
        'sibling',
        'owner',
        'generator',
        'exposed',
        'sequence',
      ]);
      expect(result.parsedImports.map((binding) => binding.localName)).toEqual(['Imported']);
      expect(result.exports).toEqual(
        new Map(
          ['constant', 'exposed', 'sequence', 'renamed'].map((name) => [
            name,
            module.bindings.get(name === 'renamed' ? 'owner' : name)![0]!.def.nodeId,
          ]),
        ),
      );
    },
  );

  it.each(filePaths)(
    'selects parameter and earliest var identities while preserving body declarations in %s',
    async (filePath) => {
      for (const prefix of ['', 'export ']) {
        for (const token of ['function', 'function*']) {
          const source = `${prefix}${token} owner(value) { var value = first(), repeated = second(), repeated = third(); var value; var repeated; }`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
          const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
          const body = result.scopes.find((scope) => scope.kind === 'Block')!;
          const parameter = owner.ownedDefs.find((def) => def.qualifiedName === 'value')!;
          const locals = body.ownedDefs;
          expect(
            locals.map((def) => def.qualifiedName),
            source,
          ).toEqual(['value', 'repeated', 'repeated', 'value', 'repeated']);
          expect(new Set(locals.map((def) => def.nodeId)).size, source).toBe(5);
          expect(parameter.nodeId, source).toBe(
            `def:${filePath}#1:${source.indexOf('value')}:Variable:value`,
          );
          expect(owner.bindings.get('value')![0]!.def, source).toBe(parameter);
          expect(owner.bindings.get('repeated')![0]!.def, source).toBe(locals[1]);
          expect(locals[1]!.nodeId, source).toBe(
            `def:${filePath}#1:${source.indexOf('repeated')}:Variable:repeated`,
          );
          expect([...body.bindings], source).toEqual([]);
          const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
          expect([...module.bindings.keys()], source).toEqual(['owner']);
          expect(result.localDefs, source).toEqual([...owner.ownedDefs, ...locals]);
          expect(result.exports, source).toEqual(
            new Map(prefix ? [['owner', module.bindings.get('owner')![0]!.def.nodeId]] : []),
          );
          expect(
            result.referenceSites.map(({ name, inScope }) => ({ name, inScope })),
            source,
          ).toEqual(['first', 'second', 'third'].map((name) => ({ name, inScope: body.id })));
        }
      }
    },
  );

  it.each(filePaths)(
    'rejects body lexical collisions and unsupported declarators atomically in %s',
    async (filePath) => {
      const bodies = [
        'let value;',
        'const value = 1;',
        'let local; let local;',
        'const local = 1; const local = 2;',
        'let local; const local = 1;',
        'const local = 1; let local;',
        'let local, local;',
        'const local = 1, local = 2;',
        'var local; let local;',
        'let local; var local;',
        'var local; const local = 1;',
        'const local = 1; var local;',
      ];
      for (const kind of ['let', 'const', 'var']) {
        for (const bad of [
          'bad = value?.[key].deep',
          'bad = delete value',
          'bad = {...value?.[key].deep}',
          'bad = [...values?.[key].deep]',
          'bad = outer(good(1), bad(value?.[key].deep))',
          'bad = outer(bad(value?.[key].deep), good(1))',
          'bad = () => { return this; }',
          '{ bad } = {}',
          ...(/\.tsx?$/.test(filePath)
            ? ['bad: number & string = 1', 'bad = new Box<() => typeof Type>()']
            : []),
        ]) {
          bodies.push(`${kind} good = valid(), ${bad};`, `${kind} ${bad}, good = valid();`);
        }
      }
      bodies.push('const missing;', 'var valid; function nested() {}');
      for (const prefix of ['', 'export ']) {
        for (const token of ['function', 'function*']) {
          for (const body of bodies) {
            for (const statements of [`${body} valid();`, `valid(); ${body}`]) {
              const source = `export const retained = 1; before(); ${prefix}${token} owner(value) { ${statements} } after();`;
              const { root } = await parse(source, filePath);
              expect(root.hasError, source).toBe(false);
              expect(() => emitTypeScriptCaptures(root), source).toThrow();
            }
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'owns nested block locals and preserves depth-first call order in %s',
    async (filePath) => {
      for (const token of ['function', 'function*']) {
        const source = [
          "import Imported from './module';",
          'export const retained = 1;',
          `export ${token} owner(value) {`,
          '  before();',
          '  { let value = init(); var repeated = first(); nested(inner());',
          '    { const deep = new Box; return deepCall(); }',
          '  }',
          '  var value, repeated = second();',
          '  { let sibling = 1; left(); }',
          '  { const sibling = 2; right(); }',
          '  { let x; }',
          '  { var x; }',
          '  after();',
          '}',
          'export { owner as renamed };',
        ].join('\n');
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
        const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
        const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
        const body = blocks.find((scope) => scope.parent === owner.id)!;
        const blockAt = (line: number) => blocks.find((scope) => scope.range.startLine === line)!;
        expect(blocks).toHaveLength(7);
        expect(owner.parent).toBe(module.id);
        for (const node of root.descendantsOfType('statement_block')) {
          const block = blockAt(node.startPosition.row + 1);
          expect(block.range).toEqual({
            startLine: node.startPosition.row + 1,
            startCol: node.startPosition.column,
            endLine: node.endPosition.row + 1,
            endCol: node.endPosition.column,
          });
          expect(block.parent).toBe(
            node.parent!.type === 'statement_block'
              ? blockAt(node.parent!.startPosition.row + 1).id
              : owner.id,
          );
        }
        expect(blocks.map((scope) => scope.ownedDefs.map((def) => def.qualifiedName))).toEqual([
          ['value', 'repeated'],
          ['value', 'repeated'],
          ['deep'],
          ['sibling'],
          ['sibling'],
          ['x'],
          ['x'],
        ]);
        expect([...body.bindings]).toEqual([]);
        for (const [line, names] of [
          [5, ['value']],
          [6, ['deep']],
          [9, ['sibling']],
          [10, ['sibling']],
          [11, ['x']],
          [12, []],
        ] as const) {
          const block = blockAt(line);
          expect([...block.bindings.keys()]).toEqual(names);
          for (const name of names) {
            expect(block.bindings.get(name)![0]!.def).toBe(
              block.ownedDefs.find((def) => def.qualifiedName === name),
            );
          }
        }
        const parameter = owner.ownedDefs.find((def) => def.qualifiedName === 'value')!;
        expect(owner.bindings.get('value')![0]!.def).toBe(parameter);
        expect(blockAt(5).bindings.get('value')![0]!.def).not.toBe(parameter);
        expect(owner.bindings.get('repeated')![0]!.def).toBe(blockAt(5).ownedDefs[1]);
        expect(owner.bindings.get('x')![0]!.def).toBe(blockAt(12).ownedDefs[0]);
        expect([...owner.bindings.keys()]).toEqual(['value', 'repeated', 'x']);
        expect(owner.ownedDefs.map((def) => def.qualifiedName)).toEqual(['owner', 'value']);
        expect(result.referenceSites.map(({ name, inScope }) => ({ name, inScope }))).toEqual(
          (
            [
              ['before', body],
              ['init', blockAt(5)],
              ['first', blockAt(5)],
              ['nested', blockAt(5)],
              ['inner', blockAt(5)],
              ['Box', blockAt(6)],
              ['deepCall', blockAt(6)],
              ['second', body],
              ['left', blockAt(9)],
              ['right', blockAt(10)],
              ['after', body],
            ] as const
          ).map(([name, scope]) => ({ name, inScope: scope.id })),
        );
        expect([...module.bindings.keys()]).toEqual(['retained', 'owner']);
        expect(result.parsedImports.map((binding) => binding.localName)).toEqual(['Imported']);
        expect(result.exports).toEqual(
          new Map(
            ['retained', 'owner', 'renamed'].map((name) => [
              name,
              module.bindings.get(name === 'renamed' ? 'owner' : name)![0]!.def.nodeId,
            ]),
          ),
        );
      }
    },
  );

  it.each(filePaths)(
    'rejects nested lexical collisions and unsupported syntax atomically in %s',
    async (filePath) => {
      const bodies = [
        '{ let x; let x; }',
        '{ let x; const x = 1; }',
        '{ let x; { var x; } }',
        '{ { var x; } let x; }',
        'let x; { var x; }',
        '{ var x; } let x;',
        'let value;',
        'const value = 1;',
      ];
      const unsupported = [
        'if (true) while (obj?.[key].deep) {}',
        'while (obj?.[key].deep) {}',
        'for (;;) { break label; }',
        'function nested() {}',
        'class Nested {}',
      ];
      for (const statement of unsupported) {
        for (const nested of [`${statement} valid();`, `valid(); ${statement}`]) {
          bodies.push(`{ { { ${nested} } } }`);
        }
      }
      for (const token of ['function', 'function*']) {
        for (const body of bodies) {
          const source = `export const retained = 1; before(); export ${token} owner(value) { ${body} } after();`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          expect(() => emitTypeScriptCaptures(root), source).toThrow();
        }
      }
      const { root } = await parse('{ while (obj?.[key].deep) {} }', filePath);
      expect(root.hasError).toBe(false);
      expect(() => emitTypeScriptCaptures(root)).toThrow();
    },
  );

  it.each(filePaths)(
    'owns braced if branches and captures conditions before branches in %s',
    async (filePath) => {
      const source = [
        'export function owner(value) {',
        '  if ((outer(new Box(value), obj.method(check())))) {',
        '    let value = 1; var repeated = first(value);',
        '    if ((value)) { return new Wrap(value); }',
        '    else { return fallback(value); }',
        '  } else {',
        '    const value = 2; var repeated = second(value);',
        '  }',
        '  after(repeated);',
        '}',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
      const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
      expect(blocks).toHaveLength(5);
      const [body, thenBlock, nestedThen, nestedElse, elseBlock] = blocks;
      expect(blocks.map((scope) => scope.parent)).toEqual([
        owner.id,
        body!.id,
        thenBlock!.id,
        thenBlock!.id,
        body!.id,
      ]);
      expect(blocks.map((scope) => scope.range)).toEqual(
        root.descendantsOfType('statement_block').map((node) => ({
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column,
        })),
      );
      expect(blocks.map((scope) => scope.ownedDefs.map((def) => def.qualifiedName))).toEqual([
        [],
        ['value', 'repeated'],
        [],
        [],
        ['value', 'repeated'],
      ]);
      expect(blocks.map((scope) => [...scope.bindings.keys()])).toEqual([
        [],
        ['value'],
        [],
        [],
        ['value'],
      ]);
      const parameter = owner.ownedDefs.find((def) => def.qualifiedName === 'value')!;
      expect([...owner.bindings.keys()]).toEqual(['value', 'repeated']);
      expect(owner.bindings.get('value')![0]!.def).toBe(parameter);
      expect(owner.bindings.get('repeated')![0]!.def).toBe(thenBlock!.ownedDefs[1]);
      expect(thenBlock!.bindings.get('value')![0]!.def).toBe(thenBlock!.ownedDefs[0]);
      expect(elseBlock!.bindings.get('value')![0]!.def).toBe(elseBlock!.ownedDefs[0]);
      expect(
        new Set(
          [parameter, thenBlock!.ownedDefs[0]!, elseBlock!.ownedDefs[0]!].map((def) => def.nodeId),
        ).size,
      ).toBe(3);
      const rangeFor = (text: string, from = 0) => {
        const start = source.indexOf(text, from);
        expect(start, text).toBeGreaterThanOrEqual(0);
        const before = source.slice(0, start).split('\n');
        const through = source.slice(0, start + text.length).split('\n');
        return {
          startLine: before.length,
          startCol: before[before.length - 1]!.length,
          endLine: through.length,
          endCol: through[through.length - 1]!.length,
        };
      };
      const call = (
        text: string,
        name: string,
        scope: string,
        callForm: 'free' | 'member' | 'constructor',
        arity: number,
      ) => ({
        name,
        kind: 'call',
        atRange: rangeFor(text),
        inScope: scope,
        callForm,
        arity,
        ...(callForm === 'member' ? { explicitReceiver: { name: 'obj' } } : {}),
      });
      const read = (name: string, after: string, scope: string) => ({
        name,
        kind: 'read',
        atRange: rangeFor(name, source.indexOf(after) + after.length),
        inScope: scope,
      });
      expect(result.referenceSites).toEqual([
        call('outer(new Box(value), obj.method(check()))', 'outer', body!.id, 'free', 2),
        call('new Box(value)', 'Box', body!.id, 'constructor', 1),
        read('value', 'new Box(', body!.id),
        call('obj.method(check())', 'method', body!.id, 'member', 1),
        read('obj', 'new Box(value), ', body!.id),
        call('check()', 'check', body!.id, 'free', 0),
        call('first(value)', 'first', thenBlock!.id, 'free', 1),
        read('value', 'first(', thenBlock!.id),
        read('value', '    if ((', thenBlock!.id),
        call('new Wrap(value)', 'Wrap', nestedThen!.id, 'constructor', 1),
        read('value', 'new Wrap(', nestedThen!.id),
        call('fallback(value)', 'fallback', nestedElse!.id, 'free', 1),
        read('value', 'fallback(', nestedElse!.id),
        call('second(value)', 'second', elseBlock!.id, 'free', 1),
        read('value', 'second(', elseBlock!.id),
        call('after(repeated)', 'after', body!.id, 'free', 1),
        read('repeated', 'after(', body!.id),
      ]);
      expect(result.exports).toEqual(new Map([['owner', result.localDefs[0]!.nodeId]]));
      parser.parse('function replacement() { if (false) {} }');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'keeps unbraced branches in their real enclosing scopes in %s',
    async (filePath) => {
      const source = [
        'function owner(value) {',
        '  before();',
        '  if (first(value)) return returned(value); else throw failed(value);',
        '  if (second()) call(); else ;',
        '  if (third()) var value, repeated = init(); else var repeated = fallback();',
        '  if (outer()) if (inner()) left(); else right(); else { braced(); }',
        '  if (next()) { block(); } else if (last()) tail(); else final();',
        '  after(repeated);',
        '}',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const result = extract(captures, filePath, hooks);
      const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
      const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
      const [body, outerElse, nextThen] = blocks;
      expect(blocks).toHaveLength(3);
      expect(blocks.map((scope) => scope.range)).toEqual(
        root.descendantsOfType('statement_block').map((node) => ({
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column,
        })),
      );
      expect(blocks.map((scope) => scope.parent)).toEqual([owner.id, body!.id, body!.id]);
      expect(blocks.map((scope) => [...scope.bindings])).toEqual([[], [], []]);
      expect(body!.ownedDefs.map((def) => def.qualifiedName)).toEqual([
        'value',
        'repeated',
        'repeated',
      ]);
      expect([...owner.bindings.keys()]).toEqual(['value', 'repeated']);
      expect(owner.bindings.get('value')![0]!.def).toBe(
        owner.ownedDefs.find((def) => def.qualifiedName === 'value'),
      );
      expect(owner.bindings.get('repeated')![0]!.def).toBe(body!.ownedDefs[1]);
      expect(
        result.referenceSites.map(({ name, kind, inScope }) => ({ name, kind, inScope })),
      ).toEqual(
        [
          ['before', 'call'],
          ['first', 'call'],
          ['value', 'read'],
          ['returned', 'call'],
          ['value', 'read'],
          ['failed', 'call'],
          ['value', 'read'],
          ['second', 'call'],
          ['call', 'call'],
          ['third', 'call'],
          ['init', 'call'],
          ['fallback', 'call'],
          ['outer', 'call'],
          ['inner', 'call'],
          ['left', 'call'],
          ['right', 'call'],
          ['braced', 'call'],
          ['next', 'call'],
          ['block', 'call'],
          ['last', 'call'],
          ['tail', 'call'],
          ['final', 'call'],
          ['after', 'call'],
          ['repeated', 'read'],
        ].map(([name, kind]) => ({
          name,
          kind,
          inScope: name === 'braced' ? outerElse!.id : name === 'block' ? nextThen!.id : body!.id,
        })),
      );
      const saved = JSON.stringify(captures);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'reuses try and loop branch scopes without conditional scopes in %s',
    async (filePath) => {
      const source = [
        'function owner(items) {',
        '  if (check()) try { work(); } finally { clean(); }',
        '  else for (const item of items) { use(item); }',
        '  after();',
        '}',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
      const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
      const [body, attempt, finalizer, loop, loopBody] = blocks;
      expect(blocks).toHaveLength(5);
      expect(blocks.map((scope) => scope.range)).toEqual(
        root.descendantsOfType(['statement_block', 'for_in_statement']).map((node) => ({
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column,
        })),
      );
      expect(blocks.map((scope) => scope.parent)).toEqual([
        owner.id,
        body!.id,
        body!.id,
        body!.id,
        loop!.id,
      ]);
      expect([...loop!.bindings.keys()]).toEqual(['item']);
      expect(
        result.referenceSites.map(({ name, kind, inScope }) => ({ name, kind, inScope })),
      ).toEqual([
        { name: 'check', kind: 'call', inScope: body!.id },
        { name: 'work', kind: 'call', inScope: attempt!.id },
        { name: 'clean', kind: 'call', inScope: finalizer!.id },
        { name: 'items', kind: 'read', inScope: loop!.id },
        { name: 'use', kind: 'call', inScope: loopBody!.id },
        { name: 'item', kind: 'read', inScope: loopBody!.id },
        { name: 'after', kind: 'call', inScope: body!.id },
      ]);
    },
  );

  it.each(filePaths)(
    'rejects unsupported unbraced branches and module returns atomically in %s',
    async (filePath) => {
      for (const branch of [
        'let lexical;',
        'const lexical = 1;',
        'function nested() {}',
        'class Nested {}',
        'return delete value;',
        'throw value?.[key].deep;',
        'value?.();',
        'break;',
        'continue;',
        'while (obj?.[key].deep) {}',
      ]) {
        for (const statement of [
          `if (check()) ${branch} else valid();`,
          `if (check()) valid(); else ${branch}`,
        ]) {
          for (const body of [`before(); ${statement}`, `${statement} after();`]) {
            const { root } = await parse(
              `export const retained = 1; function owner(value) { ${body} }`,
              filePath,
            );
            expect(() => emitTypeScriptCaptures(root), body).toThrow();
          }
        }
      }
      for (const statement of [
        'if (true) return value;',
        '{ if (true) return value; }',
        'try {} finally { if (true) valid(); else return value; }',
      ]) {
        const { root } = await parse(`before(); ${statement} after();`, filePath);
        expect(() => emitTypeScriptCaptures(root), statement).toThrow();
      }
    },
  );

  it.each(filePaths)(
    'accepts supported direct and grouped if conditions in %s',
    async (filePath) => {
      const conditions = [
        '0',
        '1.5',
        '0xff',
        '123n',
        "'text'",
        'true',
        'false',
        'null',
        '((false))',
        'value',
        '((value))',
        'check(value)',
        '((check(value)))',
        'new Box(value)',
        '((new Box(value)))',
      ];
      for (const condition of conditions) {
        const source = `function* owner(value) { if (${condition}) { ; /* empty */ } after(); }`;
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        const [body, branch] = result.scopes.filter((scope) => scope.kind === 'Block');
        expect(branch!.parent, source).toBe(body!.id);
        expect(branch!.ownedDefs, source).toEqual([]);
        expect([...branch!.bindings], source).toEqual([]);
        expect(
          result.referenceSites.map(({ name, kind, inScope }) => ({ name, kind, inScope })),
          source,
        ).toEqual([
          ...(condition.includes('check')
            ? [{ name: 'check', kind: 'call', inScope: body!.id }]
            : []),
          ...(condition.includes('Box') ? [{ name: 'Box', kind: 'call', inScope: body!.id }] : []),
          ...(condition.includes('value')
            ? [{ name: 'value', kind: 'read', inScope: body!.id }]
            : []),
          { name: 'after', kind: 'call', inScope: body!.id },
        ]);
      }
    },
  );

  it.each(filePaths)(
    'keeps parameter and earliest var identities across if branches in %s',
    async (filePath) => {
      const source =
        'function owner(value) { if (value) { var value, repeated; let sibling; } else { var repeated, sibling; } }';
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
      const [body, thenBlock, elseBlock] = result.scopes.filter((scope) => scope.kind === 'Block');
      const parameter = owner.ownedDefs.find((def) => def.qualifiedName === 'value')!;
      expect([...owner.bindings.keys()]).toEqual(['value', 'repeated', 'sibling']);
      expect(owner.bindings.get('value')![0]!.def).toBe(parameter);
      expect(owner.bindings.get('repeated')![0]!.def).toBe(thenBlock!.ownedDefs[1]);
      expect(owner.bindings.get('sibling')![0]!.def).toBe(elseBlock!.ownedDefs[1]);
      expect([...body!.bindings]).toEqual([]);
      expect([...elseBlock!.bindings]).toEqual([]);
      expect(thenBlock!.bindings.get('sibling')![0]!.def).toBe(thenBlock!.ownedDefs[2]);
      expect(thenBlock!.ownedDefs.map((def) => def.qualifiedName)).toEqual([
        'value',
        'repeated',
        'sibling',
      ]);
      expect(elseBlock!.ownedDefs.map((def) => def.qualifiedName)).toEqual(['repeated', 'sibling']);
      expect(new Set(result.localDefs.map((def) => def.nodeId)).size).toBe(result.localDefs.length);
    },
  );

  it.each(filePaths)(
    'rejects unsupported if conditions and branch shapes atomically in %s',
    async (filePath) => {
      const statements = [
        'if (obj?.[key].deep) {}',
        'if ((delete value)) {}',
        'if (value = 1) {}',
        'if (outer(good(), bad(obj?.[key].deep))) {}',
        'if (outer(bad(obj?.[key].deep), good())) {}',
        'if (true) while (obj?.[key].deep) {}',
        'if (true) {} else while (obj?.[key].deep) {}',
        'if (true) {} else if (false) while (obj?.[key].deep) {}',
        'if (true) { let same; var same; }',
        'if (true) {} else { let same; var same; }',
        'if (true) { let x; { var x; } }',
        'if (true) {} else { let x; { var x; } }',
      ];
      for (const statement of statements) {
        for (const body of [`${statement} valid();`, `valid(); ${statement}`]) {
          const source = `export const retained = 1; before(); function owner(value) { ${body} } after();`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          expect(() => emitTypeScriptCaptures(root), source).toThrow();
        }
      }
    },
  );

  it.each(filePaths)(
    'rejects unsupported siblings in either if branch and either order in %s',
    async (filePath) => {
      for (const bad of [
        'while (obj?.[key].deep) {}',
        'obj?.[key].deep;',
        'const bad = value?.[key].deep;',
      ]) {
        for (const contents of [`valid(); ${bad}`, `${bad} valid();`]) {
          for (const statement of [
            `if (check()) { ${contents} } else { other(); }`,
            `if (check()) { other(); } else { ${contents} }`,
          ]) {
            const source = `export const retained = 1; before(); export function* owner(value) { ${statement} } after();`;
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            expect(() => emitTypeScriptCaptures(root), source).toThrow();
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'owns nested try-finally references and lexical blocks in source order in %s',
    async (filePath) => {
      for (const token of ['function', 'function*']) {
        const source = [
          `export ${token} owner(value) {`,
          '  before(value);',
          '  try {',
          '    let local = first(value); var value, repeated;',
          '    if (check(local)) { throw new Box(local); }',
          '    try { return nested(local); } finally { cleanup(local); }',
          '  } finally {',
          '    let local = last(value); var repeated;',
          '    { return obj.method(local); }',
          '  }',
          '  after(repeated);',
          '}',
        ].join('\n');
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
        const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
        const [body, attempt, branch, innerAttempt, innerFinalizer, finalizer, nested] = blocks;
        expect(blocks).toHaveLength(7);
        expect(blocks.map((scope) => scope.parent)).toEqual([
          owner.id,
          body!.id,
          attempt!.id,
          attempt!.id,
          attempt!.id,
          body!.id,
          finalizer!.id,
        ]);
        expect(blocks.map((scope) => scope.range)).toEqual(
          root.descendantsOfType('statement_block').map((node) => ({
            startLine: node.startPosition.row + 1,
            startCol: node.startPosition.column,
            endLine: node.endPosition.row + 1,
            endCol: node.endPosition.column,
          })),
        );
        expect(blocks.map((scope) => scope.ownedDefs.map((def) => def.qualifiedName))).toEqual([
          [],
          ['local', 'value', 'repeated'],
          [],
          [],
          [],
          ['local', 'repeated'],
          [],
        ]);
        expect(blocks.map((scope) => [...scope.bindings.keys()])).toEqual([
          [],
          ['local'],
          [],
          [],
          [],
          ['local'],
          [],
        ]);
        expect([...owner.bindings.keys()]).toEqual(['value', 'repeated']);
        expect(owner.bindings.get('value')![0]!.def).toBe(
          owner.ownedDefs.find((def) => def.qualifiedName === 'value'),
        );
        expect(owner.bindings.get('repeated')![0]!.def).toBe(attempt!.ownedDefs[2]);
        expect(attempt!.bindings.get('local')![0]!.def).toBe(attempt!.ownedDefs[0]);
        expect(finalizer!.bindings.get('local')![0]!.def).toBe(finalizer!.ownedDefs[0]);
        expect(attempt!.ownedDefs[0]!.nodeId).not.toBe(finalizer!.ownedDefs[0]!.nodeId);
        const reference = (name: string, kind: 'call' | 'read', inScope: string) => ({
          name,
          kind,
          inScope,
        });
        expect(
          result.referenceSites.map(({ name, kind, inScope }) => ({ name, kind, inScope })),
        ).toEqual([
          reference('before', 'call', body!.id),
          reference('value', 'read', body!.id),
          reference('first', 'call', attempt!.id),
          reference('value', 'read', attempt!.id),
          reference('check', 'call', attempt!.id),
          reference('local', 'read', attempt!.id),
          reference('Box', 'call', branch!.id),
          reference('local', 'read', branch!.id),
          reference('nested', 'call', innerAttempt!.id),
          reference('local', 'read', innerAttempt!.id),
          reference('cleanup', 'call', innerFinalizer!.id),
          reference('local', 'read', innerFinalizer!.id),
          reference('last', 'call', finalizer!.id),
          reference('value', 'read', finalizer!.id),
          reference('method', 'call', nested!.id),
          reference('obj', 'read', nested!.id),
          reference('local', 'read', nested!.id),
          reference('after', 'call', body!.id),
          reference('repeated', 'read', body!.id),
        ]);
        const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
        expect([...module.bindings.keys()]).toEqual(['owner']);
        expect(result.exports).toEqual(new Map([['owner', result.localDefs[0]!.nodeId]]));
        parser.parse('function replacement() {}');
        expect(JSON.stringify(captures)).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'accepts empty try-finally blocks and sibling lexical-var names in %s',
    async (filePath) => {
      for (const token of ['function', 'function*']) {
        for (const body of [
          'try { ; /* empty */ } finally { /* empty */ ; }',
          'try { let sibling; } finally { var sibling; }',
          'try { var sibling; } finally { let sibling; }',
        ]) {
          const { root } = await parse(`${token} owner() { ${body} }`, filePath);
          expect(root.hasError, body).toBe(false);
          const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
          const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
          const [outer, attempt, finalizer] = result.scopes.filter(
            (scope) => scope.kind === 'Block',
          );
          expect(attempt!.parent).toBe(outer!.id);
          expect(finalizer!.parent).toBe(outer!.id);
          expect(result.referenceSites).toEqual([]);
          expect([...owner.bindings.keys()]).toEqual(body.includes('sibling') ? ['sibling'] : []);
          expect([attempt!, finalizer!].map((scope) => [...scope.bindings.keys()])).toEqual([
            body.includes('try { let') ? ['sibling'] : [],
            body.includes('finally { let') ? ['sibling'] : [],
          ]);
        }
      }
    },
  );

  it.each(filePaths)(
    'owns optional catch blocks and nested references in source order in %s',
    async (filePath) => {
      for (const token of ['function', 'function*']) {
        for (const withFinally of [false, true]) {
          const source = [
            `export ${token} owner(value) {`,
            '  before(value);',
            '  try { let local = first(value); var value, repeated; }',
            '  catch {',
            '    let local = recover(value); var repeated;',
            '    try { nested(local); } catch { return fallback(local); }',
            '  }',
            ...(withFinally ? ['  finally { let local = cleanup(value); var repeated; }'] : []),
            '  after(repeated);',
            '}',
          ].join('\n');
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const captures = emitTypeScriptCaptures(root);
          const saved = JSON.stringify(captures);
          const result = extract(captures, filePath, hooks);
          const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
          const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
          const [
            body,
            attempt,
            handler,
            caught,
            innerAttempt,
            innerHandler,
            innerCaught,
            finalizer,
          ] = blocks;
          expect(blocks, source).toHaveLength(withFinally ? 8 : 7);
          expect(
            blocks.map((scope) => scope.parent),
            source,
          ).toEqual([
            owner.id,
            body!.id,
            body!.id,
            handler!.id,
            caught!.id,
            caught!.id,
            innerHandler!.id,
            ...(withFinally ? [body!.id] : []),
          ]);
          expect(
            blocks.map((scope) => scope.range),
            source,
          ).toEqual(
            root.descendantsOfType(['statement_block', 'catch_clause']).map((node) => ({
              startLine: node.startPosition.row + 1,
              startCol: node.startPosition.column,
              endLine: node.endPosition.row + 1,
              endCol: node.endPosition.column,
            })),
          );
          expect(
            blocks.map((scope) => scope.ownedDefs.map((def) => def.qualifiedName)),
            source,
          ).toEqual([
            [],
            ['local', 'value', 'repeated'],
            [],
            ['local', 'repeated'],
            [],
            [],
            [],
            ...(withFinally ? [['local', 'repeated']] : []),
          ]);
          expect(
            blocks.map((scope) => [...scope.bindings.keys()]),
            source,
          ).toEqual([
            [],
            ['local'],
            [],
            ['local'],
            [],
            [],
            [],
            ...(withFinally ? [['local']] : []),
          ]);
          expect([...owner.bindings.keys()], source).toEqual(['value', 'repeated']);
          expect(owner.bindings.get('value')![0]!.def, source).toBe(
            owner.ownedDefs.find((def) => def.qualifiedName === 'value'),
          );
          expect(owner.bindings.get('repeated')![0]!.def, source).toBe(attempt!.ownedDefs[2]);
          const lexicalBlocks = [attempt!, caught!, ...(withFinally ? [finalizer!] : [])];
          expect(
            new Set(lexicalBlocks.map((scope) => scope.bindings.get('local')![0]!.def.nodeId)).size,
            source,
          ).toBe(lexicalBlocks.length);
          const pair = (name: string, argument: string, inScope: string) => [
            { name, kind: 'call', inScope },
            { name: argument, kind: 'read', inScope },
          ];
          expect(
            result.referenceSites.map(({ name, kind, inScope }) => ({ name, kind, inScope })),
            source,
          ).toEqual([
            ...pair('before', 'value', body!.id),
            ...pair('first', 'value', attempt!.id),
            ...pair('recover', 'value', caught!.id),
            ...pair('nested', 'local', innerAttempt!.id),
            ...pair('fallback', 'local', innerCaught!.id),
            ...(withFinally ? pair('cleanup', 'value', finalizer!.id) : []),
            ...pair('after', 'repeated', body!.id),
          ]);
          expect(
            result.localDefs.filter((def) => def.type === 'Variable'),
            source,
          ).toHaveLength(withFinally ? 8 : 6);
          expect(result.exports, source).toEqual(new Map([['owner', result.localDefs[0]!.nodeId]]));
          parser.parse('function replacement() {}');
          expect(JSON.stringify(captures), source).toBe(saved);
          expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
        }
      }
    },
  );

  it.each(filePaths)(
    'accepts empty optional catches and isolates sibling lexical-var bindings in %s',
    async (filePath) => {
      for (const token of ['function', 'function*']) {
        for (const statement of [
          'try { ; } catch { /* empty */ ; }',
          'try { ; } catch { ; } finally { ; }',
          'try { let sibling; } catch { var sibling; }',
          'try { var sibling; } catch { let sibling; }',
          'try {} catch { let sibling; } finally { var sibling; }',
        ]) {
          const { root } = await parse(`${token} owner() { ${statement} }`, filePath);
          expect(root.hasError, statement).toBe(false);
          const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
          const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
          const [body, attempt, handler, caught, finalizer] = result.scopes.filter(
            (scope) => scope.kind === 'Block',
          );
          expect([attempt!.parent, handler!.parent, caught!.parent], statement).toEqual([
            body!.id,
            body!.id,
            handler!.id,
          ]);
          expect(handler!.ownedDefs, statement).toEqual([]);
          expect([...handler!.bindings], statement).toEqual([]);
          expect(
            [attempt!, caught!, ...(finalizer ? [finalizer] : [])].map((scope) => [
              ...scope.bindings.keys(),
            ]),
            statement,
          ).toEqual([
            statement.includes('try { let') ? ['sibling'] : [],
            statement.includes('catch { let') ? ['sibling'] : [],
            ...(finalizer ? [[]] : []),
          ]);
          if (finalizer) expect(finalizer.parent, statement).toBe(body!.id);
          expect([...owner.bindings.keys()], statement).toEqual(
            statement.includes('sibling') ? ['sibling'] : [],
          );
          expect(result.referenceSites, statement).toEqual([]);
        }
      }
    },
  );

  it.each(filePaths)(
    'owns named catch parameters and resolves nested and sibling shadowing in %s',
    async (filePath) => {
      for (const token of ['function', 'function*']) {
        for (const outer of ['parameter', 'module']) {
          const source = [
            'const error = 1;',
            `export ${token} owner(${outer === 'parameter' ? 'error' : 'value'}) {`,
            '  before(error);',
            '  try {} catch (/* parameter */ error) {',
            '    recover(error);',
            '    { let error; shadow(error); }',
            '    try {} catch (error) { nested(error); }',
            '    resume(error);',
            '  } finally { cleanup(error); }',
            '  try {} catch (error) { sibling(error); }',
            '  after(error);',
            '}',
          ].join('\n');
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const captures = emitTypeScriptCaptures(root);
          const saved = JSON.stringify(captures);
          const result = extract(captures, filePath, hooks);
          const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
          const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
          const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
          const [
            body,
            attempt,
            handler,
            caught,
            shadow,
            innerAttempt,
            innerHandler,
            innerCaught,
            finalizer,
            siblingAttempt,
            siblingHandler,
            siblingCaught,
          ] = blocks;
          expect(blocks, source).toHaveLength(12);
          expect(
            blocks.map((scope) => scope.parent),
            source,
          ).toEqual([
            owner.id,
            body!.id,
            body!.id,
            handler!.id,
            caught!.id,
            caught!.id,
            caught!.id,
            innerHandler!.id,
            body!.id,
            body!.id,
            body!.id,
            siblingHandler!.id,
          ]);
          const rangeOf = (node: typeof root) => ({
            startLine: node.startPosition.row + 1,
            startCol: node.startPosition.column,
            endLine: node.endPosition.row + 1,
            endCol: node.endPosition.column,
          });
          expect(
            blocks.map((scope) => scope.range),
            source,
          ).toEqual(root.descendantsOfType(['statement_block', 'catch_clause']).map(rangeOf));
          const handlers = [handler!, innerHandler!, siblingHandler!];
          const expected = root.descendantsOfType('catch_clause').map((clause) => {
            const name = clause.childForFieldName('parameter')!;
            return {
              nodeId: `def:${filePath}#${name.startPosition.row + 1}:${name.startPosition.column}:Variable:${name.text}`,
              filePath,
              type: 'Variable',
              qualifiedName: 'error',
            };
          });
          for (const [index, scope] of handlers.entries()) {
            const def = expected[index]!;
            expect(scope.ownedDefs, source).toEqual([def]);
            expect([...scope.bindings], source).toEqual([
              [
                'error',
                [
                  {
                    def,
                    origin: 'local',
                    namespace: ['Class', 'Enum'].includes(def.type) ? 'both' : 'value',
                  },
                ],
              ],
            ]);
            for (const other of result.scopes.filter((candidate) => candidate.id !== scope.id)) {
              expect(other.ownedDefs, source).not.toContainEqual(def);
              expect(other.bindings.get('error') ?? [], source).not.toContainEqual({
                def,
                origin: 'local',
                namespace: ['Class', 'Enum'].includes(def.type) ? 'both' : 'value',
              });
            }
          }
          expect(new Set(expected.map((def) => def.nodeId)).size, source).toBe(3);
          expect(
            [
              attempt!,
              caught!,
              innerAttempt!,
              innerCaught!,
              finalizer!,
              siblingAttempt!,
              siblingCaught!,
            ].map((scope) => [...scope.bindings]),
            source,
          ).toEqual([[], [], [], [], [], [], []]);
          expect(
            shadow!.ownedDefs.map((def) => def.qualifiedName),
            source,
          ).toEqual(['error']);
          expect([...owner.bindings.keys()], source).toEqual([
            outer === 'parameter' ? 'error' : 'value',
          ]);
          expect([...module.bindings.keys()], source).toEqual(['error', 'owner']);
          const outside = (outer === 'parameter' ? owner : module).bindings.get('error')![0]!.def;
          const registry = buildFieldRegistry(
            buildScopeRegistryContext(finalizeScopeModel([result])),
          );
          const reads = result.referenceSites.filter((site) => site.kind === 'read');
          expect(
            reads.map(({ name, inScope }) => ({ name, inScope })),
            source,
          ).toEqual(
            [body!, caught!, shadow!, innerCaught!, caught!, finalizer!, siblingCaught!, body!].map(
              (scope) => ({ name: 'error', inScope: scope.id }),
            ),
          );
          expect(
            reads.map((site) =>
              registry.lookup(site.name, site.inScope).map(({ def }) => def.nodeId),
            ),
            source,
          ).toEqual(
            [
              outside,
              expected[0]!,
              shadow!.ownedDefs[0]!,
              expected[1]!,
              expected[0]!,
              outside,
              expected[2]!,
              outside,
            ].map((def) => [def.nodeId]),
          );
          expect(result.exports, source).toEqual(new Map([['owner', owner.ownedDefs[0]!.nodeId]]));
          parser.parse('function replacement() {}');
          expect(JSON.stringify(captures), source).toBe(saved);
          expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
        }
      }
    },
  );

  it.each(filePaths)(
    'rejects named catch collisions and unsupported bodies atomically in %s',
    async (filePath) => {
      for (const token of ['function', 'function*']) {
        for (const statement of [
          'try {} catch (error) { let error; }',
          'try {} catch (error) { const error = 1; }',
          'try {} catch (error) { var error; }',
          'try {} catch (error) { { var error; } }',
          'try {} catch (error) { try { var error; } finally {} }',
          'try {} catch (error) { try {} catch { var error; } }',
          'try {} catch (error) { try {} finally { var error; } }',
          'try {} catch (error) { while (obj?.[key].deep) {} }',
          'try {} catch (error) { obj?.[key].deep; }',
          'try {} catch (error) { recover(error); } finally { while (obj?.[key].deep) {} }',
        ]) {
          for (const body of [`valid(); ${statement}`, `${statement} valid();`]) {
            const source = `export const retained = 1; before(); ${token} owner(error) { ${body} } after();`;
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            expect(() => emitTypeScriptCaptures(root), source).toThrow();
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'rejects unsupported optional catch contents and binding collisions atomically in %s',
    async (filePath) => {
      for (const token of ['function', 'function*']) {
        for (const bad of [
          'while (obj?.[key].deep) {}',
          'obj?.[key].deep;',
          'const bad = obj?.[key].deep;',
          'let same; let same;',
          'let same; var same;',
          'try {} catch ({ error }) {}',
        ]) {
          for (const contents of [`valid(); ${bad}`, `${bad} valid();`]) {
            for (const statement of [
              `try { ${contents} } catch { recover(); }`,
              `try { valid(); } catch { ${contents} }`,
              `try { valid(); } catch { recover(); } finally { ${contents} }`,
            ]) {
              const source = `export const retained = 1; before(); ${token} owner() { ${statement} } after();`;
              const { root } = await parse(source, filePath);
              expect(root.hasError, source).toBe(false);
              expect(() => emitTypeScriptCaptures(root), source).toThrow();
            }
          }
        }
        for (const statement of [
          'let same; try {} catch { var same; }',
          'try {} catch { var same; } let same;',
          'try {} catch { let same; { var same; } }',
        ]) {
          const { root } = await parse(`${token} owner() { ${statement} }`, filePath);
          expect(root.hasError, statement).toBe(false);
          expect(() => emitTypeScriptCaptures(root), statement).toThrow();
        }
      }
    },
  );

  it.each(filePaths)(
    'owns module try scopes, catch shadowing and source-ordered references in %s',
    async (filePath) => {
      for (const named of [false, true]) {
        const source = [
          "import Imported from './module';",
          'export const error = 1;',
          'before(error);',
          'try { let local = first(error); var repeated; }',
          `catch ${named ? '(/* binding */ error) ' : ''}{`,
          '  recover(error);',
          '  { let error; shadow(error); }',
          '  try { nested(error); } catch (error) { inner(error); }',
          '  resume(error);',
          '} finally { cleanup(error); var repeated; }',
          'after(repeated); Imported();',
          'export { repeated as exposed };',
        ].join('\n');
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
        const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
        const [
          attempt,
          handler,
          caught,
          shadow,
          innerAttempt,
          innerHandler,
          innerCaught,
          finalizer,
        ] = blocks;
        expect(blocks, source).toHaveLength(8);
        expect(
          result.scopes.some((scope) => scope.kind === 'Function'),
          source,
        ).toBe(false);
        expect(
          blocks.map((scope) => scope.parent),
          source,
        ).toEqual([
          module.id,
          module.id,
          handler!.id,
          caught!.id,
          caught!.id,
          caught!.id,
          innerHandler!.id,
          module.id,
        ]);
        expect(
          blocks.map((scope) => scope.range),
          source,
        ).toEqual(
          root.descendantsOfType(['statement_block', 'catch_clause']).map((node) => ({
            startLine: node.startPosition.row + 1,
            startCol: node.startPosition.column,
            endLine: node.endPosition.row + 1,
            endCol: node.endPosition.column,
          })),
        );
        expect(
          blocks.map((scope) => scope.ownedDefs.map((def) => def.qualifiedName).sort()),
          source,
        ).toEqual([
          ['local', 'repeated'],
          named ? ['error'] : [],
          [],
          ['error'],
          [],
          ['error'],
          [],
          ['repeated'],
        ]);
        expect(
          blocks.map((scope) => [...scope.bindings.keys()]),
          source,
        ).toEqual([['local'], named ? ['error'] : [], [], ['error'], [], ['error'], [], []]);
        expect([...module.bindings.keys()], source).toEqual(['error', 'repeated']);
        const repeated = attempt!.ownedDefs.find((def) => def.qualifiedName === 'repeated')!;
        expect(module.bindings.get('repeated')![0]!.def, source).toBe(repeated);
        const pair = (name: string, argument: string, inScope: string) => [
          { name, kind: 'call', inScope },
          { name: argument, kind: 'read', inScope },
        ];
        expect(
          result.referenceSites.map(({ name, kind, inScope }) => ({ name, kind, inScope })),
          source,
        ).toEqual([
          ...pair('before', 'error', module.id),
          ...pair('first', 'error', attempt!.id),
          ...pair('recover', 'error', caught!.id),
          ...pair('shadow', 'error', shadow!.id),
          ...pair('nested', 'error', innerAttempt!.id),
          ...pair('inner', 'error', innerCaught!.id),
          ...pair('resume', 'error', caught!.id),
          ...pair('cleanup', 'error', finalizer!.id),
          ...pair('after', 'repeated', module.id),
          { name: 'Imported', kind: 'call', inScope: module.id },
        ]);
        const outer = module.bindings.get('error')![0]!.def;
        const caughtError = named ? handler!.ownedDefs[0]! : outer;
        const registry = buildFieldRegistry(
          buildScopeRegistryContext(finalizeScopeModel([result])),
        );
        expect(
          result.referenceSites
            .filter((site) => site.kind === 'read')
            .map((site) => registry.lookup(site.name, site.inScope).map(({ def }) => def.nodeId)),
          source,
        ).toEqual(
          [
            outer,
            outer,
            caughtError,
            shadow!.ownedDefs[0]!,
            caughtError,
            innerHandler!.ownedDefs[0]!,
            caughtError,
            outer,
            repeated,
          ].map((def) => [def.nodeId]),
        );
        expect(result.parsedImports, source).toEqual([
          {
            kind: 'alias',
            localName: 'Imported',
            importedName: 'default',
            alias: 'Imported',
            targetRaw: './module',
          },
        ]);
        expect(result.exports, source).toEqual(
          new Map([
            ['error', outer.nodeId],
            ['exposed', repeated.nodeId],
          ]),
        );
        expect(
          captures.filter((match) => match['@declaration.variable']),
          source,
        ).toHaveLength(result.localDefs.length);
        parser.parse('function replacement() {}');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'shares one canonical module var batch across top-level, sibling and nested tries in %s',
    async (filePath) => {
      const parts = [
        'var repeated;',
        'try { var repeated; try { var repeated; } finally { var repeated; } } finally { var repeated; }',
        'try {} catch { var repeated; } finally { var repeated; }',
      ];
      for (const statements of [parts, [...parts].reverse()]) {
        const source = `${statements.join('\n')}\nafter(repeated); export { repeated };`;
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const result = extract(captures, filePath, hooks);
        const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
        const declarations = root.descendantsOfType('variable_declarator');
        const expected = declarations.map((declaration) => {
          const name = declaration.childForFieldName('name')!;
          return {
            nodeId: `def:${filePath}#${name.startPosition.row + 1}:${name.startPosition.column}:Variable:repeated`,
            filePath,
            type: 'Variable',
            qualifiedName: 'repeated',
          };
        });
        expect(result.localDefs, source).toHaveLength(7);
        expect(new Set(result.localDefs.map((def) => def.nodeId)).size, source).toBe(7);
        expect(new Set(result.localDefs.map((def) => def.nodeId)), source).toEqual(
          new Set(expected.map((def) => def.nodeId)),
        );
        expect(
          captures.filter((match) => match['@declaration.variable']),
          source,
        ).toHaveLength(7);
        expect([...module.bindings], source).toEqual([
          ['repeated', [{ def: expected[0]!, origin: 'local', namespace: 'value' }]],
        ]);
        const canonical = result.localDefs.find((def) => def.nodeId === expected[0]!.nodeId)!;
        expect(module.bindings.get('repeated')![0]!.def, source).toBe(canonical);
        expect(
          result.scopes.flatMap((scope) => scope.ownedDefs).filter((def) => def === canonical),
          source,
        ).toHaveLength(1);
        expect(
          result.scopes
            .filter((scope) => scope.kind === 'Block')
            .every((scope) => scope.bindings.size === 0),
          source,
        ).toBe(true);
        const registry = buildFieldRegistry(
          buildScopeRegistryContext(finalizeScopeModel([result])),
        );
        const read = result.referenceSites.find((site) => site.kind === 'read')!;
        expect(
          registry.lookup(read.name, read.inScope).map(({ def }) => def.nodeId),
          source,
        ).toEqual([canonical.nodeId]);
        expect(result.exports, source).toEqual(new Map([['repeated', canonical.nodeId]]));
      }
      const { root } = await parse('try { var exposed; } finally {} export { exposed };', filePath);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      expect(result.exports).toEqual(new Map([['exposed', result.localDefs[0]!.nodeId]]));
    },
  );

  it.each(filePaths)(
    'allows import names to be shadowed by module try lexicals and catch parameters in %s',
    async (filePath) => {
      for (const importedFirst of [false, true]) {
        const imported = "import Imported from './module';";
        const statement =
          'try { let Imported; use(Imported); } catch (Imported) { recover(Imported); } finally { let Imported; cleanup(Imported); }';
        const source = `${importedFirst ? imported : ''} ${statement} ${importedFirst ? '' : imported}`;
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        expect(result.parsedImports, source).toHaveLength(1);
        const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
        expect([...module.bindings], source).toEqual([]);
        const registry = buildFieldRegistry(
          buildScopeRegistryContext(finalizeScopeModel([result])),
        );
        const definitions = result.scopes
          .filter((scope) => scope.kind === 'Block')
          .flatMap((scope) => scope.ownedDefs);
        expect(definitions, source).toHaveLength(3);
        expect(
          result.referenceSites
            .filter((site) => site.kind === 'read')
            .map((site) => registry.lookup(site.name, site.inScope).map(({ def }) => def.nodeId)),
          source,
        ).toEqual(definitions.map((def) => [def.nodeId]));
      }
    },
  );

  it.each(filePaths)(
    'rejects module try returns, collisions and unsupported contents atomically in %s',
    async (filePath) => {
      const statements = [
        'try { return; } finally {}',
        'try {} catch { return value; }',
        'try {} catch (error) { if (true) { return error; } }',
        'try {} finally { if (true) { return call(); } }',
        'try { if (true) { try {} finally { return; } } } finally {}',
        'try {} catch (error) { let error; }',
        'try {} catch (error) { const error = 1; }',
        'try {} catch (error) { var error; }',
        'try {} catch (error) { { var error; } }',
        'try {} catch (error) { try {} finally { var error; } }',
        'try {} catch (error) { try {} catch { var error; } }',
        'try {} catch ({ error }) {}',
        'try {} catch ([error]) {}',
        String.raw`try {} catch (\u0065rror) {}`,
        ...(/\.tsx?$/.test(filePath) ? ['try {} catch (error: unknown) {}'] : []),
        ...[
          'while (obj?.[key].deep) {}',
          'obj?.[key].deep;',
          'const bad = obj?.[key].deep;',
          'let same; let same;',
          'let same; var same;',
        ].flatMap((bad) => [
          `try { ${bad} } finally { cleanup(); }`,
          `try { valid(); } catch { ${bad} }`,
          `try { valid(); } catch (error) { ${bad} }`,
          `try { valid(); } finally { ${bad} }`,
        ]),
      ];
      for (const declaration of [
        "import same from './module';",
        'let same;',
        'const same = 1;',
        'function same() {}',
        'class same {}',
      ]) {
        for (const nested of [
          'try { var same; } finally {}',
          'try {} catch { var same; }',
          'try {} catch (error) { var same; }',
          'try {} finally { var same; }',
          'try { try {} catch { var same; } } finally {}',
        ]) {
          statements.push(`${declaration} ${nested}`, `${nested} ${declaration}`);
        }
      }
      for (const statement of statements) {
        for (const source of [
          `export const retained = 1; before(); ${statement} after();`,
          `${statement} export const retained = 1; after();`,
        ]) {
          const { root } = await parse(source, filePath);
          // Tree-sitter can accept module-level returns and semantic collisions.
          // Rejection must therefore come from the composed capture boundary too.
          expect(() => emitTypeScriptCaptures(root), source).toThrow();
        }
      }
    },
  );

  it.each(filePaths)(
    'isolates module sibling and nested block lexicals in %s',
    async (filePath) => {
      const source = [
        'let value;',
        '{ let value; first(value); { const value = 1; nested(value); } resume(value); }',
        '{ const value = 2; sibling(value); }',
        'after(value);',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError, source).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
      expect(
        blocks.map((scope) => scope.parent),
        source,
      ).toEqual([module.id, blocks[0]!.id, module.id]);
      expect(
        blocks.map((scope) => scope.range),
        source,
      ).toEqual(
        root.descendantsOfType('statement_block').map((node) => ({
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column,
        })),
      );
      expect(
        result.scopes.some((scope) => scope.kind === 'Function'),
        source,
      ).toBe(false);
      expect(result.localDefs, source).toHaveLength(4);
      expect([...module.bindings.keys()], source).toEqual(['value']);
      expect(
        blocks.map((scope) => [...scope.bindings.keys()]),
        source,
      ).toEqual([['value'], ['value'], ['value']]);
      const registry = buildFieldRegistry(buildScopeRegistryContext(finalizeScopeModel([result])));
      const reads = result.referenceSites.filter((site) => site.kind === 'read');
      expect(
        reads.map((site) => site.inScope),
        source,
      ).toEqual([blocks[0]!.id, blocks[1]!.id, blocks[0]!.id, blocks[2]!.id, module.id]);
      expect(
        reads.map((site) => registry.lookup(site.name, site.inScope).map(({ def }) => def.nodeId)),
        source,
      ).toEqual(
        [
          blocks[0]!.ownedDefs[0]!,
          blocks[1]!.ownedDefs[0]!,
          blocks[0]!.ownedDefs[0]!,
          blocks[2]!.ownedDefs[0]!,
          module.ownedDefs[0]!,
        ].map((def) => [def.nodeId]),
      );
      parser.parse('function replacement() {}');
      expect(JSON.stringify(captures), source).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
    },
  );

  it.each(filePaths)(
    'allows imports to be shadowed only inside module blocks in %s',
    async (filePath) => {
      for (const importedFirst of [false, true]) {
        const imported = "import Imported from './module';";
        const statement =
          '{ let Imported; use(Imported); } { const Imported = 1; other(Imported); }';
        const source = `${importedFirst ? imported : ''} ${statement} ${importedFirst ? '' : imported} Imported();`;
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
        const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
        expect(result.parsedImports, source).toEqual([
          {
            kind: 'alias',
            localName: 'Imported',
            importedName: 'default',
            alias: 'Imported',
            targetRaw: './module',
          },
        ]);
        expect([...module.bindings], source).toEqual([]);
        expect(blocks, source).toHaveLength(2);
        const registry = buildFieldRegistry(
          buildScopeRegistryContext(finalizeScopeModel([result])),
        );
        expect(
          result.referenceSites
            .filter((site) => site.kind === 'read')
            .map((site) => registry.lookup(site.name, site.inScope).map(({ def }) => def.nodeId)),
          source,
        ).toEqual(blocks.map((scope) => [scope.ownedDefs[0]!.nodeId]));
        expect(result.referenceSites.at(-1), source).toMatchObject({
          name: 'Imported',
          kind: 'call',
          inScope: module.id,
        });
      }
    },
  );

  it.each(filePaths)(
    'coalesces module vars across direct declarations, blocks and tries in %s',
    async (filePath) => {
      const parts = [
        'var repeated;',
        '{ var repeated; { var repeated; } }',
        'try { var repeated; } finally { var repeated; }',
      ];
      for (const statements of [parts, [...parts].reverse()]) {
        const source = `${statements.join('\n')} after(repeated); export { repeated };`;
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const result = extract(captures, filePath, hooks);
        const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
        const first = root.descendantsOfType('variable_declarator')[0]!.childForFieldName('name')!;
        const canonicalId = `def:${filePath}#${first.startPosition.row + 1}:${first.startPosition.column}:Variable:repeated`;
        const canonical = result.localDefs.find((def) => def.nodeId === canonicalId)!;
        expect(result.localDefs, source).toHaveLength(5);
        expect(new Set(result.localDefs.map((def) => def.nodeId)).size, source).toBe(5);
        expect(
          captures.filter((match) => match['@declaration.variable']),
          source,
        ).toHaveLength(5);
        expect([...module.bindings], source).toEqual([
          ['repeated', [{ def: canonical, origin: 'local', namespace: 'value' }]],
        ]);
        expect(module.bindings.get('repeated')![0]!.def, source).toBe(canonical);
        expect(
          result.scopes.flatMap((scope) => scope.ownedDefs).filter((def) => def === canonical),
          source,
        ).toHaveLength(1);
        expect(
          result.scopes
            .filter((scope) => scope.kind === 'Block')
            .every((scope) => scope.bindings.size === 0),
          source,
        ).toBe(true);
        const registry = buildFieldRegistry(
          buildScopeRegistryContext(finalizeScopeModel([result])),
        );
        const read = result.referenceSites.find((site) => site.kind === 'read')!;
        expect(
          registry.lookup(read.name, read.inScope).map(({ def }) => def.nodeId),
          source,
        ).toEqual([canonicalId]);
        expect(result.exports, source).toEqual(new Map([['repeated', canonicalId]]));
      }
    },
  );

  it.each(filePaths)(
    'rejects module block returns, collisions and unsupported contents atomically in %s',
    async (filePath) => {
      const statements = [
        '{ return; }',
        '{ { return value; } }',
        '{ if (true) { return call(); } }',
        '{ try {} finally { return; } }',
        '{ try {} catch { return value; } }',
        ...[
          'while (obj?.[key].deep) {}',
          'obj?.[key].deep;',
          'const bad = obj?.[key].deep;',
          'let same; let same;',
          'let same; var same;',
          'let same; { var same; }',
          'function nested() {}',
          'class Nested {}',
        ].flatMap((bad) => [`{ valid(); ${bad} }`, `{ ${bad} valid(); }`]),
      ];
      for (const declaration of ["import same from './module';", 'let same;', 'const same = 1;']) {
        for (const block of [
          '{ var same; }',
          '{ { var same; } }',
          '{ try {} finally { var same; } }',
        ]) {
          statements.push(`${declaration} ${block}`, `${block} ${declaration}`);
        }
      }
      for (const statement of statements) {
        for (const source of [
          `export const retained = 1; before(); ${statement} after();`,
          `${statement} export const retained = 1; after();`,
        ]) {
          const { root } = await parse(source, filePath);
          expect(() => emitTypeScriptCaptures(root), source).toThrow();
        }
      }
    },
  );

  it.each(filePaths)(
    'rejects unsupported catch bindings and malformed try shapes atomically in %s',
    async (filePath) => {
      const statements = [
        'try {} catch ({ message }) {}',
        'try {} catch ([error]) {}',
        'try {} catch ({ error }) {} finally {}',
        String.raw`try {} catch (\u0065rror) {}`,
        'try {}',
        'try {} finally',
        'try valid(); finally {}',
        'try {} finally valid();',
        'try { valid(); } finally {',
        'try {} catch',
        'try {} catch valid();',
        'try {} catch {',
        'try {} catch {} finally',
        ...(/\.tsx?$/.test(filePath) ? ['try {} catch (error: unknown) {}'] : []),
      ];
      const supported = 'export const retained = 1; before();';
      for (const token of ['function', 'function*']) {
        for (const statement of statements) {
          for (const body of [`${statement} valid();`, `valid(); ${statement}`]) {
            const { root } = await parse(
              `${supported} ${token} owner() { ${body} } after();`,
              filePath,
            );
            expect(() => emitTypeScriptCaptures(root), body).toThrow();
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'rejects unsupported try-finally contents and binding collisions atomically in %s',
    async (filePath) => {
      for (const token of ['function', 'function*']) {
        for (const bad of [
          'while (obj?.[key].deep) {}',
          'obj?.[key].deep;',
          'const bad = obj?.[key].deep;',
          'let same; let same;',
          'let same; var same;',
          'let same; { var same; }',
          'try {} catch ({ error }) {} finally {}',
        ]) {
          for (const contents of [`valid(); ${bad}`, `${bad} valid();`]) {
            for (const statement of [
              `try { ${contents} } finally { cleanup(); }`,
              `try { valid(); } finally { ${contents} }`,
            ]) {
              const source = `export const retained = 1; before(); ${token} owner() { ${statement} } after();`;
              const { root } = await parse(source, filePath);
              expect(root.hasError, source).toBe(false);
              expect(() => emitTypeScriptCaptures(root), source).toThrow();
            }
          }
        }
        for (const body of [
          'let same; try { var same; } finally {}',
          'let same; try {} finally { var same; }',
          'try { var same; } finally {} let same;',
          'try {} finally { var same; } let same;',
        ]) {
          const { root } = await parse(`${token} owner() { ${body} }`, filePath);
          expect(root.hasError, body).toBe(false);
          expect(() => emitTypeScriptCaptures(root), body).toThrow();
        }
      }
    },
  );

  it.each(filePaths)(
    'detaches deeply nested captures before parser reuse in %s',
    async (filePath) => {
      const depth = 128;
      const { parser, root } = await parse(
        `export function owner(value) { ${'{'.repeat(depth)} let lexical = outer(inner()); var value, repeated; ${'}'.repeat(depth)} var repeated; }`,
        filePath,
      );
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const baseline = extract(captures, filePath, hooks);
      const independent = emitTypeScriptCaptures(root);
      parser.parse('function replacement() { { let other = 1; } }');
      expect(JSON.stringify(captures)).toBe(saved);
      const detached = extract(JSON.parse(saved), filePath, hooks);
      expect(detached).toEqual(baseline);
      const owner = detached.scopes.find((scope) => scope.kind === 'Function')!;
      const blocks = detached.scopes.filter((scope) => scope.kind === 'Block');
      expect(blocks).toHaveLength(depth + 1);
      expect(blocks[0]!.parent).toBe(owner.id);
      for (let index = 1; index < blocks.length; index++) {
        expect(blocks[index]!.parent).toBe(blocks[index - 1]!.id);
      }
      const deepest = blocks[blocks.length - 1]!;
      expect([...deepest.bindings.keys()]).toEqual(['lexical']);
      expect(owner.bindings.get('value')![0]!.def).toBe(
        owner.ownedDefs.find((def) => def.qualifiedName === 'value'),
      );
      expect(owner.bindings.get('repeated')![0]!.def).toBe(deepest.ownedDefs[2]);
      expect(detached.referenceSites.map(({ name, inScope }) => ({ name, inScope }))).toEqual(
        ['outer', 'inner'].map((name) => ({ name, inScope: deepest.id })),
      );
      expect(independent).toEqual(captures);
      Object.values(captures[0]!)[0]!.range.startLine = 999;
      expect(JSON.stringify(independent)).toBe(saved);
    },
  );

  it.each(filePaths)(
    'detaches body declaration captures before parser reuse in %s',
    async (filePath) => {
      const { parser, root } = await parse(
        'export function owner(value) { const lexical = outer(inner(1), new Box); let pending; var value, repeated = next(), repeated; }',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const baseline = extract(captures, filePath, hooks);
      const independent = emitTypeScriptCaptures(root);
      expect(independent).toEqual(captures);
      parser.parse('export function replacement() { const other = 1; }');
      expect(JSON.stringify(captures)).toBe(saved);
      const detached = extract(JSON.parse(saved), filePath, hooks);
      expect(detached).toEqual(baseline);
      const owner = detached.scopes.find((scope) => scope.kind === 'Function')!;
      const body = detached.scopes.find((scope) => scope.kind === 'Block')!;
      expect(body.ownedDefs.map((def) => def.qualifiedName)).toEqual([
        'lexical',
        'pending',
        'value',
        'repeated',
        'repeated',
      ]);
      expect(owner.bindings.get('value')![0]!.def).toBe(
        owner.ownedDefs.find((def) => def.qualifiedName === 'value'),
      );
      expect(owner.bindings.get('repeated')![0]!.def).toBe(body.ownedDefs[3]);
      expect(detached.referenceSites.map((site) => site.inScope)).toEqual(Array(4).fill(body.id));
      Object.values(captures[0]!)[0]!.range.startLine = 999;
      expect(JSON.stringify(independent)).toBe(saved);
    },
  );

  it.each(filePaths)(
    'extracts literal lexical and var bindings and exports in %s',
    async (filePath) => {
      const declarations = [
        ['const integer = 1;', ['integer']],
        ['let decimal = 1.5, exponent = 2e3;', ['decimal', 'exponent']],
        ['const hex = 0xff, binary = 0b10, octal = 0o7;', ['hex', 'binary', 'octal']],
        ['const separated = 1_000, bigint = 123n;', ['separated', 'bigint']],
        [String.raw`const escaped = 'it\'s', unicode = "\u0061";`, ['escaped', 'unicode']],
        [
          'let /* before */ yes /* name */ = /* value */ true, no = false, empty = null;',
          ['yes', 'no', 'empty'],
        ],
        ['let pending, /* next */ later;', ['pending', 'later']],
      ] as const;
      for (const exported of [false, true]) {
        for (const [lexicalDeclaration, names] of declarations) {
          for (const declaration of [
            lexicalDeclaration,
            lexicalDeclaration.replace(/^(const|let)/, 'var'),
          ]) {
            const source = `${exported ? 'export ' : ''}${declaration}`;
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
            const expected = names.map((name) => ({
              nodeId: `def:${filePath}#1:${source.indexOf(name)}:Variable:${name}`,
              filePath,
              type: 'Variable',
              qualifiedName: name,
            }));
            expect(result.localDefs, source).toEqual(expected);
            expect(
              result.scopes.map((scope) => scope.kind),
              source,
            ).toEqual(['Module']);
            const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
            expect(module.bindings.size, source).toBe(names.length);
            for (const def of expected) {
              expect(module.bindings.get(def.qualifiedName), source).toEqual([
                {
                  def,
                  origin: 'local',
                  namespace: ['Class', 'Enum'].includes(def.type) ? 'both' : 'value',
                },
              ]);
            }
            expect(result.exports, source).toEqual(
              new Map(exported ? expected.map((def) => [def.qualifiedName, def.nodeId]) : []),
            );
            expect(result.referenceSites, source).toEqual([]);
          }
        }
      }
    },
  );

  it.each(filePaths)('resolves export aliases to lexical definitions in %s', async (filePath) => {
    const { root } = await parse('const local = 1;\nexport { local as renamed };', filePath);
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
    expect(result.exports).toEqual(new Map([['renamed', `def:${filePath}#1:6:Variable:local`]]));
    expect(result.referenceSites).toEqual([]);
  });

  it.each(filePaths)(
    'preserves repeated var definitions and exports the earliest binding in %s',
    async (filePath) => {
      const { root } = await parse(
        ['var local;', 'export var local = 1;', 'var local;', 'export { local as renamed };'].join(
          '\n',
        ),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const expected = [
        [1, 4],
        [2, 11],
        [3, 4],
      ].map(([line, column]) => ({
        nodeId: `def:${filePath}#${line}:${column}:Variable:local`,
        filePath,
        type: 'Variable',
        qualifiedName: 'local',
      }));
      expect(result.localDefs).toEqual(expected);
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      expect([...module.bindings]).toEqual([
        ['local', [{ def: expected[0], origin: 'local', namespace: 'value' }]],
      ]);
      expect(result.exports).toEqual(
        new Map([
          ['local', expected[0]!.nodeId],
          ['renamed', expected[0]!.nodeId],
        ]),
      );
      expect(result.referenceSites).toEqual([]);
    },
  );

  it.each(filePaths)(
    'rejects var collisions with other declarations and duplicate exports in %s',
    async (filePath) => {
      for (const declaration of [
        'const local = 1;',
        'let local;',
        'function local() {}',
        'function* local() {}',
        'class local {}',
      ]) {
        for (const prefix of ['', 'export ']) {
          for (const varPrefix of ['', 'export ']) {
            for (const source of [
              `${varPrefix}var local;\n${prefix}${declaration}`,
              `${prefix}${declaration}\n${varPrefix}var local;`,
            ]) {
              const { root } = await parse(source, filePath);
              expect(root.hasError, source).toBe(false);
              expect(() => emitTypeScriptCaptures(root), source).toThrow();
            }
          }
        }
      }
      for (const source of [
        'export var local;\nexport var local = 1;',
        'export var local;\nexport { local };',
        'var local;\nexport { local as renamed };\nexport { local as renamed };',
      ]) {
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        expect(() => extract(emitTypeScriptCaptures(root), filePath, hooks), source).toThrow();
      }
    },
  );

  it.each(filePaths)(
    'rejects duplicate non-var declarations before extraction in %s',
    async (filePath) => {
      const declarations = [
        'let local;',
        'const local = 1;',
        'function local() {}',
        'function* local() {}',
        'class local {}',
      ];
      // The ordered matrix covers both declaration orders and same-kind pairs.
      for (const first of declarations) {
        for (const second of declarations) {
          for (const [firstPrefix, secondPrefix] of [
            ['', ''],
            ['export ', ''],
            ['', 'export '],
          ]) {
            const source = `${firstPrefix}${first}\n${secondPrefix}${second}`;
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            expect(() => emitTypeScriptCaptures(root), source).toThrow();
          }
        }
      }
      for (const source of [
        'let local, local;',
        'const local = 1, local = 2;',
        'export let local = 1, local = 2;',
        'export const local = 1, local = 2;',
        "import { Remote as imported } from './module';\nfunction local() {}\nclass local {}",
      ]) {
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        expect(() => emitTypeScriptCaptures(root), source).toThrow();
      }
    },
  );

  it.each(filePaths)(
    'preserves same-statement var duplicates and selects the earliest binding in %s',
    async (filePath) => {
      const { root } = await parse(
        'var local = 1, local = 2;\nexport { local as renamed };',
        filePath,
      );
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const expected = [4, 15].map((column) => ({
        nodeId: `def:${filePath}#1:${column}:Variable:local`,
        filePath,
        type: 'Variable',
        qualifiedName: 'local',
      }));
      expect(result.localDefs).toEqual(expected);
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      expect([...module.bindings]).toEqual([
        ['local', [{ def: expected[0], origin: 'local', namespace: 'value' }]],
      ]);
      expect(result.exports).toEqual(new Map([['renamed', expected[0]!.nodeId]]));
    },
  );

  it.each(filePaths)(
    'rejects import collisions with top-level declarations in either order in %s',
    async (filePath) => {
      const imports = [
        "import local from './module';",
        "import local, {} from './module';",
        "import { Remote as local } from './module';",
        "import * as local from './module';",
      ];
      const declarations = [
        'const local = 1;',
        'let local;',
        'var local;',
        'function local() {}',
        'function* local() {}',
        'class local {}',
      ];
      for (const statement of imports) {
        for (const declaration of declarations) {
          for (const prefix of ['', 'export ']) {
            for (const source of [
              `${statement}\n${prefix}${declaration}`,
              `${prefix}${declaration}\n${statement}`,
            ]) {
              const { root } = await parse(source, filePath);
              expect(root.hasError, source).toBe(false);
              expect(() => emitTypeScriptCaptures(root), source).toThrow();
            }
          }
        }
      }
    },
  );

  it.each(filePaths)('rejects duplicate import local bindings in %s', async (filePath) => {
    const imports = [
      "import local from './first';",
      "import local, { /* empty */ } from './first';",
      "import { Remote as local } from './first';",
      "import * as local from './first';",
    ];
    const sources = [
      "import local, { Remote as local } from './module';",
      "import local, * as local from './module';",
      "import { First as local, Second as local } from './module';",
      "import { local, Remote as local } from './module';",
    ];
    for (const first of imports) {
      for (const second of imports) {
        sources.push(`${first}\n${second.replace('./first', './second')}`);
      }
    }
    for (const source of sources) {
      const { root } = await parse(source, filePath);
      expect(root.hasError, source).toBe(false);
      expect(() => emitTypeScriptCaptures(root), source).toThrow();
    }
  });

  it.each(filePaths)(
    'accepts distinct import local names sharing remote names in %s',
    async (filePath) => {
      const source = [
        "import { Remote as first, Remote as second } from './module';",
        "import { Remote as third } from './other';",
        'const Remote = 1;',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      expect(result.parsedImports.map((binding) => binding.localName)).toEqual([
        'first',
        'second',
        'third',
      ]);
      expect(result.localDefs.map((def) => def.qualifiedName)).toEqual(['Remote']);
    },
  );

  it.each(filePaths)(
    'rejects unsupported lexical and var declarators without partial output in %s',
    async (filePath) => {
      const unsupported = [
        'bad = NaN?.[key].deep',
        'bad = Infinity?.[key].deep',
        'bad = other?.[key].deep',
        'bad = delete value',
        'bad = tag`text`',
        'bad = tag`value ${other}`',
        'bad = /pattern/zz',
        'bad = {...value?.[key].deep}',
        'bad = [...values?.[key].deep]',
        '{ bad } = {}',
        '[[bad]] = []',
      ];
      for (const declaration of unsupported) {
        for (const kind of ['let', 'const', 'var']) {
          for (const prefix of ['', 'export ']) {
            for (const declarators of [
              declaration,
              `good = 1, ${declaration}`,
              `${declaration}, good = 1`,
            ]) {
              const source = `${prefix}${kind} ${declarators};`;
              const { root } = await parse(source, filePath);
              expect(root.hasError, source).toBe(false);
              expect(() => emitTypeScriptCaptures(root), source).toThrow();
            }
          }
        }
      }
      // The grammar accepts these declarations; the composer's semantic guard must refuse them.
      for (const prefix of ['', 'export ']) {
        for (const declarators of ['missing', 'good = 1, missing', 'missing, good = 1']) {
          const source = `${prefix}const ${declarators};`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          expect(() => emitTypeScriptCaptures(root), source).toThrow();
        }
      }
    },
  );

  it.each(filePaths)(
    'accepts comments throughout empty declarations and export clauses in %s',
    async (filePath) => {
      const { root } = await parse(
        [
          '; /* module */',
          'function /* name */ local(/* parameters */) { /* body */ }',
          'function* generator() { // body\n}',
          'class Local { /* body */ }',
          'export /* clause */ { local as renamed, generator, Local };',
        ].join('\n'),
        filePath,
      );
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      expect(result.localDefs.map((def) => def.qualifiedName)).toEqual([
        'local',
        'generator',
        'Local',
      ]);
      expect(result.exports).toEqual(
        new Map([
          ['renamed', result.localDefs[0]!.nodeId],
          ['generator', result.localDefs[1]!.nodeId],
          ['Local', result.localDefs[2]!.nodeId],
        ]),
      );
    },
  );

  it.each(filePaths)('extracts top-level literal-only call references in %s', async (filePath) => {
    const declarative =
      "import { Value } from './module';\nconst literal = 1;\nexport { literal as exposed };";
    const calls = [
      ['value()', 'value', 'free', 0],
      [
        'value(/* literals */ 1, 1.5, 2e3, 0xff, 123n, "text", true, false, null,)',
        'value',
        'free',
        9,
      ],
      ['object.method()', 'method', 'member', 0],
      [
        "object /* receiver */ . /* member */ method(/* first */ 'text', true, false, null, /* trailing */)",
        'method',
        'member',
        4,
      ],
      ['new Value', 'Value', 'constructor', 0],
      ['new /* constructor */ Value(/* empty */)', 'Value', 'constructor', 0],
      ['new Value(/* literals */ 1, "text", true, false, null,)', 'Value', 'constructor', 5],
    ] as const;
    const baselineRoot = await parse(declarative, filePath);
    const baseline = extract(emitTypeScriptCaptures(baselineRoot.root), filePath, hooks);
    const { root } = await parse(
      [declarative, ...calls.map(([expression]) => `${expression};`)].join('\n'),
      filePath,
    );
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
    expect(result.referenceSites).toEqual(
      calls.flatMap(([expression, name, callForm, arity], index) => [
        {
          name,
          atRange: {
            startLine: index + 4,
            startCol: 0,
            endLine: index + 4,
            endCol: expression.length,
          },
          inScope: result.moduleScope,
          kind: 'call' as const,
          callForm,
          arity,
          ...(callForm === 'member' ? { explicitReceiver: { name: 'object' } } : {}),
        },
        ...(callForm === 'member'
          ? [
              {
                name: 'object',
                kind: 'read' as const,
                atRange: {
                  startLine: index + 4,
                  startCol: 0,
                  endLine: index + 4,
                  endCol: 'object'.length,
                },
                inScope: result.moduleScope,
              },
            ]
          : []),
      ]),
    );
    expect(result.localDefs).toEqual(baseline.localDefs);
    expect(result.parsedImports).toEqual(baseline.parsedImports);
    expect(result.exports).toEqual(baseline.exports);
    expect(result.scopes.map((scope) => scope.kind)).toEqual(['Module']);
    expect(result.scopes[0]!.bindings).toEqual(baseline.scopes[0]!.bindings);
  });

  it.each(filePaths)(
    'visits receiver calls before arguments exactly once in %s',
    async (filePath) => {
      const source = [
        'factory(x).save(y);',
        'prisma.user.findMany();',
        "supabase.from('x').select('*');",
        'function owner(x, y, prisma, supabase) {',
        '  { let x; const result = factory(x).store(first(x)).leaf.save(y);',
        '    prisma.user.findMany(); supabase.from(x).select(y);',
        '    return factory(x).save(y);',
        '  }',
        '}',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
      const nested = blocks[1]!;
      const call = (name: string, arity: number, inScope = result.moduleScope) => ({
        name,
        kind: 'call',
        arity,
        inScope,
      });
      const read = (name: string, inScope = result.moduleScope) => ({
        name,
        kind: 'read',
        arity: undefined,
        inScope,
      });
      expect(
        result.referenceSites.map(({ name, kind, arity, inScope }) => ({
          name,
          kind,
          arity,
          inScope,
        })),
      ).toEqual([
        call('save', 1),
        call('factory', 1),
        read('x'),
        read('y'),
        call('findMany', 0),
        read('user'),
        read('prisma'),
        call('select', 1),
        call('from', 1),
        read('supabase'),
        call('save', 1, nested.id),
        read('leaf', nested.id),
        call('store', 1, nested.id),
        call('factory', 1, nested.id),
        read('x', nested.id),
        call('first', 1, nested.id),
        read('x', nested.id),
        read('y', nested.id),
        call('findMany', 0, nested.id),
        read('user', nested.id),
        read('prisma', nested.id),
        call('select', 1, nested.id),
        call('from', 1, nested.id),
        read('supabase', nested.id),
        read('x', nested.id),
        read('y', nested.id),
        call('save', 1, nested.id),
        call('factory', 1, nested.id),
        read('x', nested.id),
        read('y', nested.id),
      ]);
      expect(
        new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
          .size,
      ).toBe(result.referenceSites.length);
      expect(
        result.referenceSites
          .filter((site) => ['user', 'leaf'].includes(site.name))
          .map((site) => site.name),
      ).toEqual(['user', 'leaf', 'user']);
      const x = nested.ownedDefs.find((def) => def.qualifiedName === 'x')!;
      const fields = buildFieldRegistry(buildScopeRegistryContext(finalizeScopeModel([result])));
      expect(fields.lookup('x', nested.id)[0]!.def.nodeId).toBe(x.nodeId);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'extracts nested calls and constructors in preorder in %s',
    async (filePath) => {
      const declarative =
        "import { Value } from './module';\nconst literal = 1;\nexport { literal as exposed };";
      const { root: baselineRoot } = await parse(declarative, filePath);
      const baseline = extract(emitTypeScriptCaptures(baselineRoot), filePath, hooks);
      for (const commented of [false, true]) {
        for (const grouped of [false, true]) {
          const group = (expression: string) =>
            grouped ? `(/* group */ (${expression}))` : expression;
          const leaf = group('1');
          const inner = commented ? `inner(/* leaf */ ${leaf},)` : `inner(${leaf})`;
          const box = commented ? 'new /* name */ Box' : 'new Box';
          const member = commented
            ? `obj /* receiver */ .method(${group(box)}, ${group('true')}, /* trailing */)`
            : `obj.method(${group(box)}, ${group('true')})`;
          const last = commented ? `last(/* leaf */ ${group('null')},)` : `last(${group('null')})`;
          const wrap = commented
            ? `new Wrap(/* nested */ ${group(last)},)`
            : `new Wrap(${group(last)})`;
          const outer = commented
            ? `outer(/* first */ ${group(inner)},\n ${group(member)}, ${group(wrap)},)`
            : `outer(${group(inner)}, ${group(member)}, ${group(wrap)})`;
          const source = `${declarative}\n${group(outer)};\n${group('new Standalone')};`;
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
          const calls = [
            [outer, 'outer', 'free', 3],
            [inner, 'inner', 'free', 1],
            [member, 'method', 'member', 2],
            [box, 'Box', 'constructor', 0],
            [wrap, 'Wrap', 'constructor', 1],
            [last, 'last', 'free', 1],
            ['new Standalone', 'Standalone', 'constructor', 0],
          ] as const;
          expect(result.referenceSites, source).toEqual(
            calls.flatMap(([expression, name, callForm, arity]) => {
              const start = source.indexOf(expression);
              expect(start, expression).toBeGreaterThanOrEqual(0);
              const before = source.slice(0, start).split('\n');
              const through = source.slice(0, start + expression.length).split('\n');
              return [
                {
                  name,
                  atRange: {
                    startLine: before.length,
                    startCol: before[before.length - 1]!.length,
                    endLine: through.length,
                    endCol: through[through.length - 1]!.length,
                  },
                  inScope: result.moduleScope,
                  kind: 'call',
                  callForm,
                  arity,
                  ...(callForm === 'member' ? { explicitReceiver: { name: 'obj' } } : {}),
                },
                ...(callForm === 'member'
                  ? [
                      {
                        name: 'obj',
                        kind: 'read',
                        inScope: result.moduleScope,
                        atRange: {
                          startLine: before.length,
                          startCol: before[before.length - 1]!.length,
                          endLine: before.length,
                          endCol: before[before.length - 1]!.length + 'obj'.length,
                        },
                      },
                    ]
                  : []),
              ];
            }),
          );
          expect(result.localDefs, source).toEqual(baseline.localDefs);
          expect(result.parsedImports, source).toEqual(baseline.parsedImports);
          expect(result.exports, source).toEqual(baseline.exports);
          expect(
            result.scopes.map((scope) => scope.kind),
            source,
          ).toEqual(['Module']);
          expect(result.scopes[0]!.bindings, source).toEqual(baseline.scopes[0]!.bindings);
        }
      }
    },
  );

  it.each(filePaths)(
    'extracts call initializers in statement and declarator preorder in %s',
    async (filePath) => {
      for (const kind of ['let', 'const', 'var']) {
        for (const prefix of ['', 'export ']) {
          for (const grouped of [false, true]) {
            const group = (expression: string) =>
              grouped ? `(/* group */ (${expression}))` : expression;
            const inner = `inner(/* literal */ ${group('1')},)`;
            const member = `obj /* receiver */ .method(${group('new Box')}, ${group('true')})`;
            const outer = `outer(${group(inner)},\n ${group(member)}, ${group('null')})`;
            const last = `last(${group('"text"')})`;
            const constructor = `new Wrap(${group(last)}, ${group('false')},)`;
            const source = [
              'before();',
              `${prefix}${kind} first = ${group(outer)}, literal = ${group('1')}, second = ${group(constructor)}, third = ${group('object.method()')};`,
              'after(new Tail);',
            ].join('\n');
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
            const rangeFor = (text: string) => {
              const start = source.indexOf(text);
              expect(start, text).toBeGreaterThanOrEqual(0);
              const before = source.slice(0, start).split('\n');
              const through = source.slice(0, start + text.length).split('\n');
              return {
                startLine: before.length,
                startCol: before[before.length - 1]!.length,
                endLine: through.length,
                endCol: through[through.length - 1]!.length,
              };
            };
            const calls = [
              ['before()', 'before', 'free', 0, undefined],
              [outer, 'outer', 'free', 3, undefined],
              [inner, 'inner', 'free', 1, undefined],
              [member, 'method', 'member', 2, 'obj'],
              ['new Box', 'Box', 'constructor', 0, undefined],
              [constructor, 'Wrap', 'constructor', 2, undefined],
              [last, 'last', 'free', 1, undefined],
              ['object.method()', 'method', 'member', 0, 'object'],
              ['after(new Tail)', 'after', 'free', 1, undefined],
              ['new Tail', 'Tail', 'constructor', 0, undefined],
            ] as const;
            expect(result.referenceSites, source).toEqual(
              calls.flatMap(([expression, name, callForm, arity, receiver]) => [
                {
                  name,
                  atRange: rangeFor(expression),
                  inScope: result.moduleScope,
                  kind: 'call',
                  callForm,
                  arity,
                  ...(receiver ? { explicitReceiver: { name: receiver } } : {}),
                },
                ...(receiver
                  ? [
                      {
                        name: receiver,
                        kind: 'read',
                        atRange: rangeFor(receiver),
                        inScope: result.moduleScope,
                      },
                    ]
                  : []),
              ]),
            );
            const expected = ['first', 'literal', 'second', 'third'].map((name) => {
              const range = rangeFor(`${name} =`);
              return {
                nodeId: `def:${filePath}#${range.startLine}:${range.startCol}:Variable:${name}`,
                filePath,
                type: 'Variable',
                qualifiedName: name,
              };
            });
            expect(result.localDefs, source).toEqual(expected);
            expect(
              result.scopes.map((scope) => scope.kind),
              source,
            ).toEqual(['Module']);
            const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
            expect([...module.bindings], source).toEqual(
              expected.map((def) => [
                def.qualifiedName,
                [
                  {
                    def,
                    origin: 'local',
                    namespace: ['Class', 'Enum'].includes(def.type) ? 'both' : 'value',
                  },
                ],
              ]),
            );
            expect(result.exports, source).toEqual(
              new Map(prefix ? expected.map((def) => [def.qualifiedName, def.nodeId]) : []),
            );
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'preserves repeated var call initializers and exports the earliest binding in %s',
    async (filePath) => {
      const source = [
        'var local = first(), local = obj.second(new Box);',
        'export var local = new Wrap(last(1));',
        'export { local as renamed };',
      ].join('\n');
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      const starts = [
        source.indexOf('local'),
        source.indexOf('local', source.indexOf('local') + 1),
        source.indexOf('local', source.indexOf('\n')),
      ];
      const expected = starts.map((start) => {
        const before = source.slice(0, start).split('\n');
        return {
          nodeId: `def:${filePath}#${before.length}:${before[before.length - 1]!.length}:Variable:local`,
          filePath,
          type: 'Variable',
          qualifiedName: 'local',
        };
      });
      expect(result.localDefs).toEqual(expected);
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      expect([...module.bindings]).toEqual([
        ['local', [{ def: expected[0], origin: 'local', namespace: 'value' }]],
      ]);
      expect(result.exports).toEqual(
        new Map([
          ['local', expected[0]!.nodeId],
          ['renamed', expected[0]!.nodeId],
        ]),
      );
      expect(result.referenceSites.map(({ name, inScope }) => ({ name, inScope }))).toEqual(
        ['first', 'second', 'obj', 'Box', 'Wrap', 'last'].map((name) => ({
          name,
          inScope: result.moduleScope,
        })),
      );
    },
  );

  it.each(filePaths)(
    'interleaves call and identifier-argument reads in source preorder in %s',
    async (filePath) => {
      const source =
        'outer((/* argument */ café), 1, inner(missing, true), obj.method((λ), null), new Box(café));';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const independent = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      expect(
        result.referenceSites.map(({ name, kind, callForm, arity, inScope }) => ({
          name,
          kind,
          callForm,
          arity,
          inScope,
        })),
      ).toEqual([
        { name: 'outer', kind: 'call', callForm: 'free', arity: 5, inScope: result.moduleScope },
        {
          name: 'café',
          kind: 'read',
          callForm: undefined,
          arity: undefined,
          inScope: result.moduleScope,
        },
        { name: 'inner', kind: 'call', callForm: 'free', arity: 2, inScope: result.moduleScope },
        {
          name: 'missing',
          kind: 'read',
          callForm: undefined,
          arity: undefined,
          inScope: result.moduleScope,
        },
        { name: 'method', kind: 'call', callForm: 'member', arity: 2, inScope: result.moduleScope },
        {
          name: 'obj',
          kind: 'read',
          callForm: undefined,
          arity: undefined,
          inScope: result.moduleScope,
        },
        {
          name: 'λ',
          kind: 'read',
          callForm: undefined,
          arity: undefined,
          inScope: result.moduleScope,
        },
        {
          name: 'Box',
          kind: 'call',
          callForm: 'constructor',
          arity: 1,
          inScope: result.moduleScope,
        },
        {
          name: 'café',
          kind: 'read',
          callForm: undefined,
          arity: undefined,
          inScope: result.moduleScope,
        },
      ]);
      const names = root
        .descendantsOfType('identifier')
        .filter((node) => ['café', 'missing', 'obj', 'λ'].includes(node.text));
      const reads = captures.filter((match) => match['@reference.read']);
      expect(reads).toEqual(
        names.map((name) => {
          const range = {
            startLine: name.startPosition.row + 1,
            startCol: name.startPosition.column,
            endLine: name.endPosition.row + 1,
            endCol: name.endPosition.column,
          };
          return {
            '@reference.read': { name: '@reference.read', text: '', range },
            '@reference.name': { name: '@reference.name', text: name.text, range },
          };
        }),
      );
      expect(result.referenceSites.filter((site) => site.kind === 'read')).toEqual(
        reads.map((match) => ({
          name: match['@reference.name']!.text,
          kind: 'read',
          atRange: match['@reference.read']!.range,
          inScope: result.moduleScope,
        })),
      );
      expect(captures).toEqual(independent);
      for (const [index, match] of captures.entries()) {
        for (const [key, capture] of Object.entries(match)) {
          expect(capture).not.toBe(independent[index]![key]);
          expect(capture.range).not.toBe(independent[index]![key]!.range);
        }
      }
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
      reads[0]!['@reference.read']!.range.startLine = 999;
      expect(reads[0]!['@reference.name']!.range.startLine).toBe(1);
      expect(JSON.stringify(independent)).toBe(saved);
    },
  );

  it.each(filePaths)(
    'owns identifier arguments in returned and initialized calls in nested blocks in %s',
    async (filePath) => {
      const source = [
        'function owner(value) {',
        '  const initialized = outer((value), 1);',
        '  { let value = 2; return obj.method(new Box((value)), inner(missing, false)); }',
        '  return outer(value);',
        '}',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const [body, nested] = result.scopes.filter((scope) => scope.kind === 'Block');
      expect(
        result.referenceSites.map(({ name, kind, arity, inScope }) => ({
          name,
          kind,
          arity,
          inScope,
        })),
      ).toEqual([
        { name: 'outer', kind: 'call', arity: 2, inScope: body!.id },
        { name: 'value', kind: 'read', arity: undefined, inScope: body!.id },
        { name: 'method', kind: 'call', arity: 2, inScope: nested!.id },
        { name: 'obj', kind: 'read', arity: undefined, inScope: nested!.id },
        { name: 'Box', kind: 'call', arity: 1, inScope: nested!.id },
        { name: 'value', kind: 'read', arity: undefined, inScope: nested!.id },
        { name: 'inner', kind: 'call', arity: 2, inScope: nested!.id },
        { name: 'missing', kind: 'read', arity: undefined, inScope: nested!.id },
        { name: 'outer', kind: 'call', arity: 1, inScope: body!.id },
        { name: 'value', kind: 'read', arity: undefined, inScope: body!.id },
      ]);
      expect([...nested!.bindings.keys()]).toEqual(['value']);
      parser.parse('function replacement() {}');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'captures standalone identifier reads in source order and their lexical scopes in %s',
    async (filePath) => {
      const source = [
        "import Imported from './module';",
        'export const value = 1;',
        'Imported; ((missing)); (\n café\n);',
        'before();',
        'export function owner(value) {',
        '  value; ((Imported));',
        '  { let value = 1; ((/* shadow */ value));',
        '    if (true) { value; ((λ)); } else { ((missing)); }',
        '    value;',
        '  }',
        '  value;',
        '}',
        'after();',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError, source).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const independent = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const baseline = extract(
        captures.filter((match) => !match['@reference.read']),
        filePath,
        hooks,
      );
      const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
      expect(blocks).toHaveLength(4);
      const expressions = root
        .descendantsOfType('expression_statement')
        .map((statement) => statement.namedChildren[0]!);
      const rangeOf = (node: typeof root) => ({
        startLine: node.startPosition.row + 1,
        startCol: node.startPosition.column,
        endLine: node.endPosition.row + 1,
        endCol: node.endPosition.column,
      });
      const identifiers = expressions
        .filter((expression) => expression.type !== 'call_expression')
        .map((expression) =>
          expression.type === 'identifier'
            ? expression
            : expression.descendantsOfType('identifier')[0]!,
        );
      expect(identifiers.map((node) => node.text)).toEqual([
        'Imported',
        'missing',
        'café',
        'value',
        'Imported',
        'value',
        'value',
        'λ',
        'missing',
        'value',
        'value',
      ]);
      const reads = captures.filter((match) => match['@reference.read']);
      expect(reads).toEqual(
        identifiers.map((node) => ({
          '@reference.read': { name: '@reference.read', text: '', range: rangeOf(node) },
          '@reference.name': { name: '@reference.name', text: node.text, range: rangeOf(node) },
        })),
      );
      const expectedScopes = [
        result.moduleScope,
        result.moduleScope,
        result.moduleScope,
        result.moduleScope,
        blocks[0]!.id,
        blocks[0]!.id,
        blocks[1]!.id,
        blocks[2]!.id,
        blocks[2]!.id,
        blocks[3]!.id,
        blocks[1]!.id,
        blocks[0]!.id,
        result.moduleScope,
      ];
      expect(result.referenceSites).toEqual(
        expressions.map((expression, index) => {
          if (expression.type === 'call_expression') {
            return {
              name: expression.childForFieldName('function')!.text,
              atRange: rangeOf(expression),
              inScope: expectedScopes[index],
              kind: 'call',
              callForm: 'free',
              arity: 0,
            };
          }
          const name =
            expression.type === 'identifier'
              ? expression
              : expression.descendantsOfType('identifier')[0]!;
          return {
            name: name.text,
            kind: 'read',
            atRange: rangeOf(name),
            inScope: expectedScopes[index],
          };
        }),
      );
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
      expect(result.parsedImports).toEqual(baseline.parsedImports);
      expect(result.exports).toEqual(baseline.exports);
      const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
      expect([...owner.bindings.keys()]).toEqual(['value']);
      expect([...blocks[1]!.bindings.keys()]).toEqual(['value']);
      expect(blocks[1]!.bindings.get('value')![0]!.def.nodeId).not.toBe(
        owner.bindings.get('value')![0]!.def.nodeId,
      );
      expect(result.localDefs.map((def) => def.qualifiedName)).toEqual([
        'value',
        'owner',
        'value',
        'value',
      ]);
      expect(result.parsedImports).toEqual([
        {
          kind: 'alias',
          localName: 'Imported',
          importedName: 'default',
          alias: 'Imported',
          targetRaw: './module',
        },
      ]);
      expect(result.exports).toEqual(
        new Map([
          ['value', result.localDefs[0]!.nodeId],
          ['owner', result.localDefs[1]!.nodeId],
        ]),
      );
      expect(independent).toEqual(captures);
      for (const [index, match] of captures.entries()) {
        for (const [key, capture] of Object.entries(match)) {
          expect(capture).not.toBe(independent[index]![key]);
          expect(capture.range).not.toBe(independent[index]![key]!.range);
        }
      }
      const expectedResult = structuredClone(result);
      reads[0]!['@reference.read']!.range.startLine = 999;
      expect(reads[0]!['@reference.name']!.range.startLine).toBe(3);
      parser.parse('function replacement() { other; }');
      expect(JSON.stringify(independent)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(expectedResult);
      expect(extract(independent, filePath, hooks)).toEqual(expectedResult);
    },
  );

  it.each(filePaths)(
    'rejects unsupported expression siblings before or after standalone reads atomically in %s',
    async (filePath) => {
      for (const expression of [
        'obj?.[key].deep',
        'obj?.[key]',
        'value + 1',
        '!value',
        'factory()[key]++',
        '1',
        'true',
        'null',
        'undefined',
        String.raw`\u0076alue`,
      ]) {
        for (const bad of [`${expression};`, `((${expression}));`]) {
          for (const contents of [`Imported; ${bad}`, `${bad} ((Imported));`]) {
            for (const statement of [
              contents,
              `function owner(value) { ${contents} }`,
              `function owner(value) { { ${contents} } }`,
              `function owner(value) { if (true) { ${contents} } else { value; } }`,
              `function owner(value) { if (true) { value; } else { ${contents} } }`,
            ]) {
              const source = `import Imported from './module';\nexport const retained = 1;\n${statement}`;
              const { root } = await parse(source, filePath);
              expect(root.hasError, source).toBe(false);
              expect(() => emitTypeScriptCaptures(root), source).toThrow();
            }
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'captures direct and grouped identifier initializers as module reads in %s',
    async (filePath) => {
      for (const kind of ['const', 'let', 'var']) {
        for (const prefix of ['', 'export ']) {
          const source = [
            "import Imported from './module';",
            `${prefix}${kind} direct = Imported, grouped = ((/* value */ missing)), unicode = (\n café\n), nan = NaN, infinity = ((Infinity)), self = self;`,
          ].join('\n');
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const values = root.descendantsOfType('variable_declarator').map((node) => {
            const value = node.childForFieldName('value')!;
            return value.type === 'identifier' ? value : value.descendantsOfType('identifier')[0]!;
          });
          expect(
            values.map((value) => [value.type, value.text]),
            source,
          ).toEqual(
            ['Imported', 'missing', 'café', 'NaN', 'Infinity', 'self'].map((name) => [
              'identifier',
              name,
            ]),
          );
          const captures = emitTypeScriptCaptures(root);
          const independent = emitTypeScriptCaptures(root);
          const saved = JSON.stringify(captures);
          const reads = captures.filter((match) => match['@reference.read']);
          expect(reads, source).toEqual(
            values.map((value) => {
              const range = {
                startLine: value.startPosition.row + 1,
                startCol: value.startPosition.column,
                endLine: value.endPosition.row + 1,
                endCol: value.endPosition.column,
              };
              return {
                '@reference.read': { name: '@reference.read', text: '', range },
                '@reference.name': { name: '@reference.name', text: value.text, range },
              };
            }),
          );
          const result = extract(captures, filePath, hooks);
          const baseline = extract(
            captures.filter((match) => !match['@reference.read']),
            filePath,
            hooks,
          );
          expect(result.referenceSites, source).toEqual(
            reads.map((match) => ({
              name: match['@reference.name']!.text,
              kind: 'read',
              atRange: match['@reference.read']!.range,
              inScope: result.moduleScope,
            })),
          );
          expect(result.localDefs, source).toEqual(baseline.localDefs);
          expect(result.scopes, source).toEqual(baseline.scopes);
          expect(
            result.localDefs.map((def) => def.qualifiedName),
            source,
          ).toEqual(['direct', 'grouped', 'unicode', 'nan', 'infinity', 'self']);
          const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
          expect([...module.bindings], source).toEqual(
            result.localDefs.map((def) => [
              def.qualifiedName,
              [
                {
                  def,
                  origin: 'local',
                  namespace: ['Class', 'Enum'].includes(def.type) ? 'both' : 'value',
                },
              ],
            ]),
          );
          expect(result.parsedImports, source).toEqual([
            {
              kind: 'alias',
              localName: 'Imported',
              importedName: 'default',
              alias: 'Imported',
              targetRaw: './module',
            },
          ]);
          expect(result.exports, source).toEqual(
            new Map(prefix ? result.localDefs.map((def) => [def.qualifiedName, def.nodeId]) : []),
          );
          expect(captures, source).toEqual(independent);
          for (const [index, match] of captures.entries()) {
            for (const [key, capture] of Object.entries(match)) {
              expect(capture).not.toBe(independent[index]![key]);
              expect(capture.range).not.toBe(independent[index]![key]!.range);
            }
          }
          parser.parse('replacement();');
          expect(JSON.stringify(captures), source).toBe(saved);
          expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
        }
      }
    },
  );

  it.each(filePaths)(
    'owns initializer reads in nested blocks without changing canonical var bindings in %s',
    async (filePath) => {
      const source = [
        "import Imported from './module';",
        'export function owner(value) {',
        '  const first = value, second = ((Imported));',
        '  var value = value, repeated = missing;',
        '  { let value = ((value)); const café = value;',
        '    { var repeated = (café); let last = ((missing)); }',
        '  }',
        '  var repeated = Imported;',
        '}',
      ].join('\n');
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError, source).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const baseline = extract(
        captures.filter((match) => !match['@reference.read']),
        filePath,
        hooks,
      );
      const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
      expect(blocks).toHaveLength(3);
      const values = root.descendantsOfType('variable_declarator').map((node) => {
        const value = node.childForFieldName('value')!;
        return value.type === 'identifier' ? value : value.descendantsOfType('identifier')[0]!;
      });
      expect(values.map((value) => value.text)).toEqual([
        'value',
        'Imported',
        'value',
        'missing',
        'value',
        'value',
        'café',
        'missing',
        'Imported',
      ]);
      expect(result.referenceSites).toEqual(
        values.map((value, index) => ({
          name: value.text,
          kind: 'read',
          atRange: {
            startLine: value.startPosition.row + 1,
            startCol: value.startPosition.column,
            endLine: value.endPosition.row + 1,
            endCol: value.endPosition.column,
          },
          inScope: blocks[index < 4 || index === 8 ? 0 : index < 6 ? 1 : 2]!.id,
        })),
      );
      expect(result.localDefs).toEqual(baseline.localDefs);
      expect(result.scopes).toEqual(baseline.scopes);
      const owner = result.scopes.find((scope) => scope.kind === 'Function')!;
      const parameter = owner.ownedDefs.find((def) => def.qualifiedName === 'value')!;
      expect(owner.bindings.get('value')![0]!.def).toBe(parameter);
      expect(owner.bindings.get('repeated')![0]!.def).toBe(
        blocks[0]!.ownedDefs.find((def) => def.qualifiedName === 'repeated'),
      );
      expect(blocks[1]!.bindings.get('value')![0]!.def).toBe(blocks[1]!.ownedDefs[0]);
      expect(blocks[1]!.bindings.get('value')![0]!.def).not.toBe(parameter);
      expect([...blocks[0]!.bindings.keys()]).toEqual(['first', 'second']);
      expect([...blocks[2]!.bindings.keys()]).toEqual(['last']);
      expect(
        result.scopes.find((scope) => scope.id === result.moduleScope)!.bindings.has('repeated'),
      ).toBe(false);
      parser.parse('function replacement() {}');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'rejects unsupported initializer call trees atomically in either order in %s',
    async (filePath) => {
      const unsupported = [
        'other?.[key].deep',
        'value?.()',
        'object?.[key]?.()',
        'object[key]?.()',
        'object[key]()',
        'new Namespace.Value()',
        'new object[key]()',
        'value()()',
        'outer(value?.[key].deep)',
        'outer(...make())',
        'outer(() => { return this; })',
        'outer({...value?.[key].deep})',
        'outer([...values?.[key].deep])',
        'outer(good(1), bad(object[key]()))',
        'outer(bad(object[key]()), good(1))',
      ];
      for (const value of unsupported) {
        for (const kind of ['let', 'const', 'var']) {
          for (const prefix of ['', 'export ']) {
            for (const declarators of [
              `good = valid(1), bad = ${value}`,
              `bad = ${value}, good = valid(1)`,
            ]) {
              const declaration = `${prefix}${kind} ${declarators};`;
              for (const source of [
                `export const retained = 1;\nbefore();\n${declaration}\nafter();`,
                `${declaration}\nbefore();\nexport const retained = 1;`,
              ]) {
                const { root } = await parse(source, filePath);
                expect(root.hasError, source).toBe(false);
                expect(() => emitTypeScriptCaptures(root), source).toThrow();
              }
            }
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'rejects unsupported nested inputs before returning captures in %s',
    async (filePath) => {
      const unsupported = [
        'value?.[key].deep',
        '() => { return this; }',
        '{...value?.[key].deep}',
        '[...values?.[key].deep]',
        '...make()',
        'object[key]()',
        String.raw`\u0076alue`,
        'value?.()',
        'object?.[key]?.()',
        'object[key]?.()',
        'new Namespace.Value()',
        'new object[key]()',
        'value()()',
      ];
      for (const argument of unsupported) {
        for (const argumentsText of [`good(1), bad(${argument})`, `bad(${argument}), good(1)`]) {
          for (const expression of [
            `outer(${argumentsText})`,
            `obj.method(${argumentsText})`,
            `new Wrap(${argumentsText})`,
          ]) {
            for (const source of [
              `export const retained = 1;\nvalid();\n${expression};`,
              `${expression};\nvalid();\nexport const retained = 1;`,
            ]) {
              const { root } = await parse(source, filePath);
              expect(root.hasError, source).toBe(false);
              expect(() => emitTypeScriptCaptures(root), source).toThrow();
            }
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'retains negative numeric values and exact neighboring references in %s',
    async (filePath) => {
      for (const literal of ['-1.25', '-2e3', '-0', '-123n', '- /* operand */ 1']) {
        for (const container of [
          literal,
          `[${literal}, {number: ${literal}, next: inner(value)}]`,
          `{number: ${literal}, nested: [${literal}, inner(value)]}`,
        ]) {
          const expressions = /\.tsx?$/.test(filePath)
            ? [container, `(${container}) as const`]
            : [container];
          for (const expression of expressions) {
            for (const position of ['initializer', 'argument', 'return', 'throw', 'if'] as const) {
              const statement = {
                initializer: `const item = ${expression};`,
                argument: `outer(value, ${expression}, obj.method(${literal}));`,
                return: `return ${expression};`,
                throw: `throw ${expression};`,
                if: `if (${expression}) { branch(); }`,
              }[position];
              const source = `function owner(value, obj) { before(); ${statement} after(value); }`;
              const { parser, root } = await parse(source, filePath);
              expect(root.hasError, source).toBe(false);
              const captures = emitTypeScriptCaptures(root);
              const saved = JSON.stringify(captures);
              const result = extract(captures, filePath, hooks);
              const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
              const body = blocks[0]!;
              const rangeOf = (text: string, from = source.indexOf(statement)) => {
                const offset = source.indexOf(text, from);
                expect(offset, text).toBeGreaterThanOrEqual(from);
                return { startLine: 1, startCol: offset, endLine: 1, endCol: offset + text.length };
              };
              const call = (text: string, name: string, arity: number, inScope = body.id) => ({
                name,
                kind: 'call',
                callForm: name === 'method' ? 'member' : 'free',
                arity,
                inScope,
                atRange: rangeOf(text, name === 'before' ? 0 : source.indexOf(statement)),
                ...(name === 'method' ? { explicitReceiver: { name: 'obj' } } : {}),
              });
              const read = (name: string, from: number) => ({
                name,
                kind: 'read',
                inScope: body.id,
                atRange: rangeOf(name, from),
              });
              expect(result.referenceSites, source).toEqual([
                call('before()', 'before', 0),
                ...(position === 'argument'
                  ? [
                      call(`outer(value, ${expression}, obj.method(${literal}))`, 'outer', 3),
                      read('value', source.indexOf('outer(')),
                    ]
                  : []),
                ...(container === literal
                  ? []
                  : [call('inner(value)', 'inner', 1), read('value', source.indexOf('inner('))]),
                ...(position === 'argument'
                  ? [
                      call(`obj.method(${literal})`, 'method', 1),
                      read('obj', source.indexOf('obj.method(')),
                    ]
                  : []),
                ...(position === 'if' ? [call('branch()', 'branch', 0, blocks[1]!.id)] : []),
                call('after(value)', 'after', 1),
                read('value', source.indexOf('after(')),
              ]);
              parser.parse('replacement();');
              expect(JSON.stringify(captures), source).toBe(saved);
              expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
            }
          }
        }
      }
    },
  );

  it.each(filePaths)('rejects unsupported unary operands atomically in %s', async (filePath) => {
    for (const operand of [
      'delete value',
      'delete call()',
      'delete (value.x)',
      'delete value[key]',
      'delete (value)',
      'delete value.x',
      'delete value?.x',
      'delete "1"',
      '-1e',
      '-',
    ]) {
      const values = [
        operand,
        `[good(), ${operand}]`,
        `[${operand}, good()]`,
        `{next: ${operand}}`,
        ...(/\.tsx?$/.test(filePath) ? [`${operand} as const`] : []),
      ];
      for (const value of values) {
        for (const statement of [
          `const item = ${value};`,
          `outer(${value});`,
          `return ${value};`,
          `throw ${value};`,
          `if (${value}) { branch(); }`,
        ]) {
          const source = `before(); function owner(value) { ${statement} } after();`;
          const { root } = await parse(source, filePath);
          expect(() => emitTypeScriptCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
        }
      }
    }
    for (const literal of ['-1.25', '-2e3', '-0', '-123n', '- /* operand */ 1']) {
      for (const statement of [`${literal};`, `((${literal}));`]) {
        for (const source of [`before(); ${statement}`, `${statement} after();`]) {
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          expect(() => emitTypeScriptCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
        }
      }
    }
  });

  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains exact references through const assertions in every expression position in %s',
    async (filePath) => {
      const array =
        '[{first: value}, inner([missing] as const), obj.method({arg: value} as const), [] as const, {} as const]';
      for (const operand of [array, `{items: ${array}}`]) {
        const assertion = `((${operand}) /* operand */ as /* keyword */ const)`;
        for (const position of [
          'initializer',
          'argument',
          'return',
          'throw',
          'standalone',
          'if',
        ] as const) {
          const statement = {
            initializer: `const item = ${assertion};`,
            argument: `outer(${assertion}, 0 as const);`,
            return: `return ${assertion};`,
            throw: `throw ${assertion};`,
            standalone: `${assertion};`,
            if: `if (${assertion}) { branch(); }`,
          }[position];
          const source = `const value = 1;\nfunction owner(value, obj, missing) {\n { let value; ${statement} }\n}`;
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const captures = emitTypeScriptCaptures(root);
          const saved = JSON.stringify(captures);
          const result = extract(captures, filePath, hooks);
          const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
          const lexical = blocks[1]!;
          const rangeOf = (text: string, from = source.indexOf(assertion)) => {
            const offset = source.indexOf(text, from);
            expect(offset, text).toBeGreaterThanOrEqual(from);
            const before = source.slice(0, offset).split('\n');
            const through = source.slice(0, offset + text.length).split('\n');
            return {
              startLine: before.length,
              startCol: before.at(-1)!.length,
              endLine: through.length,
              endCol: through.at(-1)!.length,
            };
          };
          const read = (name: string, from = source.indexOf(assertion)) => ({
            name,
            kind: 'read',
            inScope: lexical.id,
            atRange: rangeOf(name, from),
          });
          const call = (
            text: string,
            name: string,
            callForm: string,
            arity: number,
            inScope = lexical.id,
          ) => ({
            name,
            kind: 'call',
            callForm,
            arity,
            inScope,
            atRange: rangeOf(text, source.indexOf(statement)),
            ...(callForm === 'member' ? { explicitReceiver: { name: 'obj' } } : {}),
          });
          expect(result.referenceSites, source).toEqual([
            ...(position === 'argument'
              ? [call(`outer(${assertion}, 0 as const)`, 'outer', 'free', 2)]
              : []),
            read('value'),
            call('inner([missing] as const)', 'inner', 'free', 1),
            read('missing'),
            call('obj.method({arg: value} as const)', 'method', 'member', 1),
            read('obj'),
            read('value', source.indexOf('arg: ')),
            ...(position === 'if' ? [call('branch()', 'branch', 'free', 0, blocks[2]!.id)] : []),
          ]);
          expect(
            result.scopes.map((scope) => scope.kind),
            source,
          ).toEqual([
            'Module',
            'Function',
            'Block',
            'Block',
            ...(position === 'if' ? ['Block'] : []),
          ]);
          const fields = buildFieldRegistry(
            buildScopeRegistryContext(finalizeScopeModel([result])),
          );
          expect(fields.lookup('value', lexical.id)[0]!.def.nodeId, source).toBe(
            lexical.ownedDefs.find((def) => def.qualifiedName === 'value')!.nodeId,
          );
          parser.parse('replacement();');
          expect(JSON.stringify(captures), source).toBe(saved);
          expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
        }
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'keeps const literal and empty-container arguments in call arity in %s',
    async (filePath) => {
      const literals = ['0', '1', '"text"', 'true', 'false', 'null', '[]', '{}'];
      const source = `outer(${literals.map((value) => `((/* before */ ${value} /* after */) as const)`).join(', ')});`;
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      expect(result.referenceSites).toEqual([
        {
          name: 'outer',
          kind: 'call',
          callForm: 'free',
          arity: literals.length,
          inScope: result.moduleScope,
          atRange: { startLine: 1, startCol: 0, endLine: 1, endCol: source.length - 1 },
        },
      ]);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'rejects invalid const assertions and nested values atomically in either order in %s',
    async (filePath) => {
      for (const bad of [
        'value as const',
        'call() as const',
        '(call()) as const',
        '(value) as const',
        '({} as const) as const',
        '([] as const) as const',
        '(1 as const) as const',
        '[] as typeof Shape',
        '{} as typeof Shape',
        '<Type>[]',
        '<const>[]',
        'tag`text` as const',
        '`text` as const',
        '+1 as const',
        '[...values?.[key].deep] as const',
        '[,] as const',
        '[value?.[key].deep] as const',
        '{[key?.[index].deep]: value} as const',
        '{value: () => { return this; }} as const',
        '[] as',
        '[] as const Type',
        '[] as const<string>',
      ]) {
        for (const value of [`[good(), ${bad}] as const`, `[${bad}, good()] as const`]) {
          for (const statement of [
            `const item = ${value};`,
            `outer(${value});`,
            `return ${value};`,
            `throw ${value};`,
            `(${value});`,
            `if (${value}) { branch(); }`,
          ]) {
            const source = `before(); function owner(value) { ${statement} } after();`;
            const { root } = await parse(source, filePath);
            expect(() => emitTypeScriptCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'keeps empty, plain and escaped template arguments free of extra references in %s',
    async (filePath) => {
      const templates = [
        '``',
        '`plain text`',
        '`first\nsecond`',
        '`escaped \\n \\u0061 \\\\ \\` \\${literal}`',
      ];
      const source = `before(); outer(${templates.join(', ')}); after();`;
      const { root } = await parse(source, filePath);
      expect(root.hasError, source).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      expect(
        result.referenceSites.map(({ name, kind, arity, inScope }) => ({
          name,
          kind,
          arity,
          inScope,
        })),
      ).toEqual([
        { name: 'before', kind: 'call', arity: 0, inScope: result.moduleScope },
        { name: 'outer', kind: 'call', arity: templates.length, inScope: result.moduleScope },
        { name: 'after', kind: 'call', arity: 0, inScope: result.moduleScope },
      ]);
    },
  );

  it.each(filePaths)(
    'retains exact template substitution references and lexical ownership in %s',
    async (filePath) => {
      const template =
        '`raw ${ /* before */ ((value)) /* after */ }\n${inner(`nested ${missing}`)} ${obj.method(new Box(value))}`';
      for (const position of [
        'initializer',
        'return',
        'throw',
        'argument',
        'array',
        'object',
      ] as const) {
        const statement = {
          initializer: `const item = ${template};`,
          return: `return ${template};`,
          throw: `throw ${template};`,
          argument: `outer(${template}, value);`,
          array: `const item = [${template}];`,
          object: `const item = {key: ${template}};`,
        }[position];
        const source = `const value = 1;\nfunction owner(value, obj, missing) {\n { let value; ${statement} }\n}`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const lexical = result.scopes.filter((scope) => scope.kind === 'Block')[1]!;
        const start = source.indexOf(template);
        const rangeOf = (text: string, from = start) => {
          const offset = source.indexOf(text, from);
          expect(offset, text).toBeGreaterThanOrEqual(from);
          const before = source.slice(0, offset).split('\n');
          const through = source.slice(0, offset + text.length).split('\n');
          return {
            startLine: before.length,
            startCol: before.at(-1)!.length,
            endLine: through.length,
            endCol: through.at(-1)!.length,
          };
        };
        const read = (name: string, from = start) => ({
          name,
          kind: 'read',
          atRange: rangeOf(name, from),
          inScope: lexical.id,
        });
        const call = (text: string, name: string, callForm: string, arity: number) => ({
          name,
          kind: 'call',
          callForm,
          arity,
          atRange: rangeOf(text, source.indexOf(statement)),
          inScope: lexical.id,
          ...(callForm === 'member' ? { explicitReceiver: { name: 'obj' } } : {}),
        });
        expect(result.referenceSites, source).toEqual([
          ...(position === 'argument'
            ? [call(`outer(${template}, value)`, 'outer', 'free', 2)]
            : []),
          read('value'),
          call('inner(`nested ${missing}`)', 'inner', 'free', 1),
          read('missing'),
          call('obj.method(new Box(value))', 'method', 'member', 1),
          read('obj'),
          call('new Box(value)', 'Box', 'constructor', 1),
          read('value', source.indexOf('new Box')),
          ...(position === 'argument' ? [read('value', start + template.length)] : []),
        ]);
        expect(
          result.scopes.map((scope) => scope.kind),
          source,
        ).toEqual(['Module', 'Function', 'Block', 'Block']);
        const fields = buildFieldRegistry(buildScopeRegistryContext(finalizeScopeModel([result])));
        expect(fields.lookup('value', lexical.id)[0]!.def.nodeId, source).toBe(
          lexical.ownedDefs.find((def) => def.qualifiedName === 'value')!.nodeId,
        );
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'refuses unsupported and malformed template substitutions atomically in %s',
    async (filePath) => {
      const unsupported = [
        'value?.[key].deep',
        '() => { return this; }',
        '...make()',
        'value = 1',
        'delete value',
        'value?.()',
        'obj[key]()',
        '/pattern/zz',
        'tag`text`',
        ...(/\.tsx?$/.test(filePath) ? ['value as typeof Shape', 'value<Type>()'] : []),
      ];
      const templates = [
        ...unsupported.flatMap((expression) => [
          '`first ${good()} last ${' + expression + '}`',
          '`first ${' + expression + '} last ${good()}`',
        ]),
        'tag`text ${good()}`',
        '`unterminated',
        '`${}`',
        '`${value`',
        '`${good()} ${}`',
      ];
      for (const template of templates) {
        for (const statement of [
          `const item = ${template};`,
          `outer(${template});`,
          `return ${template};`,
        ]) {
          const source = `before(); function owner(value) { ${statement} } after();`;
          const { root } = await parse(source, filePath);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'keeps standalone templates outside the supported statement surface in %s',
    async (filePath) => {
      for (const statement of ['`text`;', '(`text`);', '`text ${value}`;']) {
        for (const source of [`before(); ${statement}`, `${statement} after();`]) {
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          expect(() => emitTypeScriptCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
        }
      }
    },
  );

  it.each(filePaths)(
    'captures only static object values in every expression position in %s',
    async (filePath) => {
      const object =
        '{/* keys are not reads */ value: value, "missing": inner({next: [missing,],}), 12: new Box({}), default: obj.method({arg: value}), nested: {café: ((café)),}, empty: {}, "literal": [true, false, null, 0, "text", 123n],}';
      for (const position of [
        'initializer',
        'argument',
        'return',
        'throw',
        'standalone',
        'if',
      ] as const) {
        const statement = {
          initializer: `const item = (${object});`,
          argument: `outer(${object}, {});`,
          return: `return (${object});`,
          throw: `throw (${object});`,
          standalone: `(${object});`,
          if: `if ((${object})) { branch(); }`,
        }[position];
        const source = `const value = 1;\nfunction owner(value, obj, café) {\n { let value; ${statement} }\n}`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
        const lexical = blocks[1]!;
        const rangeOf = (text: string, from = source.indexOf(object)) => {
          const offset = source.indexOf(text, from);
          expect(offset, text).toBeGreaterThanOrEqual(from);
          const before = source.slice(0, offset).split('\n');
          const through = source.slice(0, offset + text.length).split('\n');
          return {
            startLine: before.length,
            startCol: before.at(-1)!.length,
            endLine: through.length,
            endCol: through.at(-1)!.length,
          };
        };
        const read = (name: string, marker: string) => ({
          name,
          kind: 'read',
          inScope: lexical.id,
          atRange: rangeOf(name, source.indexOf(marker) + marker.length),
        });
        const call = (
          text: string,
          name: string,
          callForm: string,
          arity: number,
          inScope = lexical.id,
        ) => ({
          name,
          kind: 'call',
          callForm,
          arity,
          inScope,
          atRange: rangeOf(text, source.indexOf(statement)),
          ...(callForm === 'member' ? { explicitReceiver: { name: 'obj' } } : {}),
        });
        expect(result.referenceSites, source).toEqual([
          ...(position === 'argument' ? [call(`outer(${object}, {})`, 'outer', 'free', 2)] : []),
          read('value', 'value: '),
          call('inner({next: [missing,],})', 'inner', 'free', 1),
          read('missing', 'next: ['),
          call('new Box({})', 'Box', 'constructor', 1),
          call('obj.method({arg: value})', 'method', 'member', 1),
          read('obj', 'default: '),
          read('value', 'arg: '),
          read('café', 'café: (('),
          ...(position === 'if' ? [call('branch()', 'branch', 'free', 0, blocks[2]!.id)] : []),
        ]);
        expect(
          result.scopes.map((scope) => scope.kind),
          source,
        ).toEqual([
          'Module',
          'Function',
          'Block',
          'Block',
          ...(position === 'if' ? ['Block'] : []),
        ]);
        const local = lexical.ownedDefs.find((def) => def.qualifiedName === 'value')!;
        const fields = buildFieldRegistry(buildScopeRegistryContext(finalizeScopeModel([result])));
        expect(fields.lookup('value', lexical.id)[0]!.def.nodeId, source).toBe(local.nodeId);
        expect(local.nodeId, source).not.toBe(
          result.localDefs.find((def) => def.qualifiedName === 'value')!.nodeId,
        );
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'visits computed object keys before values once with exact ranges and lexical scopes in %s',
    async (filePath) => {
      const object =
        '{[keyOf(value)]: valueOf(value), [Kinds.Item]: value, [table[indexes[key]]]: tail, [/* key */ ((value))]: value, ["__proto__"]: value}';
      for (const expression of [
        object,
        ...(/\.tsx?$/.test(filePath) ? [`${object} as const`] : []),
      ]) {
        for (const position of [
          'initializer',
          'argument',
          'return',
          'throw',
          'standalone',
          'if',
          'arrow',
        ] as const) {
          const statement = {
            initializer: `const item = (${expression});`,
            argument: `outer(${expression});`,
            return: `return (${expression});`,
            throw: `throw (${expression});`,
            standalone: `(${expression});`,
            if: `if (${expression}) { branch(); }`,
            arrow: `const callback = value => (${expression});`,
          }[position];
          const source = `const value = 1;\nfunction owner(value) {\n { let value; ${statement} }\n}`;
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const captures = emitTypeScriptCaptures(root);
          const saved = JSON.stringify(captures);
          const result = extract(captures, filePath, hooks);
          const independent = emitTypeScriptCaptures(root);
          const lexical = result.scopes.filter((scope) => scope.kind === 'Block')[1]!;
          const scope =
            position === 'arrow'
              ? result.scopes.find(
                  (scope) =>
                    scope.ownerDefId ===
                    result.localDefs.find((def) => def.qualifiedName === 'callback')?.nodeId,
                )!
              : lexical;
          const start = source.indexOf(object);
          const rangeOf = (text: string, from = start) => {
            const offset = source.indexOf(text, from);
            expect(offset, text).toBeGreaterThanOrEqual(from);
            const before = source.slice(0, offset).split('\n');
            const through = source.slice(0, offset + text.length).split('\n');
            return {
              startLine: before.length,
              startCol: before.at(-1)!.length,
              endLine: through.length,
              endCol: through.at(-1)!.length,
            };
          };
          const read = (name: string, marker: string) => ({
            name,
            kind: 'read',
            inScope: scope.id,
            atRange: rangeOf(name, source.indexOf(marker, start) + marker.length),
          });
          const call = (text: string, name: string, arity: number, inScope = scope.id) => ({
            name,
            kind: 'call',
            callForm: 'free',
            arity,
            inScope,
            atRange: rangeOf(text, source.indexOf(statement)),
          });
          const selection = (text: string, objectText: string, index: string) => ({
            kind: 'read',
            inScope: scope.id,
            atRange: rangeOf(text),
            selection: {
              kind: 'computed',
              objectRange: rangeOf(objectText, source.indexOf(text, start)),
              indexRange: rangeOf(index, source.indexOf(text, start) + objectText.length + 1),
            },
          });
          expect(result.referenceSites, source).toEqual([
            ...(position === 'argument' ? [call(`outer(${expression})`, 'outer', 1)] : []),
            call('keyOf(value)', 'keyOf', 1),
            read('value', 'keyOf('),
            call('valueOf(value)', 'valueOf', 1),
            read('value', 'valueOf('),
            {
              name: 'Item',
              kind: 'read',
              explicitReceiver: { name: 'Kinds' },
              inScope: scope.id,
              atRange: rangeOf('Kinds.Item'),
            },
            read('Kinds', '['),
            read('value', '[Kinds.Item]: '),
            selection('table[indexes[key]]', 'table', 'indexes[key]'),
            read('table', '[Kinds.Item]: '),
            selection('indexes[key]', 'indexes', 'key'),
            read('indexes', 'table['),
            read('key', 'indexes['),
            read('tail', '[table[indexes[key]]]: '),
            read('value', '/* key */ (('),
            read('value', '((value))]: '),
            read('value', '["__proto__"]: '),
            ...(position === 'if'
              ? [
                  call(
                    'branch()',
                    'branch',
                    0,
                    result.scopes.filter((scope) => scope.kind === 'Block')[2]!.id,
                  ),
                ]
              : []),
          ]);
          expect(
            captures.filter((match) => match['@reference.read.computed']),
            source,
          ).toHaveLength(2);
          expect(
            new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
              .size,
            source,
          ).toBe(result.referenceSites.length);
          const fields = buildFieldRegistry(
            buildScopeRegistryContext(finalizeScopeModel([result])),
          );
          expect(fields.lookup('value', scope.id)[0]!.def.nodeId, source).toBe(
            scope.ownedDefs.find((def) => def.qualifiedName === 'value')!.nodeId,
          );
          expect(captures, source).toEqual(independent);
          for (const [index, match] of captures.entries()) {
            for (const [name, capture] of Object.entries(match)) {
              expect(capture).not.toBe(independent[index]![name]);
              expect(capture.range).not.toBe(independent[index]![name]!.range);
            }
          }
          parser.parse('replacement();');
          expect(JSON.stringify(captures), source).toBe(saved);
          expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
        }
      }
    },
  );

  it.each(filePaths)(
    'keeps mixed computed pairs, spreads and arrow reads in their lexical scopes in %s',
    async (filePath) => {
      const source =
        'function owner() { { const object = {...spread, [key]: {...other, [again]: value => ({[value]: closed})}, [last]: tail}; } }';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError, source).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const lexical = result.scopes.filter((scope) => scope.kind === 'Block')[1]!;
      const arrow = result.scopes.find(
        (scope) => scope.kind === 'Function' && scope.ownerDefId === null,
      )!;
      expect(result.referenceSites).toEqual(
        [
          ['spread', lexical.id],
          ['key', lexical.id],
          ['other', lexical.id],
          ['again', lexical.id],
          ['value', arrow.id],
          ['closed', arrow.id],
          ['last', lexical.id],
          ['tail', lexical.id],
        ].map(([name, inScope]) => {
          const startCol = source.indexOf(
            name!,
            name === 'value' ? source.indexOf('({[value]') : source.indexOf('{...spread'),
          );
          return {
            name,
            kind: 'read',
            inScope,
            atRange: { startLine: 1, startCol, endLine: 1, endCol: startCol + name!.length },
          };
        }),
      );
      expect(result.scopes.map((scope) => scope.kind)).toEqual([
        'Module',
        'Function',
        'Block',
        'Block',
        'Function',
      ]);
      expect(arrow.parent).toBe(lexical.id);
      expect(captures.some((match) => match['@reference.read.computed'])).toBe(false);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'rejects unsupported computed keys and values atomically in either order in %s',
    async (filePath) => {
      const unsupported = [
        'key?.[index].deep',
        'key = value',
        '(key, value)',
        'delete key',
        'delete key',
        'key?.()',
        'object[key]()',
        '() => { return this; }',
        ...(/\.tsx?$/.test(filePath) ? ['key as typeof Shape', 'key<Type>()'] : []),
      ];
      for (const bad of unsupported) {
        for (const property of [`[${bad}]: valid()`, `[valid()]: ${bad}`]) {
          for (const object of [
            `{[good()]: first(), ${property}}`,
            `{${property}, [good()]: first()}`,
          ]) {
            for (const statement of [
              `const item = ${object};`,
              `consume(${object});`,
              `return ${object};`,
            ]) {
              const source = `before(); function owner() { ${statement} } after();`;
              const { root } = await parse(source, filePath);
              let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
              expect(() => {
                captures = emitTypeScriptCaptures(root);
              }, source).toThrow(ScopeUnsupportedSyntaxError);
              expect(captures, source).toBeUndefined();
            }
          }
        }
      }
      for (const object of [
        '{[]: value}',
        '{[key]:}',
        '{[key: value}',
        '{[key]: value',
        '{[key]() {}}',
      ]) {
        for (const source of [
          `before(); const item = ${object};`,
          `const item = ${object}; after();`,
        ]) {
          const { root } = await parse(source, filePath);
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, source).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, source).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'captures exact shorthand value reads in every expression position in %s',
    async (filePath) => {
      const object =
        '{/* shorthand */ value, café, __proto__, alias: value, nested: [{value}, inner({café})], /* duplicate */ value,}';
      for (const expression of [
        object,
        ...(/\.tsx?$/.test(filePath) ? [`${object} as const`] : []),
      ]) {
        for (const position of [
          'initializer',
          'argument',
          'return',
          'throw',
          'standalone',
          'if',
        ] as const) {
          const statement = {
            initializer: `const item = (${expression});`,
            argument: `outer(${expression}, {});`,
            return: `return (${expression});`,
            throw: `throw (${expression});`,
            standalone: `(${expression});`,
            if: `if ((${expression})) { branch(); }`,
          }[position];
          const source = `const value = 1;\nfunction owner(value, café, __proto__) {\n { let value; ${statement} }\n}`;
          const { parser, root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          const captures = emitTypeScriptCaptures(root);
          const saved = JSON.stringify(captures);
          const result = extract(captures, filePath, hooks);
          const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
          const lexical = blocks[1]!;
          const rangeOf = (text: string, from = source.indexOf(statement)) => {
            const offset = source.indexOf(text, from);
            expect(offset, text).toBeGreaterThanOrEqual(from);
            const before = source.slice(0, offset).split('\n');
            const through = source.slice(0, offset + text.length).split('\n');
            return {
              startLine: before.length,
              startCol: before.at(-1)!.length,
              endLine: through.length,
              endCol: through.at(-1)!.length,
            };
          };
          const read = (name: string, marker: string) => ({
            name,
            kind: 'read',
            inScope: lexical.id,
            atRange: rangeOf(name, source.indexOf(marker, source.indexOf(object)) + marker.length),
          });
          const call = (text: string, name: string, arity: number, inScope = lexical.id) => ({
            name,
            kind: 'call',
            callForm: 'free',
            arity,
            inScope,
            atRange: rangeOf(text),
          });
          expect(result.referenceSites, source).toEqual([
            ...(position === 'argument' ? [call(`outer(${expression}, {})`, 'outer', 2)] : []),
            read('value', '/* shorthand */ '),
            read('café', 'value, '),
            read('__proto__', 'café, '),
            read('value', 'alias: '),
            read('value', 'nested: [{'),
            call('inner({café})', 'inner', 1),
            read('café', 'inner({'),
            read('value', '/* duplicate */ '),
            ...(position === 'if' ? [call('branch()', 'branch', 0, blocks[2]!.id)] : []),
          ]);
          expect(
            result.scopes.map((scope) => scope.kind),
            source,
          ).toEqual([
            'Module',
            'Function',
            'Block',
            'Block',
            ...(position === 'if' ? ['Block'] : []),
          ]);
          const local = lexical.ownedDefs.find((def) => def.qualifiedName === 'value')!;
          const fields = buildFieldRegistry(
            buildScopeRegistryContext(finalizeScopeModel([result])),
          );
          expect(fields.lookup('value', lexical.id)[0]!.def.nodeId, source).toBe(local.nodeId);
          expect(local.nodeId, source).not.toBe(
            result.localDefs.find((def) => def.qualifiedName === 'value')!.nodeId,
          );
          expect(
            new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
              .size,
            source,
          ).toBe(result.referenceSites.length);
          parser.parse('replacement();');
          expect(JSON.stringify(captures), source).toBe(saved);
          expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
        }
      }
    },
  );

  it.each(filePaths)('refuses shorthand destructuring atomically in %s', async (filePath) => {
    for (const statement of [
      'const {value} = input;',
      'let [[value]] = input;',
      '({value} = input);',
      'for (var {value} of items) {}',
    ]) {
      for (const body of [`before({value}); ${statement}`, `${statement} after({value});`]) {
        const source = `export const retained = 1; function owner(value) { ${body} }`;
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        expect(() => emitTypeScriptCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
      }
    }
  });

  it.each(filePaths)(
    'visits object receiver-call values exactly once before outer arguments in %s',
    async (filePath) => {
      const source = 'factory({first: a}).method({second: b(), nested: [{third: c}]}, d);';
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      expect(
        result.referenceSites.map(({ name, kind, arity, callForm, inScope, atRange }) => ({
          name,
          kind,
          arity,
          callForm,
          inScope,
          atRange,
        })),
      ).toEqual(
        [
          ['method', 'call', 2, 'member', source.slice(0, -1)],
          ['factory', 'call', 1, 'free', 'factory({first: a})'],
          ['a', 'read', undefined, undefined, 'a}'],
          ['b', 'call', 0, 'free', 'b()'],
          ['c', 'read', undefined, undefined, 'c}'],
          ['d', 'read', undefined, undefined, 'd)'],
        ].map(([name, kind, arity, callForm, text]) => {
          const startCol = source.indexOf(text as string);
          return {
            name,
            kind,
            arity,
            callForm,
            inScope: result.moduleScope,
            atRange: {
              startLine: 1,
              startCol,
              endLine: 1,
              endCol: startCol + (kind === 'read' ? 1 : (text as string).length),
            },
          };
        }),
      );
      expect(
        new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
          .size,
      ).toBe(result.referenceSites.length);
    },
  );

  it.each(filePaths)(
    'owns object method and getter bodies without binding property names in %s',
    async (filePath) => {
      const source =
        'let closed; const object = { method(value) { const local = value; return other => pair(local, other, closed); }, get selected() { return closed; } }; after(object);';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const [module, method, body, closure, getter, getterBody] = result.scopes;
      const rangeOf = (node: typeof root) => ({
        startLine: node.startPosition.row + 1,
        startCol: node.startPosition.column,
        endLine: node.endPosition.row + 1,
        endCol: node.endPosition.column,
      });
      const methods = root.descendantsOfType('method_definition');
      const arrow = root.descendantsOfType('arrow_function')[0]!;
      expect(result.scopes.map((scope) => scope.kind)).toEqual([
        'Module',
        'Function',
        'Block',
        'Function',
        'Function',
        'Block',
      ]);
      expect(result.scopes.slice(1).map((scope) => [scope.range, scope.parent])).toEqual([
        [rangeOf(methods[0]!), module!.id],
        [rangeOf(methods[0]!.childForFieldName('body')!), method!.id],
        [rangeOf(arrow), body!.id],
        [rangeOf(methods[1]!), module!.id],
        [rangeOf(methods[1]!.childForFieldName('body')!), getter!.id],
      ]);
      expect(result.scopes.map((scope) => [...scope.bindings.keys()])).toEqual([
        ['closed', 'object'],
        ['value'],
        ['local'],
        ['other'],
        [],
        [],
      ]);
      expect([method!.ownerDefId, getter!.ownerDefId]).toEqual([null, null]);
      expect(result.localDefs.every((def) => def.type === 'Variable')).toBe(true);
      expect(
        result.localDefs.some((def) => ['method', 'selected'].includes(def.qualifiedName)),
      ).toBe(false);
      const calls = root.descendantsOfType('call_expression');
      const localValue = root
        .descendantsOfType('variable_declarator')
        .find((node) => node.childForFieldName('name')?.text === 'local')!
        .childForFieldName('value')!;
      const closedReturn = methods[1]!.descendantsOfType('return_statement')[0]!.namedChildren[0]!;
      const ordered = [
        [localValue, body!],
        [calls[0]!, closure!],
        ...calls[0]!
          .childForFieldName('arguments')!
          .namedChildren.map((node) => [node, closure!] as const),
        [closedReturn, getterBody!],
        [calls[1]!, module!],
        [calls[1]!.childForFieldName('arguments')!.namedChildren[0]!, module!],
      ] as const;
      expect(result.referenceSites).toEqual(
        ordered.map(([node, scope]) =>
          node.type === 'call_expression'
            ? {
                name: node.childForFieldName('function')!.text,
                kind: 'call',
                callForm: 'free',
                arity: node.childForFieldName('arguments')!.namedChildCount,
                atRange: rangeOf(node),
                inScope: scope.id,
              }
            : { name: node.text, kind: 'read', atRange: rangeOf(node), inScope: scope.id },
        ),
      );
      const resolved = [
        ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
      ].flat();
      for (const site of result.referenceSites.filter((site) => site.kind === 'read')) {
        const owner =
          site.name === 'value'
            ? method!
            : site.name === 'local'
              ? body!
              : site.name === 'other'
                ? closure!
                : module!;
        expect(
          resolved.find(
            (reference) => JSON.stringify(reference.atRange) === JSON.stringify(site.atRange),
          ),
        ).toMatchObject({
          toDef: owner.bindings.get(site.name)![0]!.def.nodeId,
          fromScope: site.inScope,
        });
      }
      parser.parse('const replacement = {};');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'reuses supported statement validation inside object methods in %s',
    async (filePath) => {
      const annotation = /\.tsx?$/.test(filePath) ? ': Value' : '';
      const source = `const object = { method(value${annotation})${annotation} { var repeated = value; if (ready) { repeated = next(value); } try { return repeated; } catch (error) { throw error; } }, get selected()${annotation} { return fallback; }, get() { return source; } };`;
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      expect(result.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
        ['value', 'read'],
        ['ready', 'read'],
        ['repeated', 'write'],
        ['next', 'call'],
        ['value', 'read'],
        ['repeated', 'read'],
        ['error', 'read'],
        ['fallback', 'read'],
        ['source', 'read'],
      ]);
      expect(
        result.scopes
          .filter((scope) => scope.kind === 'Function')
          .map((scope) => [...scope.bindings.keys()]),
      ).toEqual([['value', 'repeated'], [], []]);
      expect(result.localDefs.some((def) => def.type === 'Method')).toBe(false);
    },
  );

  it.each(filePaths)(
    'captures switch discriminants, labels and case bodies in source order with one lexical scope in %s',
    async (filePath) => {
      const source =
        'function owner(value, label, outer) { switch (value) { case 1: let selected = outer; use(selected); case label: { let selected = value; use(selected); } default: finish(value); case 3: outer = value; } }';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const serialized = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const method = root.descendantsOfType('function_declaration')[0]!;
      const switchNode = root.descendantsOfType('switch_statement')[0]!;
      const switchBody = switchNode.childForFieldName('body')!;
      const rangeOf = (node: typeof root) => ({
        startLine: node.startPosition.row + 1,
        startCol: node.startPosition.column,
        endLine: node.endPosition.row + 1,
        endCol: node.endPosition.column,
      });
      const [module, fn, fnBody, switchScope, nestedBlock] = result.scopes;
      expect(result.scopes.map(({ kind }) => kind)).toEqual([
        'Module',
        'Function',
        'Block',
        'Block',
        'Block',
      ]);
      expect([fn!.range, fnBody!.range, switchScope!.range, nestedBlock!.range]).toEqual(
        [
          [method.startPosition, method.endPosition],
          [
            method.childForFieldName('body')!.startPosition,
            method.childForFieldName('body')!.endPosition,
          ],
          [switchBody.startPosition, switchBody.endPosition],
          [
            switchBody.descendantsOfType('statement_block')[0]!.startPosition,
            switchBody.descendantsOfType('statement_block')[0]!.endPosition,
          ],
        ].map(([start, end]) => ({
          startLine: start.row + 1,
          startCol: start.column,
          endLine: end.row + 1,
          endCol: end.column,
        })),
      );
      expect([
        module!.id,
        fn!.parent,
        fnBody!.parent,
        switchScope!.parent,
        nestedBlock!.parent,
      ]).toEqual([result.moduleScope, result.moduleScope, fn!.id, fnBody!.id, switchScope!.id]);
      expect([...fn!.bindings.keys()]).toEqual(['value', 'label', 'outer']);
      expect([...fnBody!.bindings.keys()]).toEqual([]);
      expect([...switchScope!.bindings.keys()]).toEqual(['selected']);
      expect(nestedBlock!.bindings.has('selected')).toBe(true);
      const refs = result.referenceSites;
      expect(
        refs.map(({ name, kind, inScope, atRange }) => [name, kind, inScope, atRange]),
      ).toEqual([
        [
          'value',
          'read',
          fnBody!.id,
          rangeOf(switchNode.childForFieldName('value')!.namedChildren[0]!),
        ],
        [
          'outer',
          'read',
          switchScope!.id,
          rangeOf(root.descendantsOfType('identifier').filter((node) => node.text === 'outer')[1]!),
        ],
        ['use', 'call', switchScope!.id, rangeOf(root.descendantsOfType('call_expression')[0]!)],
        [
          'selected',
          'read',
          switchScope!.id,
          rangeOf(
            root.descendantsOfType('identifier').filter((node) => node.text === 'selected')[1]!,
          ),
        ],
        [
          'label',
          'read',
          switchScope!.id,
          rangeOf(root.descendantsOfType('identifier').filter((node) => node.text === 'label')[1]!),
        ],
        [
          'value',
          'read',
          nestedBlock!.id,
          rangeOf(root.descendantsOfType('identifier').filter((node) => node.text === 'value')[2]!),
        ],
        ['use', 'call', nestedBlock!.id, rangeOf(root.descendantsOfType('call_expression')[1]!)],
        [
          'selected',
          'read',
          nestedBlock!.id,
          rangeOf(
            root.descendantsOfType('identifier').filter((node) => node.text === 'selected')[3]!,
          ),
        ],
        ['finish', 'call', switchScope!.id, rangeOf(root.descendantsOfType('call_expression')[2]!)],
        [
          'value',
          'read',
          switchScope!.id,
          rangeOf(root.descendantsOfType('identifier').filter((node) => node.text === 'value')[3]!),
        ],
        [
          'outer',
          'write',
          switchScope!.id,
          rangeOf(root.descendantsOfType('identifier').filter((node) => node.text === 'outer')[2]!),
        ],
        [
          'value',
          'read',
          switchScope!.id,
          rangeOf(root.descendantsOfType('identifier').filter((node) => node.text === 'value')[4]!),
        ],
      ]);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(serialized);
      expect(extract(JSON.parse(serialized), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)('rejects unsupported switch syntax atomically in %s', async (filePath) => {
    const statements = [
      'switch (value) { case 1: break; }',
      'switch (value) { default: one(); default: two(); }',
      'switch (value) { case label = 1: run(); }',
      'switch (value) { case 1: const nested = () => { return this; }; }',
      'switch (value) { case 1: var shared = value; }',
      'switch (value) { case 1: let shared = value; case 2: let shared = value; }',
    ];
    for (const statement of statements) {
      for (const body of [`before(); ${statement}`, `${statement} after();`]) {
        const source = `function owner(value) { ${body} }`;
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
        expect(() => {
          captures = emitTypeScriptCaptures(root);
        }, source).toThrow(ScopeUnsupportedSyntaxError);
        expect(captures, source).toBeUndefined();
      }
    }
  });

  it.each(filePaths)(
    'preserves switch boundary rules for loops, modules and function returns in %s',
    async (filePath) => {
      const accepted = [
        'function owner(value) { while (ready) { switch (value) { case 1: continue; } } }',
        'function owner(value) { switch (value) { case 1: return value; } }',
        'switch (value) { case 1: run(); }',
        'switch (value) {}',
        'switch /* comment */ ((value)) { case 1: case 1: run(); default: ; }',
        'function owner(value) { switch (value) { case 1: let shared = value; case 2: shared; } }',
        'function owner(value) { switch (value) { case 1: switch (value) { case 1: run(); } } }',
        'function owner(value) { switch (value) { case 1: if (ready) { run(); } } }',
      ];
      for (const source of accepted) {
        const { root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        expect(() => emitTypeScriptCaptures(root), source).not.toThrow();
      }
      for (const source of [
        'function owner(value) { switch (value) { case 1: continue; } }',
        'switch (value) { case 1: return value; }',
        'function owner(value) { switch (value) { case 1: var shared = value; } }',
      ]) {
        const { root } = await parse(source, filePath);
        let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
        expect(() => {
          captures = emitTypeScriptCaptures(root);
        }, source).toThrow(ScopeUnsupportedSyntaxError);
        expect(captures, source).toBeUndefined();
      }
      const malformed = 'function owner(value) { switch (value) { case 1: run(); }';
      const { root } = await parse(malformed, filePath);
      expect(root.hasError, malformed).toBe(true);
      expect(() => emitTypeScriptCaptures(root), malformed).toThrow(ScopeUnsupportedSyntaxError);
    },
  );

  it.each(filePaths)(
    'refuses unsupported object method headers and bodies atomically in %s',
    async (filePath) => {
      const properties = [
        'set value(input) {}',
        'get value(input) {}',
        'async method() {}',
        '*method() {}',
        '[key]() {}',
        '"method"() {}',
        'method(value = fallback) {}',
        'method(...values) {}',
        'method({value: {nested}}) {}',
        'method(value, value) {}',
        'method(value) { let value; }',
        'method(value) { const value = 1; }',
        'method() { return this; }',
        'method() { break; }',
        'method() { return value?.[key].deep; }',
        String.raw`escaped\u006bey() {}`,
        ...(/\.tsx?$/.test(filePath)
          ? ['method(this: Value) {}', 'method<T>() {}', 'method(): typeof value {}']
          : []),
      ];
      for (const property of properties) {
        for (const object of [
          `{ good: before(), ${property}, tail: after() }`,
          `{ ${property}, good: before() }`,
        ]) {
          for (const expression of [object, `[${object}]`, `consume(${object})`]) {
            const { root } = await parse(
              `const retained = 1; const object = ${expression}; after();`,
              filePath,
            );
            let captures;
            expect(() => {
              captures = emitTypeScriptCaptures(root);
            }, property).toThrow(ScopeUnsupportedSyntaxError);
            expect(captures).toBeUndefined();
          }
        }
      }
      for (const expression of [
        '{ method( {} }',
        '{ method() { return ; ',
        '{ get value( { return value; } }',
      ]) {
        const { root } = await parse(`before(); const object = ${expression}; after();`, filePath);
        expect(root.hasError).toBe(true);
        expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
      }
    },
  );

  it.each(filePaths)(
    'refuses unsupported object properties atomically in either order in %s',
    async (filePath) => {
      const properties = [
        '[key?.[index].deep]: value',
        '...values?.[key].deep',
        'async method() {}',
        'get field(value) {}',
        'set field(value) {}',
        '#private: value',
        'key: value?.[key].deep',
        'key: () => { return this; }',
        'key: [...values?.[key].deep]',
        'key: delete value',
        'key: tag`text`',
        '__proto__: value',
        '"__proto__": value',
        "'__proto__': value",
        String.raw`"escaped\u006bey": value`,
        String.raw`"escaped\\key": value`,
        String.raw`escaped\u006bey: value`,
        ...(/\.tsx?$/.test(filePath) ? ['key: value as typeof Shape'] : []),
      ];
      for (const bad of properties) {
        for (const object of [`{value, good: valid(), ${bad}}`, `{${bad}, good: valid(), value}`]) {
          for (const statement of [
            `const item = ${object};`,
            `outer(${object});`,
            `return ${object};`,
            `throw ${object};`,
            `(${object});`,
            `if (${object}) { branch(); }`,
          ]) {
            for (const body of [`before(); ${statement}`, `${statement} after();`]) {
              const source = `export const retained = 1; function owner(value) { ${body} }`;
              const { root } = await parse(source, filePath);
              expect(() => emitTypeScriptCaptures(root), source).toThrow(
                ScopeUnsupportedSyntaxError,
              );
            }
          }
        }
      }
      for (const malformed of ['({key:});', '({key value});', '({key: value,);', '({key: value']) {
        for (const source of [`before(); ${malformed}`, `${malformed} after();`]) {
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(true);
          expect(() => emitTypeScriptCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
        }
      }
    },
  );

  it.each(filePaths)(
    'preserves every reference in a deep mixed object, array and call chain in %s',
    async (filePath) => {
      const depth = 96;
      const names = Array.from({ length: depth }, (_, index) => `call${index}`);
      const source = `(${names.map((name) => `{key: [${name}(`).join('')}leaf${')]}'.repeat(depth)});`;
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      expect(
        result.referenceSites.map(({ name, kind, callForm, arity, inScope }) => ({
          name,
          kind,
          callForm,
          arity,
          inScope,
        })),
      ).toEqual([
        ...names.map((name) => ({
          name,
          kind: 'call',
          callForm: 'free',
          arity: 1,
          inScope: result.moduleScope,
        })),
        {
          name: 'leaf',
          kind: 'read',
          callForm: undefined,
          arity: undefined,
          inScope: result.moduleScope,
        },
      ]);
      expect(result.scopes.map((scope) => scope.kind)).toEqual(['Module']);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'captures dense arrays in every expression position with lexical ownership in %s',
    async (filePath) => {
      const array =
        '[/* first */ value, inner([missing,]), new Box([true, false, null, 0, "text", 123n,]), obj.method([value]), (([café,])), [],]';
      for (const position of [
        'initializer',
        'argument',
        'return',
        'throw',
        'standalone',
        'if',
      ] as const) {
        const statement = {
          initializer: `const items = (${array});`,
          argument: `outer(${array}, []);`,
          return: `return (${array});`,
          throw: `throw (${array});`,
          standalone: `(${array});`,
          if: `if ((${array})) { branch(); }`,
        }[position]!;
        const source = `const value = 1;\nfunction owner(value, obj, café) {\n { let value; ${statement} }\n}`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
        const lexical = blocks[1]!;
        const start = source.indexOf(array);
        const rangeOf = (text: string, from = start) => {
          const offset = source.indexOf(text, from);
          expect(offset, text).toBeGreaterThanOrEqual(from);
          const before = source.slice(0, offset).split('\n');
          const through = source.slice(0, offset + text.length).split('\n');
          return {
            startLine: before.length,
            startCol: before.at(-1)!.length,
            endLine: through.length,
            endCol: through.at(-1)!.length,
          };
        };
        const read = (name: string, from = start) => ({
          name,
          kind: 'read',
          inScope: lexical.id,
          atRange: rangeOf(name, from),
        });
        const call = (
          text: string,
          name: string,
          callForm: string,
          arity: number,
          inScope = lexical.id,
        ) => ({
          name,
          kind: 'call',
          callForm,
          arity,
          inScope,
          atRange: rangeOf(text, source.indexOf(statement)),
          ...(callForm === 'member' ? { explicitReceiver: { name: 'obj' } } : {}),
        });
        expect(result.referenceSites, source).toEqual([
          ...(position === 'argument' ? [call(`outer(${array}, [])`, 'outer', 'free', 2)] : []),
          read('value'),
          call('inner([missing,])', 'inner', 'free', 1),
          read('missing'),
          call('new Box([true, false, null, 0, "text", 123n,])', 'Box', 'constructor', 1),
          call('obj.method([value])', 'method', 'member', 1),
          read('obj'),
          read('value', source.indexOf('obj.method')),
          read('café'),
          ...(position === 'if' ? [call('branch()', 'branch', 'free', 0, blocks[2]!.id)] : []),
        ]);
        expect(
          result.scopes.map((scope) => scope.kind),
          source,
        ).toEqual([
          'Module',
          'Function',
          'Block',
          'Block',
          ...(position === 'if' ? ['Block'] : []),
        ]);
        const local = lexical.ownedDefs.find((def) => def.qualifiedName === 'value')!;
        const fields = buildFieldRegistry(buildScopeRegistryContext(finalizeScopeModel([result])));
        expect(fields.lookup('value', lexical.id)[0]!.def.nodeId, source).toBe(local.nodeId);
        expect(local.nodeId, source).not.toBe(
          result.localDefs.find((def) => def.qualifiedName === 'value')!.nodeId,
        );
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'visits array receiver-call arguments exactly once before outer arguments in %s',
    async (filePath) => {
      const source = 'factory([a]).method([b(), [c]], d);';
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
      expect(
        result.referenceSites.map(({ name, kind, arity, callForm, inScope, atRange }) => ({
          name,
          kind,
          arity,
          callForm,
          inScope,
          atRange,
        })),
      ).toEqual(
        [
          ['method', 'call', 2, 'member', source],
          ['factory', 'call', 1, 'free', 'factory([a])'],
          ['a', 'read', undefined, undefined, 'a]'],
          ['b', 'call', 0, 'free', 'b()'],
          ['c', 'read', undefined, undefined, 'c]'],
          ['d', 'read', undefined, undefined, 'd)'],
        ].map(([name, kind, arity, callForm, text]) => {
          const startCol = source.indexOf(text as string);
          return {
            name,
            kind,
            arity,
            callForm,
            inScope: result.moduleScope,
            atRange: {
              startLine: 1,
              startCol,
              endLine: 1,
              endCol:
                startCol +
                (kind === 'read' ? 1 : (text as string).length - (name === 'method' ? 1 : 0)),
            },
          };
        }),
      );
      expect(
        new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
          .size,
      ).toBe(result.referenceSites.length);
    },
  );

  it.each(filePaths)(
    'visits array spread operands once in source order with lexical arrow scopes in %s',
    async (filePath) => {
      const array =
        '[first, ... /* spread */ values, ...make(arg), ...[...nested, tail], ...((value => pair(value, closed))), last]';
      for (const statement of [
        `const items = ${array};`,
        `consume(${array});`,
        `return ${array};`,
        `throw ${array};`,
        `${array};`,
        `const items = {value: ${array}};`,
      ]) {
        const source = `function owner() { ${statement} }`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const body = result.scopes.find((scope) => scope.kind === 'Block')!;
        const arrow = result.scopes.filter((scope) => scope.kind === 'Function')[1]!;
        expect([...arrow.bindings.keys()]).toEqual(['value']);
        expect(arrow.parent).toBe(body.id);
        const rangeOf = (text: string, from = source.indexOf(array)) => {
          const startCol = source.indexOf(text, from);
          return { startLine: 1, startCol, endLine: 1, endCol: startCol + text.length };
        };
        const read = (name: string, inScope = body.id, from?: number) => ({
          name,
          kind: 'read',
          atRange: rangeOf(name, from),
          inScope,
        });
        const call = (text: string, name: string, arity: number, inScope = body.id) => ({
          name,
          kind: 'call',
          callForm: 'free',
          arity,
          atRange: rangeOf(text, name === 'consume' ? 0 : undefined),
          inScope,
        });
        expect(result.referenceSites).toEqual([
          ...(statement.startsWith('consume') ? [call(`consume(${array})`, 'consume', 1)] : []),
          read('first'),
          read('values'),
          call('make(arg)', 'make', 1),
          read('arg'),
          read('nested'),
          read('tail'),
          call('pair(value, closed)', 'pair', 2, arrow.id),
          read('value', arrow.id, source.indexOf('pair(')),
          read('closed', arrow.id),
          read('last'),
        ]);
        expect(
          new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
            .size,
        ).toBe(result.referenceSites.length);
        parser.parse('replacement();');
        expect(JSON.stringify(captures)).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
      }
    },
  );

  it.each(filePaths)(
    'visits object spread operands once with exact ranges and lexical arrow ownership in %s',
    async (filePath) => {
      const object =
        '{/* first */ first, ... /* spread */ values, ...make(arg), ...{...nested, tail}, ...((value => pair(value, closed))), empty: {}, last,}';
      for (const statement of [
        `const items = ${object};`,
        `consume(${object});`,
        `return ${object};`,
        `throw ${object};`,
        `(${object});`,
        `const items = [${object}];`,
      ]) {
        const source = `function owner() { ${statement} }`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const body = result.scopes.find((scope) => scope.kind === 'Block')!;
        const arrow = result.scopes.filter((scope) => scope.kind === 'Function')[1]!;
        expect([...arrow.bindings.keys()]).toEqual(['value']);
        expect(arrow.parent).toBe(body.id);
        expect(result.scopes.map((scope) => scope.kind)).toEqual([
          'Module',
          'Function',
          'Block',
          'Function',
        ]);
        const rangeOf = (text: string, from = source.indexOf(object)) => {
          const startCol = source.indexOf(text, from);
          expect(startCol, text).toBeGreaterThanOrEqual(from);
          return { startLine: 1, startCol, endLine: 1, endCol: startCol + text.length };
        };
        const read = (name: string, inScope = body.id, from?: number) => ({
          name,
          kind: 'read',
          atRange: rangeOf(name, from),
          inScope,
        });
        const call = (text: string, name: string, arity: number, inScope = body.id) => ({
          name,
          kind: 'call',
          callForm: 'free',
          arity,
          atRange: rangeOf(text, name === 'consume' ? 0 : undefined),
          inScope,
        });
        expect(result.referenceSites, source).toEqual([
          ...(statement.startsWith('consume') ? [call(`consume(${object})`, 'consume', 1)] : []),
          read('first', body.id, source.indexOf('*/ ') + 3),
          read('values'),
          call('make(arg)', 'make', 1),
          read('arg'),
          read('nested'),
          read('tail'),
          call('pair(value, closed)', 'pair', 2, arrow.id),
          read('value', arrow.id, source.indexOf('pair(')),
          read('closed', arrow.id),
          read('last'),
        ]);
        expect(
          new Set(result.referenceSites.map((site) => JSON.stringify([site.kind, site.atRange])))
            .size,
        ).toBe(result.referenceSites.length);
        parser.parse('replacement();');
        expect(JSON.stringify(captures)).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
      }
      for (const expression of [
        '{}',
        '{...{}}',
        '{...values,}',
        '{...{}, key: value, ...other,}',
      ]) {
        const { root } = await parse(`const items = ${expression};`, filePath);
        expect(root.hasError, expression).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        expect(
          result.referenceSites.map(({ name }) => name),
          expression,
        ).toEqual(
          expression.includes('other')
            ? ['value', 'other']
            : expression.includes('values')
              ? ['values']
              : [],
        );
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains ordinary assertion value evidence across runtime contexts in %s',
    async (filePath) => {
      const expression =
        '((make(input as Shape) as /* type */ Map<string, Shape[]>) satisfies Outer) as readonly [Shape, Other | null]';
      for (const position of [
        'initializer',
        'argument',
        'return',
        'throw',
        'standalone',
        'if',
        'array',
        'object',
        'assignment',
        'not',
        'binary',
        'template',
        'computed',
        'spread',
        'non-null',
        'arrow',
      ] as const) {
        const statement = {
          initializer: `const result = (${expression});`,
          argument: `consume((${expression}));`,
          return: `return (${expression});`,
          throw: `throw (${expression});`,
          standalone: `(${expression});`,
          if: `if (${expression}) { branch(); }`,
          array: `const result = [(${expression})];`,
          object: `const result = {value: (${expression})};`,
          assignment: `result = (${expression});`,
          not: `const result = !(${expression});`,
          binary: `const result = (${expression}) + 1;`,
          template: 'const result = `${' + expression + '}`;',
          computed: `const result = {[(${expression})]: 1};`,
          spread: `const result = {...(${expression})};`,
          'non-null': `const result = (${expression})!;`,
          arrow: `const callback = () => (${expression});`,
        }[position];
        const source = `const input = 1;\nfunction owner(input) {\n { let input; ${statement} }\n}`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const blocks = result.scopes.filter((scope) => scope.kind === 'Block');
        const lexical = blocks[1]!;
        const valueScope =
          position === 'arrow'
            ? result.scopes.find(
                (scope) =>
                  scope.ownerDefId ===
                  result.localDefs.find((def) => def.qualifiedName === 'callback')?.nodeId,
              )!
            : lexical;
        const rangeOf = (text: string) => {
          const start = source.indexOf(text, source.indexOf(statement));
          expect(start, text).toBeGreaterThanOrEqual(source.indexOf(statement));
          const before = source.slice(0, start).split('\n');
          return {
            startLine: before.length,
            startCol: before.at(-1)!.length,
            endLine: before.length,
            endCol: before.at(-1)!.length + text.length,
          };
        };
        expect(result.referenceSites, source).toEqual([
          ...(position === 'assignment'
            ? [{ name: 'result', kind: 'write', inScope: lexical.id, atRange: rangeOf('result') }]
            : []),
          ...(position === 'argument'
            ? [
                {
                  name: 'consume',
                  kind: 'call',
                  callForm: 'free',
                  arity: 1,
                  inScope: lexical.id,
                  atRange: rangeOf(`consume((${expression}))`),
                },
              ]
            : []),
          {
            name: 'make',
            kind: 'call',
            callForm: 'free',
            arity: 1,
            inScope: valueScope.id,
            atRange: rangeOf('make(input as Shape)'),
          },
          { name: 'input', kind: 'read', inScope: valueScope.id, atRange: rangeOf('input') },
          ...(position === 'if'
            ? [
                {
                  name: 'branch',
                  kind: 'call',
                  callForm: 'free',
                  arity: 0,
                  inScope: blocks[2]!.id,
                  atRange: rangeOf('branch()'),
                },
              ]
            : []),
        ]);
        expect(result.scopes.flatMap((scope) => [...scope.typeBindings.values()])).toEqual([]);
        expect(
          result.localDefs.find((def) => def.qualifiedName === 'result')?.declaredType,
        ).toBeUndefined();
        expect(
          result.localDefs.some((def) =>
            ['Shape', 'Outer', 'Other', 'Map'].includes(def.qualifiedName),
          ),
        ).toBe(false);
        const fields = buildFieldRegistry(buildScopeRegistryContext(finalizeScopeModel([result])));
        expect(fields.lookup('input', valueScope.id)[0]!.def.nodeId).toBe(
          lexical.ownedDefs.find((def) => def.qualifiedName === 'input')!.nodeId,
        );
        parser.parse('replacement();');
        expect(JSON.stringify(captures)).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'accepts supported assertion types and const combinations without inferred types in %s',
    async (filePath) => {
      for (const expression of [
        ...[
          'Shape',
          'Models.Shape',
          'string',
          '"ready" | null',
          'Shape[]',
          'Map<string, Shape[]>',
          'Shape["member"]',
          '[]',
          '[Shape]',
          '[Shape,]',
          '[Shape, Other]',
          'readonly [Shape[], [Other | null, Array<Shape>]]',
        ].map((type) => `make(input) as ${type}`),
        '[input as Shape, 0 as const] as const',
        '({value: input} as const) as Shape',
        '([input] as const) satisfies readonly [Shape]',
        '([input] satisfies [Shape]) as readonly [Shape]',
        '[] as [Shape] as readonly [Other]',
        '{} as Shape',
      ]) {
        const source = `const result = (${expression});`;
        const { parser, root } = await parse(source, filePath);
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        expect(
          result.referenceSites.map(({ name, kind }) => [name, kind]),
          source,
        ).toEqual(
          expression.startsWith('make')
            ? [
                ['make', 'call'],
                ['input', 'read'],
              ]
            : expression.includes('input')
              ? [['input', 'read']]
              : [],
        );
        expect(result.localDefs.map((def) => def.qualifiedName)).toEqual(['result']);
        expect(result.localDefs[0]!.declaredType).toBeUndefined();
        expect(result.scopes.flatMap((scope) => [...scope.typeBindings.values()])).toEqual([]);
        parser.parse('replacement();');
        expect(JSON.stringify(captures)).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains explicit annotations and tuple constructor arguments beside assertions in %s',
    async (filePath) => {
      const source =
        'let result: Existing = input as Shape; const box = new Box<[Shape, Other]>(input as Shape);';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, typescriptProvider);
      expect(result.scopes[0]!.typeBindings.get('result')?.rawName).toBe('Existing');
      expect(
        result.referenceSites.map(({ name, kind, callForm, arity }) => ({
          name,
          kind,
          callForm,
          arity,
        })),
      ).toEqual([
        { name: 'input', kind: 'read', callForm: undefined, arity: undefined },
        { name: 'Box', kind: 'call', callForm: 'constructor', arity: 1 },
        { name: 'input', kind: 'read', callForm: undefined, arity: undefined },
      ]);
      expect(
        result.scopes
          .flatMap((scope) => [...scope.typeBindings.values()])
          .some((ref) => ['Shape', 'Other', '[Shape, Other]'].includes(ref.rawName)),
      ).toBe(false);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, typescriptProvider)).toEqual(result);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains computed selection evidence through an asserted object in %s',
    async (filePath) => {
      const expression = '(value as Shape)[key]';
      const source = `const result = ${expression};`;
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const saved = JSON.stringify(captures);
      const result = extract(captures, filePath, hooks);
      const rangeOf = (text: string) => {
        const startCol = source.indexOf(text);
        return { startLine: 1, startCol, endLine: 1, endCol: startCol + text.length };
      };
      expect(result.referenceSites).toEqual([
        {
          kind: 'read',
          inScope: result.moduleScope,
          atRange: rangeOf(expression),
          selection: {
            kind: 'computed',
            objectRange: rangeOf('(value as Shape)'),
            indexRange: rangeOf('key'),
          },
        },
        { name: 'value', kind: 'read', inScope: result.moduleScope, atRange: rangeOf('value') },
        { name: 'key', kind: 'read', inScope: result.moduleScope, atRange: rangeOf('key') },
      ]);
      expect(result.scopes.flatMap((scope) => [...scope.typeBindings.values()])).toEqual([]);
      expect(result.localDefs.map((def) => def.qualifiedName)).toEqual(['result']);
      expect(result.localDefs[0]!.declaredType).toBeUndefined();
      expect(resolveReferences(finalizeScopeModel([result])).stats).toEqual({
        totalSites: 3,
        resolvedSites: 0,
        unresolvedSites: 2,
        ambiguousSites: 0,
        unsupportedSites: 1,
      });
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(saved);
      expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'refuses unsupported assertion types and reference positions atomically in %s',
    async (filePath) => {
      const expressions = [
        ...[
          'typeof Shape',
          'Shape & Other',
          '() => typeof Shape',
          '{key(): Shape}',
          '[name: Shape]',
          '[Shape?]',
          '[...Shape[]]',
          '[Shape, ...Other[]]',
          '[typeof Shape]',
          '[Shape & Other]',
          'Array<[Shape?]>',
        ].map((type) => `value as ${type}`),
        '/pattern/zz as Shape',
        'value?.[key].deep as Shape',
        '(() => { return this; }) as Shape',
        '(value as Shape)()',
        '(value as const).field',
        '(value as const).method()',
        'new (value as Shape)()',
        '<Shape>value',
        '<const>[]',
        'value as const',
        '(value as Shape) as const',
        '([] as Shape) as const',
        'value as',
        'value as Map<',
        'value as [,]',
        'value as [Shape,, Other]',
        'value as [Shape,,]',
        'value as [Shape',
      ];
      for (const expression of expressions) {
        for (const statement of [
          `const result = [good(), (${expression})];`,
          `consume((${expression}), good());`,
        ]) {
          const { root } = await parse(
            `before(); function owner() { ${statement} } after();`,
            filePath,
          );
          let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, statement).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures, statement).toBeUndefined();
        }
      }
      for (const statement of [
        '(value as Shape) = other;',
        '(value as Shape) += other;',
        '(value as Shape)++;',
        '++(value as Shape);',
      ]) {
        const { root } = await parse(
          `before(); function owner() { ${statement} } after();`,
          filePath,
        );
        let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
        expect(() => {
          captures = emitTypeScriptCaptures(root);
        }, statement).toThrow(ScopeUnsupportedSyntaxError);
        expect(captures, statement).toBeUndefined();
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'visits satisfies values without runtime type reads or inferred bindings in %s',
    async (filePath) => {
      for (const type of [
        'Shape',
        'Map<string, Array<Shape | null>>',
        'Shape | Other',
        'Shape["member"]',
        '[]',
        '[Shape, Other]',
        'readonly [Shape[], [Other | null]]',
      ]) {
        for (const expression of [
          `make(input) satisfies /* type */ ${type}`,
          `((make(input) satisfies ${type}) satisfies Outer)`,
        ]) {
          for (const statement of [
            `const result = (${expression});`,
            `(${expression});`,
            `return (${expression});`,
            `consume((${expression}));`,
            `const result = {nested: [(${expression})]};`,
          ]) {
            const source = `function owner(input) { ${statement} }`;
            const { parser, root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            const captures = emitTypeScriptCaptures(root);
            const saved = JSON.stringify(captures);
            const result = extract(captures, filePath, hooks);
            const body = result.scopes.find((scope) => scope.kind === 'Block')!;
            const rangeOf = (text: string) => {
              const startCol = source.indexOf(text, source.indexOf(statement));
              expect(startCol, text).toBeGreaterThanOrEqual(0);
              return { startLine: 1, startCol, endLine: 1, endCol: startCol + text.length };
            };
            expect(result.referenceSites, source).toEqual([
              ...(statement.startsWith('consume')
                ? [
                    {
                      name: 'consume',
                      kind: 'call',
                      callForm: 'free',
                      arity: 1,
                      inScope: body.id,
                      atRange: rangeOf(`consume((${expression}))`),
                    },
                  ]
                : []),
              {
                name: 'make',
                kind: 'call',
                callForm: 'free',
                arity: 1,
                inScope: body.id,
                atRange: rangeOf('make(input)'),
              },
              { name: 'input', kind: 'read', inScope: body.id, atRange: rangeOf('input') },
            ]);
            expect(result.scopes.map((scope) => scope.kind)).toEqual([
              'Module',
              'Function',
              'Block',
            ]);
            expect(result.scopes.flatMap((scope) => [...scope.typeBindings.values()])).toEqual([]);
            expect(
              result.localDefs.find((def) => def.qualifiedName === 'result')?.declaredType,
            ).toBeUndefined();
            parser.parse('replacement();');
            expect(JSON.stringify(captures)).toBe(saved);
            expect(extract(JSON.parse(saved), filePath, hooks)).toEqual(result);
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'refuses unsupported object spread operands and malformed spreads atomically in %s',
    async (filePath) => {
      for (const expression of [
        '{...value?.[key].deep}',
        '{...(() => { return this; })}',
        '{...value as typeof Shape}',
        '{...}',
        '{...values ...other}',
        '{...values,,}',
        'consume(...make())',
        'new Box(...make())',
      ]) {
        for (const body of [
          `before(); const items = ${expression};`,
          `const items = ${expression}; after();`,
        ]) {
          const { root } = await parse(`const retained = 1; ${body}`, filePath);
          let captures;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, expression).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures).toBeUndefined();
        }
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'refuses unsupported satisfies types, operands and call positions atomically in %s',
    async (filePath) => {
      for (const expression of [
        'value satisfies typeof other',
        'value satisfies (() => typeof Shape)',
        'value satisfies {key(): Shape}',
        'value?.[key].deep satisfies Shape',
        '(value satisfies Shape)()',
        '(value satisfies Shape).method()',
        'consume(...(value satisfies Shape))',
        'value satisfies',
        'value satisfies Map<',
      ]) {
        for (const body of [
          `before(); const result = (${expression});`,
          `const result = (${expression}); after();`,
        ]) {
          const { root } = await parse(`const retained = 1; ${body}`, filePath);
          let captures;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, expression).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'refuses malformed array spreads and unsupported argument spreads atomically in %s',
    async (filePath) => {
      for (const expression of [
        '[...value?.[key].deep]',
        '[...(() => { return this; })]',
        '[...{...value?.[key].deep}]',
        'consume(...make())',
        'new Box(...[values])',
        'consume([value], ...values?.[key])',
        '[...values,,]',
        '[...values ...other]',
        '[...]',
      ]) {
        for (const statement of [
          `before(); const items = ${expression};`,
          `const items = ${expression}; after();`,
        ]) {
          const { root } = await parse(`const retained = 1; ${statement}`, filePath);
          let captures;
          expect(() => {
            captures = emitTypeScriptCaptures(root);
          }, expression).toThrow(ScopeUnsupportedSyntaxError);
          expect(captures).toBeUndefined();
        }
      }
    },
  );

  it.each(filePaths)(
    'refuses unsupported array elements and receivers atomically in %s',
    async (filePath) => {
      const unsupported = [
        '[,]',
        '[value,,]',
        '[,value]',
        '[...values?.[key].deep]',
        '[{...value?.[key].deep}]',
        '[value?.[key].deep]',
        '[async function () {}]',
        '[() => { return this; }]',
        '[delete value]',
        '[tag`text`]',
        '[delete value].method()',
        '([delete value]).method()',
        ...(/\.tsx?$/.test(filePath) ? ['[value as typeof Shape]', '[value as const]'] : []),
      ];
      for (const bad of unsupported) {
        for (const value of [`[good(), ${bad}]`, `[${bad}, good()]`]) {
          for (const statement of [
            `const items = ${value};`,
            `outer(${value});`,
            `return ${value};`,
            `throw ${value};`,
            `${value};`,
            `if (${value}) { branch(); }`,
          ]) {
            for (const body of [`before(); ${statement}`, `${statement} after();`]) {
              const source = `export const retained = 1; function owner(value) { ${body} }`;
              const { root } = await parse(source, filePath);
              expect(root.hasError, source).toBe(false);
              expect(() => emitTypeScriptCaptures(root), source).toThrow(
                ScopeUnsupportedSyntaxError,
              );
            }
          }
        }
      }
    },
  );

  it.each(filePaths)(
    'preserves every reference in a deep mixed array and call chain in %s',
    async (filePath) => {
      const depth = 128;
      const names = Array.from({ length: depth }, (_, index) => `call${index}`);
      const source = `${names.map((name) => `([${name}(`).join('')}leaf${')])'.repeat(depth)};`;
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const result = extract(captures, filePath, hooks);
      expect(
        result.referenceSites.map(({ name, kind, callForm, arity, inScope }) => ({
          name,
          kind,
          callForm,
          arity,
          inScope,
        })),
      ).toEqual([
        ...names.map((name) => ({
          name,
          kind: 'call',
          callForm: 'free',
          arity: 1,
          inScope: result.moduleScope,
        })),
        {
          name: 'leaf',
          kind: 'read',
          callForm: undefined,
          arity: undefined,
          inScope: result.moduleScope,
        },
      ]);
      expect(result.scopes.map((scope) => scope.kind)).toEqual(['Module']);
      parser.parse('replacement();');
      expect(extract(JSON.parse(JSON.stringify(captures)), filePath, hooks)).toEqual(result);
    },
  );

  it.each(filePaths)(
    'preserves all references through a moderately deep argument chain in %s',
    async (filePath) => {
      const depth = 128;
      const names = Array.from({ length: depth }, (_, index) => `call${index}`);
      for (const grouped of [false, true]) {
        const source = grouped
          ? `${names.map((name) => `(${name}(`).join('')}(1)${'))'.repeat(depth)};`
          : `${names.map((name) => `${name}(`).join('')}1${')'.repeat(depth)};`;
        const { root } = await parse(source, filePath);
        expect(root.hasError).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, hooks);
        expect(
          result.referenceSites.map(({ name, callForm, arity, inScope }) => ({
            name,
            callForm,
            arity,
            inScope,
          })),
        ).toEqual(
          names.map((name) => ({ name, callForm: 'free', arity: 1, inScope: result.moduleScope })),
        );
        expect(result.scopes.map((scope) => scope.kind)).toEqual(['Module']);
      }
    },
  );

  it.each(filePaths)('rejects unsupported grouped values atomically in %s', async (filePath) => {
    const unsupported = [
      '(value?.[key].deep)',
      '(1, good())',
      '(value?.())',
      '(obj?.[key]?.())',
      '(obj[key]?.())',
      '(obj[key]())',
      '(value()())',
      '(new Namespace.Box())',
      '(value)()',
      '(obj.method)()',
      '(obj?.[key]).method()',
      'new (Box)()',
    ];
    for (const expression of unsupported) {
      for (const statement of [
        `outer(good(), ${expression});`,
        `const good = valid(), bad = (${expression});`,
      ]) {
        for (const source of [
          `export const retained = 1;\nvalid();\n${statement}`,
          `${statement}\nvalid();\nexport const retained = 1;`,
        ]) {
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          expect(() => emitTypeScriptCaptures(root), source).toThrow();
        }
      }
    }
    for (const source of [
      'valid();\n((1));',
      'const good = valid(), bad = ((value?.[key].deep));',
    ]) {
      const { root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      expect(() => emitTypeScriptCaptures(root)).toThrow();
    }
  });

  it.each(filePaths)(
    'rejects unsupported call forms without partial output in %s',
    async (filePath) => {
      const supported =
        "import { Value } from './module';\nexport const literal = 1;\nvalue();\nobject.method(true);\nnew Value;";
      const nonliteral = [
        'value?.[key].deep',
        '() => { return this; }',
        '{...value?.[key].deep}',
        '[...values?.[key].deep]',
        '...make()',
        'delete value',
        'tag`text`',
        '/pattern/zz',
        String.raw`\u0076alue`,
      ];
      const unsupported = [
        ...nonliteral.flatMap((argument) => [
          `value(${argument});`,
          `object.method(${argument});`,
          `new Value(${argument});`,
        ]),
        'value?.();',
        'object?.[key]?.();',
        'object[key]?.();',
        'object[key]();',
        'new Namespace.Value();',
        'new object[key]();',
        '(value)();',
        'value()();',
        'class Body { static method() { new Value; } }',
      ];
      for (const statement of unsupported) {
        for (const source of [`${supported}\n${statement}`, `${statement}\n${supported}`]) {
          const { root } = await parse(source, filePath);
          expect(root.hasError, source).toBe(false);
          expect(() => emitTypeScriptCaptures(root), source).toThrow();
        }
      }
    },
  );

  it('detaches independent plain captures before parser reuse', async () => {
    const filePath = 'fixture.ts';
    const { parser, root } = await parse(
      "import { Value } from './module';\nexport const literal = (('value'));\nlet pending;\nvar repeated;\nexport var repeated = (1);\nexport function local(first, second /* optional */ ?) { ; /* body */ (bodyCall((bodyChild(1)), (new BodyBox))); return (returned(new ReturnBox)); }\nexport { local as renamed, literal as alias, repeated as repeatedAlias };\n(local((1), 'text'));\n(object.method(true, (false), null));\n(new Value);\n(outer((inner((1))), (obj.method((new Box), true)), (new Wrap((last((null)))))));\nexport const initialized = (init((child((1))))), constructed = (new Created);\nlet member = (receiver.method(true));\nvar repeated = (again((new Repeated)));",
      filePath,
    );
    const first = emitTypeScriptCaptures(root);
    const second = emitTypeScriptCaptures(root);
    const saved = JSON.stringify(first);
    const baseline = extract(first, filePath, hooks);
    expect(first).toEqual(second);
    expect(first).toEqual(JSON.parse(saved));
    for (const [index, match] of first.entries()) {
      for (const [key, capture] of Object.entries(match)) {
        expect(Object.getPrototypeOf(capture)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(capture.range)).toBe(Object.prototype);
        expect(capture).not.toBe(second[index]![key]);
        expect(capture.range).not.toBe(second[index]![key]!.range);
      }
    }
    parser.parse('export class Replacement {}');
    expect(JSON.stringify(first)).toBe(saved);
    const detached = extract(JSON.parse(saved), filePath, hooks);
    expect(detached.localDefs).toEqual(baseline.localDefs);
    expect(detached.parsedImports).toEqual(baseline.parsedImports);
    expect(detached.exports).toEqual(baseline.exports);
    expect(detached.scopes).toEqual(baseline.scopes);
    expect(
      detached.scopes
        .find((scope) => scope.kind === 'Function')!
        .ownedDefs.map((def) => def.qualifiedName),
    ).toEqual(['local', 'first', 'second']);
    expect(baseline.referenceSites.map((site) => site.name)).toEqual([
      'bodyCall',
      'bodyChild',
      'BodyBox',
      'returned',
      'ReturnBox',
      'local',
      'method',
      'object',
      'Value',
      'outer',
      'inner',
      'method',
      'obj',
      'Box',
      'Wrap',
      'last',
      'init',
      'child',
      'Created',
      'method',
      'receiver',
      'again',
      'Repeated',
    ]);
    const bodyScope = baseline.scopes.find((scope) => scope.kind === 'Block')!;
    expect(baseline.referenceSites.slice(0, 5).map((site) => site.inScope)).toEqual(
      Array(5).fill(bodyScope.id),
    );
    expect(detached.referenceSites).toEqual(baseline.referenceSites);
    expect(extract(first, filePath, hooks).referenceSites).toEqual(baseline.referenceSites);
    Object.values(first[0]!)[0]!.range.startLine = 999;
    expect(JSON.stringify(second)).toBe(saved);
  });

  it.each(filePaths)(
    'rejects the entire file for unsupported statements in either order in %s',
    async (filePath) => {
      const supported = "import { Value } from './module';\nexport function retained() {}";
      for (const unsupported of [
        '{ function nested() {} }',
        'if (true) {}',
        'async function* pending() {}',
        'async function* pending() {}',
        'return;',
        'return call();',
        'throw;',
        'throw value?.[key].deep;',
        'function* body() { yield 1; }',
        'class Derived extends Base.Member {}',
        'class Member { get method() {} }',
        'export async function* pending() {}',
        'export default function fallback() {}',
        'export default class Default {}',
        "export { default as Value } from './module';",
        "export * from './module';",
        "import './side-effect';",
        "import {} from './module';",
      ]) {
        for (const source of [`${supported}\n${unsupported}`, `${unsupported}\n${supported}`]) {
          const { root } = await parse(source, filePath);
          expect(() => emitTypeScriptCaptures(root), source).toThrow();
        }
      }
    },
  );

  it.each(filePaths)(
    'captures supported lexical loop declarations and rejects unsupported loop forms atomically in %s',
    async (filePath) => {
      const source =
        'for (let item of items) { use(item); } for (const key in object) { use(key); } function hoist(values) { for (var value of values) { use(value); } }';
      const { parser, root } = await parse(source, filePath);
      expect(root.hasError).toBe(false);
      const captures = structuredClone(emitTypeScriptCaptures(root));
      const serialized = JSON.stringify(captures);
      expect(root.descendantsOfType('for_in_statement')).toHaveLength(3);
      const parsed = extract(captures, filePath, hooks);
      expect(
        parsed.localDefs.filter(({ qualifiedName }) => ['item', 'key'].includes(qualifiedName)),
      ).toHaveLength(2);
      expect(parsed.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
        ['items', 'read'],
        ['use', 'call'],
        ['item', 'read'],
        ['object', 'read'],
        ['use', 'call'],
        ['key', 'read'],
        ['values', 'read'],
        ['use', 'call'],
        ['value', 'read'],
      ]);
      const functionNode = root.descendantsOfType('function_declaration')[0]!;
      const functionScope = parsed.scopes.find(
        ({ range }) =>
          JSON.stringify(range) ===
          JSON.stringify({
            startLine: functionNode.startPosition.row + 1,
            startCol: functionNode.startPosition.column,
            endLine: functionNode.endPosition.row + 1,
            endCol: functionNode.endPosition.column,
          }),
      )!;
      const varLoop = root.descendantsOfType('for_in_statement')[2]!;
      const varLoopScope = parsed.scopes.find(
        ({ range }) =>
          JSON.stringify(range) ===
          JSON.stringify({
            startLine: varLoop.startPosition.row + 1,
            startCol: varLoop.startPosition.column,
            endLine: varLoop.endPosition.row + 1,
            endCol: varLoop.endPosition.column,
          }),
      )!;
      expect(functionScope.bindings.get('value')).toHaveLength(1);
      expect(varLoopScope.bindings.has('value')).toBe(false);
      parser.parse('const replacement = 0;');
      expect(JSON.stringify(captures)).toBe(serialized);
      expect(extract(captures, filePath, hooks)).toEqual(parsed);
      const unbracedSource =
        'function owner(items, values) { for (let item of items) consume(item); for (const key in values) consume(key); for (var value of items) consume(value); }';
      const { root: unbracedRoot } = await parse(unbracedSource, filePath);
      expect(unbracedRoot.hasError).toBe(false);
      const unbracedCaptures = emitTypeScriptCaptures(unbracedRoot);
      const unbracedParsed = extract(unbracedCaptures, filePath, hooks);
      const unbracedLoops = unbracedRoot.descendantsOfType('for_in_statement');
      const ownerScope = unbracedParsed.scopes.find(
        ({ kind, range }) =>
          kind === 'Function' &&
          JSON.stringify(range) ===
            JSON.stringify({
              startLine: 1,
              startCol: 0,
              endLine: 1,
              endCol: unbracedSource.length,
            }),
      )!;
      expect(unbracedLoops).toHaveLength(3);
      const functionBody = unbracedRoot
        .descendantsOfType('function_declaration')[0]!
        .childForFieldName('body')!;
      const functionBodyScope = unbracedParsed.scopes.find(
        ({ range }) =>
          JSON.stringify(range) ===
          JSON.stringify({
            startLine: functionBody.startPosition.row + 1,
            startCol: functionBody.startPosition.column,
            endLine: functionBody.endPosition.row + 1,
            endCol: functionBody.endPosition.column,
          }),
      )!;
      expect(unbracedParsed.scopes.filter(({ kind }) => kind === 'Block')).toHaveLength(4);
      expect(
        unbracedLoops.map(
          (loop) =>
            unbracedParsed.scopes.find(
              ({ range }) =>
                JSON.stringify(range) ===
                JSON.stringify({
                  startLine: loop.startPosition.row + 1,
                  startCol: loop.startPosition.column,
                  endLine: loop.endPosition.row + 1,
                  endCol: loop.endPosition.column,
                }),
            )?.parent,
        ),
      ).toEqual(Array(3).fill(functionBodyScope.id));
      expect(unbracedParsed.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
        ['items', 'read'],
        ['consume', 'call'],
        ['item', 'read'],
        ['values', 'read'],
        ['consume', 'call'],
        ['key', 'read'],
        ['items', 'read'],
        ['consume', 'call'],
        ['value', 'read'],
      ]);
      expect(
        unbracedParsed.scopes
          .find(
            ({ range }) =>
              JSON.stringify(range) ===
              JSON.stringify({
                startLine: unbracedLoops[0]!.startPosition.row + 1,
                startCol: unbracedLoops[0]!.startPosition.column,
                endLine: unbracedLoops[0]!.endPosition.row + 1,
                endCol: unbracedLoops[0]!.endPosition.column,
              }),
          )
          ?.bindings.get('item'),
      ).toHaveLength(1);
      expect(ownerScope.bindings.get('value')).toHaveLength(1);
      const grouped =
        'function owner(items, enabled) { if (enabled) for (const item of /* source */ (items)) consume(((item))); else fallback(); }';
      const { root: groupedRoot } = await parse(grouped, filePath);
      expect(groupedRoot.hasError).toBe(false);
      const groupedResult = extract(emitTypeScriptCaptures(groupedRoot), filePath, hooks);
      const groupedLoop = groupedRoot.descendantsOfType('for_in_statement')[0]!;
      expect(
        groupedResult.scopes
          .find(
            ({ range }) =>
              JSON.stringify(range) ===
              JSON.stringify({
                startLine: groupedLoop.startPosition.row + 1,
                startCol: groupedLoop.startPosition.column,
                endLine: groupedLoop.endPosition.row + 1,
                endCol: groupedLoop.endPosition.column,
              }),
          )
          ?.bindings.get('item'),
      ).toHaveLength(1);
      expect(groupedResult.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
        ['enabled', 'read'],
        ['items', 'read'],
        ['consume', 'call'],
        ['item', 'read'],
        ['fallback', 'call'],
      ]);
      for (const unsupported of [
        'for (let { item } of items) {}',
        'for (const item of items) continue;',
        'for (let item = 0 of items) {}',
        'for await (const item of items) {}',
        'for (using item of items) {}',
        'for (item of items) {}',
        'function collision(items) { for (let item of items) { var item; } }',
      ]) {
        const { root: badRoot } = await parse(unsupported, filePath);
        expect(() => emitTypeScriptCaptures(badRoot), unsupported).toThrow();
      }
      const { root: malformed } = await parse(
        'const retained = 1; for (let item of items) {} for (const { key } in object) {}',
        filePath,
      );
      expect(() => emitTypeScriptCaptures(malformed)).toThrow();
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'rejects nested TypeScript generic calls in %s',
    async (filePath) => {
      for (const expression of [
        'inner<Type>()',
        'obj.method<Type>()',
        'new Value<() => typeof Type>()',
      ]) {
        for (const argumentsText of [
          `good(1), ${expression}`,
          `${expression}, good(1)`,
          `good(1), ((${expression}))`,
        ]) {
          for (const source of [
            `export const retained = 1;\nouter(${argumentsText});`,
            `outer(${argumentsText});\nexport const retained = 1;`,
          ]) {
            const { root } = await parse(source, filePath);
            expect(root.hasError, source).toBe(false);
            expect(() => emitTypeScriptCaptures(root), source).toThrow();
          }
        }
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'rejects TypeScript extensions in %s',
    async (filePath) => {
      for (const source of [
        'value<Type>();',
        'new Value<() => typeof Type>();',
        'const initialized = value<Type>();',
        'export let initialized = object.method<Type>();',
        'var initialized = new Value<() => typeof Type>();',
        'const initialized = outer(inner<Type>());',
        'function generic<T>() {}',
        'function typed(): A | typeof other {}',
        'function parameter(value: Array<() => typeof value>) {}',
        'abstract class Abstract {}',
        'class Generic<T> {}',
        'class Derived implements Interface {}',
        'let definite!: number;',
        'const asserted = 1 as typeof Shape;',
        'const asserted = ((1 as typeof Shape));',
        'const asserted = ((value() as typeof Shape));',
        'const asserted = ((value!)());',
        'const asserted = ((1 satisfies typeof other));',
        'export type { Value };',
        'export declare function ambient(): void;',
      ]) {
        const { root } = await parse(source, filePath);
        expect(() => emitTypeScriptCaptures(root), source).toThrow();
      }
    },
  );

  it('rejects malformed files and non-program roots', async () => {
    for (const source of [
      'function broken(',
      'class Broken {',
      "import { Value from './module';",
    ]) {
      const { root } = await parse(source);
      expect(root.hasError).toBe(true);
      expect(() => emitTypeScriptCaptures(root), source).toThrow();
    }
    const { root } = await parse('function local() {}');
    expect(() => emitTypeScriptCaptures(root.namedChildren[0]!)).toThrow();
  });
});
