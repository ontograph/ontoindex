import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const REPO_ID = 'test-repo';
const CURRENT_COMMIT = 'abc123def456abc123def456abc123def456abc1';

describe('resolveTargetContext', () => {
  async function loadActualResolver() {
    return vi.importActual<typeof import('../../src/mcp/shared/target-context.js')>(
      '../../src/mcp/shared/target-context.js',
    );
  }

  const registryEntry = {
    name: REPO_ID,
    path: '/repo/test-repo',
    storagePath: '/repo/test-repo/.ontoindex',
    indexedAt: 'graph-index-1',
    lastCommit: CURRENT_COMMIT,
    stats: { embeddings: 3 },
  };

  function execGitFor(head: string, status = '') {
    return async (_cwd: string, args: string[]) => {
      const key = args.join(' ');
      if (key === 'rev-parse --abbrev-ref HEAD') return 'main\n';
      if (key === 'rev-parse HEAD') return `${head}\n`;
      if (key === 'status --porcelain=v1 --untracked-files=all') return status;
      return `${head}\n`;
    };
  }

  it('resolves fresh target/current/index context', async () => {
    const { resolveTargetContext } = await loadActualResolver();

    const context = await resolveTargetContext(
      {
        repo: REPO_ID,
        readiness: {
          lspAvailable: { typescript: true, python: false, rust: false },
        },
      },
      {
        readRegistry: async () => [registryEntry],
        execGit: execGitFor(CURRENT_COMMIT),
      },
    );

    expect(context).toMatchObject({
      status: 'ok',
      repoKey: REPO_ID,
      repoLabel: REPO_ID,
      repoPath: path.resolve('/repo/test-repo'),
      branch: 'main',
      targetRef: 'HEAD',
      targetHead: CURRENT_COMMIT,
      currentHead: CURRENT_COMMIT,
      indexedHead: CURRENT_COMMIT,
      graphIndexId: 'graph-index-1',
      dirtyWorktree: false,
      dirtyFileCount: 0,
      dirtyWorkspace: {
        state: 'clean',
        fileCount: 0,
        sourceFileCount: 0,
        stagedSourceFileCount: 0,
        unstagedSourceFileCount: 0,
        untrackedSourceFileCount: 0,
        unknownGraphCoverageCount: 0,
      },
      changedSinceIndex: false,
      snapshotMode: 'committed-head',
      scopeConfidence: 'high',
      embeddings: { status: 'available', count: 3 },
      lsp: { status: 'available' },
      sidecar: { status: 'unknown', reason: 'not-probed' },
      policy: { status: 'unknown' },
    });
  });

  it('marks stale index state as changed since index', async () => {
    const { resolveTargetContext } = await loadActualResolver();

    const context = await resolveTargetContext(
      { repo: REPO_ID },
      {
        readRegistry: async () => [registryEntry],
        execGit: execGitFor('head-2'),
      },
    );

    expect(context.indexedHead).toBe(CURRENT_COMMIT);
    expect(context.currentHead).toBe('head-2');
    expect(context.changedSinceIndex).toBe(true);
    expect(context.dirtyWorkspace?.state).toBe('stale-index');
  });

  it('marks dirty worktree as dirty overlay snapshot', async () => {
    const { resolveTargetContext } = await loadActualResolver();

    const context = await resolveTargetContext(
      { repo: REPO_ID },
      {
        readRegistry: async () => [registryEntry],
        execGit: execGitFor(CURRENT_COMMIT, ' M src/file.ts\n'),
      },
    );

    expect(context.dirtyWorktree).toBe(true);
    expect(context.dirtyFileCount).toBe(1);
    expect(context.dirtyWorkspace).toMatchObject({
      state: 'dirty-file',
      fileCount: 1,
      sourceFileCount: 1,
      stagedSourceFileCount: 0,
      unstagedSourceFileCount: 1,
      untrackedSourceFileCount: 0,
      unknownGraphCoverageCount: 0,
    });
    expect(context.changedSinceIndex).toBe(true);
    expect(context.snapshotMode).toBe('dirty-worktree-overlay');
    expect(context.scopeConfidence).toBe('medium');
  });

  it('marks untracked source files as unknown graph coverage', async () => {
    const { resolveTargetContext } = await loadActualResolver();

    const context = await resolveTargetContext(
      { repo: REPO_ID },
      {
        readRegistry: async () => [registryEntry],
        execGit: execGitFor(
          CURRENT_COMMIT,
          'M  src/staged.ts\n M src/unstaged.ts\n?? src/new.ts\n?? README.md\n',
        ),
      },
    );

    expect(context.dirtyWorktree).toBe(true);
    expect(context.dirtyFileCount).toBe(4);
    expect(context.dirtyWorkspace).toMatchObject({
      state: 'unknown-untracked',
      fileCount: 4,
      sourceFileCount: 3,
      stagedSourceFileCount: 1,
      unstagedSourceFileCount: 1,
      untrackedSourceFileCount: 1,
      unknownGraphCoverageCount: 1,
    });
    expect(context.scopeConfidence).toBe('low');
  });

  it('falls back to the cwd repo when no repo is provided', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo/test-repo');
    try {
      const { resolveTargetContext } = await loadActualResolver();

      const context = await resolveTargetContext(
        {},
        {
          readRegistry: async () => [
            registryEntry,
            { ...registryEntry, name: 'other-repo', path: '/repo/other' },
          ],
          execGit: execGitFor(CURRENT_COMMIT),
        },
      );

      expect(context.status).toBe('ok');
      expect(context.repoLabel).toBe(REPO_ID);
      expect(context.repoPath).toBe(path.resolve('/repo/test-repo'));
      expect(context.scopeConfidence).toBe('medium');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('returns a loud ambiguity when ONTOINDEX_MCP_REPO and cwd disagree', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo/other');
    const previousRepo = process.env.ONTOINDEX_MCP_REPO;
    process.env.ONTOINDEX_MCP_REPO = REPO_ID;
    try {
      const { resolveTargetContext } = await loadActualResolver();

      const context = await resolveTargetContext(
        {},
        {
          readRegistry: async () => [
            registryEntry,
            { ...registryEntry, name: 'other-repo', path: '/repo/other' },
          ],
          execGit: execGitFor(CURRENT_COMMIT),
        },
      );

      expect(context.status).toBe('ambiguous');
      expect(context.action).toContain('Retry with repo:');
      expect(context.action).toContain('/repo/test-repo');
      expect(context.action).toContain('/repo/other');
    } finally {
      if (previousRepo === undefined) delete process.env.ONTOINDEX_MCP_REPO;
      else process.env.ONTOINDEX_MCP_REPO = previousRepo;
      cwdSpy.mockRestore();
    }
  });

  it('returns no-index context instead of failing when registry is empty', async () => {
    const { resolveTargetContext } = await loadActualResolver();

    const context = await resolveTargetContext(
      { repo: REPO_ID },
      { readRegistry: async () => [], execGit: execGitFor(CURRENT_COMMIT) },
    );

    expect(context).toMatchObject({
      status: 'no-index',
      dirtyWorktree: null,
      changedSinceIndex: null,
      embeddings: { status: 'unknown', reason: 'repo-not-resolved' },
    });
    expect(context.action).toMatch(/ontoindex analyze/);
  });

  it('reports missing capability probes as unknown or unavailable', async () => {
    const { resolveTargetContext } = await loadActualResolver();

    const context = await resolveTargetContext(
      {
        repo: REPO_ID,
        readiness: {
          embeddingsCount: 0,
          lspAvailable: { typescript: false, python: false, rust: false },
        },
      },
      {
        readRegistry: async () => [registryEntry],
        execGit: execGitFor(CURRENT_COMMIT),
      },
    );

    expect(context.embeddings).toMatchObject({
      status: 'unavailable',
      count: 0,
      reason: 'embeddings-not-populated',
    });
    expect(context.lsp).toMatchObject({ status: 'unavailable', reason: 'no-lsp-server-on-path' });
    expect(context.sidecar).toMatchObject({ status: 'unknown', reason: 'not-probed' });
    expect(context.policy).toMatchObject({
      status: 'unknown',
      reason: 'policy-profile-probe-not-configured',
    });
  });

  it('returns actionable ambiguity when multiple repos are indexed and no repo is selected', async () => {
    const { resolveTargetContext } = await loadActualResolver();

    const context = await resolveTargetContext(
      {},
      {
        readRegistry: async () => [
          registryEntry,
          { ...registryEntry, name: 'other-repo', path: '/repo/other' },
        ],
        execGit: execGitFor(CURRENT_COMMIT),
      },
    );

    expect(context.status).toBe('ambiguous');
    expect(context.availableRepos).toEqual([
      { key: REPO_ID, path: '/repo/test-repo' },
      { key: 'other-repo', path: '/repo/other' },
    ]);
    expect(context.action).toContain('Specify one repository with the "repo" parameter');
  });
});
