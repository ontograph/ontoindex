export type EnrichmentRecordStatus =
  | 'queued'
  | 'running'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'superseded';

export interface EnrichmentFact {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface EnrichmentRecordInput {
  sourceIndexId: string;
  sourceCommitHash: string;
  schemaVersion?: number;
  analyzerId: string;
  analyzerVersion: string;
  filePath: string;
  fileHash: string;
  status: EnrichmentRecordStatus;
  confidence?: number;
  records?: readonly EnrichmentFact[];
  failureReason?: string;
}

export interface EnrichmentRecord {
  sourceIndexId: string;
  sourceCommitHash: string;
  schemaVersion?: number;
  analyzerId: string;
  analyzerVersion: string;
  filePath: string;
  fileHash: string;
  status: EnrichmentRecordStatus;
  confidence?: number;
  records: EnrichmentFact[];
  failureReason?: string;
}

export interface EnrichmentSnapshot {
  sourceIndexId: string;
  sourceCommitHash: string;
  schemaVersion?: number;
  analyzerVersion?: string;
  filePath: string;
  fileHash: string;
}

export type EnrichmentFreshnessReason =
  | 'fresh'
  | 'status-unusable'
  | 'index-mismatch'
  | 'commit-mismatch'
  | 'schema-mismatch'
  | 'file-path-mismatch'
  | 'file-hash-mismatch';

export interface EnrichmentFreshnessDecision {
  usable: boolean;
  reason: EnrichmentFreshnessReason;
}

export type EnrichmentInvalidationReason =
  | 'hash-compatible'
  | 'stale-by-new-index'
  | 'superseded-by-new-index';

export interface EnrichmentInvalidationDecision {
  record: EnrichmentRecord;
  reason: EnrichmentInvalidationReason;
}

const USABLE_STATUSES = new Set<EnrichmentRecordStatus>(['complete', 'partial']);
const ENRICHMENT_RECORD_STATUSES = new Set<EnrichmentRecordStatus>([
  'queued',
  'running',
  'complete',
  'partial',
  'failed',
  'cancelled',
  'stale',
  'superseded',
]);

export function createEnrichmentRecord(input: EnrichmentRecordInput): EnrichmentRecord {
  const confidence = normalizeConfidence(input.confidence);
  const record: EnrichmentRecord = {
    sourceIndexId: requireNonEmpty(input.sourceIndexId, 'sourceIndexId'),
    sourceCommitHash: requireNonEmpty(input.sourceCommitHash, 'sourceCommitHash'),
    analyzerId: requireNonEmpty(input.analyzerId, 'analyzerId'),
    analyzerVersion: requireNonEmpty(input.analyzerVersion, 'analyzerVersion'),
    filePath: requireNonEmpty(input.filePath, 'filePath'),
    fileHash: requireNonEmpty(input.fileHash, 'fileHash'),
    status: requireKnownStatus(input.status),
    records: [...(input.records ?? [])],
  };

  if (input.schemaVersion !== undefined) {
    record.schemaVersion = normalizeSchemaVersion(input.schemaVersion);
  }
  if (confidence !== undefined) {
    record.confidence = confidence;
  }
  if (input.failureReason !== undefined) {
    record.failureReason = requireNonEmpty(input.failureReason, 'failureReason');
  }

  return record;
}

export function decideEnrichmentFreshness(
  record: EnrichmentRecord,
  snapshot: EnrichmentSnapshot,
): EnrichmentFreshnessDecision {
  if (!USABLE_STATUSES.has(record.status)) {
    return { usable: false, reason: 'status-unusable' };
  }
  if (record.sourceIndexId !== snapshot.sourceIndexId) {
    return { usable: false, reason: 'index-mismatch' };
  }
  if (record.sourceCommitHash !== snapshot.sourceCommitHash) {
    return { usable: false, reason: 'commit-mismatch' };
  }
  if (hasSchemaMismatch(record.schemaVersion, snapshot.schemaVersion)) {
    return { usable: false, reason: 'schema-mismatch' };
  }
  if (record.filePath !== snapshot.filePath) {
    return { usable: false, reason: 'file-path-mismatch' };
  }
  if (record.fileHash !== snapshot.fileHash) {
    return { usable: false, reason: 'file-hash-mismatch' };
  }

  return { usable: true, reason: 'fresh' };
}

export function invalidateEnrichmentForNewAnalyze(
  record: EnrichmentRecord,
  snapshot: EnrichmentSnapshot,
): EnrichmentInvalidationDecision {
  if (isHashCompatible(record, snapshot)) {
    return { record, reason: 'hash-compatible' };
  }

  if (record.status === 'queued') {
    return {
      record: { ...record, status: 'superseded' },
      reason: 'superseded-by-new-index',
    };
  }

  return {
    record: { ...record, status: 'stale' },
    reason: 'stale-by-new-index',
  };
}

function isHashCompatible(record: EnrichmentRecord, snapshot: EnrichmentSnapshot): boolean {
  return (
    record.filePath === snapshot.filePath &&
    record.fileHash === snapshot.fileHash &&
    snapshot.analyzerVersion !== undefined &&
    record.analyzerVersion === snapshot.analyzerVersion &&
    !hasSchemaMismatch(record.schemaVersion, snapshot.schemaVersion)
  );
}

function hasSchemaMismatch(
  recordSchemaVersion: number | undefined,
  snapshotSchemaVersion: number | undefined,
): boolean {
  return (
    (recordSchemaVersion !== undefined || snapshotSchemaVersion !== undefined) &&
    recordSchemaVersion !== snapshotSchemaVersion
  );
}

function normalizeConfidence(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('confidence must be a finite number from 0 to 1');
  }
  return value;
}

function normalizeSchemaVersion(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('schemaVersion must be a non-negative integer');
  }
  return value;
}

function requireNonEmpty(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requireKnownStatus(value: EnrichmentRecordStatus): EnrichmentRecordStatus {
  if (!ENRICHMENT_RECORD_STATUSES.has(value)) {
    throw new Error(`status has unsupported value: ${String(value)}`);
  }
  return value;
}
