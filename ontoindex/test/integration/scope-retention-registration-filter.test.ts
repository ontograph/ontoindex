import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { SemanticModelRegistrationEvent } from '../../src/core/ingestion/model/semantic-model.js';

describe('scope retention model registration filtering', () => {
  const directories: string[] = [];

  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('retains supported registrations without spending records on unsupported languages', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ontoindex-retention-registration-filter-'),
    );
    directories.push(directory);
    fs.writeFileSync(path.join(directory, 'a.ts'), 'export function run() {}\n');
    fs.writeFileSync(
      path.join(directory, 'lib.go'),
      'package fixture\nfunc go_fn() {}\ntype S struct {}\n',
    );
    fs.writeFileSync(
      path.join(directory, 'tool.py'),
      'def py_fn():\n    pass\nclass K:\n    pass\n',
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
          const events: SemanticModelRegistrationEvent[] = [];
          for await (const batch of handle.iterateModelRegistrations()) events.push(...batch);

          expect(
            events.filter((event) => event.kind === 'symbol.add' && /\.go$/.test(event.filePath)),
          ).toEqual([]);
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: 'symbol.add',
              filePath: 'a.ts',
              name: 'run',
            }),
          );
          for (const name of ['py_fn', 'K']) {
            expect(events).toContainEqual(
              expect.objectContaining({
                kind: 'symbol.add',
                filePath: 'tool.py',
                name,
              }),
            );
          }
          expect(handle.modelRegistrationRecordCount).toBe(events.length);
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
          expect(handle.reasons).not.toContain('model-registration-incomplete');
          expect(handle.reasons).not.toContain('model-registration-count-limit');
        },
      },
    });
    expect(consumed).toBe(true);
    expect(result.usedWorkerPool).toBe(false);
  }, 90_000);
});
