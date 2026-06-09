import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUDIT_EVENT_STORE_SCHEMA_VERSION,
  LocalAuditEventStore,
  getAuditEventStorePath,
  getAuditProjectionPath,
  loadAuditEventStoreState,
  rebuildAuditProjectionFile,
  saveAuditEventStoreState,
  type AuditEvent,
} from '../../src/core/audit-lifecycle/audit-event-store.js';
import { buildAuditProjection } from '../../src/core/audit-lifecycle/audit-projection.js';

const itOnLockFriendlyFs = process.platform === 'win32' ? it.skip : it;

let tmpDir: string;
let store: LocalAuditEventStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-audit-event-store-'));
  store = new LocalAuditEventStore(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const sessionInput = {
  id: 'session-1',
  targetRepo: 'repo-a',
  targetHead: 'abc123',
  sourceHash: 'sha256:source',
  graphIndexId: 'index-1',
  verifierVersion: 'verifier-1',
  sidecarStateHash: 'sha256:sidecar',
  createdAt: '2026-05-17T00:00:00.000Z',
};

const evidence = {
  id: 'evidence-1',
  kind: 'source-snapshot',
  targetHead: 'abc123',
  graphIndexId: 'index-1',
  verifierVersion: 'verifier-1',
  sidecarStateHash: 'sha256:sidecar',
  confidence: 0.9,
  reasonCodes: ['fresh-positive-evidence'],
};

describe('audit event store', () => {
  it('uses the required audit store and projection paths under .ontoindex/audit', () => {
    expect(getAuditEventStorePath('/repo')).toBe(
      path.join('/repo', '.ontoindex', 'audit', 'audit-event-store.json'),
    );
    expect(getAuditProjectionPath('/repo')).toBe(
      path.join('/repo', '.ontoindex', 'audit', 'audit-projection.json'),
    );
  });

  it('loads a missing event store as an empty versioned log', async () => {
    await expect(loadAuditEventStoreState(store.eventStorePath)).resolves.toEqual({
      schemaVersion: AUDIT_EVENT_STORE_SCHEMA_VERSION,
      events: [],
    });
  });

  it('creates a session and writes a disposable projection', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });

    const rawStore = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    expect(rawStore).toMatchObject({
      schemaVersion: 1,
      events: [
        {
          id: 'evt-1',
          type: 'AuditIngested',
          session: {
            targetRepo: 'repo-a',
            targetHead: 'abc123',
            sourceHash: 'sha256:source',
            graphIndexId: 'index-1',
            verifierVersion: 'verifier-1',
            sidecarStateHash: 'sha256:sidecar',
          },
        },
      ],
    });

    const projection = JSON.parse(await fs.readFile(store.projectionPath, 'utf8'));
    expect(projection.sessions).toHaveLength(1);
    expect(projection.sessions[0]).toMatchObject({ id: 'session-1', targetHead: 'abc123' });
  });

  it('appends finding, verification, status, tombstone, bundle, dispatch, lint, and guard events', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });
    await store.createFindingCandidate(
      {
        id: 'finding-1',
        sessionId: 'session-1',
        title: 'Unchecked close result',
        fingerprint: 'fp-1',
      },
      { id: 'evt-2', occurredAt: '2026-05-17T00:00:01.000Z' },
    );

    await store.appendEvent(verifiedEvent());
    await store.appendEvent({
      id: 'evt-4',
      type: 'FindingStatusChanged',
      occurredAt: '2026-05-17T00:00:03.000Z',
      sessionId: 'session-1',
      findingId: 'finding-1',
      status: 'RESOLVED-ALREADY',
      reason: 'negative evidence still holds',
    });
    await store.appendEvent({
      id: 'evt-5',
      type: 'FindingTombstoned',
      occurredAt: '2026-05-17T00:00:04.000Z',
      sessionId: 'session-1',
      findingId: 'finding-1',
      tombstone: {
        tombstonedAt: '2026-05-17T00:00:04.000Z',
        reason: 'fixed before ingest',
        invariantId: 'invariant-1',
        evidence: [evidence],
      },
    });
    await store.appendEvent({
      id: 'evt-6',
      type: 'FindingBundled',
      occurredAt: '2026-05-17T00:00:05.000Z',
      sessionId: 'session-1',
      bundleId: 'bundle-1',
      bundle: {
        id: 'bundle-1',
        sessionId: 'session-1',
        findingIds: ['finding-1'],
        status: 'CREATED',
        createdAt: '2026-05-17T00:00:05.000Z',
        metadata: {},
      },
    });
    await store.appendEvent({
      id: 'evt-7',
      type: 'BundleDispatched',
      occurredAt: '2026-05-17T00:00:06.000Z',
      sessionId: 'session-1',
      bundleId: 'bundle-1',
      dispatchedAt: '2026-05-17T00:00:06.000Z',
      metadata: { worker: 'external' },
    });
    await store.appendEvent({
      id: 'evt-8',
      type: 'AuditLinted',
      occurredAt: '2026-05-17T00:00:07.000Z',
      sessionId: 'session-1',
      status: 'passed',
      findingIds: ['finding-1'],
      warnings: [],
    });
    await store.appendEvent({
      id: 'evt-9',
      type: 'ScopeGuardEvaluated',
      occurredAt: '2026-05-17T00:00:08.000Z',
      sessionId: 'session-1',
      status: 'passed',
      metadata: { changedFiles: [] },
    });

    const state = await store.load();
    expect(state.events.map((event) => event.id)).toEqual([
      'evt-1',
      'evt-2',
      'evt-3',
      'evt-4',
      'evt-5',
      'evt-6',
      'evt-7',
      'evt-8',
      'evt-9',
    ]);

    const projection = JSON.parse(await fs.readFile(store.projectionPath, 'utf8'));
    expect(projection.findings[0]).toMatchObject({
      id: 'finding-1',
      status: 'DISPATCHED',
      bundleId: 'bundle-1',
      verification: { status: 'OPEN' },
      tombstone: { invariantId: 'invariant-1' },
    });
    expect(projection.bundles[0]).toMatchObject({
      id: 'bundle-1',
      status: 'DISPATCHED',
      dispatchedAt: '2026-05-17T00:00:06.000Z',
    });
    expect(projection.lintRuns).toHaveLength(1);
    expect(projection.scopeGuardEvaluations).toHaveLength(1);
  });

  it('rebuilds projection deterministically from the event log only', async () => {
    const events: AuditEvent[] = [
      {
        id: 'evt-1',
        type: 'AuditIngested',
        occurredAt: '2026-05-17T00:00:00.000Z',
        sessionId: 'session-1',
        session: {
          ...sessionInput,
          metadata: {},
        },
      },
      {
        id: 'evt-2',
        type: 'FindingCandidateCreated',
        occurredAt: '2026-05-17T00:00:01.000Z',
        sessionId: 'session-1',
        findingId: 'finding-1',
        finding: {
          id: 'finding-1',
          sessionId: 'session-1',
          title: 'Unchecked close result',
          fingerprint: 'fp-1',
          status: 'NEEDS-VERIFY',
          evidence: [],
          metadata: {},
        },
      },
      verifiedEvent(),
    ];
    await saveAuditEventStoreState(store.eventStorePath, {
      schemaVersion: AUDIT_EVENT_STORE_SCHEMA_VERSION,
      events,
    });

    const expected = buildAuditProjection(events, '2026-05-17T01:00:00.000Z');
    await rebuildAuditProjectionFile(store.eventStorePath, store.projectionPath);
    const rebuilt = JSON.parse(await fs.readFile(store.projectionPath, 'utf8'));

    expect({ ...rebuilt, rebuiltAt: '2026-05-17T01:00:00.000Z' }).toEqual(expected);
  });

  itOnLockFriendlyFs('serializes concurrent appends without losing events', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.createFindingCandidate(
          {
            id: `finding-${index}`,
            sessionId: 'session-1',
            title: `Finding ${index}`,
            fingerprint: `fp-${index}`,
          },
          { id: `evt-finding-${index}` },
          { retryDelayMs: 1, maxAttempts: 200 },
        ),
      ),
    );

    const state = await store.load();
    expect(state.events).toHaveLength(6);
    expect(new Set(state.events.map((event) => event.id)).size).toBe(6);
  });

  it('rejects corrupted JSON and duplicate event ids', async () => {
    await fs.mkdir(path.dirname(store.eventStorePath), { recursive: true });
    await fs.writeFile(store.eventStorePath, '{not-json', 'utf8');
    await expect(store.load()).rejects.toThrow('audit event store is not valid JSON');

    await fs.writeFile(
      store.eventStorePath,
      JSON.stringify({
        schemaVersion: 1,
        events: [
          { ...verifiedEvent(), id: 'dup' },
          { ...verifiedEvent(), id: 'dup' },
        ],
      }),
      'utf8',
    );
    await expect(store.load()).rejects.toThrow('duplicate audit event id: dup');
  });

  it('does not mutate existing event history when appending', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });
    const before = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));

    await store.createFindingCandidate(
      {
        id: 'finding-1',
        sessionId: 'session-1',
        title: 'Finding',
        fingerprint: 'fp-1',
      },
      { id: 'evt-2' },
    );

    const after = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    expect(after.events[0]).toEqual(before.events[0]);
    expect(after.events).toHaveLength(2);
  });
});

function verifiedEvent(): AuditEvent {
  return {
    id: 'evt-3',
    type: 'FindingVerified',
    occurredAt: '2026-05-17T00:00:02.000Z',
    sessionId: 'session-1',
    findingId: 'finding-1',
    verification: {
      verifiedAt: '2026-05-17T00:00:02.000Z',
      status: 'OPEN',
      evidence: [evidence],
      reasonCodes: ['fresh-positive-evidence'],
      verifierVersion: 'verifier-1',
    },
  };
}
