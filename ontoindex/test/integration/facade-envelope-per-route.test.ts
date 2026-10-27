import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { ONTOINDEX_FACADE_TOOLS } from '../../src/mcp/facade/tool-definitions.js';
import {
  MCP_RESPONSE_MAX_BYTES,
  type ResponsePageEnvelope,
} from '../../src/mcp/shared/response-pages.js';

const routes: Record<string, { method: string; args: Record<string, unknown> }> = {
  discover: { method: 'list_repos', args: { action: 'repos' } },
  search: { method: 'query', args: { action: 'semantic', query: 'symbol' } },
  inspect: { method: 'context', args: { action: 'context', name: 'symbol' } },
  impact: { method: 'impact', args: { action: 'symbol', target: 'symbol' } },
  audit: { method: 'audit_report', args: { action: 'report' } },
  refactor: { method: 'sandbox', args: { action: 'sandbox', operation: 'stage' } },
  manage: {
    method: 'session',
    args: { action: 'session', operation: 'list', session_id: 'fixture' },
  },
  docs: { method: 'docs', args: { action: 'context' } },
};

let resultDir: string;

beforeEach(async () => {
  resultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-facade-pages-'));
  vi.stubEnv('ONTOINDEX_MCP_RESULT_DIR', resultDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(resultDir, { recursive: true, force: true });
});

async function fixture(backend: object) {
  const server = createMCPServer(backend as any);
  const client = new Client({ name: 'facade-envelope-regression', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const responses: any[] = [];
  const send = serverTransport.send.bind(serverTransport);
  vi.spyOn(serverTransport, 'send').mockImplementation(async (message, options) => {
    responses.push(message);
    await send(message, options);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    responses,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe.each(ONTOINDEX_FACADE_TOOLS.map((tool) => tool.name))('%s facade MCP envelope', (name) => {
  it('pages a budgeted success and replays the same cursor chunk', async () => {
    // Exercise facade routing and transport, without claiming graph or database semantics.
    const payload = { result: { source: 'x'.repeat(100_000) } };
    const text = JSON.stringify(payload, null, 2);
    const callTool = vi.fn().mockResolvedValue(payload);
    const f = await fixture({ callTool });
    try {
      const route = routes[name];
      expect(route).toBeDefined();
      const args = { ...route.args, response_budget_bytes: 150_000 };
      const first = await f.client.callTool({ name, arguments: args });
      expect(first.isError).not.toBe(true);
      const firstPage = JSON.parse(
        (first.content as Array<{ text: string }>)[0].text,
      ) as ResponsePageEnvelope;
      expect(firstPage.truncated).toBe(true);
      expect(firstPage.responsePage).toMatchObject({
        version: 1,
        encoding: 'utf8-json-text',
        offset: 0,
        nextCursor: expect.any(String),
        totalBytes: Buffer.byteLength(text, 'utf8'),
        sha256: createHash('sha256').update(text).digest('hex'),
      });
      expect(firstPage.chunk.length).toBeGreaterThan(0);
      const request = {
        name,
        arguments: { ...args, response_cursor: firstPage.responsePage.nextCursor! },
      };
      const next = await f.client.callTool(request);
      const replay = await f.client.callTool(request);
      expect(next.isError).not.toBe(true);
      expect(replay).toEqual(next);
      const nextPage = JSON.parse(
        (next.content as Array<{ text: string }>)[0].text,
      ) as ResponsePageEnvelope;
      expect(nextPage.responsePage.offset).toBe(firstPage.responsePage.returnedBytes);
      expect(nextPage.responsePage.sha256).toBe(firstPage.responsePage.sha256);
      expect(nextPage.chunk).toBe(
        text.slice(
          nextPage.responsePage.offset,
          nextPage.responsePage.offset + nextPage.responsePage.returnedBytes,
        ),
      );
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledWith(
        route.method,
        expect.objectContaining({ response_budget_bytes: args.response_budget_bytes }),
      );
      for (const message of f.responses.filter((message) => message.result?.content)) {
        expect(message.error).toBeUndefined();
        expect(Buffer.byteLength(JSON.stringify(message.result), 'utf8')).toBeLessThanOrEqual(
          MCP_RESPONSE_MAX_BYTES,
        );
      }
    } finally {
      await f.close();
    }
  });

  it('returns invalid facade arguments as a tool error without dispatching', async () => {
    const callTool = vi.fn();
    const f = await fixture({ callTool });
    try {
      const response = await f.client.callTool({ name, arguments: { action: 'invalid-action' } });
      expect(response.isError).toBe(true);
      expect(response.content).toEqual([
        { type: 'text', text: expect.stringContaining('Unknown facade action') },
      ]);
      expect(callTool).not.toHaveBeenCalled();
      const wire = f.responses.find((message) => message.result?.isError);
      expect(wire).toBeDefined();
      expect(wire.result).toMatchObject({ isError: true, content: response.content });
      expect(wire.error).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it('returns a throwing backend as a tool error without a JSON-RPC error', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('fixture backend failed'));
    const f = await fixture({ callTool });
    try {
      const response = await f.client.callTool({ name, arguments: routes[name].args });
      expect(response.isError).toBe(true);
      expect(response.content).toEqual([
        { type: 'text', text: expect.stringContaining('fixture backend failed') },
      ]);
      expect(callTool).toHaveBeenCalledTimes(1);
      const wire = f.responses.find((message) => message.result?.isError);
      expect(wire).toBeDefined();
      expect(wire.result).toMatchObject({ isError: true, content: response.content });
      expect(wire.error).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});
