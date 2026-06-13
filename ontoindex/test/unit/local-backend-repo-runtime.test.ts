import { describe, expect, it } from 'vitest';
import type { RepoHandle } from 'ontoindex-shared';

import { resolveRepoFromHandles } from '../../src/mcp/local/local-backend-repo-runtime.js';

function makeRepo(id: string, name: string, repoPath: string): RepoHandle {
  return {
    id,
    name,
    repoPath,
    storagePath: `${repoPath}/.ontoindex`,
    lbugPath: `${repoPath}/.ontoindex/lbug.db`,
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

    const result = resolveRepoFromHandles(
      repos,
      undefined,
      '/opt/demodb/_workfolder/ontocode',
    );

    expect(result?.id).toBe('codex');
  });

  it('prefers an explicit repo parameter over the preferred project path', () => {
    const repos = new Map<string, RepoHandle>([
      ['ontoindex', makeRepo('ontoindex', 'OntoIndex', '/opt/demodb/_workfolder/OntoIndex')],
      ['codex', makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode')],
    ]);

    const result = resolveRepoFromHandles(repos, 'ontoindex', '/opt/demodb/_workfolder/ontocode');

    expect(result?.id).toBe('ontoindex');
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

    expect(result).toBeNull();
  });
});
