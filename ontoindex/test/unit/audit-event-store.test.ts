import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUDIT_EVENT_STORE_GENESIS_PREVIOUS_CHECKSUM,
  AUDIT_EVENT_STORE_SCHEMA_VERSION,
  LocalAuditEventStore,
  getAuditEventStorePath,
  getAuditProjectionPath,
  inspectAuditEventStoreRaw,
  loadAuditEventStoreState,
  recoverAuditEventStore,
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
      integrity: { status: 'VALID' },
    });
  });

  it('creates a session and writes a disposable projection', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });

    const rawStore = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    expect(rawStore).toMatchObject({
      schemaVersion: 2,
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
    const raw = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    expect(raw.events.map((event: { sequence: number }) => event.sequence)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  it('rejects corrupted JSON and duplicate event ids', async () => {
    await fs.mkdir(path.dirname(store.eventStorePath), { recursive: true });
    await fs.writeFile(store.eventStorePath, '{not-json', 'utf8');
    await expect(store.load()).rejects.toThrow('audit event store is not valid JSON');

    await fs.writeFile(
      store.eventStorePath,
      JSON.stringify({
        schemaVersion: 2,
        events: [
          { ...verifiedEvent(), id: 'dup' },
          { ...verifiedEvent(), id: 'dup' },
        ],
      }),
      'utf8',
    );
    await expect(store.load()).rejects.toThrow('duplicate audit event id: dup');
  });

  it('writes deterministic v2 integrity envelopes with the genesis link', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });
    const raw = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    expect(raw.schemaVersion).toBe(2);
    expect(raw.events[0]).toMatchObject({
      sequence: 0,
      previousChecksum: AUDIT_EVENT_STORE_GENESIS_PREVIOUS_CHECKSUM,
    });
    expect(raw.events[0].checksum).toMatch(/^[a-f0-9]{64}$/);
    const checksum = raw.events[0].checksum;
    await saveAuditEventStoreState(store.eventStorePath, await store.load());
    const saved = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    expect(saved.events[0].checksum).toBe(checksum);
  });

  it('reports broken v2 chains without laundering them on save', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });
    const raw = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    raw.events[0].session.targetHead = 'mutated';
    await fs.writeFile(store.eventStorePath, JSON.stringify(raw), 'utf8');
    await expect(store.load()).resolves.toMatchObject({ integrity: { status: 'BROKEN' } });
    await expect(
      saveAuditEventStoreState(store.eventStorePath, await store.load()),
    ).rejects.toThrow('cannot save audit event store with broken on-disk chain');
  });

  it('fails closed when a schema-v2 store has integrity envelopes stripped', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });
    const raw = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    delete raw.events[0].sequence;
    delete raw.events[0].previousChecksum;
    delete raw.events[0].checksum;
    await fs.writeFile(store.eventStorePath, JSON.stringify(raw), 'utf8');

    await expect(store.load()).resolves.toMatchObject({
      integrity: { status: 'BROKEN', reason: 'missing-integrity-envelope' },
    });
    await expect(
      saveAuditEventStoreState(store.eventStorePath, await store.load()),
    ).rejects.toThrow('cannot save audit event store with broken on-disk chain');

    const after = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    expect(after.events[0].sequence).toBeUndefined();
    expect(after.events[0].checksum).toBeUndefined();
  });

  it('reads v1 as legacy and refuses to migrate it in place', async () => {
    await fs.mkdir(path.dirname(store.eventStorePath), { recursive: true });
    await fs.writeFile(
      store.eventStorePath,
      JSON.stringify({
        schemaVersion: 1,
        events: [
          {
            id: 'legacy-1',
            type: 'AuditIngested',
            occurredAt: sessionInput.createdAt,
            sessionId: sessionInput.id,
            session: sessionInput,
          },
        ],
      }),
      'utf8',
    );
    await expect(store.load()).resolves.toMatchObject({
      integrity: { status: 'LEGACY_UNVERIFIED' },
    });
    const before = await fs.readFile(store.eventStorePath);
    await expect(
      store.createFindingCandidate(
        { id: 'finding-new', sessionId: 'session-1', title: 'Finding', fingerprint: 'fp-new' },
        { id: 'evt-new' },
      ),
    ).rejects.toThrow('cannot write to an unverified legacy audit event store');
    expect(await fs.readFile(store.eventStorePath)).toEqual(before);
  });

  it('does not let envelope stripping plus an append launder tampered history', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });
    await store.createFindingCandidate(
      { id: 'finding-1', sessionId: 'session-1', title: 'Original', fingerprint: 'fp-1' },
      { id: 'evt-2', occurredAt: '2026-05-17T00:00:01.000Z' },
    );
    const raw = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    raw.events[1].finding.title = 'TAMPERED';
    const stripped = raw.events.map(
      ({ sequence, checksum, previousChecksum, ...event }: Record<string, unknown>) => event,
    );
    await fs.writeFile(
      store.eventStorePath,
      JSON.stringify({ schemaVersion: 1, events: stripped }),
      'utf8',
    );

    await expect(store.load()).resolves.toMatchObject({
      integrity: { status: 'LEGACY_UNVERIFIED' },
    });
    await expect(
      store.appendEvent({
        id: 'evt-lint',
        type: 'AuditLinted',
        occurredAt: '2026-05-17T00:00:09.000Z',
        sessionId: 'session-1',
        status: 'passed',
        findingIds: ['finding-1'],
        warnings: [],
      }),
    ).rejects.toThrow('cannot write to an unverified legacy audit event store');
    await expect(store.load()).resolves.toMatchObject({
      integrity: { status: 'LEGACY_UNVERIFIED' },
    });
  });

  it('archives an unverified legacy store into a fresh empty chain', async () => {
    await fs.mkdir(path.dirname(store.eventStorePath), { recursive: true });
    await fs.writeFile(
      store.eventStorePath,
      JSON.stringify({
        schemaVersion: 1,
        events: [
          {
            id: 'legacy-1',
            type: 'AuditIngested',
            occurredAt: sessionInput.createdAt,
            sessionId: sessionInput.id,
            session: sessionInput,
          },
        ],
      }),
      'utf8',
    );
    const original = await fs.readFile(store.eventStorePath);

    const recovery = await recoverAuditEventStore(store.eventStorePath, store.projectionPath);

    expect(await fs.readFile(recovery.archivePath)).toEqual(original);
    await expect(store.load()).resolves.toMatchObject({
      events: [],
      integrity: { status: 'VALID' },
    });
  });

  it('binds the legacy boundary into every checksum', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });
    const raw = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    expect(
      raw.events.every((event: Record<string, unknown>) => event.legacyPrefixLength === undefined),
    ).toBe(true);
    raw.legacyPrefixLength = 1;
    await fs.writeFile(store.eventStorePath, JSON.stringify(raw), 'utf8');

    // legacyPrefixLength participates in every checksum, so injecting a boundary
    // cannot silently reclassify already-signed events.
    await expect(store.load()).resolves.toMatchObject({
      integrity: { status: 'BROKEN', firstBrokenSequence: 0, reason: 'checksum-mismatch' },
    });
  });

  it('rejects an out-of-range legacy boundary as broken integrity', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });
    const raw = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    raw.legacyPrefixLength = 2;
    await fs.writeFile(store.eventStorePath, JSON.stringify(raw), 'utf8');

    await expect(store.load()).resolves.toMatchObject({
      integrity: {
        status: 'BROKEN',
        firstBrokenSequence: 0,
        reason: 'invalid-legacy-prefix-length',
      },
    });
  });

  it('does not let a schema downgrade launder a broken chain', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });
    const raw = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    raw.events[0].session.targetHead = 'mutated';
    raw.schemaVersion = 1;
    await fs.writeFile(store.eventStorePath, JSON.stringify(raw), 'utf8');

    await expect(store.load()).resolves.toMatchObject({
      integrity: { status: 'BROKEN', reason: 'checksum-mismatch' },
    });
  });

  it('normalizes every event type idempotently across a save/load round trip', async () => {
    await seedAllEventTypes(store);
    const first = await store.load();
    await saveAuditEventStoreState(store.eventStorePath, first);
    const second = await store.load();

    expect(second.events).toEqual(first.events);
    expect(second.integrity).toEqual({ status: 'VALID' });
  });

  it('reports insertion at the first affected sequence', async () => {
    await seedVerifiedFinding(store);
    const raw = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    raw.events.splice(1, 0, { ...raw.events[2], id: 'evt-inserted' });
    await fs.writeFile(store.eventStorePath, JSON.stringify(raw), 'utf8');

    await expect(store.load()).resolves.toMatchObject({
      integrity: { status: 'BROKEN', firstBrokenSequence: 1 },
    });
  });

  it('reports reordering at the first affected sequence', async () => {
    await seedVerifiedFinding(store);
    const raw = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    raw.events = [raw.events[1], raw.events[0], raw.events[2]];
    await fs.writeFile(store.eventStorePath, JSON.stringify(raw), 'utf8');

    await expect(store.load()).resolves.toMatchObject({
      integrity: { status: 'BROKEN', firstBrokenSequence: 0 },
    });
  });

  it('still reports the retained chain valid after a tail deletion', async () => {
    await seedVerifiedFinding(store);
    const raw = JSON.parse(await fs.readFile(store.eventStorePath, 'utf8'));
    raw.events.pop();
    await fs.writeFile(store.eventStorePath, JSON.stringify(raw), 'utf8');

    // Documents the accepted limitation: deleting a valid tail is undetectable
    // without an independent trust anchor.
    await expect(store.load()).resolves.toMatchObject({ integrity: { status: 'VALID' } });
  });

  it('refuses a direct save of an unverified legacy state', async () => {
    await fs.mkdir(path.dirname(store.eventStorePath), { recursive: true });
    await fs.writeFile(
      store.eventStorePath,
      JSON.stringify({
        schemaVersion: 1,
        events: [
          {
            id: 'legacy-1',
            type: 'AuditIngested',
            occurredAt: sessionInput.createdAt,
            sessionId: sessionInput.id,
            session: sessionInput,
          },
        ],
      }),
      'utf8',
    );
    const before = await fs.readFile(store.eventStorePath);

    await expect(
      saveAuditEventStoreState(store.eventStorePath, await store.load()),
    ).rejects.toThrow('cannot write to an unverified legacy audit event store');
    expect(await fs.readFile(store.eventStorePath)).toEqual(before);
  });

  it('refuses to overwrite malformed on-disk bytes through save', async () => {
    await fs.mkdir(path.dirname(store.eventStorePath), { recursive: true });
    const bytes = Buffer.from('{malformed', 'utf8');
    await fs.writeFile(store.eventStorePath, bytes);

    await expect(
      saveAuditEventStoreState(store.eventStorePath, {
        schemaVersion: AUDIT_EVENT_STORE_SCHEMA_VERSION,
        events: [],
      }),
    ).rejects.toThrow('cannot save over malformed audit event store');
    expect(await fs.readFile(store.eventStorePath)).toEqual(bytes);
  });

  it('inspects malformed raw bytes and archives them into a fresh empty chain', async () => {
    await fs.mkdir(path.dirname(store.eventStorePath), { recursive: true });
    const bytes = Buffer.from('{malformed', 'utf8');
    await fs.writeFile(store.eventStorePath, bytes);
    const inspected = await inspectAuditEventStoreRaw(store.eventStorePath);
    expect(inspected.parseError).toBeTruthy();
    const recovery = await recoverAuditEventStore(store.eventStorePath, store.projectionPath);
    expect(recovery.archiveBytes).toBe(bytes.length);
    expect(await fs.readFile(recovery.archivePath)).toEqual(bytes);
    await expect(store.load()).resolves.toMatchObject({
      events: [],
      integrity: { status: 'VALID' },
    });
  });

  it('refuses recovery for a healthy store without changing its bytes', async () => {
    await store.createSession(sessionInput, { id: 'evt-1' });
    const before = await fs.readFile(store.eventStorePath);

    await expect(
      recoverAuditEventStore(store.eventStorePath, store.projectionPath),
    ).rejects.toThrow('cannot recover audit event store with VALID integrity');
    expect(await fs.readFile(store.eventStorePath)).toEqual(before);
  });

  itOnLockFriendlyFs('uses the append lock during recovery', async () => {
    await fs.mkdir(path.dirname(store.eventStorePath), { recursive: true });
    const bytes = Buffer.from('{malformed', 'utf8');
    await fs.writeFile(store.eventStorePath, bytes);
    const lockPath = path.join(
      path.dirname(store.eventStorePath),
      `.${path.basename(store.eventStorePath)}.update.lock`,
    );
    await fs.writeFile(
      lockPath,
      JSON.stringify({ ownerId: 'active-owner', acquiredAt: new Date().toISOString() }),
      'utf8',
    );

    await expect(
      recoverAuditEventStore(store.eventStorePath, store.projectionPath, {
        maxAttempts: 1,
        staleLockMs: 60_000,
      }),
    ).rejects.toThrow('timed out acquiring audit event store update lock');
    expect(await fs.readFile(store.eventStorePath)).toEqual(bytes);
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

async function seedVerifiedFinding(target: LocalAuditEventStore): Promise<void> {
  await target.createSession(sessionInput, { id: 'evt-1' });
  await target.createFindingCandidate(
    { id: 'finding-1', sessionId: 'session-1', title: 'Finding', fingerprint: 'fp-1' },
    { id: 'evt-2', occurredAt: '2026-05-17T00:00:01.000Z' },
  );
  await target.appendEvent(verifiedEvent());
}

// Covers all nine AuditEvent variants, including a non-UTC timestamp, an
// unsorted array with duplicates, and an unknown field on the input.
async function seedAllEventTypes(target: LocalAuditEventStore): Promise<void> {
  await target.createSession(sessionInput, { id: 'evt-1' });
  await target.createFindingCandidate(
    { id: 'finding-1', sessionId: 'session-1', title: 'Finding', fingerprint: 'fp-1' },
    { id: 'evt-2', occurredAt: '2026-05-17T02:00:01.000+02:00' },
  );
  await target.appendEvent(verifiedEvent());
  await target.appendEvent({
    id: 'evt-4',
    type: 'FindingStatusChanged',
    occurredAt: '2026-05-17T00:00:03.000Z',
    sessionId: 'session-1',
    findingId: 'finding-1',
    status: 'RESOLVED-ALREADY',
    reason: 'negative evidence still holds',
  } as AuditEvent);
  await target.appendEvent({
    id: 'evt-5',
    type: 'FindingTombstoned',
    occurredAt: '2026-05-17T00:00:04.000Z',
    sessionId: 'session-1',
    findingId: 'finding-1',
    tombstone: {
      tombstonedAt: '2026-05-17T00:00:04.000Z',
      reason: 'fixed before ingest',
      evidence: [evidence],
    },
  });
  await target.appendEvent({
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
  await target.appendEvent({
    id: 'evt-7',
    type: 'BundleDispatched',
    occurredAt: '2026-05-17T00:00:06.000Z',
    sessionId: 'session-1',
    bundleId: 'bundle-1',
    dispatchedAt: '2026-05-17T00:00:06.000Z',
    metadata: { worker: 'external', unknownField: 'preserved' },
  });
  await target.appendEvent({
    id: 'evt-8',
    type: 'AuditLinted',
    occurredAt: '2026-05-17T00:00:07.000Z',
    sessionId: 'session-1',
    status: 'passed',
    findingIds: ['finding-1', 'finding-1', 'finding-0'],
    warnings: [],
  });
  await target.appendEvent({
    id: 'evt-9',
    type: 'ScopeGuardEvaluated',
    occurredAt: '2026-05-17T00:00:08.000Z',
    sessionId: 'session-1',
    status: 'passed',
    metadata: { changedFiles: [] },
  });
}
