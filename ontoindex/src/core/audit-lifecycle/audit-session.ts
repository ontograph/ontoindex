export type AuditFindingStatus =
  | 'NEEDS-VERIFY'
  | 'NEEDS-REVERIFY'
  | 'OPEN'
  | 'PARTIAL'
  | 'RESOLVED-ALREADY'
  | 'FALSE-POSITIVE'
  | 'HOLD'
  | 'TOMBSTONED'
  | 'BUNDLED'
  | 'DISPATCHED';

export type AuditSnapshotMode = 'committed-head' | 'dirty-worktree-overlay' | 'diff-ref';
export type AuditEvidenceSource = 'graph' | 'filesystem' | 'git-object' | 'sidecar' | 'runtime';

export interface AuditSessionSnapshot {
  mode: AuditSnapshotMode;
  targetHead: string;
  graphIndexId: string;
  changedFiles: string[];
  changedSymbols: string[];
  staleWarnings: string[];
}

const AUDIT_FINDING_STATUSES = new Set<AuditFindingStatus>([
  'NEEDS-VERIFY',
  'NEEDS-REVERIFY',
  'OPEN',
  'PARTIAL',
  'RESOLVED-ALREADY',
  'FALSE-POSITIVE',
  'HOLD',
  'TOMBSTONED',
  'BUNDLED',
  'DISPATCHED',
]);

export interface AuditSessionInput {
  id: string;
  targetRepo: string;
  targetHead: string;
  sourceHash: string;
  graphIndexId: string;
  verifierVersion: string;
  sidecarStateHash: string;
  createdAt?: string;
  sourcePath?: string;
  snapshotMode?: AuditSnapshotMode;
  changedFiles?: readonly string[];
  changedSymbols?: readonly string[];
  staleWarnings?: readonly string[];
  snapshot?: AuditSessionSnapshot;
  metadata?: Record<string, unknown>;
}

export interface AuditSession {
  id: string;
  targetRepo: string;
  targetHead: string;
  sourceHash: string;
  graphIndexId: string;
  verifierVersion: string;
  sidecarStateHash: string;
  createdAt: string;
  sourcePath?: string;
  snapshotMode?: AuditSnapshotMode;
  changedFiles?: string[];
  changedSymbols?: string[];
  staleWarnings?: string[];
  snapshot?: AuditSessionSnapshot;
  metadata: Record<string, unknown>;
}

export interface AuditFindingInput {
  id: string;
  sessionId: string;
  title: string;
  fingerprint: string;
  status?: AuditFindingStatus;
  summary?: string;
  severity?: string;
  evidence?: AuditEvidence[];
  metadata?: Record<string, unknown>;
}

export interface AuditFinding {
  id: string;
  sessionId: string;
  title: string;
  fingerprint: string;
  status: AuditFindingStatus;
  summary?: string;
  severity?: string;
  evidence: AuditEvidence[];
  metadata: Record<string, unknown>;
  verification?: AuditFindingVerification;
  tombstone?: AuditFindingTombstone;
  bundleId?: string;
  updatedAt?: string;
}

export interface AuditEvidence {
  id: string;
  kind: string;
  targetHead: string;
  graphIndexId: string;
  verifierVersion: string;
  sidecarStateHash: string;
  source?: AuditEvidenceSource;
  sourceFresh?: boolean;
  graphStale?: boolean;
  staleWarnings?: string[];
  confidence?: number;
  reasonCodes?: string[];
  data?: Record<string, unknown>;
}

export interface AuditFindingVerification {
  verifiedAt: string;
  status: AuditFindingStatus;
  evidence: AuditEvidence[];
  reasonCodes: string[];
  verifierVersion: string;
}

export interface AuditFindingTombstone {
  tombstonedAt: string;
  reason: string;
  invariantId?: string;
  evidence: AuditEvidence[];
}

export interface AuditBundle {
  id: string;
  sessionId: string;
  findingIds: string[];
  status: 'CREATED' | 'DISPATCHED';
  createdAt: string;
  dispatchedAt?: string;
  metadata: Record<string, unknown>;
}

export function createAuditSession(input: AuditSessionInput): AuditSession {
  const snapshot = normalizeSessionSnapshot(input);
  return {
    id: requireNonEmptyString(input.id, 'session.id'),
    targetRepo: requireNonEmptyString(input.targetRepo, 'session.targetRepo'),
    targetHead: requireNonEmptyString(input.targetHead, 'session.targetHead'),
    sourceHash: requireNonEmptyString(input.sourceHash, 'session.sourceHash'),
    graphIndexId: requireNonEmptyString(input.graphIndexId, 'session.graphIndexId'),
    verifierVersion: requireNonEmptyString(input.verifierVersion, 'session.verifierVersion'),
    sidecarStateHash: requireNonEmptyString(input.sidecarStateHash, 'session.sidecarStateHash'),
    createdAt: toIsoTimestamp(input.createdAt ?? new Date().toISOString(), 'session.createdAt'),
    ...(input.sourcePath !== undefined
      ? { sourcePath: requireNonEmptyString(input.sourcePath, 'session.sourcePath') }
      : {}),
    ...(snapshot !== undefined
      ? {
          snapshotMode: snapshot.mode,
          changedFiles: [...snapshot.changedFiles],
          changedSymbols: [...snapshot.changedSymbols],
          staleWarnings: [...snapshot.staleWarnings],
          snapshot,
        }
      : {}),
    metadata: normalizeMetadata(input.metadata),
  };
}

export function createAuditFinding(input: AuditFindingInput): AuditFinding {
  return {
    id: requireNonEmptyString(input.id, 'finding.id'),
    sessionId: requireNonEmptyString(input.sessionId, 'finding.sessionId'),
    title: requireNonEmptyString(input.title, 'finding.title'),
    fingerprint: requireNonEmptyString(input.fingerprint, 'finding.fingerprint'),
    status: normalizeAuditFindingStatus(input.status ?? 'NEEDS-VERIFY', 'finding.status'),
    ...(input.summary !== undefined
      ? { summary: requireNonEmptyString(input.summary, 'finding.summary') }
      : {}),
    ...(input.severity !== undefined
      ? { severity: requireNonEmptyString(input.severity, 'finding.severity') }
      : {}),
    evidence: [...(input.evidence ?? [])],
    metadata: normalizeMetadata(input.metadata),
  };
}

export function requireNonEmptyString(value: string, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

export function normalizeAuditFindingStatus(value: string, fieldName: string): AuditFindingStatus {
  if (!AUDIT_FINDING_STATUSES.has(value as AuditFindingStatus)) {
    throw new Error(`${fieldName} has unsupported value: ${String(value)}`);
  }
  return value as AuditFindingStatus;
}

export function toIsoTimestamp(value: string, fieldName: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be an ISO timestamp`);
  }
  return date.toISOString();
}

export function normalizeMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('metadata must be an object');
  }
  return { ...value };
}

function normalizeSessionSnapshot(input: AuditSessionInput): AuditSessionSnapshot | undefined {
  if (input.snapshot !== undefined) {
    return {
      mode: normalizeSnapshotMode(input.snapshot.mode, 'session.snapshot.mode'),
      targetHead: requireNonEmptyString(input.snapshot.targetHead, 'session.snapshot.targetHead'),
      graphIndexId: requireNonEmptyString(
        input.snapshot.graphIndexId,
        'session.snapshot.graphIndexId',
      ),
      changedFiles: normalizeStringArray(
        input.snapshot.changedFiles,
        'session.snapshot.changedFiles',
      ),
      changedSymbols: normalizeStringArray(
        input.snapshot.changedSymbols,
        'session.snapshot.changedSymbols',
      ),
      staleWarnings: normalizeStringArray(
        input.snapshot.staleWarnings,
        'session.snapshot.staleWarnings',
      ),
    };
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
    mode: normalizeSnapshotMode(input.snapshotMode ?? 'committed-head', 'session.snapshotMode'),
    targetHead: requireNonEmptyString(input.targetHead, 'session.targetHead'),
    graphIndexId: requireNonEmptyString(input.graphIndexId, 'session.graphIndexId'),
    changedFiles: normalizeStringArray(input.changedFiles ?? [], 'session.changedFiles'),
    changedSymbols: normalizeStringArray(input.changedSymbols ?? [], 'session.changedSymbols'),
    staleWarnings: normalizeStringArray(input.staleWarnings ?? [], 'session.staleWarnings'),
  };
}

function normalizeSnapshotMode(value: string, fieldName: string): AuditSnapshotMode {
  if (value !== 'committed-head' && value !== 'dirty-worktree-overlay' && value !== 'diff-ref') {
    throw new Error(`${fieldName} has unsupported value: ${String(value)}`);
  }
  return value;
}

function normalizeStringArray(values: readonly string[], fieldName: string): string[] {
  return Array.from(
    new Set(values.map((value) => requireNonEmptyString(value, `${fieldName}[]`))),
  ).sort();
}
