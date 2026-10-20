import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock('../../src/mcp/super/dispatch.js');
});

describe('MCP graph-walk initialization', () => {
  it.each([false, true])(
    'prepares lazy graph reads before dispatch (failure: %s)',
    async (fail) => {
      vi.resetModules();
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
      const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
      const events: string[] = [];
      const dispatchSuper = vi.fn(async () => {
        events.push('dispatch');
        return { walkId: 'prepared-walk' };
      });
      vi.doMock('../../src/mcp/super/dispatch.js', () => ({ dispatchSuper }));
      const handlerSpy = vi.spyOn(Server.prototype, 'setRequestHandler');
      const { createMCPServer } = await import('../../src/mcp/server.js');
      const repo = { id: 'repo-1', name: 'fixture', repoPath: '/repo/fixture' };
      const backend = {
        callTool: vi.fn(),
        resolveRepo: vi.fn(async () => repo),
        ensureRepoInitialized: vi.fn(async () => {
          events.push('initialize');
        }),
        withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => {
          events.push('prepare');
          if (fail) throw new Error('workspace blocked');
          const result = await operation();
          events.push('release');
          return result;
        }),
        withCommittedGraphNotice: vi.fn(),
      };
      createMCPServer(backend as any);
      const handler = handlerSpy.mock.calls.find(
        ([schema]) => schema === CallToolRequestSchema,
      )?.[1] as any;
      const response = await handler({
        params: { name: 'gn_graph_walk', arguments: { repo: 'fixture', action: 'start' } },
      });
      expect(backend.withPreparedRepoRead).toHaveBeenCalledWith(
        repo,
        { needsRelationships: true, wantsWorkspaceGraph: true },
        expect.any(Function),
      );
      expect(events).toEqual(
        fail ? ['initialize', 'prepare'] : ['initialize', 'prepare', 'dispatch', 'release'],
      );
      expect(dispatchSuper).toHaveBeenCalledTimes(fail ? 0 : 1);
      expect(response.isError).toBe(fail ? true : undefined);
      expect(backend.withCommittedGraphNotice).not.toHaveBeenCalled();
    },
  );

  it('initializes a cold repository before dispatching the first graph walk', async () => {
    vi.resetModules();
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    let initialized = false;
    const dispatchSuper = vi.fn(async () => {
      if (!initialized) throw new Error('Graph is not initialized');
      return { walkId: 'walk-1' };
    });
    vi.doMock('../../src/mcp/super/dispatch.js', () => ({ dispatchSuper }));
    const handlerSpy = vi.spyOn(Server.prototype, 'setRequestHandler');
    const { createMCPServer } = await import('../../src/mcp/server.js');
    const backend = {
      callTool: vi.fn(),
      resolveRepo: vi.fn(async () => ({
        id: 'repo-1',
        name: 'fixture',
        repoPath: '/repo/fixture',
      })),
      ensureRepoInitialized: vi.fn(async () => {
        initialized = true;
      }),
    };
    createMCPServer(backend as any);
    const handler = handlerSpy.mock.calls.find(
      ([schema]) => schema === CallToolRequestSchema,
    )?.[1] as any;
    expect(handler).toBeDefined();
    const args = { action: 'start', seedSymbol: 'dispatchFacade', repo: 'fixture' };

    const response = await handler({ params: { name: 'gn_graph_walk', arguments: args } });

    expect(response.isError).toBeUndefined();
    expect(backend.resolveRepo).toHaveBeenCalledWith('fixture');
    expect(backend.ensureRepoInitialized).toHaveBeenCalledWith('repo-1');
    expect(dispatchSuper).toHaveBeenCalledWith('gn_graph_walk', args, 'repo-1');
    expect(backend.callTool).not.toHaveBeenCalled();
    expect(response.content[0].text).toContain('walk-1');
  });

  it('threads the backend write gate through public safe-refactor dispatch', async () => {
    vi.resetModules();
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const dispatchSuper = vi.fn(async (_name, _args, repoId, backend) => {
      return backend.callTool('rename', {
        repo: repoId,
        symbol_uid: 'Function:src/token.ts:parseToken',
        new_name: 'verifyToken',
        dry_run: false,
        confirm: true,
      });
    });
    vi.doMock('../../src/mcp/super/dispatch.js', () => ({ dispatchSuper }));
    const handlerSpy = vi.spyOn(Server.prototype, 'setRequestHandler');
    const { createMCPServer } = await import('../../src/mcp/server.js');
    const { LocalBackend } = await import('../../src/mcp/local/local-backend.js');
    const backend = new LocalBackend();
    vi.spyOn(backend, 'resolveRepo').mockResolvedValue({
      id: 'repo-1',
      name: 'fixture',
      repoPath: '/repo/fixture',
    } as any);
    vi.spyOn(backend, 'ensureRepoInitialized').mockResolvedValue(undefined);
    // Bypass graph initialization only; retain the real default-deny write authorization.
    vi.spyOn(backend as any, 'ensureInitialized').mockResolvedValue(undefined);
    const callToolSpy = vi.spyOn(backend, 'callTool');
    createMCPServer(backend);
    const handler = handlerSpy.mock.calls.find(
      ([schema]) => schema === CallToolRequestSchema,
    )?.[1] as any;
    expect(handler).toBeDefined();
    const args = {
      intent: 'rename',
      symbol: 'parseToken',
      params: { newName: 'verifyToken' },
      dryRun: false,
      confirm: true,
      preChecks: false,
      repo: 'fixture',
    };

    const response = await handler({ params: { name: 'gn_safe_refactor', arguments: args } });

    expect(dispatchSuper).toHaveBeenCalledWith('gn_safe_refactor', args, 'repo-1', {
      repoPath: '/repo/fixture',
      callTool: expect.any(Function),
    });
    expect(callToolSpy).toHaveBeenCalledWith('rename', {
      repo: 'repo-1',
      symbol_uid: 'Function:src/token.ts:parseToken',
      new_name: 'verifyToken',
      dry_run: false,
      confirm: true,
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Write operations are disabled on this backend');
  });

  it('retains repository identity when paging a server response with a next-step hint', async () => {
    vi.resetModules();
    const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-server-pages-'));
    vi.stubEnv('ONTOINDEX_MCP_RESULT_DIR', resultDir);
    try {
      const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
      const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
      const handlerSpy = vi.spyOn(Server.prototype, 'setRequestHandler');
      const { createMCPServer } = await import('../../src/mcp/server.js');
      createMCPServer({
        callTool: vi.fn(async () => ({
          repoLabel: 'fixture',
          repoPath: '/repo/fixture',
          data: 'x'.repeat(60000),
        })),
      } as any);
      const handler = handlerSpy.mock.calls.find(
        ([schema]) => schema === CallToolRequestSchema,
      )?.[1] as any;
      expect(handler).toBeDefined();

      const response = await handler({
        params: { name: 'context', arguments: { repo: 'fixture' } },
      });

      expect(response.isError).toBeUndefined();
      const page = JSON.parse(response.content[0].text);
      expect(page.truncated).toBe(true);
      expect(page.responsePage.identity).toEqual({
        repoLabel: 'fixture',
        repoPath: '/repo/fixture',
      });
      expect(page.responsePage.nextCursor).toBeDefined();
    } finally {
      await fs.rm(resultDir, { recursive: true, force: true });
    }
  });
});
