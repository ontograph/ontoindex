import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGraphRAGTools } from '../../src/core/llm/tools';
import type { GraphRAGBackend } from '../../src/core/llm/tools';

const makeBackend = (overrides: Partial<GraphRAGBackend> = {}): GraphRAGBackend => ({
  executeQuery: vi.fn().mockResolvedValue([]),
  search: vi.fn().mockResolvedValue([]),
  grep: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(''),
  ...overrides,
});

describe('createGraphRAGTools', () => {
  let backend: GraphRAGBackend;
  let tools: ReturnType<typeof createGraphRAGTools>;

  beforeEach(() => {
    backend = makeBackend();
    tools = createGraphRAGTools(backend);
  });

  const getTool = (name: string) => {
    const t = tools.find((t) => t.name === name);
    if (!t) throw new Error(`Tool "${name}" not found`);
    return t;
  };

  // ─────────────────── searchTool ───────────────────

  describe('searchTool', () => {
    it('returns "No code found" when search resolves empty', async () => {
      const result = await getTool('search').invoke({ query: 'auth' });
      expect(result).toContain('No code found');
    });

    it('returns error string (no throw) when search throws', async () => {
      backend = makeBackend({ search: vi.fn().mockRejectedValue(new Error('unavailable')) });
      tools = createGraphRAGTools(backend);
      const result = await getTool('search').invoke({ query: 'auth' });
      expect(typeof result).toBe('string');
      expect(result).toContain('not available');
    });

    it('contains result name when search returns results', async () => {
      backend = makeBackend({
        search: vi.fn().mockResolvedValue([
          {
            filePath: 'src/auth/login.ts',
            score: 0.95,
            name: 'loginHandler',
            label: 'Function',
            sources: ['bm25'],
          },
        ]),
      });
      tools = createGraphRAGTools(backend);
      const result = await getTool('search').invoke({ query: 'auth', groupByProcess: false });
      expect(result).toContain('loginHandler');
    });

    it('calls backend.search with the query', async () => {
      await getTool('search').invoke({ query: 'myQuery' });
      expect(backend.search).toHaveBeenCalledWith(
        'myQuery',
        expect.objectContaining({ enrich: true }),
      );
    });
  });

  // ─────────────────── cypherTool ───────────────────

  describe('cypherTool', () => {
    it('calls executeQuery with the cypher string', async () => {
      await getTool('cypher').invoke({ cypher: 'MATCH (n) RETURN n LIMIT 1' });
      expect(backend.executeQuery).toHaveBeenCalledWith('MATCH (n) RETURN n LIMIT 1');
    });

    it('adds a safe default LIMIT when cypher omits one', async () => {
      await getTool('cypher').invoke({ cypher: 'MATCH (n) RETURN n' });
      expect(backend.executeQuery).toHaveBeenCalledWith('MATCH (n) RETURN n LIMIT 100');
    });

    it('returns "no results" message when executeQuery returns []', async () => {
      const result = await getTool('cypher').invoke({ cypher: 'MATCH (n) RETURN n' });
      expect(result).toContain('no results');
    });

    it('formats results as a markdown table when executeQuery returns rows', async () => {
      backend = makeBackend({
        executeQuery: vi.fn().mockResolvedValue([{ name: 'foo', filePath: 'src/foo.ts' }]),
      });
      tools = createGraphRAGTools(backend);
      const result = await getTool('cypher').invoke({ cypher: 'MATCH (n) RETURN n.name AS name' });
      expect(result).toContain('name');
      expect(result).toContain('foo');
    });

    it('routes {{QUERY_VECTOR}} to semantic search via backend.search', async () => {
      backend = makeBackend({
        search: vi
          .fn()
          .mockResolvedValue([
            { filePath: 'src/x.ts', score: 0.8, name: 'xFn', label: 'Function' },
          ]),
      });
      tools = createGraphRAGTools(backend);
      const result = await getTool('cypher').invoke({
        cypher: 'CALL QUERY_VECTOR_INDEX({{QUERY_VECTOR}}, 10)',
        query: 'authentication',
      });
      expect(backend.search).toHaveBeenCalledWith(
        'authentication',
        expect.objectContaining({ mode: 'semantic' }),
      );
      expect(result).toContain('Semantic search');
    });

    it('returns error string when {{QUERY_VECTOR}} present but query omitted', async () => {
      const result = await getTool('cypher').invoke({
        cypher: 'CALL QUERY_VECTOR_INDEX({{QUERY_VECTOR}}, 10)',
      });
      expect(result).toContain("didn't provide a 'query'");
    });

    it('returns cypher error string when executeQuery throws (no propagation)', async () => {
      backend = makeBackend({
        executeQuery: vi.fn().mockRejectedValue(new Error('syntax error')),
      });
      tools = createGraphRAGTools(backend);
      const result = await getTool('cypher').invoke({ cypher: 'INVALID QUERY' });
      expect(result).toContain('Cypher error');
    });
  });

  // ─────────────────── grepTool ───────────────────

  describe('grepTool', () => {
    it('returns no-matches message when grep resolves []', async () => {
      const result = await getTool('grep').invoke({ pattern: 'TODO' });
      expect(result).toContain('No matches');
    });

    it('output contains matched file path when grep returns results', async () => {
      backend = makeBackend({
        grep: vi
          .fn()
          .mockResolvedValue([{ filePath: 'src/worker.ts', line: 42, text: 'TODO: fix me' }]),
      });
      tools = createGraphRAGTools(backend);
      const result = await getTool('grep').invoke({ pattern: 'TODO' });
      expect(result).toContain('src/worker.ts');
      expect(result).toContain('42');
    });

    it('returns error string (no throw) when grep throws', async () => {
      backend = makeBackend({ grep: vi.fn().mockRejectedValue(new Error('grep failed')) });
      tools = createGraphRAGTools(backend);
      const result = await getTool('grep').invoke({ pattern: 'oops' });
      expect(result).toContain('Grep error');
    });

    it('rejects invalid regex before calling backend', async () => {
      const result = await getTool('grep').invoke({ pattern: '[invalid' });
      expect(result).toContain('Invalid regex');
      expect(backend.grep).not.toHaveBeenCalled();
    });
  });

  // ─────────────────── readTool ───────────────────

  describe('readTool', () => {
    it('calls readFile with the given path', async () => {
      await getTool('read').invoke({ filePath: 'src/utils.ts' });
      expect(backend.readFile).toHaveBeenCalledWith('src/utils.ts');
    });

    it('returns file content on success', async () => {
      backend = makeBackend({ readFile: vi.fn().mockResolvedValue('export const x = 1;') });
      tools = createGraphRAGTools(backend);
      const result = await getTool('read').invoke({ filePath: 'src/utils.ts' });
      expect(result).toContain('export const x = 1;');
    });

    it('returns error string (no throw) when readFile throws', async () => {
      backend = makeBackend({ readFile: vi.fn().mockRejectedValue(new Error('disk error')) });
      tools = createGraphRAGTools(backend);
      const result = await getTool('read').invoke({ filePath: 'src/utils.ts' });
      expect(typeof result).toBe('string');
      expect(result).toContain('Error reading file');
    });

    it('returns "File not found" message on 404-style errors', async () => {
      backend = makeBackend({ readFile: vi.fn().mockRejectedValue(new Error('not found')) });
      tools = createGraphRAGTools(backend);
      const result = await getTool('read').invoke({ filePath: 'missing.ts' });
      expect(result).toContain('not found');
    });
  });

  // ─────────────────── overviewTool ───────────────────

  describe('overviewTool', () => {
    it('calls executeQuery at least once', async () => {
      await getTool('overview').invoke({});
      expect(backend.executeQuery).toHaveBeenCalled();
    });

    it('returns a non-empty string', async () => {
      const result = await getTool('overview').invoke({});
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('includes cluster and process section headers', async () => {
      const result = await getTool('overview').invoke({});
      expect(result).toContain('CLUSTERS');
      expect(result).toContain('PROCESSES');
    });

    it('returns error string (no throw) when executeQuery rejects', async () => {
      backend = makeBackend({ executeQuery: vi.fn().mockRejectedValue(new Error('db down')) });
      tools = createGraphRAGTools(backend);
      const result = await getTool('overview').invoke({});
      expect(result).toContain('Overview error');
    });
  });

  // ─────────────────── exploreTool ───────────────────

  describe('exploreTool', () => {
    it('returns a string for an unknown target (no throw)', async () => {
      const result = await getTool('explore').invoke({ target: 'nonexistent-xyz' });
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('calls executeQuery when type is "process"', async () => {
      backend = makeBackend({
        executeQuery: vi
          .fn()
          .mockResolvedValue([{ id: 'p1', label: 'Auth Process', type: 'flow', stepCount: 3 }]),
      });
      tools = createGraphRAGTools(backend);
      await getTool('explore').invoke({ target: 'Auth Process', type: 'process' });
      expect(backend.executeQuery).toHaveBeenCalled();
    });

    it('returns process detail string when a process is found', async () => {
      backend = makeBackend({
        executeQuery: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'p1', label: 'Login Flow', type: 'flow', stepCount: 2 }])
          .mockResolvedValue([]),
      });
      tools = createGraphRAGTools(backend);
      const result = await getTool('explore').invoke({ target: 'Login Flow', type: 'process' });
      expect(result).toContain('PROCESS');
    });

    it('returns cluster detail string when type is "cluster"', async () => {
      backend = makeBackend({
        executeQuery: vi
          .fn()
          .mockResolvedValueOnce([]) // no process match
          .mockResolvedValueOnce([
            { id: 'c1', label: 'Auth Cluster', cohesion: 0.9, symbolCount: 5, description: 'auth' },
          ])
          .mockResolvedValue([]),
      });
      tools = createGraphRAGTools(backend);
      const result = await getTool('explore').invoke({ target: 'Auth Cluster' });
      expect(result).toContain('CLUSTER');
    });

    it('returns "Could not find" for completely unknown target', async () => {
      const result = await getTool('explore').invoke({ target: 'zzz-unknown-zzz' });
      expect(result).toContain('Could not find');
    });
  });

  // ─────────────────── impactTool ───────────────────

  describe('impactTool', () => {
    it('calls executeQuery for target resolution', async () => {
      await getTool('impact').invoke({ target: 'myFn', direction: 'upstream' });
      expect(backend.executeQuery).toHaveBeenCalled();
    });

    it('returns a non-empty string result', async () => {
      const result = await getTool('impact').invoke({ target: 'myFn', direction: 'upstream' });
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns "Could not find" when target node not in graph', async () => {
      const result = await getTool('impact').invoke({ target: 'ghostFn', direction: 'upstream' });
      expect(result).toContain('Could not find');
    });

    it('returns impact report string when target is found', async () => {
      backend = makeBackend({
        executeQuery: vi
          .fn()
          // findTargetQuery: returns one node
          .mockResolvedValueOnce([{ id: 'fn1', nodeType: 'Function', filePath: 'src/foo.ts' }])
          // d1 depth query
          .mockResolvedValueOnce([])
          // remaining Promise.all calls
          .mockResolvedValue([]),
      });
      tools = createGraphRAGTools(backend);
      const result = await getTool('impact').invoke({ target: 'myFn', direction: 'upstream' });
      expect(typeof result).toBe('string');
    });

    it('returns valid relation types error for empty invalid relationTypes', async () => {
      backend = makeBackend({
        executeQuery: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'fn1', nodeType: 'Function', filePath: 'src/foo.ts' }])
          .mockResolvedValue([]),
      });
      tools = createGraphRAGTools(backend);
      const result = await getTool('impact').invoke({
        target: 'myFn',
        direction: 'upstream',
        relationTypes: ['INVALID_TYPE'],
      });
      expect(result).toContain('No valid relation types');
    });
  });
});
