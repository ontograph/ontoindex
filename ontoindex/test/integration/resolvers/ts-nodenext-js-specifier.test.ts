/**
 * TypeScript NodeNext/ESM imports name the emitted `.js` file while the repo
 * only holds the `.ts` source. The import must still resolve so cross-file
 * CALLS edges reach exported helpers, including `export const` arrow functions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  runPipelineFromRepo,
  type PipelineOptions,
  type PipelineResult,
} from './helpers.js';

const PARSE_PATHS: Array<[string, PipelineOptions | undefined]> = [
  ['sequential', undefined],
  ['worker', { workerThresholdsForTest: { minFiles: 1, minBytes: 0 } }],
];

describe.each(PARSE_PATHS)(
  'TypeScript NodeNext `.js` import specifiers (%s parse)',
  (_, options) => {
    let result: PipelineResult;

    beforeAll(async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'ts-nodenext-js-specifier'),
        () => {},
        options,
      );
    }, 60000);

    it('emits a file IMPORTS edge to the .ts source', () => {
      const imports = getRelationships(result, 'IMPORTS').filter(
        (e) => e.sourceFilePath === 'src/app/handler.ts',
      );
      expect(imports.map((e) => e.targetFilePath)).toContain('src/lib/pool.ts');
    });

    it('emits cross-file CALLS edges to the imported function and const arrow helper', () => {
      const calls = getRelationships(result, 'CALLS').filter(
        (e) => e.source === 'handle' && e.targetFilePath === 'src/lib/pool.ts',
      );
      expect(calls.map((e) => e.target).sort()).toEqual(['isWrite', 'runQuery']);
    });

    it('emits one Function node for an exported const arrow and keeps plain consts', () => {
      const ids: string[] = [];
      result.graph.forEachNode((node) => {
        if (node.properties.filePath === 'src/lib/pool.ts' && node.label !== 'File')
          ids.push(node.id);
      });
      expect(ids.filter((id) => id.endsWith(':runQuery'))).toEqual([
        'Function:src/lib/pool.ts:runQuery',
      ]);
      expect(ids).toContain('Const:src/lib/pool.ts:POOL_SIZE');
    });
  },
);
