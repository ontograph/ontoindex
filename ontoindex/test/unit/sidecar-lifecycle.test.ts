import { describe, expect, it } from 'vitest';
import {
  createEmptySidecarStoreState,
  createSidecarRequest,
  decideSidecarLifecycle,
  type SidecarLockRecord,
  type SidecarStoreState,
} from '../../src/core/ingestion/enrichment/index.js';

const now = '2026-05-13T10:00:00.000Z';
const lockRequest = {
  ownerId: 'runner-a',
  pid: 1234,
  sourceIndexId: 'index-1',
  analyzerId: 'ts-type-aware',
  now,
  leaseMs: 60_000,
  staleHeartbeatMs: 120_000,
  processAlive: true,
};
const throttle = {
  logicalCpuCount: 28,
  observedCpuPercent: 4,
  workerCount: 1,
};

function queuedRequest(overrides = {}) {
  return createSidecarRequest({
    repoId: 'repo-1',
    sourceIndexId: 'index-1',
    analyzerId: 'ts-type-aware',
    analyzerVersion: '1.0.0',
    purpose: 'type-aware-resolution',
    scopeHash: 'scope-1',
    priority: 'unresolved-calls',
    requestedAt: '2026-05-13T09:59:00.000Z',
    ...overrides,
  });
}

function state(overrides: Partial<SidecarStoreState> = {}): SidecarStoreState {
  return {
    ...createEmptySidecarStoreState(),
    requests: [queuedRequest()],
    ...overrides,
  };
}

function activeLock(overrides: Partial<SidecarLockRecord> = {}): SidecarLockRecord {
  return {
    ownerId: 'runner-b',
    pid: 2222,
    startedAt: '2026-05-13T09:59:00.000Z',
    heartbeatAt: '2026-05-13T10:00:00.000Z',
    sourceIndexId: 'index-1',
    analyzerId: 'ts-type-aware',
    leaseExpiresAt: '2026-05-13T10:01:00.000Z',
    ...overrides,
  };
}

describe('sidecar process lifecycle decision contract', () => {
  it('idles without taking a lock when there is no queued work', () => {
    const decision = decideSidecarLifecycle({
      state: state({ requests: [] }),
      lockRequest,
      throttle,
    });

    expect(decision).toEqual({
      action: 'idle',
      reason: 'no-queued-work',
      selectedRequest: null,
      lock: null,
      throttle: null,
      runnerLock: null,
    });
  });

  it('leaves queued work waiting when an active lock is held by another owner', () => {
    const currentLock = activeLock();
    const decision = decideSidecarLifecycle({
      state: state({ lock: currentLock }),
      lockRequest,
      throttle,
    });

    expect(decision).toMatchObject({
      action: 'wait-for-lock',
      reason: 'active-lock-held-by-another-owner',
      selectedRequest: { id: queuedRequest().id },
      lock: {
        acquired: false,
        reason: 'already-running',
        record: currentLock,
      },
      throttle: null,
      runnerLock: null,
    });
  });

  it('stops before acquiring a lock when the lock request does not match selected work', () => {
    const request = queuedRequest({ analyzerId: 'codeql' });
    const decision = decideSidecarLifecycle({
      state: state({ requests: [request] }),
      lockRequest,
      throttle,
    });

    expect(decision).toEqual({
      action: 'stop',
      reason: 'lock-request-mismatch',
      selectedRequest: request,
      lock: null,
      throttle: null,
      runnerLock: null,
    });
  });

  it('explicitly starts after taking over a stale lock', () => {
    const staleLock = activeLock({
      heartbeatAt: '2026-05-13T09:57:00.000Z',
      leaseExpiresAt: '2026-05-13T09:58:00.000Z',
    });
    const decision = decideSidecarLifecycle({
      state: state({ lock: staleLock }),
      lockRequest,
      throttle,
    });

    expect(decision).toMatchObject({
      action: 'start',
      reason: 'stale-lock-taken-over',
      lock: {
        acquired: true,
        reason: 'stale-lock-recovered',
        staleReason: 'lease-expired-heartbeat-stale',
        previousRecord: staleLock,
      },
      throttle: {
        action: 'continue',
        reason: 'within-budget',
      },
      runnerLock: {
        ownerId: 'runner-a',
      },
    });
  });

  it('pauses after acquiring the lock when foreground work is active', () => {
    const decision = decideSidecarLifecycle({
      state: state(),
      lockRequest,
      throttle: {
        ...throttle,
        foregroundActive: true,
      },
    });

    expect(decision).toMatchObject({
      action: 'pause',
      reason: 'throttle-pause',
      lock: {
        acquired: true,
        reason: 'empty',
      },
      throttle: {
        action: 'pause',
        reason: 'foreground-active',
      },
      runnerLock: {
        ownerId: 'runner-a',
      },
    });
  });

  it('pauses when CPU is over the hard pause budget', () => {
    const decision = decideSidecarLifecycle({
      state: state(),
      lockRequest,
      throttle: {
        ...throttle,
        observedCpuPercent: 25,
      },
    });

    expect(decision).toMatchObject({
      action: 'pause',
      reason: 'throttle-pause',
      throttle: {
        action: 'pause',
        reason: 'cpu-over-budget',
      },
    });
  });

  it('stops when worker count exceeds the exactly-one-runner contract', () => {
    const decision = decideSidecarLifecycle({
      state: state(),
      lockRequest,
      throttle: {
        ...throttle,
        workerCount: 2,
      },
    });

    expect(decision).toMatchObject({
      action: 'stop',
      reason: 'throttle-stop',
      throttle: {
        action: 'stop',
        reason: 'worker-count-over-limit',
      },
    });
  });

  it('starts the selected request only when lock is acquired and throttle allows', () => {
    const request = queuedRequest({ id: 'request-a' });
    const decision = decideSidecarLifecycle({
      state: state({ requests: [request] }),
      lockRequest,
      throttle: {
        ...throttle,
        observedCpuPercent: 12,
      },
    });

    expect(decision).toMatchObject({
      action: 'start',
      reason: 'throttle-throttle',
      selectedRequest: request,
      lock: {
        acquired: true,
      },
      throttle: {
        action: 'throttle',
        reason: 'cpu-over-budget',
      },
      runnerLock: {
        ownerId: 'runner-a',
      },
    });
  });
});
