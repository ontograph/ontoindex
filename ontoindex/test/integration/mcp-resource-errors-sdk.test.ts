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
          required: true,
        }),
      ]);
      expect(report.warnings).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
