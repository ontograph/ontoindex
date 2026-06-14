import { describe, expect, it } from 'vitest';

import {
  attachRepoScopeIdentity,
  createGlobalTargetContext,
} from '../../src/mcp/shared/response-envelope.js';

describe('public response identity', () => {
  const repo = {
    id: 'repo-1',
    name: 'fixture',
    repoPath: '/repo/fixture',
  };

  it('preserves representative global public envelopes without adding repo identity', () => {
    const response = {
      version: 1,
      source: 'mcp-frontier',
      startupProfile: 'default',
      targetContext: createGlobalTargetContext('discover/tools does not require repository resolution'),
      count: 1,
      tools: [{ name: 'discover', kind: 'facade' }],
    };

    expect(attachRepoScopeIdentity(response, repo)).toEqual(response);
  });

  it('still backfills repo identity for representative legacy public objects', () => {
    expect(attachRepoScopeIdentity({ findings: [] }, repo)).toEqual({
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
      findings: [],
    });
  });
});
