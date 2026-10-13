import { describe, expect, it } from 'vitest';
import path from 'node:path';

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
        projectCwd: '/opt/demodb/_workfolder/Repo With Spaces',
        processCwd: '/opt/demodb/_workfolder/OntoIndex',
      },
      preferredRetryLabel: 'codex',
      intendedPath: '/opt/demodb/_workfolder/Repo With Spaces',
    });

    expect(message).toContain('Repository "ontoindex" not found.');
    expect(message).toContain('- codex -> /opt/demodb/_workfolder/Repo With Spaces');
    expect(message).not.toContain('ONTOINDEX_MCP_REPO');
    expect(message).toContain('ONTOINDEX_MCP_PROJECT_CWD=/opt/demodb/_workfolder/Repo With Spaces');
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
    const projectPath = path.resolve("/project/Current Repo's Checkout");
    const repoPath = path.resolve('/opt/demodb/_workfolder/Repo With Spaces');
    const quotedProjectPath = `'${projectPath.replace(/'/g, `'"'"'`)}'`;
    const message = formatMcpStartupMismatchError({
      repoSelector: '/opt/demodb/_workfolder/Repo With Spaces',
      resolvedRepo: {
        label: 'repo-with-spaces',
        path: '/opt/demodb/_workfolder/Repo With Spaces',
      },
      projectCwd: "/project/Current Repo's Checkout",
      processCwd: '/opt/demodb/_workfolder/OntoIndex',
      gitRoot: '/opt/demodb/_workfolder/Repo With Spaces/.git',
    });

    expect(message).toContain('OntoIndex MCP startup blocked: --repo');
    expect(message).not.toContain('ONTOINDEX_MCP_REPO');
    expect(message).toContain('Keep the current project:');
    expect(message).toContain(`ontoindex mcp --project ${quotedProjectPath}`);
    expect(message).toContain('Use the resolved repository:');
    expect(message).toContain(`ontoindex mcp --project '${repoPath}' --repo '${repoPath}'`);
    expect(message).not.toContain(`--project ${quotedProjectPath} --repo`);
  });
});
