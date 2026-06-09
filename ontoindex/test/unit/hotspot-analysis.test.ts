import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn().mockResolvedValue([]),
}));

import { runHotspotAnalysis } from '../../src/mcp/local/backend-hotspot-analysis.js';

async function commit(repoPath: string, author: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(repoPath, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf8');
  }
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync(
    'git',
    ['commit', '-m', `touch ${Object.keys(files).join(',')}`, `--author=${author} <${author}@x>`],
    {
      cwd: repoPath,
      env: { ...process.env, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: `${author}@x` },
    },
  );
}

describe('hotspot_analysis', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-hotspot-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@x'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpDir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });

    await commit(tmpDir, 'alice', { 'src/a.ts': '1' });
    await commit(tmpDir, 'alice', { 'src/a.ts': '2', 'src/b.ts': '1' });
    await commit(tmpDir, 'bob', { 'src/a.ts': '3', 'src/b.ts': '2' });
    await commit(tmpDir, 'alice', { 'src/a.ts': '4' });
    await commit(tmpDir, 'carol', { 'src/c.ts': '1' });
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('default metric returns churn_x_complexity ranking', async () => {
    const repo: any = { id: 'hotspot-test', name: 'hotspot-test', repoPath: tmpDir };
    const result = await runHotspotAnalysis(repo, { since: '10 years' });
    expect(result.status).toBe('success');
    expect(result.metric).toBe('churn_x_complexity');
    expect(result.total_commits).toBe(5);
    // src/a.ts has 4 commits, src/b.ts has 2, src/c.ts has 1.
    const byFile = new Map((result.hotspots as any[]).map((h) => [h.file, h]));
    expect(byFile.get('src/a.ts')!.commits).toBe(4);
    expect(byFile.get('src/b.ts')!.commits).toBe(2);
    expect(byFile.get('src/c.ts')!.commits).toBe(1);
    // Top-ranked is src/a.ts (highest commit count; caller_count from
    // the mocked DB is 0 for everything so score == commits).
    expect((result.hotspots[0] as any).file).toBe('src/a.ts');
  });

  it('change_coupling surfaces frequently co-changing pairs', async () => {
    const repo: any = { id: 'hotspot-test', name: 'hotspot-test', repoPath: tmpDir };
    const result = await runHotspotAnalysis(repo, { metric: 'change_coupling', since: '10 years' });
    expect(result).toEqual({
      status: 'success',
      tool: 'hotspot_analysis',
      repo: 'hotspot-test',
      metric: 'change_coupling',
      since: '10 years',
      total_commits: 5,
      hotspot_count: 1,
      hotspots: [
        {
          file_a: 'src/a.ts',
          file_b: 'src/b.ts',
          co_changes: 2,
          commits_a: 4,
          commits_b: 2,
          coupling_ratio: 1,
        },
      ],
      warnings: [],
    });
  });

  it('ownership ranks files by distinct author count', async () => {
    const repo: any = { id: 'hotspot-test', name: 'hotspot-test', repoPath: tmpDir };
    const result = await runHotspotAnalysis(repo, { metric: 'ownership', since: '10 years' });
    expect(result.status).toBe('success');
    expect(result.metric).toBe('ownership');
    const byFile = new Map((result.hotspots as any[]).map((h) => [h.file, h]));
    // src/a.ts touched by alice+bob (2 authors).
    expect(byFile.get('src/a.ts')!.author_count).toBe(2);
    expect(byFile.get('src/a.ts')!.authors).toEqual(['alice', 'bob']);
    // src/c.ts touched by carol only.
    expect(byFile.get('src/c.ts')!.author_count).toBe(1);
  });

  it('respects limit parameter', async () => {
    const repo: any = { id: 'hotspot-test', name: 'hotspot-test', repoPath: tmpDir };
    const result = await runHotspotAnalysis(repo, { limit: 1, since: '10 years' });
    expect(result.hotspots).toHaveLength(1);
    expect(result.hotspot_count).toBeGreaterThan(1);
  });

  it('returns empty success on a non-git repo', async () => {
    const nonGit = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-hotspot-nogit-'));
    try {
      const repo: any = { id: 'hotspot-nogit', name: 'nogit', repoPath: nonGit };
      const result = await runHotspotAnalysis(repo, {});
      expect(result.status).toBe('success');
      expect(result.total_commits).toBe(0);
      expect(result.hotspots).toEqual([]);
    } finally {
      await fs.rm(nonGit, { recursive: true, force: true });
    }
  });
});
