import { describe, expect, it } from 'vitest';
import { parseRetrievalReplayCase, RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION, validateRetrievalReplayCase } from '../../src/core/search/replay/replay-case.js';

const minimalValidCase = {
  schemaVersion: RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION,
  id: 'plain-symbol',
  query: 'symbol: CacheStore',
  request: {
    action: 'semantic',
    typedQuery: true,
    retrievalPolicy: 'symbol-neighborhood',
    includeSkeleton: true,
    qualityMode: 'balanced',
  },
  expected: {
    topK: 5,
    identities: [
      {
        kind: 'symbol',
        uid: 'Function:src/cache.ts:CacheStore',
        repoPath: '/repo',
        filePath: 'src/cache.ts',
      },
      {
        kind: 'unknown',
        reason: 'intentional-doc-shift',
      },
    ],
  },
};

describe('replay case validation', () => {
  it('accepts a valid schema-version-1 replay case', () => {
    const parsed = parseRetrievalReplayCase(minimalValidCase);
    expect(parsed.schemaVersion).toBe(RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION);
    expect(parsed.request.action).toBe('semantic');
    expect(parsed.expected.topK).toBe(5);
    expect(parsed.expected.identities).toHaveLength(2);
  });

  it('rejects unsupported schema versions', () => {
    const invalidVersionCase = { ...minimalValidCase, schemaVersion: 2 };
    const result = validateRetrievalReplayCase(invalidVersionCase);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.path).toBe('schemaVersion');
  });

  it('requires request to be present and action to be semantic', () => {
    const missingRequest = { ...minimalValidCase, request: undefined };
    const withoutAction = {
      ...minimalValidCase,
      request: { ...minimalValidCase.request, action: 'wrong' },
    };

    expect(validateRetrievalReplayCase(missingRequest).ok).toBe(false);
    expect(validateRetrievalReplayCase(withoutAction).ok).toBe(false);
  });

  it('rejects malformed identities and unknown identities without reason', () => {
    const malformedIdentityCase = {
      ...minimalValidCase,
      expected: {
        topK: 3,
        identities: [
          {
            kind: 'symbol',
            filePath: 'src/cache.ts',
          },
          {
            kind: 'unknown',
          },
        ],
      },
    };

    const result = validateRetrievalReplayCase(malformedIdentityCase);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((error) => error.message.includes('include reason'))).toBe(true);
  });

  it('rejects malformed topK', () => {
    const malformedTopKCase = {
      ...minimalValidCase,
      expected: {
        ...minimalValidCase.expected,
        topK: 0,
      },
    };
    expect(validateRetrievalReplayCase(malformedTopKCase).ok).toBe(false);
  });
});
