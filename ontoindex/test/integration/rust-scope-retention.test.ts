import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupportedLanguages } from 'ontoindex-shared';
import type { LanguageProvider } from '../../src/core/ingestion/language-provider.js';
import * as providers from '../../src/core/ingestion/languages/index.js';
import { rustProvider } from '../../src/core/ingestion/languages/rust.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { summarizeScopeRetentionCoverage } from '../../src/core/ingestion/pipeline-phases/scope-retention-coverage.js';
import { finalizeScopeModel } from '../../src/core/ingestion/finalize-orchestrator.js';
import { resolveReferences } from '../../src/core/ingestion/resolve-references.js';

async function collect<T>(batches: AsyncIterable<readonly T[]>): Promise<T[]> {
  const records: T[] = [];
  for await (const batch of batches) records.push(...batch);
  return records;
}

describe('production Rust scope retention', () => {
  const directories: string[] = [];

  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('retains supported scopes and refused legacy evidence without changing the live graph', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-rust-retention-'));
    directories.push(directory);
    fs.writeFileSync(
      path.join(directory, 'supported.rs'),
      ['pub fn first() { second(); first(); return; }', 'fn second() { first(); second(); }'].join(
        '\n',
      ) + '\n',
    );
    fs.writeFileSync(
      path.join(directory, 'refused.rs'),
      ['pub fn retained() { retained(); }', 'const VALUE: i32 = 1;'].join('\n') + '\n',
    );

    const options = { skipGraphPhases: true, skipWorkers: true };
    expect(rustProvider.emitScopeCaptures).toBeTypeOf('function');
    const baselineProvider: LanguageProvider = {
      ...rustProvider,
      bindingScopeFor: undefined,
      interpretExports: undefined,
      interpretImport: undefined,
      emitScopeCaptures: undefined,
    };
    const originalGetProvider = providers.getProvider;
    const originalGetProviderForFile = providers.getProviderForFile;
    const providerSpy = vi
      .spyOn(providers, 'getProvider')
      .mockImplementation((language) =>
        language === SupportedLanguages.Rust ? baselineProvider : originalGetProvider(language),
      );
    // Parsing and retention use separate registry views; disable both for the baseline.
    const fileProviderSpy = vi
      .spyOn(providers, 'getProviderForFile')
      .mockImplementation((filePath) => {
        const original = originalGetProviderForFile(filePath);
        return original === rustProvider ? baselineProvider : original;
      });
    let baseline: Awaited<ReturnType<typeof runPipelineFromRepo>>;
    try {
      baseline = await runPipelineFromRepo(directory, () => {}, options);
    } finally {
      fileProviderSpy.mockRestore();
      providerSpy.mockRestore();
    }

    let consumed = false;
    const warning = vi.spyOn(console, 'warn');
    let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
    try {
      result = await runPipelineFromRepo(directory, () => {}, {
        ...options,
        scopeRetention: {
          deadline: Date.now() + 60_000,
          artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
          consume: async (handle) => {
            consumed = true;
            const files = await collect(handle.iterate());
            expect(files.map((file) => file.filePath)).toEqual(['supported.rs']);
            const file = files[0]!;
            expect(file.localDefs.map((def) => def.qualifiedName)).toEqual(['first', 'second']);
            expect(file.scopes.map((scope) => scope.kind)).toEqual([
              'Module',
              'Function',
              'Block',
              'Function',
              'Block',
            ]);
            const module = file.scopes.find((scope) => scope.id === file.moduleScope)!;
            const functions = file.scopes.filter((scope) => scope.kind === 'Function');
            const blocks = file.scopes.filter((scope) => scope.kind === 'Block');
            expect(functions.map((scope) => scope.parent)).toEqual([module.id, module.id]);
            expect(blocks.map((scope) => scope.parent)).toEqual(functions.map((scope) => scope.id));
            expect([...module.bindings]).toEqual(
              file.localDefs.map((def) => [def.qualifiedName, [{ def, origin: 'local' }]]),
            );
            expect(file.exports).toEqual(new Map([['first', file.localDefs[0]!.nodeId]]));
            expect(
              file.referenceSites.map(({ name, inScope, arity, callForm }) => ({
                name,
                inScope,
                arity,
                callForm,
              })),
            ).toEqual([
              { name: 'second', inScope: blocks[0]!.id, arity: 0, callForm: 'free' },
              { name: 'first', inScope: blocks[0]!.id, arity: 0, callForm: 'free' },
              { name: 'first', inScope: blocks[1]!.id, arity: 0, callForm: 'free' },
              { name: 'second', inScope: blocks[1]!.id, arity: 0, callForm: 'free' },
            ]);
            expect(file.parsedImports).toEqual([]);
            expect(resolveReferences(finalizeScopeModel(files)).stats).toEqual({
              totalSites: 4,
              resolvedSites: 4,
              unresolvedSites: 0,
              ambiguousSites: 0,
              unsupportedSites: 0,
            });

            const calls = await collect(handle.iterateCalls());
            const expectedFunctions = [
              ['supported.rs', 'first'],
              ['supported.rs', 'second'],
              ['refused.rs', 'retained'],
            ];
            for (const [filePath, calledName] of expectedFunctions) {
              expect(calls).toContainEqual(expect.objectContaining({ filePath, calledName }));
            }
            expect(handle.callRecordCount).toBe(calls.length);
            const registrations = await collect(handle.iterateModelRegistrations());
            for (const [filePath, name] of expectedFunctions) {
              expect(registrations).toContainEqual(
                expect.objectContaining({ kind: 'symbol.add', filePath, name }),
              );
            }
            expect(handle.modelRegistrationRecordCount).toBe(registrations.length);
            const nodes = await collect(handle.iterateGraphNodes());
            for (const [filePath, name] of expectedFunctions) {
              expect(nodes).toContainEqual(
                expect.objectContaining({
                  label: 'Function',
                  properties: expect.objectContaining({ filePath, name }),
                }),
              );
            }
            const nodeIds = new Set(nodes.map((node) => node.id));
            const relationships = await collect(handle.iterateGraphRelationships());
            expect(relationships.length).toBeGreaterThan(0);
            for (const edge of relationships) {
              expect(nodeIds.has(edge.sourceId)).toBe(true);
              expect(nodeIds.has(edge.targetId)).toBe(true);
            }
            expect(
              [...handle.inventory].sort((left, right) =>
                left.filePath.localeCompare(right.filePath),
              ),
            ).toEqual([
              { filePath: 'refused.rs', status: 'failed', reason: 'unsupported-syntax' },
              { filePath: 'supported.rs', status: 'retained' },
            ]);
            expect(handle.status).toBe('incomplete');
            expect(handle.reasons).toContain('unsupported-syntax');
            expect(handle.seedReady).toBe(false);
            expect(summarizeScopeRetentionCoverage(handle.inventory).complete).toBe(false);
          },
        },
      });
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('scope extraction failed for refused.rs:'),
      );
    } finally {
      warning.mockRestore();
    }
    expect(consumed).toBe(true);
    expect(result.usedWorkerPool).toBe(false);
    const normalize = (graph: typeof result.graph) => ({
      nodes: [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id)),
      relationships: [...graph.relationships].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    });
    expect(normalize(result.graph)).toEqual(normalize(baseline.graph));
    expect(rustProvider.emitScopeCaptures).toBeTypeOf('function');
  }, 90_000);
});
