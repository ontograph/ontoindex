import { describe, expect, it } from 'vitest';

import type { IndexSourceManifest } from '../../src/core/indexing/source-manifest.js';
import { resolveTargetContext } from '../../src/mcp/shared/target-context.js';

describe('target context graph capability authority', () => {
  it('degrades a matching symbols-only generation when full graph capabilities are required', async () => {
    const manifest: IndexSourceManifest = {
      version: 1,
      head: 'abc123',
      sourceDigest: 'source-digest',
      sourceEntryCount: 1,
      includePaths: [],
      scopeDigest: 'scope-digest',
      ignorePolicyDigest: 'ignore-digest',
      pipelineProfile: 'symbols',
      analyzerContractVersion: 'ontoindex-source-manifest-v1',
      coverage: 'complete',
    };
    const execGit = async (_cwd: string, args: string[]) => {
      if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'feature\n';
      if (args[0] === 'status') return '';
      return 'abc123\n';
    };

    const context = await resolveTargetContext(
      {
        repo: 'repo',
        verifyGraphAuthority: true,
        requiredGraphCapabilities: ['impact', 'processes'],
      },
      {
        readRegistry: async () => [
          {
            name: 'repo',
            path: '/repo',
            storagePath: '/repo/.ontoindex',
            indexedAt: '2026-08-05T00:00:00.000Z',
            lastCommit: 'abc123',
          },
        ],
        execGit,
        loadMeta: async () => ({
          repoPath: '.',
          lastCommit: 'abc123',
          indexedAt: '2026-08-05T00:00:00.000Z',
          generationId: 'generation-1',
          sourceManifest: manifest,
          indexMode: 'symbols-only',
          pipelineProfile: 'symbols',
          capabilities: { symbols: true, impact: 'degraded', processes: false },
        }),
        computeSourceManifest: async () => manifest,
        resolveActiveIndexGeneration: async () => ({
          generationId: 'generation-1',
          generationPath: '/repo/.ontoindex/generations/generation-1',
          lbugPath: '/repo/.ontoindex/generations/generation-1/lbug',
          metaPath: '/repo/.ontoindex/generations/generation-1/meta.json',
          snapshotPath: '/repo/.ontoindex/generations/generation-1/snapshot.json',
        }),
      },
    );

    expect(context.graphAuthority).toMatchObject({
      state: 'degraded',
      reason: 'required graph capabilities unavailable: impact, processes',
      generationId: 'generation-1',
    });
  });

  it.each([
    { version: 2, analyzerContractVersion: 'ontoindex-source-manifest-v1' },
    { version: 1, analyzerContractVersion: 'ontoindex-source-manifest-v2' },
  ])('degrades unsupported manifest identity contracts', async (identity) => {
    const manifest = {
      version: identity.version,
      head: 'abc123',
      sourceDigest: 'source-digest',
      sourceEntryCount: 1,
      includePaths: [],
      scopeDigest: 'scope-digest',
      ignorePolicyDigest: 'ignore-digest',
      pipelineProfile: 'full',
      analyzerContractVersion: identity.analyzerContractVersion,
      coverage: 'complete',
    } as unknown as IndexSourceManifest;
    const execGit = async (_cwd: string, args: string[]) => {
      if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'feature\n';
      if (args[0] === 'status') return '';
      return 'abc123\n';
    };

    const context = await resolveTargetContext(
      { repo: 'repo', verifyGraphAuthority: true },
      {
        readRegistry: async () => [
          {
            name: 'repo',
            path: '/repo',
            storagePath: '/repo/.ontoindex',
            indexedAt: '2026-08-05T00:00:00.000Z',
            lastCommit: 'abc123',
          },
        ],
        execGit,
        loadMeta: async () => ({
          repoPath: '.',
          lastCommit: 'abc123',
          indexedAt: '2026-08-05T00:00:00.000Z',
          generationId: 'generation-1',
          sourceManifest: manifest,
        }),
        computeSourceManifest: async () => manifest,
        resolveActiveIndexGeneration: async () => ({
          generationId: 'generation-1',
          generationPath: '/repo/.ontoindex/generations/generation-1',
          lbugPath: '/repo/.ontoindex/generations/generation-1/lbug',
          metaPath: '/repo/.ontoindex/generations/generation-1/meta.json',
          snapshotPath: '/repo/.ontoindex/generations/generation-1/snapshot.json',
        }),
      },
    );

    expect(context.graphAuthority).toMatchObject({
      state: 'degraded',
      reason: 'index manifest version or analyzer contract is unsupported',
      generationId: 'generation-1',
    });
  });
});
