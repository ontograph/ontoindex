import { describe, expect, it, vi } from 'vitest';
import { projectResponseSourceLines } from '../../src/mcp/shared/response-source-lines.js';

const row = { filePath: 'src/a.ts', type: 'Function', startLine: 0, endLine: 3, line: 0 };
const publicRow = { ...row, startLine: 1, endLine: 4, line: 1 };

describe('public source line projection', () => {
  const auditRows = [
    row,
    { ...row, filePath: 'notes.md' },
    { ...row, filePath: 'README', type: 'Section' },
    { ...row, filePath: 'program.cob' },
    { ...row, filePath: 'build.jcl' },
  ];

  it.each([
    ['search', 'repomap', 'symbols'],
    ['audit', 'dead_code', 'entries'],
    ['audit', 'tech_debt', 'symbols'],
  ])('projects %s/%s graph rows while preserving one-based ingesters', (tool, action, key) => {
    const result = { [key]: auditRows };
    expect(projectResponseSourceLines(tool, action, result)).toEqual({
      [key]: [publicRow, ...auditRows.slice(1)],
    });
    expect(result[key][0].startLine).toBe(0);
  });

  it('projects tech debt finding locations using their filePath and line fields', () => {
    const result = { findings: auditRows.map((location) => ({ location })) };
    expect(projectResponseSourceLines('audit', 'tech_debt', result)).toEqual({
      findings: [publicRow, ...auditRows.slice(1)].map((location) => ({ location })),
    });
    expect(result.findings[0].location.startLine).toBe(0);
  });

  it.each([
    ['audit', 'pre_commit_audit'],
    ['gn_pre_commit_audit', undefined],
  ])('projects only symbol evidence in %s and preserves hunk lines', (tool, action) => {
    const hunk = { ...row, kind: 'hunk', startLine: 1, endLine: 4 };
    const evidence = [...auditRows.map((entry) => ({ ...entry, kind: 'symbol' })), hunk];
    expect(projectResponseSourceLines(tool, action, { evidence })).toEqual({
      evidence: [{ ...publicRow, kind: 'symbol' }, ...evidence.slice(1)],
    });
    expect(evidence[0].startLine).toBe(0);
  });

  it('projects successful group context payloads once and preserves errors and unrelated entries', () => {
    const symbol = { ...row, citations: [{ lineSpan: { start: 0, end: 3 } }] };
    const payload = { symbol, candidates: auditRows, unrelated: { symbol: row } };
    const error = { repoPath: '/error', payload: { ...payload, error: 'unavailable' } };
    const unrelated = { symbol: row };
    const result = {
      group: 'group',
      target: 'a',
      service: 'context',
      results: [{ repoPath: '/one', registryName: 'one', payload }, error, unrelated, null],
      unrelated: { symbol: row },
    };
    const original = structuredClone(result);
    const projected = projectResponseSourceLines('inspect', 'context', result) as typeof result;
    expect(projected).toEqual({
      ...result,
      results: [
        {
          repoPath: '/one',
          registryName: 'one',
          payload: {
            ...payload,
            symbol: { ...publicRow, citations: [{ lineSpan: { start: 1, end: 4 } }] },
            candidates: [publicRow, ...auditRows.slice(1)],
          },
        },
        error,
        unrelated,
        null,
      ],
    });
    expect(projected.results[1]).toBe(error);
    expect(projected.results[2]).toBe(unrelated);
    expect(result).toEqual(original);
  });

  it.each(auditRows)(
    'projects impact source identity for $filePath using batch rules',
    (identity) => {
      const { type, ...location } = identity;
      const sourceIdentity = { ...location, kind: type, sourceDigest: 'digest' };
      const result = { sourceIdentity, target: identity, candidates: [identity] };
      const original = structuredClone(result);
      const expectedIdentity = identity === row ? publicRow : identity;
      const { type: _type, ...expectedLocation } = expectedIdentity;
      const expected = {
        sourceIdentity: { ...expectedLocation, kind: type, sourceDigest: 'digest' },
        target: expectedIdentity,
        candidates: [expectedIdentity],
      };
      expect(projectResponseSourceLines('impact', 'symbol', result)).toEqual(expected);
      expect(
        projectResponseSourceLines('impact', 'batch', { perSymbol: [{ target: 'a', result }] }),
      ).toEqual({ perSymbol: [{ target: 'a', result: expected }] });
      expect(result).toEqual(original);
    },
  );

  it('serializes once before paging and reuses projected pages without another backend call', async () => {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const { createMCPServer } = await import('../../src/mcp/server.js');
    const setHandler = vi.spyOn(Server.prototype, 'setRequestHandler');
    const result = { symbol: { ...row, content: 'x'.repeat(70000) } };
    const backend = { callTool: vi.fn(async () => result) };
    const server = createMCPServer(backend as never);
    try {
      const handler = setHandler.mock.calls.find(
        ([schema]) => schema === CallToolRequestSchema,
      )![1];
      const args = { action: 'context', name: 'a', response_budget_bytes: 1000000 };
      const call = async (arguments_: Record<string, unknown>) => {
        const response = await (handler as (request: unknown) => Promise<any>)({
          params: { name: 'inspect', arguments: arguments_ },
        });
        expect(response.isError).toBeUndefined();
        return JSON.parse(response.content[0].text);
      };
      let page = await call(args);
      expect(page.responsePage).toBeDefined();
      let serialized = page.chunk;
      while (page.responsePage.nextCursor) {
        page = await call({ ...args, response_cursor: page.responsePage.nextCursor });
        serialized += page.chunk;
      }
      expect(JSON.parse(serialized).symbol).toMatchObject(publicRow);
      expect(backend.callTool).toHaveBeenCalledTimes(1);
      expect(result.symbol.startLine).toBe(0);
    } finally {
      setHandler.mockRestore();
      await server.close();
    }
  });

  it('projects all semantic symbol locations without mutating shared input rows', () => {
    const symbol = {
      ...row,
      citations: [{ lineSpan: { start: 0, end: 3 } }],
      lspRefs: { line: 0 },
    };
    const result = {
      definitions: [symbol],
      process_symbols: [symbol],
      processes: [{ symbols: [symbol] }],
      structured_retrieval: { candidates: [symbol], rows: [symbol] },
    };
    const projected = projectResponseSourceLines('search', 'semantic', result) as typeof result;
    for (const symbols of [
      projected.definitions,
      projected.process_symbols,
      projected.processes[0].symbols,
      projected.structured_retrieval.candidates,
      projected.structured_retrieval.rows,
    ]) {
      expect(symbols[0]).toMatchObject(publicRow);
      expect(symbols[0].citations[0].lineSpan).toEqual({ start: 1, end: 4 });
      expect(symbols[0].lspRefs).toEqual({ line: 0 });
    }
    expect(symbol.startLine).toBe(0);
    expect(symbol.citations[0].lineSpan.start).toBe(0);
    expect(projectResponseSourceLines('search', 'semantic', result)).toEqual(projected);
  });

  it.each([
    'notes.md',
    'notes.MDX',
    'notes.markdown',
    'a.cob',
    'a.cbl',
    'a.cobol',
    'a.cpy',
    'a.copybook',
    'a.jcl',
    'a.job',
    'a.proc',
  ])('preserves one-based %s', (filePath) => {
    const symbol = { ...row, filePath, citations: [{ lineSpan: { start: 1, end: 3 } }] };
    expect(projectResponseSourceLines('search', 'semantic', { definitions: [symbol] })).toEqual({
      definitions: [symbol],
    });
  });

  it('preserves Section labels even without a Markdown extension and nonnumeric coordinates', () => {
    const symbols = [
      { ...row, type: 'Section', filePath: 'README' },
      { filePath: 'a.ts', startLine: null, endLine: '3' },
      { startLine: 0 },
    ];
    expect(projectResponseSourceLines('search', 'semantic', { definitions: symbols })).toEqual({
      definitions: symbols,
    });
  });

  it.each([
    ['inspect', 'context'],
    ['impact', 'symbol'],
  ])('projects %s %s candidates', (tool, action) => {
    expect(projectResponseSourceLines(tool, action, { candidates: [row] })).toEqual({
      candidates: [publicRow],
    });
  });

  it('projects context symbols and impact targets including nested batch results', () => {
    expect(projectResponseSourceLines('inspect', 'context', { symbol: row })).toEqual({
      symbol: publicRow,
    });
    expect(projectResponseSourceLines('impact', 'symbol', { target: row })).toEqual({
      target: publicRow,
    });
    expect(
      projectResponseSourceLines('impact', 'batch', {
        perSymbol: [{ target: 'a', result: { target: row, candidates: [row] } }],
      }),
    ).toEqual({
      perSymbol: [{ target: 'a', result: { target: publicRow, candidates: [publicRow] } }],
    });
  });

  it.each([
    ['search', 'cypher'],
    ['inspect', 'evidence'],
    ['audit', 'verify_diff'],
    ['inspect', 'module'],
    ['gn_context', undefined],
  ])('leaves %s/%s unchanged', (tool, action) => {
    const result = { symbol: row, definitions: [row], evidence: [{ start_line: 1 }] };
    expect(projectResponseSourceLines(tool, action, result)).toBe(result);
    expect(projectResponseSourceLines(tool, action, 'raw')).toBe('raw');
  });
});
