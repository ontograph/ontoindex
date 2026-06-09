import { describe, expect, it, vi } from 'vitest';
import * as poolAdapter from '../../src/core/lbug/pool-adapter.js';
import { runCycleDetect } from '../../src/mcp/local/backend-cycle-detect.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

const CYCLE_SEED = [
  `CREATE (a:File {id: 'file:src/lib/a.ts', name: 'a.ts', filePath: 'src/lib/a.ts', content: ''})`,
  `CREATE (b:File {id: 'file:src/lib/b.ts', name: 'b.ts', filePath: 'src/lib/b.ts', content: ''})`,
  `CREATE (fa:Function {id: 'func:alpha', name: 'alpha', filePath: 'src/services/alpha.ts', startLine: 1, endLine: 5, isExported: true, content: '', description: ''})`,
  `CREATE (fb:Function {id: 'func:beta', name: 'beta', filePath: 'src/services/beta.ts', startLine: 1, endLine: 5, isExported: true, content: '', description: ''})`,
  `MATCH (a:File), (b:File) WHERE a.id = 'file:src/lib/a.ts' AND b.id = 'file:src/lib/b.ts'
   CREATE (a)-[:CodeRelation {type: 'IMPORTS', confidence: 1.0, reason: 'import', step: 0}]->(b)`,
  `MATCH (a:File), (b:File) WHERE a.id = 'file:src/lib/b.ts' AND b.id = 'file:src/lib/a.ts'
   CREATE (a)-[:CodeRelation {type: 'IMPORTS', confidence: 1.0, reason: 'import', step: 0}]->(b)`,
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:alpha' AND b.id = 'func:beta'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:beta' AND b.id = 'func:alpha'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
];

withTestLbugDB(
  'backend-cycle-detect',
  (handle) => {
    describe('runCycleDetect', () => {
      it('detects import and call cycles by SCC', async () => {
        const result = await runCycleDetect(
          { id: handle.repoId, name: 'cycle-test' },
          { edge_types: ['IMPORTS', 'CALLS'] },
        );

        expect(result.status).toBe('success');
        expect(result.summary.total_cycles).toBe(2);
        expect(result.summary.largest_cycle_size).toBe(2);
        expect(result.summary.affected_files).toBe(4);
        expect(result.cycles).toHaveLength(2);
        expect(result.cycles).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              cycle_length: 2,
              edge_types: ['IMPORTS'],
              members: expect.arrayContaining([
                expect.objectContaining({ filePath: 'src/lib/a.ts', kind: 'File' }),
                expect.objectContaining({ filePath: 'src/lib/b.ts', kind: 'File' }),
              ]),
            }),
            expect.objectContaining({
              cycle_length: 2,
              edge_types: ['CALLS'],
              members: expect.arrayContaining([
                expect.objectContaining({ name: 'alpha', kind: 'Function' }),
                expect.objectContaining({ name: 'beta', kind: 'Function' }),
              ]),
            }),
          ]),
        );
      });

      it('returns stable golden SCC output ordering and shape', async () => {
        const result = await runCycleDetect(
          { id: handle.repoId, name: 'cycle-test' },
          { edge_types: ['IMPORTS', 'CALLS'] },
        );

        expect(result).toEqual({
          status: 'success',
          tool: 'cycle_detect',
          repo: 'cycle-test',
          edge_types: ['IMPORTS', 'CALLS'],
          min_cycle_length: 2,
          limit: 30,
          cycles: [
            {
              cycle_length: 2,
              affected_files: 2,
              edge_types: ['IMPORTS'],
              members: [
                {
                  id: 'file:src/lib/a.ts',
                  name: 'a.ts',
                  filePath: 'src/lib/a.ts',
                  kind: 'File',
                },
                {
                  id: 'file:src/lib/b.ts',
                  name: 'b.ts',
                  filePath: 'src/lib/b.ts',
                  kind: 'File',
                },
              ],
            },
            {
              cycle_length: 2,
              affected_files: 2,
              edge_types: ['CALLS'],
              members: [
                {
                  id: 'func:alpha',
                  name: 'alpha',
                  filePath: 'src/services/alpha.ts',
                  kind: 'Function',
                },
                {
                  id: 'func:beta',
                  name: 'beta',
                  filePath: 'src/services/beta.ts',
                  kind: 'Function',
                },
              ],
            },
          ],
          warnings: [],
          summary: {
            total_cycles: 2,
            largest_cycle_size: 2,
            affected_files: 4,
          },
        });
      });

      it('filters cycles by edge type', async () => {
        const result = await runCycleDetect(
          { id: handle.repoId, name: 'cycle-test' },
          { edge_types: ['IMPORTS'] },
        );

        expect(result.status).toBe('success');
        expect(result.summary.total_cycles).toBe(1);
        expect(result.cycles).toHaveLength(1);
        expect(result.cycles[0].edge_types).toEqual(['IMPORTS']);
        expect(result.cycles[0].members.map((member) => member.filePath)).toEqual([
          'src/lib/a.ts',
          'src/lib/b.ts',
        ]);
      });

      it('applies file_filter to the analyzed subgraph', async () => {
        const result = await runCycleDetect(
          { id: handle.repoId, name: 'cycle-test' },
          { edge_types: ['CALLS'], file_filter: 'src/services/**' },
        );

        expect(result.status).toBe('success');
        expect(result.summary.total_cycles).toBe(1);
        expect(result.cycles).toHaveLength(1);
        expect(result.cycles[0].members.map((member) => member.filePath)).toEqual([
          'src/services/alpha.ts',
          'src/services/beta.ts',
        ]);
      });

      it('preserves template interpolation behavior for Symbol error messages', async () => {
        const thrown = { message: Symbol('cycle') };
        const executeSpy = vi
          .spyOn(poolAdapter, 'executeParameterized')
          .mockRejectedValueOnce(thrown);
        try {
          await expect(
            runCycleDetect({ id: handle.repoId, name: 'cycle-test' }, { edge_types: ['CALLS'] }),
          ).rejects.toThrow(TypeError);
        } finally {
          executeSpy.mockRestore();
        }
      });
    });
  },
  { seed: CYCLE_SEED, poolAdapter: true },
);
