import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { summarizeScopeRetentionCoverage } from '../../src/core/ingestion/pipeline-phases/scope-retention-coverage.js';

describe('type-only scope retention coverage', () => {
  const directories: string[] = [];

  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('retains type-only files while refusing unsupported runtime syntax', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-retention-type-only-'));
    directories.push(directory);
    fs.writeFileSync(
      path.join(directory, 'a.ts'),
      [
        '// Generated type declarations.',
        'import type { B } from "./b";',
        'export type A = { b: B | null, name: string, };',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(path.join(directory, 'b.ts'), 'export type B = { id: number, };\n');
    fs.writeFileSync(
      path.join(directory, 'ports.ts'),
      [
        'export interface BackendPort { init(): Promise<boolean>; callTool(method: string, params: unknown): Promise<unknown>; dispose(): Promise<void>; }',
        'export interface GroupBackendPort extends BackendPort { listGroups(): Promise<unknown>; syncGroup(groupName: string): Promise<unknown>; }',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(directory, 'reference-site.tsx'),
      [
        'import type { B } from "./b";',
        'export type ReferenceKind = "call" | "read";',
        'export interface ReferenceSite { readonly name: string; readonly kind: ReferenceKind; readonly value?: B; }',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(directory, 'm.ts'),
      [
        'export type M = { n: number };',
        'export const { value: { nested } } = { value: { nested: 1 } };',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(directory, 'ordinary.ts'),
      [
        'import Main, { B as Renamed } from "./b";',
        'import * as types from "./b";',
        'import type { A } from "./a";',
        'export type Ordinary = Main | Renamed | types.B | A;',
        'export interface Port { value: Ordinary; }',
      ].join('\n') + '\n',
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
          expect(
            [...handle.inventory].sort((left, right) =>
              left.filePath.localeCompare(right.filePath),
            ),
          ).toStrictEqual([
            { filePath: 'a.ts', status: 'retained' },
            { filePath: 'b.ts', status: 'retained' },
            { filePath: 'm.ts', status: 'failed', reason: 'unsupported-syntax' },
            { filePath: 'ordinary.ts', status: 'retained' },
            { filePath: 'ports.ts', status: 'retained' },
            { filePath: 'reference-site.tsx', status: 'retained' },
          ]);
          expect(summarizeScopeRetentionCoverage(handle.inventory)).toEqual({
            version: 1,
            languages: [
              {
                language: 'typescript',
                files: 6,
                retained: 5,
                skipped: 0,
                refused: 1,
                unaccounted: 0,
                unparsed: 0,
                refusalReasons: [{ reason: 'unsupported-syntax', count: 1 }],
              },
            ],
            complete: false,
          });
        },
      },
    });
    expect(consumed).toBe(true);
    expect(result.usedWorkerPool).toBe(false);
  }, 90_000);
});
