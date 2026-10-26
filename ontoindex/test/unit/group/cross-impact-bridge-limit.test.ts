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

  it.each([false, true])(
    'preserves fan metadata (%s) and marks results partial at the bridge neighbor cap',
    async (withMetadata) => {
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
        }));
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
          impactByUid: vi.fn(async (_repo, uid) => fans[uid === 'dep-1' ? 0 : 1]),
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
          expect(result.cross).toEqual(
            metadata.map((entry, index) => ({
              repo: 'reg-dep',
              repo_path: 'app/dep',
              contract: {
                id: `http::GET::/${index === 0 ? 'a' : 'b'}`,
                type: 'http',
                match_type: 'exact',
                confidence: index === 0 ? 0.9 : 0.8,
              },
              by_depth: fans[index].byDepth,
              affected_processes: [`process-${index}`],
              ...(withMetadata ? entry : {}),
            })),
          );
          expect(result.summary.cross_repo_hits).toBe(2);
          expect(port.impactByUid).toHaveBeenCalledTimes(2);
        }
        expect(queryBridge.mock.calls[0][1]).toContain('LIMIT 2');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
