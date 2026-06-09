import {
  refreshSidecarLockHeartbeat,
  releaseSidecarLock,
  type SidecarLockAcquireRequest,
} from './sidecar-lock.js';
import { decideSidecarLifecycle, type SidecarLifecycleDecision } from './sidecar-lifecycle.js';
import {
  type SidecarEnrichmentRequest,
  type SidecarRequestStatus,
} from './sidecar-request-pool.js';
import {
  LocalSidecarStore,
  type SidecarStoreState,
  type SidecarStoreUpdateOptions,
} from './sidecar-store.js';
import { type SidecarThrottleInput } from './sidecar-throttle.js';

export type SidecarRunnerTerminalStatus = Extract<
  SidecarRequestStatus,
  'complete' | 'partial' | 'cancelled'
>;

export type SidecarRunnerExecutionStatus = SidecarRunnerTerminalStatus | 'running';

export interface SidecarRunnerExecutionResult {
  status?: SidecarRunnerExecutionStatus;
  failureReason?: string;
}

export interface SidecarRunnerExecutionContext {
  readonly heartbeat: () => Promise<boolean>;
}

export interface SidecarRunnerCallbacks {
  loadState: () => Promise<SidecarStoreState>;
  updateState: (
    update: (state: SidecarStoreState) => SidecarStoreState | Promise<SidecarStoreState>,
  ) => Promise<SidecarStoreState>;
  observeThrottle: () => SidecarThrottleInput | Promise<SidecarThrottleInput>;
  executeRequest: (
    request: SidecarEnrichmentRequest,
    context: SidecarRunnerExecutionContext,
  ) => Promise<SidecarRunnerExecutionResult | undefined>;
  now: () => string | Date;
  pid: () => number;
  ownerId: () => string;
}

export interface LocalSidecarRunnerCallbacksOptions {
  store: LocalSidecarStore;
  executeRequest: SidecarRunnerCallbacks['executeRequest'];
  observeThrottle: SidecarRunnerCallbacks['observeThrottle'];
  ownerId: SidecarRunnerCallbacks['ownerId'];
  pid: SidecarRunnerCallbacks['pid'];
  now: SidecarRunnerCallbacks['now'];
  updateOptions?: SidecarStoreUpdateOptions;
}

export interface SidecarRunnerOptions {
  sourceIndexId: string;
  analyzerId: string;
  leaseMs: number;
  staleHeartbeatMs: number;
  processAlive?: boolean;
}

export type SidecarRunnerOutcome =
  | {
      executed: false;
      reason: 'idle' | 'lock-denied' | 'paused' | 'stopped' | 'throttled';
      decision: SidecarLifecycleDecision;
    }
  | {
      executed: true;
      request: SidecarEnrichmentRequest;
      status: SidecarRequestStatus;
      decision: SidecarLifecycleDecision;
    };

export function createLocalSidecarRunnerCallbacks(
  options: LocalSidecarRunnerCallbacksOptions,
): SidecarRunnerCallbacks {
  return {
    loadState: () => options.store.load(),
    updateState: (update) =>
      options.store.update(async (state) => {
        const next = await update(state);
        if (next !== state) {
          state.schemaVersion = next.schemaVersion;
          state.requests = next.requests;
          state.lock = next.lock;
          state.enrichments = next.enrichments;
        }
        return state;
      }, options.updateOptions),
    observeThrottle: options.observeThrottle,
    executeRequest: options.executeRequest,
    now: options.now,
    pid: options.pid,
    ownerId: options.ownerId,
  };
}

export async function runSidecarRunnerOnce(
  callbacks: SidecarRunnerCallbacks,
  options: SidecarRunnerOptions,
): Promise<SidecarRunnerOutcome> {
  const state = await callbacks.loadState();
  const throttle = await callbacks.observeThrottle();
  const lockRequest = createLockRequest(callbacks, options);
  const decision = decideSidecarLifecycle({
    state,
    lockRequest,
    throttle,
    fairness: { now: lockRequest.now },
  });

  if (decision.action === 'idle') {
    return { executed: false, reason: 'idle', decision };
  }
  if (decision.action === 'wait-for-lock') {
    return { executed: false, reason: 'lock-denied', decision };
  }

  if (decision.action !== 'start' || !decision.selectedRequest || !decision.runnerLock) {
    await releaseOwnerLock(callbacks);
    return {
      executed: false,
      reason: decision.action === 'pause' ? 'paused' : 'stopped',
      decision,
    };
  }

  if (decision.throttle?.action !== 'continue') {
    await releaseOwnerLock(callbacks);
    return { executed: false, reason: 'throttled', decision };
  }

  const request = decision.selectedRequest;
  await callbacks.updateState((current) => ({
    ...current,
    lock: decision.runnerLock,
    requests: updateRequestStatus(current.requests, request.id, 'running', callbacks.now()),
  }));

  let keepOwnerLock = false;
  try {
    const result: SidecarRunnerExecutionResult =
      (await callbacks.executeRequest(request, {
        heartbeat: () => heartbeatOwnerLock(callbacks, options.leaseMs),
      })) ?? {};
    const status = result?.status ?? 'complete';
    keepOwnerLock = status === 'running';
    await callbacks.updateState((current) => ({
      ...current,
      requests: updateRequestStatus(current.requests, request.id, status, callbacks.now()),
    }));
    return { executed: true, request, status, decision };
  } catch (error) {
    await callbacks.updateState((current) => ({
      ...current,
      requests: updateRequestStatus(current.requests, request.id, 'failed', callbacks.now()),
    }));
    return { executed: true, request, status: 'failed', decision };
  } finally {
    if (!keepOwnerLock) {
      await releaseOwnerLock(callbacks);
    }
  }
}

async function heartbeatOwnerLock(
  callbacks: SidecarRunnerCallbacks,
  leaseMs: number,
): Promise<boolean> {
  let refreshed = false;
  await callbacks.updateState((current) => {
    const decision = refreshSidecarLockHeartbeat(current.lock, {
      ownerId: callbacks.ownerId(),
      now: callbacks.now(),
      leaseMs,
    });
    refreshed = decision.refreshed;
    return { ...current, lock: decision.record };
  });
  return refreshed;
}

async function releaseOwnerLock(callbacks: SidecarRunnerCallbacks): Promise<void> {
  await callbacks.updateState((current) => {
    const decision = releaseSidecarLock(current.lock, callbacks.ownerId());
    return { ...current, lock: decision.record };
  });
}

function updateRequestStatus(
  requests: readonly SidecarEnrichmentRequest[],
  requestId: string,
  status: SidecarRequestStatus,
  updatedAt: string | Date,
): SidecarEnrichmentRequest[] {
  const updatedAtIso = toIsoTimestamp(updatedAt);
  return requests.map((request) =>
    request.id === requestId
      ? {
          ...request,
          status,
          updatedAt: updatedAtIso,
        }
      : request,
  );
}

function createLockRequest(
  callbacks: SidecarRunnerCallbacks,
  options: SidecarRunnerOptions,
): SidecarLockAcquireRequest {
  return {
    ownerId: callbacks.ownerId(),
    pid: callbacks.pid(),
    sourceIndexId: options.sourceIndexId,
    analyzerId: options.analyzerId,
    now: callbacks.now(),
    leaseMs: options.leaseMs,
    staleHeartbeatMs: options.staleHeartbeatMs,
    processAlive: options.processAlive,
  };
}

function toIsoTimestamp(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
