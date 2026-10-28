import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { LocalAuditEventStore } from '../../src/core/audit-lifecycle/audit-event-store.js';
import type {
  AuditEvidence,
  AuditFindingStatus,
} from '../../src/core/audit-lifecycle/audit-session.js';
import { getAuditSessionLockPath } from '../../src/core/audit-lifecycle/session-lock.js';
import { dispatchFacade } from '../../src/mcp/facade/dispatch.js';
import { dispatchSuper, SUPER_NAMES } from '../../src/mcp/super/dispatch.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../src/mcp/super/tool-definitions.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { createMCPServer } from '../../src/mcp/server.js';
import {
  activateIndexGeneration,
  createIndexGeneration,
  registerRepo,
  saveMeta,
} from '../../src/storage/repo-manager.js';

describe('audit lifecycle MCP integration', () => {
  it('matches session lock create, load and default validation with only lock-file writes', async () => {
    const repo = initRepo();
    const session = 'session-facade-lock';
    try {
      await seedManagerSession(repo, session, ['finding-a']);
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      const before = paths.map((file) => readFileSync(file));
      const lockPath = getAuditSessionLockPath(repo, session);
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const options = {
        repo,
        sessionId: session,
        ontoindexVersion: 'fixture-version',
        persist: false,
      };
      const direct = (await dispatchSuper(
        'gn_audit_session_lock',
        { ...options, action: 'create' },
        repo,
      )) as Record<string, any>;
      const facade = await dispatchFacade(
        'audit',
        'session_lock',
        { ...options, action: 'session_lock', lock_action: 'create' },
        backend,
      );
      expect(facade).toEqual({ repoLabel: repo, repoPath: repo, ...direct });
      expect(direct).toMatchObject({
        operation: 'create',
        lock: {
          sessionId: session,
          targetHead: head(repo),
          graphIndexId: expect.stringMatching(/^legacy:/),
          graphHash: expect.any(String),
          ontoindexVersion: 'fixture-version',
          createdAt: '2026-05-17T00:00:00.000Z',
        },
      });
      // The existing create handler persists a lock even when persist is false.
      expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(direct.lock);
      expect(paths.map((file) => readFileSync(file))).toEqual(before);
      const snapshot = [...paths, lockPath].map((file) => readFileSync(file));
      for (const lock_action of ['load', 'validate', undefined]) {
        const args = {
          repo,
          session: 'ignored-alias',
          sessionId: session,
          currentHead: head(repo),
          graphIndexId: direct.lock.graphIndexId,
          graphHash: direct.lock.graphHash,
        };
        const expected = (await dispatchSuper(
          'gn_audit_session_lock',
          {
            ...args,
            ...(lock_action === undefined ? {} : { action: lock_action }),
          },
          repo,
        )) as Record<string, any>;
        const actual = await dispatchFacade(
          'audit',
          'session_lock',
          {
            ...args,
            action: 'session_lock',
            ...(lock_action === undefined ? {} : { lock_action }),
          },
          backend,
        );
        expect(actual).toEqual({ repoLabel: repo, repoPath: repo, ...expected });
        expect(expected).toMatchObject(
          lock_action === 'load'
            ? { operation: 'load', lock: direct.lock }
            : { operation: 'validate', status: 'VALID_SESSION', ok: true, lock: direct.lock },
        );
        expect([...paths, lockPath].map((file) => readFileSync(file))).toEqual(snapshot);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects caller assertions that differ from live state without writing', async () => {
    const repo = initRepo();
    const session = 'session-facade-lock-drift';
    try {
      await seedManagerSession(repo, session, ['finding-a']);
      await dispatchSuper('gn_audit_session_lock', { repo, session, action: 'create' }, repo);
      const store = new LocalAuditEventStore(repo);
      const paths = [
        store.eventStorePath,
        store.projectionPath,
        getAuditSessionLockPath(repo, session),
      ];
      const before = paths.map((file) => readFileSync(file));
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      for (const [field, options] of [
        ['currentHead', { currentHead: 'different-head' }],
        ['graphIndexId', { graphIndexId: 'graph-2' }],
        ['graphHash', { graphHash: 'graph-hash-2' }],
      ] as const) {
        const args = { repo, session, ...options };
        await expect(
          dispatchSuper('gn_audit_session_lock', { ...args, action: 'validate' }, repo),
        ).rejects.toThrow(new RegExp(`${field}.*live`));
        await expect(
          dispatchFacade(
            'audit',
            'session_lock',
            { ...args, action: 'session_lock', lock_action: 'validate' },
            backend,
          ),
        ).rejects.toThrow(new RegExp(`${field}.*live`));
        expect(paths.map((file) => readFileSync(file))).toEqual(before);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('detects metadata publication drift at unchanged HEAD and refuses manager writes', async () => {
    const repo = initRepo();
    const session = 'session-metadata-drift';
    try {
      await seedManagerSession(repo, session, ['finding-a']);
      const created = (await dispatchSuper(
        'gn_audit_session_lock',
        { repo, session, action: 'create' },
        repo,
      )) as Record<string, any>;
      const store = new LocalAuditEventStore(repo);
      const paths = [
        store.eventStorePath,
        store.projectionPath,
        getAuditSessionLockPath(repo, session),
      ];
      const before = paths.map((file) => readFileSync(file));
      const metaPath = path.join(repo, '.ontoindex/meta.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      writeFileSync(metaPath, JSON.stringify({ ...meta, indexedAt: '2026-05-18T00:00:00.000Z' }));
      const stale = (await dispatchSuper(
        'gn_audit_session_lock',
        { repo, session, action: 'validate' },
        repo,
      )) as Record<string, any>;
      expect(stale).toMatchObject({ status: 'STALE_SESSION', ok: false });
      expect(stale.staleFields.map((change: { field: string }) => change.field)).toEqual([
        'graphIndexId',
        'graphHash',
      ]);
      expect(stale.current.targetHead).toBe(created.lock.targetHead);
      for (const assertions of [
        { graphIndexId: created.lock.graphIndexId },
        { graphHash: created.lock.graphHash },
      ]) {
        await expect(
          dispatchSuper(
            'gn_audit_session_lock',
            { repo, session, action: 'validate', ...assertions },
            repo,
          ),
        ).rejects.toThrow(/live/);
      }
      for (const name of [
        'gn_audit_session_verify',
        'gn_audit_session_bundle',
        'gn_audit_session_dispatch',
      ]) {
        const report = (await dispatchSuper(name, { repo, session }, repo)) as Record<string, any>;
        expect(report).toMatchObject({ ok: false, code: 'STALE_SESSION' });
      }
      expect(paths.map((file) => readFileSync(file))).toEqual(before);
      const recreated = (await dispatchSuper(
        'gn_audit_session_lock',
        { repo, session, action: 'create' },
        repo,
      )) as Record<string, any>;
      expect(recreated.lock.graphIndexId).toBe(stale.current.graphIndexId);
      expect(await dispatchSuper('gn_audit_session_lock', { repo, session }, repo)).toMatchObject({
        ok: true,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('detects replacement of an active graph generation at unchanged HEAD', async () => {
    const repo = initRepo();
    const session = 'session-generation-drift';
    try {
      const storagePath = path.join(repo, '.ontoindex');
      const publish = async (id: string) => {
        const generation = await createIndexGeneration(storagePath, id);
        writeFileSync(generation.lbugPath, 'fixture graph');
        writeFileSync(generation.snapshotPath, '{}');
        writeFileSync(
          generation.metaPath,
          JSON.stringify({
            repoPath: repo,
            lastCommit: head(repo),
            indexedAt: '2026-05-17T00:00:00.000Z',
            generationId: id,
          }),
        );
        await activateIndexGeneration(storagePath, generation);
      };
      await publish('audit-generation-one');
      await seedManagerSession(repo, session, ['finding-a']);
      const created = (await dispatchSuper(
        'gn_audit_session_lock',
        { repo, session, action: 'create' },
        repo,
      )) as Record<string, any>;
      expect(created.lock.graphIndexId).toBe('audit-generation-one');
      await publish('audit-generation-two');
      const stale = (await dispatchSuper(
        'gn_audit_session_lock',
        { repo, session },
        repo,
      )) as Record<string, any>;
      expect(stale).toMatchObject({
        ok: false,
        code: 'STALE_SESSION',
        current: { graphIndexId: 'audit-generation-two' },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'corrupt', 'tagged-root', 'malformed', 'wrong-repo', 'stale-head'])(
    'fails closed before start or create writes with %s metadata',
    async (scenario) => {
      const repo = initRepo();
      const session = `session-invalid-${scenario}`;
      try {
        const store = new LocalAuditEventStore(repo);
        const metaPath = path.join(repo, '.ontoindex/meta.json');
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        if (scenario === 'missing') rmSync(metaPath);
        else
          writeFileSync(
            metaPath,
            scenario === 'corrupt'
              ? '{'
              : JSON.stringify({
                  ...meta,
                  ...(scenario === 'tagged-root' ? { generationId: 'unpublished' } : {}),
                  ...(scenario === 'malformed' ? { indexedAt: 'invalid' } : {}),
                  ...(scenario === 'wrong-repo' ? { repoPath: tmpdir() } : {}),
                  ...(scenario === 'stale-head' ? { lastCommit: 'old-head' } : {}),
                }),
          );
        await expect(
          dispatchSuper(
            'gn_audit_session_start',
            {
              repo,
              pastedText: '## Missing guard\nPath: src/app.ts\nClaim: missing guard',
              targetRef: 'HEAD',
            },
            repo,
          ),
        ).rejects.toThrow(/metadata|live HEAD/);
        expect(existsSync(store.eventStorePath)).toBe(false);
        expect(existsSync(store.projectionPath)).toBe(false);
        await seedManagerSession(repo, session, ['finding-a']);
        const paths = [store.eventStorePath, store.projectionPath];
        const before = paths.map((file) => readFileSync(file));
        await expect(
          dispatchSuper('gn_audit_session_lock', { repo, session, action: 'create' }, repo),
        ).rejects.toThrow(/metadata|live HEAD/);
        expect(paths.map((file) => readFileSync(file))).toEqual(before);
        expect(existsSync(getAuditSessionLockPath(repo, session))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it('rejects malformed lock selectors before resolution and preserves missing-session errors without writes', async () => {
    const repo = initRepo();
    const session = 'session-facade-lock-errors';
    try {
      await seedManagerSession(repo, session, ['finding-a']);
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      const before = paths.map((file) => readFileSync(file));
      const resolveRepo = vi.fn(async () => ({ id: repo, repoPath: repo }));
      const backend = { resolveRepo } as unknown as LocalBackend;
      for (const lock_action of [null, '', 'delete', 1]) {
        await expect(
          dispatchFacade('audit', 'session_lock', { repo, session, lock_action }, backend),
        ).rejects.toThrow(/lock_action/);
      }
      expect(resolveRepo).not.toHaveBeenCalled();
      for (const args of [{ repo }, { repo, session: 'missing-session' }]) {
        const outcomes = await Promise.allSettled([
          dispatchSuper('gn_audit_session_lock', { ...args, action: 'create' }, repo),
          dispatchFacade(
            'audit',
            'session_lock',
            { ...args, action: 'session_lock', lock_action: 'create' },
            backend,
          ),
        ]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
        if (outcomes[0].status === 'rejected' && outcomes[1].status === 'rejected') {
          expect(outcomes[0].reason).toBeInstanceOf(Error);
          expect(outcomes[1].reason.message).toBe(outcomes[0].reason.message);
        }
      }
      expect(paths.map((file) => readFileSync(file))).toEqual(before);
      expect(existsSync(getAuditSessionLockPath(repo, session))).toBe(false);
      expect(existsSync(getAuditSessionLockPath(repo, 'missing-session'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('matches plain facade dedupe to the real store report without changing store bytes', async () => {
    const repo = initRepo();
    const session = 'session-facade-dedupe';
    try {
      await seedManagerSession(repo, session, ['finding-a', 'finding-b']);
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      const before = paths.map((file) => readFileSync(file));
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const args = { repo, session, strategy: 'root-cause' };
      const direct = (await dispatchSuper('gn_audit_dedupe', args, repo)) as Record<string, any>;
      const facade = (await dispatchFacade('audit', 'dedupe', args, backend)) as Record<
        string,
        any
      >;

      expect(direct.groups).toHaveLength(1);
      expect(direct.groups[0]).toMatchObject({
        strategy: 'root-cause',
        findingIds: ['finding-a', 'finding-b'],
      });
      expect(facade).toEqual({ repoLabel: repo, repoPath: repo, ...direct });
      expect(paths.map((file) => readFileSync(file))).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('matches plain facade bundle to the real store report with persist false', async () => {
    const repo = initRepo();
    const session = 'session-facade-bundle-read';
    try {
      await seedManagerSession(repo, session, ['finding-a', 'finding-b']);
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      const before = paths.map((file) => readFileSync(file));
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const args = { repo, session, persist: false };
      const direct = (await dispatchSuper('gn_audit_bundle', args, repo)) as Record<string, any>;
      const facade = (await dispatchFacade('audit', 'bundle', args, backend)) as Record<
        string,
        any
      >;

      expect(direct.bundles).toHaveLength(1);
      expect(direct.bundles[0]).toMatchObject({ findingIds: ['finding-a', 'finding-b'] });
      expect(facade.bundles).toHaveLength(1);
      expect(facade.bundles[0].createdAt).toEqual(expect.any(String));
      expect({
        ...facade,
        bundles: facade.bundles.map((bundle: Record<string, unknown>, index: number) => ({
          ...bundle,
          createdAt: direct.bundles[index].createdAt,
        })),
      }).toEqual({ repoLabel: repo, repoPath: repo, ...direct });
      expect(paths.map((file) => readFileSync(file))).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('persists plain facade bundle memberships with the default strategy and limit', async () => {
    const repo = initRepo();
    const session = 'session-facade-bundle-write';
    try {
      await seedManagerSession(repo, session, ['finding-a', 'finding-b']);
      const direct = (await dispatchSuper(
        'gn_audit_bundle',
        { repo, session, persist: false },
        repo,
      )) as Record<string, any>;
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const facade = (await dispatchFacade(
        'audit',
        'bundle',
        { repo, session },
        backend,
      )) as Record<string, any>;

      expect(facade.limits).toEqual({ maxBundles: 25, emitted: 1, total: 1, truncated: false });
      expect(facade.bundles).toHaveLength(1);
      expect(facade.bundles[0]).toEqual({ ...direct.bundles[0], createdAt: expect.any(String) });
      expect(facade.bundles[0]).toMatchObject({
        strategy: 'root-cause',
        findingIds: ['finding-a', 'finding-b'],
      });
      const events = (await new LocalAuditEventStore(repo).load()).events.filter(
        (event) => event.type === 'FindingBundled',
      );
      expect(events).toHaveLength(1);
      const bundle = facade.bundles[0];
      expect(events[0]).toMatchObject({
        sessionId: session,
        bundleId: bundle.id,
        occurredAt: bundle.createdAt,
        bundle: {
          id: bundle.id,
          sessionId: session,
          findingIds: bundle.findingIds,
          status: bundle.status,
          createdAt: bundle.createdAt,
          metadata: { strategy: bundle.strategy, duplicateFindingIds: bundle.duplicateFindingIds },
        },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('matches plain facade bundle conflicts, filters and limits without changing store bytes', async () => {
    const repo = initRepo();
    const session = 'session-facade-conflicts';
    try {
      await seedManagerSession(repo, session, ['finding-a', 'finding-b'], true);
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      const before = paths.map((file) => readFileSync(file));
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const args = { repo, session, strategy: 'exact' };
      const direct = (await dispatchSuper('gn_bundle_conflicts', args, repo)) as Record<
        string,
        any
      >;

      expect(direct.bundleCount).toBe(2);
      expect(direct.conflicts).toEqual([
        expect.objectContaining({ kind: 'file', value: 'src/app.ts' }),
        expect.objectContaining({ kind: 'symbol', value: 'run' }),
        expect.objectContaining({ kind: 'test-surface', value: 'test/app.test.ts' }),
        expect.objectContaining({ kind: 'write-set', value: 'src/app.ts' }),
      ]);
      expect(direct.limits).toEqual({ maxConflicts: 50, emitted: 4, total: 4, truncated: false });
      for (const conflict of direct.conflicts) {
        expect(conflict.findingIds).toEqual(['finding-a', 'finding-b']);
        expect(conflict.bundleIds).toHaveLength(2);
      }

      for (const options of [
        {},
        { bundleIds: [] },
        { bundleIds: [direct.conflicts[0].bundleIds[0]] },
        { bundleIds: ['missing-bundle'] },
        { maxConflicts: 1 },
      ]) {
        const params = { ...args, ...options };
        const report = (await dispatchSuper('gn_bundle_conflicts', params, repo)) as Record<
          string,
          any
        >;
        const facade = await dispatchFacade('audit', 'bundle_conflicts', params, backend);
        expect(facade).toEqual({ repoLabel: repo, repoPath: repo, ...report });
        if ('maxConflicts' in options) {
          expect(report.conflicts).toEqual(direct.conflicts.slice(0, 1));
          expect(report.limits).toEqual({ maxConflicts: 1, emitted: 1, total: 4, truncated: true });
        } else if (options.bundleIds?.includes('missing-bundle')) {
          expect(report.conflicts).toEqual([]);
          expect(report.limits).toEqual({
            maxConflicts: 50,
            emitted: 0,
            total: 0,
            truncated: false,
          });
        } else {
          expect(report).toEqual(direct);
        }
      }
      for (const params of [
        { repo },
        { ...args, session: 42 },
        { ...args, bundleIds: [42] },
        { ...args, strategy: 'invalid' },
      ]) {
        const outcomes = await Promise.allSettled([
          dispatchSuper('gn_bundle_conflicts', params, repo),
          dispatchFacade('audit', 'bundle_conflicts', params, backend),
        ]);
        expect(outcomes[0].status).toBe('rejected');
        expect(outcomes[1].status).toBe('rejected');
        if (outcomes[0].status === 'rejected' && outcomes[1].status === 'rejected') {
          expect(outcomes[0].reason).toBeInstanceOf(Error);
          expect(outcomes[1].reason.message).toBe(outcomes[0].reason.message);
        }
      }
      expect(paths.map((file) => readFileSync(file))).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('matches plain facade scope guard results and errors without changing store bytes', async () => {
    const repo = initRepo();
    const session = 'session-facade-scope-read';
    try {
      await seedManagerSession(repo, session, ['finding-a']);
      const bundled = (await dispatchSuper(
        'gn_audit_bundle',
        { repo, session, persist: false },
        repo,
      )) as Record<string, any>;
      const bundleId = bundled.bundles[0].id;
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      const before = paths.map((file) => readFileSync(file));
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const args = { repo, session, bundleId, persist: false };

      for (const options of [
        {
          changedFiles: ['src/app.ts'],
          changedSymbols: ['run'],
          executedTests: ['test/app.test.ts'],
        },
        { changedFiles: ['src/outside.ts'], changedSymbols: ['outside'], executedTests: [] },
        {
          changedFiles: ['src/app.ts'],
          changedSymbols: ['run'],
          executedTests: [],
          requiredTests: [],
        },
      ]) {
        const params = { ...args, ...options };
        const direct = (await dispatchSuper('gn_scope_guard', params, repo)) as Record<string, any>;
        const facade = await dispatchFacade('audit', 'scope_guard', params, backend);
        expect(facade).toEqual({ repoLabel: repo, repoPath: repo, ...direct });
        expect(direct).toMatchObject({ action: 'scope-guard', sessionId: session, bundleId });
        if (options.changedSymbols.includes('outside')) {
          expect(direct.status).toBe('FAIL');
          expect(direct.issues).toEqual([
            expect.objectContaining({ kind: 'missing-required-test', value: 'test/app.test.ts' }),
            expect.objectContaining({ kind: 'unexpected-file', value: 'src/outside.ts' }),
            expect.objectContaining({ kind: 'unexpected-symbol', value: 'outside' }),
          ]);
        } else {
          expect(direct).toMatchObject({ status: 'PASS', issues: [] });
        }
        expect(paths.map((file) => readFileSync(file))).toEqual(before);
      }

      for (const params of [
        { repo, bundleId, persist: false },
        { repo, session, persist: false },
        { ...args, bundleId: 'missing-bundle' },
        { ...args, changedFiles: [42] },
        { ...args, requiredTests: 42 },
      ]) {
        const outcomes = await Promise.allSettled([
          dispatchSuper('gn_scope_guard', params, repo),
          dispatchFacade('audit', 'scope_guard', params, backend),
        ]);
        expect(outcomes[0].status).toBe('rejected');
        expect(outcomes[1].status).toBe('rejected');
        if (outcomes[0].status === 'rejected' && outcomes[1].status === 'rejected') {
          expect(outcomes[0].reason).toBeInstanceOf(Error);
          expect(outcomes[1].reason.message).toBe(outcomes[0].reason.message);
        }
        expect(paths.map((file) => readFileSync(file))).toEqual(before);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('persists exactly one plain facade scope guard evaluation by default', async () => {
    const repo = initRepo();
    const session = 'session-facade-scope-write';
    try {
      await seedManagerSession(repo, session, ['finding-a']);
      const bundled = (await dispatchSuper(
        'gn_audit_bundle',
        { repo, session, persist: false },
        repo,
      )) as Record<string, any>;
      const bundleId = bundled.bundles[0].id;
      const store = new LocalAuditEventStore(repo);
      const before = (await store.load()).events;
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const options = {
        changedFiles: ['src/app.ts'],
        changedSymbols: ['run'],
        executedTests: ['test/app.test.ts'],
      };
      const direct = (await dispatchSuper(
        'gn_scope_guard',
        { repo, session, bundleId, ...options, persist: false },
        repo,
      )) as Record<string, any>;
      const facade = await dispatchFacade(
        'audit',
        'scope_guard',
        { repo, sessionId: session, bundleId, ...options },
        backend,
      );

      expect(facade).toEqual({ repoLabel: repo, repoPath: repo, ...direct });
      expect(direct).toMatchObject({ status: 'PASS', issues: [] });
      const after = (await store.load()).events;
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toEqual([
        expect.objectContaining({
          type: 'ScopeGuardEvaluated',
          sessionId: session,
          status: direct.status,
          metadata: { bundleId, issues: direct.issues, ...options },
        }),
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('matches plain facade tombstone previews without changing store bytes', async () => {
    const repo = initRepo();
    const session = 'session-facade-tombstone-read';
    try {
      const proof = await seedResolvedSession(repo, session);
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      const before = paths.map((file) => readFileSync(file));
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      for (const options of [
        { session, reason: 'fixed' },
        {
          session: 'missing-session',
          sessionId: session,
          reason: 'fixed',
          invariantId: 'guard-holds',
          fixCommit: head(repo),
        },
        { sessionId: session, reason: '' },
      ]) {
        const args = { repo, findingId: 'finding-a', persist: false, ...options };
        const direct = (await dispatchSuper('gn_audit_tombstone_create', args, repo)) as Record<
          string,
          any
        >;
        const facade = (await dispatchFacade('audit', 'tombstone_create', args, backend)) as Record<
          string,
          any
        >;
        for (const report of [direct, facade]) {
          expect(report).toMatchObject({
            action: 'audit-tombstone-create',
            sessionId: session,
            findingId: 'finding-a',
            status: 'TOMBSTONED',
            tombstone: { reason: options.reason },
            fixCommit: options.fixCommit ?? null,
          });
          expect(new Date(report.tombstone.tombstonedAt).toISOString()).toBe(
            report.tombstone.tombstonedAt,
          );
          expect(report.tombstone.evidence).toEqual([proof]);
        }
        expect({
          ...facade,
          tombstone: {
            ...facade.tombstone,
            tombstonedAt: direct.tombstone.tombstonedAt,
          },
        }).toEqual({ repoLabel: repo, repoPath: repo, ...direct });
        expect(paths.map((file) => readFileSync(file))).toEqual(before);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('persists exactly one plain facade tombstone by default and projects its status', async () => {
    const repo = initRepo();
    const session = 'session-facade-tombstone-write';
    try {
      const proof = await seedResolvedSession(repo, session);
      const store = new LocalAuditEventStore(repo);
      const before = (await store.load()).events;
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const fixCommit = head(repo);
      const facade = (await dispatchFacade(
        'audit',
        'tombstone_create',
        {
          repo,
          sessionId: session,
          findingId: 'finding-a',
          reason: 'fixed',
          invariantId: 'guard-holds',
          fixCommit,
        },
        backend,
      )) as Record<string, any>;

      expect(facade).toMatchObject({ status: 'TOMBSTONED', fixCommit });
      expect(facade.tombstone.evidence).toEqual([proof]);
      const after = (await store.load()).events;
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toEqual([
        expect.objectContaining({
          type: 'FindingTombstoned',
          sessionId: session,
          findingId: 'finding-a',
          tombstone: facade.tombstone,
        }),
      ]);
      expect(after.at(-1)).not.toHaveProperty('fixCommit');
      expect(after.at(-1)).not.toHaveProperty('tombstone.fixCommit');
      const projection = JSON.parse(readFileSync(store.projectionPath, 'utf8'));
      expect(projection.findings).toContainEqual(
        expect.objectContaining({
          id: 'finding-a',
          status: 'TOMBSTONED',
          tombstone: facade.tombstone,
        }),
      );
      const persisted = [store.eventStorePath, store.projectionPath].map((file) =>
        readFileSync(file),
      );
      await expect(
        dispatchSuper(
          'gn_audit_tombstone_create',
          {
            repo,
            session,
            findingId: 'finding-a',
            reason: 'fixed again',
          },
          repo,
        ),
      ).rejects.toThrow();
      expect(
        [store.eventStorePath, store.projectionPath].map((file) => readFileSync(file)),
      ).toEqual(persisted);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([
    'open',
    'no-proof',
    'positive',
    'wrong-head',
    'wrong-graph',
    'wrong-verifier',
    'source-stale',
    'graph-stale',
    'stale-warning',
    'circular-proof',
    'status-mismatch',
  ])(
    'rejects %s tombstone evidence in preview and persistence without writes',
    async (scenario) => {
      const repo = initRepo();
      const session = `session-tombstone-${scenario}`;
      try {
        if (scenario === 'open') {
          await seedManagerSession(repo, session, ['finding-a']);
        } else {
          const changes: Partial<AuditEvidence> = {
            ...(scenario === 'positive' ? { data: { polarity: 'positive' } } : {}),
            ...(scenario === 'wrong-head' ? { targetHead: 'wrong-head' } : {}),
            ...(scenario === 'wrong-graph' ? { graphIndexId: 'wrong-graph' } : {}),
            ...(scenario === 'wrong-verifier' ? { verifierVersion: 'wrong-verifier' } : {}),
            ...(scenario === 'source-stale' ? { sourceFresh: false } : {}),
            ...(scenario === 'graph-stale' ? { graphStale: true } : {}),
            ...(scenario === 'stale-warning' ? { staleWarnings: ['source changed'] } : {}),
            ...(scenario === 'circular-proof'
              ? { id: 'tombstone-proof:finding-a', kind: 'tombstone' }
              : {}),
          };
          await seedResolvedSession(
            repo,
            session,
            changes,
            scenario === 'no-proof',
            scenario === 'status-mismatch' ? 'FALSE-POSITIVE' : 'RESOLVED-ALREADY',
          );
        }
        const store = new LocalAuditEventStore(repo);
        const paths = [store.eventStorePath, store.projectionPath];
        const before = paths.map((file) => readFileSync(file));
        const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
        for (const persist of [false, true]) {
          const args = { repo, session, findingId: 'finding-a', reason: 'fixed', persist };
          await expect(dispatchSuper('gn_audit_tombstone_create', args, repo)).rejects.toThrow();
          await expect(
            dispatchFacade('audit', 'tombstone_create', args, backend),
          ).rejects.toThrow();
          expect(paths.map((file) => readFileSync(file))).toEqual(before);
        }
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it('accepts only caller evidence that exactly matches persisted qualifying proof', async () => {
    const repo = initRepo();
    const session = 'session-tombstone-explicit';
    try {
      const proof = await seedResolvedSession(repo, session, { data: { polarity: 'negative' } });
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      const before = paths.map((file) => readFileSync(file));
      for (const evidence of [[], [{ ...proof, confidence: 1 }], [{ ...proof, id: 'forged' }]]) {
        for (const persist of [false, true]) {
          await expect(
            dispatchSuper(
              'gn_audit_tombstone_create',
              {
                repo,
                session,
                findingId: 'finding-a',
                reason: 'fixed',
                evidence,
                persist,
              },
              repo,
            ),
          ).rejects.toThrow();
          expect(paths.map((file) => readFileSync(file))).toEqual(before);
        }
      }
      const preview = (await dispatchSuper(
        'gn_audit_tombstone_create',
        {
          repo,
          session,
          findingId: 'finding-a',
          reason: 'fixed',
          evidence: [proof],
          persist: false,
        },
        repo,
      )) as Record<string, any>;
      expect(preview.tombstone.evidence).toEqual([proof]);
      expect(paths.map((file) => readFileSync(file))).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rechecks finding status after acquiring the append lock', async () => {
    const repo = initRepo();
    const session = 'session-tombstone-status-race';
    const append = LocalAuditEventStore.prototype.appendEvent;
    let interveningBytes: Buffer[] | undefined;
    try {
      await seedResolvedSession(repo, session);
      const spy = vi
        .spyOn(LocalAuditEventStore.prototype, 'appendEvent')
        .mockImplementation(async function (this: LocalAuditEventStore, event, options) {
          if (event.type === 'FindingTombstoned') {
            await append.call(this, {
              id: 'evt-intervening-status',
              type: 'FindingStatusChanged',
              occurredAt: '2026-05-17T00:00:06.000Z',
              sessionId: session,
              findingId: 'finding-a',
              status: 'OPEN',
              reason: 'new positive evidence',
            });
            interveningBytes = [this.eventStorePath, this.projectionPath].map((file) =>
              readFileSync(file),
            );
          }
          return append.call(this, event, options);
        });
      await expect(
        dispatchSuper(
          'gn_audit_tombstone_create',
          {
            repo,
            session,
            findingId: 'finding-a',
            reason: 'fixed',
          },
          repo,
        ),
      ).rejects.toThrow();
      spy.mockRestore();
      const store = new LocalAuditEventStore(repo);
      expect(interveningBytes).toBeDefined();
      expect(
        [store.eventStorePath, store.projectionPath].map((file) => readFileSync(file)),
      ).toEqual(interveningBytes);
      expect(
        (await store.load()).events.filter((event) => event.type === 'FindingTombstoned'),
      ).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('preserves plain facade tombstone errors without changing store bytes', async () => {
    const repo = initRepo();
    const session = 'session-facade-tombstone-errors';
    try {
      await seedManagerSession(repo, session, ['finding-a']);
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      const before = paths.map((file) => readFileSync(file));
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      for (const args of [
        { repo, findingId: 'finding-a', reason: 'fixed' },
        { repo, session, findingId: 'finding-a' },
        { repo, session, reason: 'fixed' },
        { repo, session, findingId: 'missing-finding', reason: 'fixed' },
      ]) {
        const outcomes = await Promise.allSettled([
          dispatchSuper('gn_audit_tombstone_create', args, repo),
          dispatchFacade('audit', 'tombstone_create', args, backend),
        ]);
        expect(outcomes[0].status).toBe('rejected');
        expect(outcomes[1].status).toBe('rejected');
        if (outcomes[0].status === 'rejected' && outcomes[1].status === 'rejected') {
          expect(outcomes[0].reason).toBeInstanceOf(Error);
          expect(outcomes[1].reason.message).toBe(outcomes[0].reason.message);
        }
        expect(paths.map((file) => readFileSync(file))).toEqual(before);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('matches plain facade dispatch prompt to the real store report without changing store bytes', async () => {
    const repo = initRepo();
    const session = 'session-facade-prompt-read';
    try {
      await seedManagerSession(repo, session, ['finding-a']);
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      const before = paths.map((file) => readFileSync(file));
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const args = { repo, session, persist: false };
      const direct = (await dispatchSuper('gn_dispatch_prompt', args, repo)) as Record<string, any>;
      const facade = (await dispatchFacade('audit', 'dispatch_prompt', args, backend)) as Record<
        string,
        any
      >;

      for (const report of [direct, facade]) {
        expect(report.action).toBe('dispatch-prompt');
        expect(report.prompt).toContain('- Finding ids: finding-a');
        expect(report.prompt).toContain(
          `- Verification timestamp: ${report.verificationTimestamp}`,
        );
        expect(new Date(report.verificationTimestamp).toISOString()).toBe(
          report.verificationTimestamp,
        );
        expect(report.limits).toEqual({
          maxPromptChars: 20_000,
          promptChars: report.prompt.length,
          truncated: false,
        });
      }
      expect({
        ...facade,
        verificationTimestamp: direct.verificationTimestamp,
        prompt: facade.prompt.replace(
          `- Verification timestamp: ${facade.verificationTimestamp}`,
          `- Verification timestamp: ${direct.verificationTimestamp}`,
        ),
      }).toEqual({ repoLabel: repo, repoPath: repo, ...direct });
      expect(paths.map((file) => readFileSync(file))).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([
    { surface: 'super', persist: undefined },
    { surface: 'super', persist: true },
    { surface: 'facade', persist: undefined },
    { surface: 'facade', persist: true },
  ] as const)(
    'rejects $surface dispatch with persist=$persist before bundling without changing store bytes',
    async ({ surface, persist }) => {
      const repo = initRepo();
      const session = 'session-unbundled-prompt';
      try {
        await seedManagerSession(repo, session, ['finding-a']);
        const store = new LocalAuditEventStore(repo);
        const paths = [store.eventStorePath, store.projectionPath];
        const before = paths.map((file) => readFileSync(file));
        const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
        const args = { repo, session, ...(persist === undefined ? {} : { persist }) };
        const dispatch =
          surface === 'super'
            ? dispatchSuper('gn_dispatch_prompt', args, repo)
            : dispatchFacade('audit', 'dispatch_prompt', args, backend);

        await expect(dispatch).rejects.toThrow(
          /bundle must be persisted before dispatch:.*run audit bundle first or set persist:false/,
        );
        expect(paths.map((file) => readFileSync(file))).toEqual(before);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it('persists plain facade dispatch metadata with the default sensitive redaction', async () => {
    const repo = initRepo();
    const session = 'session-facade-prompt-write';
    try {
      await seedManagerSession(repo, session, ['finding-a']);
      const bundled = (await dispatchSuper('gn_audit_bundle', { repo, session }, repo)) as Record<
        string,
        any
      >;
      expect(bundled.bundles).toHaveLength(1);
      expect(bundled.bundles[0].findingIds).toEqual(['finding-a']);
      const store = new LocalAuditEventStore(repo);
      const before = (await store.load()).events;
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const facade = (await dispatchFacade(
        'audit',
        'dispatch_prompt',
        { repo, session },
        backend,
      )) as Record<string, any>;

      expect(facade.redactionMode).toBe('sensitive');
      expect(facade.bundleId).toBe(bundled.bundles[0].id);
      expect(facade.prompt).toContain('- Finding ids: finding-a');
      expect(facade.prompt).toContain('[REDACTED_PATH_');
      expect(facade.prompt).not.toContain('src/app.ts');
      expect(facade.limits.truncated).toBe(false);
      const after = (await store.load()).events;
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toEqual([
        expect.objectContaining({
          type: 'BundleDispatched',
          sessionId: session,
          bundleId: facade.bundleId,
          occurredAt: facade.verificationTimestamp,
          dispatchedAt: facade.verificationTimestamp,
          metadata: { redactionMode: 'sensitive', promptLength: facade.prompt.length },
        }),
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('forwards plain facade path redaction and prompt limits to the real generator', async () => {
    const repo = initRepo();
    const session = 'session-facade-prompt-options';
    try {
      await seedManagerSession(repo, session, ['finding-a']);
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      const before = paths.map((file) => readFileSync(file));
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const args = { repo, session, persist: false };
      const plain = (await dispatchFacade(
        'audit',
        'dispatch_prompt',
        { ...args, redactionMode: 'none' },
        backend,
      )) as Record<string, any>;
      const redacted = (await dispatchFacade(
        'audit',
        'dispatch_prompt',
        { ...args, redactionMode: 'paths' },
        backend,
      )) as Record<string, any>;

      expect(plain.redactionMode).toBe('none');
      expect(plain.prompt).toContain('- src/app.ts');
      expect(plain.prompt).toContain('- test/app.test.ts');
      expect(redacted.redactionMode).toBe('paths');
      expect(redacted.prompt).toContain('[REDACTED_PATH_');
      expect(redacted.prompt).not.toContain('src/app.ts');
      expect(redacted.prompt).not.toContain('test/app.test.ts');
      const bounded = (await dispatchFacade(
        'audit',
        'dispatch_prompt',
        { ...args, redactionMode: 'paths', maxPromptChars: 80 },
        backend,
      )) as Record<string, any>;

      expect(bounded.prompt).toBe(redacted.prompt.slice(0, 80));
      expect(bounded.limits).toEqual({
        maxPromptChars: 80,
        promptChars: redacted.prompt.length,
        truncated: true,
      });
      expect(paths.map((file) => readFileSync(file))).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each(['legacy', 'facade'] as const)(
    'bundles and dispatches a cold verified session over the SDK via %s, then refuses HEAD drift',
    async (route) => {
      const repo = initRepo();
      const home = mkdtempSync(path.join(tmpdir(), 'gn-audit-sdk-home-'));
      const backend = new LocalBackend();
      const server = createMCPServer(backend);
      const client = new Client({ name: 'audit-lifecycle-sdk', version: '1' });
      const sessionId = 'session-sdk';
      try {
        vi.stubEnv('ONTOINDEX_HOME', home);
        writeFileSync(path.join(home, 'registry.json'), '[]\n');
        const meta = {
          repoPath: repo,
          lastCommit: head(repo),
          indexedAt: '2026-05-17T00:00:00.000Z',
          capabilities: { symbols: false, impact: 'degraded' as const, processes: false },
        };
        // Lifecycle operations need repository identity, without an initialized graph.
        await saveMeta(path.join(repo, '.ontoindex'), meta);
        await registerRepo(repo, meta, { name: 'audit-lifecycle-sdk' });
        await seedManagerSession(repo, sessionId, ['finding-sdk']);
        await backend.init();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);

        const call = async (
          operation: 'lock' | 'bundle' | 'dispatch',
          args: Record<string, unknown> = {},
        ) => {
          const action = `session_${operation}`;
          const response = await client.callTool({
            name: route === 'legacy' ? `gn_audit_${action}` : 'audit',
            arguments: {
              repo,
              session: sessionId,
              response_budget_bytes: 30000,
              ...args,
              ...(route === 'facade'
                ? { action, ...(operation === 'lock' ? { lock_action: 'create' } : {}) }
                : operation === 'lock'
                  ? { action: 'create' }
                  : {}),
            },
          });
          const text = (response.content as Array<{ type: string; text?: string }>)
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('\n');
          return { response, report: JSON.parse(text) as Record<string, any> };
        };

        const lock = await call('lock');
        expect(lock.response.isError).not.toBe(true);
        expect(lock.report.lock.sessionId).toBe(sessionId);
        const lockPath = getAuditSessionLockPath(repo, sessionId);
        expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(lock.report.lock);
        const bundled = await call('bundle', { strategy: 'root-cause' });
        expect(bundled.response.isError).not.toBe(true);
        expect(bundled.report.ok).toBe(true);
        expect(bundled.report.bundle.bundles).toHaveLength(1);
        const bundleId = bundled.report.bundle.bundles[0].id;
        expect(bundled.report.bundle.bundles[0]).toMatchObject({
          id: expect.any(String),
          sessionId,
          findingIds: ['finding-sdk'],
        });
        const store = new LocalAuditEventStore(repo);
        expect(JSON.parse(readFileSync(store.projectionPath, 'utf8')).bundles).toEqual([
          expect.objectContaining({
            id: bundleId,
            sessionId,
            findingIds: ['finding-sdk'],
            status: 'CREATED',
          }),
        ]);
        const dispatched = await call('dispatch', { bundleId });
        expect(dispatched.response.isError).not.toBe(true);
        expect(dispatched.report.ok).toBe(true);
        expect(dispatched.report).toMatchObject({
          sessionId,
          bundleId,
          dispatch: { sessionId, bundleId },
        });
        expect(dispatched.report.dispatch.prompt.length).toBeGreaterThan(0);
        expect(dispatched.report.dispatch.prompt).toContain('finding-sdk');
        const timestamp = dispatched.report.dispatch.verificationTimestamp;
        expect(timestamp).toEqual(
          expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        );
        expect(new Date(timestamp).toISOString()).toBe(timestamp);
        const dispatchEvents = (await store.load()).events.filter(
          (event) => event.type === 'BundleDispatched',
        );
        expect(dispatchEvents).toEqual([
          expect.objectContaining({
            sessionId,
            bundleId,
            occurredAt: timestamp,
            dispatchedAt: timestamp,
          }),
        ]);
        expect(JSON.parse(readFileSync(store.projectionPath, 'utf8')).bundles).toEqual([
          expect.objectContaining({
            id: bundleId,
            sessionId,
            findingIds: ['finding-sdk'],
            status: 'DISPATCHED',
            dispatchedAt: timestamp,
          }),
        ]);
        const paths = [store.eventStorePath, store.projectionPath, lockPath];
        const beforeDrift = paths.map((file) => readFileSync(file));

        writeFileSync(path.join(repo, 'src/app.ts'), 'export function run() { return 2; }\n');
        execFileSync('git', ['add', 'src/app.ts'], { cwd: repo });
        execFileSync('git', ['commit', '-m', 'drift'], { cwd: repo, stdio: 'pipe' });
        for (const operation of ['bundle', 'dispatch'] as const) {
          const stale = await call(operation, { bundleId });
          expect(stale.response.isError).toBe(true);
          expect(stale.report).toMatchObject({ ok: false, code: 'STALE_SESSION' });
          expect(stale.report.prompt).toBeUndefined();
          expect(stale.report.dispatch).toBeUndefined();
          expect(paths.map((file) => readFileSync(file))).toEqual(beforeDrift);
        }
        expect(
          (await store.load()).events.filter((event) => event.type === 'BundleDispatched'),
        ).toEqual(dispatchEvents);
      } finally {
        try {
          await client.close();
        } finally {
          try {
            await server.close();
          } finally {
            try {
              await backend.disconnect();
            } finally {
              vi.unstubAllEnvs();
              rmSync(home, { recursive: true, force: true });
              rmSync(repo, { recursive: true, force: true });
            }
          }
        }
      }
    },
  );

  it('registers audit lifecycle super-functions in definitions and dispatch', () => {
    const names = new Set(ONTOINDEX_SUPER_TOOLS.map((tool) => tool.name));

    for (const name of [
      'gn_audit_ingest',
      'gn_audit_verify',
      'gn_fix_history',
      'gn_audit_bundle',
      'gn_audit_lint',
      'gn_audit_dedupe',
      'gn_dispatch_prompt',
      'gn_audit_tombstone_create',
      'gn_audit_session_start',
      'gn_audit_session_verify',
      'gn_audit_session_dedupe',
      'gn_audit_session_bundle',
      'gn_audit_session_dispatch',
      'gn_audit_session_review_worker',
      'gn_audit_session_lock',
      'gn_audit_pr_marker_scan',
      'gn_audit_diff',
      'gn_audit_replay',
      'gn_audit_export',
      'gn_scope_guard',
      'gn_bundle_conflicts',
    ]) {
      expect(names.has(name)).toBe(true);
      expect(SUPER_NAMES.has(name as never)).toBe(true);
    }
  });

  it('dispatches ingest and lint through bounded JSON-friendly reports', async () => {
    const repo = initRepo();
    const report = path.join(repo, 'audit.md');
    writeFileSync(
      report,
      [
        '## Missing guard in run',
        'Severity: HIGH',
        'Path: src/app.ts',
        'Symbol: run',
        'Claim: run is missing a guard',
        '- evidence: src/app.ts:1',
      ].join('\n'),
    );

    const ingest = (await dispatchSuper(
      'gn_audit_ingest',
      { repo, report, target: 'HEAD', persist: false },
      repo,
    )) as Record<string, any>;

    expect(ingest.action).toBe('audit-ingest');
    expect(ingest.rawCount).toBe(1);
    expect(ingest.findings[0]).toMatchObject({ status: 'NEEDS-VERIFY' });
    expect(ingest.limits.truncated).toBe(false);

    const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
    const store = new LocalAuditEventStore(repo);
    const facade = (await dispatchFacade(
      'audit',
      'ingest',
      { repo, sourcePath: report, targetRef: 'HEAD', persist: false },
      backend,
    )) as Record<string, any>;
    expect(facade.freshnessMetadata.checkedAt).toEqual(expect.any(String));
    expect({
      ...facade,
      freshnessMetadata: {
        ...facade.freshnessMetadata,
        checkedAt: ingest.freshnessMetadata.checkedAt,
        targetHead: {
          ...facade.freshnessMetadata.targetHead,
          lockedAt: ingest.freshnessMetadata.targetHead.lockedAt,
        },
      },
    }).toEqual({ repoLabel: repo, repoPath: repo, ...ingest });
    expect([store.eventStorePath, store.projectionPath].map(existsSync)).toEqual([false, false]);

    const errors = await Promise.allSettled([
      dispatchSuper('gn_audit_ingest', { repo }, repo),
      dispatchFacade('audit', 'ingest', { repo }, backend),
    ]);
    expect(errors[0].status).toBe('rejected');
    expect(errors[1].status).toBe('rejected');
    if (errors[0].status === 'rejected' && errors[1].status === 'rejected') {
      expect(errors[0].reason).toBeInstanceOf(Error);
      expect(errors[1].reason.message).toBe(errors[0].reason.message);
    }
    expect([store.eventStorePath, store.projectionPath].map(existsSync)).toEqual([false, false]);

    const persisted = (await dispatchFacade(
      'audit',
      'ingest',
      { repo, report },
      backend,
    )) as Record<string, any>;
    expect(persisted).toMatchObject({
      action: 'audit-ingest',
      targetRef: 'HEAD',
      rawCount: 1,
      findings: [expect.objectContaining({ status: 'NEEDS-VERIFY' })],
    });
    const events = (await store.load()).events;
    expect(events.map((event) => event.type)).toEqual(['AuditIngested', 'FindingCandidateCreated']);
    expect(events[0]).toMatchObject({
      sessionId: persisted.sessionId,
      session: { id: persisted.sessionId, sourceHash: persisted.sourceHash },
    });
    expect(events[1]).toMatchObject({
      sessionId: persisted.sessionId,
      findingId: persisted.findings[0].findingId,
      finding: { id: persisted.findings[0].findingId, status: 'NEEDS-VERIFY' },
    });
    const projection = JSON.parse(readFileSync(store.projectionPath, 'utf8'));
    expect(projection.sessions).toHaveLength(1);
    expect(projection.findings).toEqual([
      expect.objectContaining({ id: persisted.findings[0].findingId, status: 'NEEDS-VERIFY' }),
    ]);

    const lint = (await dispatchSuper(
      'gn_audit_lint',
      { repo, findings: ingest.findings, persist: false },
      repo,
    )) as Record<string, any>;

    expect(lint.action).toBe('audit-lint');
    expect(lint.ok).toBe(true);
    expect(lint.summary.findings).toBe(1);
  });

  it('matches real verify facade reports and envelopes without writes, then persists verification by default', async () => {
    const repo = initRepo();
    try {
      const ingest = (await dispatchSuper(
        'gn_audit_ingest',
        {
          repo,
          sourceText: [
            '## Missing guard in run',
            'Severity: HIGH',
            'Path: src/app.ts',
            'Symbol: run',
            'Claim: run is missing a guard',
            '- evidence: src/app.ts:1',
          ].join('\n'),
        },
        repo,
      )) as Record<string, any>;
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      const before = paths.map((file) => readFileSync(file));
      const beforeEvents = (await store.load()).events;
      const candidate = beforeEvents.find((event) => event.type === 'FindingCandidateCreated');
      expect(candidate?.type).toBe('FindingCandidateCreated');
      if (candidate?.type !== 'FindingCandidateCreated')
        throw new Error('ingest did not create a finding candidate');
      const inlineFinding = candidate.finding.metadata.auditLifecycleFinding;
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const args = {
        repo,
        session: ingest.sessionId,
        findingId: ingest.findings[0].findingId,
        persist: false,
      };
      const normalizeVerifiedAt = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(normalizeVerifiedAt);
        if (value === null || typeof value !== 'object') return value;
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => {
            if (key === 'verifiedAt') {
              expect(entry).toEqual(
                expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
              );
              return [key, '<verifiedAt>'];
            }
            return [key, normalizeVerifiedAt(entry)];
          }),
        );
      };

      for (const options of [
        {},
        { legacyResponse: false },
        { sessionId: ingest.sessionId, maxFindings: 1, maxEvidence: 1 },
        { finding: inlineFinding },
      ]) {
        const params = { ...args, ...options };
        const direct = (await dispatchSuper('gn_audit_verify', params, repo)) as Record<
          string,
          any
        >;
        const facade = (await dispatchFacade('audit', 'verify', params, backend)) as Record<
          string,
          any
        >;
        const report = options.legacyResponse === false ? direct.results : direct;
        expect(report).toMatchObject({
          action: 'audit-verify',
          sessionId: ingest.sessionId,
          verifiedCount: 1,
        });
        expect(report.findings[0].findingId).toBe(ingest.findings[0].findingId);
        if (options.legacyResponse === false) {
          expect(direct).toMatchObject({ envelopeVersion: '1', tool: 'gn_audit_verify' });
        }
        expect(normalizeVerifiedAt(facade)).toEqual(
          normalizeVerifiedAt(
            options.legacyResponse === false
              ? direct
              : { repoLabel: repo, repoPath: repo, ...direct },
          ),
        );
        expect(paths.map((file) => readFileSync(file))).toEqual(before);
      }

      const persisted = (await dispatchFacade(
        'audit',
        'verify',
        {
          repo,
          session: ingest.sessionId,
          findingId: ingest.findings[0].findingId,
        },
        backend,
      )) as Record<string, any>;
      expect(persisted).toMatchObject({
        action: 'audit-verify',
        sessionId: ingest.sessionId,
        verifiedCount: 1,
        limits: { maxFindings: 25, maxEvidence: 25, emitted: 1, total: 1, truncated: false },
      });
      const events = (await store.load()).events;
      expect(events.slice(0, beforeEvents.length)).toEqual(beforeEvents);
      const appended = events.slice(beforeEvents.length);
      expect(appended.map((event) => event.type)).toEqual([
        'FindingVerified',
        'FindingStatusChanged',
      ]);
      const finding = persisted.findings[0];
      const status = finding.status === 'DECISION-GATED' ? 'HOLD' : finding.status;
      expect(appended[0]).toMatchObject({
        sessionId: ingest.sessionId,
        findingId: finding.findingId,
        occurredAt: finding.verifiedAt,
        verification: { status },
      });
      expect(appended[1]).toMatchObject({
        sessionId: ingest.sessionId,
        findingId: finding.findingId,
        occurredAt: finding.verifiedAt,
        status,
        reason: finding.statusReason,
      });
      const projection = JSON.parse(readFileSync(store.projectionPath, 'utf8'));
      expect(projection.findings).toEqual([
        expect.objectContaining({ id: finding.findingId, status }),
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('preserves real verify errors for missing input and malformed inline findings without writes', async () => {
    const repo = initRepo();
    try {
      const backend = { resolveRepo: async () => ({ id: repo, repoPath: repo }) } as LocalBackend;
      const store = new LocalAuditEventStore(repo);
      const paths = [store.eventStorePath, store.projectionPath];
      for (const options of [
        {},
        { finding: [] },
        { finding: {} },
        { session: 'missing-session' },
      ]) {
        const params = { repo, ...options };
        const outcomes = await Promise.allSettled([
          dispatchSuper('gn_audit_verify', params, repo),
          dispatchFacade('audit', 'verify', params, backend),
        ]);
        expect(outcomes[0].status).toBe('rejected');
        expect(outcomes[1].status).toBe('rejected');
        if (outcomes[0].status === 'rejected' && outcomes[1].status === 'rejected') {
          expect(outcomes[0].reason).toBeInstanceOf(Error);
          expect(outcomes[1].reason).toBeInstanceOf(Error);
          expect(outcomes[1].reason.message).toBe(outcomes[0].reason.message);
        }
        expect(paths.map(existsSync)).toEqual([false, false]);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('dispatches session lock and PR marker scan lifecycle controls', async () => {
    const repo = initRepo();
    const report = path.join(repo, 'audit.md');
    writeFileSync(
      report,
      [
        '## Deferred guard in run',
        'Severity: HIGH',
        'Path: src/app.ts',
        'Symbol: run',
        'Claim: run is missing a guard',
        '- evidence: src/app.ts:2',
      ].join('\n'),
    );

    const ingest = (await dispatchSuper(
      'gn_audit_ingest',
      { repo, report, target: 'HEAD' },
      repo,
    )) as Record<string, any>;

    const lock = (await dispatchSuper(
      'gn_audit_session_lock',
      { repo, session: ingest.sessionId, action: 'create' },
      repo,
    )) as Record<string, any>;
    expect(lock.operation).toBe('create');
    expect(lock.lock.sessionId).toBe(ingest.sessionId);

    const validate = (await dispatchSuper(
      'gn_audit_session_lock',
      { repo, session: ingest.sessionId, action: 'validate' },
      repo,
    )) as Record<string, any>;
    expect(validate.status).toBe('VALID_SESSION');

    const markers = (await dispatchSuper(
      'gn_audit_pr_marker_scan',
      {
        repo,
        sourceText: 'export function run() {\\n  // TODO: PR-3 follow-up\\n  return 1;\\n}\\n',
        path: 'src/app.ts',
        evidenceLine: 3,
      },
      repo,
    )) as Record<string, any>;
    expect(markers.markers.map((marker: any) => marker.markerKind)).toEqual(
      expect.arrayContaining(['TODO', 'PR_REFERENCE']),
    );

    const exported = (await dispatchSuper(
      'gn_audit_export',
      { repo, session: ingest.sessionId, format: 'both' },
      repo,
    )) as Record<string, any>;
    expect(exported.json.session.id).toBe(ingest.sessionId);
    expect(exported.markdown).toContain('## Audit Result');
  });

  it('starts a manager session and refuses stale verify when HEAD drifts', async () => {
    const repo = initRepo();
    const report = path.join(repo, 'audit.md');
    writeFileSync(
      report,
      [
        '## Missing guard in run',
        'Severity: HIGH',
        'Path: src/app.ts',
        'Symbol: run',
        'Claim: run is missing a guard',
        '- evidence: src/app.ts:1',
      ].join('\n'),
    );

    const started = (await dispatchSuper(
      'gn_audit_session_start',
      { repo, sourcePath: report, targetRef: 'HEAD' },
      repo,
    )) as Record<string, any>;

    expect(started.action).toBe('audit-session-start');
    expect(started.ok).toBe(true);
    expect(started.lock.sessionId).toBe(started.sessionId);

    writeFileSync(path.join(repo, 'src/app.ts'), 'export function run() { return 2; }\n');
    execFileSync('git', ['add', 'src/app.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'drift'], { cwd: repo, stdio: 'ignore' });

    const verify = (await dispatchSuper(
      'gn_audit_session_verify',
      { repo, session: started.sessionId },
      repo,
    )) as Record<string, any>;

    expect(verify.ok).toBe(false);
    expect(verify.code).toBe('STALE_SESSION');
  });

  it('starts a non-persistent session without creating a store-backed lock', async () => {
    const repo = initRepo();
    const report = path.join(repo, 'audit.md');
    writeFileSync(
      report,
      [
        '## Missing guard in run',
        'Severity: HIGH',
        'Path: src/app.ts',
        'Symbol: run',
        'Claim: run is missing a guard',
        '- evidence: src/app.ts:1',
      ].join('\n'),
    );

    const started = (await dispatchSuper(
      'gn_audit_session_start',
      { repo, sourcePath: report, targetRef: 'HEAD', persist: false },
      repo,
    )) as Record<string, any>;

    expect(started.action).toBe('audit-session-start');
    expect(started.ok).toBe(true);
    expect(started.persisted).toBe(false);
    expect(started.lock).toBeNull();
  });

  it('runs dedupe before manager bundling and blocks manager dispatch for NEEDS-REVERIFY findings', async () => {
    const repo = initRepo();
    const sessionId = 'session-manager';
    await seedManagerSession(repo, sessionId, ['finding-a', 'finding-b']);

    const lock = (await dispatchSuper(
      'gn_audit_session_lock',
      { repo, session: sessionId, action: 'create' },
      repo,
    )) as Record<string, any>;
    expect(lock.lock.sessionId).toBe(sessionId);

    const bundle = (await dispatchSuper(
      'gn_audit_session_bundle',
      { repo, session: sessionId, strategy: 'root-cause' },
      repo,
    )) as Record<string, any>;

    expect(bundle.ok).toBe(true);
    expect(bundle.dedupe.action).toBe('audit-dedupe');
    expect(bundle.bundle.action).toBe('audit-bundle');
    expect(bundle.bundle.bundles).toHaveLength(1);

    const store = new LocalAuditEventStore(repo);
    await store.appendEvent({
      id: 'evt-reverify',
      type: 'FindingStatusChanged',
      occurredAt: '2026-05-17T00:00:05.000Z',
      sessionId,
      findingId: 'finding-a',
      status: 'NEEDS-REVERIFY',
      reason: 'stale OPEN refused by manager',
    });

    const dispatch = (await dispatchSuper(
      'gn_audit_session_dispatch',
      { repo, session: sessionId, bundleId: bundle.bundle.bundles[0].id },
      repo,
    )) as Record<string, any>;

    expect(dispatch.ok).toBe(false);
    expect(dispatch.code).toBe('DISPATCH_BLOCKED');
    expect(dispatch.blockedFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ findingId: 'finding-a', currentStatus: 'NEEDS-REVERIFY' }),
      ]),
    );
  });

  it('returns integrity metadata while preserving readable BROKEN-chain reports', async () => {
    const repo = initRepo();
    const sessionId = 'session-integrity';
    const store = new LocalAuditEventStore(repo);
    await store.createSession(
      {
        id: sessionId,
        targetRepo: path.basename(repo),
        targetHead: head(repo),
        sourceHash: 'sha256:integrity',
        graphIndexId: 'graph-1',
        verifierVersion: 'verifier-1',
        sidecarStateHash: 'graph-hash-1',
        createdAt: '2026-05-17T00:00:00.000Z',
      },
      { id: 'evt-session-integrity' },
    );
    const state = JSON.parse(readFileSync(store.eventStorePath, 'utf8')) as Record<string, unknown>;
    const events = state.events as Array<Record<string, unknown>>;
    events[0].checksum = 'tampered';
    writeFileSync(store.eventStorePath, JSON.stringify({ ...state, events }));

    for (const [name, params] of [
      ['gn_audit_replay', { repo, session: sessionId }],
      ['gn_audit_export', { repo, session: sessionId, format: 'both' }],
    ] as const) {
      const report = (await dispatchSuper(name, params, repo)) as Record<string, any>;
      expect(report.integrity).toMatchObject({ status: 'BROKEN', firstBrokenSequence: 0 });
      expect(report.ok).not.toBe(false);
      if (name === 'gn_audit_export') {
        expect(report.markdown).toContain('Integrity:');
        expect(report.markdown).toContain('- Status: BROKEN');
        expect(report.markdown).toContain('- First broken sequence: 0');
        expect(report.markdown).toContain('- Reason: checksum-mismatch');
      }
    }
  });

  it('runs scope guard and required test checks during manager review', async () => {
    const repo = initRepo();
    const sessionId = 'session-review';
    await seedManagerSession(repo, sessionId, ['finding-a']);
    await dispatchSuper(
      'gn_audit_session_lock',
      { repo, session: sessionId, action: 'create' },
      repo,
    );
    const bundle = (await dispatchSuper(
      'gn_audit_session_bundle',
      { repo, session: sessionId, strategy: 'root-cause' },
      repo,
    )) as Record<string, any>;

    const review = (await dispatchSuper(
      'gn_audit_session_review_worker',
      {
        repo,
        session: sessionId,
        bundleId: bundle.bundle.bundles[0].id,
        changedFiles: ['src/unexpected.ts'],
        changedSymbols: ['run'],
        executedTests: [],
      },
      repo,
    )) as Record<string, any>;

    expect(review.ok).toBe(false);
    expect(review.review.status).toBe('FAIL');
    expect(review.review.issues.map((issue: any) => issue.kind).sort()).toEqual([
      'missing-required-test',
      'unexpected-file',
    ]);
  });
});

function initRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'gn-audit-mcp-'));
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  writeFileSync(path.join(repo, 'src-app-placeholder'), '');
  execFileSync('mkdir', ['-p', 'src'], { cwd: repo });
  writeFileSync(path.join(repo, 'src/app.ts'), 'export function run() { return 1; }\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
  mkdirSync(path.join(repo, '.ontoindex'));
  writeFileSync(
    path.join(repo, '.ontoindex/meta.json'),
    JSON.stringify({
      repoPath: repo,
      lastCommit: head(repo),
      indexedAt: '2026-05-17T00:00:00.000Z',
    }),
  );
  return repo;
}

async function seedManagerSession(
  repo: string,
  sessionId: string,
  findingIds: string[],
  distinctFingerprints = false,
): Promise<void> {
  const store = new LocalAuditEventStore(repo);
  const targetHead = head(repo);
  await store.createSession(
    {
      id: sessionId,
      targetRepo: path.basename(repo),
      targetHead,
      sourceHash: `sha256:${sessionId}`,
      graphIndexId: 'graph-1',
      verifierVersion: 'verifier-1',
      sidecarStateHash: 'graph-hash-1',
      createdAt: '2026-05-17T00:00:00.000Z',
    },
    { id: `evt-session-${sessionId}` },
  );

  for (const findingId of findingIds) {
    await store.createFindingCandidate(
      {
        id: findingId,
        sessionId,
        title: `Finding ${findingId}`,
        fingerprint: distinctFingerprints ? `root-cause:${findingId}` : 'root-cause:run-guard',
        status: 'NEEDS-VERIFY',
        metadata: {
          files: ['src/app.ts'],
          symbols: ['run'],
          tests: ['test/app.test.ts'],
          writeSet: ['src/app.ts'],
          estimatedLoc: 3,
          rootCauseId: 'rc-run-guard',
        },
      },
      {
        id: `evt-candidate-${findingId}`,
        occurredAt: '2026-05-17T00:00:01.000Z',
      },
    );
    await store.appendEvent({
      id: `evt-verify-${findingId}`,
      type: 'FindingVerified',
      occurredAt: '2026-05-17T00:00:02.000Z',
      sessionId,
      findingId,
      verification: {
        verifiedAt: '2026-05-17T00:00:02.000Z',
        status: 'OPEN',
        evidence: [
          {
            id: `evidence-${findingId}`,
            kind: 'static',
            targetHead,
            graphIndexId: 'graph-1',
            verifierVersion: 'verifier-1',
            sidecarStateHash: 'graph-hash-1',
            reasonCodes: ['fresh-positive-evidence'],
            data: { path: 'src/app.ts', symbol: 'run', line: 1 },
          },
        ],
        reasonCodes: ['fresh-positive-evidence'],
        verifierVersion: 'verifier-1',
      },
    });
    await store.appendEvent({
      id: `evt-status-${findingId}`,
      type: 'FindingStatusChanged',
      occurredAt: '2026-05-17T00:00:03.000Z',
      sessionId,
      findingId,
      status: 'OPEN',
      reason: 'fresh positive evidence',
    });
  }
}

async function seedResolvedSession(
  repo: string,
  sessionId: string,
  changes: Partial<AuditEvidence> = {},
  noProof = false,
  status: AuditFindingStatus = 'RESOLVED-ALREADY',
): Promise<AuditEvidence> {
  await seedManagerSession(repo, sessionId, ['finding-a']);
  const store = new LocalAuditEventStore(repo);
  const proof: AuditEvidence = {
    id: 'fixed-guard-proof',
    kind: 'source-snapshot',
    targetHead: head(repo),
    graphIndexId: 'graph-1',
    verifierVersion: 'resolution-verifier',
    sidecarStateHash: 'resolution-sidecar',
    sourceFresh: true,
    graphStale: false,
    confidence: 0.73,
    reasonCodes: ['guard-present'],
    data: { polarity: 'fix-proof', path: 'src/app.ts', line: 1 },
    ...changes,
  };
  await store.appendEvent({
    id: 'evt-resolution-verification',
    type: 'FindingVerified',
    occurredAt: '2026-05-17T00:00:04.000Z',
    sessionId,
    findingId: 'finding-a',
    verification: {
      verifiedAt: '2026-05-17T00:00:04.000Z',
      status: 'RESOLVED-ALREADY',
      evidence: noProof ? [] : [proof],
      reasonCodes: ['guard-present'],
      verifierVersion: 'resolution-verifier',
    },
  });
  await store.appendEvent({
    id: 'evt-resolution-status',
    type: 'FindingStatusChanged',
    occurredAt: '2026-05-17T00:00:05.000Z',
    sessionId,
    findingId: 'finding-a',
    status,
    reason: 'guard present',
  });
  return proof;
}

function head(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}
