import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GroupConfig } from '../../../src/core/group/types.js';
import type { GroupToolPort } from '../../../src/core/group/service.js';

describe('cross-impact bridge fan-out bounds', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('marks results partial when bridge neighbor query reaches the query-level cap', async () => {
    vi.resetModules();
    vi.stubEnv('ONTOINDEX_GROUP_CROSS_MAX_BRIDGE_NEIGHBORS', '2');

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

    const queryBridge = vi.fn(async () => [
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
    ]);

    vi.doMock('../../../src/core/group/storage.js', () => ({
      getGroupDir: () => groupDir,
    }));
    vi.doMock('../../../src/core/group/config-parser.js', () => ({
      loadGroupConfig: vi.fn(async () => config),
    }));
    vi.doMock('../../../src/core/group/bridge-db.js', () => ({
      readBridgeMeta: vi.fn(async () => ({ version: 0, generatedAt: '', missingRepos: [] })),
      openBridgeDbReadOnly: vi.fn(async () => ({ _db: {}, _conn: {}, groupDir })),
      closeBridgeDb: vi.fn(async () => {}),
      queryBridge,
    }));

    try {
      const { runGroupImpact, MAX_CROSS_BRIDGE_NEIGHBORS } =
        await import('../../../src/core/group/cross-impact.js');
      expect(MAX_CROSS_BRIDGE_NEIGHBORS).toBe(2);

      const port: GroupToolPort = {
        resolveRepo: vi.fn(async (name: string) => ({
          id: name,
          name,
          repoPath: `/repos/${name}`,
          storagePath: `/repos/${name}/.ontoindex`,
        })),
        impact: vi.fn(async () => ({
          target: { id: 'local-uid', filePath: 'src/local.ts' },
          summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
          byDepth: {},
          risk: 'LOW',
        })),
        impactByUid: vi.fn(async () => ({ byDepth: {}, affected_processes: [] })),
        query: vi.fn(),
        context: vi.fn(),
      };

      const result = await runGroupImpact(
        { port, ontoindexDir: tmpDir },
        { name: 'g1', repo: 'app/backend', target: 'Local', direction: 'upstream' },
      );

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.truncated).toBe(true);
        expect(result.truncationReason).toBe('partial');
      }
      expect(queryBridge.mock.calls[0][1]).toContain('LIMIT 2');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
