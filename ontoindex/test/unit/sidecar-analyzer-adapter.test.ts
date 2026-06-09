import { describe, expect, it, vi } from 'vitest';
import {
  analyzeSidecarRequestToEnrichmentRecords,
  createSidecarAnalyzerExecutor,
  createSidecarRequest,
  LocalSidecarAnalyzerAdapter,
  type SidecarAnalyzerAdapterOptions,
} from '../../src/core/ingestion/enrichment/index.js';

const request = createSidecarRequest({
  id: 'request-1',
  repoId: 'repo-1',
  sourceIndexId: 'index-1',
  analyzerId: 'local-lightweight',
  analyzerVersion: '1.0.0',
  purpose: 'type-aware-resolution',
  scopeHash: 'scope-1',
  priority: 'user-requested',
  requestedAt: '2026-05-13T10:00:00.000Z',
});

const baseOptions: SidecarAnalyzerAdapterOptions = {
  analyzer: {
    analyzerId: 'local-lightweight',
    analyzerVersion: '1.0.0',
  },
  snapshot: {
    sourceIndexId: 'index-1',
    sourceCommitHash: 'commit-1',
    schemaVersion: 2,
  },
  files: [
    {
      filePath: 'src/app.ts',
      fileHash: 'hash-app',
      facts: [{ kind: 'scope-file', symbolCount: 3 }],
    },
  ],
  analyze: vi.fn(),
};

describe('sidecar analyzer adapter', () => {
  it('converts complete analyzer results into bound enrichment record inputs', async () => {
    const analyze = vi.fn(async () => ({
      confidence: 0.9,
    }));

    const records = await analyzeSidecarRequestToEnrichmentRecords(request, {
      ...baseOptions,
      analyze,
    });

    expect(records).toEqual([
      {
        sourceIndexId: 'index-1',
        sourceCommitHash: 'commit-1',
        schemaVersion: 2,
        analyzerId: 'local-lightweight',
        analyzerVersion: '1.0.0',
        filePath: 'src/app.ts',
        fileHash: 'hash-app',
        status: 'complete',
        confidence: 0.9,
        records: [{ kind: 'scope-file', symbolCount: 3 }],
      },
    ]);
    expect(analyze).toHaveBeenCalledWith({
      request,
      analyzer: baseOptions.analyzer,
      snapshot: baseOptions.snapshot,
      file: baseOptions.files[0],
    });
  });

  it('preserves partial per-file results without changing identity bindings', async () => {
    const records = await analyzeSidecarRequestToEnrichmentRecords(request, {
      ...baseOptions,
      files: [
        { filePath: 'src/a.ts', fileHash: 'hash-a' },
        { filePath: 'src/b.ts', fileHash: 'hash-b' },
      ],
      analyze: vi
        .fn()
        .mockResolvedValueOnce({ records: [{ kind: 'ok' }] })
        .mockResolvedValueOnce({
          status: 'partial',
          records: [{ kind: 'partial-fact' }],
          failureReason: 'unresolved imports',
        }),
    });

    expect(records).toMatchObject([
      {
        filePath: 'src/a.ts',
        fileHash: 'hash-a',
        status: 'complete',
        records: [{ kind: 'ok' }],
      },
      {
        filePath: 'src/b.ts',
        fileHash: 'hash-b',
        status: 'partial',
        records: [{ kind: 'partial-fact' }],
        failureReason: 'unresolved imports',
      },
    ]);
  });

  it('turns analyzer failures into failed records with failure reasons', async () => {
    const records = await analyzeSidecarRequestToEnrichmentRecords(request, {
      ...baseOptions,
      analyze: vi.fn(async () => {
        throw new Error('fixture analyzer crashed');
      }),
    });

    expect(records).toMatchObject([
      {
        filePath: 'src/app.ts',
        fileHash: 'hash-app',
        status: 'failed',
        records: [],
        failureReason: 'fixture analyzer crashed',
      },
    ]);
  });

  it('defaults explicit failed analyzer results to a stable failure reason', async () => {
    const records = await analyzeSidecarRequestToEnrichmentRecords(request, {
      ...baseOptions,
      analyze: vi.fn(async () => ({ status: 'failed' })),
    });

    expect(records).toMatchObject([
      {
        status: 'failed',
        failureReason: 'sidecar analyzer reported file failure',
      },
    ]);
  });

  it('rejects requests for a different analyzer identity', async () => {
    const otherRequest = createSidecarRequest({
      ...request,
      analyzerId: 'other-analyzer',
    });

    await expect(
      analyzeSidecarRequestToEnrichmentRecords(otherRequest, baseOptions),
    ).rejects.toThrow(
      'sidecar analyzer id mismatch: request=other-analyzer adapter=local-lightweight',
    );
  });

  it('returns complete execution for empty scopes without invoking the analyzer', async () => {
    const analyze = vi.fn();
    const upsertEnrichment = vi.fn();
    const executeRequest = createSidecarAnalyzerExecutor({
      ...baseOptions,
      files: [],
      analyze,
      upsertEnrichment,
    });

    await expect(
      analyzeSidecarRequestToEnrichmentRecords(request, {
        ...baseOptions,
        files: [],
        analyze,
      }),
    ).resolves.toEqual([]);
    await expect(executeRequest(request, { heartbeat: vi.fn() })).resolves.toEqual({
      status: 'complete',
    });
    expect(analyze).not.toHaveBeenCalled();
    expect(upsertEnrichment).not.toHaveBeenCalled();
  });

  it('upserts records and reports partial execution when any file is partial or failed', async () => {
    const upsertEnrichment = vi.fn();
    const adapter = new LocalSidecarAnalyzerAdapter({
      ...baseOptions,
      files: [
        { filePath: 'src/a.ts', fileHash: 'hash-a' },
        { filePath: 'src/b.ts', fileHash: 'hash-b' },
      ],
      analyze: vi
        .fn()
        .mockResolvedValueOnce([{ kind: 'ok' }])
        .mockRejectedValueOnce(new Error('cannot parse file')),
    });
    const executeRequest = adapter.createExecutor(upsertEnrichment);

    await expect(executeRequest(request, { heartbeat: vi.fn() })).resolves.toEqual({
      status: 'partial',
      failureReason: '1 file(s) failed during sidecar analysis',
    });
    expect(upsertEnrichment).toHaveBeenCalledTimes(2);
    expect(upsertEnrichment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filePath: 'src/b.ts',
        fileHash: 'hash-b',
        status: 'failed',
        failureReason: 'cannot parse file',
      }),
    );
  });
});
