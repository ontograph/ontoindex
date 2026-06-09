import { describe, expect, it } from 'vitest';
import {
  createFileAnalysisMetadata,
  summarizeDeltaCompleteness,
  type DeltaMetadataStore,
} from '../../src/core/ingestion/runtime/index.js';

const baseMetadata = {
  repoId: 'repo-1',
  repoRoot: '/repo',
  fileHash: 'sha256:abc',
  language: 'typescript',
  parserVersion: 'tree-sitter-typescript@1',
  providerVersion: 'ontoindex-ts-provider@1',
  lastSuccessfulPhase: 'parse' as const,
};

describe('delta completeness summary', () => {
  it('summarizes successful metadata as complete when expected files are present', () => {
    const store = storeWith([
      metadata('src/a.ts', 'success', '2026-05-13T00:00:00.000Z'),
      metadata('src/b.ts', 'skipped', '2026-05-13T00:01:00.000Z'),
    ]);

    expect(summarizeDeltaCompleteness(store, ['src/a.ts', 'src/b.ts'])).toEqual({
      complete: true,
      totalFiles: 2,
      successfulFiles: 1,
      failedFiles: 0,
      pendingFiles: 0,
      skippedFiles: 1,
      missingFiles: 0,
      incompleteFiles: 0,
      failedFilePaths: [],
      missingFilePaths: [],
      lastAnalyzedAt: '2026-05-13T00:01:00.000Z',
    });
  });

  it('reports failed, pending, and missing files without changing store state', () => {
    const store = storeWith([
      metadata('src/a.ts', 'success', '2026-05-13T00:00:00.000Z'),
      metadata('src/b.ts', 'failed', '2026-05-13T00:01:00.000Z', 'parse failed'),
      metadata('src/c.ts', 'pending', '2026-05-13T00:02:00.000Z'),
    ]);

    const summary = summarizeDeltaCompleteness(store, [
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/missing.ts',
    ]);

    expect(summary).toMatchObject({
      complete: false,
      totalFiles: 4,
      successfulFiles: 1,
      failedFiles: 1,
      pendingFiles: 1,
      missingFiles: 1,
      incompleteFiles: 3,
      failedFilePaths: ['src/b.ts'],
      missingFilePaths: ['src/missing.ts'],
      lastAnalyzedAt: '2026-05-13T00:02:00.000Z',
    });
    expect(Object.keys(store.files)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('treats a missing store as incomplete when expected files are known', () => {
    expect(summarizeDeltaCompleteness(null, ['src/a.ts'])).toMatchObject({
      complete: false,
      totalFiles: 1,
      missingFiles: 1,
      incompleteFiles: 1,
      missingFilePaths: ['src/a.ts'],
      lastAnalyzedAt: null,
    });
  });
});

function metadata(
  filePath: string,
  status: 'pending' | 'success' | 'failed' | 'skipped',
  analyzedAt: string,
  failureReason?: string,
) {
  return createFileAnalysisMetadata({
    ...baseMetadata,
    filePath,
    status,
    analyzedAt,
    failureReason,
  });
}

function storeWith(files: ReturnType<typeof metadata>[]): DeltaMetadataStore {
  return {
    schemaVersion: 1,
    updatedAt: '2026-05-13T00:03:00.000Z',
    files: Object.fromEntries(files.map((file) => [file.filePath, file])),
  };
}
