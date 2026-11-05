import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileText } from '../../src/core/process/exec-file.js';
import { computeSourceManifest } from '../../src/core/indexing/source-manifest.js';
import {
  maybeScheduleAutoRefresh,
  maybeScheduleWorkspacePrebuild,
} from '../../src/mcp/local/auto-refresh.js';
import type { RepoMeta } from '../../src/storage/repo-manager.js';
import type { gnEnsureFresh } from '../../src/mcp/super/ensure-fresh.js';

const roots: string[] = [];
const ensureFresh = vi.fn<typeof gnEnsureFresh>().mockResolvedValue({
  analysisSubmission: { status: 'queued', jobId: 'test-job' },
} as Awaited<ReturnType<typeof gnEnsureFresh>>);
const spawnRefresh = vi.fn().mockResolvedValue(undefined);

async function fixture(
  options: {
    commitless?: boolean;
    plain?: boolean;
    profile?: 'full' | 'symbols' | 'huge-repo-symbols';
    includePaths?: string[];
  } = {},
) {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-auto-refresh-'));
  roots.push(repoPath);
  const git = (args: string[]) => execFileText('git', args, { cwd: repoPath });
  if (!options.plain) await git(['init', '-q']);
  await fs.mkdir(path.join(repoPath, 'src'));
  await fs.writeFile(path.join(repoPath, 'src', 'main.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(repoPath, '.gitignore'), '.ontoindex/\n');
  const commit = async () => {
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'change',
    ]);
  };
  if (!options.commitless && !options.plain) await commit();
  const storagePath = path.join(repoPath, '.ontoindex');
  await fs.mkdir(storagePath);
  const sourceManifest = await computeSourceManifest(repoPath, {
    includePaths: options.includePaths ?? ['src'],
    pipelineProfile: options.profile ?? 'full',
  });
  const meta: RepoMeta = {
    repoPath,
    lastCommit: sourceManifest.head ?? '',
    indexedAt: new Date().toISOString(),
    sourceManifest,
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
    const warnings = await Promise.all(
      Array.from({ length: 6 }, () => maybeScheduleAutoRefresh(repo, { ensureFresh })),
    );
    expect(ensureFresh).toHaveBeenCalledTimes(1);
    expect(new Set(warnings).size).toBe(1);
  });

  it('does nothing for dirty-only changes on the same HEAD', async () => {
    const { repo } = await fixture();
    await fs.writeFile(path.join(repo.repoPath, 'src', 'main.ts'), 'dirty\n');
    expect(await maybeScheduleAutoRefresh(repo, { ensureFresh })).toBeUndefined();
    expect(ensureFresh).not.toHaveBeenCalled();
  });

  it.each([{ commitless: true }, { plain: true }])(
    'checks only the recorded scope without commits (%j)',
    async (options) => {
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
      expect(spawnRefresh).toHaveBeenCalledWith(repo, {
        includePaths: ['src/'],
        pipelineProfile: 'symbols',
      });
      expect(await maybeScheduleAutoRefresh(repo, deps)).toContain('stale');
      expect(spawnRefresh).toHaveBeenCalledTimes(1);
      expect(ensureFresh).not.toHaveBeenCalled();
    },
  );

  it('passes the recorded include paths and symbols profile to ensure-fresh', async () => {
    const { repo, advance } = await fixture({ profile: 'symbols' });
    await advance();
    await maybeScheduleAutoRefresh(repo, { ensureFresh });
    expect(ensureFresh).toHaveBeenCalledWith(repo.repoPath, {
      repo: repo.repoPath,
      autoAnalyze: true,
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
    ensureFresh.mockResolvedValueOnce({
      analysisSubmission: {
        status: 'blocked',
        reasonCode: 'ACTIVE_JOB_CONFLICT',
        message: 'another job is running',
      },
    } as Awaited<ReturnType<typeof gnEnsureFresh>>);
    expect(await maybeScheduleAutoRefresh(repo, { ensureFresh })).toContain(
      'A refresh is already running',
    );
    await fs.rm(path.join(repo.storagePath, 'auto-refresh.stamp'));
    ensureFresh.mockResolvedValueOnce({
      analysisSubmission: {
        status: 'blocked',
        reasonCode: 'untrusted',
        message: 'repair manually',
      },
    } as Awaited<ReturnType<typeof gnEnsureFresh>>);
    expect(await maybeScheduleAutoRefresh(repo, { ensureFresh })).toContain(
      'Refresh blocked (untrusted)',
    );
  });
});

describe('automatic workspace prebuild', () => {
  const fullFixture = (options: Parameters<typeof fixture>[0] = {}) =>
    fixture({ includePaths: [], ...options });

  it.each(['manifest', 'legacy'])(
    'does not spawn for a huge profile in %s metadata',
    async (source) => {
      const { repo } = await fullFixture({ profile: 'huge-repo-symbols' });
      if (source === 'legacy') {
        const metaPath = path.join(repo.storagePath, 'meta.json');
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
        delete meta.sourceManifest;
        meta.pipelineProfile = 'huge-repo-symbols';
        await fs.writeFile(metaPath, JSON.stringify(meta));
      }
      expect(await maybeScheduleWorkspacePrebuild(repo, { spawnRefresh })).toBeUndefined();
      expect(spawnRefresh).not.toHaveBeenCalled();
    },
  );

  it.each(['manifest', 'legacy'])(
    'does not spawn with include paths in %s metadata',
    async (source) => {
      const { repo } = await fixture();
      if (source === 'legacy') {
        const metaPath = path.join(repo.storagePath, 'meta.json');
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
        delete meta.sourceManifest;
        meta.includePaths = ['src'];
        await fs.writeFile(metaPath, JSON.stringify(meta));
      }
      expect(await maybeScheduleWorkspacePrebuild(repo, { spawnRefresh })).toBeUndefined();
      expect(spawnRefresh).not.toHaveBeenCalled();
    },
  );

  it('retries an unchanged working tree when its active generation changes', async () => {
    const { repo } = await fullFixture();
    const meta = JSON.parse(await fs.readFile(path.join(repo.storagePath, 'meta.json'), 'utf8'));
    let now = Date.now();
    const deps = { spawnRefresh, now: () => now };
    for (const generationId of ['first', 'second']) {
      const generationPath = path.join(repo.storagePath, 'generations', generationId);
      await fs.mkdir(generationPath, { recursive: true });
      await fs.writeFile(
        path.join(generationPath, 'meta.json'),
        JSON.stringify({ ...meta, generationId }),
      );
      await fs.rm(path.join(repo.storagePath, 'current'), { force: true });
      await fs.symlink(generationPath, path.join(repo.storagePath, 'current'), 'dir');
      expect(await maybeScheduleWorkspacePrebuild(repo, deps)).toContain(
        'started in the background',
      );
      now += 300001;
    }
    expect(spawnRefresh).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent launches and suppresses unchanged attempts beyond the interval', async () => {
    const { repo } = await fullFixture();
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    let now = Date.now();
    const deps = { spawnRefresh, now: () => now };
    const notes = await Promise.all(
      Array.from({ length: 6 }, () => maybeScheduleWorkspacePrebuild(repo, deps)),
    );
    expect(notes).toEqual(
      Array(6).fill(
        'Workspace graph preparation started in the background; later reads include uncommitted files.',
      ),
    );
    expect(spawnRefresh).toHaveBeenCalledExactlyOnceWith(repo, ['--workspace-graph']);
    now += 300001;
    expect(await maybeScheduleWorkspacePrebuild(repo, deps)).toBe(
      'Workspace graph preparation was already attempted for this working tree; edit or commit to retry, or run `ontoindex analyze --workspace-graph`.',
    );
    expect(spawnRefresh).toHaveBeenCalledTimes(1);
    expect(await fs.stat(path.join(repo.storagePath, 'workspace-prebuild.stamp'))).toBeDefined();
    await expect(fs.stat(path.join(repo.storagePath, 'auto-refresh.stamp'))).rejects.toThrow();
  });

  it('throttles rapid edits and retries an edited dirty file after the interval', async () => {
    const { repo } = await fullFixture();
    const file = path.join(repo.repoPath, 'src', 'main.ts');
    await fs.writeFile(file, 'dirty\n');
    let now = Date.now();
    const deps = { spawnRefresh, now: () => now };
    expect(await maybeScheduleWorkspacePrebuild(repo, deps)).toContain('started in the background');
    const stamp = path.join(repo.storagePath, 'workspace-prebuild.stamp');
    const firstIdentity = await fs.readFile(stamp, 'utf8');
    expect(firstIdentity).toMatch(/^[a-f0-9]{64}$/);
    await fs.writeFile(file, 'edited dirty file\n');
    expect(await maybeScheduleWorkspacePrebuild(repo, deps)).toContain('started recently');
    now += 300001;
    expect(await maybeScheduleWorkspacePrebuild(repo, deps)).toContain('started in the background');
    expect(spawnRefresh).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(stamp, 'utf8')).not.toBe(firstIdentity);
  });

  it('retries a same-length dirty edit with its mtime restored after the interval', async () => {
    const { repo } = await fullFixture();
    const file = path.join(repo.repoPath, 'src', 'main.ts');
    await fs.writeFile(file, 'dirty\n');
    // Use a whole-second mtime so fs.utimes restores it without rounding loss.
    const timestamp = Math.floor(Date.now() / 1000);
    await fs.utimes(file, timestamp, timestamp);
    const before = await fs.stat(file);
    let now = Date.now();
    const deps = { spawnRefresh, now: () => now };
    expect(await maybeScheduleWorkspacePrebuild(repo, deps)).toContain('started in the background');
    expect(spawnRefresh).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(file, 'other\n');
    await fs.utimes(file, before.atime, before.mtime);
    const after = await fs.stat(file);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);

    now += 300001;
    expect(await maybeScheduleWorkspacePrebuild(repo, deps)).toContain('started in the background');
    expect(spawnRefresh).toHaveBeenCalledTimes(2);
  });

  it('allows another attempt for unchanged inputs after one hour', async () => {
    const { repo } = await fullFixture();
    let now = Date.now();
    const deps = { spawnRefresh, now: () => now };
    await maybeScheduleWorkspacePrebuild(repo, deps);
    now += 60 * 60 * 1000;
    expect(await maybeScheduleWorkspacePrebuild(repo, deps)).toContain('started in the background');
    expect(spawnRefresh).toHaveBeenCalledTimes(2);
  });

  it('leaves a HEAD ahead of the indexed commit to regular refresh', async () => {
    const { repo, advance } = await fullFixture();
    await advance();
    expect(await maybeScheduleWorkspacePrebuild(repo, { spawnRefresh })).toBeUndefined();
    expect(spawnRefresh).not.toHaveBeenCalled();
  });

  it.each([{ commitless: true }, { plain: true }])(
    'does not spawn when HEAD is unknown (%j)',
    async (options) => {
      const { repo } = await fullFixture(options);
      expect(await maybeScheduleWorkspacePrebuild(repo, { spawnRefresh })).toBeUndefined();
      expect(spawnRefresh).not.toHaveBeenCalled();
    },
  );

  it('does not spawn without metadata or when identity computation fails', async () => {
    const { repo } = await fullFixture();
    const stat = vi.spyOn(fs, 'stat').mockRejectedValueOnce(new Error('stat failed'));
    try {
      await fs.writeFile(path.join(repo.repoPath, 'untracked file.ts'), 'dirty\n');
      expect(await maybeScheduleWorkspacePrebuild(repo, { spawnRefresh })).toBeUndefined();
      expect(spawnRefresh).not.toHaveBeenCalled();
    } finally {
      stat.mockRestore();
    }
    await fs.rm(path.join(repo.storagePath, 'meta.json'));
    expect(await maybeScheduleWorkspacePrebuild(repo, { spawnRefresh })).toBeUndefined();
    expect(spawnRefresh).not.toHaveBeenCalled();
  });

  it.each(['ONTOINDEX_AUTO_REFRESH', 'ONTOINDEX_AUTO_WORKSPACE'])('honors %s=0', async (name) => {
    const { repo } = await fullFixture();
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    vi.stubEnv(name, '0');
    expect(await maybeScheduleWorkspacePrebuild(repo, { spawnRefresh })).toBeUndefined();
    expect(spawnRefresh).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'linux').each(['active', 'unknown'])(
    'skips an %s analyze lock',
    async (state) => {
      const { repo } = await fullFixture();
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
      const processStartIdentity = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[19];
      await fs.writeFile(
        path.join(repo.storagePath, 'analyze.lock'),
        JSON.stringify({
          pid: process.pid,
          ...(state === 'active' ? { processStartIdentity } : {}),
        }),
      );
      expect(await maybeScheduleWorkspacePrebuild(repo, { spawnRefresh })).toBeUndefined();
      expect(spawnRefresh).not.toHaveBeenCalled();
    },
  );

  it('never throws on a failed launch and allows retrying it', async () => {
    const { repo } = await fullFixture();
    spawnRefresh.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(maybeScheduleWorkspacePrebuild(repo, { spawnRefresh })).resolves.toBeUndefined();
    expect(await maybeScheduleWorkspacePrebuild(repo, { spawnRefresh })).toContain('started');
    expect(spawnRefresh).toHaveBeenCalledTimes(2);
  });
});
