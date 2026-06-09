import fs from 'fs/promises';
import path from 'path';
import {
  CURRENT_DELTA_METADATA_SCHEMA_VERSION,
  type FileAnalysisMetadata,
} from './delta-metadata.js';

export const DELTA_METADATA_STORE_FILE = 'delta-metadata.json';

export interface DeltaMetadataStore {
  schemaVersion: number;
  updatedAt: string;
  files: Record<string, FileAnalysisMetadata>;
}

export function createEmptyDeltaMetadataStore(
  updatedAt = new Date().toISOString(),
): DeltaMetadataStore {
  return {
    schemaVersion: CURRENT_DELTA_METADATA_SCHEMA_VERSION,
    updatedAt,
    files: {},
  };
}

export async function loadDeltaMetadataStore(
  storagePath: string,
): Promise<DeltaMetadataStore | null> {
  const storePath = getDeltaMetadataStorePath(storagePath);

  let raw: string;
  try {
    raw = await fs.readFile(storePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  return parseDeltaMetadataStore(JSON.parse(raw));
}

export async function saveDeltaMetadataStore(
  storagePath: string,
  store: DeltaMetadataStore,
): Promise<void> {
  parseDeltaMetadataStore(store);

  await fs.mkdir(storagePath, { recursive: true });

  const storePath = getDeltaMetadataStorePath(storagePath);
  const tempPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(store, null, 2)}\n`;

  await fs.writeFile(tempPath, payload, 'utf8');
  await fs.rename(tempPath, storePath);
}

export async function upsertFileAnalysisMetadata(
  storagePath: string,
  metadata: FileAnalysisMetadata,
  updatedAt = new Date().toISOString(),
): Promise<DeltaMetadataStore> {
  const store =
    (await loadDeltaMetadataStore(storagePath)) ?? createEmptyDeltaMetadataStore(updatedAt);

  if (metadata.schemaVersion !== CURRENT_DELTA_METADATA_SCHEMA_VERSION) {
    throw new Error(`Unsupported file analysis metadata schema version: ${metadata.schemaVersion}`);
  }

  store.updatedAt = updatedAt;
  store.files[metadata.filePath] = metadata;
  await saveDeltaMetadataStore(storagePath, store);
  return store;
}

export function getDeltaMetadataStorePath(storagePath: string): string {
  return path.join(storagePath, DELTA_METADATA_STORE_FILE);
}

function parseDeltaMetadataStore(value: unknown): DeltaMetadataStore {
  if (!isRecord(value)) {
    throw new Error('Delta metadata store must be an object');
  }

  if (value.schemaVersion !== CURRENT_DELTA_METADATA_SCHEMA_VERSION) {
    throw new Error(`Unsupported delta metadata schema version: ${String(value.schemaVersion)}`);
  }

  if (typeof value.updatedAt !== 'string' || value.updatedAt.trim().length === 0) {
    throw new Error('Delta metadata store requires updatedAt');
  }

  if (!isRecord(value.files)) {
    throw new Error('Delta metadata store requires files');
  }

  for (const [filePath, metadata] of Object.entries(value.files)) {
    if (!isRecord(metadata)) {
      throw new Error(`Delta metadata for ${filePath} must be an object`);
    }
    if (metadata.schemaVersion !== CURRENT_DELTA_METADATA_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported file analysis metadata schema version for ${filePath}: ${String(
          metadata.schemaVersion,
        )}`,
      );
    }
    if (metadata.filePath !== filePath) {
      throw new Error(`Delta metadata key does not match filePath for ${filePath}`);
    }
  }

  return value as unknown as DeltaMetadataStore;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
