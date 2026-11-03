import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { emitTypeScriptDeclarationCaptures } from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';
import { typescriptProvider } from '../../../src/core/ingestion/languages/typescript.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';
import { resolveReferences } from '../../../src/core/ingestion/resolve-references.js';
import { extractParsedFileOutcome } from '../../../src/core/ingestion/scope-extractor-bridge.js';

describe('ordinary TypeScript namespaces', () => {
  it('resolves body reads locally without exposing namespace members', async () => {
    const parser = await createParserForLanguage(SupportedLanguages.TypeScript, 'fixture.ts');
    const root = parser.parse(
      [
        'const privateValue = 0;',
        'namespace N {',
        '  type Private = string;',
        '  var typed: Private;',
        '  const privateValue = 1;',
        '  export const publicValue = privateValue;',
        '}',
        'privateValue; N.publicValue; publicValue;',
      ].join('\n'),
    ).rootNode;
    const result = extract(emitTypeScriptCaptures(root), 'fixture.ts', typescriptProvider);
    const namespace = result.scopes.find((scope) => scope.kind === 'Namespace')!;
    const body = result.scopes.find((scope) => scope.parent === namespace.id)!;
    expect(body.typeBindings.get('typed')?.rawName).toBe('Private');
    const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
    expect([...module.bindings.keys()]).toEqual(['privateValue', 'N']);
    const resolution = resolveReferences(finalizeScopeModel([result]));
    const resolved = [...resolution.referenceIndex.bySourceScope.values()].flat();
    const inner = body.bindings.get('privateValue')![0]!.def;
    const outer = module.bindings.get('privateValue')![0]!.def;
    expect(
      resolved.filter((site) => site.toDef === inner.nodeId).map((site) => site.atRange),
    ).toEqual(
      result.referenceSites
        .filter((site) => site.name === 'privateValue' && site.inScope === body.id)
        .map((site) => site.atRange),
    );
    expect(
      resolved.filter((site) => site.toDef === outer.nodeId).map((site) => site.atRange),
    ).toEqual(
      result.referenceSites
        .filter((site) => site.name === 'privateValue' && site.inScope === module.id)
        .map((site) => site.atRange),
    );
    const publicDef = body.bindings.get('publicValue')![0]!.def;
    expect(resolved.filter((site) => site.toDef === publicDef.nodeId)).toEqual([]);
    expect(result.exports.size).toBe(0);
  });

  it.each(['fixture.ts', 'fixture.tsx'])(
    'preserves declaration ownership and body lexical bindings in %s',
    async (filePath) => {
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
      const source = [
        'const value = 0;',
        'namespace One {',
        '  export const value = 1;',
        '  export function read() { return value; }',
        '  export interface Shape { name: string }',
        '  export type Label = string;',
        '  export enum Status { Ready, Done, }',
        '  export class Comment { method() { return this; } }',
        '  var repeated; { var repeated; }',
        '}',
        'namespace Two { const value = 2; use(value); }',
        'export { One };',
      ].join('\n');
      const root = parser.parse(source).rootNode;
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const serialized = JSON.stringify(captures);
      const result = extract(captures, filePath, typescriptProvider);
      const warnings: string[] = [];
      const outcome = extractParsedFileOutcome(
        typescriptProvider,
        source,
        filePath,
        (message) => warnings.push(message),
        root,
      );
      expect(outcome.status).toBe('success');
      expect(warnings).toEqual([]);
      if (outcome.status === 'success') expect(outcome.parsedFile).toEqual(result);
      const module = result.scopes.find((scope) => scope.id === result.moduleScope)!;
      expect([...module.bindings.keys()]).toEqual(['value', 'One', 'Two']);
      expect(module.bindings.get('One')?.[0]?.namespace).toBe('both');
      const namespaces = result.scopes.filter((scope) => scope.kind === 'Namespace');
      expect(namespaces).toHaveLength(2);
      for (const [index, namespace] of namespaces.entries()) {
        const definition = result.localDefs.find((def) => def.nodeId === namespace.ownerDefId)!;
        expect(definition.type).toBe('Namespace');
        expect(definition.qualifiedName).toBe(index === 0 ? 'One' : 'Two');
        expect(namespace.bindings.size).toBe(0);
        const body = result.scopes.find((scope) => scope.parent === namespace.id)!;
        expect(body.kind).toBe('Block');
        expect(body.bindings.has('value')).toBe(true);
        if (index === 0) {
          expect([...body.bindings.keys()]).toEqual([
            'value',
            'read',
            'Shape',
            'Label',
            'Status',
            'Comment',
            'repeated',
          ]);
          expect(body.bindings.get('repeated')).toHaveLength(1);
        }
      }
      // Namespace export wrappers never publish their children as file exports.
      expect([...result.exports.keys()]).toEqual(['One']);
      expect(
        captures
          .filter((match) => match['@export.name'])
          .map((match) => match['@export.name']!.text),
      ).toEqual(['One']);
      expect(result.referenceSites.map((site) => site.name)).toEqual(['value', 'use', 'value']);
      parser.parse('replacement();');
      expect(JSON.stringify(captures)).toBe(serialized);
      expect(extract(JSON.parse(serialized), filePath, typescriptProvider)).toEqual(result);
    },
  );

  it.each(['namespace'])('detaches a parent-bound %s declaration', async (keyword) => {
    const parser = await createParserForLanguage(SupportedLanguages.TypeScript, 'fixture.ts');
    const root = parser.parse(`${keyword} Named {}`).rootNode;
    const [match] = emitTypeScriptDeclarationCaptures(
      root.descendantsOfType('internal_module')[0]!,
    );
    expect(match['@declaration.namespace']).toBeDefined();
    expect(match['@declaration.name']!.text).toBe('Named');
    expect(match['@typescript.binding_scope']!.text).toBe('parent');
  });

  it.each([
    'namespace N {} namespace N {}',
    'namespace N {} class N {}',
    'class N {} namespace N {}',
    'namespace N {} function N() {}',
    'function N() {} namespace N {}',
    'namespace N {} enum N { A }',
    'enum N { A } namespace N {}',
    'import { N } from "other"; namespace N {}',
    'namespace N {} import { N } from "other";',
    'var N; namespace N {}',
    'namespace N {} var N;',
    'namespace N.M {}',
    'namespace N { namespace Inner {} }',
    'declare namespace N {}',
    'export namespace N {}',
    'module "external" {}',
    'namespace N { import { Value } from "other"; }',
    'namespace N { export { Value }; }',
    'namespace N { export default class Value {} }',
    'namespace N { const duplicate = 1; let duplicate = 2; }',
    'namespace N { enum Status { Ready, Done = "done" } }',
    'namespace N { { interface Hidden {} } }',
    'namespace N { export function unsupported() { yield 1; } }',
  ])('rejects unsupported namespace syntax atomically: %s', async (source) => {
    const parser = await createParserForLanguage(SupportedLanguages.TypeScript, 'fixture.ts');
    for (const text of [`before(); ${source}`, `${source} after();`]) {
      const root = parser.parse(text).rootNode;
      expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
    }
  });
});
