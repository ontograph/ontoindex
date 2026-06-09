import { describe, expect, it } from 'vitest';

import {
  InMemoryGraphIdentityProvider,
  LbugGraphIdentityProvider,
  type GraphIdentityRow,
} from '../../src/core/ingestion/enrichment/markdown-graph-identity-provider.js';
import type { SourceIndexIdentity } from '../../src/core/ingestion/enrichment/docs-contracts.js';

const sourceIndex: SourceIndexIdentity = {
  repoId: 'repo-a',
  repoPath: '/repo/a',
  sourceIndexId: 'index-a',
  sourceCommitHash: 'commit-a',
  graphSchemaVersion: 7,
};

describe('InMemoryGraphIdentityProvider', () => {
  it('returns deterministic capped symbol candidates', async () => {
    const provider = new InMemoryGraphIdentityProvider({
      symbols: [
        {
          type: 'symbol',
          id: 'Function:run:b',
          name: 'run',
          filePath: 'src/b.ts',
          confidence: 0.8,
        },
        {
          type: 'symbol',
          id: 'Function:run:a',
          name: 'run',
          filePath: 'src/a.ts',
          confidence: 0.9,
        },
        {
          type: 'symbol',
          id: 'Function:run:c',
          name: 'run',
          filePath: 'src/c.ts',
          confidence: 0.7,
        },
      ],
    });

    await expect(provider.findSymbols({ mention: 'run', maxCandidates: 2 })).resolves.toEqual([
      expect.objectContaining({ id: 'Function:run:a' }),
      expect.objectContaining({ id: 'Function:run:b' }),
    ]);
  });

  it('matches test files by path suffix before exposing them to resolver tests', async () => {
    const provider = new InMemoryGraphIdentityProvider({
      testFiles: [
        {
          type: 'test-file',
          id: 'File:ontoindex/test/unit/example.test.ts',
          filePath: 'ontoindex/test/unit/example.test.ts',
          confidence: 0.95,
        },
      ],
    });

    await expect(
      provider.findTestFiles({ mention: 'example.test.ts', maxCandidates: 5 }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: 'test-file',
        filePath: 'ontoindex/test/unit/example.test.ts',
      }),
    ]);
  });
});

describe('LbugGraphIdentityProvider', () => {
  it('maps LadybugDB symbol rows through the provider boundary', async () => {
    const queries: string[] = [];
    const provider = new LbugGraphIdentityProvider({
      repoId: 'repo-a',
      sourceIndex,
      query: async (_repoId: string, cypher: string): Promise<GraphIdentityRow[]> => {
        queries.push(cypher);
        return [
          {
            id: 'Function:resolveDoc',
            name: 'resolveDoc',
            label: 'Function',
            filePath: 'src/resolve.ts',
            startLine: 10,
            endLine: 20,
          },
        ];
      },
    });

    const candidates = await provider.findSymbols({ mention: 'resolveDoc', maxCandidates: 5 });

    expect(queries[0]).toContain('MATCH (n)');
    expect(candidates).toEqual([
      expect.objectContaining({
        type: 'symbol',
        id: 'Function:resolveDoc',
        filePath: 'src/resolve.ts',
        sourceIndexId: 'index-a',
        graphSchemaVersion: 7,
      }),
    ]);
  });

  it('passes symbol file and kind hints into the LadybugDB query', async () => {
    const paramsSeen: unknown[] = [];
    const provider = new LbugGraphIdentityProvider({
      repoId: 'repo-a',
      query: async (_repoId: string, cypher: string, params): Promise<GraphIdentityRow[]> => {
        expect(cypher).toContain('n.filePath CONTAINS $filePathHint');
        expect(cypher).toContain('labels(n)[0] = $kindHint');
        paramsSeen.push(params);
        return [
          {
            id: 'Function:resolveDoc',
            name: 'resolveDoc',
            filePath: 'src/docs/resolve.ts',
          },
        ];
      },
    });

    await expect(
      provider.findSymbols({
        mention: 'resolveDoc',
        filePathHint: 'src/docs/resolve.ts',
        kindHint: 'Function',
        maxCandidates: 5,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'Function:resolveDoc',
        filePath: 'src/docs/resolve.ts',
      }),
    ]);
    expect(paramsSeen).toEqual([
      {
        mention: 'resolveDoc',
        filePathHint: 'src/docs/resolve.ts',
        kindHint: 'Function',
        limit: 5,
      },
    ]);
  });

  it('filters production test-file lookup to indexed test paths', async () => {
    const provider = new LbugGraphIdentityProvider({
      repoId: 'repo-a',
      query: async (): Promise<GraphIdentityRow[]> => [
        { id: 'File:src/user.ts', name: 'user.ts', filePath: 'src/user.ts' },
        { id: 'File:test/user.test.ts', name: 'user.test.ts', filePath: 'test/user.test.ts' },
      ],
    });

    await expect(provider.findTestFiles({ mention: 'user', maxCandidates: 5 })).resolves.toEqual([
      expect.objectContaining({ type: 'test-file', id: 'File:test/user.test.ts' }),
    ]);
  });

  it('looks up route candidates by method and path key', async () => {
    const provider = new LbugGraphIdentityProvider({
      repoId: 'repo-a',
      query: async (_repoId, _cypher, params): Promise<GraphIdentityRow[]> => [
        { id: String(params.routeKey), name: String(params.routeKey), filePath: 'src/routes.ts' },
      ],
    });

    await expect(
      provider.findRoutes({ method: 'GET', path: '/users/:id', maxCandidates: 5 }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: 'route',
        id: 'GET /users/:id',
        method: 'GET',
        routePath: '/users/:id',
      }),
    ]);
  });
});
