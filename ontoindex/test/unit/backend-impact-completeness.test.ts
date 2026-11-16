import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  executeParameterized: vi.fn(),
}));

import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { impactResultCompleteness, runImpact } from '../../src/mcp/local/backend-impact.js';

describe('impact result completeness', () => {
  it('recognizes the real first-traversal failure without an error property', async () => {
    const uid = 'Function:src/auth.ts:login';
    vi.mocked(executeParameterized).mockImplementation(async (_repo, _query, params) => {
      if (params?.uid === uid) {
        return [
          {
            id: uid,
            name: 'login',
            type: 'Function',
            filePath: 'src/auth.ts',
            startLine: 1,
            endLine: 2,
          },
        ];
      }
      throw new Error('DB unavailable');
    });
    const result = await runImpact(
      { id: 'repo', name: 'repo' },
      { target: 'login', target_uid: uid, direction: 'upstream' },
    );
    expect(result).toMatchObject({
      target: { id: uid },
      impactedCount: 0,
      risk: 'UNKNOWN',
      partial: true,
      summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
      affected_processes: [],
      affected_modules: [],
      byDepth: {},
    });
    expect(result.error).toBeUndefined();
    expect(impactResultCompleteness(result)).toBe('failed');
  });
});
