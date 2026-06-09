import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { runGraphDiff } from '../../src/mcp/local/backend-graph-diff.js';

const execMock = executeParameterized as unknown as ReturnType<typeof vi.fn>;

async function makeRepoDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gn-graph-diff-'));
}

async function writeSnapshot(
  storageDir: string,
  snapshot: {
    lastCommit?: string;
    savedAt?: string;
    calleesMap?: Record<string, string[]>;
    fileToSymbols?: Record<string, string[]>;
  },
): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(path.join(storageDir, 'snapshot.json'), JSON.stringify(snapshot), 'utf8');
}

const createdDirs: string[] = [];

async function buildRepo(opts: { withSnapshot?: boolean } = {}): Promise<any> {
  const base = await makeRepoDir();
  createdDirs.push(base);
  const storage = path.join(base, '.ontoindex');
  await fs.mkdir(storage, { recursive: true });
  if (opts.withSnapshot) {
    await writeSnapshot(storage, {
      lastCommit: 'abc123',
      savedAt: '2026-04-01T00:00:00Z',
      calleesMap: {
        n_a: ['n_b'], // edge present in both snapshot and current
        n_b: ['n_c'], // edge present only in snapshot (removed)
      },
      fileToSymbols: {
        'src/a.ts': ['n_a'],
        'src/b.ts': ['n_b'],
        'src/c.ts': ['n_c'],
      },
    });
  }
  return { id: 'graph-diff-test', name: 'graph-diff-test', repoPath: base, storagePath: storage };
}

afterAll(async () => {
  for (const dir of createdDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('graph_diff', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it('returns empty success + note when no snapshot is present', async () => {
    const repo = await buildRepo({ withSnapshot: false });
    const result = await runGraphDiff(repo, {});
    expect(result.status).toBe('success');
    expect(result.snapshot_present).toBe(false);
    expect(result.added_count).toBe(0);
    expect(result.removed_count).toBe(0);
    expect(result.note).toMatch(/snapshot/i);
    // Must not have queried the DB in this path.
    expect(execMock).not.toHaveBeenCalled();
  });

  it('diffs added, removed, and flags cross-community edges', async () => {
    const repo = await buildRepo({ withSnapshot: true });
    // Current: keep n_a->n_b, drop n_b->n_c, add n_a->n_d (new) + n_x->n_y (new, cross-community)
    execMock.mockResolvedValueOnce([
      {
        sourceId: 'n_a',
        targetId: 'n_b',
        relType: 'CALLS',
        sourceName: 'A',
        sourceFile: 'src/a.ts',
        targetName: 'B',
        targetFile: 'src/b.ts',
        sourceCommunity: 'c1',
        targetCommunity: 'c1',
      },
      {
        sourceId: 'n_a',
        targetId: 'n_d',
        relType: 'CALLS',
        sourceName: 'A',
        sourceFile: 'src/a.ts',
        targetName: 'D',
        targetFile: 'src/d.ts',
        sourceCommunity: 'c1',
        targetCommunity: 'c1',
      },
      {
        sourceId: 'n_x',
        targetId: 'n_y',
        relType: 'IMPORTS',
        sourceName: 'X',
        sourceFile: 'src/x.ts',
        targetName: 'Y',
        targetFile: 'src/y.ts',
        sourceCommunity: 'c1',
        targetCommunity: 'c2',
      },
    ]);
    const result = await runGraphDiff(repo, {});
    expect(result).toEqual({
      status: 'success',
      tool: 'graph_diff',
      repo: 'graph-diff-test',
      snapshot_present: true,
      snapshot_saved_at: '2026-04-01T00:00:00Z',
      snapshot_commit: 'abc123',
      added_count: 2,
      removed_count: 1,
      cross_community_added_count: 1,
      added: [
        {
          source_id: 'n_a',
          source_name: 'A',
          source_file: 'src/a.ts',
          target_id: 'n_d',
          target_name: 'D',
          target_file: 'src/d.ts',
          rel_type: 'CALLS',
          cross_community: undefined,
        },
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

    const addedPairs = result.added.map((e) => `${e.source_id}->${e.target_id}`).sort();
    expect(addedPairs).toEqual(['n_a->n_d', 'n_x->n_y']);
    const crossAdded = result.added.filter((e) => e.cross_community);
    expect(crossAdded).toHaveLength(1);
    expect(crossAdded[0].source_id).toBe('n_x');

    const removedPairs = result.removed.map((e) => `${e.source_id}->${e.target_id}`);
    expect(removedPairs).toEqual(['n_b->n_c']);
    // Removed edges should use snapshot fileToSymbols to backfill file paths.
    expect(result.removed[0].source_file).toBe('src/b.ts');
    expect(result.removed[0].target_file).toBe('src/c.ts');
  });

  it('returns error response when db query fails', async () => {
    const repo = await buildRepo({ withSnapshot: true });
    execMock.mockRejectedValueOnce(new Error('pool not initialised'));
    const result = await runGraphDiff(repo, {});
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/failed to query/i);
    expect(result.snapshot_present).toBe(true);
  });

  it('respects the limit parameter', async () => {
    const repo = await buildRepo({ withSnapshot: true });
    const currentRows: any[] = [];
    // 5 brand-new edges; snapshot only knew about n_a->n_b + n_b->n_c.
    for (let i = 0; i < 5; i++) {
      currentRows.push({
        sourceId: `new_src_${i}`,
        targetId: `new_tgt_${i}`,
        relType: 'CALLS',
        sourceName: `S${i}`,
        sourceFile: `src/s${i}.ts`,
        targetName: `T${i}`,
        targetFile: `src/t${i}.ts`,
        sourceCommunity: 'c1',
        targetCommunity: 'c1',
      });
    }
    execMock.mockResolvedValueOnce(currentRows);
    const result = await runGraphDiff(repo, { limit: 2 });
    expect(result.status).toBe('success');
    expect(result.added_count).toBe(5);
    expect(result.added).toHaveLength(2);
    // Removed edges (2 from snapshot) should also be clamped to 2 — both fit.
    expect(result.removed_count).toBe(2);
  });
});
