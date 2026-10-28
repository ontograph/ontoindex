import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
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
import { interpretTypeScriptTypeBinding } from '../../../src/core/ingestion/languages/typescript.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';

const hooks = {
  bindingScopeFor: typeScriptDeclarationBindingScope,
  declarationNamespaceFor: typeScriptDeclarationNamespace,
  selectLocalBindings: selectTypeScriptLocalBindings,
  interpretImport: interpretTypeScriptImport,
  interpretExports: interpretTypeScriptExports,
  interpretTypeBinding: interpretTypeScriptTypeBinding,
};
const filePaths = ['fixture.ts', 'fixture.tsx'];

function rangeOf(source: string, text: string, offset = 0) {
  const start = source.indexOf(text, offset);
  expect(start, text).toBeGreaterThanOrEqual(0);
  const position = (offset: number) => {
    const lines = source.slice(0, offset).split('\n');
    return { line: lines.length, col: lines.at(-1)!.length };
  };
  const from = position(start);
  const to = position(start + text.length);
  return { startLine: from.line, startCol: from.col, endLine: to.line, endCol: to.col };
}

describe('inline TypeScript object annotations', () => {
  it.each(filePaths)(
    'preserves captures, exact annotation ranges and replay in %s',
    async (filePath) => {
      const cases = [
        {
          annotation: 'Array<{ node: string; children: Iterator<string>; entered: boolean }>',
          statement: (type: string) => `const iterStack: ${type} = [];`,
        },
        {
          annotation:
            'readonly { readonly language: SupportedLanguages; readonly diff: ShadowDiff }[]',
          statement: (type: string) =>
            `function aggregateDiffs(diffs: ${type}) { consume(value); }`,
        },
        {
          annotation:
            '{ readonly child?: { value: Array<string | number>; next?: readonly string[] } }',
          statement: (type: string) => `const result: ${type} = make(value);`,
        },
        {
          annotation: '{ member: { inner: string }[]; optional?: boolean, }',
          statement: (type: string) => `function owner(): ${type} { return make(value); }`,
        },
        {
          annotation: '{ member: { inner: string }[]; readonly optional?: boolean }',
          statement: (type: string) => `const result = new Box<${type}>(value);`,
        },
        { annotation: '{}', statement: (type: string) => `const result: ${type} = make(value);` },
        {
          annotation:
            '{ /* before */ readonly /* name */ member /* optional */ ? /* type */ : /* value */ string /* end */ ; other: number, }',
          statement: (type: string) => `const result: ${type} = make(value);`,
        },
      ];
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
      for (const { annotation, statement } of cases) {
        const source = statement(annotation);
        const root = parser.parse(source).rootNode;
        expect(root.hasError, source).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const saved = JSON.stringify(captures);
        const result = extract(captures, filePath, hooks);
        const baselineType = 'T'.repeat(annotation.length);
        const baseline = emitTypeScriptCaptures(parser.parse(statement(baselineType)).rootNode);
        expect(
          captures.map((match) =>
            Object.fromEntries(
              Object.entries(match).map(([key, capture]) => [
                key,
                { ...capture, text: capture.text === annotation ? baselineType : capture.text },
              ]),
            ),
          ),
          source,
        ).toEqual(baseline);
        const annotations = captures
          .flatMap((match) => Object.values(match))
          .filter((capture) => capture.text === annotation);
        if (source.includes('new Box')) expect(annotations, source).toEqual([]);
        else expect(annotations.length, source).toBeGreaterThan(0);
        for (const capture of annotations)
          expect(capture.range, source).toEqual(rangeOf(source, annotation));
        expect(
          result.localDefs.map((def) => def.qualifiedName),
          source,
        ).toEqual(
          source.includes('aggregateDiffs')
            ? ['aggregateDiffs', 'diffs']
            : source.includes('function owner')
              ? ['owner']
              : [source.includes('iterStack') ? 'iterStack' : 'result'],
        );
        const expectedReferences = source.includes('consume')
          ? [
              {
                name: 'consume',
                kind: 'call',
                callForm: 'free',
                arity: 1,
                atRange: rangeOf(source, 'consume(value)'),
              },
              {
                name: 'value',
                kind: 'read',
                atRange: rangeOf(source, 'value', source.lastIndexOf('value')),
              },
            ]
          : source.includes('new Box')
            ? [
                {
                  name: 'Box',
                  kind: 'call',
                  callForm: 'constructor',
                  arity: 1,
                  atRange: rangeOf(source, `new Box<${annotation}>(value)`),
                },
                {
                  name: 'value',
                  kind: 'read',
                  atRange: rangeOf(source, 'value', source.lastIndexOf('value')),
                },
              ]
            : source.includes('make(value)')
              ? [
                  {
                    name: 'make',
                    kind: 'call',
                    callForm: 'free',
                    arity: 1,
                    atRange: rangeOf(source, 'make(value)'),
                  },
                  {
                    name: 'value',
                    kind: 'read',
                    atRange: rangeOf(source, 'value', source.lastIndexOf('value')),
                  },
                ]
              : [];
        expect(
          result.referenceSites.map(({ inScope: _scope, ...reference }) => reference),
          source,
        ).toEqual(expectedReferences);
        parser.parse('replacement();');
        expect(JSON.stringify(captures), source).toBe(saved);
        expect(extract(JSON.parse(saved), filePath, hooks), source).toEqual(result);
      }
    },
  );

  it.each(filePaths)('preserves multiline annotation text and ranges in %s', async (filePath) => {
    const annotation =
      '{\n  // member comment\n  readonly member?: { inner: string };\n  other: number,\n}';
    const source = `const result: ${annotation} = make(value);`;
    const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
    const captures = emitTypeScriptCaptures(parser.parse(source).rootNode);
    const annotationCaptures = captures
      .flatMap((match) => Object.values(match))
      .filter((capture) => capture.text === annotation);
    expect(annotationCaptures.length).toBeGreaterThan(0);
    for (const capture of annotationCaptures)
      expect(capture.range).toEqual(rangeOf(source, annotation));
    const result = extract(captures, filePath, hooks);
    expect(extract(JSON.parse(JSON.stringify(captures)), filePath, hooks)).toEqual(result);
    expect(result.referenceSites.map((reference) => reference.name)).toEqual(['make', 'value']);
  });

  it.each(filePaths)(
    'rejects unsupported members atomically around valid declarations in %s',
    async (filePath) => {
      const members = [
        'method(): string',
        '(): string',
        'new (): Shape',
        '[key: string]: number',
        '[key]: string',
        '"key": string',
        '1: string',
        '#key: string',
        'private key: string',
        'public key: string',
        'protected key: string',
        'static key: string',
        'override key: string',
        'export const key: string',
        'key',
        'key?',
        'readonly key',
        'key:',
        'key: @',
        'key: string;; next: string',
        ',key: string',
        'key: string,; next: string',
        'key: { invalid(): string }',
      ];
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
      for (const member of members) {
        for (const statement of [
          `const bad: { ${member} } = make(value);`,
          `function bad(input: { ${member} }) { consume(value); }`,
          `function bad(): { ${member} } { return value; }`,
          `const bad = new Box<{ ${member} }>(value);`,
        ]) {
          for (const source of [
            `const good: string = value; ${statement}`,
            `${statement} const good: string = value;`,
          ]) {
            let captures: ReturnType<typeof emitTypeScriptCaptures> | undefined;
            expect(() => {
              captures = emitTypeScriptCaptures(parser.parse(source).rootNode);
            }, source).toThrow(ScopeUnsupportedSyntaxError);
            expect(captures, source).toBeUndefined();
          }
        }
      }
    },
  );
});
