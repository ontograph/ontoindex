import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchFacade, type FacadeTool } from '../../src/mcp/facade/dispatch.js';
import { ONTOINDEX_FACADE_TOOLS } from '../../src/mcp/facade/tool-definitions.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';

const { dispatchSuperMock } = vi.hoisted(() => ({ dispatchSuperMock: vi.fn() }));
vi.mock('../../src/mcp/super/dispatch.js', () => ({ dispatchSuper: dispatchSuperMock }));

function createBackend() {
  const callTool = vi.fn().mockResolvedValue({ ok: true });
  const resolveRepo = vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' });
  return { callTool, resolveRepo };
}

beforeEach(() => dispatchSuperMock.mockReset());

describe('facade normalization gaps', () => {
  const selectors = [
    ['lock_action', 'audit', 'session_lock', 'validate'],
    ['walk_action', 'inspect', 'graph_walk', 'status'],
    ['job_action', 'manage', 'analyze_job', 'status'],
  ] as const;
  const misplaced = selectors.flatMap(([selector, owner, operation, value]) =>
    ONTOINDEX_FACADE_TOOLS.flatMap(({ name, inputSchema }) =>
      (inputSchema.properties.action.enum ?? [])
        .filter((action) => name !== owner || action !== operation)
        .map((action) => ({
          tool: name as FacadeTool,
          action: String(action),
          selector,
          owner,
          operation,
          value,
        })),
    ),
  );

  it.each(misplaced)(
    'rejects $selector on $tool/$action with the exact message',
    async ({ tool, action, selector, owner, operation, value }) => {
      const backend = createBackend();
      const args = {
        ...(tool === 'inspect' && action === 'graph_walk' ? { walk_action: 'status' } : {}),
        [selector]: value,
      };
      await expect(
        dispatchFacade(tool, action, args, backend as unknown as LocalBackend),
      ).rejects.toEqual(
        new Error(`${selector} is only supported for ${owner}(action: "${operation}").`),
      );
      expect(backend.callTool).not.toHaveBeenCalled();
      expect(backend.resolveRepo).not.toHaveBeenCalled();
      expect(dispatchSuperMock).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', null, 0, false, {}, []])(
    'rejects non-string or empty jobId %j exactly',
    async (jobId) => {
      const backend = createBackend();
      await expect(
        dispatchFacade('manage', 'analyze_job', { jobId }, backend as unknown as LocalBackend),
      ).rejects.toEqual(new Error('manage(action: "analyze_job") requires jobId.'));
      expect(backend.resolveRepo).not.toHaveBeenCalled();
      expect(backend.callTool).not.toHaveBeenCalled();
      expect(dispatchSuperMock).not.toHaveBeenCalled();
    },
  );

  it.each([null, '', 1, 'delete'])('rejects invalid job_action %j exactly', async (job_action) => {
    const backend = createBackend();
    await expect(
      dispatchFacade(
        'manage',
        'analyze_job',
        { jobId: 'job-1', job_action },
        backend as unknown as LocalBackend,
      ),
    ).rejects.toEqual(
      new Error('manage(action: "analyze_job") requires job_action: "status" | "cancel".'),
    );
    expect(backend.resolveRepo).not.toHaveBeenCalled();
    expect(backend.callTool).not.toHaveBeenCalled();
    expect(dispatchSuperMock).not.toHaveBeenCalled();
  });

  it('does not advertise a job_action default that unrelated actions reject', async () => {
    const jobAction = ONTOINDEX_FACADE_TOOLS.find(({ name }) => name === 'manage')!.inputSchema
      .properties.job_action;
    expect(jobAction).not.toHaveProperty('default');
    expect(jobAction.enum).toEqual(['status', 'cancel']);
    // A client that injected the old advertised default would still be rejected here.
    const backend = createBackend();
    await expect(
      dispatchFacade(
        'manage',
        'route_map',
        { job_action: 'status' },
        backend as unknown as LocalBackend,
      ),
    ).rejects.toEqual(new Error('job_action is only supported for manage(action: "analyze_job").'));
    expect(backend.callTool).not.toHaveBeenCalled();
    expect(backend.resolveRepo).not.toHaveBeenCalled();
    expect(dispatchSuperMock).not.toHaveBeenCalled();
  });

  const aliases: Array<
    [FacadeTool, string, string, Record<string, unknown>, Record<string, unknown>]
  > = [
    ['inspect', 'context', 'context', {}, { name: 'alias' }],
    ['inspect', 'context', 'context', { name: 'preferred' }, { name: 'preferred' }],
    ['inspect', 'context', 'context', { uid: 'preferred' }, { uid: 'preferred' }],
    ['inspect', 'evidence', 'evidence_pack', {}, { targets: ['alias'] }],
    [
      'inspect',
      'evidence',
      'evidence_pack',
      { targets: ['preferred'] },
      { targets: ['preferred'] },
    ],
    ['inspect', 'shape', 'shape_check', {}, { route: 'alias' }],
    ['inspect', 'shape', 'shape_check', { route: 'preferred' }, { route: 'preferred' }],
    ['inspect', 'ipc', 'ipc_trace', {}, { symbol_name: 'alias' }],
    ['inspect', 'ipc', 'ipc_trace', { symbol_name: 'preferred' }, { symbol_name: 'preferred' }],
    ['impact', 'symbol', 'impact', {}, { direction: 'upstream' }],
    ['impact', 'symbol', 'impact', { direction: 'downstream' }, { direction: 'downstream' }],
    ['impact', 'batch', 'impact_batch', {}, { targets: ['alias'] }],
    ['impact', 'batch', 'impact_batch', { targets: ['preferred'] }, { targets: ['preferred'] }],
    ['impact', 'route', 'api_impact', {}, { route: 'alias' }],
    ['impact', 'route', 'api_impact', { route: 'preferred' }, { route: 'preferred' }],
    ['refactor', 'replace', 'replace_symbol', {}, { uid: 'alias' }],
    ['refactor', 'replace', 'replace_symbol', { uid: 'preferred' }, { uid: 'preferred' }],
  ];
  it.each(aliases)(
    'normalizes %s/%s without overriding explicit fields: %j',
    async (tool, action, method, fields, expected) => {
      const backend = createBackend();
      const args = { action, target: 'alias', ...fields };
      const original = structuredClone(args);
      await dispatchFacade(tool, action, args, backend as unknown as LocalBackend);
      expect(backend.callTool).toHaveBeenCalledExactlyOnceWith(method, {
        action,
        target: 'alias',
        ...expected,
      });
      expect(args).toEqual(original);
    },
  );

  it.each([
    ['Function:src/foo.ts:foo', {}, { symbol_uid: 'Function:src/foo.ts:foo' }],
    ['foo', {}, { symbol_name: 'foo' }],
    ['function:foo', {}, { symbol_name: 'function:foo' }],
    ['F:foo', {}, { symbol_name: 'F:foo' }],
    ['Function:foo', { symbol_name: 'preferred' }, { symbol_name: 'preferred' }],
    ['foo', { symbol_uid: 'Function:preferred' }, { symbol_uid: 'Function:preferred' }],
    [
      'foo',
      { symbol_uid: 'Function:preferred', symbol_name: 'preferred' },
      { symbol_uid: 'Function:preferred', symbol_name: 'preferred' },
    ],
  ] as Array<[string, Record<string, unknown>, Record<string, unknown>]>)(
    'normalizes rename target %s with %j',
    async (target, fields, expected) => {
      const backend = createBackend();
      await dispatchFacade(
        'refactor',
        'rename',
        { target, ...fields },
        backend as unknown as LocalBackend,
      );
      expect(backend.callTool).toHaveBeenCalledExactlyOnceWith('rename', { target, ...expected });
    },
  );

  it.each(['trace', 'drift', 'context', 'readiness'])(
    'defaults docs action to %s and preserves an explicit action',
    async (action) => {
      const backend = createBackend();
      await dispatchFacade('docs', action, {}, backend as unknown as LocalBackend);
      expect(backend.callTool).toHaveBeenCalledExactlyOnceWith('docs', { action });
      backend.callTool.mockClear();
      await dispatchFacade(
        'docs',
        action,
        { action: 'preferred' },
        backend as unknown as LocalBackend,
      );
      expect(backend.callTool).toHaveBeenCalledExactlyOnceWith('docs', { action: 'preferred' });
    },
  );

  it.each([{ lines: [{ type: 'symbol', query: 'preferred', lineNumber: 1 }] }, null])(
    'preserves explicit typedQuery %j without parsing an invalid document',
    async (typedQuery) => {
      const backend = createBackend();
      const args = { typed_query: true, query: 'intent:', typedQuery };
      await dispatchFacade('search', 'semantic', args, backend as unknown as LocalBackend);
      expect(backend.callTool).toHaveBeenCalledExactlyOnceWith('query', args);
    },
  );
});
