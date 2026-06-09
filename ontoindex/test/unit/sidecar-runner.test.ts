import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptySidecarStoreState,
  createLocalSidecarRunnerCallbacks,
  createSidecarRequest,
  LocalSidecarStore,
  runSidecarRunnerOnce,
  type SidecarRunnerCallbacks,
  type SidecarStoreState,
} from '../../src/core/ingestion/enrichment/index.js';

const baseNow = Date.parse('2026-05-13T10:00:00.000Z');
const runnerOptions = {
  sourceIndexId: 'index-1',
  analyzerId: 'ts-type-aware',
  leaseMs: 60_000,
  staleHeartbeatMs: 120_000,
};
const throttle = {
  logicalCpuCount: 28,
  observedCpuPercent: 4,
  workerCount: 1,
};
const tempDirs: string[] = [];

function queuedRequest(overrides = {}) {
  return createSidecarRequest({
    id: 'request-1',
    repoId: 'repo-1',
    sourceIndexId: 'index-1',
    analyzerId: 'ts-type-aware',
    analyzerVersion: '1.0.0',
    purpose: 'type-aware-resolution',
    scopeHash: 'scope-1',
    priority: 'user-requested',
    requestedAt: '2026-05-13T09:59:00.000Z',
    ...overrides,
  });
}

function activeLock(ownerId = 'other-runner') {
  return {
    ownerId,
    pid: 4321,
    startedAt: '2026-05-13T09:59:00.000Z',
    heartbeatAt: '2026-05-13T09:59:30.000Z',
    sourceIndexId: 'index-1',
    analyzerId: 'ts-type-aware',
    leaseExpiresAt: '2026-05-13T10:01:00.000Z',
  };
}

function createHarness(initialState: SidecarStoreState) {
  let state = initialState;
  let tick = 0;
  const callbacks: SidecarRunnerCallbacks = {
    loadState: vi.fn(async () => state),
    updateState: vi.fn(async (update) => {
      state = await update(state);
      return state;
    }),
    observeThrottle: vi.fn(async () => throttle),
    executeRequest: vi.fn(async () => undefined),
    now: vi.fn(() => new Date(baseNow + tick++ * 10_000).toISOString()),
    pid: vi.fn(() => 1234),
    ownerId: vi.fn(() => 'runner-a'),
  };
  return {
    callbacks,
    get state() {
      return state;
    },
  };
}

async function createTempStore(initialState: SidecarStoreState) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-sidecar-runner-'));
  tempDirs.push(dir);
  const statePath = path.join(dir, 'sidecar-state.json');
  const store = new LocalSidecarStore(statePath);
  await store.save(initialState);
  return store;
}

async function cleanupTempDirs() {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}

describe('sidecar runner scaffold', () => {
  afterEach(async () => {
    await cleanupTempDirs();
  });

  it('idles without taking a lock when no request is queued', async () => {
    const harness = createHarness(createEmptySidecarStoreState());

    const outcome = await runSidecarRunnerOnce(harness.callbacks, runnerOptions);

    expect(outcome).toMatchObject({ executed: false, reason: 'idle' });
    expect(harness.callbacks.executeRequest).not.toHaveBeenCalled();
    expect(harness.state.lock).toBeNull();
  });

  it('does not execute when the runner lock is denied', async () => {
    const request = queuedRequest();
    const harness = createHarness({
      ...createEmptySidecarStoreState(),
      requests: [request],
      lock: activeLock(),
    });

    const outcome = await runSidecarRunnerOnce(harness.callbacks, runnerOptions);

    expect(outcome).toMatchObject({ executed: false, reason: 'lock-denied' });
    expect(harness.callbacks.executeRequest).not.toHaveBeenCalled();
    expect(harness.state.requests[0].status).toBe('queued');
    expect(harness.state.lock).toEqual(activeLock());
  });

  it('does not execute when throttle pauses foreground work', async () => {
    const request = queuedRequest();
    const harness = createHarness({
      ...createEmptySidecarStoreState(),
      requests: [request],
    });
    harness.callbacks.observeThrottle = vi.fn(async () => ({
      ...throttle,
      foregroundActive: true,
    }));

    const outcome = await runSidecarRunnerOnce(harness.callbacks, runnerOptions);

    expect(outcome).toMatchObject({ executed: false, reason: 'paused' });
    expect(harness.callbacks.executeRequest).not.toHaveBeenCalled();
    expect(harness.state.requests[0].status).toBe('queued');
    expect(harness.state.lock).toBeNull();
  });

  it('executes one selected request and completes it', async () => {
    const first = queuedRequest({ id: 'request-1', priority: 'user-requested' });
    const second = queuedRequest({
      id: 'request-2',
      scopeHash: 'scope-2',
      priority: 'background-remainder',
    });
    const harness = createHarness({
      ...createEmptySidecarStoreState(),
      requests: [second, first],
    });

    const outcome = await runSidecarRunnerOnce(harness.callbacks, runnerOptions);

    expect(outcome).toMatchObject({ executed: true, status: 'complete' });
    expect(harness.callbacks.executeRequest).toHaveBeenCalledTimes(1);
    expect(harness.callbacks.executeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'request-1' }),
      expect.objectContaining({ heartbeat: expect.any(Function) }),
    );
    expect(harness.state.requests).toMatchObject([
      { id: 'request-2', status: 'queued' },
      { id: 'request-1', status: 'complete' },
    ]);
    expect(harness.state.lock).toBeNull();
  });

  it('marks failed requests and releases the owner lock', async () => {
    const request = queuedRequest();
    const harness = createHarness({
      ...createEmptySidecarStoreState(),
      requests: [request],
    });
    harness.callbacks.executeRequest = vi.fn(async () => {
      throw new Error('analyzer failed');
    });

    const outcome = await runSidecarRunnerOnce(harness.callbacks, runnerOptions);

    expect(outcome).toMatchObject({ executed: true, status: 'failed' });
    expect(harness.state.requests[0]).toMatchObject({
      id: 'request-1',
      status: 'failed',
    });
    expect(harness.state.lock).toBeNull();
  });

  it('keeps the owner lock when execution launches a still-running sidecar process', async () => {
    const request = queuedRequest();
    const harness = createHarness({
      ...createEmptySidecarStoreState(),
      requests: [request],
    });
    harness.callbacks.executeRequest = vi.fn(async () => ({ status: 'running' }));

    const outcome = await runSidecarRunnerOnce(harness.callbacks, runnerOptions);

    expect(outcome).toMatchObject({ executed: true, status: 'running' });
    expect(harness.state.requests[0]).toMatchObject({
      id: 'request-1',
      status: 'running',
    });
    expect(harness.state.lock).toMatchObject({
      ownerId: 'runner-a',
      sourceIndexId: 'index-1',
      analyzerId: 'ts-type-aware',
    });
  });

  it('refreshes the owner lock heartbeat during long execution', async () => {
    const request = queuedRequest();
    const harness = createHarness({
      ...createEmptySidecarStoreState(),
      requests: [request],
    });
    const heartbeats: boolean[] = [];
    harness.callbacks.executeRequest = vi.fn(async (_request, context) => {
      heartbeats.push(await context.heartbeat());
      expect(harness.state.lock).toMatchObject({
        ownerId: 'runner-a',
        heartbeatAt: '2026-05-13T10:20:00.000Z',
        leaseExpiresAt: '2026-05-13T10:21:00.000Z',
      });
    });
    harness.callbacks.now = vi
      .fn()
      .mockReturnValueOnce('2026-05-13T10:00:00.000Z')
      .mockReturnValueOnce('2026-05-13T10:10:00.000Z')
      .mockReturnValueOnce('2026-05-13T10:20:00.000Z')
      .mockReturnValueOnce('2026-05-13T10:30:00.000Z');

    const outcome = await runSidecarRunnerOnce(harness.callbacks, runnerOptions);

    expect(outcome).toMatchObject({ executed: true, status: 'complete' });
    expect(heartbeats).toEqual([true]);
    expect(harness.state.lock).toBeNull();
  });

  it('creates local callbacks that persist request completion through LocalSidecarStore.update', async () => {
    const request = queuedRequest();
    const store = await createTempStore({
      ...createEmptySidecarStoreState(),
      requests: [request],
    });
    const update = vi.spyOn(store, 'update');
    const callbacks = createLocalSidecarRunnerCallbacks({
      store,
      observeThrottle: vi.fn(async () => throttle),
      executeRequest: vi.fn(async () => undefined),
      now: vi.fn(() => '2026-05-13T10:00:00.000Z'),
      pid: vi.fn(() => 1234),
      ownerId: vi.fn(() => 'runner-a'),
    });

    const outcome = await runSidecarRunnerOnce(callbacks, runnerOptions);
    const state = await store.load();

    expect(outcome).toMatchObject({ executed: true, status: 'complete' });
    expect(update).toHaveBeenCalled();
    expect(state.requests).toMatchObject([{ id: 'request-1', status: 'complete' }]);
    expect(state.lock).toBeNull();
  });

  it('creates local callbacks that persist failed requests', async () => {
    const request = queuedRequest();
    const store = await createTempStore({
      ...createEmptySidecarStoreState(),
      requests: [request],
    });
    const callbacks = createLocalSidecarRunnerCallbacks({
      store,
      observeThrottle: vi.fn(async () => throttle),
      executeRequest: vi.fn(async () => {
        throw new Error('adapter analyzer failed');
      }),
      now: vi.fn(() => '2026-05-13T10:00:00.000Z'),
      pid: vi.fn(() => 1234),
      ownerId: vi.fn(() => 'runner-a'),
    });

    const outcome = await runSidecarRunnerOnce(callbacks, runnerOptions);
    const state = await store.load();

    expect(outcome).toMatchObject({ executed: true, status: 'failed' });
    expect(state.requests).toMatchObject([{ id: 'request-1', status: 'failed' }]);
    expect(state.lock).toBeNull();
  });

  it('creates local callbacks that refresh persisted heartbeats during execution', async () => {
    const request = queuedRequest();
    const store = await createTempStore({
      ...createEmptySidecarStoreState(),
      requests: [request],
    });
    const callbacks = createLocalSidecarRunnerCallbacks({
      store,
      observeThrottle: vi.fn(async () => throttle),
      executeRequest: vi.fn(async (_request, context) => {
        expect(await context.heartbeat()).toBe(true);
        await expect(store.load()).resolves.toMatchObject({
          lock: {
            ownerId: 'runner-a',
            heartbeatAt: '2026-05-13T10:20:00.000Z',
            leaseExpiresAt: '2026-05-13T10:21:00.000Z',
          },
        });
      }),
      now: vi
        .fn()
        .mockReturnValueOnce('2026-05-13T10:00:00.000Z')
        .mockReturnValueOnce('2026-05-13T10:10:00.000Z')
        .mockReturnValueOnce('2026-05-13T10:20:00.000Z')
        .mockReturnValueOnce('2026-05-13T10:30:00.000Z'),
      pid: vi.fn(() => 1234),
      ownerId: vi.fn(() => 'runner-a'),
    });

    const outcome = await runSidecarRunnerOnce(callbacks, runnerOptions);

    expect(outcome).toMatchObject({ executed: true, status: 'complete' });
  });

  it('creates local callbacks that serialize mutations through LocalSidecarStore.update', async () => {
    const store = await createTempStore(createEmptySidecarStoreState());
    const update = vi.spyOn(store, 'update');
    const callbacks = createLocalSidecarRunnerCallbacks({
      store,
      observeThrottle: vi.fn(async () => throttle),
      executeRequest: vi.fn(async () => undefined),
      now: vi.fn(() => '2026-05-13T10:00:00.000Z'),
      pid: vi.fn(() => 1234),
      ownerId: vi.fn(() => 'runner-a'),
      updateOptions: { ownerId: 'test-update-lock' },
    });

    await callbacks.updateState((state) => ({
      ...state,
      requests: [queuedRequest()],
    }));
    const state = await store.load();

    expect(update).toHaveBeenCalledWith(expect.any(Function), { ownerId: 'test-update-lock' });
    expect(state.requests).toMatchObject([{ id: 'request-1', status: 'queued' }]);
  });
});
