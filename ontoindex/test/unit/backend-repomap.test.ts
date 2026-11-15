import { describe, expect, it, vi } from 'vitest';
import * as poolAdapter from '../../src/core/lbug/pool-adapter.js';
import { runRepomap } from '../../src/mcp/local/backend-repomap.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

const REPOMAP_SEED = [
  `CREATE (f:File {id: 'file:focus.ts', name: 'focus.ts', filePath: 'src/focus.ts', content: 'focus module'})`,
  `CREATE (i:Interface {id: 'iface:FocusShapeA', name: 'FocusShapeA', filePath: 'src/focus.ts', startLine: 1, endLine: 3, content: 'interface FocusShapeA {}', description: 'shape a'})`,
  `CREATE (i:Interface {id: 'iface:FocusShapeB', name: 'FocusShapeB', filePath: 'src/focus.ts', startLine: 5, endLine: 7, content: 'interface FocusShapeB {}', description: 'shape b'})`,
  `CREATE (i:Interface {id: 'iface:FocusShapeC', name: 'FocusShapeC', filePath: 'src/focus.ts', startLine: 9, endLine: 11, content: 'interface FocusShapeC {}', description: 'shape c'})`,
  `CREATE (i:Interface {id: 'iface:FocusShapeD', name: 'FocusShapeD', filePath: 'src/focus.ts', startLine: 13, endLine: 15, content: 'interface FocusShapeD {}', description: 'shape d'})`,
  `CREATE (i:Interface {id: 'iface:FocusShapeE', name: 'FocusShapeE', filePath: 'src/focus.ts', startLine: 17, endLine: 19, content: 'interface FocusShapeE {}', description: 'shape e'})`,
  `CREATE (fn:Function {id: 'func:coreHandler', name: 'coreHandler', filePath: 'src/focus.ts', startLine: 120, endLine: 150, isExported: true, content: 'function coreHandler() { return helper(); }', description: 'core handler'})`,
  `CREATE (fn:Function {id: 'func:helper', name: 'helper', filePath: 'src/focus.ts', startLine: 152, endLine: 160, isExported: false, content: 'function helper() { return 1; }', description: 'helper'})`,
  `CREATE (fn:Function {id: 'func:utilHelper', name: 'utilHelper', filePath: 'src/util.ts', startLine: 4, endLine: 10, isExported: false, content: 'function utilHelper() { return helper(); }', description: 'utility helper'})`,
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:coreHandler' AND b.id = 'func:helper'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
  `MATCH (a:Function), (b:Function) WHERE a.id = 'func:utilHelper' AND b.id = 'func:helper'
   CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.7, reason: 'utility', step: 0}]->(b)`,
];

withTestLbugDB(
  'backend-repomap',
  (handle) => {
    describe('runRepomap', () => {
      it.each(['signatures', 'outline', 'full', 'compressed', 'files'] as const)(
        'preserves %s output when unlabeled content projections exhaust the pool',
        async (format) => {
          const params = { focus: ['src/focus.ts'], format, token_budget: 5000 };
          const baseline = await runRepomap({ id: handle.repoId }, params);
          const execute = poolAdapter.executeParameterized;
          const spy = vi
            .spyOn(poolAdapter, 'executeParameterized')
            .mockImplementation(async (graphId, cypher, params) => {
              if (/MATCH \(n\)/.test(cypher) && cypher.includes('.content')) {
                throw new Error(
                  'Buffer manager exception: buffer pool is full and no memory could be freed',
                );
              }
              return execute(graphId, cypher, params);
            });
          try {
            expect(await runRepomap({ id: handle.repoId }, params)).toEqual(baseline);
            const contentCalls = spy.mock.calls.filter(([, cypher]) => cypher.includes('.content'));
            if (format === 'files') expect(contentCalls).toHaveLength(0);
            else {
              expect(contentCalls.length).toBeGreaterThan(0);
              for (const [, cypher, params] of contentCalls) {
                expect(cypher).toMatch(/MATCH \(n:`\w+` \{id: \$id\}\)/);
                expect(params).toHaveProperty('id');
              }
            }
          } finally {
            spy.mockRestore();
          }
        },
      );

      it('resolves a file name through the File fallback', async () => {
        const result = await runRepomap(
          { id: handle.repoId },
          { focus: ['focus.ts'], format: 'full', token_budget: 5000 },
        );
        expect(result).toMatchObject({
          status: 'success',
          symbols: [
            expect.objectContaining({
              uid: 'file:focus.ts',
              type: 'File',
              content: 'focus module',
            }),
          ],
        });
      });

      it('keeps file-focused functions in the seed set instead of truncating to an arbitrary first five matches', async () => {
        const result = await runRepomap(
          { id: handle.repoId },
          { focus: ['src/focus.ts'], format: 'full', token_budget: 5000 },
        );

        expect((result as unknown as Record<string, any>).status).toBe('success');
        expect((result as unknown as Record<string, any>).symbol_count).toBeGreaterThanOrEqual(2);

        const names = (result as unknown as Record<string, any>).symbols.map(
          (symbol: any) => symbol.name,
        );
        expect(names).toContain('coreHandler');

        const coreHandler = (result as unknown as Record<string, any>).symbols.find(
          (symbol: any) => symbol.name === 'coreHandler',
        );
        expect(coreHandler).toBeDefined();
        expect(coreHandler.isFocus).toBe(true);
        expect(coreHandler.type).toBe('Function');
      });

      it('projects the native Ladybug label before serializing symbols', async () => {
        const result = await runRepomap(
          { id: handle.repoId },
          { focus: ['src/focus.ts'], format: 'full', token_budget: 5000 },
        );

        const focusShape = (result as unknown as Record<string, any>).symbols.find(
          (symbol: any) => symbol.name === 'FocusShapeA',
        );
        expect(focusShape).toBeDefined();
        expect(focusShape.type).toBe('Interface');
      });

      it('returns files-only projection for files format', async () => {
        const result = await runRepomap(
          { id: handle.repoId },
          { focus: ['src/focus.ts'], format: 'files', token_budget: 5000 },
        );

        expect((result as unknown as Record<string, any>).status).toBe('success');
        expect((result as unknown as Record<string, any>).format).toBe('files');
        expect(
          (result as unknown as Record<string, any>).readFirstFiles
            .map((entry) => entry.filePath)
            .includes('src/focus.ts'),
        ).toBe(true);
        expect(
          (result as unknown as Record<string, any>).readFirstFiles
            .map((entry) => entry.filePath)
            .includes('src/util.ts'),
        ).toBe(true);
        expect(
          (result as unknown as Record<string, any>).omittedCounts.total,
        ).toBeGreaterThanOrEqual(0);
        expect(
          (result as unknown as Record<string, any>).readFirstFiles.length,
        ).toBeGreaterThanOrEqual(1);
        expect((result as unknown as Record<string, any>).symbol_count).toBeGreaterThan(0);
        expect((result as unknown as Record<string, any>).tokens_used).toBeGreaterThan(0);
        expect('symbols' in result).toBe(false);
      });
    });
  },
  { seed: REPOMAP_SEED, poolAdapter: true },
);

withTestLbugDB(
  'backend-repomap-budget',
  (handle) => {
    it('hydrates in rank order, skips oversized candidates, and stops at the exact budget', async () => {
      const contentReads: string[] = [];
      const execute = poolAdapter.executeParameterized;
      const spy = vi
        .spyOn(poolAdapter, 'executeParameterized')
        .mockImplementation(async (graphId, cypher, params) => {
          if (/MATCH \(n:`Function` \{id: \$id\}\)/.test(cypher) && cypher.includes('AS content')) {
            contentReads.push(params?.id as string);
          }
          return execute(graphId, cypher, params);
        });
      try {
        // HEAD fills ordered file seeds first. With no edges each score is
        // (1 - 0.85) / 4. Its serialized entries have 171/567/175/179 chars,
        // so ceil(length / 4) costs 43/142/44/45 tokens for A/B/C/D.
        const result = await runRepomap(
          { id: handle.repoId },
          { focus: ['src/budget.ts'], format: 'full', token_budget: 87 },
        );
        expect(contentReads).toEqual(['func:budgetA', 'func:budgetB', 'func:budgetC']);
        expect(result).toMatchObject({ status: 'success', symbol_count: 2, tokens_used: 87 });
        if ('symbols' in result) {
          expect(result.symbols.map((symbol) => symbol.uid)).toEqual([
            'func:budgetA',
            'func:budgetC',
          ]);
        } else {
          throw new Error('Expected repomap symbols');
        }
      } finally {
        spy.mockRestore();
      }
    });
  },
  {
    seed: [4, 400, 8, 12].map((length, index) => {
      const suffix = String.fromCharCode(65 + index);
      return `CREATE (n:Function {id: 'func:budget${suffix}', name: 'budget${suffix}', filePath: 'src/budget.ts', startLine: ${index + 1}, endLine: ${index + 1}, content: '${'x'.repeat(length)}'})`;
    }),
    poolAdapter: true,
  },
);
