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

async function createHarness(options: {
  callToolError?: string;
  dispatchError?: string;
  resolveRepoError?: string;
} = {}): Promise<{ backend: MockBackend; handler: ToolCallHandler }> {
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

function readErrorPayload(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../../src/mcp/super/dispatch.js');
});

describe('MCP server tool-call errors', () => {
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
