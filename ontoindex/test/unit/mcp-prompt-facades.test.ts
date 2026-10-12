import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMCPServer } from '../../src/mcp/server.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../../src/mcp/shared/response-pages.js');
});

function getPromptHandler(): (request: any, extra?: unknown) => Promise<any> {
  const spy = vi.spyOn(Server.prototype, 'setRequestHandler');
  createMCPServer({} as any);
  const handler = spy.mock.calls.find(([schema]) => schema === GetPromptRequestSchema)?.[1];
  expect(handler).toBeDefined();
  return handler as (request: any, extra?: unknown) => Promise<any>;
}

describe('MCP impact prompt', () => {
  it('uses public facades with required actions and preserves diff arguments', async () => {
    const handler = getPromptHandler();
    const result = await handler({
      params: { name: 'detect_impact', arguments: { scope: 'compare', base_ref: 'main' } },
    });
    const text = result.messages[0].content.text;
    expect(text).toContain('impact({"action":"diff","scope":"compare","base_ref":"main"})');
    expect(text).toContain('inspect({action: "context", name: "<symbol>"})');
    expect(text).toContain('impact({action: "symbol", target: "<symbol>", direction: "upstream"})');
    expect(text).not.toContain('detect_changes(');
  });

  it('rejects non-string arguments and unsupported impact scopes', async () => {
    const handler = getPromptHandler();
    await expect(
      handler({
        params: { name: 'detect_impact', arguments: { scope: 42 } },
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('Invalid prompt argument.'),
    });
    await expect(
      handler({
        params: { name: 'detect_impact', arguments: { scope: 'branch' } },
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('Invalid impact scope.'),
    });
  });

  it('caps prompt arguments by UTF-8 bytes', async () => {
    const handler = getPromptHandler();
    const accepted = await handler({
      params: { name: 'generate_map', arguments: { repo: '😀'.repeat(1024) } },
    });
    expect(accepted.messages[0].content.text).toContain('😀'.repeat(1024));
    await expect(
      handler({
        params: { name: 'generate_map', arguments: { repo: '😀'.repeat(1025) } },
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('Invalid prompt argument.'),
    });
  });

  it('bounds the complete serialized prompt response', async () => {
    vi.resetModules();
    vi.doMock('../../src/mcp/shared/response-pages.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/mcp/shared/response-pages.js')>()),
      MCP_RESPONSE_MAX_BYTES: 256,
    }));
    const { Server: FreshServer } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { GetPromptRequestSchema: FreshPromptSchema } =
      await import('@modelcontextprotocol/sdk/types.js');
    const { createMCPServer: createFreshServer } = await import('../../src/mcp/server.js');
    const spy = vi.spyOn(FreshServer.prototype, 'setRequestHandler');
    createFreshServer({} as any);
    const handler = spy.mock.calls.find(([schema]) => schema === FreshPromptSchema)?.[1] as
      | ((request: any) => Promise<any>)
      | undefined;

    await expect(
      handler!({ params: { name: 'generate_map', arguments: { repo: 'repo' } } }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('Prompt response exceeded the byte limit.'),
    });
  });
});
