import { describe, expect, it } from 'vitest';
import {
  attachRepoScopeIdentity,
  createGlobalTargetContext,
  wrapRepoScopeIdentity,
} from '../../src/mcp/shared/response-envelope.js';

describe('response envelope repo identity', () => {
  const repo = {
    id: 'repo-1',
    name: 'fixture',
    repoPath: '/repo/fixture',
  };

  it('adds compact repo identity to legacy object responses', () => {
    const result = attachRepoScopeIdentity({ findings: [] }, repo);
    expect(result).toEqual({
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
      findings: [],
    });
  });

  it('preserves explicit targetContext envelopes', () => {
    const targetContext = createGlobalTargetContext('global');
    const result = attachRepoScopeIdentity({ targetContext, tools: [] }, repo);
    expect(result).toEqual({ targetContext, tools: [] });
  });

  it('preserves arrays and scalars by default', () => {
    const items = [{ name: 'fixture' }];
    expect(attachRepoScopeIdentity(items, repo)).toBe(items);
    expect(attachRepoScopeIdentity('ok', repo)).toBe('ok');
  });

  it('wraps arrays and scalars with an explicit envelope opt-in', () => {
    expect(wrapRepoScopeIdentity([{ name: 'fixture' }], repo)).toEqual({
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
      result: [{ name: 'fixture' }],
    });
    expect(wrapRepoScopeIdentity('ok', repo)).toEqual({
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
      result: 'ok',
    });
  });
});
