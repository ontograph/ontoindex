import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LocalAuditEventStore,
  type AuditEvent,
} from '../../src/core/audit-lifecycle/audit-event-store.js';
import {
  createAuditSessionLock,
  createAuditSessionLockFromStore,
  getAuditSessionLockPath,
  loadAndValidateAuditSessionLock,
  validateAuditSessionLock,
} from '../../src/core/audit-lifecycle/session-lock.js';

let tmpDir: string;
let store: LocalAuditEventStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-audit-session-lock-'));
  store = new LocalAuditEventStore(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const sessionInput = {
  id: 'session-1',
  targetRepo: 'repo-a',
  targetHead: 'head-1',
  sourceHash: 'sha256:source',
  graphIndexId: 'graph-index-1',
  verifierVersion: 'verifier-1',
  sidecarStateHash: 'sha256:sidecar',
  createdAt: '2026-05-17T00:00:00.000Z',
};

const evidence = {
  id: 'evidence-1',
  kind: 'source-snapshot',
  targetHead: 'head-1',
  graphIndexId: 'graph-index-1',
  verifierVersion: 'verifier-1',
  sidecarStateHash: 'sha256:sidecar',
};

describe('audit session lock', () => {
  it('creates and persists a lock from the audit event store projection', async () => {
    await seedSessionWithTombstone();

    const lock = await createAuditSessionLockFromStore({
      repoRoot: tmpDir,
      sessionId: 'session-1',
      graphHash: 'sha256:graph-1',
      ontoindexVersion: '1.6.2',
      createdAt: '2026-05-17T00:00:10.000Z',
      store,
    });

    expect(lock).toMatchObject({
      schemaVersion: 1,
      sessionId: 'session-1',
      targetRepo: 'repo-a',
      targetHead: 'head-1',
      graphIndexId: 'graph-index-1',
      graphHash: 'sha256:graph-1',
      ontoindexVersion: '1.6.2',
      tombstoneIds: ['finding-1'],
      tombstoneSnapshot: {
        count: 1,
        ids: ['finding-1'],
        latestTombstonedAt: '2026-05-17T00:00:03.000Z',
      },
      createdAt: '2026-05-17T00:00:10.000Z',
    });
    expect(lock.tombstoneSnapshot.hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const persisted = JSON.parse(
      await fs.readFile(getAuditSessionLockPath(tmpDir, 'session-1'), 'utf8'),
    );
    expect(persisted).toEqual(lock);
  });

  it('validates a lock when HEAD and graph identity still match', async () => {
    await seedSessionWithTombstone();
    await createAuditSessionLockFromStore({
      repoRoot: tmpDir,
      sessionId: 'session-1',
      graphHash: 'sha256:graph-1',
      ontoindexVersion: '1.6.2',
      createdAt: '2026-05-17T00:00:10.000Z',
      store,
    });

    const result = await loadAndValidateAuditSessionLock(tmpDir, 'session-1', {
      targetHead: 'head-1',
      graphIndexId: 'graph-index-1',
      graphHash: 'sha256:graph-1',
    });

    expect(result.status).toBe('VALID_SESSION');
    expect(result.ok).toBe(true);
  });

  it('returns hard STALE_SESSION when the target HEAD changes', () => {
    const result = validateAuditSessionLock(
      {
        sessionId: 'session-1',
        targetRepo: 'repo-a',
        targetHead: 'head-1',
        graphIndexId: 'graph-index-1',
        graphHash: 'sha256:graph-1',
        ontoindexVersion: '1.6.2',
        createdAt: '2026-05-17T00:00:10.000Z',
      },
      {
        targetHead: 'head-2',
        graphIndexId: 'graph-index-1',
        graphHash: 'sha256:graph-1',
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'STALE_SESSION',
      code: 'STALE_SESSION',
      staleFields: [{ field: 'targetHead', locked: 'head-1', current: 'head-2' }],
    });
  });

  it('returns hard STALE_SESSION when the graph hash changes', () => {
    const result = validateAuditSessionLock(
      {
        sessionId: 'session-1',
        targetRepo: 'repo-a',
        targetHead: 'head-1',
        graphIndexId: 'graph-index-1',
        graphHash: 'sha256:graph-1',
        ontoindexVersion: '1.6.2',
        createdAt: '2026-05-17T00:00:10.000Z',
      },
      {
        targetHead: 'head-1',
        graphIndexId: 'graph-index-1',
        graphHash: 'sha256:graph-2',
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'STALE_SESSION',
      code: 'STALE_SESSION',
      staleFields: [{ field: 'graphHash', locked: 'sha256:graph-1', current: 'sha256:graph-2' }],
    });
  });

  it('records dirty worktree overlay snapshot files and symbols when supplied', () => {
    const lock = createAuditSessionLock({
      sessionId: 'session-1',
      targetRepo: 'repo-a',
      targetHead: 'head-1',
      graphIndexId: 'graph-index-1',
      graphHash: 'sha256:graph-1',
      ontoindexVersion: '1.6.2',
      snapshotMode: 'dirty-worktree-overlay',
      changedFiles: ['src/process.cpp', 'test/process.test.ts'],
      changedSymbols: ['spawnChild'],
      staleWarnings: ['Indexed graph is stale; filesystem evidence is from dirty overlay.'],
      createdAt: '2026-05-17T00:00:10.000Z',
    });

    expect(lock).toMatchObject({
      snapshotMode: 'dirty-worktree-overlay',
      changedFiles: ['src/process.cpp', 'test/process.test.ts'],
      changedSymbols: ['spawnChild'],
      staleWarnings: ['Indexed graph is stale; filesystem evidence is from dirty overlay.'],
      snapshot: {
        mode: 'dirty-worktree-overlay',
        targetHead: 'head-1',
        graphIndexId: 'graph-index-1',
        changedFiles: ['src/process.cpp', 'test/process.test.ts'],
        changedSymbols: ['spawnChild'],
      },
    });
  });
});

async function seedSessionWithTombstone(): Promise<void> {
  await store.createSession(sessionInput, { id: 'evt-1' });
  await store.createFindingCandidate(
    {
      id: 'finding-1',
      sessionId: 'session-1',
      title: 'Closed finding',
      fingerprint: 'fp-1',
    },
    { id: 'evt-2', occurredAt: '2026-05-17T00:00:01.000Z' },
  );
  await store.appendEvent(tombstonedEvent());
}

function tombstonedEvent(): AuditEvent {
  return {
    id: 'evt-3',
    type: 'FindingTombstoned',
    occurredAt: '2026-05-17T00:00:03.000Z',
    sessionId: 'session-1',
    findingId: 'finding-1',
    tombstone: {
      tombstonedAt: '2026-05-17T00:00:03.000Z',
      reason: 'fixed before session lock',
      invariantId: 'invariant-1',
      evidence: [evidence],
    },
  };
}
