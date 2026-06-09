import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { driftCommand } from '../../src/cli/docs.js';
import * as lbug from '../../src/core/lbug/pool-adapter.js';
import * as markdownCollector from '../../src/core/ingestion/enrichment/markdown-sidecar-collector.js';
import { hashText } from '../../src/core/ingestion/enrichment/markdown-sidecar-producer.js';
import { LocalSidecarStore } from '../../src/core/ingestion/enrichment/sidecar-store.js';
import * as git from '../../src/storage/git.js';
import * as repoManager from '../../src/storage/repo-manager.js';

vi.mock('../../src/storage/repo-manager.js');
vi.mock('../../src/storage/git.js');
vi.mock('../../src/core/ingestion/enrichment/markdown-sidecar-collector.js');
vi.mock('../../src/core/lbug/pool-adapter.js');

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('mockExit');
}) as never);

describe('docs drift', () => {
  let mockLoad: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(git.isGitRepo).mockReturnValue(true);
    vi.mocked(git.getGitRoot).mockReturnValue('/test/repo');
    vi.mocked(git.getCurrentCommit).mockReturnValue('abc123');
    vi.mocked(repoManager.findRepo).mockResolvedValue({
      repoPath: '/test/repo',
      meta: {
        repoPath: '/test/repo',
        indexedAt: 'index-1',
        lastCommit: 'abc123',
        stats: { nodes: 10, relationships: 20 },
      },
    } as never);
    vi.mocked(repoManager.getStoragePaths).mockReturnValue({
      storagePath: '/test/repo/.ontoindex',
      lbugPath: '/test/repo/.ontoindex/lbug',
      metaPath: '',
    });
    vi.mocked(markdownCollector.collectMarkdownSidecarDocuments).mockResolvedValue({
      documents: [{ docPath: 'docs/api.md', source: 'GET /users', sourceCommitHash: 'abc123' }],
      scopeHash: 'scope-1',
    });
    vi.mocked(lbug.initLbug).mockResolvedValue(undefined);
    vi.mocked(lbug.closeLbug).mockResolvedValue(undefined);
    vi.mocked(lbug.executeParameterized).mockResolvedValue([
      { path: '/users', sourceFile: 'src/routes.ts', handler: 'Route:/users' },
    ] as never);
    mockLoad = vi.spyOn(LocalSidecarStore.prototype, 'load').mockResolvedValue({
      schemaVersion: 1,
      requests: [],
      lock: null,
      enrichments: [
        {
          sourceIndexId: 'index-1',
          sourceCommitHash: 'abc123',
          schemaVersion: 1,
          analyzerId: 'markdown-document-sidecar',
          analyzerVersion: '0.1.0',
          filePath: 'docs/api.md',
          fileHash: hashText('GET /users'),
          status: 'complete',
          records: [apiSpec('GET', '/users')],
        },
      ],
    } as never);
  });

  afterEach(() => {
    mockLoad.mockRestore();
    mockLog.mockClear();
    mockError.mockClear();
    mockExit.mockClear();
  });

  it('emits API drift JSON from sidecar facts and route nodes', async () => {
    await driftCommand({ api: true, json: true });

    const output = JSON.parse(mockLog.mock.calls[0][0]);
    expect(output.summary.report).toBe('api-drift');
    expect(output.repo).toMatchObject({
      id: '/test/repo',
      path: '/test/repo',
      sourceIndexId: 'index-1',
      sourceCommitHash: 'abc123',
    });
    expect(output.summary.api).toMatchObject({
      documentedRoutes: 1,
      codeRoutes: 1,
    });
    expect(output.items).toHaveLength(1);
    expect(output.items[0]).toMatchObject({
      status: 'unsupported',
      path: '/users',
      code: [
        {
          state: 'partial',
          filePath: 'src/routes.ts',
        },
      ],
    });
  });

  it('rejects drift reports without --api', async () => {
    await expect(driftCommand({ json: true })).rejects.toThrow('mockExit');
    expect(mockError).toHaveBeenCalledWith('Only docs drift --api is supported.');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

function apiSpec(method: string, path: string) {
  return {
    kind: 'markdown-api-spec',
    schemaVersion: 1,
    docPath: 'docs/api.md',
    headingPath: ['API'],
    lineSpan: { start: 1, end: 1 },
    sourceChunkKey: 'chunk:api',
    normalizedKey: `${method} ${path}`,
    confidence: 0.9,
    evidence: {
      text: `${method} ${path}`,
      raw: `${method} ${path}`,
      lineSpan: { start: 1, end: 1 },
    },
    method,
    path,
    routeKey: `${method} ${path}`,
  };
}
