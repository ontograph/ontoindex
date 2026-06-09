import { promises as fs } from 'node:fs';
import path from 'node:path';

import { buildAuditProjection } from './audit-projection.js';
import {
  createAuditFinding,
  createAuditSession,
  normalizeAuditFindingStatus,
  normalizeMetadata,
  requireNonEmptyString,
  toIsoTimestamp,
  type AuditBundle,
  type AuditEvidence,
  type AuditFinding,
  type AuditFindingInput,
  type AuditFindingStatus,
  type AuditFindingTombstone,
  type AuditFindingVerification,
  type AuditSession,
  type AuditSessionInput,
} from './audit-session.js';

export const AUDIT_EVENT_STORE_SCHEMA_VERSION = 1;
export const AUDIT_EVENT_STORE_RELATIVE_PATH = path.join(
  '.ontoindex',
  'audit',
  'audit-event-store.json',
);
export const AUDIT_PROJECTION_RELATIVE_PATH = path.join(
  '.ontoindex',
  'audit',
  'audit-projection.json',
);

interface AuditEventBase {
  id: string;
  type: string;
  occurredAt: string;
  sessionId: string;
  actor?: string;
}

export interface AuditIngestedEvent extends AuditEventBase {
  type: 'AuditIngested';
  session: AuditSession;
}

export interface FindingCandidateCreatedEvent extends AuditEventBase {
  type: 'FindingCandidateCreated';
  findingId: string;
  finding: AuditFinding;
}

export interface FindingVerifiedEvent extends AuditEventBase {
  type: 'FindingVerified';
  findingId: string;
  verification: AuditFindingVerification;
}

export interface FindingStatusChangedEvent extends AuditEventBase {
  type: 'FindingStatusChanged';
  findingId: string;
  status: AuditFindingStatus;
  reason: string;
}

export interface FindingTombstonedEvent extends AuditEventBase {
  type: 'FindingTombstoned';
  findingId: string;
  tombstone: AuditFindingTombstone;
}

export interface FindingBundledEvent extends AuditEventBase {
  type: 'FindingBundled';
  bundleId: string;
  bundle: AuditBundle;
}

export interface BundleDispatchedEvent extends AuditEventBase {
  type: 'BundleDispatched';
  bundleId: string;
  dispatchedAt: string;
  metadata: Record<string, unknown>;
}

export interface ScopeGuardEvaluatedEvent extends AuditEventBase {
  type: 'ScopeGuardEvaluated';
  status: string;
  metadata: Record<string, unknown>;
}

export interface AuditLintedEvent extends AuditEventBase {
  type: 'AuditLinted';
  status: string;
  findingIds: string[];
  warnings: string[];
}

export type AuditEvent =
  | AuditIngestedEvent
  | FindingCandidateCreatedEvent
  | FindingVerifiedEvent
  | FindingStatusChangedEvent
  | FindingTombstonedEvent
  | FindingBundledEvent
  | BundleDispatchedEvent
  | ScopeGuardEvaluatedEvent
  | AuditLintedEvent;

export interface AuditEventStoreState {
  schemaVersion: typeof AUDIT_EVENT_STORE_SCHEMA_VERSION;
  events: AuditEvent[];
}

export interface AuditEventInput {
  id?: string;
  occurredAt?: string;
  actor?: string;
}

export interface AuditStoreUpdateOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  staleLockMs?: number;
  ownerId?: string;
}

const DEFAULT_UPDATE_LOCK_MAX_ATTEMPTS = 25;
const DEFAULT_UPDATE_LOCK_RETRY_DELAY_MS = 10;
const DEFAULT_UPDATE_LOCK_STALE_MS = 30_000;

export class LocalAuditEventStore {
  readonly eventStorePath: string;
  readonly projectionPath: string;

  constructor(repoRoot: string) {
    this.eventStorePath = getAuditEventStorePath(repoRoot);
    this.projectionPath = getAuditProjectionPath(repoRoot);
  }

  async load(): Promise<AuditEventStoreState> {
    return loadAuditEventStoreState(this.eventStorePath);
  }

  async appendEvent(event: AuditEvent, options: AuditStoreUpdateOptions = {}): Promise<AuditEvent> {
    return withAuditStoreUpdateLock(this.eventStorePath, options, async () => {
      const state = await this.load();
      assertUniqueEventId(state.events, event.id);
      const nextEvent = normalizeAuditEvent(event);
      state.events.push(nextEvent);
      await saveAuditEventStoreState(this.eventStorePath, state);
      await rebuildAuditProjectionFile(this.eventStorePath, this.projectionPath);
      return nextEvent;
    });
  }

  async createSession(
    input: AuditSessionInput,
    eventInput: AuditEventInput = {},
    options: AuditStoreUpdateOptions = {},
  ): Promise<AuditSession> {
    const session = createAuditSession(input);
    await this.appendEvent(
      {
        id: eventInput.id ?? createAuditEventId('evt'),
        type: 'AuditIngested',
        occurredAt: eventInput.occurredAt ?? session.createdAt,
        sessionId: session.id,
        ...(eventInput.actor !== undefined ? { actor: eventInput.actor } : {}),
        session,
      },
      options,
    );
    return session;
  }

  async createFindingCandidate(
    input: AuditFindingInput,
    eventInput: AuditEventInput = {},
    options: AuditStoreUpdateOptions = {},
  ): Promise<AuditFinding> {
    const finding = createAuditFinding(input);
    await this.appendEvent(
      {
        id: eventInput.id ?? createAuditEventId('evt'),
        type: 'FindingCandidateCreated',
        occurredAt: eventInput.occurredAt ?? new Date().toISOString(),
        sessionId: finding.sessionId,
        findingId: finding.id,
        ...(eventInput.actor !== undefined ? { actor: eventInput.actor } : {}),
        finding,
      },
      options,
    );
    return finding;
  }
}

export async function loadAuditEventStoreState(
  stateFilePath: string,
): Promise<AuditEventStoreState> {
  let raw: string;
  try {
    raw = await fs.readFile(stateFilePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return createEmptyAuditEventStoreState();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`audit event store is not valid JSON: ${(error as Error).message}`);
  }

  return normalizeAuditEventStoreState(parsed);
}

export async function saveAuditEventStoreState(
  stateFilePath: string,
  state: AuditEventStoreState,
): Promise<void> {
  await atomicWriteJson(stateFilePath, normalizeAuditEventStoreState(state));
}

export async function rebuildAuditProjectionFile(
  stateFilePath: string,
  projectionPath: string,
): Promise<void> {
  const state = await loadAuditEventStoreState(stateFilePath);
  const projection = buildAuditProjection(state.events);
  await atomicWriteJson(projectionPath, projection);
}

export function createEmptyAuditEventStoreState(): AuditEventStoreState {
  return {
    schemaVersion: AUDIT_EVENT_STORE_SCHEMA_VERSION,
    events: [],
  };
}

export function getAuditEventStorePath(repoRoot: string): string {
  return path.join(repoRoot, AUDIT_EVENT_STORE_RELATIVE_PATH);
}

export function getAuditProjectionPath(repoRoot: string): string {
  return path.join(repoRoot, AUDIT_PROJECTION_RELATIVE_PATH);
}

function normalizeAuditEventStoreState(value: unknown): AuditEventStoreState {
  const record = requireObject(value, 'audit event store');
  const schemaVersion = requireNumber(record.schemaVersion, 'schemaVersion');
  if (schemaVersion !== AUDIT_EVENT_STORE_SCHEMA_VERSION) {
    throw new Error(`unsupported audit event store schemaVersion: ${schemaVersion}`);
  }
  const events = requireArray(record.events, 'events').map((event) => normalizeAuditEvent(event));
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) {
      throw new Error(`duplicate audit event id: ${event.id}`);
    }
    seen.add(event.id);
  }
  return { schemaVersion: AUDIT_EVENT_STORE_SCHEMA_VERSION, events };
}

function normalizeAuditEvent(value: AuditEvent | unknown): AuditEvent {
  const record = requireObject(value, 'event');
  const base = {
    id: requireRecordString(record, 'id', 'event.id'),
    occurredAt: toIsoTimestamp(
      requireRecordString(record, 'occurredAt', 'event.occurredAt'),
      'event.occurredAt',
    ),
    sessionId: requireRecordString(record, 'sessionId', 'event.sessionId'),
    ...(record.actor !== undefined
      ? { actor: requireRecordString(record, 'actor', 'event.actor') }
      : {}),
  };
  const type = requireRecordString(record, 'type', 'event.type');
  switch (type) {
    case 'AuditIngested':
      return { ...base, type, session: createAuditSession(record.session as AuditSessionInput) };
    case 'FindingCandidateCreated': {
      const finding = createAuditFinding(record.finding as AuditFindingInput);
      return {
        ...base,
        type,
        findingId: requireRecordString(record, 'findingId', 'event.findingId'),
        finding,
      };
    }
    case 'FindingVerified':
      return {
        ...base,
        type,
        findingId: requireRecordString(record, 'findingId', 'event.findingId'),
        verification: normalizeVerification(record.verification),
      };
    case 'FindingStatusChanged':
      return {
        ...base,
        type,
        findingId: requireRecordString(record, 'findingId', 'event.findingId'),
        status: normalizeAuditFindingStatus(
          requireRecordString(record, 'status', 'event.status'),
          'event.status',
        ),
        reason: requireRecordString(record, 'reason', 'event.reason'),
      };
    case 'FindingTombstoned':
      return {
        ...base,
        type,
        findingId: requireRecordString(record, 'findingId', 'event.findingId'),
        tombstone: normalizeTombstone(record.tombstone),
      };
    case 'FindingBundled':
      return {
        ...base,
        type,
        bundleId: requireRecordString(record, 'bundleId', 'event.bundleId'),
        bundle: normalizeBundle(record.bundle),
      };
    case 'BundleDispatched':
      return {
        ...base,
        type,
        bundleId: requireRecordString(record, 'bundleId', 'event.bundleId'),
        dispatchedAt: toIsoTimestamp(
          requireRecordString(record, 'dispatchedAt', 'event.dispatchedAt'),
          'event.dispatchedAt',
        ),
        metadata: normalizeMetadata(record.metadata as Record<string, unknown> | undefined),
      };
    case 'ScopeGuardEvaluated':
      return {
        ...base,
        type,
        status: requireRecordString(record, 'status', 'event.status'),
        metadata: normalizeMetadata(record.metadata as Record<string, unknown> | undefined),
      };
    case 'AuditLinted':
      return {
        ...base,
        type,
        status: requireRecordString(record, 'status', 'event.status'),
        findingIds: requireArray(record.findingIds, 'event.findingIds').map((id) =>
          requireUnknownString(id, 'event.findingIds[]'),
        ),
        warnings: requireArray(record.warnings, 'event.warnings').map((warning) =>
          requireUnknownString(warning, 'event.warnings[]'),
        ),
      };
    default:
      throw new Error(`unsupported audit event type: ${type}`);
  }
}

function normalizeVerification(value: unknown): AuditFindingVerification {
  const record = requireObject(value, 'verification');
  return {
    verifiedAt: toIsoTimestamp(
      requireRecordString(record, 'verifiedAt', 'verification.verifiedAt'),
      'verification.verifiedAt',
    ),
    status: normalizeAuditFindingStatus(
      requireRecordString(record, 'status', 'verification.status'),
      'verification.status',
    ),
    evidence: requireArray(record.evidence, 'verification.evidence').map(normalizeEvidence),
    reasonCodes: requireArray(record.reasonCodes, 'verification.reasonCodes').map((reasonCode) =>
      requireUnknownString(reasonCode, 'verification.reasonCodes[]'),
    ),
    verifierVersion: requireNonEmptyString(
      requireRecordString(record, 'verifierVersion', 'verification.verifierVersion'),
      'verification.verifierVersion',
    ),
  };
}

function normalizeTombstone(value: unknown): AuditFindingTombstone {
  const record = requireObject(value, 'tombstone');
  return {
    tombstonedAt: toIsoTimestamp(
      requireRecordString(record, 'tombstonedAt', 'tombstone.tombstonedAt'),
      'tombstone.tombstonedAt',
    ),
    reason: requireRecordString(record, 'reason', 'tombstone.reason'),
    ...(record.invariantId !== undefined
      ? { invariantId: requireRecordString(record, 'invariantId', 'tombstone.invariantId') }
      : {}),
    evidence: requireArray(record.evidence, 'tombstone.evidence').map(normalizeEvidence),
  };
}

function normalizeEvidence(value: unknown): AuditEvidence {
  const record = requireObject(value, 'evidence');
  return {
    id: requireRecordString(record, 'id', 'evidence.id'),
    kind: requireRecordString(record, 'kind', 'evidence.kind'),
    targetHead: requireRecordString(record, 'targetHead', 'evidence.targetHead'),
    graphIndexId: requireRecordString(record, 'graphIndexId', 'evidence.graphIndexId'),
    verifierVersion: requireRecordString(record, 'verifierVersion', 'evidence.verifierVersion'),
    sidecarStateHash: requireNonEmptyString(
      requireRecordString(record, 'sidecarStateHash', 'evidence.sidecarStateHash'),
      'evidence.sidecarStateHash',
    ),
    ...(record.source !== undefined
      ? { source: normalizeEvidenceSource(record.source, 'evidence.source') }
      : {}),
    ...(record.sourceFresh !== undefined
      ? { sourceFresh: requireBoolean(record.sourceFresh, 'evidence.sourceFresh') }
      : {}),
    ...(record.graphStale !== undefined
      ? { graphStale: requireBoolean(record.graphStale, 'evidence.graphStale') }
      : {}),
    ...(record.staleWarnings !== undefined
      ? {
          staleWarnings: requireArray(record.staleWarnings, 'evidence.staleWarnings').map(
            (warning) => requireUnknownString(warning, 'evidence.staleWarnings[]'),
          ),
        }
      : {}),
    ...(record.confidence !== undefined
      ? { confidence: requireFiniteNumber(record.confidence, 'evidence.confidence') }
      : {}),
    ...(record.reasonCodes !== undefined
      ? {
          reasonCodes: requireArray(record.reasonCodes, 'evidence.reasonCodes').map((reasonCode) =>
            requireUnknownString(reasonCode, 'evidence.reasonCodes[]'),
          ),
        }
      : {}),
    ...(record.data !== undefined
      ? { data: normalizeMetadata(record.data as Record<string, unknown>) }
      : {}),
  };
}

function normalizeEvidenceSource(value: unknown, fieldName: string): AuditEvidence['source'] {
  if (
    value !== 'graph' &&
    value !== 'filesystem' &&
    value !== 'git-object' &&
    value !== 'sidecar' &&
    value !== 'runtime'
  ) {
    throw new Error(`${fieldName} has unsupported value: ${String(value)}`);
  }
  return value;
}

function normalizeBundle(value: unknown): AuditBundle {
  const record = requireObject(value, 'bundle');
  return {
    id: requireRecordString(record, 'id', 'bundle.id'),
    sessionId: requireRecordString(record, 'sessionId', 'bundle.sessionId'),
    findingIds: requireArray(record.findingIds, 'bundle.findingIds').map((id) =>
      requireUnknownString(id, 'bundle.findingIds[]'),
    ),
    status: record.status === 'DISPATCHED' ? 'DISPATCHED' : 'CREATED',
    createdAt: toIsoTimestamp(
      requireRecordString(record, 'createdAt', 'bundle.createdAt'),
      'bundle.createdAt',
    ),
    ...(record.dispatchedAt !== undefined
      ? {
          dispatchedAt: toIsoTimestamp(
            requireRecordString(record, 'dispatchedAt', 'bundle.dispatchedAt'),
            'bundle.dispatchedAt',
          ),
        }
      : {}),
    metadata: normalizeMetadata(record.metadata as Record<string, unknown> | undefined),
  };
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

async function withAuditStoreUpdateLock<T>(
  stateFilePath: string,
  options: AuditStoreUpdateOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(
    path.dirname(stateFilePath),
    `.${path.basename(stateFilePath)}.update.lock`,
  );
  const ownerId = options.ownerId ?? createAuditEventId('owner');
  await acquireAuditStoreUpdateLock(lockPath, stateFilePath, ownerId, {
    maxAttempts: options.maxAttempts ?? DEFAULT_UPDATE_LOCK_MAX_ATTEMPTS,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_UPDATE_LOCK_RETRY_DELAY_MS,
    staleLockMs: options.staleLockMs ?? DEFAULT_UPDATE_LOCK_STALE_MS,
  });
  try {
    return await callback();
  } finally {
    await releaseAuditStoreUpdateLock(lockPath, ownerId);
  }
}

async function acquireAuditStoreUpdateLock(
  lockPath: string,
  stateFilePath: string,
  ownerId: string,
  options: Required<Pick<AuditStoreUpdateOptions, 'maxAttempts' | 'retryDelayMs' | 'staleLockMs'>>,
): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ ownerId, pid: process.pid, stateFilePath, acquiredAt: new Date().toISOString() }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }
      await removeStaleAuditStoreUpdateLock(lockPath, options.staleLockMs);
      if (attempt < options.maxAttempts && options.retryDelayMs > 0) {
        await delay(options.retryDelayMs);
      }
    }
  }
  throw new Error(`timed out acquiring audit event store update lock: ${lockPath}`);
}

async function removeStaleAuditStoreUpdateLock(
  lockPath: string,
  staleLockMs: number,
): Promise<void> {
  const stat = await fs.stat(lockPath).catch((error) => {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (stat !== null && Date.now() - stat.mtimeMs > staleLockMs) {
    await fs.rm(lockPath, { force: true });
  }
}

async function releaseAuditStoreUpdateLock(lockPath: string, ownerId: string): Promise<void> {
  const raw = await fs.readFile(lockPath, 'utf8').catch((error) => {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (raw === null) {
    return;
  }
  const parsed = JSON.parse(raw) as { ownerId?: string };
  if (parsed.ownerId === ownerId) {
    await fs.rm(lockPath, { force: true });
  }
}

function assertUniqueEventId(events: readonly AuditEvent[], eventId: string): void {
  if (events.some((event) => event.id === eventId)) {
    throw new Error(`duplicate audit event id: ${eventId}`);
  }
}

function requireObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return value;
}

function requireRecordString(
  record: Record<string, unknown>,
  key: string,
  fieldName: string,
): string {
  return requireUnknownString(record[key], fieldName);
}

function requireUnknownString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return requireNonEmptyString(value, fieldName);
}

function requireNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return value;
}

function requireBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function createAuditEventId(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
