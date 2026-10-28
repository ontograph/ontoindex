import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchFacade } from '../../src/mcp/facade/dispatch.js';
import { ONTOINDEX_FACADE_TOOLS } from '../../src/mcp/facade/tool-definitions.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../src/mcp/super/tool-definitions.js';
import { getPublicToolRegistry } from '../../src/mcp/shared/tool-registry.js';
import { serializeToolContract } from '../../src/mcp/shared/tool-contract-schema.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';

const { dispatchSuperMock } = vi.hoisted(() => ({ dispatchSuperMock: vi.fn() }));
vi.mock('../../src/mcp/super/dispatch.js', () => ({ dispatchSuper: dispatchSuperMock }));

afterEach(() => vi.unstubAllEnvs());

describe('safe refactor facade mapping', () => {
  it.each([{}, { dryRun: true, preChecks: false }, { dryRun: false, confirm: true, force: true }])(
    'forwards options and binds the authorized backend: %j',
    async (options) => {
      dispatchSuperMock.mockReset().mockResolvedValue({ applied: false });
      const backend = {
        ...graphReadBackend,
        resolveRepo: vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' }),
        callTool: vi.fn(function (this: unknown) {
          return this;
        }),
      };
      const args = {
        action: 'safe_refactor',
        repo: 'fixture',
        intent: 'modify-body',
        symbol: 'preferred',
        target: 'alias',
        params: { newBody: 'return 1;' },
        ...options,
      };
      const original = structuredClone(args);
      expect(
        await dispatchFacade('refactor', 'safe_refactor', args, backend as unknown as LocalBackend),
      ).toMatchObject({ applied: false });
      expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
        'gn_safe_refactor',
        original,
        'fixture',
        {
          repoPath: '/tmp/fixture',
          callTool: expect.any(Function),
        },
      );
      expect(dispatchSuperMock.mock.calls[0][3].callTool('sentinel', {})).toBe(backend);
      expect(args).toEqual(original);
      for (const field of ['dryRun', 'confirm', 'preChecks', 'force']) {
        if (!(field in options))
          expect(dispatchSuperMock.mock.calls[0][1]).not.toHaveProperty(field);
      }
    },
  );

  it('preserves handler error identity without fallback', async () => {
    const error = new Error('safe refactor refused');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const backend = {
      ...graphReadBackend,
      resolveRepo: vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' }),
      callTool: vi.fn(),
    };
    await expect(
      dispatchFacade(
        'refactor',
        'safe_refactor',
        {
          intent: 'modify-body',
          symbol: 'preferred',
          params: { newBody: 'return 1;' },
        },
        backend as unknown as LocalBackend,
      ),
    ).rejects.toBe(error);
    expect(error).toMatchObject({ repoLabel: 'fixture', repoPath: '/tmp/fixture' });
    expect(backend.callTool).not.toHaveBeenCalled();
    expect(dispatchSuperMock).toHaveBeenCalledOnce();
  });

  it('advertises stable metadata and optional primitive fields without defaults', () => {
    const registry = getPublicToolRegistry({ includeFacades: true });
    const action = { action: 'safe_refactor', contractStatus: 'stable', structuredOutput: false };
    expect(registry.find((tool) => tool.name === 'refactor')!.actions).toContainEqual(action);
    expect(
      serializeToolContract(registry).tools.find((tool) => tool.name === 'refactor')!.actions,
    ).toContainEqual(action);
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'refactor')!.inputSchema;
    const primitive = ONTOINDEX_SUPER_TOOLS.find(
      (tool) => tool.name === 'gn_safe_refactor',
    )!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('safe_refactor');
    expect(schema.properties.intent.enum).toEqual(primitive.properties.intent.enum);
    expect(schema.properties).toMatchObject({
      intent: { type: 'string' },
      params: { type: 'object' },
      dryRun: { type: 'boolean' },
      confirm: { type: 'boolean' },
      preChecks: { type: 'boolean' },
      force: { type: 'boolean' },
    });
    for (const field of ['intent', 'params', 'dryRun', 'confirm', 'preChecks', 'force']) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

const graphReadBackend = {
  ensureRepoInitialized: vi.fn(async () => {}),
  withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => operation()),
};

describe('verification facade read ownership', () => {
  it.each(['verify_diff', 'test_gap'] as const)(
    'forwards %s backend without preparing the mixed-evidence report in the facade',
    async (action) => {
      const response = { status: 'PASS', actual: { changedSymbols: ['selected'] } };
      dispatchSuperMock.mockReset().mockResolvedValue(response);
      const backend = {
        resolveRepo: vi.fn(async () => ({ id: 'fixture', repoPath: '/tmp/fixture' })),
        ensureRepoInitialized: vi.fn(),
        withPreparedRepoRead: vi.fn(),
        withCommittedGraphNotice: vi.fn(),
        callTool: vi.fn(),
      };
      const args = { repo: 'fixture', changedFiles: ['src/selected.ts'] };
      expect(
        await dispatchFacade('audit', action, args, backend as unknown as LocalBackend),
      ).toMatchObject(response);
      expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
        `gn_${action}`,
        args,
        'fixture',
        undefined,
        undefined,
        backend,
      );
      expect(backend.ensureRepoInitialized).not.toHaveBeenCalled();
      expect(backend.withPreparedRepoRead).not.toHaveBeenCalled();
      expect(backend.withCommittedGraphNotice).not.toHaveBeenCalled();
      expect(backend.callTool).not.toHaveBeenCalled();
    },
  );
});

describe('facade graph read preparation', () => {
  it.each([
    { automatic: '1', committed: false, notice: false },
    { automatic: '0', committed: false, notice: true },
    { automatic: '0', committed: true, notice: false },
  ])('holds preparation through dispatch: %j', async ({ automatic, committed, notice }) => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', automatic);
    const events: string[] = [];
    const repo = { id: 'fixture', name: 'fixture', repoPath: '/tmp/fixture' };
    dispatchSuperMock.mockReset().mockImplementation(async () => {
      events.push('dispatch');
      return { ok: true };
    });
    const backend = {
      resolveRepo: vi.fn(async () => repo),
      ensureRepoInitialized: vi.fn(async () => {
        events.push('initialize');
      }),
      withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => {
        events.push('prepare');
        try {
          return await operation();
        } finally {
          events.push('release');
        }
      }),
      withCommittedGraphNotice: vi.fn(async (result) => {
        events.push('notice');
        return result;
      }),
    };
    const result = await dispatchFacade(
      'inspect',
      'explore',
      {
        query: 'dispatch',
        ...(committed ? { read_mode: 'committed' } : {}),
      },
      backend as unknown as LocalBackend,
    );
    expect(events).toEqual([
      'initialize',
      'prepare',
      'dispatch',
      'release',
      ...(notice ? ['notice'] : []),
    ]);
    expect(backend.withPreparedRepoRead).toHaveBeenCalledExactlyOnceWith(
      repo,
      { needsRelationships: true, wantsWorkspaceGraph: true },
      expect.any(Function),
    );
    expect(backend.withCommittedGraphNotice).toHaveBeenCalledTimes(notice ? 1 : 0);
    expect(result).toMatchObject({ ok: true, repoLabel: 'fixture', repoPath: '/tmp/fixture' });
  });

  it.each(['initialize', 'prepare', 'dispatch'] as const)(
    'preserves %s failure identity and scope',
    async (failure) => {
      const events: string[] = [];
      const error = new Error(`${failure} blocked`);
      const repo = { id: 'fixture', name: 'fixture', repoPath: '/tmp/fixture' };
      dispatchSuperMock.mockReset().mockImplementation(async () => {
        events.push('dispatch');
        throw error;
      });
      const backend = {
        resolveRepo: vi.fn(async () => repo),
        ensureRepoInitialized: vi.fn(async () => {
          events.push('initialize');
          if (failure === 'initialize') throw error;
        }),
        withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => {
          events.push('prepare');
          if (failure === 'prepare') throw error;
          try {
            return await operation();
          } finally {
            events.push('release');
          }
        }),
        withCommittedGraphNotice: vi.fn(),
      };
      await expect(
        dispatchFacade(
          'inspect',
          'graph_walk',
          { walk_action: 'start' },
          backend as unknown as LocalBackend,
        ),
      ).rejects.toBe(error);
      expect(error).toMatchObject({ repoLabel: 'fixture', repoPath: '/tmp/fixture' });
      expect(events).toEqual(
        failure === 'initialize'
          ? ['initialize']
          : failure === 'prepare'
            ? ['initialize', 'prepare']
            : ['initialize', 'prepare', 'dispatch', 'release'],
      );
      expect(dispatchSuperMock).toHaveBeenCalledTimes(failure === 'dispatch' ? 1 : 0);
      expect(backend.withCommittedGraphNotice).not.toHaveBeenCalled();
    },
  );

  it('skips graph preparation and notices for non-graph handlers', async () => {
    dispatchSuperMock.mockReset().mockResolvedValue({ ok: true });
    const backend = {
      resolveRepo: vi.fn(async () => ({ id: 'fixture', repoPath: '/tmp/fixture' })),
      ensureRepoInitialized: vi.fn(),
      withPreparedRepoRead: vi.fn(),
      withCommittedGraphNotice: vi.fn(),
    };
    await dispatchFacade(
      'audit',
      'diff',
      { sessionA: 'a', sessionB: 'b' },
      backend as unknown as LocalBackend,
    );
    expect(dispatchSuperMock).toHaveBeenCalledOnce();
    expect(backend.ensureRepoInitialized).not.toHaveBeenCalled();
    expect(backend.withPreparedRepoRead).not.toHaveBeenCalled();
    expect(backend.withCommittedGraphNotice).not.toHaveBeenCalled();
  });
});

describe('audit session lock facade mapping', () => {
  it.each([
    {},
    { lock_action: undefined },
    {
      lock_action: 'create',
      sessionId: 'alias',
      currentHead: 'head-1',
      graphIndexId: 'graph-1',
      graphHash: 'hash-1',
      ontoindexVersion: 'version-1',
      persist: false,
    },
    { lock_action: 'load', session: 'preferred', sessionId: 'alias' },
    {
      lock_action: 'validate',
      currentHead: 'head-2',
      graphIndexId: 'graph-2',
      graphHash: 'hash-2',
    },
  ])('translates only the optional selector and preserves options: %j', async (options) => {
    const report = { operation: options.lock_action ?? 'validate', warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(report);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = {
      action: 'session_lock',
      repo: 'fixture',
      extra: { preserved: true },
      ...options,
    };
    const original = structuredClone(args);
    const {
      action: _outer,
      lock_action: selector,
      ...forwarded
    } = original as Record<string, unknown>;

    expect(
      await dispatchFacade('audit', 'session_lock', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(report);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_audit_session_lock',
      {
        ...forwarded,
        ...(selector === undefined ? {} : { action: selector }),
      },
      'fixture',
    );
    expect(resolveRepo).toHaveBeenCalledExactlyOnceWith('fixture');
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
    expect(dispatchSuperMock.mock.calls[0][1]).not.toHaveProperty('lock_action');
    if (selector === undefined)
      expect(dispatchSuperMock.mock.calls[0][1]).not.toHaveProperty('action');
  });

  it.each([null, '', 'session_lock', 'delete', 1, true, {}, []])(
    'rejects explicit invalid selector %j before IO',
    async (lock_action) => {
      dispatchSuperMock.mockReset();
      const backend = { resolveRepo: vi.fn(), callTool: vi.fn() };
      await expect(
        dispatchFacade(
          'audit',
          'session_lock',
          { action: 'session_lock', lock_action },
          backend as unknown as LocalBackend,
        ),
      ).rejects.toThrow(/lock_action/);
      expect(backend.resolveRepo).not.toHaveBeenCalled();
      expect(backend.callTool).not.toHaveBeenCalled();
      expect(dispatchSuperMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { tool: 'audit', action: 'export', lock_action: 'load' },
    { tool: 'inspect', action: 'context', lock_action: null },
  ] as const)(
    'rejects a misplaced selector before IO: %j',
    async ({ tool, action, lock_action }) => {
      dispatchSuperMock.mockReset();
      const backend = { resolveRepo: vi.fn(), callTool: vi.fn() };
      await expect(
        dispatchFacade(tool, action, { action, lock_action }, backend as unknown as LocalBackend),
      ).rejects.toThrow(/lock_action/);
      expect(backend.resolveRepo).not.toHaveBeenCalled();
      expect(backend.callTool).not.toHaveBeenCalled();
      expect(dispatchSuperMock).not.toHaveBeenCalled();
    },
  );

  it('preserves handler error identity without fallback', async () => {
    const error = new Error('session lock unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const backend = {
      resolveRepo: vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' }),
      callTool: vi.fn(),
    };
    await expect(
      dispatchFacade(
        'audit',
        'session_lock',
        { lock_action: 'load', session: 'current' },
        backend as unknown as LocalBackend,
      ),
    ).rejects.toBe(error);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_audit_session_lock',
      { action: 'load', session: 'current' },
      'fixture',
    );
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('advertises stable metadata and optional fields without handler defaults', () => {
    const registry = getPublicToolRegistry({ includeFacades: true });
    const action = {
      action: 'session_lock',
      contractStatus: 'stable',
      structuredOutput: true,
      dispatchCategory: 'audit',
    };
    expect(registry.find((tool) => tool.name === 'audit')!.actions).toContainEqual(action);
    expect(
      serializeToolContract(registry).tools.find((tool) => tool.name === 'audit')!.actions,
    ).toContainEqual(action);
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('session_lock');
    expect(schema.properties).toMatchObject({
      lock_action: { type: 'string', enum: ['create', 'load', 'validate'] },
      session: { type: 'string' },
      sessionId: { type: 'string' },
      currentHead: { type: 'string' },
      graphIndexId: { type: 'string' },
      graphHash: { type: 'string' },
      ontoindexVersion: { type: 'string' },
    });
    for (const field of [
      'lock_action',
      'session',
      'sessionId',
      'currentHead',
      'graphIndexId',
      'graphHash',
      'ontoindexVersion',
    ]) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('can delete facade mapping', () => {
  it('preserves advertised deletion safety metadata in the serialized contract', () => {
    const registry = getPublicToolRegistry({ includeFacades: true });
    const audit = registry.find((tool) => tool.name === 'audit')!;
    const action = audit.actions!.find((entry) => entry.action === 'can_delete');
    expect(action).toEqual({
      action: 'can_delete',
      contractStatus: 'stable',
      structuredOutput: true,
      dispatchCategory: 'safety',
    });
    expect(
      ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema.properties.action
        .enum,
    ).toContain(action!.action);
    expect(
      serializeToolContract(registry).tools.find((tool) => tool.name === 'audit')!.actions,
    ).toContainEqual(action);
  });

  it.each([{}, { includeCrossRepo: false }, { includeCrossRepo: true }])(
    'forwards options unchanged: %j',
    async (options) => {
      const report = { verdict: 'CAUTION', warnings: ['preserved warning'] };
      dispatchSuperMock.mockReset().mockResolvedValue(report);
      const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
      const callTool = vi.fn();
      const args = {
        action: 'can_delete',
        repo: 'fixture',
        symbol: 'orphanHelper',
        extra: { preserved: true },
        ...options,
      };
      const original = structuredClone(args);

      expect(
        await dispatchFacade('audit', 'can_delete', args, {
          ...graphReadBackend,
          resolveRepo,
          callTool,
        } as unknown as LocalBackend),
      ).toMatchObject(report);
      expect(resolveRepo).toHaveBeenCalledExactlyOnceWith('fixture');
      expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
        'gn_can_delete',
        original,
        'fixture',
      );
      expect(callTool).not.toHaveBeenCalled();
      expect(args).toEqual(original);
      if (!('includeCrossRepo' in options)) {
        expect(dispatchSuperMock.mock.calls[0][1]).not.toHaveProperty('includeCrossRepo');
      }
    },
  );

  it('preserves thrown handler error identity without falling back', async () => {
    const error = new Error('deletion safety unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = { symbol: 'orphanHelper' };

    await expect(
      dispatchFacade('audit', 'can_delete', args, {
        ...graphReadBackend,
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).rejects.toBe(error);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith('gn_can_delete', args, 'fixture');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('advertises optional deletion fields without injecting defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('can_delete');
    expect(schema.properties).toMatchObject({
      symbol: { type: 'string' },
      includeCrossRepo: { type: 'boolean' },
    });
    expect(schema.properties.symbol).not.toHaveProperty('default');
    expect(schema.properties.includeCrossRepo).not.toHaveProperty('default');
  });
});

describe('safe edit check facade mapping', () => {
  it('preserves advertised edit safety metadata in the serialized contract', () => {
    const registry = getPublicToolRegistry({ includeFacades: true });
    const audit = registry.find((tool) => tool.name === 'audit')!;
    const action = audit.actions!.find((entry) => entry.action === 'safe_edit_check');
    expect(action).toEqual({
      action: 'safe_edit_check',
      contractStatus: 'stable',
      structuredOutput: true,
      dispatchCategory: 'safety',
    });
    expect(
      ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema.properties.action
        .enum,
    ).toContain(action!.action);
    expect(
      serializeToolContract(registry).tools.find((tool) => tool.name === 'audit')!.actions,
    ).toContainEqual(action);
  });

  it.each([
    {},
    { intent: 'modify-body', force: false, docsEvidence: false },
    { intent: 'delete', force: true, docsEvidence: true },
  ])('forwards options unchanged without injecting defaults: %j', async (options) => {
    const report = { verdict: 'CAUTION', warnings: ['preserved warning'] };
    dispatchSuperMock.mockReset().mockResolvedValue(report);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = {
      action: 'safe_edit_check',
      repo: 'fixture',
      symbol: 'parseToken',
      extra: { preserved: true },
      ...options,
    };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'safe_edit_check', args, {
        ...graphReadBackend,
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(report);
    expect(resolveRepo).toHaveBeenCalledExactlyOnceWith('fixture');
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_safe_edit_check',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
    for (const field of ['intent', 'force', 'docsEvidence']) {
      if (!(field in options)) expect(dispatchSuperMock.mock.calls[0][1]).not.toHaveProperty(field);
    }
  });

  it('preserves thrown handler error identity without falling back', async () => {
    const error = new Error('edit safety unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = { symbol: 'parseToken' };

    await expect(
      dispatchFacade('audit', 'safe_edit_check', args, {
        ...graphReadBackend,
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).rejects.toBe(error);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_safe_edit_check',
      args,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('pre commit audit facade mapping', () => {
  it.each([
    {},
    { scope: 'staged', expectedSymbols: [], includePaths: [], docsEvidence: false },
    { scope: 'unstaged', expectedSymbols: ['doWork'], includePaths: ['src'], docsEvidence: true },
    { scope: 'all' },
    { scope: 'branch' },
  ])('forwards options unchanged without injecting defaults: %j', async (options) => {
    const report = { verdict: 'REVIEW', warnings: ['preserved warning'] };
    dispatchSuperMock.mockReset().mockResolvedValue(report);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = {
      action: 'pre_commit_audit',
      repo: 'fixture',
      extra: { preserved: true },
      ...options,
    };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'pre_commit_audit', args, {
        ...graphReadBackend,
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(report);
    expect(resolveRepo).toHaveBeenCalledExactlyOnceWith('fixture');
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_pre_commit_audit',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
    for (const field of ['scope', 'expectedSymbols', 'includePaths', 'docsEvidence']) {
      if (!(field in options)) expect(dispatchSuperMock.mock.calls[0][1]).not.toHaveProperty(field);
    }
  });

  it('preserves handler error identity without backend fallback', async () => {
    const error = new Error('commit audit unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const callTool = vi.fn();
    const backend = {
      ...graphReadBackend,
      resolveRepo: vi.fn().mockResolvedValue({ id: 'fixture' }),
      callTool,
    };
    await expect(
      dispatchFacade('audit', 'pre_commit_audit', {}, backend as unknown as LocalBackend),
    ).rejects.toBe(error);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith('gn_pre_commit_audit', {}, 'fixture');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('advertises stable safety metadata and optional fields without defaults', () => {
    const registry = getPublicToolRegistry({ includeFacades: true });
    const action = {
      action: 'pre_commit_audit',
      contractStatus: 'stable',
      structuredOutput: true,
      dispatchCategory: 'safety',
    };
    expect(registry.find((tool) => tool.name === 'audit')!.actions).toContainEqual(action);
    expect(
      serializeToolContract(registry).tools.find((tool) => tool.name === 'audit')!.actions,
    ).toContainEqual(action);
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('pre_commit_audit');
    expect(schema.properties).toMatchObject({
      scope: {
        type: 'string',
        enum: expect.arrayContaining(['staged', 'unstaged', 'all', 'branch']),
      },
      expectedSymbols: { type: 'array', items: { type: 'string' } },
      includePaths: { type: 'array', items: { type: 'string' } },
      docsEvidence: { type: 'boolean' },
    });
    for (const field of ['scope', 'expectedSymbols', 'includePaths', 'docsEvidence']) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('audit diff and export facade mappings', () => {
  it.each([
    {
      action: 'diff',
      method: 'gn_audit_diff',
      options: { sessionA: 'previous', sessionB: 'current' },
    },
    {
      action: 'diff',
      method: 'gn_audit_diff',
      options: { sessionA: 'previous', sessionB: 'current', maxEntries: 999 },
    },
    { action: 'export', method: 'gn_audit_export', options: { session: 'current' } },
    { action: 'export', method: 'gn_audit_export', options: { sessionId: 'current' } },
    {
      action: 'export',
      method: 'gn_audit_export',
      options: { session: 'current', sessionId: 'conflicting', format: 'both', maxFindings: 999 },
    },
  ])('forwards $action options unchanged: $options', async ({ action, method, options }) => {
    const response = { warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = {
      action,
      repo: 'fixture',
      legacyResponse: false,
      extra: { preserved: true },
      ...options,
    };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', action, args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(method, original, 'fixture');
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
  });

  it.each(['diff', 'export'])('preserves thrown %s handler error identity', async (action) => {
    const error = new Error('audit unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });

    await expect(
      dispatchFacade('audit', action, {}, { resolveRepo } as unknown as LocalBackend),
    ).rejects.toBe(error);
  });

  it('advertises optional audit fields without shared handler defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toEqual(expect.arrayContaining(['diff', 'export']));
    expect(schema.properties).toMatchObject({
      sessionA: { type: 'string' },
      sessionB: { type: 'string' },
      session: { type: 'string' },
      sessionId: { type: 'string' },
      format: { type: 'string', enum: ['json', 'markdown', 'both'] },
      maxEntries: { type: 'number' },
      maxFindings: { type: 'number' },
    });
    for (const field of ['maxEntries', 'maxFindings', 'format']) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('audit ingest facade mapping', () => {
  it.each([
    {},
    { report: 'audit.md', target: 'HEAD', persist: false, maxFindings: 1 },
    { sourcePath: 'audit.md', targetRef: 'main', graphIndexId: 'graph-1', persist: true },
    {
      report: 'fallback.md',
      sourcePath: 'preferred.md',
      target: 'HEAD',
      targetRef: 'main',
      sourceText: 'pasted findings',
    },
  ])('forwards ingest aliases and options unchanged: %j', async (options) => {
    const response = { action: 'audit-ingest', warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = { action: 'ingest', repo: 'fixture', extra: { preserved: true }, ...options };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'ingest', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(resolveRepo).toHaveBeenCalledExactlyOnceWith('fixture');
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_audit_ingest',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
    for (const field of [
      'report',
      'sourcePath',
      'sourceText',
      'target',
      'targetRef',
      'graphIndexId',
      'persist',
      'maxFindings',
    ]) {
      if (!(field in options)) expect(dispatchSuperMock.mock.calls[0][1]).not.toHaveProperty(field);
    }
  });

  it('preserves thrown ingest handler error identity without falling back', async () => {
    const error = new Error('audit source required');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();

    await expect(
      dispatchFacade('audit', 'ingest', {}, { resolveRepo, callTool } as unknown as LocalBackend),
    ).rejects.toBe(error);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith('gn_audit_ingest', {}, 'fixture');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('advertises optional ingest fields without injecting handler defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('ingest');
    expect(schema.properties).toMatchObject({
      report: { type: 'string' },
      sourcePath: { type: 'string' },
      sourceText: { type: 'string' },
      target: { type: 'string' },
      targetRef: { type: 'string' },
      graphIndexId: { type: 'string' },
      persist: { type: 'boolean' },
      maxFindings: { type: 'number' },
    });
    for (const field of [
      'report',
      'sourcePath',
      'sourceText',
      'target',
      'targetRef',
      'graphIndexId',
      'persist',
      'maxFindings',
    ]) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('audit verify facade mapping', () => {
  it.each([
    {},
    { session: 'current', findingId: 'finding-a' },
    {
      sessionId: 'current',
      maxFindings: 999,
      maxEvidence: 999,
      persist: false,
      legacyResponse: false,
    },
    { session: 'current', sessionId: 'preferred', graphIndexId: 'graph-1', persist: true },
    { finding: { findingId: 'inline', source: { path: 'audit.md' } }, maxEvidence: 1 },
  ])('forwards verify options unchanged: %j', async (options) => {
    const response = { action: 'audit-verify', warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = { action: 'verify', repo: 'fixture', extra: { preserved: true }, ...options };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'verify', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(resolveRepo).toHaveBeenCalledExactlyOnceWith('fixture');
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_audit_verify',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
    for (const field of [
      'session',
      'sessionId',
      'findingId',
      'finding',
      'graphIndexId',
      'maxFindings',
      'maxEvidence',
      'persist',
      'legacyResponse',
    ]) {
      if (!(field in options)) expect(dispatchSuperMock.mock.calls[0][1]).not.toHaveProperty(field);
    }
  });

  it('preserves thrown verify handler error identity without falling back', async () => {
    const error = new Error('session or finding is required for audit verify');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();

    await expect(
      dispatchFacade('audit', 'verify', {}, { resolveRepo, callTool } as unknown as LocalBackend),
    ).rejects.toBe(error);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith('gn_audit_verify', {}, 'fixture');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('advertises stable verify metadata and optional fields without handler defaults', () => {
    const audit = getPublicToolRegistry({ includeFacades: true }).find(
      (tool) => tool.name === 'audit',
    )!;
    expect(audit.actions!.find((entry) => entry.action === 'verify')).toEqual({
      action: 'verify',
      contractStatus: 'stable',
      structuredOutput: true,
      dispatchCategory: 'audit',
    });
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('verify');
    expect(schema.properties).toMatchObject({
      session: { type: 'string' },
      sessionId: { type: 'string' },
      findingId: { type: 'string' },
      finding: { type: 'object' },
      graphIndexId: { type: 'string' },
      persist: { type: 'boolean' },
      maxFindings: { type: 'number', maximum: 500 },
      maxEvidence: { type: 'number' },
    });
    for (const field of [
      'session',
      'sessionId',
      'findingId',
      'finding',
      'graphIndexId',
      'persist',
      'maxFindings',
      'maxEvidence',
    ]) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('diff impact facade mapping', () => {
  it.each([
    {},
    { scope: 'staged' },
    { scope: 'branch', includeReviewers: true, docsEvidence: false },
    {
      scope: 'commit-range',
      commitRange: 'HEAD~1..HEAD',
      includePaths: ['src/'],
      includeReviewers: false,
      docsEvidence: true,
      profile: 'pr-pack',
    },
  ])('forwards every primitive option without injecting defaults: %j', async (options) => {
    const response = { commitRange: '--cached', warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const backend = {
      ...graphReadBackend,
      resolveRepo: vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' }),
      callTool: vi.fn(),
    };
    const args = { action: 'diff_impact', repo: 'fixture', ...options };
    const original = structuredClone(args);
    expect(
      await dispatchFacade('impact', 'diff_impact', args, backend as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_diff_impact',
      original,
      'fixture',
    );
    expect(backend.callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
    for (const field of [
      'scope',
      'commitRange',
      'includePaths',
      'includeReviewers',
      'docsEvidence',
      'profile',
    ]) {
      if (!(field in options)) expect(dispatchSuperMock.mock.calls[0][1]).not.toHaveProperty(field);
    }
  });

  it('preserves diff impact error identity without legacy fallback', async () => {
    const error = new Error('diff impact unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const backend = {
      ...graphReadBackend,
      resolveRepo: vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' }),
      callTool: vi.fn(),
    };
    await expect(
      dispatchFacade('impact', 'diff_impact', {}, backend as unknown as LocalBackend),
    ).rejects.toBe(error);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith('gn_diff_impact', {}, 'fixture');
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('advertises the distinct stable action and optional primitive fields', () => {
    const registry = getPublicToolRegistry({ includeFacades: true });
    const action = {
      action: 'diff_impact',
      contractStatus: 'stable',
      structuredOutput: true,
      dispatchCategory: 'pr-review',
    };
    expect(registry.find((tool) => tool.name === 'impact')!.actions).toContainEqual(action);
    expect(
      serializeToolContract(registry).tools.find((tool) => tool.name === 'impact')!.actions,
    ).toContainEqual(action);
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'impact')!.inputSchema;
    const primitive = ONTOINDEX_SUPER_TOOLS.find(
      (tool) => tool.name === 'gn_diff_impact',
    )!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toEqual(expect.arrayContaining(['diff', 'diff_impact']));
    expect(schema.properties.scope.enum).toEqual(
      expect.arrayContaining(primitive.properties.scope.enum!),
    );
    expect(schema.properties).toMatchObject({
      commitRange: { type: 'string' },
      includePaths: { type: 'array', items: { type: 'string' } },
      includeReviewers: { type: 'boolean' },
      docsEvidence: { type: 'boolean' },
      profile: { type: 'string', enum: ['pr-pack'] },
    });
    for (const field of [
      'scope',
      'commitRange',
      'includePaths',
      'includeReviewers',
      'docsEvidence',
      'profile',
    ])
      expect(schema.properties[field]).not.toHaveProperty('default');
  });
});

describe('review diff facade mapping', () => {
  it.each([
    {},
    { scope: 'staged' },
    { scope: 'commit-range', commitRange: 'HEAD~1..HEAD', includePaths: ['src/'] },
  ])('forwards review options without injecting defaults: %j', async (options) => {
    const response = { envelopeVersion: '1', tool: 'gn_review_diff', warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const backend = {
      ...graphReadBackend,
      resolveRepo: vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' }),
      callTool: vi.fn(),
    };
    const args = { action: 'review_diff', repo: 'fixture', ...options };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'review_diff', args, backend as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_review_diff',
      original,
      'fixture',
    );
    expect(backend.callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
    for (const field of ['scope', 'commitRange', 'includePaths']) {
      if (!(field in options)) expect(dispatchSuperMock.mock.calls[0][1]).not.toHaveProperty(field);
    }
  });

  it('preserves review error identity without fallback', async () => {
    const error = new Error('review unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const backend = {
      ...graphReadBackend,
      resolveRepo: vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' }),
      callTool: vi.fn(),
    };
    await expect(
      dispatchFacade('audit', 'review_diff', {}, backend as unknown as LocalBackend),
    ).rejects.toBe(error);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith('gn_review_diff', {}, 'fixture');
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('advertises stable review metadata and optional review fields', () => {
    const registry = getPublicToolRegistry({ includeFacades: true });
    const action = {
      action: 'review_diff',
      contractStatus: 'stable',
      structuredOutput: true,
      dispatchCategory: 'pr-review',
    };
    expect(registry.find((tool) => tool.name === 'audit')!.actions).toContainEqual(action);
    expect(
      serializeToolContract(registry).tools.find((tool) => tool.name === 'audit')!.actions,
    ).toContainEqual(action);
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('review_diff');
    expect(schema.properties).toMatchObject({
      commitRange: { type: 'string' },
      includePaths: { type: 'array', items: { type: 'string' } },
    });
    for (const field of ['commitRange', 'scope', 'includePaths'])
      expect(schema.properties[field]).not.toHaveProperty('default');
  });
});

describe('audit lint facade mapping', () => {
  it('advertises the scope union supported by lint, diff validation and pre-commit handlers', () => {
    const scope = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema
      .properties.scope;
    expect(scope.enum).toEqual([
      'report',
      'bundle',
      'all',
      'unstaged',
      'staged',
      'compare',
      'branch',
      'commit-range',
    ]);
    expect(scope).not.toHaveProperty('default');
    for (const name of [
      'gn_audit_lint',
      'gn_verify_diff',
      'gn_test_gap',
      'gn_pre_commit_audit',
      'gn_review_diff',
    ]) {
      const handlerScope = ONTOINDEX_SUPER_TOOLS.find((tool) => tool.name === name)!.inputSchema
        .properties.scope;
      expect(scope.enum).toEqual(expect.arrayContaining(handlerScope.enum!));
    }
  });

  it.each([
    {},
    { session: 'current' },
    {
      sessionId: 'current',
      persist: false,
      advisory: false,
      includeIgnored: false,
      minimal: false,
      summary: false,
    },
    {
      session: 'current',
      sessionId: 'conflicting',
      cursor: 'opaque-cursor',
      scope: 'all',
      maxIssues: 999,
    },
  ])('forwards lint options unchanged: %j', async (options) => {
    const response = { warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = { action: 'lint', repo: 'fixture', extra: { preserved: true }, ...options };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'lint', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith('gn_audit_lint', original, 'fixture');
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
  });

  it('preserves thrown lint handler error identity', async () => {
    const error = new Error('audit lint unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });

    await expect(
      dispatchFacade('audit', 'lint', {}, { resolveRepo } as unknown as LocalBackend),
    ).rejects.toBe(error);
  });

  it('advertises optional lint fields without shared handler defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('lint');
    expect(schema.properties).toMatchObject({
      session: { type: 'string' },
      sessionId: { type: 'string' },
      scope: { type: 'string', enum: expect.arrayContaining(['report', 'bundle', 'all']) },
      maxIssues: { type: 'number' },
      cursor: { type: 'string' },
      persist: { type: 'boolean' },
      advisory: { type: 'boolean' },
      includeIgnored: { type: 'boolean' },
      minimal: { type: 'boolean' },
      summary: { type: 'boolean' },
    });
    for (const field of [
      'session',
      'sessionId',
      'scope',
      'maxIssues',
      'cursor',
      'persist',
      'advisory',
      'includeIgnored',
      'minimal',
      'summary',
    ]) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('audit dedupe facade mapping', () => {
  it.each([
    { session: 'current' },
    { sessionId: 'current', strategy: 'exact', maxGroups: 999, persist: false },
    { session: 'current', sessionId: 'conflicting', strategy: 'write-set', maxGroups: 999 },
  ])('forwards dedupe options unchanged: %j', async (options) => {
    const response = { warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = { action: 'dedupe', repo: 'fixture', extra: { preserved: true }, ...options };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'dedupe', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_audit_dedupe',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
  });

  it('preserves thrown dedupe handler error identity', async () => {
    const error = new Error('audit dedupe unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });

    await expect(
      dispatchFacade('audit', 'dedupe', {}, { resolveRepo } as unknown as LocalBackend),
    ).rejects.toBe(error);
  });

  it('advertises optional dedupe fields without shared handler defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('dedupe');
    expect(schema.properties).toMatchObject({
      session: { type: 'string' },
      sessionId: { type: 'string' },
      strategy: {
        type: 'string',
        enum: ['exact', 'symbol', 'root-cause', 'write-set', 'test-surface'],
      },
      maxGroups: { type: 'number' },
      persist: { type: 'boolean' },
    });
    for (const field of ['session', 'sessionId', 'strategy', 'maxGroups', 'persist']) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('audit bundle facade mapping', () => {
  it.each([
    { session: 'current' },
    { sessionId: 'current', strategy: 'exact', maxBundles: 999, persist: false },
    {
      session: 'current',
      sessionId: 'conflicting',
      strategy: 'write-set',
      maxBundles: 999,
      persist: false,
    },
  ])('forwards bundle options unchanged: %j', async (options) => {
    const response = { warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = { action: 'bundle', repo: 'fixture', extra: { preserved: true }, ...options };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'bundle', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_audit_bundle',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
  });

  it('preserves thrown bundle handler error identity', async () => {
    const error = new Error('audit bundle unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });

    await expect(
      dispatchFacade('audit', 'bundle', {}, { resolveRepo } as unknown as LocalBackend),
    ).rejects.toBe(error);
  });

  it('advertises bundle fields without shared handler defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('bundle');
    expect(schema.properties).toMatchObject({
      session: { type: 'string' },
      sessionId: { type: 'string' },
      strategy: {
        type: 'string',
        enum: ['exact', 'symbol', 'root-cause', 'write-set', 'test-surface'],
      },
      maxBundles: { type: 'number' },
      persist: { type: 'boolean' },
    });
    for (const field of ['session', 'sessionId', 'strategy', 'maxBundles', 'persist']) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('audit bundle conflicts facade mapping', () => {
  it.each([
    { session: 'current' },
    { sessionId: 'current', bundleIds: ['bundle-1'], strategy: 'exact', maxConflicts: 999 },
    {
      session: 'current',
      sessionId: 'conflicting',
      bundleIds: [],
      strategy: 'write-set',
      maxConflicts: 999,
    },
  ])('forwards bundle conflicts options unchanged: %j', async (options) => {
    const response = { warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = {
      action: 'bundle_conflicts',
      repo: 'fixture',
      extra: { preserved: true },
      ...options,
    };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'bundle_conflicts', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_bundle_conflicts',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
  });

  it('preserves thrown bundle conflicts handler error identity', async () => {
    const error = new Error('audit bundle conflicts unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });

    await expect(
      dispatchFacade('audit', 'bundle_conflicts', {}, { resolveRepo } as unknown as LocalBackend),
    ).rejects.toBe(error);
  });

  it('advertises optional bundle conflicts fields without shared handler defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('bundle_conflicts');
    expect(schema.properties).toMatchObject({
      session: { type: 'string' },
      sessionId: { type: 'string' },
      bundleIds: { type: 'array', items: { type: 'string' } },
      strategy: {
        type: 'string',
        enum: ['exact', 'symbol', 'root-cause', 'write-set', 'test-surface'],
      },
      maxConflicts: { type: 'number', minimum: 1, maximum: 100 },
    });
    for (const field of ['session', 'sessionId', 'bundleIds', 'strategy', 'maxConflicts']) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('audit scope guard facade mapping', () => {
  it.each([
    { session: 'current', bundleId: 'bundle-1' },
    {
      sessionId: 'current',
      bundleId: 'bundle-1',
      changedFiles: ['src/app.ts'],
      changedSymbols: ['run'],
      executedTests: ['test/app.test.ts'],
      requiredTests: [],
      persist: false,
    },
    {
      session: 'current',
      sessionId: 'conflicting',
      bundleId: 'bundle-2',
      changedFiles: [],
      changedSymbols: [],
      executedTests: [],
      requiredTests: ['test/other.test.ts'],
      persist: true,
    },
  ])('forwards scope guard options unchanged: %j', async (options) => {
    const response = { status: 'PASS', issues: [] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = { action: 'scope_guard', repo: 'fixture', extra: { preserved: true }, ...options };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'scope_guard', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_scope_guard',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
  });

  it('preserves thrown scope guard handler error identity', async () => {
    const error = new Error('audit scope guard unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });

    await expect(
      dispatchFacade('audit', 'scope_guard', {}, { resolveRepo } as unknown as LocalBackend),
    ).rejects.toBe(error);
  });

  it('advertises optional scope guard fields without shared handler defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('scope_guard');
    expect(schema.properties).toMatchObject({
      session: { type: 'string' },
      sessionId: { type: 'string' },
      bundleId: { type: 'string' },
      persist: { type: 'boolean' },
    });
    for (const field of ['changedFiles', 'changedSymbols', 'executedTests', 'requiredTests']) {
      expect(schema.properties[field]).toMatchObject({ type: 'array', items: { type: 'string' } });
    }
    for (const field of [
      'session',
      'sessionId',
      'bundleId',
      'changedFiles',
      'changedSymbols',
      'executedTests',
      'requiredTests',
      'persist',
    ]) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('audit dispatch prompt facade mapping', () => {
  it.each([
    { session: 'current' },
    {
      sessionId: 'current',
      bundleId: 'bundle-1',
      redactionMode: 'none',
      forbidUnverifiedFindings: false,
      allowRuntimeOnlyFindings: false,
      persist: false,
      maxPromptChars: 999999,
    },
    { session: 'current', sessionId: 'conflicting', bundleId: 'bundle-2' },
  ])('forwards dispatch prompt options unchanged: %j', async (options) => {
    const response = { warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = {
      action: 'dispatch_prompt',
      repo: 'fixture',
      extra: { preserved: true },
      ...options,
    };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'dispatch_prompt', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_dispatch_prompt',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
  });

  it('preserves thrown dispatch prompt handler error identity', async () => {
    const error = new Error('audit dispatch prompt unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });

    await expect(
      dispatchFacade('audit', 'dispatch_prompt', {}, { resolveRepo } as unknown as LocalBackend),
    ).rejects.toBe(error);
  });

  it('advertises optional dispatch prompt fields without shared handler defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('dispatch_prompt');
    expect(schema.properties).toMatchObject({
      session: { type: 'string' },
      sessionId: { type: 'string' },
      bundleId: { type: 'string' },
      redactionMode: { type: 'string', enum: ['none', 'paths', 'snippets', 'sensitive'] },
      forbidUnverifiedFindings: { type: 'boolean' },
      allowRuntimeOnlyFindings: { type: 'boolean' },
      persist: { type: 'boolean' },
      maxPromptChars: { type: 'number' },
    });
    for (const field of [
      'session',
      'sessionId',
      'bundleId',
      'redactionMode',
      'forbidUnverifiedFindings',
      'allowRuntimeOnlyFindings',
      'persist',
      'maxPromptChars',
    ]) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('audit tombstone create facade mapping', () => {
  it.each([
    { session: 'current', findingId: 'finding-1', reason: 'fixed' },
    {
      sessionId: 'current',
      findingId: 'finding-1',
      reason: 'fixed',
      invariantId: 'invariant-1',
      fixCommit: 'abc123',
      persist: false,
    },
    {
      session: 'conflicting',
      sessionId: 'current',
      findingId: 'finding-2',
      reason: '',
      persist: true,
    },
  ])('forwards tombstone options unchanged: %j', async (options) => {
    const response = { status: 'TOMBSTONED', warnings: [] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = {
      action: 'tombstone_create',
      repo: 'fixture',
      extra: { preserved: true },
      ...options,
    };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'tombstone_create', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toEqual({ repoLabel: 'fixture', repoPath: '/tmp/fixture', ...response });
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_audit_tombstone_create',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
  });

  it('preserves tombstone handler error identity without falling back', async () => {
    const error = new Error('audit tombstone unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();

    await expect(
      dispatchFacade('audit', 'tombstone_create', {}, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).rejects.toBe(error);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('advertises optional tombstone fields without shared handler defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('tombstone_create');
    expect(schema.properties).toMatchObject({
      session: { type: 'string' },
      sessionId: { type: 'string' },
      findingId: { type: 'string' },
      reason: { type: 'string' },
      invariantId: { type: 'string' },
      fixCommit: { type: 'string' },
      persist: { type: 'boolean' },
    });
    for (const field of [
      'session',
      'sessionId',
      'findingId',
      'reason',
      'invariantId',
      'fixCommit',
      'persist',
    ]) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
    const registry = getPublicToolRegistry({ includeFacades: true });
    const action = registry
      .find((tool) => tool.name === 'audit')!
      .actions!.find((entry) => entry.action === 'tombstone_create');
    expect(action).toEqual({
      action: 'tombstone_create',
      contractStatus: 'stable',
      structuredOutput: true,
      dispatchCategory: 'audit',
    });
    expect(
      serializeToolContract(registry).tools.find((tool) => tool.name === 'audit')!.actions,
    ).toContainEqual(action);
  });
});

describe('audit replay facade mapping', () => {
  it.each([
    { session: 'current' },
    { sessionId: 'current', targetHead: 'HEAD~1', maxFindings: 999 },
    { session: 'current', sessionId: 'conflicting', targetHead: 'HEAD', maxFindings: 999 },
  ])('forwards replay options unchanged: %j', async (options) => {
    const response = { warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = { action: 'replay', repo: 'fixture', extra: { preserved: true }, ...options };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'replay', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_audit_replay',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
  });

  it('preserves thrown replay handler error identity', async () => {
    const error = new Error('audit replay unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });

    await expect(
      dispatchFacade('audit', 'replay', {}, { resolveRepo } as unknown as LocalBackend),
    ).rejects.toBe(error);
  });

  it('advertises replay fields without shared handler defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('replay');
    expect(schema.properties).toMatchObject({
      session: { type: 'string' },
      sessionId: { type: 'string' },
      targetHead: { type: 'string' },
      maxFindings: { type: 'number' },
    });
    expect(schema.properties.maxFindings).not.toHaveProperty('default');
  });
});

describe('audit PR marker scan facade mapping', () => {
  it.each([
    { evidenceLine: 1 },
    { evidenceLine: 2, source: '// TODO: follow up' },
    { evidenceLine: 3, source: '// TODO: alias', sourceText: '// PR-12: canonical' },
    { evidenceLine: 4, path: 'src/fixture.ts', windowBefore: 0, windowAfter: 0 },
    { evidenceLine: 5, windowBefore: 999, windowAfter: 999 },
  ])('forwards marker scan options unchanged: %j', async (options) => {
    const response = { warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = {
      action: 'pr_marker_scan',
      repo: 'fixture',
      extra: { preserved: true },
      ...options,
    };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'pr_marker_scan', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_audit_pr_marker_scan',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
  });

  it('preserves thrown marker scan handler error identity', async () => {
    const error = new Error('marker scan unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });

    await expect(
      dispatchFacade('audit', 'pr_marker_scan', {}, { resolveRepo } as unknown as LocalBackend),
    ).rejects.toBe(error);
  });

  it('advertises marker scan fields without shared handler defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('pr_marker_scan');
    expect(schema.properties).toMatchObject({
      path: { type: 'string' },
      source: { type: 'string' },
      sourceText: { type: 'string' },
      evidenceLine: { type: 'number' },
      windowBefore: { type: 'number' },
      windowAfter: { type: 'number' },
    });
    for (const field of [
      'path',
      'source',
      'sourceText',
      'evidenceLine',
      'windowBefore',
      'windowAfter',
    ]) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('audit fix history facade mapping', () => {
  it.each([
    { targetHead: 'HEAD', path: 'src/fixture.ts' },
    { targetHead: 'HEAD~1', path: 'src/fixture.ts', patterns: [] },
    {
      targetHead: 'HEAD',
      path: 'src/fixture.ts',
      patterns: ['fix', 'negative evidence'],
      limit: 999,
    },
  ])('forwards fix history options unchanged: %j', async (options) => {
    const response = { warnings: ['preserved'] };
    dispatchSuperMock.mockReset().mockResolvedValue(response);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const callTool = vi.fn();
    const args = { action: 'fix_history', repo: 'fixture', extra: { preserved: true }, ...options };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('audit', 'fix_history', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend),
    ).toMatchObject(response);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_fix_history',
      original,
      'fixture',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(args).toEqual(original);
  });

  it('preserves thrown fix history handler error identity', async () => {
    const error = new Error('fix history unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });

    await expect(
      dispatchFacade('audit', 'fix_history', {}, { resolveRepo } as unknown as LocalBackend),
    ).rejects.toBe(error);
  });

  it('advertises fix history fields without shared handler defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('fix_history');
    expect(schema.properties).toMatchObject({
      targetHead: { type: 'string' },
      path: { type: 'string' },
      patterns: { type: 'array', items: { type: 'string' } },
      limit: { type: 'number' },
    });
    for (const field of ['targetHead', 'path', 'patterns', 'limit']) {
      expect(schema.properties[field]).not.toHaveProperty('default');
    }
  });
});

describe('explore facade mapping', () => {
  it.each([undefined, 'shallow', 'balanced', 'deep'])(
    'forwards depth %s without defaults',
    async (depth) => {
      const response = { warnings: ['preserved'] };
      dispatchSuperMock.mockReset().mockResolvedValue(response);
      const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
      const args = {
        action: 'explore',
        query: 'auth flow',
        ...(depth === undefined ? {} : { depth }),
        qualityMode: 'fast',
        includeSkeletons: false,
        includeCitations: false,
        profile: 'task-pack',
        format: 'files',
        extra: 1,
      };
      const original = structuredClone(args);
      expect(
        await dispatchFacade('inspect', 'explore', args, {
          ...graphReadBackend,
          resolveRepo,
        } as unknown as LocalBackend),
      ).toMatchObject(response);
      expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith('gn_explore', original, 'fixture');
      expect(args).toEqual(original);
    },
  );
  it.each([
    [100, 3],
    [0, 1],
    ['deep', undefined],
    [NaN, undefined],
  ])('preserves context depth normalization for %s', async (depth, expected) => {
    const callTool = vi.fn().mockResolvedValue({ ok: true });
    const args = { depth };
    await dispatchFacade('inspect', 'context', args, { callTool } as unknown as LocalBackend);
    expect(callTool).toHaveBeenCalledExactlyOnceWith(
      'context',
      expected === undefined ? {} : { depth: expected },
    );
    expect(args).toEqual({ depth });
  });
  it('preserves handler errors', async () => {
    const error = new Error('explore unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    await expect(
      dispatchFacade('inspect', 'explore', { query: 'auth' }, {
        ...graphReadBackend,
        resolveRepo,
      } as unknown as LocalBackend),
    ).rejects.toBe(error);
  });
  it('advertises both depth types without a shared default', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'inspect')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('explore');
    expect(schema.properties.depth).toMatchObject({
      type: ['number', 'string'],
      minimum: 1,
      maximum: 3,
    });
    expect(schema.properties.depth).not.toHaveProperty('default');
    expect(schema.properties.query).toMatchObject({ type: 'string' });
  });
});

describe('discovery help and contract mappings', () => {
  it.each([
    ['help', 'gn_help'],
    ['tool_contract', 'gn_tool_contract'],
  ])('delegates %s to the existing global handler', async (action, method) => {
    dispatchSuperMock.mockReset();
    const response = { warnings: ['preserved'] };
    const callTool = vi.fn().mockResolvedValue(response);
    const resolveRepo = vi.fn();
    const args = {
      action,
      mode: 'audit',
      includeFacades: true,
      legacyResponse: false,
      extra: { preserved: true },
    };
    const original = structuredClone(args);
    expect(
      await dispatchFacade('discover', action, args, {
        callTool,
        resolveRepo,
      } as unknown as LocalBackend),
    ).toBe(response);
    expect(callTool).toHaveBeenCalledExactlyOnceWith(method, original);
    expect(args).toEqual(original);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(dispatchSuperMock).not.toHaveBeenCalled();
    const error = new Error('global handler unavailable');
    callTool.mockRejectedValueOnce(error);
    await expect(
      dispatchFacade('discover', action, {}, { callTool } as unknown as LocalBackend),
    ).rejects.toBe(error);
  });

  it.each([undefined, '7', NaN, Infinity, 1000, 2.5])(
    'leaves help limit %s to the handler',
    async (limit) => {
      const callTool = vi.fn().mockResolvedValue({ ok: true });
      const args = limit === undefined ? { action: 'help' } : { action: 'help', limit };
      const original = structuredClone(args);
      await dispatchFacade('discover', 'help', args, { callTool } as unknown as LocalBackend);
      expect(callTool).toHaveBeenCalledExactlyOnceWith('gn_help', original);
      expect(args).toEqual(original);
    },
  );

  it.each([
    ['repos', 'list_repos'],
    ['routes', 'route_map'],
    ['tools', 'tool_map'],
    ['packs', 'analysis_catalog'],
    ['groups', 'group_list'],
    ['sync', 'group_sync'],
  ])('preserves existing %s delegation and raw extras', async (action, method) => {
    const callTool = vi.fn().mockResolvedValue({ ok: true });
    const args = { action, codebase: true, limit: 'legacy-extra' };
    await dispatchFacade('discover', action, args, { callTool } as unknown as LocalBackend);
    expect(callTool).toHaveBeenCalledExactlyOnceWith(method, args);
  });

  it('advertises optional legacy discovery fields without a limit default', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'discover')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toEqual(
      expect.arrayContaining(['help', 'tool_contract', 'tools']),
    );
    expect(schema.properties).toMatchObject({
      topic: { enum: ['overview', 'docs', 'editing', 'setup'], default: 'overview' },
      mode: { enum: ['general', 'audit', 'refactor', 'query-projects'] },
      query: { type: 'string' },
      intent: { type: 'string' },
      evidenceClass: {
        enum: [
          'graph_evidence',
          'docs_evidence',
          'audit_evidence',
          'advisory_memory',
          'runtime_diagnostic',
          'unknown',
        ],
      },
      evidenceClasses: { type: 'array', items: { type: 'string' } },
      stability: { enum: ['stable', 'experimental', 'deprecated'] },
      includeNonAuthoritativeEvidence: { default: false },
      includeFacades: { default: false },
      legacyResponse: { default: true },
      limit: { minimum: 1, maximum: 100 },
    });
    expect(schema.properties.limit).not.toHaveProperty('default');
  });
});

describe('quality mode facade mapping', () => {
  it.each([
    { level: 'fast' },
    { level: 'balanced', duration: 'session' },
    { level: 'thorough', duration: 'until-revert' },
  ])('forwards quality options without applying defaults: %j', async (options) => {
    dispatchSuperMock.mockReset();
    const response = { level: options.level, warnings: ['process-wide setting'] };
    const callTool = vi.fn().mockResolvedValue(response);
    const resolveRepo = vi.fn();
    const args = { action: 'quality_mode', extra: { preserved: true }, ...options };
    const original = structuredClone(args);

    expect(
      await dispatchFacade('manage', 'quality_mode', args, {
        callTool,
        resolveRepo,
      } as unknown as LocalBackend),
    ).toBe(response);
    expect(callTool).toHaveBeenCalledExactlyOnceWith('gn_quality_mode', original);
    expect(args).toEqual(original);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(dispatchSuperMock).not.toHaveBeenCalled();
  });

  it('preserves backend responses and thrown errors', async () => {
    dispatchSuperMock.mockReset();
    const response = { error: 'invalid level', warnings: ['choose a supported level'] };
    const callTool = vi.fn().mockResolvedValueOnce(response);
    const resolveRepo = vi.fn();
    const backend = { callTool, resolveRepo } as unknown as LocalBackend;

    expect(await dispatchFacade('manage', 'quality_mode', {}, backend)).toBe(response);
    expect(callTool).toHaveBeenLastCalledWith('gn_quality_mode', {});
    const error = new Error('quality mode unavailable');
    callTool.mockRejectedValueOnce(error);
    await expect(dispatchFacade('manage', 'quality_mode', {}, backend)).rejects.toBe(error);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(dispatchSuperMock).not.toHaveBeenCalled();
  });

  it('advertises legacy quality fields without requiring them globally', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'manage')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('quality_mode');
    expect(schema.properties.level).toMatchObject({
      type: 'string',
      enum: ['fast', 'balanced', 'thorough'],
    });
    expect(schema.properties.duration).toMatchObject({
      type: 'string',
      enum: ['session', 'until-revert'],
      default: 'session',
    });
    expect(schema.properties.level).not.toHaveProperty('default');
  });
});

describe('diagnosis facade mapping', () => {
  it.each([
    {},
    {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
      checkToolContract: false,
    },
    { checkLsp: true, legacyResponse: false, includeFileScopePreview: true },
  ])('forwards options without applying defaults: %j', async (options) => {
    dispatchSuperMock.mockReset();
    const response = { ok: true };
    const callTool = vi.fn().mockResolvedValue(response);
    const resolveRepo = vi.fn();
    const args = { action: 'diagnose', repo: 'fixture', extra: 1, ...options };
    const original = structuredClone(args);
    expect(
      await dispatchFacade('manage', 'diagnose', args, {
        callTool,
        resolveRepo,
      } as unknown as LocalBackend),
    ).toBe(response);
    expect(callTool).toHaveBeenCalledExactlyOnceWith('gn_diagnose', original);
    expect(args).toEqual(original);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(dispatchSuperMock).not.toHaveBeenCalled();
  });
  it('preserves backend errors', async () => {
    const response = { error: 'unavailable' };
    const callTool = vi.fn().mockResolvedValueOnce(response);
    const backend = { callTool } as unknown as LocalBackend;
    expect(await dispatchFacade('manage', 'diagnose', {}, backend)).toBe(response);
    const error = new Error('unavailable');
    callTool.mockRejectedValueOnce(error);
    await expect(dispatchFacade('manage', 'diagnose', {}, backend)).rejects.toBe(error);
  });
  it('advertises optional diagnosis checks with legacy defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'manage')!.inputSchema;
    expect(schema.properties.action.enum).toContain('diagnose');
    expect(schema.required).toEqual(['action']);
    for (const field of [
      'checkLsp',
      'checkEmbeddings',
      'checkIndexFreshness',
      'checkToolContract',
    ]) {
      expect(schema.properties[field]).toMatchObject({ type: 'boolean', default: true });
    }
  });
});

describe('index freshness facade mapping', () => {
  it.each([
    { label: 'omitted', options: {} },
    { label: 'false', options: { autoAnalyze: false } },
    {
      label: 'true with legacy options',
      options: {
        autoAnalyze: true,
        withEmbeddings: true,
        killMcpForLock: true,
        requiredGraphCapabilities: ['impact', 'symbols', 'impact'],
        legacyResponse: false,
        extra: { preserved: true },
      },
    },
  ])(
    'forwards $label without mutating arguments or applying handler defaults',
    async ({ options }) => {
      dispatchSuperMock.mockReset().mockResolvedValue({ ok: true });
      const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
      const callTool = vi.fn();
      const args = { action: 'ensure_fresh', repo: 'fixture', ...options };
      const original = structuredClone(args);

      await dispatchFacade('manage', 'ensure_fresh', args, {
        resolveRepo,
        callTool,
      } as unknown as LocalBackend);

      expect(resolveRepo).not.toHaveBeenCalled();
      expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
        'gn_ensure_fresh',
        original,
        'fixture',
      );
      expect(callTool).not.toHaveBeenCalled();
      expect(args).toEqual(original);
      if (options.autoAnalyze === undefined) {
        expect(dispatchSuperMock.mock.calls[0][1]).not.toHaveProperty('autoAnalyze');
      }
    },
  );

  it('preserves handler error responses without wrapping repository context', async () => {
    const error = { error: 'analysis unavailable', code: 'ANALYSIS_UNAVAILABLE' };
    dispatchSuperMock.mockReset().mockResolvedValue(error);
    const repo = { id: 'fixture', repoPath: '/tmp/fixture' };
    const resolveRepo = vi.fn().mockResolvedValue(repo);
    const withCommittedGraphNotice = vi.fn(async (result) => result);

    const result = await dispatchFacade('manage', 'ensure_fresh', { autoAnalyze: true }, {
      resolveRepo,
      withCommittedGraphNotice,
    } as unknown as LocalBackend);

    expect(resolveRepo).not.toHaveBeenCalled();
    expect(withCommittedGraphNotice).not.toHaveBeenCalled();
    expect(result).toBe(error);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_ensure_fresh',
      { autoAnalyze: true },
      '',
    );
  });

  it('lets the freshness owner report an unregistered repository selector', async () => {
    const args = { repo: '/tmp/unregistered', autoAnalyze: true };
    const report = { status: 'error', code: 'REPOSITORY_NOT_REGISTERED', repo: args.repo };
    dispatchSuperMock.mockReset().mockResolvedValue(report);
    const resolveRepo = vi.fn().mockRejectedValue(new Error('unregistered repository'));
    const withCommittedGraphNotice = vi.fn();

    const result = await dispatchFacade('manage', 'ensure_fresh', args, {
      resolveRepo,
      withCommittedGraphNotice,
    } as unknown as LocalBackend);

    expect(resolveRepo).not.toHaveBeenCalled();
    expect(withCommittedGraphNotice).not.toHaveBeenCalled();
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith('gn_ensure_fresh', args, args.repo);
    expect(result).toBe(report);
  });

  it('preserves thrown handler errors', async () => {
    const error = new Error('analysis failed');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });

    await expect(
      dispatchFacade('manage', 'ensure_fresh', {}, { resolveRepo } as unknown as LocalBackend),
    ).rejects.toBe(error);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith('gn_ensure_fresh', {}, '');
  });

  it('advertises legacy freshness fields and defaults without requiring them globally', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'manage')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('ensure_fresh');
    expect(schema.properties).toMatchObject({
      repo: { type: 'string' },
      autoAnalyze: { type: 'boolean', default: false },
      withEmbeddings: { type: 'boolean', default: false },
      killMcpForLock: { type: 'boolean', default: false },
      requiredGraphCapabilities: {
        type: 'array',
        items: { type: 'string', enum: ['symbols', 'impact', 'processes'] },
        default: ['symbols'],
      },
      legacyResponse: { type: 'boolean', default: true },
    });
  });
});

describe('analysis job facade mapping', () => {
  it.each([undefined, 'status', 'cancel'])(
    'forwards job action %s without mutating input',
    async (jobAction) => {
      dispatchSuperMock.mockReset().mockResolvedValue({ ok: true });
      const repo = { id: 'fixture', repoPath: '/tmp/fixture' };
      const resolveRepo = vi.fn().mockResolvedValue(repo);
      const args = {
        action: 'analyze_job',
        job_action: jobAction,
        jobId: 'job-1',
        repo: 'fixture',
        extra: 1,
      };
      await dispatchFacade('manage', 'analyze_job', args, {
        resolveRepo,
      } as unknown as LocalBackend);
      expect(resolveRepo).toHaveBeenCalledWith('fixture');
      expect(dispatchSuperMock).toHaveBeenCalledWith(
        'gn_analyze_job',
        {
          action: jobAction ?? 'status',
          jobId: 'job-1',
          repo: 'fixture',
          extra: 1,
        },
        'fixture',
      );
      expect(args).toEqual({
        action: 'analyze_job',
        job_action: jobAction,
        jobId: 'job-1',
        repo: 'fixture',
        extra: 1,
      });
    },
  );

  it.each([null, '', 1, 'delete'])(
    'rejects invalid job selector %s before resolving a repository',
    async (job_action) => {
      const resolveRepo = vi.fn();
      await expect(
        dispatchFacade('manage', 'analyze_job', { job_action, jobId: 'job-1' }, {
          resolveRepo,
        } as unknown as LocalBackend),
      ).rejects.toThrow('requires job_action');
      expect(resolveRepo).not.toHaveBeenCalled();
    },
  );

  it('rejects reserved selector on unrelated actions and requires a job ID', async () => {
    const callTool = vi.fn();
    await expect(
      dispatchFacade('manage', 'route_map', { job_action: 'cancel' }, {
        callTool,
      } as unknown as LocalBackend),
    ).rejects.toThrow('only supported');
    await expect(
      dispatchFacade('manage', 'analyze_job', {}, { callTool } as unknown as LocalBackend),
    ).rejects.toThrow('requires jobId');
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('graph walk facade mapping', () => {
  it.each(['start', 'step', 'status'])(
    'maps walk action %s without mutating arguments',
    async (walk_action) => {
      dispatchSuperMock.mockReset().mockResolvedValue({ ok: true });
      const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
      const args = {
        action: 'graph_walk',
        walk_action,
        walkId: 'walk-1',
        seedSymbol: 'symbol',
        maxSteps: 100,
        extra: 1,
      };
      const original = { ...args };
      await dispatchFacade('inspect', 'graph_walk', args, {
        ...graphReadBackend,
        resolveRepo,
      } as unknown as LocalBackend);
      expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
        'gn_graph_walk',
        {
          action: walk_action,
          walkId: 'walk-1',
          seedSymbol: 'symbol',
          maxSteps: 100,
          extra: 1,
        },
        'fixture',
      );
      expect(args).toEqual(original);
    },
  );

  it.each([undefined, null, '', 1, 'cancel'])(
    'rejects invalid walk selector %s before dispatch',
    async (walk_action) => {
      dispatchSuperMock.mockReset();
      const resolveRepo = vi.fn();
      await expect(
        dispatchFacade('inspect', 'graph_walk', { walk_action }, {
          resolveRepo,
        } as unknown as LocalBackend),
      ).rejects.toThrow('requires walk_action');
      expect(resolveRepo).not.toHaveBeenCalled();
      expect(dispatchSuperMock).not.toHaveBeenCalled();
    },
  );

  it('rejects cross-operation selectors before backend invocation', async () => {
    const resolveRepo = vi.fn();
    const callTool = vi.fn();
    const backend = { resolveRepo, callTool } as unknown as LocalBackend;
    await expect(
      dispatchFacade('inspect', 'context', { walk_action: 'start' }, backend),
    ).rejects.toThrow('only supported');
    await expect(
      dispatchFacade('manage', 'analyze_job', { jobId: 'job-1', walk_action: 'status' }, backend),
    ).rejects.toThrow('only supported');
    await expect(
      dispatchFacade(
        'inspect',
        'graph_walk',
        { walk_action: 'status', job_action: 'status' },
        backend,
      ),
    ).rejects.toThrow('only supported');
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('preserves handler validation responses', async () => {
    const error = { error: 'start action requires a seedSymbol', code: 'SEED_SYMBOL_REQUIRED' };
    dispatchSuperMock.mockReset().mockResolvedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const result = await dispatchFacade('inspect', 'graph_walk', { walk_action: 'start' }, {
      ...graphReadBackend,
      resolveRepo,
    } as unknown as LocalBackend);
    expect(result).toMatchObject(error);
    expect(dispatchSuperMock).toHaveBeenCalledWith('gn_graph_walk', { action: 'start' }, 'fixture');
  });

  it('advertises legacy walk bounds without requiring walk fields on other actions', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'inspect')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('graph_walk');
    expect(schema.properties).toMatchObject({
      walk_action: { enum: ['start', 'step', 'status'] },
      walkId: { type: 'string' },
      seedSymbol: { type: 'string' },
      navigationPolicy: { default: 'follow-calls' },
      maxSteps: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
      maxFrontier: { type: 'integer', default: 100, minimum: 1, maximum: 250 },
      maxExpansionPerStep: { type: 'integer', default: 5, minimum: 1, maximum: 25 },
    });
    expect(schema.properties.walk_action).not.toHaveProperty('default');
  });
});

describe('propose location facade mapping', () => {
  it.each([{}, { language: 'python' }])(
    'forwards options without applying defaults: %j',
    async (options) => {
      const response = { directory: 'src/core', warnings: ['review suggested location'] };
      dispatchSuperMock.mockReset().mockResolvedValue(response);
      const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
      const callTool = vi.fn();
      const args = {
        action: 'propose_location',
        repo: 'fixture',
        intent: 'add parser',
        extra: { preserved: true },
        ...options,
      };
      const original = structuredClone(args);

      const result = await dispatchFacade('inspect', 'propose_location', args, {
        ...graphReadBackend,
        resolveRepo,
        callTool,
      } as unknown as LocalBackend);

      expect(resolveRepo).toHaveBeenCalledExactlyOnceWith('fixture');
      expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
        'gn_propose_location',
        original,
        'fixture',
      );
      expect(callTool).not.toHaveBeenCalled();
      expect(args).toEqual(original);
      expect(result).toMatchObject(response);
      if (!('language' in options)) {
        expect(dispatchSuperMock.mock.calls[0][1]).not.toHaveProperty('language');
      }
    },
  );

  it('preserves thrown handler errors', async () => {
    const error = new Error('location unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const args = { repo: 'fixture', intent: 'add parser' };

    await expect(
      dispatchFacade('inspect', 'propose_location', args, {
        ...graphReadBackend,
        resolveRepo,
      } as unknown as LocalBackend),
    ).rejects.toBe(error);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
      'gn_propose_location',
      args,
      'fixture',
    );
  });

  it('advertises location fields without requiring intent globally', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'inspect')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toContain('propose_location');
    expect(schema.properties).toMatchObject({
      intent: { type: 'string' },
      language: { type: 'string' },
    });
  });
});

describe('module and related facade mappings', () => {
  it.each([
    {
      action: 'module',
      method: 'gn_explain_module',
      fields: { filePath: 'src/foo.ts' },
      options: {},
    },
    {
      action: 'module',
      method: 'gn_explain_module',
      fields: { filePath: 'src/foo.ts' },
      options: {
        includeSkeleton: false,
        includePublicAPI: false,
        includeCoChange: false,
        recentTouchDays: 0,
        format: 'files',
      },
    },
    { action: 'related', method: 'gn_find_related', fields: { symbol: 'foo' }, options: {} },
    {
      action: 'related',
      method: 'gn_find_related',
      fields: { symbol: 'foo' },
      options: {
        includeCallers: false,
        includeCallees: false,
        includeCoChanged: false,
        includeClusterSiblings: false,
        includeCrossRepo: false,
        maxItemsPerCategory: 2.5,
        format: 'files',
      },
    },
  ])(
    'forwards $action options unchanged: $options',
    async ({ action, method, fields, options }) => {
      const response = { warnings: ['preserved handler warning'], result: { available: true } };
      dispatchSuperMock.mockReset().mockResolvedValue(response);
      const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
      const callTool = vi.fn();
      const args = { action, repo: 'fixture', ...fields, ...options, extra: { preserved: true } };
      const original = structuredClone(args);

      expect(
        await dispatchFacade('inspect', action, args, {
          ...graphReadBackend,
          resolveRepo,
          callTool,
        } as unknown as LocalBackend),
      ).toMatchObject(response);
      expect(resolveRepo).toHaveBeenCalledExactlyOnceWith('fixture');
      expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(method, original, 'fixture');
      expect(callTool).not.toHaveBeenCalled();
      expect(args).toEqual(original);
    },
  );

  it.each([
    ['module', 'gn_explain_module', { filePath: 'src/foo.ts' }],
    ['related', 'gn_find_related', { symbol: 'foo' }],
  ] as const)('preserves %s thrown handler error identity', async (action, method, fields) => {
    const error = new Error('handler unavailable');
    dispatchSuperMock.mockReset().mockRejectedValue(error);
    const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
    const args = { action, ...fields };

    await expect(
      dispatchFacade('inspect', action, args, {
        ...graphReadBackend,
        resolveRepo,
      } as unknown as LocalBackend),
    ).rejects.toBe(error);
    expect(resolveRepo).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(method, args, 'fixture');
  });

  it('advertises distinct module and context paths and legacy neighborhood defaults', () => {
    const schema = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'inspect')!.inputSchema;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toEqual(expect.arrayContaining(['module', 'related']));
    expect(schema.properties).toMatchObject({
      filePath: { type: 'string' },
      file_path: { type: 'string', description: 'Context file path disambiguator.' },
      symbol: { type: 'string' },
      includeSkeleton: { type: 'boolean', default: true },
      includePublicAPI: { type: 'boolean', default: true },
      includeCoChange: { type: 'boolean', default: true },
      recentTouchDays: { type: 'number', default: 30 },
      includeCallers: { type: 'boolean', default: true },
      includeCallees: { type: 'boolean', default: true },
      includeCoChanged: { type: 'boolean', default: true },
      includeClusterSiblings: { type: 'boolean', default: true },
      includeCrossRepo: { type: 'boolean', default: false },
      maxItemsPerCategory: { type: 'number', default: 10 },
      format: { type: 'string', enum: ['json', 'files'] },
    });
    expect(schema.properties.filePath).not.toBe(schema.properties.file_path);
    expect(schema.properties.format).not.toHaveProperty('default');
  });
});

describe('facade operation mapping', () => {
  it.each([
    { operation: 'get', fields: { session_id: 'x', key: 'plan', repo: 'fixture' } },
    { operation: 'set', fields: { session_id: 'x', key: 'plan', value: 'next', repo: 'fixture' } },
    { operation: 'list', fields: { session_id: 'x', repo: 'fixture' } },
  ])(
    'maps session operation $operation and forwards its fields to the backend',
    async ({ operation, fields }) => {
      const callTool = vi.fn(async () => ({ ok: true }));
      const args = { action: 'session', operation, ...fields };

      await dispatchFacade('manage', 'session', args, { callTool } as unknown as LocalBackend);

      expect(callTool).toHaveBeenCalledWith('session', { action: operation, ...fields });
      expect(args).toEqual({ action: 'session', operation, ...fields });
    },
  );

  it.each([undefined, null, 'stage', 'session', '', 1])(
    'rejects invalid session operation %s before dispatch',
    async (operation) => {
      const callTool = vi.fn();

      await expect(
        dispatchFacade('manage', 'session', { action: 'session', operation }, {
          callTool,
        } as unknown as LocalBackend),
      ).rejects.toThrow('manage(action: "session") requires operation: "get" | "set" | "list".');
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  it.each([
    { operation: undefined, expected: 'stage' },
    { operation: 'stage', expected: 'stage' },
    { operation: 'apply', expected: 'apply' },
  ])('maps sandbox operation $operation to $expected', async ({ operation, expected }) => {
    const callTool = vi.fn(async () => ({ ok: true }));

    await dispatchFacade('refactor', 'sandbox', { action: 'sandbox', operation, repo: 'fixture' }, {
      callTool,
    } as unknown as LocalBackend);

    expect(callTool).toHaveBeenCalledWith('sandbox', { action: expected, repo: 'fixture' });
  });

  it.each(['list', 'sandbox', '', 1])(
    'rejects invalid sandbox operation %s before dispatch',
    async (operation) => {
      const callTool = vi.fn();

      await expect(
        dispatchFacade('refactor', 'sandbox', { action: 'sandbox', operation }, {
          callTool,
        } as unknown as LocalBackend),
      ).rejects.toThrow('refactor(action: "sandbox") requires operation: "stage" | "apply".');
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  it.each([{ action: 'route_map' }, { action: 'route_map', operation: 'list' }])(
    'preserves unrelated facade arguments %j',
    async (args) => {
      const callTool = vi.fn(async () => ({ ok: true }));

      await dispatchFacade('manage', 'route_map', args, { callTool } as unknown as LocalBackend);

      expect(callTool).toHaveBeenCalledWith('route_map', args);
    },
  );

  it('advertises the existing session-key contract without requiring session fields for route_map', () => {
    const tool = ONTOINDEX_FACADE_TOOLS.find((entry) => entry.name === 'manage')!;

    expect(tool.inputSchema.properties).toMatchObject({
      session_id: { type: 'string' },
      key: { type: 'string' },
      value: { type: 'string' },
      repo: { type: 'string' },
    });
    expect(tool.description).toContain(
      '"list" requires session_id and lists keys within that session',
    );
    expect(tool.description).toContain('"get" requires session_id/key');
    expect(tool.description).toContain('"set" requires session_id/key/value');
    expect(tool.description).toContain('Session fields are not required for action "route_map"');
    expect(tool.inputSchema.required).toEqual(['action']);
  });

  it.each([
    { name: 'manage', operations: ['get', 'set', 'list'], action: 'session' },
    { name: 'refactor', operations: ['stage', 'apply'], action: 'sandbox' },
  ])('advertises supported $name operations', ({ name, operations, action }) => {
    const tool = ONTOINDEX_FACADE_TOOLS.find((entry) => entry.name === name)!;

    expect(tool.inputSchema.properties.operation).toMatchObject({
      type: 'string',
      enum: operations,
    });
    expect(tool.inputSchema.properties.operation.description).toContain(action);
    expect(tool.inputSchema.required).toEqual(['action']);
  });
});
