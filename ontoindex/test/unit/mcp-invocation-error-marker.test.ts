import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock('../../src/mcp/super/dispatch.js');
});

describe('MCP invocation errors', () => {
  it.each([true, false])('classifies only explicitly marked results: %s', async (marked) => {
    vi.resetModules();
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const { gnGraphWalk } = await import('../../src/mcp/super/graph-walk.js');
    const payload = marked
      ? await gnGraphWalk('fixture', { action: 'start' })
      : { status: 'error', ok: false, nested: { ok: false } };
    vi.doMock('../../src/mcp/super/dispatch.js', () => ({
      dispatchSuper: vi.fn(async () => payload),
    }));
    const spy = vi.spyOn(Server.prototype, 'setRequestHandler');
    const { createMCPServer } = await import('../../src/mcp/server.js');
    createMCPServer({
      resolveRepo: vi.fn(async () => ({ id: 'fixture', name: 'fixture', repoPath: '/fixture' })),
      ensureRepoInitialized: vi.fn(),
      callTool: vi.fn(),
    } as any);
    const handler = spy.mock.calls.find(([schema]) => schema === CallToolRequestSchema)![1] as any;
    const response = await handler({
      params: { name: 'gn_graph_walk', arguments: { action: 'start' } },
    });
    expect(response.isError).toBe(marked ? true : undefined);
    const text = JSON.stringify(
      { repoLabel: 'fixture', repoPath: '/fixture', ...payload },
      null,
      2,
    );
    expect(response.content[0].text).toContain(text);
    if (marked) expect(response.content[0].text).toContain('SEED_SYMBOL_REQUIRED');
  });
  it.each([true, false])(
    'traces a rejected server connection only when enabled: %s',
    async (enabled) => {
      vi.resetModules();
      vi.stubEnv('ONTOINDEX_MCP_STARTUP_TRACE', enabled ? '1' : '0');
      const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
      vi.spyOn(Server.prototype, 'connect').mockRejectedValue(new Error('transport failed'));
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { startMCPServer } = await import('../../src/mcp/server.js');
      await expect(startMCPServer({} as any)).rejects.toThrow('transport failed');
      if (enabled) {
        expect(stderr).toHaveBeenCalledWith('[ontoindex:mcp:init] server.connect: start');
        expect(stderr).toHaveBeenCalledWith(
          '[ontoindex:mcp:init] server.connect: failed: transport failed',
        );
      } else expect(stderr).not.toHaveBeenCalled();
    },
  );
});
