import { afterEach, describe, expect, it, vi } from 'vitest';

type ToolCallHandler = (request: {
  params: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}) => Promise<any>;

type MockBackend = {
  callTool: ReturnType<typeof vi.fn>;
  resolveRepo: ReturnType<typeof vi.fn>;
  ensureRepoInitialized: ReturnType<typeof vi.fn>;
};

async function createHarness(
  options: {
    callToolError?: string;
    dispatchError?: string;
    resolveRepoError?: string;
  } = {},
): Promise<{ backend: MockBackend; handler: ToolCallHandler }> {
  vi.resetModules();

  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  if (options.dispatchError) {
    vi.doMock('../../src/mcp/super/dispatch.js', () => ({
      dispatchSuper: vi.fn(async () => {
        throw new Error(options.dispatchError);
      }),
    }));
  }

  const setRequestHandlerSpy = vi.spyOn(Server.prototype, 'setRequestHandler');
  const { createMCPServer } = await import('../../src/mcp/server.js');

  const backend: MockBackend = {
    callTool: vi.fn(async () => {
      if (options.callToolError) throw new Error(options.callToolError);
      return { ok: true };
    }),
    resolveRepo: vi.fn(async () => {
      if (options.resolveRepoError) throw new Error(options.resolveRepoError);
      return { id: 'repo-1', name: 'fixture', repoPath: '/repo/fixture' };
    }),
    ensureRepoInitialized: vi.fn(async () => undefined),
  };

  createMCPServer(backend as any);
  const handler = setRequestHandlerSpy.mock.calls.find(
    ([schema]) => schema === CallToolRequestSchema,
  )?.[1] as ToolCallHandler | undefined;

  expect(handler).toBeDefined();
  return { backend, handler: handler as ToolCallHandler };
}

async function createPublicHandlers(): Promise<{ backend: MockBackend; call: ToolCallHandler; list: () => Promise<any> }> {
  vi.resetModules();
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  vi.doMock('../../src/mcp/super/dispatch.js', () => ({
    dispatchSuper: vi.fn(async () => ({
      status: 'ok', summary: 'retained', topSymbols: ['x'.repeat(1000)],
    })),
  }));
  const setHandler = vi.spyOn(Server.prototype, 'setRequestHandler');
  const { createMCPServer } = await import('../../src/mcp/server.js');
  const backend: MockBackend = {
    callTool: vi.fn(async () => ({ ok: true })),
    resolveRepo: vi.fn(async () => ({ id: 'repo-1', name: 'fixture', repoPath: '/repo/fixture' })),
    ensureRepoInitialized: vi.fn(async () => undefined),
  };
  createMCPServer(backend as any);
  const call = setHandler.mock.calls.find(([schema]) => schema === CallToolRequestSchema)?.[1] as ToolCallHandler;
  const list = setHandler.mock.calls.find(([schema]) => schema === ListToolsRequestSchema)?.[1] as () => Promise<any>;
  return { backend, call, list };
}

function readErrorPayload(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../../src/mcp/super/dispatch.js');
});

describe('MCP server tool-call errors', () => {
  it('advertises the optional budget and rejects invalid values before backend dispatch', async () => {
    const { backend, call, list } = await createPublicHandlers();
    const tools = await list();
    const explore = tools.tools.find((entry: any) => entry.name === 'gn_explore');
    expect(explore.inputSchema.properties.response_budget_bytes).toMatchObject({ type: 'integer' });
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
      const response = await call({ params: { name: 'list_repos', arguments: { response_budget_bytes: value } } });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('positive safe integer');
    }
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('applies an explicit logical budget at the public handler', async () => {
    const { backend, call } = await createPublicHandlers();
    const response = await call({ params: { name: 'gn_explore', arguments: { query: 'x', response_budget_bytes: 700 } } });
    const payload = JSON.parse(response.content[0].text);
    expect(backend.callTool).not.toHaveBeenCalled();
    expect(payload.summary).toBe('retained');
    expect(payload.topSymbols).toBeUndefined();
    expect(payload.responseBudget).toMatchObject({ requestedBytes: 700, truncated: true });
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(700);
  });


  it('bounds large multibyte scoped errors and preserves identity', async () => {
    const { handler } = await createHarness({ dispatchError: '\u{1f600}\n"'.repeat(50000) });
    const response = await handler({
      params: { name: 'gn_explore', arguments: { repo: 'fixture' } },
    });
    expect(response.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(48 * 1024);
    expect(readErrorPayload(response.content[0].text)).toMatchObject({
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
    });
    expect(response.content[0].text).toContain('[truncated]');
    expect(response.content[0].text).not.toContain('\uFFFD');
  });

  it('bounds large global errors even when request arguments are huge', async () => {
    const { handler } = await createHarness({ callToolError: 'x'.repeat(200000) });
    const response = await handler({
      params: { name: 'list_repos', arguments: { unused: 'x'.repeat(200000) } },
    });
    expect(response.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(48 * 1024);
    expect(response.content[0].text).toContain('[truncated]');
  });

  it('returns bounded errors when response paging itself fails', async () => {
    const { handler } = await createHarness();
    const response = await handler({
      params: { name: 'list_repos', arguments: { response_cursor: 'invalid' } },
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Invalid response cursor.');
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(48 * 1024);
  });

  it('includes repo identity when a repo-scoped super tool throws after resolution', async () => {
    const { handler, backend } = await createHarness({ dispatchError: 'dispatch failed' });

    const response = await handler({
      params: { name: 'gn_explore', arguments: { repo: 'fixture' } },
    });

    expect(backend.resolveRepo).toHaveBeenCalledWith('fixture');
    expect(response.isError).toBe(true);
    expect(readErrorPayload(response.content[0].text)).toMatchObject({
      error: 'dispatch failed',
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
    });
  });

  it('includes repo identity when a repo-scoped facade throws after resolution', async () => {
    const { handler, backend } = await createHarness({ dispatchError: 'dispatch failed' });

    const response = await handler({
      params: { name: 'audit', arguments: { action: 'session_start', repo: 'fixture' } },
    });

    expect(backend.resolveRepo).toHaveBeenCalledWith('fixture');
    expect(response.isError).toBe(true);
    expect(readErrorPayload(response.content[0].text)).toMatchObject({
      error: 'dispatch failed',
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
    });
  });

  it('keeps repo resolution errors actionable and unscoped', async () => {
    const { handler } = await createHarness({
      resolveRepoError: 'Repository "missing" not found.\nRetry:\n  repo: "fixture"',
    });

    const response = await handler({
      params: { name: 'gn_explore', arguments: { repo: 'missing' } },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Repository "missing" not found.');
    expect(response.content[0].text).toContain('Retry:');
    expect(response.content[0].text).not.toContain('repoLabel');
  });

  it('keeps global tool errors free of repo identity', async () => {
    const { handler } = await createHarness({ callToolError: 'global failed' });

    const response = await handler({
      params: { name: 'list_repos', arguments: {} },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toBe('Error: global failed');
  });
});
