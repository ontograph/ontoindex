import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverlaySnapshot } from '../../src/mcp/local/backend-overlay.js';

const repo = { id: 'verified-base-test', repoPath: '/fixture', storagePath: '/fixture/.ontoindex' };
const snapshot = (baseProvenance: OverlaySnapshot['baseProvenance']): OverlaySnapshot => ({
  usable: false,
  reason: 'no dirty files',
  dirtyPaths: new Set(),
  configPaths: new Set(),
  parseErrorPaths: new Set(),
  overlayPaths: new Set(),
  uncoveredPaths: new Set(),
  tombstones: new Set(),
  baseMatches: true,
  headChanged: false,
  baseProvenance,
});

afterEach(() => vi.unstubAllEnvs());

describe('verified workspace base', () => {
  it.each(['working-tree', 'unknown'] as const)(
    'verifies a clean base for %s provenance',
    async (provenance) => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      const build = vi.fn(async () => {});
      const verify = vi.fn(async () => true);
      await expect(
        actualRuntime.prepareWorkspaceRead({
          repo,
          needsRelationships: true,
          requireVerifiedBase: true,
          dependencies: {
            getSnapshot: async () => snapshot(provenance),
            verifyBaseMatchesWorkingTree: verify,
            buildWorkspaceGraph: build,
          },
        }),
      ).resolves.toMatchObject({ baseVerified: true });
      expect(verify).toHaveBeenCalledOnce();
      expect(build).not.toHaveBeenCalled();
    },
  );

  it.each([false, 'throws'] as const)(
    'refuses a base when verification returns %s',
    async (outcome) => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      const build = vi.fn();
      const verify = vi.fn(async () => {
        if (outcome === 'throws') throw new Error('failed');
        return false;
      });
      await expect(
        actualRuntime.prepareWorkspaceRead({
          repo,
          needsRelationships: true,
          requireVerifiedBase: true,
          dependencies: {
            getSnapshot: async () => snapshot('unknown'),
            verifyBaseMatchesWorkingTree: verify,
            buildWorkspaceGraph: build,
          },
        }),
      ).rejects.toMatchObject({
        code: 'workspace_coverage_incomplete',
        diagnostics: {
          reason:
            outcome === 'throws'
              ? 'committed index verification failed'
              : 'committed index bytes differ from the clean working tree; refresh with ontoindex analyze',
        },
      });
      expect(build).not.toHaveBeenCalled();
    },
  );

  it('reuses a verified commit base', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const build = vi.fn();
    const verify = vi.fn();
    const base = snapshot('commit');
    await expect(
      actualRuntime.prepareWorkspaceRead({
        repo,
        needsRelationships: true,
        requireVerifiedBase: true,
        dependencies: {
          getSnapshot: async () => base,
          verifyBaseMatchesWorkingTree: verify,
          buildWorkspaceGraph: build,
        },
      }),
    ).resolves.toBe(base);
    expect(build).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
});

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import * as runtime from '../../src/mcp/local/local-backend-repo-runtime.js';
import * as storage from '../../src/storage/repo-manager.js';

vi.mock('../../src/mcp/local/local-backend-repo-runtime.js', async (original) => ({
  ...(await original<typeof import('../../src/mcp/local/local-backend-repo-runtime.js')>()),
  prepareWorkspaceRead: vi.fn(),
}));
vi.mock('../../src/storage/repo-manager.js', async (original) => ({
  ...(await original<typeof import('../../src/storage/repo-manager.js')>()),
  readActiveGenerationMeta: vi.fn(async () => ({ meta: null, authority: 'missing' })),
  acquireIndexGenerationPin: vi.fn(async () => ({
    dbPath: '/fixture/db',
    release: async () => {},
  })),
}));
vi.mock('../../src/core/lbug/pool-adapter.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  withPinnedGeneration: vi.fn(async (_id, _path, callback) => callback()),
}));
vi.mock('../../src/mcp/local/backend-overlay.js', async (original) => ({
  ...(await original<typeof import('../../src/mcp/local/backend-overlay.js')>()),
  withPinnedOverlay: vi.fn(async (_repo, _snapshot, callback) => callback()),
}));

// Preserve the real preparation function for the dependency-injection tests above.
const actualRuntime = await vi.importActual<
  typeof import('../../src/mcp/local/local-backend-repo-runtime.js')
>('../../src/mcp/local/local-backend-repo-runtime.js');

describe('explicit read contexts', () => {
  it.each([
    [true, 'complete', 'degraded', 'workspace-graph', 'complete'],
    [true, 'complete', 'complete', 'workspace-graph', 'complete'],
    [true, 'partial', 'complete', 'workspace-graph', 'partial'],
    [true, 'partial', 'degraded', 'workspace-graph', 'partial'],
    [false, undefined, 'degraded', 'base', 'partial'],
    [false, undefined, 'complete', 'base', 'complete'],
  ] as const)(
    'uses selected coverage for usable=%s workspace=%s base=%s',
    async (usable, workspaceCoverage, baseCoverage, source, semanticCoverage) => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      vi.mocked(runtime.prepareWorkspaceRead).mockResolvedValue({
        ...snapshot('commit'),
        usable,
        capability: 'workspace-graph',
        coverage: workspaceCoverage,
        baseGenerationId: 'g',
      });
      vi.mocked(storage.readActiveGenerationMeta).mockResolvedValue({
        meta: {
          parserEvidence: { version: 1, parseErrorCount: 0, parseErrorFiles: [], truncated: false },
          sourceManifest: {
            version: 1,
            head: 'head',
            sourceDigest: 'source-digest',
            sourceEntryCount: 1,
            includePaths: [],
            scopeDigest: 'scope-digest',
            ignorePolicyDigest: 'ignore-digest',
            pipelineProfile: 'full',
            analyzerContractVersion: 'ontoindex-source-manifest-v1',
            coverage: baseCoverage,
          },
        },
        authority: 'trusted',
        activeGeneration: { generationId: 'g', lbugPath: '/fixture/db' },
      } as any);
      const backend = new LocalBackend();
      try {
        const result = await backend.withPreparedRepoRead(
          repo as any,
          { needsRelationships: true, readMode: 'workspace' },
          async () => ({}),
        );
        expect(result).toMatchObject({ readContext: { source, semanticCoverage } });
      } finally {
        await backend.dispose();
      }
    },
  );

  it.each([true, false])(
    'checks the base generation and pins it when matching: %s',
    async (matches) => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      const release = vi.fn(async () => {});
      vi.mocked(storage.acquireIndexGenerationPin).mockResolvedValueOnce({
        dbPath: '/fixture/db',
        release,
      } as any);
      vi.mocked(runtime.prepareWorkspaceRead).mockResolvedValue({
        ...snapshot('unknown'),
        baseVerified: true,
        baseGenerationId: 'g',
      });
      vi.mocked(storage.readActiveGenerationMeta).mockResolvedValue({
        meta: {
          parserEvidence: { version: 1, parseErrorCount: 0, parseErrorFiles: [], truncated: false },
          sourceManifest: {
            version: 1,
            head: 'head',
            sourceDigest: 'source-digest',
            sourceEntryCount: 1,
            includePaths: [],
            scopeDigest: 'scope-digest',
            ignorePolicyDigest: 'ignore-digest',
            pipelineProfile: 'full',
            analyzerContractVersion: 'ontoindex-source-manifest-v1',
            coverage: 'complete',
          },
        },
        authority: 'trusted',
        activeGeneration: { generationId: matches ? 'g' : 'other', lbugPath: '/fixture/db' },
      } as any);
      const backend = new LocalBackend();
      const handler = vi.fn(async () => ({}));
      try {
        const result = backend.withPreparedRepoRead(
          repo as any,
          { needsRelationships: true, readMode: 'workspace' },
          handler,
        );
        if (matches) {
          await expect(result).resolves.toMatchObject({
            readContext: {
              source: 'base',
              semanticCoverage: 'complete',
              inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          });
          expect(release).toHaveBeenCalledOnce();
        } else {
          await expect(result).rejects.toMatchObject({
            code: 'workspace_coverage_incomplete',
            diagnostics: { reason: 'index generation changed during preparation; retry' },
          });
          expect(handler).not.toHaveBeenCalled();
          expect(release).not.toHaveBeenCalled();
        }
      } finally {
        await backend.dispose();
      }
    },
  );
  it.each([
    [undefined, null, [], null, 'partial'],
    ...[256, 257].map((length) => [
      {
        version: 1,
        parseErrorCount: 2,
        parseErrorFiles: ['x'.repeat(length), 'short.ts'],
        truncated: false,
      },
      2,
      ['short.ts', length === 256 ? 'x'.repeat(256) : `${'x'.repeat(255)}…`],
      length > 256,
      'partial',
    ]),
    [
      { version: 1, parseErrorCount: 0, parseErrorFiles: [], truncated: false },
      0,
      [],
      false,
      'complete',
    ],
    [
      {
        version: 1,
        parseErrorCount: 2,
        parseErrorFiles: ['z.ts', 'a.ts', 'a.ts'],
        truncated: false,
      },
      2,
      ['a.ts', 'z.ts'],
      false,
      'partial',
    ],
    [
      {
        version: 1,
        parseErrorCount: 20,
        parseErrorFiles: Array.from({ length: 15 }, (_, i) => `bad${i}.ts`),
        truncated: true,
      },
      20,
      Array.from({ length: 15 }, (_, i) => `bad${i}.ts`)
        .sort()
        .slice(0, 10),
      true,
      'partial',
    ],
  ])(
    'reads generation parser evidence after restart: %j',
    async (evidence, count, sample, truncated, coverage) => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      vi.mocked(runtime.prepareWorkspaceRead).mockResolvedValue({
        ...snapshot('commit'),
        baseGenerationId: 'g',
      });
      // JSON roundtrip represents metadata reloaded without process-local parser state.
      vi.mocked(storage.readActiveGenerationMeta).mockResolvedValue(
        JSON.parse(
          JSON.stringify({
            meta: {
              parserEvidence: evidence,
              sourceManifest: {
                version: 1,
                head: 'head',
                sourceDigest: 'source-digest',
                sourceEntryCount: 1,
                includePaths: [],
                scopeDigest: 'scope-digest',
                ignorePolicyDigest: 'ignore-digest',
                pipelineProfile: 'full',
                analyzerContractVersion: 'ontoindex-source-manifest-v1',
                coverage: 'complete',
              },
            },
            authority: 'trusted',
            activeGeneration: { generationId: 'g', lbugPath: '/fixture/db' },
          }),
        ),
      );
      const backend = new LocalBackend();
      try {
        const result = await backend.withPreparedRepoRead(
          repo as any,
          { needsRelationships: true, readMode: 'workspace' },
          async () => ({}),
        );
        expect(result).toMatchObject({
          readContext: {
            source: 'base',
            semanticCoverage: coverage,
            parseErrorPathCount: count,
            parseErrorPathSample: sample,
            parseErrorPathSampleTruncated: truncated,
          },
        });
      } finally {
        await backend.dispose();
      }
    },
  );

  it.each([0, 256, 257])('bounds live parse-error samples of length %i', async (length) => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const paths = length ? ['x'.repeat(length), 'short.ts'] : [];
    vi.mocked(runtime.prepareWorkspaceRead).mockResolvedValue({
      ...snapshot('commit'),
      usable: true,
      capability: 'workspace-graph',
      coverage: 'complete',
      parseErrorPaths: new Set(paths),
    });
    vi.mocked(storage.readActiveGenerationMeta).mockResolvedValue({
      meta: null,
      authority: 'missing',
    } as any);
    const backend = new LocalBackend();
    try {
      const result = await backend.withPreparedRepoRead(
        repo as any,
        { needsRelationships: true, readMode: 'workspace' },
        async () => ({}),
      );
      expect(result).toMatchObject({
        readContext: {
          source: 'workspace-graph',
          parseErrorPathCount: paths.length,
          parseErrorPathSample: length
            ? ['short.ts', length === 256 ? 'x'.repeat(256) : `${'x'.repeat(255)}…`]
            : [],
          parseErrorPathSampleTruncated: length > 256,
        },
      });
    } finally {
      await backend.dispose();
    }
  });

  it.each([
    ['commit', false],
    ['working-tree', true],
    ['unknown', null],
    [undefined, null],
  ] as const)('reports %s committed provenance', async (kind, included) => {
    vi.mocked(storage.readActiveGenerationMeta).mockResolvedValue({
      meta: {
        lastCommit: 'head',
        ...(kind ? { sourceProvenance: { kind, head: 'head', changedPathCount: 0 } } : {}),
      },
      authority: 'trusted',
      activeGeneration: { generationId: 'g', lbugPath: '/fixture/db' },
    } as any);
    const backend = new LocalBackend();
    try {
      const result = await backend.withPreparedRepoRead(
        repo as any,
        { needsRelationships: false, readMode: 'committed' },
        async () => ({}),
      );
      expect(result).toMatchObject({
        readContext: { sourceProvenance: kind ?? 'unknown', workingTreeIncluded: included },
      });
      expect((result as any).readContext.excludedEvidence).toEqual([
        ...(kind !== 'working-tree' ? ['uncommitted source changes'] : []),
        'manual overlays',
        'live LSP references',
      ]);
    } finally {
      await backend.dispose();
    }
  });

  it.each([
    ['complete', ['missing.ts']],
    ['degraded', []],
  ] as const)(
    'refuses %s workspace coverage with uncovered paths %j',
    async (coverage, uncovered) => {
      vi.mocked(runtime.prepareWorkspaceRead).mockClear();
      vi.mocked(runtime.prepareWorkspaceRead).mockResolvedValue({
        ...snapshot('commit'),
        usable: true,
        capability: 'workspace-graph',
        coverage,
        uncoveredPaths: new Set(uncovered),
      });
      vi.mocked(storage.readActiveGenerationMeta).mockResolvedValue({
        meta: {},
        authority: 'trusted',
      } as any);
      const backend = new LocalBackend();
      const handler = vi.fn(async () => ({}));
      try {
        await expect(
          backend.withPreparedRepoRead(
            repo as any,
            { needsRelationships: false, readMode: 'workspace' },
            handler,
          ),
        ).rejects.toMatchObject({ code: 'workspace_coverage_incomplete', retryable: false });
        expect(handler).not.toHaveBeenCalled();
        expect(runtime.prepareWorkspaceRead).toHaveBeenCalledTimes(1);
      } finally {
        await backend.dispose();
      }
    },
  );
});

it('fails closed when explicit workspace reads are disabled', async () => {
  vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
  const backend = new LocalBackend();
  const handler = vi.fn(async () => ({}));
  try {
    await expect(
      backend.withPreparedRepoRead(
        repo as any,
        { needsRelationships: true, readMode: 'workspace' },
        handler,
      ),
    ).rejects.toMatchObject({
      code: 'workspace_coverage_incomplete',
      retryable: false,
      diagnostics: { reason: expect.stringContaining('disabled') },
    });
    expect(handler).not.toHaveBeenCalled();
  } finally {
    await backend.dispose();
  }
});
