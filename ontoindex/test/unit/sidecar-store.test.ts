import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LocalSidecarStore,
  SIDECAR_STORE_SCHEMA_VERSION,
  createEmptySidecarStoreState,
  createEnrichmentRecord,
  createSidecarRequest,
  submitSidecarStoreRequest,
  upsertSidecarStoreEnrichment,
  loadSidecarStoreState,
  saveSidecarStoreState,
  type SidecarStoreState,
} from '../../src/core/ingestion/enrichment/index.js';

let tmpDir: string;
let statePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-sidecar-store-'));
  statePath = path.join(tmpDir, 'sidecar-state.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const request = createSidecarRequest({
  id: 'request-1',
  repoId: 'repo-1',
  sourceIndexId: 'index-1',
  analyzerId: 'ts-type-aware',
  analyzerVersion: '1.0.0',
  purpose: 'type-aware-resolution',
  scopeHash: 'scope-1',
  priority: 'user-requested',
  requestedAt: '2026-05-13T00:00:00.000Z',
  status: 'queued',
});

const enrichment = createEnrichmentRecord({
  sourceIndexId: 'index-1',
  sourceCommitHash: 'commit-1',
  schemaVersion: 2,
  analyzerId: 'ts-type-aware',
  analyzerVersion: '1.0.0',
  filePath: 'src/app.ts',
  fileHash: 'hash-1',
  status: 'complete',
  confidence: 0.9,
  records: [{ kind: 'call-edge', from: 'main', to: 'run' }],
});

const lock = {
  ownerId: 'owner-1',
  pid: 1234,
  startedAt: '2026-05-13T00:00:00.000Z',
  heartbeatAt: '2026-05-13T00:00:10.000Z',
  sourceIndexId: 'index-1',
  analyzerId: 'ts-type-aware',
  leaseExpiresAt: '2026-05-13T00:01:10.000Z',
};

function updateLockPath(): string {
  return path.join(tmpDir, '.sidecar-state.json.update.lock');
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('local sidecar store', () => {
  it('loads missing state files as empty versioned state', async () => {
    await expect(loadSidecarStoreState(statePath)).resolves.toEqual(createEmptySidecarStoreState());
  });

  it('persists requests, the current lock, and enrichment records in one JSON state file', async () => {
    const state: SidecarStoreState = {
      schemaVersion: SIDECAR_STORE_SCHEMA_VERSION,
      requests: [{ ...request, updatedAt: '2026-05-13T00:00:05.000Z' }],
      lock,
      enrichments: [enrichment],
      manifest: null,
    };

    await saveSidecarStoreState(statePath, state);

    const raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
    expect(raw).toMatchObject({
      schemaVersion: 2,
      requests: [{ id: 'request-1' }],
      lock: { ownerId: 'owner-1' },
      enrichments: [{ filePath: 'src/app.ts' }],
    });
    await expect(loadSidecarStoreState(statePath)).resolves.toEqual(state);
  });

  it('normalizes persisted request and enrichment records through existing constructors', async () => {
    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        requests: [
          {
            ...request,
            requestedAt: '2026-05-13T00:00:00Z',
            updatedAt: '2026-05-13T00:00:05Z',
            mergedRequestIds: ['z', 'a'],
          },
        ],
        lock,
        enrichments: [
          {
            ...enrichment,
            records: [{ kind: 'call-edge', to: 'run', from: 'main' }],
          },
        ],
      }),
      'utf8',
    );

    const loaded = await loadSidecarStoreState(statePath);

    expect(loaded.requests[0]).toMatchObject({
      requestedAt: '2026-05-13T00:00:00.000Z',
      updatedAt: '2026-05-13T00:00:05.000Z',
      mergedRequestIds: ['a', 'z'],
    });
    expect(loaded.enrichments[0]).toEqual(enrichment);
  });

  it('rejects malformed persisted state instead of silently accepting it', async () => {
    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        requests: [{ ...request, priority: 'urgent' }],
        lock: null,
        enrichments: [],
      }),
      'utf8',
    );

    await expect(loadSidecarStoreState(statePath)).rejects.toThrow(
      'priority has unsupported value: urgent',
    );
  });

  it('rejects malformed lock and enrichment payloads', async () => {
    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        requests: [],
        lock: { ...lock, pid: 0 },
        enrichments: [],
      }),
      'utf8',
    );
    await expect(loadSidecarStoreState(statePath)).rejects.toThrow(
      'lock.pid must be a positive integer',
    );

    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        requests: [],
        lock: null,
        enrichments: [{ ...enrichment, records: [{}] }],
      }),
      'utf8',
    );
    await expect(loadSidecarStoreState(statePath)).rejects.toThrow(
      'enrichments[0].records[0].kind must be a string',
    );
  });

  it('offers a small class adapter over the load and save functions', async () => {
    const store = new LocalSidecarStore(statePath);
    const state = { ...createEmptySidecarStoreState(), requests: [request] };

    await store.save(state);

    await expect(store.load()).resolves.toEqual(state);
  });

  it('submits requests through the request pool so persisted duplicates merge', () => {
    const state = createEmptySidecarStoreState();

    expect(submitSidecarStoreRequest(state, request)).toMatchObject({ status: 'queued' });
    expect(
      submitSidecarStoreRequest(state, {
        ...request,
        id: 'request-2',
        priority: 'unresolved-calls',
        requestedAt: '2026-05-13T00:00:10.000Z',
        durability: 'persistent',
      }),
    ).toMatchObject({ status: 'merged' });

    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]).toMatchObject({
      id: 'request-1',
      priority: 'user-requested',
      durability: 'persistent',
      mergedRequestIds: ['request-2'],
    });
  });

  it('upserts enrichment records by snapshot analyzer and file identity', () => {
    const state = { ...createEmptySidecarStoreState(), enrichments: [enrichment] };

    const updated = upsertSidecarStoreEnrichment(state, {
      ...enrichment,
      status: 'partial',
      confidence: 0.7,
      records: [{ kind: 'call-edge', from: 'main', to: 'rerun' }],
    });

    expect(updated.status).toBe('partial');
    expect(state.enrichments).toEqual([updated]);
  });

  it('persists request and enrichment upserts across a fresh store instance', async () => {
    const store = new LocalSidecarStore(statePath);

    await store.submitRequest(request);
    await store.upsertEnrichment(enrichment);
    await store.setLock(lock);

    const reloaded = new LocalSidecarStore(statePath);
    await expect(reloaded.load()).resolves.toMatchObject({
      requests: [{ id: 'request-1' }],
      enrichments: [{ filePath: 'src/app.ts', status: 'complete' }],
      lock: { ownerId: 'owner-1' },
    });
  });

  it('updates state through an atomic read-modify-write operation', async () => {
    const store = new LocalSidecarStore(statePath);

    const result = await store.update((state) => {
      state.requests.push(request);
      return state.requests.length;
    });

    expect(result).toBe(1);
    await expect(store.load()).resolves.toMatchObject({
      requests: [{ id: 'request-1' }],
    });
  });

  it('blocks a concurrent updater while the update lock is held', async () => {
    const store = new LocalSidecarStore(statePath);
    const release = defer();
    let enteredFirstUpdate!: () => void;
    const firstUpdateEntered = new Promise<void>((resolve) => {
      enteredFirstUpdate = resolve;
    });

    const firstUpdate = store.update(
      async (state) => {
        enteredFirstUpdate();
        state.requests.push(request);
        await release.promise;
      },
      { ownerId: 'first-updater' },
    );
    await firstUpdateEntered;

    await expect(
      store.update((state) => state.requests.push(request), {
        maxAttempts: 1,
        retryDelayMs: 0,
        staleLockMs: 60_000,
        ownerId: 'second-updater',
      }),
    ).rejects.toThrow('timed out acquiring sidecar store update lock');

    release.resolve();
    await firstUpdate;
    await expect(fs.stat(updateLockPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers from a stale update lock', async () => {
    const store = new LocalSidecarStore(statePath);
    await fs.writeFile(
      updateLockPath(),
      JSON.stringify({
        ownerId: 'stale-owner',
        pid: process.pid,
        acquiredAt: '2026-05-13T00:00:00.000Z',
        stateFilePath: statePath,
      }),
      'utf8',
    );
    const oldLockTime = new Date('2026-05-13T00:00:00.000Z');
    await fs.utimes(updateLockPath(), oldLockTime, oldLockTime);

    await store.update(
      (state) => {
        state.requests.push(request);
      },
      { maxAttempts: 2, retryDelayMs: 0, staleLockMs: 1, ownerId: 'fresh-owner' },
    );

    await expect(store.load()).resolves.toMatchObject({
      requests: [{ id: 'request-1' }],
    });
    await expect(fs.stat(updateLockPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up the update lock after a thrown mutator', async () => {
    const store = new LocalSidecarStore(statePath);

    await expect(
      store.update(
        () => {
          throw new Error('mutator failed');
        },
        { ownerId: 'throwing-updater' },
      ),
    ).rejects.toThrow('mutator failed');

    await expect(fs.stat(updateLockPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('routes submit and enrichment upserts through the update lock', async () => {
    const store = new LocalSidecarStore(statePath);
    const release = defer();
    let enteredUpdate!: () => void;
    const updateEntered = new Promise<void>((resolve) => {
      enteredUpdate = resolve;
    });

    const heldUpdate = store.update(
      async () => {
        enteredUpdate();
        await release.promise;
      },
      { ownerId: 'held-update' },
    );
    await updateEntered;

    let submitResolved = false;
    const submit = store.submitRequest(request).then((result) => {
      submitResolved = true;
      return result;
    });
    await wait(2);
    expect(submitResolved).toBe(false);

    release.resolve();
    await heldUpdate;
    await expect(submit).resolves.toMatchObject({ status: 'queued' });

    await store.upsertEnrichment(enrichment);
    await expect(store.load()).resolves.toMatchObject({
      requests: [{ id: 'request-1' }],
      enrichments: [{ filePath: 'src/app.ts' }],
    });
  });

  // REV-10: sidecar manifest cache and deep freshness
  it('migrates a v1 store file to v2 by adding manifest: null', async () => {
    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        requests: [],
        lock: null,
        enrichments: [],
      }),
      'utf8',
    );

    const loaded = await loadSidecarStoreState(statePath);

    expect(loaded.schemaVersion).toBe(SIDECAR_STORE_SCHEMA_VERSION);
    expect(loaded.manifest).toBeNull();
  });

  it('persists and reloads a manifest through setManifest', async () => {
    const store = new LocalSidecarStore(statePath);
    const manifest = {
      repoId: 'repo-1',
      repoPath: '/repo',
      sourceIndexId: 'index-1',
      sourceCommitHash: 'abc123',
      graphSchemaVersion: 42,
      analyzerId: 'markdown-document-sidecar' as const,
      analyzerVersion: '1.0.0',
      files: [{ docPath: 'docs/api.md', fileHash: 'hash-abc' }],
    };

    await store.setManifest(manifest);

    const reloaded = await store.load();
    expect(reloaded.manifest).toEqual(manifest);
  });

  it('persists null manifest and reloads it as null', async () => {
    const store = new LocalSidecarStore(statePath);
    await store.setManifest({
      repoId: 'r',
      repoPath: '/r',
      sourceIndexId: 'i',
      sourceCommitHash: 'c',
      graphSchemaVersion: 1,
      analyzerId: 'markdown-document-sidecar' as const,
      analyzerVersion: '1',
      files: [],
    });
    await store.setManifest(null);

    const reloaded = await store.load();
    expect(reloaded.manifest).toBeNull();
  });

  it('rejects an unknown schema version', async () => {
    await fs.writeFile(
      statePath,
      JSON.stringify({ schemaVersion: 99, requests: [], lock: null, enrichments: [] }),
      'utf8',
    );
    await expect(loadSidecarStoreState(statePath)).rejects.toThrow('schemaVersion must be');
  });
});
