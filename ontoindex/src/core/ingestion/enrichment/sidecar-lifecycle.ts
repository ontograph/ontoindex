import {
  acquireSidecarLock,
  type SidecarLockAcquireDecision,
  type SidecarLockAcquireRequest,
  type SidecarLockRecord,
} from './sidecar-lock.js';
import {
  selectNextSidecarRequest,
  type SchedulerFairnessOptions,
  type SidecarEnrichmentRequest,
} from './sidecar-request-pool.js';
import { type SidecarStoreState } from './sidecar-store.js';
import {
  decideSidecarThrottle,
  type SidecarThrottleDecision,
  type SidecarThrottleInput,
} from './sidecar-throttle.js';

export type SidecarLifecycleAction = 'idle' | 'wait-for-lock' | 'pause' | 'stop' | 'start';

export type SidecarLifecycleReason =
  | 'no-queued-work'
  | 'lock-request-mismatch'
  | 'active-lock-held-by-another-owner'
  | 'lock-acquired'
  | 'stale-lock-taken-over'
  | 'throttle-continue'
  | 'throttle-throttle'
  | 'throttle-pause'
  | 'throttle-stop';

export interface SidecarLifecycleInput {
  state: Pick<SidecarStoreState, 'lock' | 'requests'>;
  lockRequest: SidecarLockAcquireRequest;
  throttle: SidecarThrottleInput;
  fairness?: Partial<SchedulerFairnessOptions>;
}

export interface SidecarLifecycleDecision {
  action: SidecarLifecycleAction;
  reason: SidecarLifecycleReason;
  selectedRequest: SidecarEnrichmentRequest | null;
  lock: SidecarLockAcquireDecision | null;
  throttle: SidecarThrottleDecision | null;
  runnerLock: SidecarLockRecord | null;
}

export function decideSidecarLifecycle(input: SidecarLifecycleInput): SidecarLifecycleDecision {
  const selectedRequest = selectNextSidecarRequest(input.state.requests, input.fairness);
  if (!selectedRequest) {
    return {
      action: 'idle',
      reason: 'no-queued-work',
      selectedRequest: null,
      lock: null,
      throttle: null,
      runnerLock: null,
    };
  }

  if (
    selectedRequest.sourceIndexId !== input.lockRequest.sourceIndexId ||
    selectedRequest.analyzerId !== input.lockRequest.analyzerId
  ) {
    return {
      action: 'stop',
      reason: 'lock-request-mismatch',
      selectedRequest,
      lock: null,
      throttle: null,
      runnerLock: null,
    };
  }

  const lock = acquireSidecarLock(input.state.lock, input.lockRequest);
  if (!lock.acquired) {
    return {
      action: 'wait-for-lock',
      reason: 'active-lock-held-by-another-owner',
      selectedRequest,
      lock,
      throttle: null,
      runnerLock: null,
    };
  }

  const throttle = decideSidecarThrottle(input.throttle);
  if (throttle.action === 'pause') {
    return {
      action: 'pause',
      reason: 'throttle-pause',
      selectedRequest,
      lock,
      throttle,
      runnerLock: lock.record,
    };
  }

  if (throttle.action === 'stop') {
    return {
      action: 'stop',
      reason: 'throttle-stop',
      selectedRequest,
      lock,
      throttle,
      runnerLock: lock.record,
    };
  }

  return {
    action: 'start',
    reason:
      lock.reason === 'stale-lock-recovered'
        ? 'stale-lock-taken-over'
        : throttle.action === 'throttle'
          ? 'throttle-throttle'
          : lock.reason === 'empty'
            ? 'lock-acquired'
            : 'throttle-continue',
    selectedRequest,
    lock,
    throttle,
    runnerLock: lock.record,
  };
}
