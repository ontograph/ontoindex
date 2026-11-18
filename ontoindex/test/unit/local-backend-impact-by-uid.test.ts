import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoHandle } from 'ontoindex-shared';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { impactByUid } from '../../src/mcp/local/backend-impact.js';
import { isAutomaticWorkspaceEnabled } from '../../src/mcp/local/backend-overlay.js';
import { LbugOpenError } from '../../src/core/lbug/open-error.js';
import type { GroupToolPort } from '../../src/core/group/service.js';

vi.mock('../../src/mcp/local/backend-impact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/local/backend-impact.js')>()),
  impactByUid: vi.fn(),
}));
vi.mock('../../src/mcp/local/backend-overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/local/backend-overlay.js')>()),
  isAutomaticWorkspaceEnabled: vi.fn(),
}));

// Expose only the existing private owners needed to isolate this public method.
interface ImpactBackendInternals {
  repos: Map<string, RepoHandle>;
  ensureInitialized(repoId: string): Promise<void>;
  dispatchRepoTool(method: string, params: Record<string, unknown>): Promise<unknown>;
  operations: Set<Promise<unknown>>;
  operationContext: { getStore(): { signal?: AbortSignal } | undefined };
}

describe('LocalBackend UID impact', () => {
  const repo = {
    id: 'repo',
    name: 'repo',
    repoPath: '/repo',
    storagePath: '/repo/.ontoindex',
    lbugPath: '/repo/.ontoindex/lbug',
  };
  const uid = 'Function:src/auth.ts:login';
  const opts = { maxDepth: 1, relationTypes: ['CALLS'], minConfidence: 0, includeTests: false };

  beforeEach(() => {
    vi.mocked(isAutomaticWorkspaceEnabled).mockReset().mockReturnValue(true);
    vi.mocked(impactByUid).mockReset().mockResolvedValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  function setup() {
    const backend = new LocalBackend();
    const internals = backend as unknown as ImpactBackendInternals;
    internals.repos.set(repo.id, repo);
    const init = vi.spyOn(backend, 'init').mockResolvedValue(true);
    const ensure = vi.spyOn(internals, 'ensureInitialized').mockResolvedValue(undefined);
    const dispatch = vi.spyOn(internals, 'dispatchRepoTool').mockResolvedValue(null);
    return { backend, internals, init, ensure, dispatch };
  }

  it('does no preparation when already aborted', async () => {
    const { backend, init, ensure, dispatch } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      backend.impactByUid(repo.id, uid, 'upstream', { ...opts, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(init).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(['init', 'ensure', 'dispatch'] as const)(
    'stops after abort during %s without swallowing resource errors',
    async (phase) => {
      for (const resource of [false, true]) {
        const state = setup();
        const controller = new AbortController();
        const native = Object.assign(new Error('native open failed'), { code: 'ENOMEM' });
        const abort = () => {
          controller.abort();
          if (resource) throw new Error('preparation failed', { cause: native });
        };
        if (phase === 'init')
          state.init.mockImplementation(async () => {
            abort();
            return true;
          });
        else if (phase === 'ensure')
          state.ensure.mockImplementation(async () => {
            abort();
          });
        else
          state.dispatch.mockImplementation(async () => {
            abort();
            return null;
          });
        const result = state.backend.impactByUid(repo.id, uid, 'upstream', {
          ...opts,
          signal: controller.signal,
        });
        if (resource) await expect(result).rejects.toBe(native);
        else await expect(result).rejects.toMatchObject({ name: 'AbortError' });
        if (phase === 'init') expect(state.ensure).not.toHaveBeenCalled();
        if (phase !== 'dispatch') expect(state.dispatch).not.toHaveBeenCalled();
        vi.restoreAllMocks();
      }
    },
  );

  it.each([true, false])('forwards signal in automatic mode %s', async (automatic) => {
    const { backend, dispatch } = setup();
    vi.mocked(isAutomaticWorkspaceEnabled).mockReturnValue(automatic);
    const signal = new AbortController().signal;
    await backend.impactByUid(repo.id, uid, 'upstream', { ...opts, signal });
    if (automatic)
      expect(dispatch).toHaveBeenCalledWith('impact', expect.objectContaining({ signal }));
    else expect(impactByUid).toHaveBeenCalledWith(repo, uid, 'upstream', { ...opts, signal });
  });

  it.each([
    ['impact', 'inherited'],
    ['impact', 'explicit'],
    ['impactByUid', 'inherited'],
    ['impactByUid', 'explicit'],
  ] as const)(
    'tracks %s until settlement when %s aborts the composed signal',
    async (method, source) => {
      const { backend, internals, dispatch } = setup();
      const inherited = new AbortController();
      const explicit = new AbortController();
      let settle!: (result: null) => void;
      let started!: () => void;
      const dispatchStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      dispatch.mockImplementation(
        async () =>
          new Promise<null>((resolve) => {
            settle = resolve;
            started();
          }),
      );
      const port = (backend.getGroupService() as unknown as { port: GroupToolPort }).port;
      let operation!: Promise<unknown>;
      await backend.withOperation(
        async () => {
          operation =
            method === 'impact'
              ? port.impact(
                  repo,
                  { target: uid, direction: 'upstream' },
                  { signal: explicit.signal },
                )
              : port.impactByUid(repo.id, uid, 'upstream', { ...opts, signal: explicit.signal });
        },
        { signal: inherited.signal },
      );
      await dispatchStarted;
      const signal = dispatch.mock.calls[0][1].signal as AbortSignal;
      expect(signal).not.toBe(inherited.signal);
      expect(signal).not.toBe(explicit.signal);
      (source === 'inherited' ? inherited : explicit).abort();
      expect(signal.aborted).toBe(true);
      expect(internals.operations.size).toBe(1);
      const outcome = operation.then(
        () => undefined,
        () => undefined,
      );
      settle(null);
      await outcome;
      expect(internals.operations.size).toBe(0);
    },
  );

  it.each(['inherited', 'explicit'] as const)('retains a lone %s signal', async (source) => {
    const { backend, internals, dispatch } = setup();
    const signal = new AbortController().signal;
    const port = (backend.getGroupService() as unknown as { port: GroupToolPort }).port;
    await backend.withOperation(
      async () => {
        await port.impact(
          repo,
          { target: uid, direction: 'upstream' },
          source === 'explicit' ? { signal } : undefined,
        );
        expect(internals.operationContext.getStore()?.signal).toBe(
          source === 'inherited' ? signal : undefined,
        );
      },
      source === 'inherited' ? { signal } : undefined,
    );
    expect(dispatch).toHaveBeenCalledWith('impact', expect.objectContaining({ signal }));
  });

  it.each(['init', 'ensure'] as const)('preserves resource errors from %s', async (phase) => {
    const state = setup();
    const error = Object.assign(new Error('open failed'), { code: 'ENOMEM' });
    state[phase].mockRejectedValue(error);
    await expect(state.backend.impactByUid(repo.id, uid, 'upstream', opts)).rejects.toBe(error);
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it.each(['init', 'ensure'] as const)('returns null for ordinary %s errors', async (phase) => {
    const state = setup();
    state[phase].mockRejectedValue(new Error('database unavailable'));
    await expect(state.backend.impactByUid(repo.id, uid, 'upstream', opts)).resolves.toBeNull();
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it('returns null for an unknown repo', async () => {
    const { backend, internals, dispatch } = setup();
    internals.repos.clear();
    await expect(backend.impactByUid(repo.id, uid, 'upstream', opts)).resolves.toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('preserves resource errors from automatic workspace dispatch', async () => {
    const { backend, dispatch } = setup();
    const error = new Error('allocation failed');
    dispatch.mockRejectedValue(error);
    await expect(backend.impactByUid(repo.id, uid, 'upstream', opts)).rejects.toBe(error);
  });

  it('returns null for ordinary automatic workspace dispatch errors', async () => {
    const { backend, dispatch } = setup();
    dispatch.mockRejectedValue(new Error('workspace unavailable'));
    await expect(backend.impactByUid(repo.id, uid, 'upstream', opts)).resolves.toBeNull();
  });

  it.each(['init', 'ensure', 'dispatch'] as const)(
    'preserves the deepest wrapped %s resource cause',
    async (phase) => {
      const state = setup();
      const native = Object.assign(new Error('native open failed'), { code: 'ENOMEM' });
      const wrapped = new Error('workspace_preparation_failed', {
        cause: new LbugOpenError('/repo/.ontoindex/lbug', native),
      });
      state[phase].mockRejectedValue(wrapped);
      await expect(state.backend.impactByUid(repo.id, uid, 'upstream', opts)).rejects.toBe(native);
    },
  );

  it.each(['init', 'dispatch'] as const)(
    'keeps ordinary and cyclic %s cause chains nullable',
    async (phase) => {
      const state = setup();
      const ordinary = new Error('preparation failed', { cause: new Error('unavailable') });
      state[phase].mockRejectedValue(ordinary);
      await expect(state.backend.impactByUid(repo.id, uid, 'upstream', opts)).resolves.toBeNull();
      const cyclic = new Error('cycle', { cause: undefined });
      cyclic.cause = cyclic;
      state[phase].mockRejectedValue(cyclic);
      await expect(state.backend.impactByUid(repo.id, uid, 'upstream', opts)).resolves.toBeNull();
    },
  );

  it.each([7, 8])('bounds cause inspection at eight nodes (wrappers: %i)', async (count) => {
    const { backend, dispatch } = setup();
    const resource = Object.assign(new Error('open failed'), { code: 'EMFILE' });
    let wrapped: Error = resource;
    for (let index = 0; index < count; index++)
      wrapped = new Error('preparation failed', { cause: wrapped });
    dispatch.mockRejectedValue(wrapped);
    const result = backend.impactByUid(repo.id, uid, 'upstream', opts);
    if (count === 7) await expect(result).rejects.toBe(resource);
    else await expect(result).resolves.toBeNull();
  });

  it.each([null, { error: 'unavailable' }, { status: 'ambiguous', candidates: [] }])(
    'returns null for unsuccessful automatic results: %j',
    async (result) => {
      const { backend, dispatch } = setup();
      dispatch.mockResolvedValue(result);
      await expect(backend.impactByUid(repo.id, uid, 'upstream', opts)).resolves.toBeNull();
      expect(impactByUid).not.toHaveBeenCalled();
    },
  );

  it('returns the automatic result and forwards UID impact options', async () => {
    const { backend, dispatch } = setup();
    const result = { target: { id: uid }, impactedCount: 0, risk: 'LOW' };
    dispatch.mockResolvedValue(result);
    await expect(backend.impactByUid(repo.id, uid, 'downstream', opts)).resolves.toBe(result);
    expect(dispatch).toHaveBeenCalledWith('impact', {
      repo: repo.id,
      target: uid,
      target_uid: uid,
      direction: 'downstream',
      ...opts,
    });
    expect(impactByUid).not.toHaveBeenCalled();
  });

  it('retains usable routed evidence when cancellation races with return', async () => {
    const { backend, dispatch } = setup();
    const controller = new AbortController();
    const routed = {
      target: { id: uid },
      impactedCount: 1,
      risk: 'LOW',
      byDepth: { 1: [{ id: 'caller' }] },
      rawCounts: { total: 1, direct: 1, byDepth: { 1: 1 }, riskReasons: [] },
      source: 'workspace-graph',
      freshness: { state: 'dirty' },
    };
    dispatch.mockImplementation(async () => {
      controller.abort();
      return routed;
    });
    const result = await backend.impactByUid(repo.id, uid, 'upstream', {
      ...opts,
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      ...routed,
      risk: 'UNKNOWN',
      partial: true,
      traversalComplete: false,
      rawCounts: { ...routed.rawCounts, riskReasons: ['traversal_partial'] },
    });
    expect(result?.warnings?.join(' ')).toContain('aborted');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('passes resource errors through the committed delegate', async () => {
    const { backend, dispatch } = setup();
    vi.mocked(isAutomaticWorkspaceEnabled).mockReturnValue(false);
    const error = Object.assign(new Error('query failed'), { code: 'ENFILE' });
    vi.mocked(impactByUid).mockRejectedValue(error);
    await expect(backend.impactByUid(repo.id, uid, 'upstream', opts)).rejects.toBe(error);
    expect(impactByUid).toHaveBeenCalledWith(repo, uid, 'upstream', opts);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
