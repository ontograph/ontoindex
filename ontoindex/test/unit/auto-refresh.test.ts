import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileText } from '../../src/core/process/exec-file.js';
import { computeSourceManifest } from '../../src/core/indexing/source-manifest.js';
import { maybeScheduleAutoRefresh } from '../../src/mcp/local/auto-refresh.js';
import type { RepoMeta } from '../../src/storage/repo-manager.js';
import type { gnEnsureFresh } from '../../src/mcp/super/ensure-fresh.js';

const roots: string[] = [];
const ensureFresh = vi.fn<typeof gnEnsureFresh>().mockResolvedValue({
  analysisSubmission: { status: 'queued', jobId: 'test-job' },
} as Awaited<ReturnType<typeof gnEnsureFresh>>);
const spawnRefresh = vi.fn().mockResolvedValue(undefined);

async function fixture(options: { commitless?: boolean; plain?: boolean; profile?: 'full' | 'symbols' | 'huge-repo-symbols' } = {}) {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-auto-refresh-'));
  roots.push(repoPath);
  const git = (args: string[]) => execFileText('git', args, { cwd: repoPath });
  if (!options.plain) await git(['init', '-q']);
  await fs.mkdir(path.join(repoPath, 'src'));
  await fs.writeFile(path.join(repoPath, 'src', 'main.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(repoPath, '.gitignore'), '.ontoindex/\n');
  const commit = async () => {
    await git(['add', '.']);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'change']);
  };
  if (!options.commitless && !options.plain) await commit();
  const storagePath = path.join(repoPath, '.ontoindex');
  await fs.mkdir(storagePath);
  const sourceManifest = await computeSourceManifest(repoPath, {
    includePaths: ['src'], pipelineProfile: options.profile ?? 'full',
  });
  const meta: RepoMeta = {
    repoPath, lastCommit: sourceManifest.head ?? '', indexedAt: new Date().toISOString(), sourceManifest,
  };
  await fs.writeFile(path.join(storagePath, 'meta.json'), JSON.stringify(meta));
  const advance = async () => {
    await fs.writeFile(path.join(repoPath, 'src', 'main.ts'), 'export const value = 2;\n');
    await commit();
  };
  return { repo: { id: repoPath, repoPath, storagePath }, advance, commit };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  ensureFresh.mockClear();
  spawnRefresh.mockClear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('automatic refresh', () => {
  it('schedules a new commit once and warns when the stamp suppresses another submission', async () => {
    const { repo, advance } = await fixture();
    await advance();
    expect(await maybeScheduleAutoRefresh(repo, { ensureFresh })).toContain('test-job');
    expect(await maybeScheduleAutoRefresh(repo, { ensureFresh })).toContain('stale');
    expect(ensureFresh).toHaveBeenCalledTimes(1);
    expect(await fs.stat(path.join(repo.storagePath, 'auto-refresh.stamp'))).toBeDefined();
  });

  it('shares one submission across concurrent calls', async () => {
    const { repo, advance } = await fixture();
    await advance();
    const warnings = await Promise.all(Array.from({ length: 6 }, () => maybeScheduleAutoRefresh(repo, { ensureFresh })));
    expect(ensureFresh).toHaveBeenCalledTimes(1);
    expect(new Set(warnings).size).toBe(1);
  });

  it('does nothing for dirty-only changes on the same HEAD', async () => {
    const { repo } = await fixture();
    await fs.writeFile(path.join(repo.repoPath, 'src', 'main.ts'), 'dirty\n');
    expect(await maybeScheduleAutoRefresh(repo, { ensureFresh })).toBeUndefined();
    expect(ensureFresh).not.toHaveBeenCalled();
  });

  it.each([{ commitless: true }, { plain: true }])('checks only the recorded scope without commits (%j)', async (options) => {
    const { repo } = await fixture({ ...options, profile: 'symbols' });
    let now = Date.now();
    const deps = { ensureFresh, spawnRefresh, now: () => now };
    expect(await maybeScheduleAutoRefresh(repo, deps)).toBeUndefined();
    await fs.writeFile(path.join(repo.repoPath, 'outside.ts'), 'outside\n');
    now += 300001;
    expect(await maybeScheduleAutoRefresh(repo, deps)).toBeUndefined();
    await fs.writeFile(path.join(repo.repoPath, 'src', 'main.ts'), 'inside\n');
    now += 300001;
    expect(await maybeScheduleAutoRefresh(repo, deps)).toContain('started');
    expect(spawnRefresh).toHaveBeenCalledWith(repo, { includePaths: ['src/'], pipelineProfile: 'symbols' });
    expect(await maybeScheduleAutoRefresh(repo, deps)).toContain('stale');
    expect(spawnRefresh).toHaveBeenCalledTimes(1);
    expect(ensureFresh).not.toHaveBeenCalled();
  });

  it('passes the recorded include paths and symbols profile to ensure-fresh', async () => {
    const { repo, advance } = await fixture({ profile: 'symbols' });
    await advance();
    await maybeScheduleAutoRefresh(repo, { ensureFresh });
    expect(ensureFresh).toHaveBeenCalledWith(repo.repoPath, {
      repo: repo.repoPath, autoAnalyze: true,
      scope: { includePaths: ['src/'], pipelineProfile: 'symbols' },
    });
  });

  it('never refreshes huge-repo-symbols indexes', async () => {
    const { repo, advance } = await fixture({ profile: 'huge-repo-symbols' });
    await advance();
    expect(await maybeScheduleAutoRefresh(repo, { ensureFresh })).toContain('manually');
    expect(ensureFresh).not.toHaveBeenCalled();
  });

  it('honors the disable switch', async () => {
    const { repo, advance } = await fixture();
    await advance();
    vi.stubEnv('ONTOINDEX_AUTO_REFRESH', '0');
    expect(await maybeScheduleAutoRefresh(repo, { ensureFresh })).toBeUndefined();
    expect(ensureFresh).not.toHaveBeenCalled();
  });

  it('never throws on missing metadata or submission errors', async () => {
    const { repo, advance } = await fixture();
    await advance();
    ensureFresh.mockRejectedValueOnce(new Error('submission failed'));
    await expect(maybeScheduleAutoRefresh(repo, { ensureFresh })).resolves.toBeUndefined();
    await fs.rm(path.join(repo.storagePath, 'meta.json'));
    await expect(maybeScheduleAutoRefresh(repo, { ensureFresh })).resolves.toBeUndefined();
  });

  it('reports a running refresh and names other blockers in the stale warning', async () => {
    const { repo, advance } = await fixture();
    await advance();
    ensureFresh.mockResolvedValueOnce({ analysisSubmission: {
      status: 'blocked', reasonCode: 'ACTIVE_JOB_CONFLICT', message: 'another job is running',
    } } as Awaited<ReturnType<typeof gnEnsureFresh>>);
    expect(await maybeScheduleAutoRefresh(repo, { ensureFresh })).toContain('A refresh is already running');
    await fs.rm(path.join(repo.storagePath, 'auto-refresh.stamp'));
    ensureFresh.mockResolvedValueOnce({ analysisSubmission: {
      status: 'blocked', reasonCode: 'untrusted', message: 'repair manually',
    } } as Awaited<ReturnType<typeof gnEnsureFresh>>);
    expect(await maybeScheduleAutoRefresh(repo, { ensureFresh })).toContain('Refresh blocked (untrusted)');
  });
});
