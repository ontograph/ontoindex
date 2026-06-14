import { describe, expect, it } from 'vitest';

import {
  formatRepoResolutionError,
  formatMcpStartupMismatchError,
  repoResolutionCandidatesFromEntries,
} from '../../src/mcp/shared/repo-resolution-errors.js';

describe('repo resolution error formatting', () => {
  it('includes labels, paths, env scope, retry, and arg-first quoted restart commands for unknown repos', () => {
    const message = formatRepoResolutionError({
      reason: 'not-found',
      requestedRepo: 'ontoindex',
      candidates: [{ label: 'codex', path: '/opt/demodb/_workfolder/Repo With Spaces' }],
      environment: {
        mcpRepo: '/opt/demodb/_workfolder/Repo With Spaces',
        projectCwd: '/opt/demodb/_workfolder/Repo With Spaces',
        processCwd: '/opt/demodb/_workfolder/OntoIndex',
      },
      preferredRetryLabel: 'codex',
      intendedPath: '/opt/demodb/_workfolder/Repo With Spaces',
    });

    expect(message).toContain('Repository "ontoindex" not found.');
    expect(message).toContain('- codex -> /opt/demodb/_workfolder/Repo With Spaces');
    expect(message).toContain('ONTOINDEX_MCP_REPO=/opt/demodb/_workfolder/Repo With Spaces');
    expect(message).toContain('repo: "codex"');
    expect(message).toContain("ontoindex mcp --project '/opt/demodb/_workfolder/Repo With Spaces'");
  });

  it('formats multi-repo ambiguity with deterministic first retry', () => {
    const message = formatRepoResolutionError({
      reason: 'ambiguous',
      candidates: [
        { label: 'ontoindex', path: '/repo/ontoindex' },
        { label: 'codex', path: '/repo/codex' },
      ],
    });

    expect(message).toContain('Multiple repositories are indexed');
    expect(message).toContain('repo: "ontoindex"');
  });

  it('keeps Windows-style paths visible in candidate output', () => {
    const candidates = repoResolutionCandidatesFromEntries([
      { name: 'winproj', path: 'C:\\Users\\erasy\\work\\project' },
    ]);

    expect(candidates[0]?.label).toBe('winproj');
    expect(candidates[0]?.path).toContain('C:\\Users\\erasy\\work\\project');
  });

  it('shell-quotes startup mismatch paths in restart commands', () => {
    const message = formatMcpStartupMismatchError({
      repoSelector: '/opt/demodb/_workfolder/Repo With Spaces',
      resolvedRepo: {
        label: 'repo-with-spaces',
        path: '/opt/demodb/_workfolder/Repo With Spaces',
      },
      projectCwd: '/opt/demodb/_workfolder/Repo With Spaces',
      processCwd: '/opt/demodb/_workfolder/OntoIndex',
      gitRoot: '/opt/demodb/_workfolder/Repo With Spaces/.git',
      source: 'cli',
    });

    expect(message).toContain(
      "ontoindex mcp --project '/opt/demodb/_workfolder/Repo With Spaces' --repo '/opt/demodb/_workfolder/Repo With Spaces'",
    );
  });
});
