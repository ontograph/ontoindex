import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RepoHandle } from 'ontoindex-shared';

import {
  ensureRepoInitialized,
  resolveRepoFromHandles,
} from '../../src/mcp/local/local-backend-repo-runtime.js';

function makeRepo(id: string, name: string, repoPath: string): RepoHandle {
  const resolvedRepoPath = path.resolve(repoPath);
  return {
    id,
    name,
    repoPath: resolvedRepoPath,
    storagePath: `${resolvedRepoPath}/.ontoindex`,
    lbugPath: `${resolvedRepoPath}/.ontoindex/lbug.db`,
    indexedAt: '2026-06-13T00:00:00.000Z',
    lastCommit: 'abc123',
  };
}

describe('resolveRepoFromHandles', () => {
  it('defaults to the preferred project path when multiple repos are indexed', () => {
    const repos = new Map<string, RepoHandle>([
      ['ontoindex', makeRepo('ontoindex', 'OntoIndex', '/opt/demodb/_workfolder/OntoIndex')],
      ['codex', makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode')],
    ]);

    const result = resolveRepoFromHandles(repos, undefined, '/opt/demodb/_workfolder/ontocode');

    expect(result).toEqual({ kind: 'resolved', repo: repos.get('codex') });
  });

  it('prefers an explicit repo parameter over the preferred project path', () => {
    const repos = new Map<string, RepoHandle>([
      ['ontoindex', makeRepo('ontoindex', 'OntoIndex', '/opt/demodb/_workfolder/OntoIndex')],
      ['codex', makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode')],
    ]);

    const result = resolveRepoFromHandles(repos, 'ontoindex', '/opt/demodb/_workfolder/ontocode');

    expect(result).toEqual({ kind: 'resolved', repo: repos.get('ontoindex') });
  });

  it('still returns null when multiple repos are indexed and no default matches', () => {
    const repos = new Map<string, RepoHandle>([
      ['ontoindex', makeRepo('ontoindex', 'OntoIndex', '/opt/demodb/_workfolder/OntoIndex')],
      ['codex', makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode')],
    ]);

    const result = resolveRepoFromHandles(
      repos,
      undefined,
      '/opt/demodb/_workfolder/unindexed-project',
    );

    expect(result.kind).toBe('ambiguous');
  });

  it('uses the preferred project path to disambiguate duplicate labels', () => {
    const active = makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode');
    const stale = makeRepo('codex-b3B0L2', 'codex', '/opt/demodb/_workfolder/ontocode-f1-layout');
    const repos = new Map<string, RepoHandle>([
      [active.id, active],
      [stale.id, stale],
    ]);

    expect(resolveRepoFromHandles(repos, 'codex', active.repoPath)).toEqual({
      kind: 'resolved',
      repo: active,
    });
  });

  it('prefers the longest containing repository path', () => {
    const parent = makeRepo('workspace', 'shared', '/opt/workspace');
    const child = makeRepo('project', 'shared', '/opt/workspace/project');
    const repos = new Map<string, RepoHandle>([
      [parent.id, parent],
      [child.id, child],
    ]);

    expect(resolveRepoFromHandles(repos, 'shared', '/opt/workspace/project/src')).toEqual({
      kind: 'resolved',
      repo: child,
    });
    expect(resolveRepoFromHandles(repos, undefined, '/opt/workspace/project/src')).toEqual({
      kind: 'resolved',
      repo: child,
    });
  });

  it('reports duplicate labels as ambiguous without a matching preferred path', () => {
    const first = makeRepo('first', 'shared', '/opt/first');
    const second = makeRepo('second', 'shared', '/opt/second');
    const repos = new Map<string, RepoHandle>([
      [first.id, first],
      [second.id, second],
    ]);

    expect(resolveRepoFromHandles(repos, 'shared', '/opt/unrelated')).toEqual({
      kind: 'ambiguous',
      candidates: [first, second],
    });
  });

  it('reports partial labels as ambiguous unless only one matches', () => {
    const first = makeRepo('first', 'shared-api', '/opt/first');
    const second = makeRepo('second', 'shared-web', '/opt/second');
    const repos = new Map<string, RepoHandle>([
      [first.id, first],
      [second.id, second],
    ]);

    expect(resolveRepoFromHandles(repos, 'shared')).toEqual({
      kind: 'ambiguous',
      candidates: [first, second],
    });
    expect(resolveRepoFromHandles(repos, 'api')).toEqual({ kind: 'resolved', repo: first });
  });

  it('matches an exact repository path through a symlink', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-resolve-'));
    const repoPath = path.join(tempRoot, 'repo');
    const symlinkPath = path.join(tempRoot, 'repo-link');
    await fs.mkdir(repoPath);
    await fs.symlink(repoPath, symlinkPath, 'dir');
    const repo = makeRepo('repo', 'repo', repoPath);

    try {
      expect(resolveRepoFromHandles(new Map([[repo.id, repo]]), symlinkPath)).toEqual({
        kind: 'resolved',
        repo,
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('ensureRepoInitialized during a rebuild', () => {
  async function setup(options: {
    published: boolean;
    lockPid: number;
    processStartIdentity?: string;
  }) {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-rebuild-'));
    const storagePath = path.join(repoPath, '.ontoindex');
    await fs.mkdir(storagePath);
    const lbugPath = path.join(storagePath, 'lbug');
    if (options.published) await fs.writeFile(lbugPath, 'db');
    await fs.writeFile(
      path.join(storagePath, 'analyze.lock'),
      JSON.stringify({
        pid: options.lockPid,
        startedAt: '2026-09-26T00:00:00.000Z',
        ...(options.processStartIdentity
          ? { processStartIdentity: options.processStartIdentity }
          : {}),
      }),
    );
    const handle: RepoHandle = { ...makeRepo('repo', 'repo', repoPath), storagePath, lbugPath };
    const initLbug = vi.fn(async () => undefined);
    const run = () =>
      ensureRepoInitialized({
        repoId: 'repo',
        handle,
        initializedRepos: new Set(),
        reinitPromises: new Map(),
        lastStalenessCheck: new Map(),
        isLbugReady: () => false,
        initLbug,
        closeLbug: vi.fn(async () => undefined),
      });
    return { repoPath, initLbug, run };
  }

  it('opens the published generation while analyze holds the lock', async () => {
    const { repoPath, initLbug, run } = await setup({ published: true, lockPid: process.pid });
    try {
      await expect(run()).resolves.toBeUndefined();
      expect(initLbug).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('blocks only the first build when no generation is published yet', async () => {
    const { repoPath, initLbug, run } = await setup({ published: false, lockPid: process.pid });
    try {
      await expect(run()).rejects.toThrow(/being built for the first time/);
      expect(initLbug).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('ignores a lock whose owner process is gone', async () => {
    // PID 2^22+ is above the Linux pid_max default and never running.
    const { repoPath, initLbug, run } = await setup({
      published: false,
      lockPid: 4_194_304 + 7,
    });
    try {
      await expect(run()).resolves.toBeUndefined();
      expect(initLbug).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'linux')('ignores a lock whose PID was reused', async () => {
    // A live PID whose start identity differs from the one recorded by analyze.
    const { repoPath, initLbug, run } = await setup({
      published: false,
      lockPid: process.pid,
      processStartIdentity: 'not-the-recorded-start-time',
    });
    try {
      await expect(run()).resolves.toBeUndefined();
      expect(initLbug).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });
});
