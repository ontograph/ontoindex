import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import {
  MCP_RESPONSE_MAX_BYTES,
  type ResponsePageEnvelope,
} from '../../src/mcp/shared/response-pages.js';

afterEach(() => vi.restoreAllMocks());

async function fixture(backend: object) {
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
  return {
    client,
    responses,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
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
      expect(Buffer.byteLength(JSON.stringify(wire), 'utf8')).toBeLessThanOrEqual(
        MCP_RESPONSE_MAX_BYTES,
      );
    } finally {
      await f.close();
    }
  });

  it('keeps backend exceptions private and preserves successful reads', async () => {
    const listRepos = vi.fn().mockResolvedValue([]);
    const f = await fixture({ listRepos });
    try {
      expect((await f.client.readResource({ uri: 'ontoindex://repos' })).contents).toHaveLength(1);
      listRepos.mockRejectedValue(new Error('secret backend detail'));
      const error = await f.client
        .readResource({ uri: 'ontoindex://repos' })
        .catch((err: unknown) => err);
      expect(error).toMatchObject({ code: ErrorCode.InternalError });
      expect((error as Error).message).toContain('Resource read failed.');
      expect(JSON.stringify(f.responses)).not.toContain('secret backend detail');
    } finally {
      await f.close();
    }
  });
});

describe('MCP facade argument errors through the SDK', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['missing action', {}, 'action'],
    ['unknown action', { action: 'unknown' }, 'action'],
    ['null lock selector', { action: 'session_lock', lock_action: null }, 'lock_action'],
    ['empty lock selector', { action: 'session_lock', lock_action: '' }, 'lock_action'],
    ['unknown lock selector', { action: 'session_lock', lock_action: 'delete' }, 'lock_action'],
    ['numeric lock selector', { action: 'session_lock', lock_action: 1 }, 'lock_action'],
  ])('returns a tool error for %s before backend access', async (_label, args, errorText) => {
    const backend = new LocalBackend();
    const resolveRepo = vi.spyOn(backend, 'resolveRepo');
    const callTool = vi.spyOn(backend, 'callTool');
    const f = await fixture(backend);
    try {
      const response = await f.client.callTool({ name: 'audit', arguments: args });
      expect(response.isError).toBe(true);
      expect(response.content).toEqual([
        { type: 'text', text: expect.stringContaining(errorText) },
      ]);
      const wire = f.responses.find((message: any) => message.result?.isError) as any;
      expect(wire).toBeDefined();
      expect(wire.result).toMatchObject({ isError: true, content: response.content });
      expect(wire.error).toBeUndefined();
      expect(resolveRepo).not.toHaveBeenCalled();
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});

describe('MCP startup profile discovery through the SDK', () => {
  it('captures the startup tool/schema snapshot and validates hidden-call arguments before backend access', async () => {
    const originalProfile = process.env.ONTOINDEX_MCP_STARTUP_PROFILE;
    const backend = new LocalBackend();
    const resolveRepo = vi.spyOn(backend, 'resolveRepo');
    const callTool = vi.spyOn(backend, 'callTool');
    const ensureRepoInitialized = vi.spyOn(backend, 'ensureRepoInitialized');
    let core: Awaited<ReturnType<typeof fixture>> | undefined;
    let full: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      process.env.ONTOINDEX_MCP_STARTUP_PROFILE = 'core';
      core = await fixture(backend);
      const originalTools = await core.client.listTools();
      expect(originalTools.tools).toHaveLength(8);
      expect(originalTools.tools.some((tool) => tool.name.startsWith('gn_'))).toBe(false);
      for (const name of ['gn_help', 'gn_tool_contract']) {
        const result = await core.client.callTool({ name, arguments: { includeFacades: true } });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text?: string }>;
        const report = JSON.parse(content[0].text!.split('\n\n---')[0]);
        expect(report.startupProfile.advertisedCount).toBe(8);
        expect(report.startupProfile.hiddenButCallableCount).toBe(54);
        expect(report.startupProfile.hiddenButCallable).toContain(name);
      }
      expect(originalTools.tools.find((tool) => tool.name === 'refactor')).toMatchObject({
        inputSchema: {
          properties: { action: { enum: expect.arrayContaining(['safe_refactor']) } },
        },
      });
      expect(originalTools.tools.map((tool) => tool.name)).not.toContain('gn_safe_refactor');

      // The server rejects the response budget before repository resolution or operation dispatch.
      const response = await core.client.callTool({
        name: 'gn_safe_refactor',
        arguments: { intent: 'rename', params: {}, response_budget_bytes: -1 },
      });
      expect(response.isError).toBe(true);
      expect(response.content).toEqual([
        { type: 'text', text: 'Error: response_budget_bytes must be a positive safe integer.' },
      ]);
      expect(resolveRepo).not.toHaveBeenCalled();
      expect(callTool).not.toHaveBeenCalled();
      expect(ensureRepoInitialized).not.toHaveBeenCalled();

      process.env.ONTOINDEX_MCP_STARTUP_PROFILE = 'public-full';
      full = await fixture(backend);
      expect((await full.client.listTools()).tools.map((tool) => tool.name)).toContain(
        'gn_safe_refactor',
      );
      expect(await core.client.listTools()).toEqual(originalTools);
    } finally {
      try {
        const cleanup = await Promise.allSettled([core?.close(), full?.close()]);
        for (const result of cleanup) {
          if (result.status === 'rejected') throw result.reason;
        }
      } finally {
        if (originalProfile === undefined) delete process.env.ONTOINDEX_MCP_STARTUP_PROFILE;
        else process.env.ONTOINDEX_MCP_STARTUP_PROFILE = originalProfile;
      }
    }
  });
});

describe('MCP context cursor transport through the SDK', () => {
  it.each(['context', 'inspect'])(
    '%s preserves pages and rejects changed cursor requests',
    async (name) => {
      const originalResultDir = process.env.ONTOINDEX_MCP_RESULT_DIR;
      const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-sdk-pages-'));
      process.env.ONTOINDEX_MCP_RESULT_DIR = resultDir;
      // Stubbed results exercise route/transport parity, not indexed graph semantics.
      const identity = { repoLabel: 'fixture', repoPath: '/repo/fixture' };
      const payload = { ...identity, result: { source: '🔒λ'.repeat(10_000) } };
      const expectedText = JSON.stringify(payload, null, 2);
      const callTool = vi.fn().mockResolvedValue(payload);
      const resolveRepo = vi.fn();
      const f = await fixture({ callTool, resolveRepo });
      try {
        const args = {
          repo: 'fixture',
          name: 'symbol',
          response_budget_bytes: 100_000,
          ...(name === 'inspect' ? { action: 'context' } : {}),
        };
        const first = await f.client.callTool({ name, arguments: args });
        expect(first.isError).not.toBe(true);
        expect(callTool).toHaveBeenCalledTimes(1);
        expect(callTool).toHaveBeenCalledWith('context', expect.objectContaining(args));
        const firstPage = JSON.parse(
          (first.content as Array<{ text: string }>)[0].text,
        ) as ResponsePageEnvelope;
        expect(firstPage.responsePage.nextCursor).toBeDefined();
        const cursor = firstPage.responsePage.nextCursor!;
        const chunks: string[] = [];
        let page = firstPage;
        let offset = 0;
        for (let pages = 0; pages < 10; pages++) {
          expect(page.truncated).toBe(true);
          expect(page.responsePage).toMatchObject({
            version: 1,
            encoding: 'utf8-json-text',
            offset,
            identity,
            totalBytes: Buffer.byteLength(expectedText, 'utf8'),
            sha256: createHash('sha256').update(expectedText).digest('hex'),
          });
          expect(page.responsePage.returnedBytes).toBe(Buffer.byteLength(page.chunk, 'utf8'));
          expect(page.responsePage.returnedBytes).toBeGreaterThan(0);
          chunks.push(page.chunk);
          offset += page.responsePage.returnedBytes;
          if (!page.responsePage.nextCursor) break;
          const response = await f.client.callTool({
            name,
            arguments: { ...args, response_cursor: page.responsePage.nextCursor },
          });
          expect(response.isError).not.toBe(true);
          page = JSON.parse((response.content as Array<{ text: string }>)[0].text);
        }
        expect(page.responsePage.nextCursor).toBeUndefined();
        expect(chunks.join('')).toBe(expectedText);
        const replay = await f.client.callTool({
          name,
          arguments: { ...args, response_cursor: cursor },
        });
        expect(replay.isError).not.toBe(true);
        expect(JSON.parse((replay.content as Array<{ text: string }>)[0].text).chunk).toBe(
          chunks[1],
        );
        for (const changed of [
          { name, arguments: { ...args, repo: 'other', response_cursor: cursor } },
          { name, arguments: { ...args, name: 'other', response_cursor: cursor } },
          {
            name: name === 'context' ? 'inspect' : 'context',
            arguments: { ...args, action: 'context', response_cursor: cursor },
          },
          ...(name === 'inspect'
            ? [{ name, arguments: { ...args, read_mode: 'committed', response_cursor: cursor } }]
            : []),
        ]) {
          expect((await f.client.callTool(changed)).isError).toBe(true);
          expect(callTool).toHaveBeenCalledTimes(1);
          expect(resolveRepo).not.toHaveBeenCalled();
        }
        const wireResults = f.responses.filter((message: any) => message.result) as any[];
        for (const message of wireResults) {
          expect(Buffer.byteLength(JSON.stringify(message.result), 'utf8')).toBeLessThanOrEqual(
            MCP_RESPONSE_MAX_BYTES,
          );
        }
      } finally {
        await f.close();
        if (originalResultDir === undefined) delete process.env.ONTOINDEX_MCP_RESULT_DIR;
        else process.env.ONTOINDEX_MCP_RESULT_DIR = originalResultDir;
        await fs.rm(resultDir, { recursive: true, force: true });
      }
    },
  );
});

describe('systems audit arguments through the SDK', () => {
  it('preserves equivalent fault simulation results for target and targetCall', async () => {
    const f = await fixture({
      resolveRepo: vi.fn().mockResolvedValue({ id: 'fixture', name: 'fixture', repoPath: '.' }),
    });
    try {
      const args = {
        sourceText: `
          int fd = pidfd_open(pid, 0);
          if (fd == -1) { return; }
          state = ready;
        `,
        returnValue: '-1',
      };
      const reports = [];
      for (const alias of ['target', 'targetCall']) {
        const response = await f.client.callTool({
          name: 'gn_simulate_fault',
          arguments: { ...args, [alias]: 'pidfd_open' },
        });
        expect(response.isError).not.toBe(true);
        const content = response.content as Array<{ type: string; text: string }>;
        const report = JSON.parse(content[0].text.split('\n\n---\n')[0]);
        expect(report).toMatchObject({
          analyzerId: 'gn_simulate_fault',
          targetCall: 'pidfd_open',
          returnValue: '-1',
          targetResultSymbols: ['fd'],
        });
        expect(report.earlyReturns.length).toBeGreaterThan(0);
        reports.push(report);
      }
      expect(reports[0]).toEqual(reports[1]);
    } finally {
      await f.close();
    }
  });

  it('reports unresolved boundary evidence for a resource and start without facts', async () => {
    const f = await fixture({
      resolveRepo: vi.fn().mockResolvedValue({ id: 'fixture', name: 'fixture', repoPath: '.' }),
    });
    try {
      const response = await f.client.callTool({
        name: 'gn_trace_boundary',
        arguments: { resource: 'fd:handoff', start: 'p1', facts: [] },
      });
      expect(response.isError).not.toBe(true);
      const content = response.content as Array<{ type: string; text: string }>;
      const report = JSON.parse(content[0].text.split('\n\n---\n')[0]);
      expect(report).toMatchObject({
        tool: 'gn_trace_boundary',
        status: 'unresolved',
        segments: [],
        systemsEvidence: [],
        findings: [],
      });
      expect(report.skipReasons).toContain('no-matching-boundary-evidence');
    } finally {
      await f.close();
    }
  });

  it('reuses the supplied evidence testFile for test suggestions', async () => {
    const f = await fixture({
      resolveRepo: vi.fn().mockResolvedValue({ id: 'fixture', name: 'fixture', repoPath: '.' }),
    });
    try {
      const response = await f.client.callTool({
        name: 'gn_test_suggestions',
        arguments: {
          symbol: 'SidecarManager::_spawn',
          risk: 'fd-leak-across-fork',
          targetedCoverage: 'found',
          evidence: [{ testFile: 'test/from-target-report.test.ts' }],
        },
      });
      expect(response.isError).not.toBe(true);
      const content = response.content as Array<{ type: string; text: string }>;
      const report = JSON.parse(content[0].text.split('\n\n---\n')[0]);
      expect(report.suggestions).toEqual([
        expect.objectContaining({
          file: 'test/from-target-report.test.ts',
          target: 'SidecarManager::_spawn',
          case: expect.stringContaining('fd_leak_across_fork'),
          required: false,
        }),
      ]);
      expect(report.warnings).toEqual([
        'Suggestions are advisory; supplied test paths and coverage are not independently verified.',
      ]);
    } finally {
      await f.close();
    }
  });
});
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
