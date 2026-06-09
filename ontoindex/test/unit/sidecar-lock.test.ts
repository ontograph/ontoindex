import { describe, expect, it } from 'vitest';
import {
  acquireSidecarLock,
  refreshSidecarLockHeartbeat,
  releaseSidecarLock,
  type SidecarLockRecord,
} from '../../src/core/ingestion/enrichment/index.js';

const baseRequest = {
  ownerId: 'owner-a',
  pid: 1234,
  sourceIndexId: 'index-1',
  analyzerId: 'ts-type-aware',
  now: '2026-05-13T10:00:00.000Z',
  leaseMs: 60_000,
  staleHeartbeatMs: 120_000,
};

function activeLock(overrides: Partial<SidecarLockRecord> = {}): SidecarLockRecord {
  return {
    ownerId: 'owner-a',
    pid: 1234,
    startedAt: '2026-05-13T09:59:00.000Z',
    heartbeatAt: '2026-05-13T10:00:00.000Z',
    sourceIndexId: 'index-1',
    analyzerId: 'ts-type-aware',
    leaseExpiresAt: '2026-05-13T10:01:00.000Z',
    ...overrides,
  };
}

describe('sidecar single-flight lock contract', () => {
  it('acquires when no durable lock exists', () => {
    const decision = acquireSidecarLock(null, baseRequest);

    expect(decision).toEqual({
      acquired: true,
      reason: 'empty',
      record: {
        ownerId: 'owner-a',
        pid: 1234,
        startedAt: '2026-05-13T10:00:00.000Z',
        heartbeatAt: '2026-05-13T10:00:00.000Z',
        sourceIndexId: 'index-1',
        analyzerId: 'ts-type-aware',
        leaseExpiresAt: '2026-05-13T10:01:00.000Z',
      },
    });
  });

  it('denies acquisition while an active lock heartbeat and lease are current', () => {
    const current = activeLock();
    const decision = acquireSidecarLock(current, {
      ...baseRequest,
      ownerId: 'owner-b',
      pid: 2222,
      processAlive: true,
    });

    expect(decision).toEqual({
      acquired: false,
      reason: 'already-running',
      record: current,
    });
  });

  it('refreshes heartbeat and lease for the current owner', () => {
    const current = activeLock();
    const decision = refreshSidecarLockHeartbeat(current, {
      ownerId: 'owner-a',
      now: '2026-05-13T10:00:30.000Z',
      leaseMs: 90_000,
    });

    expect(decision).toEqual({
      refreshed: true,
      reason: 'owner-matched',
      record: {
        ...current,
        heartbeatAt: '2026-05-13T10:00:30.000Z',
        leaseExpiresAt: '2026-05-13T10:02:00.000Z',
      },
    });
  });

  it('releases only when the owner matches', () => {
    const current = activeLock();

    expect(releaseSidecarLock(current, 'owner-a')).toEqual({
      released: true,
      reason: 'owner-matched',
      record: null,
      previousRecord: current,
    });
  });

  it('recovers a stale lock when the prior process is gone', () => {
    const current = activeLock();
    const decision = acquireSidecarLock(current, {
      ...baseRequest,
      ownerId: 'owner-b',
      pid: 2222,
      processAlive: false,
    });

    expect(decision).toMatchObject({
      acquired: true,
      reason: 'stale-lock-recovered',
      staleReason: 'process-gone',
      previousRecord: current,
      record: {
        ownerId: 'owner-b',
        pid: 2222,
      },
    });
  });

  it('recovers a stale lock when lease is expired and heartbeat is stale', () => {
    const current = activeLock({
      heartbeatAt: '2026-05-13T09:57:00.000Z',
      leaseExpiresAt: '2026-05-13T09:58:00.000Z',
    });
    const decision = acquireSidecarLock(current, {
      ...baseRequest,
      ownerId: 'owner-b',
      pid: 2222,
      processAlive: true,
    });

    expect(decision).toMatchObject({
      acquired: true,
      reason: 'stale-lock-recovered',
      staleReason: 'lease-expired-heartbeat-stale',
      previousRecord: current,
      record: {
        ownerId: 'owner-b',
        pid: 2222,
      },
    });
  });

  it('denies release by the wrong owner', () => {
    const current = activeLock();

    expect(releaseSidecarLock(current, 'owner-b')).toEqual({
      released: false,
      reason: 'wrong-owner',
      record: current,
    });
  });
});
