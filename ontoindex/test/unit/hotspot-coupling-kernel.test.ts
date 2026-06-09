import { describe, expect, it } from 'vitest';
import { computeCoupling } from '../../src/mcp/local/backend-hotspot-coupling-kernel.js';

describe('hotspot coupling kernel', () => {
  it('counts deterministic co-change pairs from commit file rows', () => {
    expect(
      computeCoupling([
        { files: ['src/b.ts', 'src/a.ts', 'src/a.ts'] },
        { files: ['src/a.ts'] },
        { files: ['src/a.ts', 'src/b.ts'] },
        { files: ['src/c.ts'] },
      ]),
    ).toEqual([
      {
        file_a: 'src/a.ts',
        file_b: 'src/b.ts',
        co_changes: 2,
        commits_a: 3,
        commits_b: 2,
        coupling_ratio: 1,
      },
    ]);
  });
});
