import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolMocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  isLbugReady: vi.fn(),
  isWriteQuery: vi.fn(),
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
  executeQuery: poolMocks.executeQuery,
  isLbugReady: poolMocks.isLbugReady,
  isWriteQuery: poolMocks.isWriteQuery,
}));

import { queryCypher, validateMcpCypherLimit } from '../../src/mcp/local/backend-query.js';

describe('MCP Cypher query limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolMocks.isLbugReady.mockReturnValue(true);
    poolMocks.isWriteQuery.mockReturnValue(false);
    poolMocks.executeQuery.mockResolvedValue([{ ok: true }]);
  });

  it('rejects raw Cypher without LIMIT before executing it', async () => {
    const result = await queryCypher({ id: 'repo' }, { query: 'MATCH (n) RETURN n' });

    expect(result).toEqual({
      error: 'MCP Cypher queries must include LIMIT 5000 or lower',
    });
    expect(poolMocks.executeQuery).not.toHaveBeenCalled();
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
    expect(poolMocks.executeQuery).not.toHaveBeenCalled();
  });

  it('ignores LIMIT inside string literals before executing it', async () => {
    const result = await queryCypher(
      { id: 'repo' },
      { query: 'MATCH (n) RETURN "LIMIT 1" AS text' },
    );

    expect(result).toEqual({
      error: 'MCP Cypher queries must include LIMIT 5000 or lower',
    });
    expect(poolMocks.executeQuery).not.toHaveBeenCalled();
  });

  it('ignores LIMIT inside comments before executing it', async () => {
    const result = await queryCypher({ id: 'repo' }, { query: 'MATCH (n) RETURN n // LIMIT 1' });

    expect(result).toEqual({
      error: 'MCP Cypher queries must include LIMIT 5000 or lower',
    });
    expect(poolMocks.executeQuery).not.toHaveBeenCalled();
  });

  it('rejects subquery-only LIMIT before executing it', async () => {
    const result = await queryCypher(
      { id: 'repo' },
      { query: 'CALL { MATCH (n) RETURN n LIMIT 1 } RETURN n' },
    );

    expect(result).toEqual({
      error: 'MCP Cypher queries must include LIMIT 5000 or lower',
    });
    expect(poolMocks.executeQuery).not.toHaveBeenCalled();
  });

  it('executes read-only Cypher when LIMIT is bounded', async () => {
    const result = await queryCypher({ id: 'repo' }, { query: 'MATCH (n) RETURN n LIMIT 25' });

    expect(result).toEqual([{ ok: true }]);
    expect(poolMocks.executeQuery).toHaveBeenCalledWith('repo', 'MATCH (n) RETURN n LIMIT 25');
  });

  it('executes read-only Cypher when a property named limit precedes the result LIMIT', async () => {
    const query = 'MATCH (n) RETURN n.limit AS value LIMIT 10';
    const result = await queryCypher({ id: 'repo' }, { query });

    expect(result).toEqual([{ ok: true }]);
    expect(poolMocks.executeQuery).toHaveBeenCalledWith('repo', query);
  });

  it('executes read-only Cypher when a subquery and top-level result LIMIT are bounded', async () => {
    const query = 'CALL { MATCH (n) RETURN n LIMIT 1 } RETURN n LIMIT 25';
    const result = await queryCypher({ id: 'repo' }, { query });

    expect(result).toEqual([{ ok: true }]);
    expect(poolMocks.executeQuery).toHaveBeenCalledWith('repo', query);
  });
});
