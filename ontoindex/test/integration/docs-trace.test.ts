import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { traceCommand } from '../../src/cli/docs.js';
import { LocalSidecarStore } from '../../src/core/ingestion/enrichment/sidecar-store.js';
import * as git from '../../src/storage/git.js';
import * as repoManager from '../../src/storage/repo-manager.js';
import * as markdownCollector from '../../src/core/ingestion/enrichment/markdown-sidecar-collector.js';
import { hashText } from '../../src/core/ingestion/enrichment/markdown-sidecar-producer.js';

vi.mock('../../src/storage/repo-manager.js');
vi.mock('../../src/storage/git.js');
vi.mock('../../src/core/ingestion/enrichment/markdown-sidecar-collector.js');

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('mockExit');
}) as never);

describe('docs trace', () => {
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
      lbugPath: '',
      metaPath: '',
    });
    vi.mocked(markdownCollector.collectMarkdownSidecarDocuments).mockResolvedValue({
      documents: [{ docPath: 'docs/requirements.md', source: 'REQ-1', sourceCommitHash: 'abc123' }],
      scopeHash: 'scope-1',
    });
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
          filePath: 'docs/requirements.md',
          fileHash: hashText('REQ-1'),
          status: 'complete',
          records: [requirement('REQ-1'), resolution('REQ-1')],
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

  it('emits requirement trace JSON from sidecar facts and resolutions', async () => {
    await traceCommand({ requirements: true, json: true, id: 'REQ-1' });

    const output = JSON.parse(mockLog.mock.calls[0][0]);
    expect(output.summary.report).toBe('requirement-trace');
    expect(output.repo).toMatchObject({
      id: '/test/repo',
      path: '/test/repo',
      sourceIndexId: 'index-1',
      sourceCommitHash: 'abc123',
    });
    expect(output.items).toHaveLength(1);
    expect(output.items[0]).toMatchObject({
      requirementId: 'REQ-1',
      status: 'implemented',
      evidenceClasses: ['declared', 'linked', 'resolved'],
    });
  });

  it('rejects trace reports without --requirements', async () => {
    await expect(traceCommand({ json: true })).rejects.toThrow('mockExit');
    expect(mockError).toHaveBeenCalledWith('Only docs trace --requirements is supported.');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

function requirement(requirementId: string) {
  return {
    kind: 'markdown-requirement',
    schemaVersion: 1,
    docPath: 'docs/requirements.md',
    headingPath: [requirementId],
    lineSpan: { start: 1, end: 1 },
    sourceChunkKey: `chunk:${requirementId}`,
    normalizedKey: requirementId,
    confidence: 1,
    evidence: {
      text: `${requirementId} requirement`,
      raw: `${requirementId} requirement`,
      lineSpan: { start: 1, end: 1 },
    },
    requirementId,
    title: `${requirementId} title`,
    source: 'heading',
  };
}

function resolution(factKey: string) {
  return {
    kind: 'markdown-doc-resolution',
    schemaVersion: 1,
    resolverId: 'ontoindex.markdown-doc-resolver',
    resolverVersion: '1.0.0',
    sourceIndexId: 'index-1',
    sourceCommitHash: 'abc123',
    graphSchemaVersion: 1,
    docPath: 'docs/requirements.md',
    factKey,
    factKind: 'markdown-requirement',
    subjectKind: 'requirement',
    resolutionKey: `resolution:${factKey}`,
    status: 'resolved',
    confidence: 0.8,
    evidenceKind: 'lexical-requirement-id',
    reasons: ['single-candidate'],
    targetGraphIdentity: {
      type: 'symbol',
      id: `symbol:${factKey}`,
      filePath: 'src/feature.ts',
      confidence: 0.8,
    },
    candidates: [
      {
        type: 'symbol',
        id: `symbol:${factKey}`,
        filePath: 'src/feature.ts',
        confidence: 0.8,
      },
    ],
    lineSpan: { start: 1, end: 1 },
  };
}
