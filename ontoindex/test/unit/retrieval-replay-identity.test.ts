import { describe, expect, it } from 'vitest';
import {
  isReplayIdentityStrictMatch,
  normalizeReplayIdentities,
  toReplayIdentityKey,
  validateRetrievalReplayIdentity,
} from '../../src/core/search/replay/result-identity.js';

describe('replay identity normalization', () => {
  it('normalizes and sorts identities using deterministic keys', () => {
    const normalized = normalizeReplayIdentities([
      {
        kind: 'route',
        name: '/users/{id}',
        uid: 'Route:GET:/users/{id}',
      },
      {
        kind: 'symbol',
        uid: 'Function:src/cache.ts:CacheStore',
        filePath: 'src/cache.ts',
      },
      {
        kind: 'symbol',
        uid: 'Function:src/cache.ts:CacheStore',
        filePath: 'src/cache.ts',
      },
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized[0].kind).toBe('route');
    expect(normalized[1].kind).toBe('symbol');
  });

  it('uses semantic identity fields (not score/order) for stable key generation', () => {
    const symbolOne = {
      kind: 'symbol',
      uid: 'Function:src/a.ts:Beta',
      filePath: 'src/a.ts',
      name: 'Beta',
    };
    const symbolTwo = {
      kind: 'symbol',
      uid: 'Function:src/b.ts:Alpha',
      filePath: 'src/b.ts',
      name: 'Alpha',
    };
    const firstKey = toReplayIdentityKey(symbolOne);
    const secondKey = toReplayIdentityKey(symbolTwo);

    expect(firstKey.localeCompare(secondKey) > 0).toBe(false);
    expect(new Set([firstKey, secondKey]).size).toBe(2);
  });

  it('flags unknown identities as not matching strict expected identities', () => {
    const expected = {
      kind: 'symbol',
      uid: 'Function:src/main.ts:main',
    };
    const actualUnknown = {
      kind: 'unknown',
      reason: 'result collapsed to doc section',
    };
    expect(isReplayIdentityStrictMatch(actualUnknown, expected)).toBe(false);
  });

  it('only allows explicit unknown-to-unknown strict matches', () => {
    const validation = validateRetrievalReplayIdentity({
      kind: 'unknown',
      reason: 'route-level ambiguity',
    });
    expect(validation.ok).toBe(true);
    const actual = {
      kind: 'unknown' as const,
      reason: 'route-level ambiguity',
      repoPath: '/repo',
    };
    const expected = {
      kind: 'unknown' as const,
      reason: 'route-level ambiguity',
      repoPath: '/repo',
    };
    expect(isReplayIdentityStrictMatch(actual, expected)).toBe(true);
  });
});
