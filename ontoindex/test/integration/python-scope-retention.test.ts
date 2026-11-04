import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { summarizeScopeRetentionCoverage } from '../../src/core/ingestion/pipeline-phases/scope-retention-coverage.js';

async function collect<T>(batches: AsyncIterable<readonly T[]>): Promise<T[]> {
  const records: T[] = [];
  for await (const batch of batches) records.push(...batch);
  return records;
}

describe('production Python scope retention', () => {
  const directories: string[] = [];

  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('retains parser evidence without changing the live graph', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-python-retention-'));
    directories.push(directory);
    fs.writeFileSync(
      path.join(directory, 'supported.py'),
      [
        'def first():',
        '    first()',
        '    return 1',
        'def second():',
        '    first()',
        'second()',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(directory, 'refused.py'),
      ['def retained():', '    retained()', 'value = 1'].join('\n') + '\n',
    );

    const options = { skipGraphPhases: true, skipWorkers: true };
    const baseline = await runPipelineFromRepo(directory, () => {}, options);
    let consumed = false;
    const result = await runPipelineFromRepo(directory, () => {}, {
      ...options,
      scopeRetention: {
        deadline: Date.now() + 60_000,
        artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
        consume: async (handle) => {
          consumed = true;
          const calls = await collect(handle.iterateCalls());
          for (const [filePath, calledName] of [
            ['supported.py', 'first'],
            ['supported.py', 'second'],
            ['refused.py', 'retained'],
          ]) {
            expect(calls).toContainEqual(expect.objectContaining({ filePath, calledName }));
          }
          expect(handle.callRecordCount).toBe(calls.length);
          const registrations = await collect(handle.iterateModelRegistrations());
          for (const [filePath, name] of [
            ['supported.py', 'first'],
            ['supported.py', 'second'],
            ['refused.py', 'retained'],
          ]) {
            expect(registrations).toContainEqual(
              expect.objectContaining({ kind: 'symbol.add', filePath, name }),
            );
          }
          expect(handle.modelRegistrationRecordCount).toBe(registrations.length);
          const nodes = await collect(handle.iterateGraphNodes());
          for (const [filePath, name] of [
            ['supported.py', 'first'],
            ['supported.py', 'second'],
            ['refused.py', 'retained'],
          ]) {
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
            { filePath: 'refused.py', status: 'retained' },
            { filePath: 'supported.py', status: 'retained' },
          ]);

          expect(handle.status).toBe('retained');
          expect(handle.reasons).not.toContain('unsupported-syntax');
          expect(handle.seedReady).toBe(false);
          expect(summarizeScopeRetentionCoverage(handle.inventory).complete).toBe(true);
        },
      },
    });
    expect(consumed).toBe(true);
    expect(result.usedWorkerPool).toBe(false);
    const normalize = (graph: typeof result.graph) => ({
      nodes: [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id)),
      relationships: [...graph.relationships].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    });
    expect(normalize(result.graph)).toEqual(normalize(baseline.graph));
  }, 90_000);
});
