import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../../src/mcp/super/dispatch.js');
});

describe('trusted MCP diagnostic project context', () => {
  it.each([
    [{ projectCwd: '/startup/project' }, '/startup/project'],
    [{ transport: 'http' }, null],
    [{}, null],
  ] as const)('passes service context from options %j', async (options, projectCwd) => {
    vi.resetModules();
    const dispatchSuper = vi.fn().mockResolvedValue({ misconfiguration: { status: 'ok' } });
    vi.doMock('../../src/mcp/super/dispatch.js', () => ({ dispatchSuper }));
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const handlers = vi.spyOn(Server.prototype, 'setRequestHandler');
    const { createMCPServer } = await import('../../src/mcp/server.js');
    createMCPServer(
      {
        resolveRepo: vi.fn().mockResolvedValue({
          id: 'repo-1',
          name: 'requested',
          repoPath: '/requested/repo',
        }),
      } as any,
      options,
    );
    const handler = handlers.mock.calls.find(
      ([schema]) => schema === CallToolRequestSchema,
    )?.[1] as any;
    const args = { repo: 'requested', projectCwd: '/spoofed/project' };
    await handler({ params: { name: 'gn_diagnose', arguments: args } });
    expect(dispatchSuper).toHaveBeenCalledWith('gn_diagnose', args, 'repo-1', undefined, {
      repoPath: '/requested/repo',
      projectCwd,
    });
  });
});
