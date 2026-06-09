import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    executeQuery: vi.fn(),
    streamQuery: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

import {
  ClientDisconnectedError,
  estimateLegacyGraphRecordCount,
  getLegacyGraphRecordLimit,
  runApiQueryWithGuards,
  streamGraphNdjson,
  validateApiQueryLimit,
} from '../../src/server/api.js';

const createMockResponse = (writeImpl?: (chunk: string) => boolean) => {
  const response = new EventEmitter() as any;
  response.writableEnded = false;
  response.destroyed = false;
  response.write = vi.fn((chunk: string) => (writeImpl ? writeImpl(chunk) : true));
  return response;
};

describe('streamGraphNdjson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for drain when writes hit backpressure', async () => {
    lbugMocks.streamQuery.mockImplementation(
      async (query: string, onRow: (row: any) => Promise<void>) => {
        if (query.includes('MATCH (n:`File`)')) {
          await onRow({ id: 'File:src/app.ts', name: 'app.ts', filePath: 'src/app.ts' });
          return 1;
        }
        if (query.includes('CodeRelation')) {
          await onRow({
            sourceId: 'File:src/app.ts',
            targetId: 'Function:src/app.ts:main',
            type: 'CONTAINS',
          });
          return 1;
        }
        return 0;
      },
    );

    const writes: string[] = [];
    let firstWrite = true;
    const response = createMockResponse((chunk) => {
      writes.push(chunk);
      if (firstWrite) {
        firstWrite = false;
        return false;
      }
      return true;
    });

    let settled = false;
    const pending = streamGraphNdjson(response, false).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(writes).toHaveLength(1);
    expect(settled).toBe(false);

    response.emit('drain');
    await pending;

    expect(writes).toHaveLength(2);
  });

  it('stops streaming when the client disconnects', async () => {
    const controller = new AbortController();
    lbugMocks.streamQuery.mockImplementation(
      async (query: string, onRow: (row: any) => Promise<void>) => {
        if (!query.includes('MATCH (n:`File`)')) {
          return 0;
        }
        await onRow({ id: 'File:src/app.ts', name: 'app.ts', filePath: 'src/app.ts' });
        controller.abort();
        await onRow({ id: 'File:src/other.ts', name: 'other.ts', filePath: 'src/other.ts' });
        return 2;
      },
    );

    const response = createMockResponse();

    await expect(streamGraphNdjson(response, false, controller.signal)).rejects.toBeInstanceOf(
      ClientDisconnectedError,
    );
    expect(response.write).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-missing table errors', async () => {
    lbugMocks.streamQuery.mockImplementation(async (query: string) => {
      if (query.includes('MATCH (n:`File`)')) {
        throw new Error('database unavailable');
      }
      return 0;
    });

    const response = createMockResponse();
    await expect(streamGraphNdjson(response, false)).rejects.toThrow('database unavailable');
  });

  it('ignores missing-table errors while continuing the stream', async () => {
    lbugMocks.streamQuery.mockImplementation(
      async (query: string, onRow: (row: any) => Promise<void>) => {
        if (query.includes('MATCH (n:`File`)')) {
          throw new Error('Table File does not exist');
        }
        if (query.includes('CodeRelation')) {
          await onRow({
            sourceId: 'File:src/app.ts',
            targetId: 'Function:src/app.ts:main',
            type: 'CONTAINS',
          });
          return 1;
        }
        return 0;
      },
    );

    const response = createMockResponse();
    await expect(streamGraphNdjson(response, false)).resolves.toBeUndefined();
    expect(response.write).toHaveBeenCalledTimes(1);
  });

  it('quotes node table names in generated Cypher queries', async () => {
    lbugMocks.streamQuery.mockImplementation(async () => 0);

    const response = createMockResponse();
    await expect(streamGraphNdjson(response, false)).resolves.toBeUndefined();

    expect(lbugMocks.streamQuery).toHaveBeenCalledWith(
      expect.stringContaining('MATCH (n:`Macro`)'),
      expect.any(Function),
    );
  });

  it('streams Route and Tool nodes without requiring startLine fields', async () => {
    lbugMocks.streamQuery.mockImplementation(
      async (query: string, onRow: (row: any) => Promise<void>) => {
        if (query.includes('MATCH (n:`Route`)')) {
          expect(query).not.toContain('startLine');
          await onRow({
            id: 'Route:/api/graph:GET',
            name: 'GET /api/graph',
            filePath: 'src/server/api.ts',
            responseKeys: ['nodes', 'relationships'],
            errorKeys: ['error'],
            middleware: ['withAuth'],
          });
          return 1;
        }
        if (query.includes('MATCH (n:`Tool`)')) {
          expect(query).not.toContain('startLine');
          await onRow({
            id: 'Tool:ontoindex_query',
            name: 'ontoindex_query',
            filePath: 'src/mcp/resources.ts',
            description: 'Query the code graph',
          });
          return 1;
        }
        return 0;
      },
    );

    const writes: string[] = [];
    const response = createMockResponse((chunk) => {
      writes.push(chunk);
      return true;
    });

    await expect(streamGraphNdjson(response, false)).resolves.toBeUndefined();

    const records = writes.map((chunk) => JSON.parse(chunk));
    expect(records).toContainEqual({
      type: 'node',
      data: {
        id: 'Route:/api/graph:GET',
        label: 'Route',
        properties: {
          name: 'GET /api/graph',
          filePath: 'src/server/api.ts',
          startLine: undefined,
          endLine: undefined,
          content: undefined,
          responseKeys: ['nodes', 'relationships'],
          errorKeys: ['error'],
          middleware: ['withAuth'],
          heuristicLabel: undefined,
          cohesion: undefined,
          symbolCount: undefined,
          description: undefined,
          processType: undefined,
          stepCount: undefined,
          communities: undefined,
          entryPointId: undefined,
          terminalId: undefined,
        },
      },
    });
    expect(records).toContainEqual({
      type: 'node',
      data: {
        id: 'Tool:ontoindex_query',
        label: 'Tool',
        properties: {
          name: 'ontoindex_query',
          filePath: 'src/mcp/resources.ts',
          startLine: undefined,
          endLine: undefined,
          content: undefined,
          responseKeys: undefined,
          errorKeys: undefined,
          middleware: undefined,
          heuristicLabel: undefined,
          cohesion: undefined,
          symbolCount: undefined,
          description: 'Query the code graph',
          processType: undefined,
          stepCount: undefined,
          communities: undefined,
          entryPointId: undefined,
          terminalId: undefined,
        },
      },
    });
  });

  it('estimates legacy graph record count before materializing graph JSON', async () => {
    lbugMocks.executeQuery.mockImplementation(async (query: string) => {
      if (query.includes('MATCH ()-[r:CodeRelation]->()')) return [{ count: 7 }];
      if (query.includes('MATCH (n:`File`)')) return [{ count: 3n }];
      if (query.includes('MATCH (n:`Macro`)')) throw new Error('Table Macro does not exist');
      return [{ count: 2 }];
    });

    await expect(estimateLegacyGraphRecordCount(false)).resolves.toBeGreaterThan(7);
    expect(lbugMocks.executeQuery).toHaveBeenCalledWith(
      expect.stringContaining('RETURN count(n) AS count'),
    );
  });

  it('keeps legacy graph JSON mode below the streaming threshold by default', () => {
    expect(getLegacyGraphRecordLimit()).toBeLessThanOrEqual(25_000);
  });
});

describe('validateApiQueryLimit', () => {
  it('requires an explicit LIMIT for HTTP API queries', () => {
    expect(validateApiQueryLimit('MATCH (n) RETURN n')).toContain('must include LIMIT');
  });

  it('accepts bounded HTTP API queries', () => {
    expect(validateApiQueryLimit('MATCH (n) RETURN n LIMIT 100')).toBeNull();
  });

  it('rejects query limits above the API cap', () => {
    expect(validateApiQueryLimit('MATCH (n) RETURN n LIMIT 50001')).toContain('exceeds');
  });

  it('ignores LIMIT inside string literals', () => {
    expect(validateApiQueryLimit('MATCH (n) RETURN "LIMIT 1" AS text')).toContain(
      'must include LIMIT',
    );
  });

  it('ignores LIMIT inside comments', () => {
    expect(validateApiQueryLimit('MATCH (n) RETURN n /* LIMIT 1 */')).toContain(
      'must include LIMIT',
    );
  });

  it('rejects subquery-only LIMIT', () => {
    expect(validateApiQueryLimit('CALL { MATCH (n) RETURN n LIMIT 1 } RETURN n')).toContain(
      'must include LIMIT',
    );
  });

  it('accepts a bounded top-level result LIMIT after a bounded subquery', () => {
    expect(
      validateApiQueryLimit('CALL { MATCH (n) RETURN n LIMIT 1 } RETURN n LIMIT 100'),
    ).toBeNull();
  });
});

describe('runApiQueryWithGuards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects HTTP API queries without LIMIT before executing them', async () => {
    const result = await runApiQueryWithGuards('MATCH (n) RETURN n', async () => {
      await lbugMocks.executeQuery('MATCH (n) RETURN n');
      return { status: 200, body: { result: [] } };
    });

    expect(result).toEqual({
      status: 400,
      body: { error: 'HTTP API queries must include LIMIT 5000 or lower' },
    });
    expect(lbugMocks.executeQuery).not.toHaveBeenCalled();
  });

  it('rejects HTTP API queries above the cap before executing them', async () => {
    const result = await runApiQueryWithGuards('MATCH (n) RETURN n LIMIT 50001', async () => {
      await lbugMocks.executeQuery('MATCH (n) RETURN n LIMIT 50001');
      return { status: 200, body: { result: [] } };
    });

    expect(result).toEqual({
      status: 400,
      body: { error: 'HTTP API query LIMIT 50001 exceeds maximum 5000' },
    });
    expect(lbugMocks.executeQuery).not.toHaveBeenCalled();
  });

  it('rejects HTTP API queries with LIMIT only inside string literals before executing them', async () => {
    const result = await runApiQueryWithGuards('MATCH (n) RETURN "LIMIT 1" AS text', async () => {
      await lbugMocks.executeQuery('MATCH (n) RETURN "LIMIT 1" AS text');
      return { status: 200, body: { result: [] } };
    });

    expect(result).toEqual({
      status: 400,
      body: { error: 'HTTP API queries must include LIMIT 5000 or lower' },
    });
    expect(lbugMocks.executeQuery).not.toHaveBeenCalled();
  });

  it('rejects HTTP API queries with LIMIT only inside comments before executing them', async () => {
    const result = await runApiQueryWithGuards('MATCH (n) RETURN n /* LIMIT 1 */', async () => {
      await lbugMocks.executeQuery('MATCH (n) RETURN n /* LIMIT 1 */');
      return { status: 200, body: { result: [] } };
    });

    expect(result).toEqual({
      status: 400,
      body: { error: 'HTTP API queries must include LIMIT 5000 or lower' },
    });
    expect(lbugMocks.executeQuery).not.toHaveBeenCalled();
  });

  it('rejects HTTP API queries with only subquery LIMIT before executing them', async () => {
    const query = 'CALL { MATCH (n) RETURN n LIMIT 1 } RETURN n';
    const result = await runApiQueryWithGuards(query, async () => {
      await lbugMocks.executeQuery(query);
      return { status: 200, body: { result: [] } };
    });

    expect(result).toEqual({
      status: 400,
      body: { error: 'HTTP API queries must include LIMIT 5000 or lower' },
    });
    expect(lbugMocks.executeQuery).not.toHaveBeenCalled();
  });
});
