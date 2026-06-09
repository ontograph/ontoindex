import { describe, expect, it } from 'vitest';
import { diffGraphEdgeSets } from '../../src/mcp/local/backend-graph-diff-kernel.js';

describe('graph diff kernel', () => {
  it('compares snapshot and current edge rows without DB access', () => {
    const diff = diffGraphEdgeSets(
      {
        calleesMap: {
          n_a: ['n_b'],
          n_b: ['n_c'],
        },
        fileToSymbols: {
          'src/a.ts': ['n_a'],
          'src/b.ts': ['n_b'],
          'src/c.ts': ['n_c'],
        },
      },
      [
        {
          sourceId: 'n_a',
          targetId: 'n_b',
          relType: 'CALLS',
          sourceName: 'A',
          sourceFile: 'src/a.ts',
          sourceCommunity: 'c1',
          targetName: 'B',
          targetFile: 'src/b.ts',
          targetCommunity: 'c1',
        },
        {
          sourceId: 'n_x',
          targetId: 'n_y',
          relType: 'IMPORTS',
          sourceName: 'X',
          sourceFile: 'src/x.ts',
          sourceCommunity: 'c1',
          targetName: 'Y',
          targetFile: 'src/y.ts',
          targetCommunity: 'c2',
        },
      ],
    );

    expect(diff).toEqual({
      crossCommunityAddedCount: 1,
      added: [
        {
          source_id: 'n_x',
          source_name: 'X',
          source_file: 'src/x.ts',
          target_id: 'n_y',
          target_name: 'Y',
          target_file: 'src/y.ts',
          rel_type: 'IMPORTS',
          cross_community: true,
        },
      ],
      removed: [
        {
          source_id: 'n_b',
          source_file: 'src/b.ts',
          target_id: 'n_c',
          target_file: 'src/c.ts',
        },
      ],
    });
  });
});
