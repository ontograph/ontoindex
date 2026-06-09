import type { AuditEvidence, ReasonCode } from './audit-types.js';

export type AuditFixInvariantKind =
  | 'absence-of-pattern'
  | 'negative-evidence'
  | 'fix-commit'
  | 'manual-review'
  | string;

export type AuditFixInvariantState = 'holds' | 'violated' | 'unknown';

export interface AuditFixInvariant {
  id: string;
  kind: AuditFixInvariantKind;
  state: AuditFixInvariantState;
  targetHead: string;
  verifiedHead: string;
  verifiedAt: string;
  verifierId: string;
  verifierVersion: string;
  graphIndexId?: string;
  sidecarStateHash?: string;
  reasonCodes: ReasonCode[];
  evidence: AuditEvidence[];
  detail: string;
}

export interface AuditInvariantFreshnessInput {
  targetHead: string;
  verifierVersion: string;
  verifierId?: string;
  graphIndexId?: string;
}

export interface AuditInvariantVerification {
  fresh: boolean;
  holds: boolean;
  staleReasonCodes: ReasonCode[];
}

export interface NegativeEvidenceInput {
  id: string;
  targetHead: string;
  verifiedAt: string;
  verifierId: string;
  verifierVersion: string;
  detail: string;
  mode?: AuditEvidence['mode'];
  polarity?: Extract<AuditEvidence['polarity'], 'negative' | 'fix-proof' | 'tombstone-proof'>;
  confidence?: AuditEvidence['confidence'];
  reasonCodes?: ReasonCode[];
  path?: string;
  line?: number;
  symbol?: string;
  graphIndexId?: string;
  fileHash?: string;
}

export function createNegativeEvidence(input: NegativeEvidenceInput): AuditEvidence {
  return {
    id: requireNonEmptyString(input.id, 'negativeEvidence.id'),
    mode: input.mode ?? 'manual-review',
    polarity: input.polarity ?? 'negative',
    targetHead: requireNonEmptyString(input.targetHead, 'negativeEvidence.targetHead'),
    verifiedHead: requireNonEmptyString(input.targetHead, 'negativeEvidence.verifiedHead'),
    verifiedAt: toIsoTimestamp(input.verifiedAt, 'negativeEvidence.verifiedAt'),
    verifierId: requireNonEmptyString(input.verifierId, 'negativeEvidence.verifierId'),
    verifierVersion: requireNonEmptyString(
      input.verifierVersion,
      'negativeEvidence.verifierVersion',
    ),
    confidence: input.confidence ?? 'high',
    reasonCodes: [...(input.reasonCodes ?? ['fresh-negative-evidence'])],
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.line !== undefined ? { line: input.line } : {}),
    ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
    detail: requireNonEmptyString(input.detail, 'negativeEvidence.detail'),
    ...(input.graphIndexId !== undefined ? { graphIndexId: input.graphIndexId } : {}),
    ...(input.fileHash !== undefined ? { fileHash: input.fileHash } : {}),
  };
}

export function createFixInvariant(input: AuditFixInvariant): AuditFixInvariant {
  const targetHead = requireNonEmptyString(input.targetHead, 'invariant.targetHead');
  const verifiedHead = requireNonEmptyString(input.verifiedHead, 'invariant.verifiedHead');
  return {
    id: requireNonEmptyString(input.id, 'invariant.id'),
    kind: requireNonEmptyString(input.kind, 'invariant.kind'),
    state: normalizeInvariantState(input.state),
    targetHead,
    verifiedHead,
    verifiedAt: toIsoTimestamp(input.verifiedAt, 'invariant.verifiedAt'),
    verifierId: requireNonEmptyString(input.verifierId, 'invariant.verifierId'),
    verifierVersion: requireNonEmptyString(input.verifierVersion, 'invariant.verifierVersion'),
    ...(input.graphIndexId !== undefined ? { graphIndexId: input.graphIndexId } : {}),
    ...(input.sidecarStateHash !== undefined ? { sidecarStateHash: input.sidecarStateHash } : {}),
    reasonCodes: [...input.reasonCodes],
    evidence: input.evidence.map((evidence) => ({ ...evidence })),
    detail: requireNonEmptyString(input.detail, 'invariant.detail'),
  };
}

export function verifyFixInvariantFreshness(
  invariant: AuditFixInvariant,
  expected: AuditInvariantFreshnessInput,
): AuditInvariantVerification {
  const staleReasonCodes: ReasonCode[] = [];
  if (
    invariant.targetHead !== expected.targetHead ||
    invariant.verifiedHead !== expected.targetHead
  ) {
    staleReasonCodes.push('target-head-mismatch');
  }
  if (invariant.verifierVersion !== expected.verifierVersion) {
    staleReasonCodes.push('stale-evidence');
  }
  if (expected.verifierId !== undefined && invariant.verifierId !== expected.verifierId) {
    staleReasonCodes.push('stale-evidence');
  }
  if (expected.graphIndexId !== undefined && invariant.graphIndexId !== expected.graphIndexId) {
    staleReasonCodes.push('stale-evidence');
  }
  if (
    invariant.evidence.some(
      (evidence) =>
        evidence.targetHead !== expected.targetHead ||
        evidence.verifiedHead !== expected.targetHead ||
        evidence.verifierVersion !== expected.verifierVersion,
    )
  ) {
    staleReasonCodes.push('stale-evidence');
  }

  return {
    fresh: staleReasonCodes.length === 0,
    holds: invariant.state === 'holds',
    staleReasonCodes: Array.from(new Set(staleReasonCodes)),
  };
}

export function invariantAllowsResolvedAlready(
  invariant: AuditFixInvariant,
  expected: AuditInvariantFreshnessInput,
): boolean {
  const verification = verifyFixInvariantFreshness(invariant, expected);
  return verification.fresh && verification.holds;
}

function normalizeInvariantState(value: AuditFixInvariantState): AuditFixInvariantState {
  if (value !== 'holds' && value !== 'violated' && value !== 'unknown') {
    throw new Error(`invariant.state has unsupported value: ${String(value)}`);
  }
  return value;
}

function requireNonEmptyString(value: string, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function toIsoTimestamp(value: string, fieldName: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be an ISO timestamp`);
  }
  return date.toISOString();
}
