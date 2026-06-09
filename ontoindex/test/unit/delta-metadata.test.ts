import { describe, expect, it } from 'vitest';
import {
  CURRENT_DELTA_METADATA_SCHEMA_VERSION,
  createFileAnalysisMetadata,
} from '../../src/core/ingestion/runtime/index.js';

const baseMetadata = {
  repoId: 'repo-1',
  repoRoot: '/repo',
  filePath: 'src/index.ts',
  fileHash: 'sha256:abc',
  language: 'typescript',
  parserVersion: 'tree-sitter-typescript@1',
  providerVersion: 'ontoindex-ts-provider@1',
  lastSuccessfulPhase: 'parse' as const,
  status: 'success' as const,
};

describe('delta metadata contract', () => {
  it('creates schema-versioned file analysis metadata', () => {
    const metadata = createFileAnalysisMetadata({
      ...baseMetadata,
      analyzedAt: '2026-05-13T00:00:00.000Z',
    });

    expect(metadata).toEqual({
      ...baseMetadata,
      schemaVersion: CURRENT_DELTA_METADATA_SCHEMA_VERSION,
      analyzedAt: '2026-05-13T00:00:00.000Z',
    });
  });

  it('preserves optional embedding and chunk strategy metadata', () => {
    const metadata = createFileAnalysisMetadata({
      ...baseMetadata,
      embeddingModel: 'text-embedding-3-small',
      chunkStrategy: 'tree-sitter:function',
    });

    expect(metadata.embeddingModel).toBe('text-embedding-3-small');
    expect(metadata.chunkStrategy).toBe('tree-sitter:function');
  });

  it('rejects empty required identity fields', () => {
    expect(() =>
      createFileAnalysisMetadata({
        ...baseMetadata,
        fileHash: '   ',
      }),
    ).toThrow('File analysis metadata requires fileHash');
  });

  it('requires failureReason for failed files', () => {
    expect(() =>
      createFileAnalysisMetadata({
        ...baseMetadata,
        status: 'failed',
      }),
    ).toThrow('File analysis metadata requires failureReason when status is failed');
  });
});
