import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/core/lsp/bridge.js', () => ({
  lspBridge: { getClient: vi.fn(async () => null) },
}));
vi.mock('../../src/mcp/super/_helpers/test-coverage.js', () => ({
  findTestFiles: vi.fn(),
}));
vi.mock('../../src/mcp/shared/target-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/shared/target-context.js')>()),
  resolveTargetContext: vi.fn(async () => ({
    version: 1,
    status: 'ok',
    repoKey: 'recency-schema',
    targetHead: 'fixture',
    currentHead: 'fixture',
    indexedHead: 'fixture',
    graphAuthority: { state: 'authoritative', reason: 'fixture schema matches source' },
    dirtyWorktree: false,
    changedSinceIndex: false,
    snapshotMode: 'committed-head',
    warnings: [],
  })),
}));
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn(async () => []),
}));

import * as poolAdapter from '../../src/core/lbug/pool-adapter.js';
import { gnSafeEditCheck, type EditCheckReport } from '../../src/mcp/super/safe-edit-check.js';
import { gnCanDelete } from '../../src/mcp/super/can-delete.js';
import { findTestFiles } from '../../src/mcp/super/_helpers/test-coverage.js';

const target = 'Function:src/target.ts:target';
const seed = [
  "CREATE (:File {id: 'File:src/target.ts', name: 'target.ts', filePath: 'src/target.ts', content: ''})",
  "CREATE (:File {id: 'File:src/sibling.ts', name: 'sibling.ts', filePath: 'src/sibling.ts', content: ''})",
  `CREATE (:Function {id: '${target}', name: 'target', filePath: 'src/target.ts', startLine: 1, endLine: 3, isExported: false, content: 'function target() { return 1; }'})`,
  "MATCH (a:File {id: 'File:src/target.ts'}), (b:File {id: 'File:src/sibling.ts'}) CREATE (a)-[:CodeRelation {type: 'CO_CHANGED_WITH', confidence: 0.8, reason: 'Co-changed 8 times', step: 0}]->(b)",
];

withTestLbugDB(
  'super-recency-schema',
  (db) => {
    let querySpy: MockInstance<typeof poolAdapter.executeParameterized>;

    beforeEach(() => {
      querySpy = vi.spyOn(poolAdapter, 'executeParameterized');
      vi.mocked(findTestFiles).mockResolvedValue({
        coveringTests: ['test/target.test.ts'],
        likelihoodOfCoverage: 'HIGH',
      });
    });
    afterEach(() => vi.restoreAllMocks());

    async function expectSupportedQueries() {
      const queries = querySpy.mock.calls.map(([, query]) => query);
      expect(queries.some((query) => query.includes('CO_CHANGED_WITH'))).toBe(true);
      expect(queries.every((query) => !query.includes('lastDate'))).toBe(true);
      for (const result of querySpy.mock.results) {
        expect(result.type).toBe('return');
        await expect(result.value).resolves.toBeDefined();
      }
    }

    it('keeps sibling evidence and unknown-recency caution with the real schema', async () => {
      const report = (await gnSafeEditCheck(db.repoId, { symbol: target })) as EditCheckReport;
      expect(report.symbol.nodeId).toBe(target);
      expect(report.freshness?.authoritative).toBe(true);
      expect(report.blastRadius.upstreamCount).toBe(0);
      expect(report.testCoverage.likelihoodOfCoverage).toBe('HIGH');
      expect(report.coChangeNetwork).toEqual({
        siblings: ['src/sibling.ts'],
        recentTouchDays: -1,
      });
      expect(report.verdict).toBe('CAUTION');
      expect(report.warnings).toContain(
        'Co-change recency unavailable: index does not store co-change dates.',
      );
      expect(report.reasoning).toMatch(/recency.*unavailable/i);
      expect(report.reasoning).not.toMatch(/recently active|Graph probes failed/);
      await expectSupportedQueries();
    });

    it('retains deletion sibling evidence instead of swallowing a schema error', async () => {
      vi.mocked(findTestFiles).mockResolvedValue({
        coveringTests: [],
        likelihoodOfCoverage: 'NONE',
      });
      const report = await gnCanDelete(db.repoId, { symbol: target });
      expect(report.symbol.nodeId).toBe(target);
      expect(report.coChangeNetwork).toEqual({
        siblings: ['src/sibling.ts'],
        recentTouchDays: -1,
      });
      expect(report.verdict).toBe('CAUTION');
      expect(report.warnings).toContain(
        'Co-change recency unavailable: index does not store co-change dates.',
      );
      expect(report.blockers.some((blocker) => blocker.type === 'co-change-recent')).toBe(false);
      await expectSupportedQueries();
    });
  },
  { seed, poolAdapter: true },
);
