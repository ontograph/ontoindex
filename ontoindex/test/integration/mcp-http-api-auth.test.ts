import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
let groupHome: string | undefined;
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
    if (groupHome) rmSync(groupHome, { recursive: true, force: true });
    groupHome = undefined;
  }
});

it('preserves allowlisted group member provenance over the SDK HTTP transport', async () => {
  vi.stubEnv('ONTOINDEX_HTTP_TOKEN', 'mcp-api-test-token');
  vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
  groupHome = mkdtempSync(join(tmpdir(), 'ontoindex-mcp-group-'));
  const groupDir = join(groupHome, 'groups', 'g1');
  mkdirSync(groupDir, { recursive: true });
  writeFileSync(
    join(groupDir, 'group.yaml'),
    `version: 1
name: g1
repos:
  app/backend: test-backend
  app/frontend: test-frontend
`,
  );
  vi.stubEnv('ONTOINDEX_HOME', groupHome);
  vi.spyOn(LocalBackend.prototype, 'init').mockResolvedValue(false);
  vi.spyOn(LocalBackend.prototype, 'resolveRepo').mockImplementation(
    async (name) =>
      ({
        id: name!,
        name: name!,
        repoPath: `/fixture/${name}`,
        storagePath: `/fixture/${name}/.ontoindex`,
      }) as Awaited<ReturnType<LocalBackend['resolveRepo']>>,
  );

  const metadata = (name: string) => ({
    targetContext: { repo: name, generation: `${name}-generation` },
    freshness: { status: name === 'test-backend' ? 'fresh' : 'stale' },
    repoLabel: name,
    repoPath: `/fixture/${name}`,
    capabilitiesUsed: [`${name}-symbols`],
    capabilitiesMissing: [`${name}-processes`],
  });
  // Mock only the analysis producer boundary; dispatch and GroupService remain real.
  type MemberProducer = {
    query(repo: { id: string }, params: Record<string, unknown>): Promise<unknown>;
    context(repo: { id: string }, params: Record<string, unknown>): Promise<unknown>;
  };
  const producers = LocalBackend.prototype as unknown as MemberProducer;
  const query = vi.spyOn(producers, 'query').mockImplementation(async (repo) => ({
    ...metadata(repo.id),
    processes: [{ id: `${repo.id}-first` }, { id: `${repo.id}-second` }],
    process_symbols: [{ id: 'private-symbol' }],
    definitions: [{ name: 'private-definition' }],
    enrichment: { used: true, facts: ['private-fact'] },
    unrelated: 'private-query-field',
  }));
  const contextPayload = (name: string) => ({
    ...metadata(name),
    status: 'found',
    symbol: {
      name: 'Login',
      filePath: name === 'test-backend' ? 'services/billing/login.ts' : 'services/auth/login.ts',
    },
    incoming: [{ name: 'caller' }],
    enrichment: { used: true, facts: [`${name}-fact`] },
    unrelated: `${name}-private-context-field`,
  });
  vi.spyOn(producers, 'context').mockImplementation(async (repo) => contextPayload(repo.id));

  const listen = express.application.listen;
  vi.spyOn(express.application, 'listen').mockImplementation(function (...args: unknown[]) {
    server = Reflect.apply(listen, this, args) as Server;
    return server;
  } as typeof listen);
  await createServer(0);
  const address = server!.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  client = new Client({ name: 'group-provenance-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/api/mcp`),
    { requestInit: { headers: { Authorization: 'Bearer mcp-api-test-token' } } },
  );
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client!.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].type).toBe('text');
    return JSON.parse(content[0].text!.split('\n\n---')[0]);
  };
  const flags = {
    consume_enrichment_facts: true,
    include_passive_related_facts: true,
    include_markdown_context: true,
    include_markdown_ppr: true,
    allow_low_confidence: true,
    retrieval_policy: 'graph-with-passive-docs',
  };
  const enriched = await call('search', {
    action: 'semantic',
    repo: '@g1',
    query: 'login',
    ...flags,
  });
  expect(query).toHaveBeenCalledTimes(2);
  for (const [, params] of query.mock.calls) expect(params).toEqual(expect.objectContaining(flags));
  query.mockClear();
  const control = await call('search', { action: 'semantic', repo: '@g1', query: 'login' });
  expect(query).toHaveBeenCalledTimes(2);
  for (const [, params] of query.mock.calls) {
    for (const flag of Object.keys(flags)) expect(params).not.toHaveProperty(flag);
  }
  const expectedResults = [
    { id: 'test-backend-first', _repo: 'app/backend', _rrf_score: 1 / 61 },
    { id: 'test-frontend-first', _repo: 'app/frontend', _rrf_score: 1 / 61 },
    { id: 'test-backend-second', _repo: 'app/backend', _rrf_score: 1 / 62 },
    { id: 'test-frontend-second', _repo: 'app/frontend', _rrf_score: 1 / 62 },
  ];
  expect(enriched).toEqual({
    group: 'g1',
    query: 'login',
    results: expectedResults,
    per_repo: [
      { repo: 'app/backend', count: 2, ...metadata('test-backend') },
      { repo: 'app/frontend', count: 2, ...metadata('test-frontend') },
    ],
  });
  expect(control).toEqual(enriched);
  const context = await call('inspect', {
    action: 'context',
    repo: '@g1',
    name: 'Login',
    service: 'services/auth',
  });
  expect(context).toEqual({
    group: 'g1',
    target: 'Login',
    service: 'services/auth',
    results: [
      { repoPath: 'app/backend', registryName: 'test-backend', payload: metadata('test-backend') },
      {
        repoPath: 'app/frontend',
        registryName: 'test-frontend',
        payload: contextPayload('test-frontend'),
      },
    ],
  });
  await transport.terminateSession();
});

it('authenticates a real SDK MCP exchange through createServer middleware', async () => {
  vi.stubEnv('ONTOINDEX_HTTP_TOKEN', 'mcp-api-test-token');
  vi.stubEnv('ONTOINDEX_MCP_STARTUP_PROFILE', 'public-full');
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
  const contractResult = await client.callTool({
    name: 'gn_tool_contract',
    arguments: { includeFacades: true },
  });
  expect(contractResult.isError).not.toBe(true);
  const contractContent = contractResult.content as Array<{ type: string; text?: string }>;
  expect(contractContent[0].type).toBe('text');
  const contract = JSON.parse(contractContent[0].text!.split('\n\n---')[0]);
  expect(contract.version).toBe(1);
  expect(contract.callable).toEqual(expect.arrayContaining(['discover', 'gn_tool_contract']));

  const discoveryResult = await client.callTool({
    name: 'discover',
    arguments: { action: 'tools' },
  });
  expect(discoveryResult.isError).not.toBe(true);
  const discoveryContent = discoveryResult.content as Array<{ type: string; text?: string }>;
  expect(discoveryContent[0].type).toBe('text');
  const discovery = JSON.parse(discoveryContent[0].text!.split('\n\n---')[0]);
  expect(discovery.source).toBe('mcp-frontier');
  expect(discovery.tools.map((tool: { name: string }) => tool.name)).toEqual(
    expect.arrayContaining(['search', 'inspect', 'impact']),
  );
  await transport.terminateSession();
});
