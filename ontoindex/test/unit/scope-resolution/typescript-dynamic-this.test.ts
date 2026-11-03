import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import {
  javascriptProvider,
  typescriptProvider,
} from '../../../src/core/ingestion/languages/typescript.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { extractParsedFileOutcome } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';
import { resolveReferences } from '../../../src/core/ingestion/resolve-references.js';

describe('dynamic this through composed scope extraction', () => {
  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'retains evaluations in nested this expressions in %s',
    async (filePath) => {
      const js = /\.jsx?$/.test(filePath);
      const provider = js ? javascriptProvider : typescriptProvider;
      const parser = await createParserForLanguage(
        js ? SupportedLanguages.JavaScript : SupportedLanguages.TypeScript,
        filePath,
      );
      for (const expression of [
        '(() => this)()',
        '(this ? left : right).method()',
        '(condition ? this : right).field',
        'factory(() => { return this; }).field',
        'this.make(argument).next(other)',
        'this?.state.method?.(argument)',
        '[...(() => { return this; })]',
        '({method() { return this; }})',
      ]) {
        const root = parser.parse(`before(); consume(${expression}); after();`).rootNode;
        expect(root.hasError, expression).toBe(false);
        const result = extract(emitTypeScriptCaptures(root), filePath, provider);
        expect(
          result.referenceSites.map((site) => site.name),
          expression,
        ).toEqual(expect.arrayContaining(['before', 'consume', 'after']));
        expect(
          result.referenceSites.some((site) => site.name === 'this'),
          expression,
        ).toBe(false);
        if (expression === 'this.make(argument).next(other)') {
          for (const name of ['argument', 'other']) {
            expect(
              result.referenceSites.filter((site) => site.name === name && site.kind === 'read'),
            ).toHaveLength(1);
          }
        }
      }
    },
  );
  it.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
    'retains the CommentListSection call shape without false resolution in %s',
    async (filePath) => {
      const js = /\.jsx?$/.test(filePath);
      const provider = js ? javascriptProvider : typescriptProvider;
      const parser = await createParserForLanguage(
        js ? SupportedLanguages.JavaScript : SupportedLanguages.TypeScript,
        filePath,
      );
      const source = `
        function getItemValue(value) { return value; }
        window.L.Map.include({
          insertComment: function() {
            this.stateChangeHandler.getItemValue('InsertAnnotation');
            this.value = compute(this);
            this.count += increment;
            this.items[index] = next;
            return this;
          }
        });
      `;
      const root = parser.parse(source).rootNode;
      expect(root.hasError).toBe(false);
      const warnings: string[] = [];
      const outcome = extractParsedFileOutcome(
        provider,
        source,
        filePath,
        (message) => warnings.push(message),
        root,
      );
      expect(warnings).toEqual([]);
      expect(outcome.status).toBe('success');
      if (outcome.status !== 'success') throw new Error('expected successful scope extraction');
      const result = outcome.parsedFile;
      expect(result.referenceSites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'getItemValue',
            kind: 'call',
            arity: 1,
            explicitReceiver: { kind: 'unknown' },
          }),
          expect.objectContaining({
            name: 'stateChangeHandler',
            kind: 'read',
            explicitReceiver: { kind: 'unknown' },
          }),
          expect.objectContaining({
            name: 'value',
            kind: 'write',
            explicitReceiver: { kind: 'unknown' },
          }),
          expect.objectContaining({
            name: 'count',
            kind: 'read',
            explicitReceiver: { kind: 'unknown' },
          }),
          expect.objectContaining({
            name: 'count',
            kind: 'write',
            explicitReceiver: { kind: 'unknown' },
          }),
          expect.objectContaining({ name: 'compute', kind: 'call', arity: 1 }),
        ]),
      );
      for (const name of ['index', 'next', 'increment']) {
        expect(
          result.referenceSites.filter((site) => site.name === name && site.kind === 'read'),
        ).toHaveLength(1);
      }
      expect(result.referenceSites.some((site) => site.name === 'this')).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      expect(extract(JSON.parse(JSON.stringify(captures)), filePath, provider)).toEqual(result);
      const global = result.localDefs.find((def) => def.qualifiedName === 'getItemValue')!;
      expect(global).toBeDefined();
      const resolved = [
        ...resolveReferences(finalizeScopeModel([result])).referenceIndex.bySourceScope.values(),
      ].flat();
      expect(resolved.some((reference) => reference.toDef === global.nodeId)).toBe(false);
    },
  );
});
