/**
 * LocalBackend.callTool routes impact/query/context to GroupService when repo starts with "@".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/lbug/pool-adapter.js')>();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/mcp/core/lbug-adapter.js')>();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('../../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { LocalBackend } from '../../../src/mcp/local/local-backend.js';
import { GroupService } from '../../../src/core/group/service.js';
import type { GroupRepoHandle } from '../../../src/core/group/service.js';

describe('LocalBackend real GroupService member routing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-group-member-routing-'));
    const groupDir = path.join(tmpDir, 'groups', 'g1');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'group.yaml'),
      `version: 1
name: g1
repos:
  app/backend: test-backend
  app/frontend: test-frontend
`,
    );
    vi.stubEnv('ONTOINDEX_HOME', tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(['1', '0'])(
    'routes members through the expected handler with AUTO_WORKSPACE=%s',
    async (flag) => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', flag);
      const backend = new LocalBackend();
      const member: GroupRepoHandle = {
        id: 'test-backend',
        name: 'test-backend',
        repoPath: path.join(tmpDir, 'backend'),
        storagePath: path.join(tmpDir, 'backend-storage'),
      };
      const resolveRepo = vi.spyOn(backend, 'resolveRepo').mockImplementation(async (name) => {
        expect(name).toBe('test-backend');
        return member as Awaited<ReturnType<LocalBackend['resolveRepo']>>;
      });
      type MemberHandlers = {
        dispatchRepoTool(method: string, params: Record<string, unknown>): Promise<unknown>;
        query(repo: GroupRepoHandle, params: Record<string, unknown>): Promise<unknown>;
        context(repo: GroupRepoHandle, params: Record<string, unknown>): Promise<unknown>;
        impact(repo: GroupRepoHandle, params: Record<string, unknown>): Promise<unknown>;
      };
      const handlers = backend as unknown as MemberHandlers;
      const dispatch = vi.spyOn(handlers, 'dispatchRepoTool').mockImplementation(async (method) => {
        if (method === 'query') return { processes: [] };
        if (method === 'context') return { status: 'missing' };
        return { error: 'routing-sentinel' };
      });
      const query = vi.spyOn(handlers, 'query').mockResolvedValue({ processes: [] });
      const context = vi.spyOn(handlers, 'context').mockResolvedValue({ status: 'missing' });
      const impact = vi.spyOn(handlers, 'impact').mockResolvedValue({ error: 'routing-sentinel' });
      const service = backend.getGroupService();

      await service.groupQuery({
        name: 'g1',
        query: 'login',
        subgroup: 'app/backend',
        subgroupExact: true,
      });
      await service.groupContext({
        name: 'g1',
        target: 'Sym',
        subgroup: 'app/backend',
        subgroupExact: true,
      });
      const result = await service.groupImpact({
        name: 'g1',
        repo: 'app/backend',
        target: 'Sym',
        direction: 'upstream',
      });

      expect(result).toHaveProperty('local.error', 'routing-sentinel');
      expect(resolveRepo).toHaveBeenCalledTimes(3);
      if (flag === '1') {
        expect(dispatch).toHaveBeenCalledTimes(3);
        expect(dispatch).toHaveBeenNthCalledWith(
          1,
          'query',
          expect.objectContaining({ repo: member.id, query: 'login' }),
        );
        expect(dispatch).toHaveBeenNthCalledWith(
          2,
          'context',
          expect.objectContaining({ repo: member.id, name: 'Sym' }),
        );
        expect(dispatch).toHaveBeenNthCalledWith(
          3,
          'impact',
          expect.objectContaining({
            repo: member.id,
            target: 'Sym',
            direction: 'upstream',
            signal: expect.any(AbortSignal),
          }),
        );
        expect(query).not.toHaveBeenCalled();
        expect(context).not.toHaveBeenCalled();
        expect(impact).not.toHaveBeenCalled();
      } else {
        expect(dispatch).not.toHaveBeenCalled();
        expect(query).toHaveBeenCalledExactlyOnceWith(
          member,
          expect.objectContaining({ query: 'login' }),
        );
        expect(context).toHaveBeenCalledExactlyOnceWith(
          member,
          expect.objectContaining({ name: 'Sym' }),
        );
        expect(impact).toHaveBeenCalledExactlyOnceWith(
          member,
          expect.objectContaining({
            target: 'Sym',
            direction: 'upstream',
            signal: expect.any(AbortSignal),
          }),
        );
      }
    },
  );
});

describe('LocalBackend @group repo routing', () => {
  let tmpDir: string;
  let groupSpyQuery: ReturnType<typeof vi.spyOn>;
  let groupSpyImpact: ReturnType<typeof vi.spyOn>;
  let groupSpyContext: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-atgrp-'));
    const groupDir = path.join(tmpDir, 'groups', 'g1');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'group.yaml'),
      `version: 1
name: g1
repos:
  app/backend: test-backend
  app/frontend: test-frontend
`,
    );
    vi.stubEnv('ONTOINDEX_HOME', tmpDir);
    groupSpyQuery = vi
      .spyOn(GroupService.prototype, 'groupQuery')
      .mockResolvedValue({ via: 'query' });
    groupSpyImpact = vi
      .spyOn(GroupService.prototype, 'groupImpact')
      .mockResolvedValue({ via: 'impact' });
    groupSpyContext = vi.spyOn(GroupService.prototype, 'groupContext').mockResolvedValue({
      group: 'g1',
      results: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes query to groupQuery with default member path (first sorted repos key)', async () => {
    const backend = new LocalBackend();
    const out = await backend.callTool('query', { repo: '@g1', query: 'login' });
    expect(out).toEqual({ via: 'query' });
    expect(groupSpyQuery).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'g1', query: 'login' }),
    );
    const arg = groupSpyQuery.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('repo');
  });

  it('routes query with explicit member path as exact subgroup (no descendant repo bleed)', async () => {
    const backend = new LocalBackend();
    await backend.callTool('query', { repo: '@g1/app/frontend', query: 'x' });
    expect(groupSpyQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'g1',
        query: 'x',
        subgroup: 'app/frontend',
        subgroupExact: true,
      }),
    );
  });

  it('preserves semantic search options across group routing', async () => {
    const options = {
      task_context: 'fix login',
      max_symbols: 3,
      include_content: true,
      exclude_paths: ['vendor/'],
      include_paths: ['src/'],
      include_skeleton: false,
      include_explanations: true,
      retrieval_policy: 'graph-only',
      consume_enrichment_facts: true,
    };
    await new LocalBackend().callTool('query', { repo: '@g1', query: 'login', ...options });
    expect(groupSpyQuery).toHaveBeenCalledWith(expect.objectContaining(options));
  });

  it('routes impact to groupImpact with resolved repo member path', async () => {
    const backend = new LocalBackend();
    const out = await backend.callTool('impact', {
      repo: '@g1',
      target: 'Sym',
      direction: 'upstream',
    });
    expect(out).toEqual({ via: 'impact' });
    expect(groupSpyImpact).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'g1',
        repo: 'app/backend',
        target: 'Sym',
        direction: 'upstream',
      }),
    );
  });

  it('routes context to groupContext', async () => {
    const backend = new LocalBackend();
    await backend.callTool('context', { repo: '@g1', target: 'Sym' });
    expect(groupSpyContext).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'g1', target: 'Sym' }),
    );
  });

  it('maps MCP symbol name to groupContext target (does not overwrite group name)', async () => {
    const backend = new LocalBackend();
    await backend.callTool('context', { repo: '@g1', name: 'MyClass' });
    expect(groupSpyContext).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'g1', target: 'MyClass' }),
    );
  });

  it('returns error for unknown group name', async () => {
    const backend = new LocalBackend();
    const out = await backend.callTool('query', { repo: '@no-such-group', query: 'x' });
    expect(out).toHaveProperty('error');
    expect(String((out as { error: string }).error)).toMatch(
      /not found|no such|unknown|exist|ENOENT/i,
    );
  });

  it('returns error for unknown member path', async () => {
    const backend = new LocalBackend();
    const out = await backend.callTool('query', { repo: '@g1/not-a-member', query: 'x' });
    expect(out).toHaveProperty('error');
    expect(String((out as { error: string }).error)).toMatch(/Unknown member path/i);
  });

  it('rejects empty service without calling group tools', async () => {
    const backend = new LocalBackend();
    await expect(
      backend.callTool('query', { repo: '@g1', query: 'x', service: '' }),
    ).rejects.toThrow('Invalid arguments for query: service:');
    expect(groupSpyQuery).not.toHaveBeenCalled();
  });

  describe('dispatch boundary typing (§0.7 item 5)', () => {
    it('throws with method name when called with an unknown method', async () => {
      const backend = new LocalBackend();
      await expect(backend.callTool('no_such_tool_xyz', {})).rejects.toThrow(/no_such_tool_xyz/);
    });

    it('throws on null params for a known method', async () => {
      const backend = new LocalBackend();
      await expect(backend.callTool('query', null)).rejects.toThrow(/null/);
    });
  });

  it('unknown group_* tools mention removal', async () => {
    const backend = new LocalBackend();
    await expect(backend.callTool('group_query', { name: 'g1', query: 'x' })).rejects.toThrow(
      /Removed tools/,
    );
  });

  it('removed group_contracts mentions migration', async () => {
    const backend = new LocalBackend();
    await expect(backend.callTool('group_contracts', { name: 'g1' })).rejects.toThrow(
      /Removed tools/,
    );
  });

  it('removed group_status mentions migration', async () => {
    const backend = new LocalBackend();
    await expect(backend.callTool('group_status', { name: 'g1' })).rejects.toThrow(/Removed tools/);
  });

  describe('dispatch boundary typing (§0.7 item 5)', () => {
    it('throws with method name when called with an unknown method', async () => {
      const backend = new LocalBackend();
      await expect(backend.callTool('no_such_tool_xyz', {})).rejects.toThrow(/no_such_tool_xyz/);
    });

    it('throws on null params for a known method', async () => {
      const backend = new LocalBackend();
      await expect(backend.callTool('query', null)).rejects.toThrow(/null/);
    });
  });

  describe('Issue #794 manual smoke checklist (automated)', () => {
    beforeEach(() => {
      const groupDir = path.join(tmpDir, 'groups', 'myproduct');
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(
        path.join(groupDir, 'group.yaml'),
        `version: 1
name: myproduct
repos:
  app/backend: test-backend
  app/frontend: test-frontend
`,
      );
    });

    it.each([
      {
        method: 'impact',
        params: {
          repo: '@myproduct',
          target: 'UserService.login',
          service: 'app/backend',
        },
        spy: () => groupSpyImpact,
      },
      {
        method: 'query',
        params: { repo: '@myproduct', query: 'login', service: 'app/backend' },
        spy: () => groupSpyQuery,
      },
      {
        method: 'context',
        params: { repo: '@myproduct', target: 'UserService.login', service: 'app/backend' },
        spy: () => groupSpyContext,
      },
    ])(
      '$method with repo "@myproduct" routes to GroupService and forwards service',
      async ({ method, params, spy }) => {
        const backend = new LocalBackend();
        await backend.callTool(method, params);
        expect(spy()).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'myproduct', service: 'app/backend' }),
        );
        const callArg = spy().mock.calls[0][0] as Record<string, unknown>;
        expect(
          typeof callArg.repo === 'string' ? (callArg.repo as string).startsWith('@') : false,
        ).toBe(false);
      },
    );
  });
});
