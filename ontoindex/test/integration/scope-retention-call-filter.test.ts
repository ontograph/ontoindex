import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { ExtractedCall } from '../../src/core/ingestion/workers/parse-types.js';

describe('scope retention observed input filtering', () => {
  const directories: string[] = [];

  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('retains supported calls without spending observed input records on unsupported languages', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-retention-call-filter-'));
    directories.push(directory);
    fs.writeFileSync(
      path.join(directory, 'a.ts'),
      'export function run() {}\nfunction helper() {}\nhelper();\n',
    );
    fs.writeFileSync(
      path.join(directory, 'lib.go'),
      [
        'package fixture',
        'func go_fn() {}',
        'func caller() { go_fn(); other(); }',
        'type S struct {}',
        'func (s S) m() { go_fn(); }',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(directory, 'tool.py'),
      ['def py_fn():', '    pass', '', 'def caller():', '    py_fn()', '    print(1)'].join('\n'),
    );

    let consumed = false;
    const result = await runPipelineFromRepo(directory, () => {}, {
      skipGraphPhases: true,
      skipWorkers: true,
      scopeRetention: {
        deadline: Date.now() + 60_000,
        artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
        consume: async (handle) => {
          consumed = true;
          const calls: ExtractedCall[] = [];
          for await (const batch of handle.iterateCalls()) calls.push(...batch);

          expect(calls.filter((call) => /\.go$/.test(call.filePath))).toEqual([]);
          expect(calls).toContainEqual(
            expect.objectContaining({
              filePath: 'a.ts',
              calledName: 'helper',
            }),
          );
          expect(calls).toContainEqual(
            expect.objectContaining({
              filePath: 'tool.py',
              calledName: 'py_fn',
            }),
          );
          expect(handle.callRecordCount).toBe(calls.length);

          for (const records of [
            handle.iterateHeritage(),
            handle.iterateAssignments(),
            handle.iterateConstructorBindings(),
          ]) {
            for await (const batch of records) {
              expect(batch.filter((record) => /\.go$/.test(record.filePath))).toEqual([]);
            }
          }
          expect(handle.reasons).not.toContain('call-count-limit');
          const nodeIds = new Set<string>();
          let retainedPythonFunction = false;
          for await (const batch of handle.iterateGraphNodes()) {
            for (const node of batch) {
              nodeIds.add(node.id);
              expect(node.properties.filePath).not.toMatch(/\.go$/);
              if (node.properties.filePath === 'tool.py' && node.properties.name === 'py_fn') {
                retainedPythonFunction = true;
              }
            }
          }
          expect([...nodeIds].some((id) => id.includes('a.ts'))).toBe(true);
          expect(retainedPythonFunction).toBe(true);
          for await (const batch of handle.iterateGraphRelationships()) {
            for (const edge of batch) {
              expect(edge.sourceId).not.toMatch(/\.go/);
              expect(edge.targetId).not.toMatch(/\.go/);
            }
          }
          expect(
            [...handle.inventory].sort((left, right) =>
              left.filePath.localeCompare(right.filePath),
            ),
          ).toStrictEqual([
            { filePath: 'a.ts', status: 'retained' },
            { filePath: 'lib.go', status: 'unsupported' },
            { filePath: 'tool.py', status: 'failed', reason: 'unsupported-syntax' },
          ]);
          expect(handle.seedReady).toBe(false);
        },
      },
    });
    expect(consumed).toBe(true);
    expect(result.usedWorkerPool).toBe(false);
  }, 90_000);
});
