import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_DELTA_METADATA_SCHEMA_VERSION,
  createFileAnalysisMetadata,
  getDeltaMetadataStorePath,
  loadDeltaMetadataStore,
  saveDeltaMetadataStore,
  upsertFileAnalysisMetadata,
} from '../../src/core/ingestion/runtime/index.js';

const tmpDirs: string[] = [];

const baseMetadata = createFileAnalysisMetadata({
  repoId: 'repo-1',
  repoRoot: '/repo',
  filePath: 'src/index.ts',
  fileHash: 'sha256:abc',
  language: 'typescript',
  parserVersion: 'tree-sitter-typescript@1',
  providerVersion: 'ontoindex-ts-provider@1',
  lastSuccessfulPhase: 'parse',
  status: 'success',
  analyzedAt: '2026-05-13T00:00:00.000Z',
});

describe('delta metadata store', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('returns null when no metadata store exists', async () => {
    const storagePath = await createTempStoragePath();

    await expect(loadDeltaMetadataStore(storagePath)).resolves.toBeNull();
  });

  it('saves and loads file metadata', async () => {
    const storagePath = await createTempStoragePath();

    await saveDeltaMetadataStore(storagePath, {
      schemaVersion: CURRENT_DELTA_METADATA_SCHEMA_VERSION,
      updatedAt: '2026-05-13T00:01:00.000Z',
      files: {
        [baseMetadata.filePath]: baseMetadata,
      },
    });

    await expect(loadDeltaMetadataStore(storagePath)).resolves.toEqual({
      schemaVersion: CURRENT_DELTA_METADATA_SCHEMA_VERSION,
      updatedAt: '2026-05-13T00:01:00.000Z',
      files: {
        [baseMetadata.filePath]: baseMetadata,
      },
    });
  });

  it('upserts file metadata by file path', async () => {
    const storagePath = await createTempStoragePath();
    const replacement = {
      ...baseMetadata,
      fileHash: 'sha256:def',
      lastSuccessfulPhase: 'persist' as const,
      analyzedAt: '2026-05-13T00:02:00.000Z',
    };

    await upsertFileAnalysisMetadata(storagePath, baseMetadata, '2026-05-13T00:01:00.000Z');
    const store = await upsertFileAnalysisMetadata(
      storagePath,
      replacement,
      '2026-05-13T00:03:00.000Z',
    );

    expect(store.updatedAt).toBe('2026-05-13T00:03:00.000Z');
    expect(Object.keys(store.files)).toEqual(['src/index.ts']);
    expect(store.files['src/index.ts']).toEqual(replacement);
    await expect(loadDeltaMetadataStore(storagePath)).resolves.toEqual(store);
  });

  it('rejects incompatible store schema versions', async () => {
    const storagePath = await createTempStoragePath();
    await fs.mkdir(storagePath, { recursive: true });
    await fs.writeFile(
      getDeltaMetadataStorePath(storagePath),
      JSON.stringify({
        schemaVersion: 999,
        updatedAt: '2026-05-13T00:01:00.000Z',
        files: {},
      }),
      'utf8',
    );

    await expect(loadDeltaMetadataStore(storagePath)).rejects.toThrow(
      'Unsupported delta metadata schema version: 999',
    );
  });
});

async function createTempStoragePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-delta-metadata-'));
  tmpDirs.push(dir);
  return dir;
}
