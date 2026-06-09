import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { MarkdownSidecarSnapshotManifest } from './docs-contracts.js';
import {
  createEnrichmentRecord,
  type EnrichmentFact,
  type EnrichmentRecord,
  type EnrichmentRecordInput,
} from './enrichment-record.js';
import type { SidecarLockRecord } from './sidecar-lock.js';
import {
  createSidecarRequest,
  SidecarRequestPool,
  type SidecarEnrichmentRequest,
  type SidecarRequestInput,
  type SubmitSidecarRequestResult,
} from './sidecar-request-pool.js';

export const SIDECAR_STORE_SCHEMA_VERSION = 2;
/** Schema versions that can be safely migrated to the current version. */
const SIDECAR_STORE_MIGRATION_VERSIONS = new Set([1]);
export const SIDECAR_STORE_RELATIVE_PATH = path.join('enrichment', 'sidecar-store.json');

export interface SidecarStoreState {
  schemaVersion: typeof SIDECAR_STORE_SCHEMA_VERSION;
  requests: SidecarEnrichmentRequest[];
  lock: SidecarLockRecord | null;
  enrichments: EnrichmentRecord[];
  manifest: MarkdownSidecarSnapshotManifest | null;
}

export interface SidecarStoreUpdateOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  staleLockMs?: number;
  ownerId?: string;
}

interface PersistedSidecarStoreState {
  schemaVersion?: unknown;
  requests?: unknown;
  lock?: unknown;
  enrichments?: unknown;
  manifest?: unknown;
}

interface SidecarStoreUpdateLockRecord {
  ownerId: string;
  pid: number;
  acquiredAt: string;
  stateFilePath: string;
}

const DEFAULT_UPDATE_LOCK_MAX_ATTEMPTS = 25;
const DEFAULT_UPDATE_LOCK_RETRY_DELAY_MS = 10;
const DEFAULT_UPDATE_LOCK_STALE_MS = 30_000;

export class LocalSidecarStore {
  constructor(private readonly stateFilePath: string) {}

  async load(): Promise<SidecarStoreState> {
    return loadSidecarStoreState(this.stateFilePath);
  }

  async save(state: SidecarStoreState): Promise<void> {
    await saveSidecarStoreState(this.stateFilePath, state);
  }

  async update<T>(
    mutator: (state: SidecarStoreState) => T | Promise<T>,
    options: SidecarStoreUpdateOptions = {},
  ): Promise<T> {
    return withSidecarStoreUpdateLock(this.stateFilePath, options, async () => {
      const state = await this.load();
      const result = await mutator(state);
      await this.save(state);
      return result;
    });
  }

  async submitRequest(input: SidecarRequestInput): Promise<SubmitSidecarRequestResult> {
    return this.update((state) => submitSidecarStoreRequest(state, input));
  }

  async upsertEnrichment(record: EnrichmentRecordInput): Promise<EnrichmentRecord> {
    return this.update((state) => upsertSidecarStoreEnrichment(state, record));
  }

  async setLock(lock: SidecarLockRecord | null): Promise<void> {
    await this.update((state) => {
      state.lock = lock === null ? null : normalizePersistedLock(lock, 'lock');
    });
  }

  async setManifest(manifest: MarkdownSidecarSnapshotManifest | null): Promise<void> {
    await this.update((state) => {
      state.manifest = manifest;
    });
  }
}

export async function loadSidecarStoreState(stateFilePath: string): Promise<SidecarStoreState> {
  let raw: string;
  try {
    raw = await fs.readFile(stateFilePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return createEmptySidecarStoreState();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`sidecar store state is not valid JSON: ${(error as Error).message}`);
  }

  return normalizeSidecarStoreState(parsed);
}

export async function saveSidecarStoreState(
  stateFilePath: string,
  state: SidecarStoreState,
): Promise<void> {
  const normalized = normalizeSidecarStoreState(state);
  const directory = path.dirname(stateFilePath);
  await fs.mkdir(directory, { recursive: true });

  const tempPath = path.join(
    directory,
    `.${path.basename(stateFilePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;

  try {
    await fs.writeFile(tempPath, serialized, 'utf8');
    await fs.rename(tempPath, stateFilePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createEmptySidecarStoreState(): SidecarStoreState {
  return {
    schemaVersion: SIDECAR_STORE_SCHEMA_VERSION,
    requests: [],
    lock: null,
    enrichments: [],
    manifest: null,
  };
}

export function getSidecarStorePath(storagePath: string): string {
  return path.join(storagePath, SIDECAR_STORE_RELATIVE_PATH);
}

export function submitSidecarStoreRequest(
  state: SidecarStoreState,
  input: SidecarRequestInput,
): SubmitSidecarRequestResult {
  const pool = new SidecarRequestPool(state.requests);
  const result = pool.submit(input);
  state.requests = pool.list();
  return result;
}

export function upsertSidecarStoreEnrichment(
  state: SidecarStoreState,
  input: EnrichmentRecordInput,
): EnrichmentRecord {
  const record = createEnrichmentRecord(input);
  const key = createEnrichmentRecordKey(record);
  const next = state.enrichments.filter((existing) => createEnrichmentRecordKey(existing) !== key);
  next.push(record);
  state.enrichments = next;
  return record;
}

export function createEnrichmentRecordKey(
  record: Pick<EnrichmentRecord, 'sourceIndexId' | 'analyzerId' | 'analyzerVersion' | 'filePath'>,
): string {
  return [record.sourceIndexId, record.analyzerId, record.analyzerVersion, record.filePath]
    .map((part) => encodeURIComponent(requireNonEmptyString(part, 'enrichment key part')))
    .join(':');
}

async function withSidecarStoreUpdateLock<T>(
  stateFilePath: string,
  options: SidecarStoreUpdateOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const lockPath = getSidecarStoreUpdateLockPath(stateFilePath);
  const ownerId = options.ownerId ?? createUpdateLockOwnerId();
  const maxAttempts = options.maxAttempts ?? DEFAULT_UPDATE_LOCK_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_UPDATE_LOCK_RETRY_DELAY_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_UPDATE_LOCK_STALE_MS;

  await acquireSidecarStoreUpdateLock(lockPath, stateFilePath, ownerId, {
    maxAttempts,
    retryDelayMs,
    staleLockMs,
  });

  try {
    return await callback();
  } finally {
    await releaseSidecarStoreUpdateLock(lockPath, ownerId);
  }
}

function getSidecarStoreUpdateLockPath(stateFilePath: string): string {
  return path.join(path.dirname(stateFilePath), `.${path.basename(stateFilePath)}.update.lock`);
}

async function acquireSidecarStoreUpdateLock(
  lockPath: string,
  stateFilePath: string,
  ownerId: string,
  options: Required<
    Pick<SidecarStoreUpdateOptions, 'maxAttempts' | 'retryDelayMs' | 'staleLockMs'>
  >,
): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      await fs.writeFile(
        lockPath,
        `${JSON.stringify(createUpdateLockRecord(ownerId, stateFilePath), null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }

      await removeStaleSidecarStoreUpdateLock(lockPath, options.staleLockMs);
      if (attempt < options.maxAttempts && options.retryDelayMs > 0) {
        await delay(options.retryDelayMs);
      }
    }
  }

  throw new Error(`timed out acquiring sidecar store update lock: ${lockPath}`);
}

function createUpdateLockRecord(
  ownerId: string,
  stateFilePath: string,
): SidecarStoreUpdateLockRecord {
  return {
    ownerId,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    stateFilePath,
  };
}

function createUpdateLockOwnerId(): string {
  return `pid-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function removeStaleSidecarStoreUpdateLock(
  lockPath: string,
  staleLockMs: number,
): Promise<void> {
  const stat = await fs.stat(lockPath).catch((error) => {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat === null) return;

  if (Date.now() - stat.mtimeMs >= staleLockMs) {
    await fs.rm(lockPath, { force: true });
  }
}

async function releaseSidecarStoreUpdateLock(lockPath: string, ownerId: string): Promise<void> {
  const currentOwnerId = await readSidecarStoreUpdateLockOwner(lockPath);
  if (currentOwnerId === ownerId) {
    await fs.rm(lockPath, { force: true });
  }
}

async function readSidecarStoreUpdateLockOwner(lockPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SidecarStoreUpdateLockRecord>;
    return typeof parsed.ownerId === 'string' ? parsed.ownerId : null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSidecarStoreState(value: unknown): SidecarStoreState {
  const persisted = requireObject(value, 'sidecar store state') as PersistedSidecarStoreState;
  if (
    persisted.schemaVersion !== SIDECAR_STORE_SCHEMA_VERSION &&
    !SIDECAR_STORE_MIGRATION_VERSIONS.has(persisted.schemaVersion as number)
  ) {
    throw new Error(`sidecar store schemaVersion must be ${SIDECAR_STORE_SCHEMA_VERSION}`);
  }

  return {
    schemaVersion: SIDECAR_STORE_SCHEMA_VERSION,
    requests: requireArray(persisted.requests, 'requests').map((request, index) =>
      normalizePersistedRequest(request, `requests[${index}]`),
    ),
    lock: persisted.lock === null ? null : normalizePersistedLock(persisted.lock, 'lock'),
    enrichments: requireArray(persisted.enrichments, 'enrichments').map((record, index) =>
      normalizePersistedEnrichment(record, `enrichments[${index}]`),
    ),
    manifest:
      persisted.manifest === undefined || persisted.manifest === null
        ? null
        : normalizePersistedManifest(persisted.manifest),
  };
}

function normalizePersistedRequest(value: unknown, fieldName: string): SidecarEnrichmentRequest {
  const request = requireObject(value, fieldName) as Record<string, unknown>;
  const normalized = createSidecarRequest({
    id: requireOptionalString(request.id, `${fieldName}.id`),
    repoId: requireString(request.repoId, `${fieldName}.repoId`),
    sourceIndexId: requireString(request.sourceIndexId, `${fieldName}.sourceIndexId`),
    analyzerId: requireString(request.analyzerId, `${fieldName}.analyzerId`),
    analyzerVersion: requireString(request.analyzerVersion, `${fieldName}.analyzerVersion`),
    purpose: requireString(
      request.purpose,
      `${fieldName}.purpose`,
    ) as SidecarRequestInput['purpose'],
    scopeHash: requireString(request.scopeHash, `${fieldName}.scopeHash`),
    priority: requireString(
      request.priority,
      `${fieldName}.priority`,
    ) as SidecarRequestInput['priority'],
    requestedAt: requireString(request.requestedAt, `${fieldName}.requestedAt`),
    status: requireOptionalString(
      request.status,
      `${fieldName}.status`,
    ) as SidecarRequestInput['status'],
    expiresAt: requireOptionalString(request.expiresAt, `${fieldName}.expiresAt`),
    durability: requireOptionalString(
      request.durability,
      `${fieldName}.durability`,
    ) as SidecarRequestInput['durability'],
    sessionId: requireOptionalString(request.sessionId, `${fieldName}.sessionId`),
  });

  return {
    ...normalized,
    updatedAt: toIsoTimestamp(
      requireString(request.updatedAt, `${fieldName}.updatedAt`),
      `${fieldName}.updatedAt`,
    ),
    mergedRequestIds: requireArray(request.mergedRequestIds, `${fieldName}.mergedRequestIds`)
      .map((id, index) => requireString(id, `${fieldName}.mergedRequestIds[${index}]`))
      .sort(),
  };
}

function normalizePersistedLock(value: unknown, fieldName: string): SidecarLockRecord {
  const lock = requireObject(value, fieldName) as Record<string, unknown>;
  const pid = requireNumber(lock.pid, `${fieldName}.pid`);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`${fieldName}.pid must be a positive integer`);
  }

  return {
    ownerId: requireNonEmptyString(lock.ownerId, `${fieldName}.ownerId`),
    pid,
    startedAt: toIsoTimestamp(
      requireString(lock.startedAt, `${fieldName}.startedAt`),
      `${fieldName}.startedAt`,
    ),
    heartbeatAt: toIsoTimestamp(
      requireString(lock.heartbeatAt, `${fieldName}.heartbeatAt`),
      `${fieldName}.heartbeatAt`,
    ),
    sourceIndexId: requireNonEmptyString(lock.sourceIndexId, `${fieldName}.sourceIndexId`),
    analyzerId: requireNonEmptyString(lock.analyzerId, `${fieldName}.analyzerId`),
    leaseExpiresAt: toIsoTimestamp(
      requireString(lock.leaseExpiresAt, `${fieldName}.leaseExpiresAt`),
      `${fieldName}.leaseExpiresAt`,
    ),
  };
}

function normalizePersistedEnrichment(value: unknown, fieldName: string): EnrichmentRecord {
  const record = requireObject(value, fieldName) as Record<string, unknown>;
  return createEnrichmentRecord({
    sourceIndexId: requireString(record.sourceIndexId, `${fieldName}.sourceIndexId`),
    sourceCommitHash: requireString(record.sourceCommitHash, `${fieldName}.sourceCommitHash`),
    schemaVersion:
      record.schemaVersion === undefined
        ? undefined
        : requireNumber(record.schemaVersion, `${fieldName}.schemaVersion`),
    analyzerId: requireString(record.analyzerId, `${fieldName}.analyzerId`),
    analyzerVersion: requireString(record.analyzerVersion, `${fieldName}.analyzerVersion`),
    filePath: requireString(record.filePath, `${fieldName}.filePath`),
    fileHash: requireString(record.fileHash, `${fieldName}.fileHash`),
    status: requireString(record.status, `${fieldName}.status`) as EnrichmentRecordInput['status'],
    confidence:
      record.confidence === undefined
        ? undefined
        : requireNumber(record.confidence, `${fieldName}.confidence`),
    records: requireArray(record.records, `${fieldName}.records`).map((fact, index) =>
      normalizeEnrichmentFact(fact, `${fieldName}.records[${index}]`),
    ),
    failureReason: requireOptionalString(record.failureReason, `${fieldName}.failureReason`),
  });
}

function normalizeEnrichmentFact(value: unknown, fieldName: string): EnrichmentFact {
  const fact = requireObject(value, fieldName) as Record<string, unknown>;
  const kind = requireNonEmptyString(fact.kind, `${fieldName}.kind`);
  return { ...fact, kind };
}

function normalizePersistedManifest(value: unknown): MarkdownSidecarSnapshotManifest {
  const manifest = requireObject(value, 'manifest') as Record<string, unknown>;
  return {
    repoId: requireString(manifest.repoId, 'manifest.repoId'),
    repoPath: requireString(manifest.repoPath, 'manifest.repoPath'),
    sourceIndexId: requireString(manifest.sourceIndexId, 'manifest.sourceIndexId'),
    sourceCommitHash: requireString(manifest.sourceCommitHash, 'manifest.sourceCommitHash'),
    graphSchemaVersion: requireNumber(manifest.graphSchemaVersion, 'manifest.graphSchemaVersion'),
    analyzerId: requireString(
      manifest.analyzerId,
      'manifest.analyzerId',
    ) as MarkdownSidecarSnapshotManifest['analyzerId'],
    analyzerVersion: requireString(manifest.analyzerVersion, 'manifest.analyzerVersion'),
    files: requireArray(manifest.files, 'manifest.files').map((file, index) => {
      const f = requireObject(file, `manifest.files[${index}]`) as Record<string, unknown>;
      return {
        docPath: requireString(f.docPath, `manifest.files[${index}].docPath`),
        fileHash: requireString(f.fileHash, `manifest.files[${index}].fileHash`),
      };
    }),
  };
}

function requireObject(value: unknown, fieldName: string): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return value;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return value;
}

function requireOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, fieldName);
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  const stringValue = requireString(value, fieldName);
  if (stringValue.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return stringValue;
}

function requireNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return value;
}

function toIsoTimestamp(value: string, fieldName: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${fieldName} must be a valid timestamp`);
  }
  return date.toISOString();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
