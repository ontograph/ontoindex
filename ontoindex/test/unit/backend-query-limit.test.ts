import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolMocks = vi.hoisted(() => ({
  executeParameterized: vi.fn(),
  isLbugReady: vi.fn(),
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    executeParameterized: poolMocks.executeParameterized,
    executeQuery: vi.fn(),
    isLbugReady: poolMocks.isLbugReady,
  };
});

import { queryCypher, validateMcpCypherLimit } from '../../src/mcp/local/backend-query.js';

describe('MCP Cypher query limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolMocks.isLbugReady.mockReturnValue(true);
    poolMocks.executeParameterized.mockResolvedValue([{ ok: true }]);
  });

  it('rejects raw Cypher without LIMIT before executing it', async () => {
    const result = await queryCypher({ id: 'repo' }, { query: 'MATCH (n) RETURN n' });

    expect(result).toEqual({
      error: 'MCP Cypher queries must include LIMIT 5000 or lower',
    });
    expect(poolMocks.executeParameterized).not.toHaveBeenCalled();
  });

  it('rejects raw Cypher above the configured maximum', () => {
    expect(validateMcpCypherLimit('MATCH (n) RETURN n LIMIT 5001')).toBe(
      'MCP Cypher query LIMIT 5001 exceeds maximum 5000',
    );
  });

  it('rejects raw Cypher above the configured maximum before executing it', async () => {
    const result = await queryCypher({ id: 'repo' }, { query: 'MATCH (n) RETURN n LIMIT 5001' });

    expect(result).toEqual({
      error: 'MCP Cypher query LIMIT 5001 exceeds maximum 5000',
    });
    expect(poolMocks.executeParameterized).not.toHaveBeenCalled();
  });

  it('ignores LIMIT inside string literals before executing it', async () => {
    const result = await queryCypher(
      { id: 'repo' },
      { query: 'MATCH (n) RETURN "LIMIT 1" AS text' },
    );

    expect(result).toEqual({
      error: 'MCP Cypher queries must include LIMIT 5000 or lower',
    });
    expect(poolMocks.executeParameterized).not.toHaveBeenCalled();
  });

  it('ignores LIMIT inside comments before executing it', async () => {
    const result = await queryCypher({ id: 'repo' }, { query: 'MATCH (n) RETURN n // LIMIT 1' });

    expect(result).toEqual({
      error: 'MCP Cypher queries must include LIMIT 5000 or lower',
    });
    expect(poolMocks.executeParameterized).not.toHaveBeenCalled();
  });

  it('rejects subquery-only LIMIT before executing it', async () => {
    const result = await queryCypher(
      { id: 'repo' },
      { query: 'MATCH (root) CALL { MATCH (n) RETURN n LIMIT 1 } RETURN n' },
    );

    expect(result).toEqual({
      error: 'MCP Cypher queries must include LIMIT 5000 or lower',
    });
    expect(poolMocks.executeParameterized).not.toHaveBeenCalled();
  });

  it('executes read-only Cypher when LIMIT is bounded', async () => {
    const result = await queryCypher({ id: 'repo' }, { query: 'MATCH (n) RETURN n LIMIT 25' });

    expect(result).toEqual([{ ok: true }]);
    expect(poolMocks.executeParameterized).toHaveBeenCalledWith(
      'repo',
      'MATCH (n) RETURN n LIMIT 25',
      {},
    );
  });

  it('executes read-only Cypher when a property named limit precedes the result LIMIT', async () => {
    const query = 'MATCH (n) RETURN n.limit AS value LIMIT 10';
    const result = await queryCypher({ id: 'repo' }, { query });

    expect(result).toEqual([{ ok: true }]);
    expect(poolMocks.executeParameterized).toHaveBeenCalledWith('repo', query, {});
  });

  it('executes read-only Cypher when a subquery and top-level result LIMIT are bounded', async () => {
    const query = 'MATCH (root) CALL { MATCH (n) RETURN n LIMIT 1 } RETURN n LIMIT 25';
    const result = await queryCypher({ id: 'repo' }, { query });

    expect(result).toEqual([{ ok: true }]);
    expect(poolMocks.executeParameterized).toHaveBeenCalledWith('repo', query, {});
  });

  it.each([
    ['RETURN 1 AS create LIMIT 1', 'forbidden keyword CREATE'],
    ['RETURN 1 LIMIT 1; RETURN 2 LIMIT 1', 'multiple statements'],
    ['RETURN 1 LIMIT 1 /* secret-value', 'unterminated block comment'],
    ["RETURN 'secret-value LIMIT 1", 'unterminated quoted text or identifier'],
    ['EXPLAIN MATCH (n) RETURN n LIMIT 1', 'unsupported opening clause'],
    ['PROFILE MATCH (n) RETURN n LIMIT 1', 'unsupported opening clause'],
    ['CALL db.labels() RETURN label LIMIT 1', 'unsupported opening clause'],
    ['EXPORT DATABASE "secret-value"', 'forbidden keyword EXPORT'],
  ])('propagates the read-only reason without execution: %s', async (query, reason) => {
    const result = await queryCypher({ id: 'repo' }, { query });

    expect(result).toEqual({ error: expect.stringContaining(reason) });
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(poolMocks.executeParameterized).not.toHaveBeenCalled();
  });

  it('executes a bounded read with a quoted keyword alias', async () => {
    const query = 'RETURN 1 AS `create` LIMIT 1';
    const result = await queryCypher({ id: 'repo' }, { query });

    expect(result).toEqual([{ ok: true }]);
    expect(poolMocks.executeParameterized).toHaveBeenCalledWith('repo', query, {});
  });
});
