import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { typescriptProvider } from '../../../src/core/ingestion/languages/typescript.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { extractParsedFileOutcome } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';

const filePath = 'fixture.ts';

async function parse(source: string, filePath = 'fixture.ts') {
  const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
  return parser.parse(source).rootNode;
}

describe('TypeScript ambient variable declarations', () => {
  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains typed and untyped declarations in %s',
    async (filePath) => {
      for (const [source, name, type] of [
        ['declare var runtimeValue: string;', 'runtimeValue', 'string'],
        ['declare var runtimeValue;', 'runtimeValue', undefined],
        ['declare var first: string, second: number;', 'first', 'string'],
        ['declare var first: string, second: number;', 'second', 'number'],
      ] as const) {
        const root = await parse(source, filePath);
        expect(root.hasError).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const serialized = JSON.stringify(captures);
        const result = extract(captures, filePath, typescriptProvider);
        const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
        expect(module.bindings.get(name)).toEqual([
          {
            def: expect.objectContaining({ type: 'Variable', qualifiedName: name }),
            origin: 'local',
            namespace: 'value',
          },
        ]);
        if (type === undefined) {
          expect(module.typeBindings.size).toBe(0);
        } else {
          expect(module.typeBindings.get(name)?.rawName).toBe(type);
        }
        expect(extract(JSON.parse(serialized), filePath, typescriptProvider)).toEqual(result);
      }
    },
  );

  it.each([
    'declare var ambient: number; var ordinary = ambient;',
    'var ordinary = ambient; declare var ambient: number;',
    'declare var value: number; { var value: number; }',
    'declare var value: number; declare var value: number;',
    'declare var value: number; var value: number;',
    'var value: number; declare var value: number;',
    'declare var ambient: number; let ordinary = ambient;',
    'declare var ambient: number; const ordinary = ambient;',
    'declare var ambient: number; declare let ordinary: number; use(ambient);',
    'declare const ordinary: number; declare var ambient: number; use(ambient);',
  ])('merges ambient and ordinary variables while retaining references: %s', async (source) => {
    const root = await parse(source);
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, typescriptProvider);
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    const ambientName = source.includes('ambient') ? 'ambient' : 'value';
    expect(module.bindings.get(ambientName)).toHaveLength(1);
    const ordinaryName = source.includes('ordinary') ? 'ordinary' : 'value';
    expect(module.bindings.has(ordinaryName)).toBe(true);
    if (source.includes('ambient')) {
      expect(result.referenceSites).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'ambient', kind: 'read' })]),
      );
    }
  });

  it('keeps a sibling ambient var at module scope beside a function-local var', async () => {
    const source =
      'function read() { var localValue = 1; return ambientValue; } ' +
      'declare var ambientValue: number;';
    const root = await parse(source);
    expect(root.hasError).toBe(false);
    const result = extract(emitTypeScriptCaptures(root), filePath, typescriptProvider);
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    expect(module.bindings.has('ambientValue')).toBe(true);
    expect(module.bindings.has('localValue')).toBe(false);
    expect(result.referenceSites).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'ambientValue', kind: 'read' })]),
    );
  });

  it.each([
    'declare var value: number; let value: number;',
    'let value: number; declare var value: number;',
    'declare var value: number; const value = 1;',
    'const value = 1; declare var value: number;',
    'declare var value: number; declare function value(): void;',
    'declare var value: number; declare class value {}',
    'declare var value: number; declare namespace value {}',
    'declare var value: number; declare global { interface Window {} }',
    'declare var value: number = 1;',
    'declare var { value }: Record<string, number>;',
  ])('rejects conflicting or unsupported ambient declarations: %s', async (source) => {
    const root = await parse(source);
    expect(root.hasError, source).toBe(false);
    expect(() => emitTypeScriptCaptures(root), source).toThrow(ScopeUnsupportedSyntaxError);
  });

  it('succeeds through the production extraction bridge', async () => {
    const source = 'declare var JSDialog: any; JSDialog.render();';
    const root = await parse(source);
    const warnings: string[] = [];
    const warning = (message: string) => warnings.push(message);
    const outcome = extractParsedFileOutcome(typescriptProvider, source, filePath, warning, root);
    expect(outcome.status).toBe('success');
    expect(warnings).toEqual([]);
    if (outcome.status === 'success') {
      expect(outcome.parsedFile.referenceSites).toEqual([
        expect.objectContaining({ name: 'render', kind: 'call' }),
        expect.objectContaining({ name: 'JSDialog', kind: 'read' }),
      ]);
    }
  });
});
