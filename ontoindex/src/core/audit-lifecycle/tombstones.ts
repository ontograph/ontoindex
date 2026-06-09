import type {
  AuditEvidence,
  AuditFinding,
  AuditFingerprint,
  AuditLifecycleStatus,
  ReasonCode,
} from './audit-types.js';
import {
  createNegativeEvidence,
  verifyFixInvariantFreshness,
  type AuditFixInvariant,
  type AuditInvariantFreshnessInput,
} from './invariants.js';

export type TombstoneMatchLayer =
  | 'location-claim-history'
  | 'location-claim'
  | 'claim-history'
  | 'location-history'
  | 'claim';

export interface AuditTombstoneRecord {
  id: string;
  findingId: string;
  targetRepo: string;
  targetHead: string;
  graphIndexId: string;
  verifierId: string;
  verifierVersion: string;
  tombstonedAt: string;
  reason: string;
  fingerprint: AuditFingerprint;
  invariant: AuditFixInvariant;
  fixCommit: string | null;
  evidence: AuditEvidence[];
}

export interface AuditTombstoneMatch {
  tombstone: AuditTombstoneRecord;
  layer: TombstoneMatchLayer;
  score: number;
}

export interface TombstoneClassification {
  status: AuditLifecycleStatus;
  match: AuditTombstoneMatch | null;
  evidence: AuditEvidence[];
  reasonCodes: ReasonCode[];
  advisory: boolean;
  active: boolean;
  reopenAllowed: boolean;
}

export function createAuditTombstoneRecord(input: AuditTombstoneRecord): AuditTombstoneRecord {
  return {
    id: requireNonEmptyString(input.id, 'tombstone.id'),
    findingId: requireNonEmptyString(input.findingId, 'tombstone.findingId'),
    targetRepo: requireNonEmptyString(input.targetRepo, 'tombstone.targetRepo'),
    targetHead: requireNonEmptyString(input.targetHead, 'tombstone.targetHead'),
    graphIndexId: requireNonEmptyString(input.graphIndexId, 'tombstone.graphIndexId'),
    verifierId: requireNonEmptyString(input.verifierId, 'tombstone.verifierId'),
    verifierVersion: requireNonEmptyString(input.verifierVersion, 'tombstone.verifierVersion'),
    tombstonedAt: toIsoTimestamp(input.tombstonedAt, 'tombstone.tombstonedAt'),
    reason: requireNonEmptyString(input.reason, 'tombstone.reason'),
    fingerprint: { ...input.fingerprint },
    invariant: {
      ...input.invariant,
      evidence: input.invariant.evidence.map((item) => ({ ...item })),
    },
    fixCommit: input.fixCommit,
    evidence: input.evidence.map((item) => ({ ...item })),
  };
}

export function matchTombstoneByFingerprint(
  finding: Pick<AuditFinding, 'fingerprint'>,
  tombstones: readonly AuditTombstoneRecord[],
): AuditTombstoneMatch | null {
  return (
    tombstones
      .map((tombstone) => matchSingleTombstone(finding.fingerprint, tombstone))
      .filter((match): match is AuditTombstoneMatch => match !== null)
      .sort(
        (left, right) =>
          right.score - left.score || left.tombstone.id.localeCompare(right.tombstone.id),
      )[0] ?? null
  );
}

export function classifyTombstoneMatch(
  finding: Pick<AuditFinding, 'fingerprint' | 'targetHead' | 'graphIndexId'>,
  tombstones: readonly AuditTombstoneRecord[],
  expected: Omit<AuditInvariantFreshnessInput, 'targetHead'>,
): TombstoneClassification {
  const match = matchTombstoneByFingerprint(finding, tombstones);
  if (match === null) {
    return {
      status: 'NEEDS-VERIFY',
      match: null,
      evidence: [],
      reasonCodes: [],
      advisory: false,
      active: false,
      reopenAllowed: false,
    };
  }

  const invariant = verifyFixInvariantFreshness(match.tombstone.invariant, {
    ...expected,
    targetHead: finding.targetHead,
    graphIndexId: finding.graphIndexId,
  });
  const tombstoneFresh =
    match.tombstone.targetHead === finding.targetHead &&
    match.tombstone.graphIndexId === finding.graphIndexId &&
    match.tombstone.verifierVersion === expected.verifierVersion &&
    (expected.verifierId === undefined || match.tombstone.verifierId === expected.verifierId);
  const active = tombstoneFresh && invariant.fresh;

  if (tombstoneFresh && invariant.fresh && invariant.holds) {
    return {
      status: 'RESOLVED-ALREADY',
      match,
      evidence: [
        createNegativeEvidence({
          id: `tombstone-proof:${match.tombstone.id}`,
          mode: 'tombstone',
          polarity: 'tombstone-proof',
          targetHead: finding.targetHead,
          verifiedAt: match.tombstone.tombstonedAt,
          verifierId: match.tombstone.verifierId,
          verifierVersion: match.tombstone.verifierVersion,
          graphIndexId: finding.graphIndexId,
          detail: `Tombstone ${match.tombstone.id} matched by ${match.layer} and invariant ${match.tombstone.invariant.id} still holds.`,
          reasonCodes: ['tombstone-match'],
        }),
      ],
      reasonCodes: ['tombstone-match'],
      advisory: false,
      active,
      reopenAllowed: false,
    };
  }

  if (active && match.tombstone.invariant.state === 'violated') {
    return {
      status: 'NEEDS-REVERIFY',
      match,
      evidence: match.tombstone.invariant.evidence.map((evidence) => ({ ...evidence })),
      reasonCodes: ['tombstone-match', 'fresh-positive-evidence'],
      advisory: false,
      active,
      reopenAllowed: true,
    };
  }

  return {
    status: 'NEEDS-REVERIFY',
    match,
    evidence: match.tombstone.evidence.map((evidence) => ({ ...evidence })),
    reasonCodes: Array.from(
      new Set<ReasonCode>([
        ...(tombstoneFresh ? [] : (['stale-evidence'] satisfies ReasonCode[])),
        ...invariant.staleReasonCodes,
        ...(invariant.holds ? [] : (['missing-status-proof'] satisfies ReasonCode[])),
      ]),
    ),
    advisory: true,
    active,
    reopenAllowed: false,
  };
}

function matchSingleTombstone(
  finding: AuditFingerprint,
  tombstone: AuditTombstoneRecord,
): AuditTombstoneMatch | null {
  const location = finding.location === tombstone.fingerprint.location;
  const claim = finding.claim === tombstone.fingerprint.claim;
  const history =
    finding.history !== undefined &&
    tombstone.fingerprint.history !== undefined &&
    finding.history === tombstone.fingerprint.history;

  if (location && claim && history) {
    return { tombstone, layer: 'location-claim-history', score: 100 };
  }
  if (location && claim) {
    return { tombstone, layer: 'location-claim', score: 90 };
  }
  if (claim && history) {
    return { tombstone, layer: 'claim-history', score: 80 };
  }
  if (location && history) {
    return { tombstone, layer: 'location-history', score: 70 };
  }
  if (claim) {
    return { tombstone, layer: 'claim', score: 50 };
  }
  return null;
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
