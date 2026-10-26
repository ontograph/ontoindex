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

  it.each([
    ['gn_graph_walk', { action: 'start', seedSymbol: 'dispatchFacade' }],
    ['gn_test_gap', { symbol: 'dispatchFacade' }],
    ['gn_test_gap', { filePath: 'src/mcp/server.ts' }],
    ['gn_test_gap', { query: 'dispatch handlers' }],
  ])('routes cold repository initialization to the owner for %s %j', async (name, target) => {
    vi.resetModules();
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    let initialized = false;
    const dispatchSuper = vi.fn(
      async (_name, _args, _repoId, _writeBackend, _context, readBackend) => {
        if (name !== 'gn_test_gap' && !initialized) throw new Error('Graph is not initialized');
        if (name === 'gn_test_gap') expect(readBackend).toBe(backend);
        return { walkId: 'walk-1' };
      },
    );
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
      withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => operation()),
    };
    createMCPServer(backend as any);
    const handler = handlerSpy.mock.calls.find(
      ([schema]) => schema === CallToolRequestSchema,
    )?.[1] as any;
    expect(handler).toBeDefined();
    const args = { ...target, repo: '/repo/fixture' };

    const response = await handler({ params: { name, arguments: args } });

    expect(response.isError).toBeUndefined();
    expect(backend.resolveRepo).toHaveBeenCalledWith('/repo/fixture');
    if (name === 'gn_test_gap') {
      expect(backend.ensureRepoInitialized).not.toHaveBeenCalled();
      expect(dispatchSuper).toHaveBeenCalledWith(
        name,
        args,
        'repo-1',
        undefined,
        undefined,
        backend,
      );
    } else {
      expect(backend.ensureRepoInitialized).toHaveBeenCalledWith('repo-1');
      expect(dispatchSuper).toHaveBeenCalledWith(name, args, 'repo-1');
    }
    expect(backend.callTool).not.toHaveBeenCalled();
    expect(response.content[0].text).toContain('walk-1');
    if (name === 'gn_test_gap') {
      expect(backend.withPreparedRepoRead).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, 'readiness', 'context'])(
    'prepares gn_docs graph reads only when required (action: %s)',
    async (action) => {
      vi.resetModules();
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
      const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
      const dispatchSuper = vi.fn(async () => ({ status: 'ok' }));
      vi.doMock('../../src/mcp/super/dispatch.js', () => ({ dispatchSuper }));
      const handlerSpy = vi.spyOn(Server.prototype, 'setRequestHandler');
      const { createMCPServer } = await import('../../src/mcp/server.js');
      const repo = { id: 'repo-1', name: 'fixture', repoPath: '/repo/fixture' };
      const backend = {
        callTool: vi.fn(),
        resolveRepo: vi.fn(async () => repo),
        ensureRepoInitialized: vi.fn(async () => {}),
        withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => operation()),
        withCommittedGraphNotice: vi.fn(),
      };
      createMCPServer(backend as any);
      const handler = handlerSpy.mock.calls.find(
        ([schema]) => schema === CallToolRequestSchema,
      )?.[1] as any;
      const args = { repo: 'fixture', ...(action === undefined ? {} : { action }) };
      const response = await handler({ params: { name: 'gn_docs', arguments: args } });
      expect(response.isError).toBeUndefined();
      expect(dispatchSuper).toHaveBeenCalledWith('gn_docs', args, 'repo-1');
      expect(backend.ensureRepoInitialized).toHaveBeenCalledTimes(action === 'context' ? 1 : 0);
      expect(backend.withPreparedRepoRead).toHaveBeenCalledTimes(action === 'context' ? 1 : 0);
      expect(backend.withCommittedGraphNotice).not.toHaveBeenCalled();
    },
  );

  it('propagates test-gap initialization failures from shared dispatch', async () => {
    vi.resetModules();
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const dispatchSuper = vi.fn(
      async (_name, _args, repoId, _writeBackend, _context, readBackend) => {
        await readBackend.ensureRepoInitialized(repoId);
      },
    );
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
        throw new Error('fixture initialization failed');
      }),
    };
    createMCPServer(backend as any);
    const handler = handlerSpy.mock.calls.find(
      ([schema]) => schema === CallToolRequestSchema,
    )?.[1] as any;
    const response = await handler({
      params: { name: 'gn_test_gap', arguments: { repo: 'fixture', symbol: 'baseline' } },
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('fixture initialization failed');
    expect(dispatchSuper).toHaveBeenCalledWith(
      'gn_test_gap',
      { repo: 'fixture', symbol: 'baseline' },
      'repo-1',
      undefined,
      undefined,
      backend,
    );
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
