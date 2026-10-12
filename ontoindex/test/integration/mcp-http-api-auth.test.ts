import express from 'express';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from '../../src/server/api.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

vi.mock('../../src/server/analyze-job.js', () => ({
  JobManager: class {
    async init() {}
    async dispose() {}
  },
}));

let server: Server | undefined;
let client: Client | undefined;
const signals = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, process.listeners(signal)]));

afterEach(async () => {
  try {
    await client?.close();
    server?.closeAllConnections();
    if (server?.listening)
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
  } finally {
    for (const [signal, original] of signals) {
      for (const listener of process.listeners(signal)) {
        if (!original.includes(listener)) process.removeListener(signal, listener);
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it('authenticates a real SDK MCP exchange through createServer middleware', async () => {
  vi.stubEnv('ONTOINDEX_HTTP_TOKEN', 'mcp-api-test-token');
  vi.spyOn(LocalBackend.prototype, 'init').mockResolvedValue(false);
  const listen = express.application.listen;
  vi.spyOn(express.application, 'listen').mockImplementation(function (...args: unknown[]) {
    server = Reflect.apply(listen, this, args) as Server;
    return server;
  } as typeof listen);
  await createServer(0);
  const address = server!.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const url = new URL(`http://127.0.0.1:${address.port}/api/mcp`);
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  };
  const rejected = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(5000),
  });
  expect(rejected.status).toBe(401);
  await rejected.text();
  client = new Client({ name: 'auth-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: 'Bearer mcp-api-test-token' } },
  });
  await client.connect(transport);
  const listed = await client.listTools();
  expect(listed.tools.some((tool) => tool.name === 'gn_explore')).toBe(true);
  await transport.terminateSession();
});
