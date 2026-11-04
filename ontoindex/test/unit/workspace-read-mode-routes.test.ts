import { afterEach, describe, expect, it, vi } from 'vitest';

const prepared = vi.fn(async (_repo, _options, operation) => operation());
vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = vi.fn(async () => true);
    dispose = vi.fn();
    resolveRepo = vi.fn(async () => ({ id: 'fixture' }));
    ensureRepoInitialized = vi.fn();
    withPreparedRepoRead = prepared;
    callTool = vi.fn(async () => ({}));
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  prepared.mockClear();
});

describe('workspace read routes', () => {
  it('prepares CLI workspace reads and rejects unknown modes', async () => {
    const { contextCommand } = await import('../../src/cli/tool.js');
    await contextCommand('symbol', { repo: 'fixture', readMode: 'workspace' });
    expect(prepared).toHaveBeenCalledWith(
      expect.anything(),
      { needsRelationships: true, readMode: 'workspace' },
      expect.any(Function),
    );
    await expect(
      contextCommand('symbol', { repo: 'fixture', readMode: 'other' as any }),
    ).rejects.toThrow('committed or workspace');
  });

  it('validates MCP workspace requests before preparation and advertises supported modes', async () => {
    vi.stubEnv('ONTOINDEX_MCP_STARTUP_PROFILE', 'public-full');
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { CallToolRequestSchema, ListToolsRequestSchema } =
      await import('@modelcontextprotocol/sdk/types.js');
    const spy = vi.spyOn(Server.prototype, 'setRequestHandler');
    const { createMCPServer } = await import('../../src/mcp/server.js');
    const backend = {
      resolveRepo: vi.fn(async () => ({ id: 'fixture', name: 'fixture', repoPath: '/fixture' })),
      ensureRepoInitialized: vi.fn(),
      withPreparedRepoRead: prepared,
      callTool: vi.fn(async () => ({})),
    };
    createMCPServer(backend as any);
    const call = spy.mock.calls.find(([schema]) => schema === CallToolRequestSchema)![1] as any;
    const list = spy.mock.calls.find(([schema]) => schema === ListToolsRequestSchema)![1] as any;
    const tools = (await list()).tools;
    expect(
      tools.find((t: any) => t.name === 'search').inputSchema.properties.read_mode.enum,
    ).toEqual(['committed', 'workspace']);
    expect(
      tools.find((t: any) => t.name === 'gn_explore').inputSchema.properties.read_mode.enum,
    ).toEqual(['committed']);
    for (const args of [
      { action: 'related', repo: 'fixture' },
      { action: 'context', repo: '@group' },
      { action: 'context', repo: 'fixture', include_lsp_refs: true },
    ]) {
      const result = await call({
        params: { name: 'inspect', arguments: { ...args, read_mode: 'workspace' } },
      });
      expect(result.isError).toBe(true);
      expect(prepared).not.toHaveBeenCalled();
    }
    await call({
      params: {
        name: 'inspect',
        arguments: { action: 'context', repo: 'fixture', read_mode: 'workspace' },
      },
    });
    expect(prepared).toHaveBeenCalledWith(
      expect.anything(),
      { needsRelationships: true, readMode: 'workspace' },
      expect.any(Function),
    );
    prepared.mockClear();
    createMCPServer(backend as any, { full: true });
    const fullCall = spy.mock.calls
      .filter(([schema]) => schema === CallToolRequestSchema)
      .at(-1)![1] as any;
    const rejected = await fullCall({
      params: {
        name: 'inspect',
        arguments: { action: 'context', repo: 'fixture', read_mode: 'workspace' },
      },
    });
    expect(rejected.isError).toBe(true);
    expect(prepared).not.toHaveBeenCalled();
    await call({
      params: {
        name: 'inspect',
        arguments: { action: 'context', repo: 'fixture', read_mode: 'committed' },
      },
    });
    expect(prepared).toHaveBeenCalledWith(
      expect.anything(),
      { needsRelationships: true, readMode: 'committed' },
      expect.any(Function),
    );
  });
});
