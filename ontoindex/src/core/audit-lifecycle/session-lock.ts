import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { LocalAuditEventStore } from './audit-event-store.js';
import { buildAuditProjection } from './audit-projection.js';
import {
  requireNonEmptyString,
  toIsoTimestamp,
  type AuditSession,
  type AuditSessionSnapshot,
  type AuditSnapshotMode,
} from './audit-session.js';

export const AUDIT_SESSION_LOCK_SCHEMA_VERSION = 1;
export const AUDIT_SESSION_LOCKS_RELATIVE_DIR = path.join('.ontoindex', 'audit', 'session-locks');

export interface AuditSessionLockTombstoneInput {
  id: string;
  tombstonedAt?: string;
  reason?: string;
  invariantId?: string;
}

export interface AuditSessionLockTombstoneSnapshot {
  count: number;
  ids: string[];
  hash: string;
  latestTombstonedAt?: string;
}

export interface AuditSessionLockInput {
  sessionId: string;
  targetRepo: string;
  targetHead: string;
  graphIndexId: string;
  graphHash?: string;
  ontoindexVersion: string;
  snapshotMode?: AuditSnapshotMode;
  changedFiles?: readonly string[];
  changedSymbols?: readonly string[];
  staleWarnings?: readonly string[];
  snapshot?: AuditSessionSnapshot;
  tombstoneIds?: readonly string[];
  tombstoneSnapshot?: AuditSessionLockTombstoneSnapshot;
  createdAt?: string;
}

export interface AuditSessionLock {
  schemaVersion: typeof AUDIT_SESSION_LOCK_SCHEMA_VERSION;
  sessionId: string;
  targetRepo: string;
  targetHead: string;
  graphIndexId: string;
  graphHash: string;
  ontoindexVersion: string;
  snapshotMode?: AuditSnapshotMode;
  changedFiles?: string[];
  changedSymbols?: string[];
  staleWarnings?: string[];
  snapshot?: AuditSessionSnapshot;
  tombstoneIds: string[];
  tombstoneSnapshot: AuditSessionLockTombstoneSnapshot;
  createdAt: string;
}

export interface CreateAuditSessionLockFromStoreOptions {
  repoRoot: string;
  sessionId: string;
  ontoindexVersion: string;
  graphHash?: string;
  createdAt?: string;
  tombstones?: readonly AuditSessionLockTombstoneInput[];
  store?: LocalAuditEventStore;
}

export interface AuditSessionLockCurrentState {
  targetHead: string;
  graphIndexId: string;
  graphHash?: string;
}

export type AuditSessionLockStaleField = 'targetHead' | 'graphIndexId' | 'graphHash';

export interface AuditSessionLockStaleFieldChange {
  field: AuditSessionLockStaleField;
  locked: string;
  current: string;
}

export interface ValidAuditSessionLockResult {
  ok: true;
  status: 'VALID_SESSION';
  sessionId: string;
  lock: AuditSessionLock;
}

export interface StaleAuditSessionLockResult {
  ok: false;
  status: 'STALE_SESSION';
  code: 'STALE_SESSION';
  sessionId: string;
  message: string;
  lock: AuditSessionLock;
  current: AuditSessionLockCurrentState;
  staleFields: AuditSessionLockStaleFieldChange[];
}

export type AuditSessionLockValidationResult =
  | ValidAuditSessionLockResult
  | StaleAuditSessionLockResult;

export function getAuditSessionLockPath(repoRoot: string, sessionId: string): string {
  return path.join(
    repoRoot,
    AUDIT_SESSION_LOCKS_RELATIVE_DIR,
    `${requireNonEmptyString(sessionId, 'sessionId')}.json`,
  );
}

export function createAuditSessionLock(input: AuditSessionLockInput): AuditSessionLock {
  const tombstoneIds = normalizeStringArray(input.tombstoneIds ?? [], 'lock.tombstoneIds');
  const tombstoneSnapshot = normalizeTombstoneSnapshot(
    input.tombstoneSnapshot ??
      createAuditSessionTombstoneSnapshot(tombstoneIds.map((id) => ({ id }))),
  );
  if (tombstoneIds.join('\0') !== tombstoneSnapshot.ids.join('\0')) {
    throw new Error('lock.tombstoneIds must match lock.tombstoneSnapshot.ids');
  }
  const snapshot = normalizeSessionSnapshot(input);

  return {
    schemaVersion: AUDIT_SESSION_LOCK_SCHEMA_VERSION,
    sessionId: requireNonEmptyString(input.sessionId, 'lock.sessionId'),
    targetRepo: requireNonEmptyString(input.targetRepo, 'lock.targetRepo'),
    targetHead: requireNonEmptyString(input.targetHead, 'lock.targetHead'),
    graphIndexId: requireNonEmptyString(input.graphIndexId, 'lock.graphIndexId'),
    graphHash: requireNonEmptyString(input.graphHash ?? input.graphIndexId, 'lock.graphHash'),
    ontoindexVersion: requireNonEmptyString(input.ontoindexVersion, 'lock.ontoindexVersion'),
    ...(snapshot !== undefined
      ? {
          snapshotMode: snapshot.mode,
          changedFiles: [...snapshot.changedFiles],
          changedSymbols: [...snapshot.changedSymbols],
          staleWarnings: [...snapshot.staleWarnings],
          snapshot,
        }
      : {}),
    tombstoneIds,
    tombstoneSnapshot,
    createdAt: toIsoTimestamp(input.createdAt ?? new Date().toISOString(), 'lock.createdAt'),
  };
}

export async function createAuditSessionLockFromStore(
  options: CreateAuditSessionLockFromStoreOptions,
): Promise<AuditSessionLock> {
  const store = options.store ?? new LocalAuditEventStore(options.repoRoot);
  const state = await store.load();
  const projection = buildAuditProjection(state.events, options.createdAt);
  const session = projection.sessions.find((candidate) => candidate.id === options.sessionId);
  if (session === undefined) {
    throw new Error(`audit session does not exist: ${options.sessionId}`);
  }

  const tombstones =
    options.tombstones ?? collectSessionTombstoneInputs(projection.findings, session.id);
  const tombstoneSnapshot = createAuditSessionTombstoneSnapshot(tombstones);
  const lock = createAuditSessionLock({
    sessionId: session.id,
    targetRepo: session.targetRepo,
    targetHead: session.targetHead,
    graphIndexId: session.graphIndexId,
    graphHash: options.graphHash ?? session.sidecarStateHash,
    ontoindexVersion: options.ontoindexVersion,
    ...sessionSnapshotInput(session),
    tombstoneIds: tombstoneSnapshot.ids,
    tombstoneSnapshot,
    createdAt: options.createdAt ?? session.createdAt,
  });
  await saveAuditSessionLock(options.repoRoot, lock);
  return lock;
}

export async function saveAuditSessionLock(
  repoRoot: string,
  lock: AuditSessionLockInput,
): Promise<AuditSessionLock> {
  const normalized = createAuditSessionLock(lock);
  await atomicWriteJson(getAuditSessionLockPath(repoRoot, normalized.sessionId), normalized);
  return normalized;
}

export async function loadAuditSessionLock(
  repoRoot: string,
  sessionId: string,
): Promise<AuditSessionLock> {
  const filePath = getAuditSessionLockPath(repoRoot, sessionId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`audit session lock is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  return normalizeAuditSessionLock(parsed);
}

export function validateAuditSessionLock(
  lockInput: AuditSessionLockInput,
  currentInput: AuditSessionLockCurrentState,
): AuditSessionLockValidationResult {
  const lock = createAuditSessionLock(lockInput);
  const current = normalizeCurrentState(currentInput);
  const staleFields: AuditSessionLockStaleFieldChange[] = [];

  addStaleField(staleFields, 'targetHead', lock.targetHead, current.targetHead);
  addStaleField(staleFields, 'graphIndexId', lock.graphIndexId, current.graphIndexId);
  addStaleField(staleFields, 'graphHash', lock.graphHash, current.graphHash);

  if (staleFields.length === 0) {
    return {
      ok: true,
      status: 'VALID_SESSION',
      sessionId: lock.sessionId,
      lock,
    };
  }

  return {
    ok: false,
    status: 'STALE_SESSION',
    code: 'STALE_SESSION',
    sessionId: lock.sessionId,
    message: `audit session is stale: ${staleFields.map((field) => field.field).join(', ')}`,
    lock,
    current,
    staleFields,
  };
}

export async function loadAndValidateAuditSessionLock(
  repoRoot: string,
  sessionId: string,
  current: AuditSessionLockCurrentState,
): Promise<AuditSessionLockValidationResult> {
  return validateAuditSessionLock(await loadAuditSessionLock(repoRoot, sessionId), current);
}

export function createAuditSessionTombstoneSnapshot(
  tombstones: readonly AuditSessionLockTombstoneInput[],
): AuditSessionLockTombstoneSnapshot {
  const normalized = tombstones
    .map((tombstone) => ({
      id: requireNonEmptyString(tombstone.id, 'tombstone.id'),
      ...(tombstone.tombstonedAt !== undefined
        ? { tombstonedAt: toIsoTimestamp(tombstone.tombstonedAt, 'tombstone.tombstonedAt') }
        : {}),
      ...(tombstone.reason !== undefined
        ? { reason: requireNonEmptyString(tombstone.reason, 'tombstone.reason') }
        : {}),
      ...(tombstone.invariantId !== undefined
        ? { invariantId: requireNonEmptyString(tombstone.invariantId, 'tombstone.invariantId') }
        : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = normalized.map((tombstone) => tombstone.id);
  const latestTombstonedAt = normalized
    .map((tombstone) => tombstone.tombstonedAt)
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);

  return {
    count: normalized.length,
    ids,
    hash: `sha256:${sha256(JSON.stringify(normalized))}`,
    ...(latestTombstonedAt !== undefined ? { latestTombstonedAt } : {}),
  };
}

function normalizeAuditSessionLock(value: unknown): AuditSessionLock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('audit session lock must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== AUDIT_SESSION_LOCK_SCHEMA_VERSION) {
    throw new Error(
      `unsupported audit session lock schemaVersion: ${String(record.schemaVersion)}`,
    );
  }
  return createAuditSessionLock({
    sessionId: requireRecordString(record, 'sessionId', 'lock.sessionId'),
    targetRepo: requireRecordString(record, 'targetRepo', 'lock.targetRepo'),
    targetHead: requireRecordString(record, 'targetHead', 'lock.targetHead'),
    graphIndexId: requireRecordString(record, 'graphIndexId', 'lock.graphIndexId'),
    graphHash: requireRecordString(record, 'graphHash', 'lock.graphHash'),
    ontoindexVersion: requireRecordString(record, 'ontoindexVersion', 'lock.ontoindexVersion'),
    ...recordSnapshotInput(record),
    tombstoneIds: normalizeUnknownStringArray(record.tombstoneIds, 'lock.tombstoneIds'),
    tombstoneSnapshot: normalizeTombstoneSnapshot(record.tombstoneSnapshot),
    createdAt: requireRecordString(record, 'createdAt', 'lock.createdAt'),
  });
}

function normalizeTombstoneSnapshot(value: unknown): AuditSessionLockTombstoneSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('lock.tombstoneSnapshot must be an object');
  }
  const record = value as Record<string, unknown>;
  const count = record.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new Error('lock.tombstoneSnapshot.count must be a non-negative integer');
  }
  return {
    count,
    ids: normalizeUnknownStringArray(record.ids, 'lock.tombstoneSnapshot.ids'),
    hash: requireRecordString(record, 'hash', 'lock.tombstoneSnapshot.hash'),
    ...(record.latestTombstonedAt !== undefined
      ? {
          latestTombstonedAt: toIsoTimestamp(
            requireRecordString(
              record,
              'latestTombstonedAt',
              'lock.tombstoneSnapshot.latestTombstonedAt',
            ),
            'lock.tombstoneSnapshot.latestTombstonedAt',
          ),
        }
      : {}),
  };
}

function normalizeCurrentState(
  current: AuditSessionLockCurrentState,
): AuditSessionLockCurrentState {
  return {
    targetHead: requireNonEmptyString(current.targetHead, 'current.targetHead'),
    graphIndexId: requireNonEmptyString(current.graphIndexId, 'current.graphIndexId'),
    ...(current.graphHash !== undefined
      ? { graphHash: requireNonEmptyString(current.graphHash, 'current.graphHash') }
      : {}),
  };
}

function sessionSnapshotInput(session: AuditSession): Partial<AuditSessionLockInput> {
  if (session.snapshot !== undefined) return { snapshot: session.snapshot };
  if (session.snapshotMode !== undefined) {
    return {
      snapshotMode: session.snapshotMode,
      changedFiles: session.changedFiles ?? [],
      changedSymbols: session.changedSymbols ?? [],
      staleWarnings: session.staleWarnings ?? [],
    };
  }
  return {};
}

function recordSnapshotInput(record: Record<string, unknown>): Partial<AuditSessionLockInput> {
  if (
    record.snapshot === undefined &&
    record.snapshotMode === undefined &&
    record.changedFiles === undefined &&
    record.changedSymbols === undefined &&
    record.staleWarnings === undefined
  ) {
    return {};
  }
  if (record.snapshot !== undefined) {
    return { snapshot: normalizeSnapshotObject(record.snapshot, 'lock.snapshot') };
  }
  return {
    snapshotMode: normalizeSnapshotMode(
      record.snapshotMode ?? 'committed-head',
      'lock.snapshotMode',
    ),
    changedFiles: normalizeUnknownStringArray(record.changedFiles ?? [], 'lock.changedFiles'),
    changedSymbols: normalizeUnknownStringArray(record.changedSymbols ?? [], 'lock.changedSymbols'),
    staleWarnings: normalizeUnknownStringArray(record.staleWarnings ?? [], 'lock.staleWarnings'),
  };
}

function normalizeSessionSnapshot(input: AuditSessionLockInput): AuditSessionSnapshot | undefined {
  if (input.snapshot !== undefined) {
    return normalizeSnapshotObject(input.snapshot, 'lock.snapshot');
  }
  if (
    input.snapshotMode === undefined &&
    input.changedFiles === undefined &&
    input.changedSymbols === undefined &&
    input.staleWarnings === undefined
  ) {
    return undefined;
  }
  return {
    mode: normalizeSnapshotMode(input.snapshotMode ?? 'committed-head', 'lock.snapshotMode'),
    targetHead: requireNonEmptyString(input.targetHead, 'lock.targetHead'),
    graphIndexId: requireNonEmptyString(input.graphIndexId, 'lock.graphIndexId'),
    changedFiles: normalizeStringArray(input.changedFiles ?? [], 'lock.changedFiles'),
    changedSymbols: normalizeStringArray(input.changedSymbols ?? [], 'lock.changedSymbols'),
    staleWarnings: normalizeStringArray(input.staleWarnings ?? [], 'lock.staleWarnings'),
  };
}

function normalizeSnapshotObject(value: unknown, fieldName: string): AuditSessionSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const record = value as Record<string, unknown>;
  return {
    mode: normalizeSnapshotMode(record.mode, `${fieldName}.mode`),
    targetHead: requireRecordString(record, 'targetHead', `${fieldName}.targetHead`),
    graphIndexId: requireRecordString(record, 'graphIndexId', `${fieldName}.graphIndexId`),
    changedFiles: normalizeUnknownStringArray(record.changedFiles, `${fieldName}.changedFiles`),
    changedSymbols: normalizeUnknownStringArray(
      record.changedSymbols,
      `${fieldName}.changedSymbols`,
    ),
    staleWarnings: normalizeUnknownStringArray(record.staleWarnings, `${fieldName}.staleWarnings`),
  };
}

function normalizeSnapshotMode(value: unknown, fieldName: string): AuditSnapshotMode {
  if (value !== 'committed-head' && value !== 'dirty-worktree-overlay' && value !== 'diff-ref') {
    throw new Error(`${fieldName} has unsupported value: ${String(value)}`);
  }
  return value;
}

function collectSessionTombstoneInputs(
  findings: ReadonlyArray<{
    id: string;
    sessionId: string;
    tombstone?: { tombstonedAt: string; reason: string; invariantId?: string };
  }>,
  sessionId: string,
): AuditSessionLockTombstoneInput[] {
  return findings
    .filter((finding) => finding.sessionId === sessionId && finding.tombstone !== undefined)
    .map((finding) => ({
      id: finding.id,
      tombstonedAt: finding.tombstone?.tombstonedAt,
      reason: finding.tombstone?.reason,
      invariantId: finding.tombstone?.invariantId,
    }));
}

function addStaleField(
  staleFields: AuditSessionLockStaleFieldChange[],
  field: AuditSessionLockStaleField,
  locked: string,
  current: string | undefined,
): void {
  if (current !== undefined && locked !== current) {
    staleFields.push({ field, locked, current });
  }
}

function normalizeStringArray(values: readonly string[], fieldName: string): string[] {
  return [...new Set(values.map((value) => requireNonEmptyString(value, `${fieldName}[]`)))].sort();
}

function normalizeUnknownStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return normalizeStringArray(
    value.map((item) => {
      if (typeof item !== 'string') {
        throw new Error(`${fieldName}[] must be a string`);
      }
      return item;
    }),
    fieldName,
  );
}

function requireRecordString(
  record: Record<string, unknown>,
  key: string,
  fieldName: string,
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return requireNonEmptyString(value, fieldName);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
