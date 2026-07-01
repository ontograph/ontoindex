import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { Ignore } from 'ignore';

const REPO_ID = 'test-repo';
const CURRENT_COMMIT = 'abc123def456abc123def456abc123def456abc1';
let originalMcpRepo: string | undefined;
let originalProjectCwd: string | undefined;

beforeEach(() => {
  originalMcpRepo = process.env.ONTOINDEX_MCP_REPO;
  originalProjectCwd = process.env.ONTOINDEX_MCP_PROJECT_CWD;
  delete process.env.ONTOINDEX_MCP_REPO;
  delete process.env.ONTOINDEX_MCP_PROJECT_CWD;
});

afterEach(() => {
  if (originalMcpRepo === undefined) delete process.env.ONTOINDEX_MCP_REPO;
  else process.env.ONTOINDEX_MCP_REPO = originalMcpRepo;
  if (originalProjectCwd === undefined) delete process.env.ONTOINDEX_MCP_PROJECT_CWD;
  else process.env.ONTOINDEX_MCP_PROJECT_CWD = originalProjectCwd;
});

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

  it('keeps scoped confidence high when dirty files are outside scope', async () => {
    const { resolveTargetContext } = await loadActualResolver();

    const context = await resolveTargetContext(
      { repo: REPO_ID, scopePaths: ['src/owner'] },
      {
        readRegistry: async () => [registryEntry],
        execGit: execGitFor(CURRENT_COMMIT, ' M docs/notes.md\n?? tmp/donor.ts\n'),
      },
    );

    expect(context.dirtyWorktree).toBe(true);
    expect(context.dirtyFileCount).toBe(2);
    expect(context.dirtyWorkspace?.fileCount).toBe(2);
    expect(context.scopePaths).toEqual(['src/owner']);
    expect(context.scopedDirtyWorkspace).toMatchObject({
      state: 'clean',
      fileCount: 0,
      sourceFileCount: 0,
    });
    expect(context.scopeConfidence).toBe('high');
    expect(context.scopeConfidenceReason).toBe('scoped-worktree-clean');
  });

  it('marks tracked source files inside scope as medium confidence', async () => {
    const { resolveTargetContext } = await loadActualResolver();

    const context = await resolveTargetContext(
      { repo: REPO_ID, scopePaths: ['./src/owner/'] },
      {
        readRegistry: async () => [registryEntry],
        execGit: execGitFor(CURRENT_COMMIT, ' M src/owner/file.ts\n M docs/notes.md\n'),
      },
    );

    expect(context.scopePaths).toEqual(['src/owner']);
    expect(context.scopedDirtyWorkspace).toMatchObject({
      state: 'dirty-file',
      fileCount: 1,
      sourceFileCount: 1,
      unstagedSourceFileCount: 1,
    });
    expect(context.scopeConfidence).toBe('medium');
    expect(context.scopeConfidenceReason).toBe('dirty-source-files-in-scope');
  });

  it('marks untracked source files inside scope as low confidence', async () => {
    const { resolveTargetContext } = await loadActualResolver();

    const context = await resolveTargetContext(
      { repo: REPO_ID, scopePaths: ['src/owner'] },
      {
        readRegistry: async () => [registryEntry],
        execGit: execGitFor(CURRENT_COMMIT, '?? src/owner/new.ts\n'),
      },
    );

    expect(context.scopedDirtyWorkspace).toMatchObject({
      state: 'unknown-untracked',
      fileCount: 1,
      sourceFileCount: 1,
      untrackedSourceFileCount: 1,
    });
    expect(context.scopeConfidence).toBe('low');
    expect(context.scopeConfidenceReason).toBe('untracked-source-files-in-scope');
  });

  it('does not degrade scoped confidence for ignored dirty paths', async () => {
    const { resolveTargetContext } = await loadActualResolver();

    const context = await resolveTargetContext(
      { repo: REPO_ID, scopePaths: ['src/owner'] },
      {
        readRegistry: async () => [registryEntry],
        execGit: execGitFor(CURRENT_COMMIT, ' M src/owner/generated.ts\n'),
        loadIgnoreRules: async () =>
          ({
            ignores: (filePath: string) => filePath === 'src/owner/generated.ts',
          }) as Ignore,
      },
    );

    expect(context.dirtyFileCount).toBe(1);
    expect(context.scopedDirtyWorkspace).toMatchObject({
      state: 'clean',
      fileCount: 0,
      sourceFileCount: 0,
    });
    expect(context.scopeConfidence).toBe('high');
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

  it('prefers cwd resolution over ONTOINDEX_MCP_REPO when they disagree', async () => {
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

      expect(context.status).toBe('ok');
      expect(context.repoLabel).toBe('other-repo');
      expect(context.repoPath).toBe(path.resolve('/repo/other'));
    } finally {
      if (previousRepo === undefined) delete process.env.ONTOINDEX_MCP_REPO;
      else process.env.ONTOINDEX_MCP_REPO = previousRepo;
      cwdSpy.mockRestore();
    }
  });

  it('uses the longest matching cwd repo path when multiple parent/child paths match', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo/mono/sub/work');
    const previousRepo = process.env.ONTOINDEX_MCP_REPO;
    process.env.ONTOINDEX_MCP_REPO = 'parent-repo';
    try {
      const { resolveTargetContext } = await loadActualResolver();

      const context = await resolveTargetContext(
        {},
        {
          readRegistry: async () => [
            { ...registryEntry, name: 'parent-repo', path: '/repo/mono' },
            { ...registryEntry, name: 'child-repo', path: '/repo/mono/sub' },
          ],
          execGit: execGitFor(CURRENT_COMMIT),
        },
      );

      expect(context.status).toBe('ok');
      expect(context.repoLabel).toBe('child-repo');
      expect(context.repoPath).toBe(path.resolve('/repo/mono/sub'));
    } finally {
      if (previousRepo === undefined) delete process.env.ONTOINDEX_MCP_REPO;
      else process.env.ONTOINDEX_MCP_REPO = previousRepo;
      cwdSpy.mockRestore();
    }
  });

  it('uses explicit projectPath before cwd and env fallback', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo/other');
    const previousRepo = process.env.ONTOINDEX_MCP_REPO;
    process.env.ONTOINDEX_MCP_REPO = 'other-repo';
    try {
      const { resolveTargetContext } = await loadActualResolver();

      const context = await resolveTargetContext(
        { projectPath: '/repo/test-repo' },
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
    } finally {
      if (previousRepo === undefined) delete process.env.ONTOINDEX_MCP_REPO;
      else process.env.ONTOINDEX_MCP_REPO = previousRepo;
      cwdSpy.mockRestore();
    }
  });

  it('does not fall back to ONTOINDEX_MCP_REPO when explicit repo is provided', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo/other');
    const previousRepo = process.env.ONTOINDEX_MCP_REPO;
    process.env.ONTOINDEX_MCP_REPO = 'repo-2';
    try {
      const { resolveTargetContext } = await loadActualResolver();

      const context = await resolveTargetContext(
        { repo: 'ontoindex' },
        {
          readRegistry: async () => [
            { ...registryEntry, name: 'repo-1', path: '/repo/ontoindex' },
            { ...registryEntry, name: 'repo-2', path: '/repo/other' },
          ],
          execGit: execGitFor(CURRENT_COMMIT),
        },
      );

      expect(context.status).toBe('not-found');
      expect(context.action).toContain('Repository "ontoindex" not found');
      expect(context.repoLabel).toBeUndefined();
    } finally {
      if (previousRepo === undefined) delete process.env.ONTOINDEX_MCP_REPO;
      else process.env.ONTOINDEX_MCP_REPO = previousRepo;
      cwdSpy.mockRestore();
    }
  });

  it('emits a stable repo path mismatch warning for explicit repo selection', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo/other');
    try {
      const { resolveTargetContext } = await loadActualResolver();

      const context = await resolveTargetContext(
        { repo: REPO_ID },
        {
          readRegistry: async () => [
            registryEntry,
            { ...registryEntry, name: 'other-repo', path: '/repo/other' },
          ],
          execGit: execGitFor(CURRENT_COMMIT),
        },
      );

      expect(context.status).toBe('ok');
      expect(context.scopeConfidence).toBe('low');
      expect(context.scopeConfidenceReason).toBe('repo-path-mismatch');
      expect(context.warnings.join('\n')).toContain('REPO_PATH_MISMATCH');
      expect(context.warnings.join('\n')).toContain(`repo: "${path.resolve('/repo/test-repo')}"`);
    } finally {
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
    expect(context.action).toContain('Multiple repositories are indexed');
    expect(context.action).toContain('repo: "test-repo"');
  });
});
