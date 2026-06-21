import { describe, expect, it } from 'vitest';
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
      it('keeps file-focused functions in the seed set instead of truncating to an arbitrary first five matches', async () => {
        const result = await runRepomap(
          { id: handle.repoId },
          { focus: ['src/focus.ts'], format: 'full', token_budget: 5000 },
        );

        expect(result.status).toBe('success');
        expect(result.symbol_count).toBeGreaterThanOrEqual(2);

        const names = result.symbols.map((symbol: any) => symbol.name);
        expect(names).toContain('coreHandler');

        const coreHandler = result.symbols.find((symbol: any) => symbol.name === 'coreHandler');
        expect(coreHandler).toBeDefined();
        expect(coreHandler.isFocus).toBe(true);
        expect(coreHandler.type).toBe('Function');
      });

      it('enriches empty Ladybug labels before serializing symbols', async () => {
        const result = await runRepomap(
          { id: handle.repoId },
          { focus: ['src/focus.ts'], format: 'full', token_budget: 5000 },
        );

        const focusShape = result.symbols.find((symbol: any) => symbol.name === 'FocusShapeA');
        expect(focusShape).toBeDefined();
        expect(focusShape.type).toBe('Interface');
      });

      it('returns files-only projection for files format', async () => {
        const result = await runRepomap(
          { id: handle.repoId },
          { focus: ['src/focus.ts'], format: 'files', token_budget: 5000 },
        );

        expect(result.status).toBe('success');
        expect(result.format).toBe('files');
        expect(result.readFirstFiles.map((entry) => entry.filePath).includes('src/focus.ts')).toBe(
          true,
        );
        expect(result.readFirstFiles.map((entry) => entry.filePath).includes('src/util.ts')).toBe(
          true,
        );
        expect(result.omittedCounts.total).toBeGreaterThanOrEqual(0);
        expect(result.readFirstFiles.length).toBeGreaterThanOrEqual(1);
        expect(result.symbol_count).toBeGreaterThan(0);
        expect(result.tokens_used).toBeGreaterThan(0);
        expect('symbols' in result).toBe(false);
      });
    });
  },
  { seed: REPOMAP_SEED, poolAdapter: true },
);
