export interface SidecarLockRecord {
  ownerId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  sourceIndexId: string;
  analyzerId: string;
  leaseExpiresAt: string;
}

export type SidecarLockStaleReason = 'process-gone' | 'lease-expired-heartbeat-stale';

export type SidecarLockAcquireReason = 'empty' | 'already-running' | 'stale-lock-recovered';

export interface SidecarLockAcquireRequest {
  ownerId: string;
  pid: number;
  sourceIndexId: string;
  analyzerId: string;
  now: string | Date;
  leaseMs: number;
  staleHeartbeatMs: number;
  processAlive?: boolean;
}

export type SidecarLockAcquireDecision =
  | {
      acquired: true;
      reason: 'empty' | 'stale-lock-recovered';
      staleReason?: SidecarLockStaleReason;
      record: SidecarLockRecord;
      previousRecord?: SidecarLockRecord;
    }
  | {
      acquired: false;
      reason: 'already-running';
      staleReason?: undefined;
      record: SidecarLockRecord;
    };

export interface SidecarLockHeartbeatRequest {
  ownerId: string;
  now: string | Date;
  leaseMs: number;
}

export type SidecarLockHeartbeatDecision =
  | {
      refreshed: true;
      reason: 'owner-matched';
      record: SidecarLockRecord;
    }
  | {
      refreshed: false;
      reason: 'no-lock' | 'wrong-owner';
      record: SidecarLockRecord | null;
    };

export type SidecarLockReleaseDecision =
  | {
      released: true;
      reason: 'owner-matched';
      record: null;
      previousRecord: SidecarLockRecord;
    }
  | {
      released: false;
      reason: 'no-lock' | 'wrong-owner';
      record: SidecarLockRecord | null;
    };

export function acquireSidecarLock(
  current: SidecarLockRecord | null | undefined,
  request: SidecarLockAcquireRequest,
): SidecarLockAcquireDecision {
  const nowMs = toTimeMs(request.now, 'now');
  const record = createLockRecord(request, nowMs);

  if (!current) {
    return {
      acquired: true,
      reason: 'empty',
      record,
    };
  }

  const staleReason = getStaleReason(current, request, nowMs);
  if (staleReason) {
    return {
      acquired: true,
      reason: 'stale-lock-recovered',
      staleReason,
      record,
      previousRecord: current,
    };
  }

  return {
    acquired: false,
    reason: 'already-running',
    record: current,
  };
}

export function refreshSidecarLockHeartbeat(
  current: SidecarLockRecord | null | undefined,
  request: SidecarLockHeartbeatRequest,
): SidecarLockHeartbeatDecision {
  if (!current) {
    return {
      refreshed: false,
      reason: 'no-lock',
      record: null,
    };
  }

  if (current.ownerId !== request.ownerId) {
    return {
      refreshed: false,
      reason: 'wrong-owner',
      record: current,
    };
  }

  const nowMs = toTimeMs(request.now, 'now');
  return {
    refreshed: true,
    reason: 'owner-matched',
    record: {
      ...current,
      heartbeatAt: toIso(nowMs),
      leaseExpiresAt: toIso(nowMs + validDurationMs(request.leaseMs, 'leaseMs')),
    },
  };
}

export function releaseSidecarLock(
  current: SidecarLockRecord | null | undefined,
  ownerId: string,
): SidecarLockReleaseDecision {
  if (!current) {
    return {
      released: false,
      reason: 'no-lock',
      record: null,
    };
  }

  if (current.ownerId !== ownerId) {
    return {
      released: false,
      reason: 'wrong-owner',
      record: current,
    };
  }

  return {
    released: true,
    reason: 'owner-matched',
    record: null,
    previousRecord: current,
  };
}

function createLockRecord(request: SidecarLockAcquireRequest, nowMs: number): SidecarLockRecord {
  return {
    ownerId: requireNonEmpty(request.ownerId, 'ownerId'),
    pid: validPid(request.pid),
    startedAt: toIso(nowMs),
    heartbeatAt: toIso(nowMs),
    sourceIndexId: requireNonEmpty(request.sourceIndexId, 'sourceIndexId'),
    analyzerId: requireNonEmpty(request.analyzerId, 'analyzerId'),
    leaseExpiresAt: toIso(nowMs + validDurationMs(request.leaseMs, 'leaseMs')),
  };
}

function getStaleReason(
  current: SidecarLockRecord,
  request: SidecarLockAcquireRequest,
  nowMs: number,
): SidecarLockStaleReason | null {
  if (request.processAlive === false) {
    return 'process-gone';
  }

  const leaseExpired = toTimeMs(current.leaseExpiresAt, 'leaseExpiresAt') <= nowMs;
  const heartbeatStale =
    toTimeMs(current.heartbeatAt, 'heartbeatAt') +
      validDurationMs(request.staleHeartbeatMs, 'staleHeartbeatMs') <=
    nowMs;

  return leaseExpired && heartbeatStale ? 'lease-expired-heartbeat-stale' : null;
}

function validDurationMs(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive finite duration`);
  }
  return Math.floor(value);
}

function validPid(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('pid must be a positive integer');
  }
  return value;
}

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function toTimeMs(value: string | Date, fieldName: string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${fieldName} must be a valid timestamp`);
  }
  return ms;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}
