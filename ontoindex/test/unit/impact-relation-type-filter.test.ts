import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn().mockResolvedValue([]),
}));

import * as poolAdapter from '../../src/core/lbug/pool-adapter.js';
import {
  buildRelationTypePredicate,
  runImpactKernel,
} from '../../src/core/impact/impact-kernel.js';

// LadybugDB 0.17.1 returns wrong rows for `r.type IN [...]` against unlabeled
// nodes of mixed labels (drops some callers, repeats others). The impact
// traversal must filter relation types with `=` comparisons instead.
describe('impact relation-type filter', () => {
  beforeEach(() => {
    vi.mocked(poolAdapter.executeParameterized).mockReset().mockResolvedValue([]);
  });

  it('builds an OR chain of equality checks and deduplicates types', () => {
    expect(buildRelationTypePredicate(['CALLS'])).toBe("r.type = 'CALLS'");
    expect(buildRelationTypePredicate(['CALLS', 'IMPORTS', 'CALLS'])).toBe(
      "(r.type = 'CALLS' OR r.type = 'IMPORTS')",
    );
  });

  it.each(['upstream', 'downstream'] as const)(
    'never sends `r.type IN` in the %s traversal query',
    async (direction) => {
      await runImpactKernel(
        { id: 'repo' },
        { id: 'Function:src/a.ts:f', type: 'Function' },
        { direction, maxDepth: 1, classSeedExpansion: false },
      );
      const queries = vi
        .mocked(poolAdapter.executeParameterized)
        .mock.calls.map(([, query]) => String(query));
      expect(queries.length).toBeGreaterThan(0);
      for (const query of queries) {
        expect(query).not.toMatch(/r\.type\s+IN\s*\[/);
        expect(query).toContain("r.type = 'CALLS'");
        expect(query).toContain("r.type = 'METHOD_IMPLEMENTS'");
      }
    },
  );
});
