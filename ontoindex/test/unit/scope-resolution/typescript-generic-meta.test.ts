import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import {
  javascriptProvider,
  typescriptProvider,
} from '../../../src/core/ingestion/languages/typescript.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';
import { resolveReferences } from '../../../src/core/ingestion/resolve-references.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';
import { validateTypeScriptImportMeta } from '../../../src/core/ingestion/languages/typescript-reference-captures.js';

describe('generic calls and import metadata', () => {
  it.each(['fixture.ts', 'fixture.tsx'])(
    'retains runtime evaluations and arity while validating type arguments in %s',
    async (filePath) => {
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
      for (const expression of [
        'consume<Value>(argument)',
        'client.method<Array<Value>>(argument)',
        'client?.method<Value>(argument)',
        'client.method?.<Value>(argument)',
        'factory<Value>(argument).method<Result>(other)',
        'outer<Value>(inner<Result>(argument))',
      ]) {
        const root = parser.parse(`${expression};`).rootNode;
        expect(root.hasError, expression).toBe(false);
        const captures = emitTypeScriptCaptures(root);
        const result = extract(captures, filePath, typescriptProvider);
        expect(
          result.referenceSites.some((site) => ['Value', 'Result', 'Array'].includes(site.name)),
        ).toBe(false);
        expect(
          result.referenceSites.filter((site) => site.name === 'argument' && site.kind === 'read'),
        ).toHaveLength(1);
        expect(
          result.referenceSites
            .filter((site) => site.kind === 'call')
            .every((site) => site.arity === 1),
        ).toBe(true);
        expect(extract(JSON.parse(JSON.stringify(captures)), filePath, typescriptProvider)).toEqual(
          result,
        );
      }
    },
  );

  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'keeps import metadata receivers unknown without losing evaluations in %s',
    async (filePath) => {
      const js = /\.jsx?$/.test(filePath);
      const provider = js ? javascriptProvider : typescriptProvider;
      const parser = await createParserForLanguage(
        js ? SupportedLanguages.JavaScript : SupportedLanguages.TypeScript,
        filePath,
      );
      const root = parser.parse(`
        function resolve(input) { return input; }
        function url(input) { return input; }
        import.meta;
        consume(import.meta);
        const location = import.meta.url;
        import.meta.resolve(argument);
        import.meta.resolve(other).url;
        import.meta[key] = next;
        import.meta.env.value += increment;
      `).rootNode;
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const result = extract(captures, filePath, provider);
      expect(result.referenceSites.some((site) => ['import', 'meta'].includes(site.name))).toBe(
        false,
      );
      for (const name of ['argument', 'other', 'key', 'next', 'increment']) {
        expect(
          result.referenceSites.filter((site) => site.name === name && site.kind === 'read'),
        ).toHaveLength(1);
      }
      const metadataSites = result.referenceSites.filter((site) =>
        ['resolve', 'url', 'env', 'value'].includes(site.name),
      );
      expect(metadataSites.length).toBeGreaterThan(0);
      expect(metadataSites.every((site) => site.explicitReceiver?.kind === 'unknown')).toBe(true);
      expect(metadataSites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'resolve', kind: 'call', arity: 1 }),
          expect.objectContaining({ name: 'value', kind: 'write' }),
        ]),
      );
      const globals = new Set(
        result.localDefs
          .filter((def) => ['resolve', 'url'].includes(def.qualifiedName))
          .map((def) => def.nodeId),
      );
      expect(globals.size).toBe(2);
      const resolved = [
        ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
      ].flat();
      expect(resolved.some((site) => globals.has(site.toDef))).toBe(false);
      expect(extract(JSON.parse(JSON.stringify(captures)), filePath, provider)).toEqual(result);
      const meta = root.descendantsOfType('meta_property')[0]!;
      expect(() =>
        validateTypeScriptImportMeta({
          ...meta,
          type: 'meta_property',
          isNamed: true,
          hasError: false,
          isMissing: false,
          children: meta.children.slice(0, 2),
        }),
      ).toThrow(ScopeUnsupportedSyntaxError);
      for (const source of ['consume(new.target);', 'consume(import.);', 'new.target.url;']) {
        expect(() => emitTypeScriptCaptures(parser.parse(source).rootNode), source).toThrow(
          ScopeUnsupportedSyntaxError,
        );
      }
    },
  );
});
