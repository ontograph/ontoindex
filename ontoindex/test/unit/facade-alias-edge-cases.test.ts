import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchFacade, type FacadeTool } from '../../src/mcp/facade/dispatch.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';

const { dispatchSuperMock } = vi.hoisted(() => ({ dispatchSuperMock: vi.fn() }));
vi.mock('../../src/mcp/super/dispatch.js', () => ({ dispatchSuper: dispatchSuperMock }));

function createBackend() {
  const callTool = vi.fn().mockResolvedValue({ ok: true });
  const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
  const ensureRepoInitialized = vi.fn().mockResolvedValue(undefined);
  return { callTool, resolveRepo, ensureRepoInitialized };
}

beforeEach(() => dispatchSuperMock.mockReset());

type Alias = {
  tool: FacadeTool;
  action: string;
  method: string;
  field: string;
  target: string;
  fallback: Record<string, unknown>;
};

const aliases: Alias[] = [
  {
    tool: 'inspect',
    action: 'context',
    method: 'context',
    field: 'name',
    target: 'alias',
    fallback: { name: 'alias' },
  },
  {
    tool: 'inspect',
    action: 'context',
    method: 'context',
    field: 'uid',
    target: 'alias',
    fallback: { name: 'alias' },
  },
  {
    tool: 'inspect',
    action: 'evidence',
    method: 'evidence_pack',
    field: 'targets',
    target: 'alias',
    fallback: { targets: ['alias'] },
  },
  {
    tool: 'inspect',
    action: 'shape',
    method: 'shape_check',
    field: 'route',
    target: 'alias',
    fallback: { route: 'alias' },
  },
  {
    tool: 'inspect',
    action: 'ipc',
    method: 'ipc_trace',
    field: 'symbol_name',
    target: 'alias',
    fallback: { symbol_name: 'alias' },
  },
  {
    tool: 'impact',
    action: 'symbol',
    method: 'impact',
    field: 'direction',
    target: 'alias',
    fallback: { direction: 'upstream' },
  },
  {
    tool: 'impact',
    action: 'batch',
    method: 'impact_batch',
    field: 'targets',
    target: 'alias',
    fallback: { targets: ['alias'] },
  },
  {
    tool: 'impact',
    action: 'route',
    method: 'api_impact',
    field: 'route',
    target: 'alias',
    fallback: { route: 'alias' },
  },
  {
    tool: 'refactor',
    action: 'rename',
    method: 'rename',
    field: 'symbol_name',
    target: 'alias',
    fallback: { symbol_name: 'alias' },
  },
  {
    tool: 'refactor',
    action: 'rename',
    method: 'rename',
    field: 'symbol_uid',
    target: 'Function:alias',
    fallback: { symbol_uid: 'Function:alias' },
  },
  {
    tool: 'refactor',
    action: 'replace',
    method: 'replace_symbol',
    field: 'uid',
    target: 'alias',
    fallback: { uid: 'alias' },
  },
  {
    tool: 'docs',
    action: 'trace',
    method: 'docs',
    field: 'action',
    target: 'alias',
    fallback: { action: 'trace' },
  },
];

describe.each(aliases)('$tool/$action: $field with target', (alias) => {
  // Falsy preferred fields are replaced (or bypassed for context uid) by the alias/default.
  it.each([['empty string, null, zero, and false', ['', null, 0, false]]] as const)(
    'characterizes: %s preferred fields fall back',
    async (_label, values) => {
      for (const value of values) {
        const backend = createBackend();
        const args = { target: alias.target, [alias.field]: value };
        await dispatchFacade(alias.tool, alias.action, args, backend as unknown as LocalBackend);
        expect(backend.callTool).toHaveBeenCalledExactlyOnceWith(alias.method, {
          ...args,
          ...alias.fallback,
        });
        expect(dispatchSuperMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['preferred'])('retains conflicting preferred value %s', async (value) => {
    const backend = createBackend();
    const args = { target: alias.target, [alias.field]: value };
    await dispatchFacade(alias.tool, alias.action, args, backend as unknown as LocalBackend);
    expect(backend.callTool).toHaveBeenCalledExactlyOnceWith(alias.method, args);
  });

  // Truthy values bypass type validation, including arrays where a string is expected.
  it('characterizes: empty array and wrong-type number retain precedence', async () => {
    for (const value of [[], 42]) {
      const backend = createBackend();
      const args = { target: alias.target, [alias.field]: value };
      await dispatchFacade(alias.tool, alias.action, args, backend as unknown as LocalBackend);
      expect(backend.callTool).toHaveBeenCalledExactlyOnceWith(alias.method, args);
      expect(dispatchSuperMock).not.toHaveBeenCalled();
    }
  });
});

type Selector = {
  tool: FacadeTool;
  action: string;
  field: string;
  method: string;
  superTool?: true;
  value: string;
  error: string;
};

const selectors: Selector[] = [
  {
    tool: 'audit',
    action: 'session_lock',
    field: 'lock_action',
    method: 'gn_audit_session_lock',
    superTool: true,
    value: 'validate',
    error:
      'audit(action: "session_lock") requires lock_action: "create" | "load" | "validate" when supplied.',
  },
  {
    tool: 'inspect',
    action: 'graph_walk',
    field: 'walk_action',
    method: 'gn_graph_walk',
    superTool: true,
    value: 'status',
    error: 'inspect(action: "graph_walk") requires walk_action: "start" | "step" | "status".',
  },
  {
    tool: 'manage',
    action: 'analyze_job',
    field: 'job_action',
    method: 'gn_analyze_job',
    superTool: true,
    value: 'cancel',
    error: 'manage(action: "analyze_job") requires job_action: "status" | "cancel".',
  },
  {
    tool: 'manage',
    action: 'session',
    field: 'operation',
    method: 'session',
    value: 'list',
    error: 'manage(action: "session") requires operation: "get" | "set" | "list".',
  },
  {
    tool: 'refactor',
    action: 'sandbox',
    field: 'operation',
    method: 'sandbox',
    value: 'apply',
    error: 'refactor(action: "sandbox") requires operation: "stage" | "apply".',
  },
];

describe.each(selectors)('$tool/$action: $field selector', (selector) => {
  it.each([
    ['empty string, null, zero, false, empty array, and number', ['', null, 0, false, [], 42]],
  ] as const)('handles %s exactly before forwarding', async (_label, values) => {
    for (const value of values) {
      const backend = createBackend();
      const args = { jobId: 'job-1', action: 'conflict', [selector.field]: value };
      if (selector.action === 'sandbox' && value === null) {
        await dispatchFacade(
          selector.tool,
          selector.action,
          args,
          backend as unknown as LocalBackend,
        );
        expect(backend.callTool).toHaveBeenCalledExactlyOnceWith('sandbox', {
          jobId: 'job-1',
          action: 'stage',
        });
      } else {
        await expect(
          dispatchFacade(selector.tool, selector.action, args, backend as unknown as LocalBackend),
        ).rejects.toEqual(new Error(selector.error));
        expect(backend.callTool).not.toHaveBeenCalled();
      }
      expect(backend.resolveRepo).not.toHaveBeenCalled();
      expect(dispatchSuperMock).not.toHaveBeenCalled();
    }
  });

  it.each(['conflict'])('selector replaces conflicting action %s', async (action) => {
    const backend = createBackend();
    const args = { jobId: 'job-1', action, [selector.field]: selector.value };
    await dispatchFacade(selector.tool, selector.action, args, backend as unknown as LocalBackend);
    const expected = { jobId: 'job-1', action: selector.value };
    if (selector.superTool) {
      expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(
        selector.method,
        expected,
        'fixture',
      );
      expect(backend.callTool).not.toHaveBeenCalled();
    } else {
      expect(backend.callTool).toHaveBeenCalledExactlyOnceWith(selector.method, expected);
      expect(dispatchSuperMock).not.toHaveBeenCalled();
    }
  });
});

describe('guarded aliases and typed query selector', () => {
  it.each(['context', 'rename'])(
    'characterizes: %s sibling identifier blocks alias replacement of an empty name',
    async (action) => {
      // A truthy sibling identifier leaves even an empty preferred name untouched.
      const backend = createBackend();
      const args =
        action === 'context'
          ? { target: 'alias', name: '', uid: 'preferred' }
          : { target: 'alias', symbol_name: '', symbol_uid: 'Function:preferred' };
      await dispatchFacade(
        action === 'context' ? 'inspect' : 'refactor',
        action,
        args,
        backend as unknown as LocalBackend,
      );
      expect(backend.callTool).toHaveBeenCalledExactlyOnceWith(action, args);
    },
  );

  it.each([['empty and non-string targets', ['', null, 0, false, [], 42]]] as const)(
    'ignores %s as context aliases',
    async (_label, values) => {
      for (const target of values) {
        const backend = createBackend();
        const args = { target };
        await dispatchFacade('inspect', 'context', args, backend as unknown as LocalBackend);
        expect(backend.callTool).toHaveBeenCalledExactlyOnceWith('context', args);
      }
    },
  );

  it.each([['explicit typedQuery values', ['', null, 0, false, [], 42, 'preferred']]] as const)(
    'characterizes: %s bypass query parsing',
    async (_label, values) => {
      // Any defined typedQuery suppresses parsing, including invalid scalar values.
      for (const typedQuery of values) {
        const backend = createBackend();
        const args = { typed_query: true, query: 'intent:', typedQuery };
        await dispatchFacade('search', 'semantic', args, backend as unknown as LocalBackend);
        expect(backend.callTool).toHaveBeenCalledExactlyOnceWith('query', args);
      }
    },
  );

  it.each([['non-true typed_query values', ['', null, 0, false, [], 42, 'true']]] as const)(
    'forwards %s without parsing',
    async (_label, values) => {
      for (const typed_query of values) {
        const backend = createBackend();
        const args = { typed_query, query: 'intent:' };
        await dispatchFacade('search', 'semantic', args, backend as unknown as LocalBackend);
        expect(backend.callTool).toHaveBeenCalledExactlyOnceWith('query', args);
      }
    },
  );
});
