import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('scope retention binding input filtering', () => {
  const directories: string[] = [];

  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('excludes unsupported languages from retained file bindings and exported types', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-retention-binding-filter-'));
    directories.push(directory);
    fs.writeFileSync(
      path.join(directory, 'a.ts'),
      ['export class Service {}', 'export function make() {', '  return 1;', '}', 'make();'].join(
        '\n',
      ),
    );
    fs.writeFileSync(
      path.join(directory, 'lib.go'),
      [
        'package fixture',
        'type Service struct {}',
        'func make() Service {',
        '    var local Service',
        '    return local',
        '}',
        'func caller() { var service Service = make(); _ = service }',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(directory, 'tool.py'),
      [
        'class Service:',
        '    pass',
        '',
        'service: Service = Service()',
        '',
        'def make() -> Service:',
        '    local: Service = Service()',
        '    return local',
        '',
        'make()',
      ].join('\n'),
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
          // These families may be empty: only resolved file-scope bindings and
          // exported symbols with type metadata reach their respective producers.
          for await (const batch of handle.iterateFileBindings()) {
            for (const record of batch) {
              expect(record.filePath).not.toMatch(/\.go$/);
              expect(['a.ts', 'tool.py']).toContain(record.filePath);
            }
          }
          for await (const batch of handle.iterateExportedTypes()) {
            for (const record of batch) {
              expect(record.filePath).not.toMatch(/\.go$/);
              expect(['a.ts', 'tool.py']).toContain(record.filePath);
            }
          }

          // Positive fixture evidence keeps empty binding/type output from
          // hiding a pipeline that never parsed the supported source.
          let retainedMakeCall = false;
          for await (const batch of handle.iterateCalls()) {
            if (batch.some((call) => call.filePath === 'a.ts' && call.calledName === 'make')) {
              retainedMakeCall = true;
            }
          }
          expect(retainedMakeCall).toBe(true);
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
