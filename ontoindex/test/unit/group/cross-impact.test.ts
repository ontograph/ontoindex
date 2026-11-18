import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  validateGroupImpactParams,
  runGroupImpact,
  MAX_SUPPORTED_CROSS_DEPTH,
  DEFAULT_LOCAL_IMPACT_TIMEOUT_MS,
  collectImpactSymbolUids,
  fileMatchesServicePrefix,
} from '../../../src/core/group/cross-impact.js';
import type { GroupToolPort } from '../../../src/core/group/service.js';
import { writeBridgeMeta } from '../../../src/core/group/bridge-db.js';
import { BRIDGE_SCHEMA_VERSION } from '../../../src/core/group/bridge-schema.js';
import * as pool from '../../../src/core/lbug/pool-adapter.js';

function tmpGroup(): { tmpDir: string; groupDir: string; cleanup: () => void } {
  const tmpDir = path.join(os.tmpdir(), `ontoindex-ci-${Date.now()}-${Math.random()}`);
  const groupDir = path.join(tmpDir, 'groups', 'g1');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupDir, 'group.yaml'),
    `version: 1
name: g1
description: ""
repos:
  app/backend: reg-be
  app/frontend: reg-fe
links: []
packages: {}
detect:
  http: true
  grpc: true
  topics: true
  shared_libs: true
  embedding_fallback: true
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`,
  );
  return {
    tmpDir,
    groupDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe('cross-impact', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('test_validateGroupImpactParams_rejects_bad_direction', () => {
    const r = validateGroupImpactParams({
      name: 'g',
      repo: 'a',
      target: 't',
      direction: 'sideways',
    });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toContain('direction');
  });

  it('test_validateGroupImpactParams_clamps_crossDepth_and_warns', () => {
    const r = validateGroupImpactParams({
      name: 'g',
      repo: 'a',
      target: 't',
      direction: 'upstream',
      crossDepth: 99,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.crossDepth).toBe(MAX_SUPPORTED_CROSS_DEPTH);
      expect(r.crossDepthWarning).toBeDefined();
    }
  });

  it('test_validateGroupImpactParams_default_timeout', () => {
    const r = validateGroupImpactParams({
      name: 'g',
      repo: 'a',
      target: 't',
      direction: 'downstream',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.timeoutMs).toBe(DEFAULT_LOCAL_IMPACT_TIMEOUT_MS);
  });

  it('test_collectImpactSymbolUids_respects_service_prefix', () => {
    const local = {
      target: { id: 'a', filePath: 'services/auth/x.ts' },
      byDepth: {
        1: [{ id: 'b', filePath: 'other/y.ts' }],
      },
    };
    const uids = collectImpactSymbolUids(local, 'services/auth').uids;
    expect(uids).toContain('a');
    expect(uids).not.toContain('b');
  });

  it('test_fileMatchesServicePrefix', () => {
    expect(fileMatchesServicePrefix('services/auth/a.ts', 'services/auth')).toBe(true);
    expect(fileMatchesServicePrefix('services/aut', 'services/auth')).toBe(false);
  });

  it('test_runGroupImpact_no_cross_emits_budget_and_preserves_legacy_fields', async () => {
    const { tmpDir, cleanup } = tmpGroup();
    vi.stubEnv('ONTOINDEX_HOME', tmpDir);
    try {
      const port: GroupToolPort = {
        resolveRepo: vi.fn(async () => ({
          id: 'be',
          name: 'reg-be',
          repoPath: '/r',
          storagePath: '/r/.ontoindex',
        })),
        impact: vi.fn(async () => ({
          summary: { direct: 2, processes_affected: 1, modules_affected: 0 },
          byDepth: {},
          risk: 'LOW',
        })),
        query: vi.fn(),
        impactByUid: vi.fn(),
        context: vi.fn(),
      };
      const r = await runGroupImpact(
        { port, ontoindexDir: tmpDir },
        {
          name: 'g1',
          repo: 'app/backend',
          target: 'Sym',
          direction: 'upstream',
          maxDepth: 99,
          crossDepth: 99,
          timeoutMs: 1234,
        },
      );
      expect('error' in r).toBe(false);
      if (!('error' in r)) {
        expect(r.truncated).toBe(false);
        expect(r.truncatedRepos).toEqual([]);
        expect(r.truncationReason).toBeUndefined();
        expect(r.timeoutMs).toBe(1234);
        expect(r.crossDepthWarning).toContain('multi-hop');
        expect(r.summary).toEqual({
          direct: 2,
          processes_affected: 1,
          modules_affected: 0,
          cross_repo_hits: 0,
        });
        expect(r.budget).toMatchObject({
          requestedMaxDepth: 99,
          maxDepth: 32,
          crossDepth: MAX_SUPPORTED_CROSS_DEPTH,
          timeoutMs: 1234,
          emitted: 0,
          truncated: false,
          truncatedReasons: [],
          degradedReasons: ['cross-depth-clamped'],
        });
        expect(r.budget?.maxBridgeNeighbors).toBeGreaterThan(0);
        expect(r.budget?.elapsedMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('test_runGroupImpact_local_timeout_returns_truncation', async () => {
    const { tmpDir, cleanup } = tmpGroup();
    vi.stubEnv('ONTOINDEX_HOME', tmpDir);
    vi.useFakeTimers();
    const closeLbug = vi.spyOn(pool, 'closeLbug');
    try {
      let impactCalls = 0;
      let observedSignal: AbortSignal | undefined;
      let release!: () => void;
      const settlement = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const admitted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const payload = { summary: { direct: 1 }, byDepth: { 1: [{ id: 'x' }] } };
      const port: GroupToolPort = {
        resolveRepo: vi.fn(async () => ({
          id: 'be',
          name: 'reg-be',
          repoPath: '/r',
          storagePath: '/r/.ontoindex',
        })),
        impact: vi.fn(async (_repo, _params, options) => {
          impactCalls++;
          observedSignal = options?.signal;
          started();
          await settlement;
          return payload;
        }),
        query: vi.fn(),
        impactByUid: vi.fn(),
        context: vi.fn(),
      };
      const pending = runGroupImpact(
        { port, ontoindexDir: tmpDir },
        {
          name: 'g1',
          repo: 'app/backend',
          target: 'Sym',
          direction: 'upstream',
          timeoutMs: 15,
        },
      );
      await admitted;
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(15);
      expect(observedSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(closeLbug).not.toHaveBeenCalled();
      release();
      const r = await pending;
      expect(vi.getTimerCount()).toBe(0);
      expect(impactCalls).toBe(1);
      expect(observedSignal?.aborted).toBe(true);
      expect('error' in r).toBe(false);
      if (!('error' in r)) {
        expect(r.local).toMatchObject({
          ...payload,
          partial: true,
          truncated: true,
          risk: 'UNKNOWN',
          traversalComplete: false,
        });
        expect(r.summary.direct).toBe(1);
        expect(r.truncationReason).toBe('timeout');
        expect(r.truncated).toBe(true);
        expect(r.timeoutMs).toBe(15);
        expect(r.truncatedRepos).toEqual([]);
        expect(r.budget).toMatchObject({
          timeoutMs: 15,
          truncated: true,
          truncatedReasons: ['timeout'],
          degradedReasons: [],
        });
        expect(r.budget?.elapsedMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('test_runGroupImpact_local_partial_sets_budget_reason', async () => {
    const { tmpDir, cleanup } = tmpGroup();
    vi.stubEnv('ONTOINDEX_HOME', tmpDir);
    try {
      const port: GroupToolPort = {
        resolveRepo: vi.fn(async () => ({
          id: 'be',
          name: 'reg-be',
          repoPath: '/r',
          storagePath: '/r/.ontoindex',
        })),
        impact: vi.fn(async () => ({
          partial: true,
          summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
          byDepth: {},
          risk: 'LOW',
        })),
        query: vi.fn(),
        impactByUid: vi.fn(),
        context: vi.fn(),
      };
      const r = await runGroupImpact(
        { port, ontoindexDir: tmpDir },
        {
          name: 'g1',
          repo: 'app/backend',
          target: 'Sym',
          direction: 'upstream',
        },
      );
      expect('error' in r).toBe(false);
      if (!('error' in r)) {
        expect(r.truncated).toBe(true);
        expect(r.truncationReason).toBe('partial');
        expect(r.truncatedRepos).toEqual([]);
        expect(r.budget?.truncated).toBe(true);
        expect(r.budget?.truncatedReasons).toEqual(['partial']);
      }
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('test_runGroupImpact_bridge_schema_mismatch_returns_error', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    vi.stubEnv('ONTOINDEX_HOME', tmpDir);
    await writeBridgeMeta(groupDir, {
      version: BRIDGE_SCHEMA_VERSION + 9,
      generatedAt: new Date().toISOString(),
      missingRepos: [],
    });
    try {
      const port: GroupToolPort = {
        resolveRepo: vi.fn(async () => ({
          id: 'be',
          name: 'reg-be',
          repoPath: '/r',
          storagePath: '/r/.ontoindex',
        })),
        impact: vi.fn(async () => ({
          target: { id: 'u1', filePath: 'src/a.ts' },
          summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
          byDepth: { 1: [{ id: 'u1', filePath: 'src/a.ts' }] },
          risk: 'LOW',
        })),
        query: vi.fn(),
        impactByUid: vi.fn(),
        context: vi.fn(),
      };
      const r = await runGroupImpact(
        { port, ontoindexDir: tmpDir },
        {
          name: 'g1',
          repo: 'app/backend',
          target: 'Sym',
          direction: 'upstream',
        },
      );
      expect('error' in r).toBe(true);
      if ('error' in r) {
        expect(r.error).toContain('schema');
      }
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it.each([
    { label: 'null', local: null, risk: 'UNKNOWN' },
    { label: 'error', local: { error: 'local failed' }, risk: 'UNKNOWN' },
    { label: 'empty error', local: { error: '' }, risk: 'UNKNOWN' },
    {
      label: 'empty Error rejection',
      local: { error: '' },
      risk: 'UNKNOWN',
      reject: () => Promise.reject(new Error()),
    },
    {
      label: 'undefined rejection',
      local: { error: 'undefined' },
      risk: 'UNKNOWN',
      reject: () => Promise.reject(undefined),
    },
    {
      label: 'empty string rejection',
      local: { error: '' },
      risk: 'UNKNOWN',
      reject: () => Promise.reject(''),
    },
    { label: 'unknown', local: { risk: 'UNKNOWN' }, risk: 'UNKNOWN' },
    { label: 'truncated', local: { risk: 'HIGH', truncated: true }, risk: 'HIGH' },
    {
      label: 'traversal incomplete',
      local: { risk: 'MEDIUM', traversalComplete: false },
      risk: 'MEDIUM',
    },
  ])('preserves uncertainty or lower-bound risk for local $label', async (testCase) => {
    const { local, risk } = testCase;
    const { tmpDir, cleanup } = tmpGroup();
    try {
      const port: GroupToolPort = {
        resolveRepo: vi.fn(async () => ({
          id: 'be',
          name: 'reg-be',
          repoPath: '/r',
          storagePath: '/r/.ontoindex',
        })),
        impact: vi.fn(async () => (testCase.reject ? testCase.reject() : local)),
        query: vi.fn(),
        impactByUid: vi.fn(),
        context: vi.fn(),
      };
      const result = await runGroupImpact(
        { port, ontoindexDir: tmpDir },
        { name: 'g1', repo: 'app/backend', target: 'Sym', direction: 'upstream' },
      );
      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.local).toEqual(local);
        expect(result.risk).toBe(risk);
        expect(result.truncated).toBe(true);
        expect(result.truncationReason).toBe('partial');
        expect(result.budget?.truncatedReasons).toContain('partial');
      }
      expect(port.impactByUid).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
