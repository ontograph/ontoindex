import { describe, it, expect } from 'vitest';
import { expandQueryTokens } from '../../src/core/search/query-rewrite.js';

describe('expandQueryTokens', () => {
  it('preserves a query with no identifier-shaped tokens', () => {
    expect(expandQueryTokens('merge with rrf')).toBe('merge with rrf');
    expect(expandQueryTokens('how does the cache work')).toBe('how does the cache work');
  });

  it('splits camelCase and appends', () => {
    expect(expandQueryTokens('mergeWithRRF')).toBe('mergeWithRRF merge With RRF');
    expect(expandQueryTokens('getUserData')).toBe('getUserData get User Data');
  });

  it('splits PascalCase and appends', () => {
    expect(expandQueryTokens('PoolAdapter')).toBe('PoolAdapter Pool Adapter');
  });

  it('splits acronym-prefixed identifiers (URLParser → URL Parser)', () => {
    expect(expandQueryTokens('URLParser')).toBe('URLParser URL Parser');
    expect(expandQueryTokens('HTTPClient')).toBe('HTTPClient HTTP Client');
  });

  it('splits snake_case', () => {
    expect(expandQueryTokens('pool_adapter')).toBe('pool_adapter pool adapter');
    expect(expandQueryTokens('embedding_pipeline_v2')).toBe(
      'embedding_pipeline_v2 embedding pipeline v2',
    );
  });

  it('splits kebab-case', () => {
    expect(expandQueryTokens('user-data')).toBe('user-data user data');
    expect(expandQueryTokens('cuda-probe')).toBe('cuda-probe cuda probe');
  });

  it('expands each token in a multi-token query', () => {
    expect(expandQueryTokens('mergeWithRRF pool_adapter')).toBe(
      'mergeWithRRF merge With RRF pool_adapter pool adapter',
    );
  });

  it('handles empty / whitespace-only inputs without throwing', () => {
    expect(expandQueryTokens('')).toBe('');
    expect(expandQueryTokens('   ')).toBe('   ');
  });

  it('does not split single-word lowercase tokens', () => {
    expect(expandQueryTokens('cache')).toBe('cache');
    expect(expandQueryTokens('embedding')).toBe('embedding');
  });

  it('does not split single-word uppercase tokens (no camelCase signal)', () => {
    expect(expandQueryTokens('RRF')).toBe('RRF');
    expect(expandQueryTokens('BM25')).toBe('BM25');
  });
});
