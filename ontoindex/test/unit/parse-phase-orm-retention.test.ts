import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as walker from '../../src/core/ingestion/filesystem-walker.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { ExtractedORMQuery } from '../../src/core/ingestion/workers/parse-types.js';

describe('ORM producer completion', () => {
  it.each([
    'empty',
    'nonempty',
    'supabase',
    'mixed',
    'missing-final-read',
    'optional',
    'computed',
    'spread',
  ] as const)(
    '%s preserves observation evidence',
    async (mode) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orm-completion-'));
      const content =
        mode === 'empty'
          ? 'export function plain() {}\n'
          : mode === 'supabase'
            ? "supabase.from('posts').select('*');\n"
            : mode === 'mixed'
              ? "function plain() {}\nplain();\nprisma.user.findMany();\nsupabase.from('posts').select('*');\n"
              : mode === 'optional'
                ? 'prisma.user.findMany();\nclient?.run();\n'
                : mode === 'computed'
                  ? 'prisma.user.findMany();\nclient[method]();\n'
                  : mode === 'spread'
                    ? 'prisma.user.findMany();\nclient.run(...args);\n'
                    : 'prisma.user.findMany();\n';
      const expectedQueries: ExtractedORMQuery[] =
        mode === 'empty' || mode === 'missing-final-read'
          ? []
          : mode === 'supabase'
            ? [
                {
                  filePath: 'query.ts',
                  orm: 'supabase',
                  model: 'posts',
                  method: 'select',
                  lineNumber: 0,
                },
              ]
            : mode === 'mixed'
              ? [
                  {
                    filePath: 'query.ts',
                    orm: 'prisma',
                    model: 'user',
                    method: 'findMany',
                    lineNumber: 2,
                  },
                  {
                    filePath: 'query.ts',
                    orm: 'supabase',
                    model: 'posts',
                    method: 'select',
                    lineNumber: 3,
                  },
                ]
              : [
                  {
                    filePath: 'query.ts',
                    orm: 'prisma',
                    model: 'user',
                    method: 'findMany',
                    lineNumber: 0,
                  },
                ];
      fs.writeFileSync(path.join(repo, 'query.ts'), content);
      const read = walker.readFileContents;
      let reads = 0;
      const spy = vi.spyOn(walker, 'readFileContents').mockImplementation(async (...args) => {
        const result = await read(...args);
        if (args[0] === repo && ++reads === 3 && mode === 'missing-final-read') result.clear();
        return result;
      });
      let consumed = false;
      try {
        await runPipelineFromRepo(repo, () => {}, {
          skipWorkers: true,
          skipGraphPhases: true,
          scopeRetention: {
            deadline: Date.now() + 60_000,
            artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
            consume: async (handle) => {
              consumed = true;
              expect(handle.seedReady).toBe(false);
              const unsupported = mode === 'computed';
              expect(handle.producerCompletion['orm-queries']).toBe(
                mode !== 'missing-final-read' && !unsupported,
              );
              if (unsupported) expect(handle.reasons).toContain('unsupported-syntax');
              else if (mode !== 'missing-final-read')
                expect(handle.reasons).not.toContain('unsupported-syntax');
              expect(handle.ormQueryRecordCount).toBe(expectedQueries.length);
              const queries: ExtractedORMQuery[] = [];
              for await (const batch of handle.iterateORMQueries()) queries.push(...batch);
              expect(queries).toEqual(expectedQueries);
              if (mode === 'missing-final-read')
                expect(handle.reasons).toContain('orm-queries-producer-incomplete');
            },
          },
        });
        expect(consumed).toBe(true);
        expect(reads).toBe(3);
      } finally {
        spy.mockRestore();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
