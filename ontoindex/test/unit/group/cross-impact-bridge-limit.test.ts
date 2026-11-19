import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GroupConfig } from '../../../src/core/group/types.js';
import type { GroupToolPort } from '../../../src/core/group/service.js';

describe('cross-impact bridge fan-out bounds', () => {
  const rejections: Record<string, unknown> = {
    rejected: new Error('member rejected'),
    'rejected-empty-error': new Error(),
    'rejected-undefined': undefined,
    'rejected-empty-string': '',
  };
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('../../../src/core/lbug/pool-adapter.js');
    vi.doUnmock('../../../src/mcp/local/backend-overlay.js');
    vi.doUnmock('../../../src/core/group/storage.js');
    vi.doUnmock('../../../src/core/group/config-parser.js');
    vi.doUnmock('../../../src/core/group/bridge-db.js');
  });

  it('retains real backend traversal evidence while deadline waits for enrichment settlement', async () => {
    vi.resetModules();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-cross-backend-'));
    const groupDir = path.join(tmpDir, 'groups', 'g1');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'bridge.lbug'), '');
    const localUid = 'Function:src/local.ts:local';
    const depUid = 'Function:src/dep.ts:dep';
    const callerUid = 'Function:src/caller.ts:caller';
    const config = {
      version: 1,
      name: 'g1',
      repos: { 'app/backend': 'reg-be', 'app/dep': 'reg-dep' },
      links: [],
      packages: {},
      detect: {},
      matching: {},
    };
    const closeBridgeDb = vi.fn(async () => {});
    const queryBridge = vi.fn(async () =>
      [depUid, 'second-neighbor'].map((neighborUid) => ({
        neighborRepo: 'app/dep',
        neighborUid,
        neighborFilePath: 'src/dep.ts',
        matchType: 'exact',
        confidence: 0.9,
        contractId: neighborUid,
        contractType: 'http',
      })),
    );
    let release!: () => void;
    const enrichment = new Promise<unknown[]>((resolve) => {
      release = () => resolve([]);
    });
    let started!: () => void;
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executeParameterized = vi.fn(
      async (repoId: string, query: string, params?: Record<string, unknown>) => {
        if (params?.uid || params?.symName)
          return [
            {
              id: params.uid ?? params.symName,
              name: 'target',
              type: 'Function',
              filePath: 'src/target.ts',
            },
          ];
        if (params?.frontierIds) {
          if (repoId === 'reg-be') return [];
          return [
            {
              id: callerUid,
              name: 'caller',
              type: 'Function',
              filePath: 'src/caller.ts',
              relType: 'CALLS',
              confidence: 0.95,
            },
          ];
        }
        if (repoId === 'reg-dep' && query.includes('STEP_IN_PROCESS')) {
          started();
          return enrichment;
        }
        return [];
      },
    );
    vi.doMock('../../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../src/core/lbug/pool-adapter.js')>()),
      executeParameterized,
    }));
    vi.doMock('../../../src/mcp/local/backend-overlay.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../src/mcp/local/backend-overlay.js')>()),
      isAutomaticWorkspaceEnabled: () => false,
      getOverlaySnapshot: async () => {
        throw new Error('no workspace snapshot in fixture');
      },
    }));
    vi.doMock('../../../src/core/group/storage.js', () => ({
      getGroupDir: () => groupDir,
      getDefaultOntoIndexDir: () => tmpDir,
    }));
    vi.doMock('../../../src/core/group/config-parser.js', () => ({
      loadGroupConfig: async () => config,
    }));
    vi.doMock('../../../src/core/group/bridge-db.js', () => ({
      readBridgeMeta: async () => ({ version: 0, generatedAt: '', missingRepos: [] }),
      openBridgeDbReadOnly: async () => ({ _db: {}, _conn: {}, groupDir }),
      closeBridgeDb,
      queryBridge,
    }));
    try {
      const { LocalBackend } = await import('../../../src/mcp/local/local-backend.js');
      const backend = new LocalBackend();
      const internals = backend as unknown as {
        repos: Map<
          string,
          { id: string; name: string; repoPath: string; storagePath: string; lbugPath: string }
        >;
        operations: Set<Promise<unknown>>;
        ensureInitialized(repoId: string): Promise<void>;
        readLocalEnrichmentMetadata(): Promise<unknown>;
      };
      for (const id of ['reg-be', 'reg-dep'])
        internals.repos.set(id, {
          id,
          name: id,
          repoPath: `/repos/${id}`,
          storagePath: `/repos/${id}/.ontoindex`,
          lbugPath: `/repos/${id}/.ontoindex/lbug`,
        });
      vi.spyOn(backend, 'init').mockResolvedValue(true);
      vi.spyOn(internals, 'ensureInitialized').mockResolvedValue(undefined);
      vi.spyOn(internals, 'readLocalEnrichmentMetadata').mockResolvedValue({
        status: 'unavailable',
      });
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const pending = backend.getGroupService().groupImpact({
        name: 'g1',
        repo: 'app/backend',
        target: localUid,
        direction: 'upstream',
        maxDepth: 1,
        timeoutMs: 100,
      });
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await admitted;
      const callsBeforeDeadline = executeParameterized.mock.calls.length;
      expect(internals.operations.size).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      expect(closeBridgeDb).not.toHaveBeenCalled();
      expect(internals.operations.size).toBe(1);
      release();
      const result = (await pending) as {
        risk: string;
        truncationReason: string;
        cross: Array<Record<string, unknown>>;
      };
      expect(result).toMatchObject({ risk: 'UNKNOWN', truncationReason: 'timeout' });
      expect(result.cross).toHaveLength(1);
      expect(result.cross[0]).toMatchObject({
        by_depth: { 1: [{ id: callerUid }] },
        risk: 'UNKNOWN',
        partial: true,
        traversalComplete: false,
        truncated: true,
      });
      expect(executeParameterized).toHaveBeenCalledTimes(callsBeforeDeadline);
      expect(
        executeParameterized.mock.calls.some(([, , params]) => params?.uid === 'second-neighbor'),
      ).toBe(false);
      expect(closeBridgeDb).toHaveBeenCalledTimes(1);
      expect(internals.operations.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    { withMetadata: false, state: 'complete', cap: 2 },
    { withMetadata: true, state: 'complete', cap: 2 },
    { withMetadata: true, state: 'complete', cap: 3 },
    ...[
      'partial',
      'truncated',
      'budget-only',
      'traversal-incomplete',
      'unknown',
      'error',
      'empty-error',
      'null',
      ...Object.keys(rejections),
      'local-unknown',
      'deadline-resolution',
      'deadline-equality',
      'deadline-active',
      'deadline-preparation',
      'deadline-query-empty',
      'deadline-query-filtered',
      'bridge-failure',
    ].map((state) => ({ withMetadata: true, state, cap: 3 })),
  ])(
    'preserves fan metadata and nodes for $state (metadata: $withMetadata)',
    async ({ withMetadata, state, cap }) => {
      const rejected = state in rejections;
      const rejection = rejections[state];
      const rejectionMessage = rejection instanceof Error ? rejection.message : String(rejection);
      vi.resetModules();
      vi.stubEnv('ONTOINDEX_GROUP_CROSS_MAX_BRIDGE_NEIGHBORS', String(cap));

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-cross-limit-'));
      const groupDir = path.join(tmpDir, 'groups', 'g1');
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(path.join(groupDir, 'bridge.lbug'), '');

      const config: GroupConfig = {
        version: 1,
        name: 'g1',
        description: '',
        repos: {
          'app/backend': 'reg-be',
          'app/dep': 'reg-dep',
        },
        links: [],
        packages: {},
        detect: {
          http: true,
          grpc: true,
          topics: true,
          shared_libs: true,
          embedding_fallback: true,
        },
        matching: {
          bm25_threshold: 0.7,
          embedding_threshold: 0.65,
          max_candidates_per_step: 3,
        },
      };

      const queryBridge = vi.fn(async (_path: string, _query: string) => {
        if (state === 'bridge-failure') throw new Error('bridge query failed');
        if (state.startsWith('deadline-query-')) vi.setSystemTime(100);
        if (state === 'deadline-query-empty') return [];
        return [
          {
            neighborRepo: 'app/dep',
            neighborUid: 'dep-1',
            neighborFilePath: 'src/a.ts',
            matchType: 'exact',
            confidence: 0.9,
            contractId: 'http::GET::/a',
            contractType: 'http',
          },
          {
            neighborRepo: 'app/dep',
            neighborUid: 'dep-2',
            neighborFilePath: 'src/b.ts',
            matchType: 'exact',
            confidence: 0.8,
            contractId: 'http::GET::/b',
            contractType: 'http',
          },
        ];
      });
      const closeBridgeDb = vi.fn(async () => {});

      vi.doMock('../../../src/core/group/storage.js', () => ({
        getGroupDir: () => groupDir,
      }));
      vi.doMock('../../../src/core/group/config-parser.js', () => ({
        loadGroupConfig: vi.fn(async () => config),
      }));
      vi.doMock('../../../src/core/group/bridge-db.js', () => ({
        readBridgeMeta: vi.fn(async () => ({ version: 0, generatedAt: '', missingRepos: [] })),
        openBridgeDbReadOnly: vi.fn(async () => {
          if (state === 'deadline-preparation') vi.setSystemTime(100);
          return { _db: {}, _conn: {}, groupDir };
        }),
        closeBridgeDb,
        queryBridge,
      }));

      try {
        const { runGroupImpact, MAX_CROSS_BRIDGE_NEIGHBORS } =
          await import('../../../src/core/group/cross-impact.js');
        expect(MAX_CROSS_BRIDGE_NEIGHBORS).toBe(cap);

        const metadata = [
          {
            targetContext: { target: 'dep-1', source: 'overlay' },
            source: 'workspace-graph',
            graphImpactAvailable: true,
            freshness: { state: 'dirty' },
            repoLabel: 'dep-a',
            repoPath: '/repos/dep-a',
            capabilitiesUsed: ['impact'],
            capabilitiesMissing: [],
          },
          {
            targetContext: { target: 'dep-2', source: 'committed' },
            source: 'workspace-graph',
            graphImpactAvailable: false,
            freshness: { state: 'fresh' },
            repoLabel: 'dep-b',
            repoPath: '/repos/dep-b',
            capabilitiesUsed: [],
            capabilitiesMissing: ['processes'],
          },
        ];
        const fans = metadata.map((entry, index) => ({
          byDepth: { '1': [{ id: `dependent-${index}` }] },
          affected_processes: [{ name: `process-${index}` }],
          ...(withMetadata ? entry : {}),
          unrelatedPayload: { secret: 'must not be copied' },
          ...(index === 1 && state === 'partial'
            ? {
                risk: 'CRITICAL',
                partial: true,
                warnings: ['node cap'],
                budget: { truncated: true, truncatedReasons: ['node-cap'] },
              }
            : {}),
          ...(index === 1 && state === 'truncated' ? { risk: 'LOW', truncated: true } : {}),
          ...(index === 1 && state === 'budget-only'
            ? { risk: 'LOW', budget: { truncated: true } }
            : {}),
          ...(index === 1 && state === 'traversal-incomplete'
            ? { risk: 'LOW', traversalComplete: false }
            : {}),
          ...(index === 1 && state === 'unknown'
            ? { risk: 'UNKNOWN', partial: true, warnings: ['enrichment failed'] }
            : {}),
          ...(index === 1 && state === 'error' ? { error: 'analysis failed' } : {}),
          ...(index === 1 && state === 'empty-error' ? { error: '' } : {}),
        }));
        let releaseMember!: () => void;
        const memberSettlement = new Promise<void>((resolve) => {
          releaseMember = resolve;
        });
        let memberStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          memberStarted = resolve;
        });
        let memberSignal: AbortSignal | undefined;
        const port: GroupToolPort = {
          resolveRepo: vi.fn(async (name: string) => {
            if (
              name === 'reg-dep' &&
              ['deadline-resolution', 'deadline-equality'].includes(state)
            ) {
              vi.setSystemTime(state === 'deadline-equality' ? 100 : 101);
            }
            return {
              id: name,
              name,
              repoPath: `/repos/${name}`,
              storagePath: `/repos/${name}/.ontoindex`,
            };
          }),
          impact: vi.fn(async () => ({
            target: { id: 'local-uid', filePath: 'src/local.ts' },
            summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
            byDepth: {},
            risk: state === 'local-unknown' ? 'UNKNOWN' : 'LOW',
          })),
          impactByUid: vi.fn(async (_repo, uid, _direction, options) => {
            if (state === 'deadline-active') {
              memberSignal = options.signal;
              memberStarted();
              await memberSettlement;
            }
            if (uid === 'dep-2' && state === 'null') return null;
            if (uid === 'dep-2' && rejected) throw rejection;
            return fans[uid === 'dep-1' ? 0 : 1];
          }),
          query: vi.fn(),
          context: vi.fn(),
        };

        vi.useFakeTimers();
        vi.setSystemTime(0);
        const pending = runGroupImpact(
          { port, ontoindexDir: tmpDir },
          {
            name: 'g1',
            repo: 'app/backend',
            target: 'Local',
            direction: 'upstream',
            timeoutMs: 100,
            ...(state === 'deadline-query-filtered' ? { subgroup: 'app/backend' } : {}),
          },
        );
        if (state === 'bridge-failure') {
          await expect(pending).rejects.toThrow('bridge query failed');
          expect(closeBridgeDb).toHaveBeenCalledTimes(1);
          expect(vi.getTimerCount()).toBe(0);
          return;
        }
        if (state === 'deadline-active') {
          await started;
          let settled = false;
          void pending.then(() => {
            settled = true;
          });
          await vi.advanceTimersByTimeAsync(100);
          expect(memberSignal?.aborted).toBe(true);
          expect(settled).toBe(false);
          expect(closeBridgeDb).not.toHaveBeenCalled();
          releaseMember();
        }
        const result = await pending;
        expect(vi.getTimerCount()).toBe(0);
        expect(closeBridgeDb).toHaveBeenCalledTimes(1);
        if (state.startsWith('deadline-')) {
          const bridgeExpired =
            state === 'deadline-preparation' || state.startsWith('deadline-query-');
          expect(result).toMatchObject({
            risk: 'UNKNOWN',
            truncated: true,
            truncationReason: 'timeout',
            truncatedRepos: bridgeExpired ? [] : ['app/dep'],
            budget: { truncated: true, truncatedReasons: ['timeout'] },
          });
          expect(port.impactByUid).toHaveBeenCalledTimes(state === 'deadline-active' ? 1 : 0);
          expect(queryBridge).toHaveBeenCalledTimes(state === 'deadline-preparation' ? 0 : 1);
          if (!('error' in result)) {
            expect(result.local).toMatchObject({ target: { id: 'local-uid' }, risk: 'LOW' });
            expect(result.cross).toHaveLength(state === 'deadline-active' ? 1 : 0);
            if (state === 'deadline-active')
              expect(result.cross[0]).toMatchObject({
                by_depth: fans[0].byDepth,
                ...metadata[0],
                risk: 'UNKNOWN',
                partial: true,
                truncated: true,
                traversalComplete: false,
              });
          }
          return;
        }

        expect('error' in result).toBe(false);
        if (!('error' in result)) {
          expect(result.truncated).toBe(cap === 2 || state !== 'complete');
          expect(result.truncationReason).toBe(
            cap === 2 || state !== 'complete' ? 'partial' : undefined,
          );
          expect(result.cross).toEqual(
            metadata
              .filter((_, index) => !(index === 1 && state === 'null'))
              .map((entry, index) => ({
                repo: 'reg-dep',
                repo_path: 'app/dep',
                contract: {
                  id: `http::GET::/${index === 0 ? 'a' : 'b'}`,
                  type: 'http',
                  match_type: 'exact',
                  confidence: index === 0 ? 0.9 : 0.8,
                },
                by_depth: index === 1 && rejected ? {} : fans[index].byDepth,
                affected_processes: index === 1 && rejected ? [] : [`process-${index}`],
                ...(withMetadata && !(index === 1 && rejected) ? entry : {}),
                ...(index === 1 && state === 'partial'
                  ? {
                      risk: 'CRITICAL',
                      partial: true,
                      warnings: ['node cap'],
                      budget: { truncated: true, truncatedReasons: ['node-cap'] },
                    }
                  : {}),
                ...(index === 1 && state === 'truncated' ? { risk: 'LOW', truncated: true } : {}),
                ...(index === 1 && state === 'budget-only'
                  ? { risk: 'LOW', budget: { truncated: true } }
                  : {}),
                ...(index === 1 && state === 'traversal-incomplete'
                  ? { risk: 'LOW', traversalComplete: false }
                  : {}),
                ...(index === 1 && state === 'unknown'
                  ? { risk: 'UNKNOWN', partial: true, warnings: ['enrichment failed'] }
                  : {}),
                ...(index === 1 && state === 'error' ? { error: 'analysis failed' } : {}),
                ...(index === 1 && state === 'empty-error' ? { error: '' } : {}),
                ...(index === 1 && rejected ? { error: rejectionMessage } : {}),
              })),
          );
          expect(result.summary.cross_repo_hits).toBe(state === 'null' ? 1 : 2);
          expect(result.risk).toBe(
            rejected || ['unknown', 'error', 'empty-error', 'null', 'local-unknown'].includes(state)
              ? 'UNKNOWN'
              : state === 'partial'
                ? 'CRITICAL'
                : 'HIGH',
          );
          expect(result.truncatedRepos).toEqual(
            ['complete', 'local-unknown'].includes(state) ? [] : ['app/dep'],
          );
          expect(result.budget?.truncated).toBe(cap === 2 || state !== 'complete');
          if (cap === 2) expect(result.budget?.truncatedReasons).toContain('bridge-row-cap');
          else expect(result.budget?.truncatedReasons).not.toContain('bridge-row-cap');
          if (!['complete', 'local-unknown'].includes(state)) {
            expect(result.budget?.truncatedReasons).toContain('bridge-fanout-partial');
          }
          expect(port.impactByUid).toHaveBeenCalledTimes(2);
        }
        expect(queryBridge.mock.calls[0][1]).toContain(`LIMIT ${cap}`);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
