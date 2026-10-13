import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { MCP_RESPONSE_MAX_BYTES } from '../../src/mcp/shared/response-pages.js';

afterEach(() => vi.restoreAllMocks());

async function fixture(backend: Record<string, unknown>) {
  const server = createMCPServer(backend as any);
  const client = new Client({ name: 'resource-regression', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const responses: unknown[] = [];
  const send = serverTransport.send.bind(serverTransport);
  vi.spyOn(serverTransport, 'send').mockImplementation(async (message, options) => {
    responses.push(message);
    await send(message, options);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, responses, close: async () => { await client.close(); await server.close(); } };
}

describe('MCP resource protocol errors through the SDK', () => {
  it.each([
    ['unknown://resource', ErrorCode.InvalidParams],
    ['ontoindex://repo/%ZZ/context', ErrorCode.InvalidParams],
    ['ontoindex://repo/fixture/unsupported', -32002],
    [`unknown://${'🔒'.repeat(100000)}`, ErrorCode.InvalidParams],
  ])('rejects resource read case %# with protocol code %i', async (uri, code) => {
    const f = await fixture({});
    try {
      const error = await f.client.readResource({ uri }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({ code });
      const wire = f.responses.find((response: any) => response.error) as any;
      expect(wire.error.code).toBe(code);
      expect(wire.result).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(wire), 'utf8')).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    } finally { await f.close(); }
  });

  it('keeps backend exceptions private and preserves successful reads', async () => {
    const listRepos = vi.fn().mockResolvedValue([]);
    const f = await fixture({ listRepos });
    try {
      expect((await f.client.readResource({ uri: 'ontoindex://repos' })).contents).toHaveLength(1);
      listRepos.mockRejectedValue(new Error('secret backend detail'));
      const error = await f.client.readResource({ uri: 'ontoindex://repos' }).catch((err: unknown) => err);
      expect(error).toMatchObject({ code: ErrorCode.InternalError });
      expect((error as Error).message).toContain('Resource read failed.');
      expect(JSON.stringify(f.responses)).not.toContain('secret backend detail');
    } finally { await f.close(); }
  });
});
