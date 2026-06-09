import {
  type ResourceFact,
  type SystemsAuditEvidence,
  normalizeConfidence,
  requireNonEmptyString,
} from './resource-facts.js';

export const SYSTEMS_AUDIT_RECORD_SCHEMA_VERSION = 1;
export const SYSTEMS_AUDIT_RESPONSE_VERSION = 1;

export type SystemsAuditRecordStatus =
  | 'complete'
  | 'partial'
  | 'failed'
  | 'stale'
  | 'unsupported'
  | 'unresolved';

export type SystemsAuditFreshnessState = 'clean' | 'dirty' | 'stale' | 'partial';

export interface SystemsAuditCurrentSnapshot {
  sourceIndexId: string;
  sourceCommitHash: string;
  graphSchemaVersion?: number;
}

export interface SystemsAuditRecordInput {
  kind?: 'systems-audit-record';
  sourceIndexId: string;
  sourceCommitHash: string;
  analyzerId: string;
  analyzerVersion: string;
  filePath: string;
  fileHash: string;
  graphSchemaVersion?: number;
  status: SystemsAuditRecordStatus;
  confidence?: number;
  evidence?: readonly SystemsAuditEvidence[];
  records?: readonly ResourceFact[];
  findings?: readonly SystemsAuditFinding[];
  limits?: SystemsAuditLimits;
  skipReasons?: readonly string[];
  warnings?: readonly string[];
}

export interface SystemsAuditRecord extends Required<Omit<SystemsAuditRecordInput, 'confidence'>> {
  kind: 'systems-audit-record';
  schemaVersion: typeof SYSTEMS_AUDIT_RECORD_SCHEMA_VERSION;
  confidence: number;
}

export interface SystemsAuditFinding {
  id: string;
  category: string;
  severity: 'info' | 'low' | 'medium' | 'high';
  confidence: number;
  message: string;
  evidence: SystemsAuditEvidence[];
  status: 'open' | 'mitigated' | 'unresolved' | 'unsupported';
}

export interface SystemsAuditLimits {
  maxRecords: number;
  recordsReturned: number;
  truncated: boolean;
}

export interface SystemsAuditFreshness {
  graphState: SystemsAuditFreshnessState;
  sourceIndexId: string;
  sourceCommitHash: string;
  checkedAt: string;
  warning?: string;
}

export interface SystemsAuditResponseEnvelope {
  version: typeof SYSTEMS_AUDIT_RESPONSE_VERSION;
  tool: string;
  status: SystemsAuditRecordStatus;
  primaryGraphFacts: unknown[];
  systemsEvidence: SystemsAuditEvidence[];
  facts: ResourceFact[];
  findings: SystemsAuditFinding[];
  limits: SystemsAuditLimits;
  freshness: SystemsAuditFreshness;
  skipReasons: string[];
  warnings: string[];
  nextTools: string[];
}

export type SystemsAuditRecordFreshnessReason =
  | 'fresh'
  | 'index-mismatch'
  | 'commit-mismatch'
  | 'schema-mismatch'
  | 'status-unusable';

export interface SystemsAuditRecordFreshnessDecision {
  usable: boolean;
  reason: SystemsAuditRecordFreshnessReason;
}

const USABLE_RECORD_STATUSES = new Set<SystemsAuditRecordStatus>(['complete', 'partial']);
const RECORD_STATUSES = new Set<SystemsAuditRecordStatus>([
  'complete',
  'partial',
  'failed',
  'stale',
  'unsupported',
  'unresolved',
]);

export function createSystemsAuditRecord(input: SystemsAuditRecordInput): SystemsAuditRecord {
  const status = requireKnownRecordStatus(input.status);
  return {
    kind: 'systems-audit-record',
    schemaVersion: SYSTEMS_AUDIT_RECORD_SCHEMA_VERSION,
    sourceIndexId: requireNonEmptyString(input.sourceIndexId, 'sourceIndexId'),
    sourceCommitHash: requireNonEmptyString(input.sourceCommitHash, 'sourceCommitHash'),
    analyzerId: requireNonEmptyString(input.analyzerId, 'analyzerId'),
    analyzerVersion: requireNonEmptyString(input.analyzerVersion, 'analyzerVersion'),
    filePath: requireNonEmptyString(input.filePath, 'filePath'),
    fileHash: requireNonEmptyString(input.fileHash, 'fileHash'),
    graphSchemaVersion: input.graphSchemaVersion,
    status,
    confidence: normalizeConfidence(input.confidence ?? defaultConfidenceForStatus(status)),
    evidence: [...(input.evidence ?? [])],
    records: [...(input.records ?? [])],
    findings: [...(input.findings ?? [])],
    limits: input.limits ?? {
      maxRecords: input.records?.length ?? 0,
      recordsReturned: input.records?.length ?? 0,
      truncated: false,
    },
    skipReasons: [...(input.skipReasons ?? [])],
    warnings: [...(input.warnings ?? [])],
  };
}

export function decideSystemsAuditRecordFreshness(
  record: SystemsAuditRecord,
  snapshot: SystemsAuditCurrentSnapshot,
): SystemsAuditRecordFreshnessDecision {
  if (!USABLE_RECORD_STATUSES.has(record.status))
    return { usable: false, reason: 'status-unusable' };
  if (record.sourceIndexId !== snapshot.sourceIndexId)
    return { usable: false, reason: 'index-mismatch' };
  if (record.sourceCommitHash !== snapshot.sourceCommitHash)
    return { usable: false, reason: 'commit-mismatch' };
  if (
    snapshot.graphSchemaVersion !== undefined &&
    record.graphSchemaVersion !== undefined &&
    record.graphSchemaVersion !== snapshot.graphSchemaVersion
  ) {
    return { usable: false, reason: 'schema-mismatch' };
  }
  return { usable: true, reason: 'fresh' };
}

export function assertFreshSystemsAuditRecord(
  record: SystemsAuditRecord,
  snapshot: SystemsAuditCurrentSnapshot,
): SystemsAuditRecord {
  const decision = decideSystemsAuditRecordFreshness(record, snapshot);
  if (!decision.usable) {
    throw new Error(`systems-audit record rejected: ${decision.reason}`);
  }
  return record;
}

export function createSystemsAuditResponseEnvelope(input: {
  tool: string;
  status: SystemsAuditRecordStatus;
  primaryGraphFacts?: unknown[];
  systemsEvidence?: SystemsAuditEvidence[];
  facts?: ResourceFact[];
  findings?: SystemsAuditFinding[];
  limits?: SystemsAuditLimits;
  freshness: SystemsAuditFreshness;
  skipReasons?: readonly string[];
  warnings?: readonly string[];
  nextTools?: readonly string[];
}): SystemsAuditResponseEnvelope {
  return {
    version: SYSTEMS_AUDIT_RESPONSE_VERSION,
    tool: requireNonEmptyString(input.tool, 'tool'),
    status: requireKnownRecordStatus(input.status),
    primaryGraphFacts: [...(input.primaryGraphFacts ?? [])],
    systemsEvidence: [...(input.systemsEvidence ?? [])],
    facts: [...(input.facts ?? [])],
    findings: [...(input.findings ?? [])],
    limits: input.limits ?? {
      maxRecords: input.facts?.length ?? 0,
      recordsReturned: input.facts?.length ?? 0,
      truncated: false,
    },
    freshness: input.freshness,
    skipReasons: [...(input.skipReasons ?? [])],
    warnings: [...(input.warnings ?? [])],
    nextTools: [...(input.nextTools ?? [])],
  };
}

function requireKnownRecordStatus(value: SystemsAuditRecordStatus): SystemsAuditRecordStatus {
  if (!RECORD_STATUSES.has(value)) {
    throw new Error(`status has unsupported value: ${String(value)}`);
  }
  return value;
}

function defaultConfidenceForStatus(status: SystemsAuditRecordStatus): number {
  if (status === 'failed' || status === 'unsupported') return 0;
  if (status === 'unresolved' || status === 'partial') return 0.5;
  return 1;
}
