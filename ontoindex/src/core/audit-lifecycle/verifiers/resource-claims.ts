import type {
  AuditEvidence,
  AuditFinding,
  AuditLifecycleStatus,
  AuditStatusProjection,
  Confidence,
  ReasonCode,
} from '../audit-types.js';
import { validateStatusTransition } from '../status-transitions.js';

export type SystemsAuditClaimKind = 'forbidden-call-pattern' | 'missing-cleanup' | 'resource-leak';

export interface SystemsAuditEvidenceProvenance {
  sidecarRelease: string;
  sidecarSchemaVersion: string;
  sidecarStateHash: string;
  recordKind: string;
}

export interface SystemsAuditEvidence {
  id: string;
  claimKind: SystemsAuditClaimKind;
  polarity: 'positive' | 'negative';
  targetHead: string;
  verifiedHead: string;
  verifiedAt: string;
  analyzerId: string;
  analyzerVersion: string;
  confidence: Confidence;
  detail: string;
  path?: string;
  line?: number;
  symbol?: string;
  graphIndexId?: string;
  fileHash?: string;
  provenance?: SystemsAuditEvidenceProvenance;
}

export interface SystemsAuditEvidenceAdapterResult {
  finding: AuditFinding;
  acceptedEvidence: AuditEvidence[];
  rejectedEvidence: SystemsAuditEvidence[];
  projection: AuditStatusProjection;
  warnings: ReasonCode[];
}

const CLAIM_KINDS: ReadonlySet<string> = new Set([
  'forbidden-call-pattern',
  'missing-cleanup',
  'resource-leak',
]);

export function adaptSystemsAuditEvidenceForResourceClaim(input: {
  finding: AuditFinding;
  evidence: readonly SystemsAuditEvidence[];
}): SystemsAuditEvidenceAdapterResult {
  const accepted = input.evidence
    .filter((evidence) => canAdaptSystemsEvidence(input.finding, evidence))
    .map((evidence) => toAuditEvidence(input.finding, evidence));
  const rejected = input.evidence.filter(
    (evidence) => !canAdaptSystemsEvidence(input.finding, evidence),
  );
  const requestedStatus = chooseSystemsEvidenceStatus(input.finding, accepted);
  const candidate = applyEvidence(input.finding, accepted, requestedStatus);
  const projection = validateStatusTransition({
    from: input.finding.status,
    to: requestedStatus,
    finding: candidate,
  });
  const finding = { ...candidate, status: projection.status };

  return {
    finding,
    acceptedEvidence: accepted,
    rejectedEvidence: rejected,
    projection,
    warnings: Array.from(
      new Set<ReasonCode>([
        ...projection.warnings.map((warning) => warning.code),
        ...(rejected.length > 0 ? ['missing-status-proof' as const] : []),
      ]),
    ),
  };
}

export function canAdaptSystemsEvidence(
  finding: AuditFinding,
  evidence: SystemsAuditEvidence,
): boolean {
  const claimKind = finding.claimDsl?.kind;
  return (
    CLAIM_KINDS.has(evidence.claimKind) &&
    claimKind === evidence.claimKind &&
    evidence.provenance !== undefined &&
    evidence.provenance.sidecarRelease.length > 0 &&
    evidence.provenance.sidecarSchemaVersion.length > 0 &&
    evidence.provenance.sidecarStateHash.length > 0 &&
    evidence.provenance.recordKind.length > 0
  );
}

function chooseSystemsEvidenceStatus(
  finding: AuditFinding,
  evidence: readonly AuditEvidence[],
): AuditLifecycleStatus {
  if (evidence.some((item) => item.polarity === 'positive')) return 'OPEN';
  if (evidence.some((item) => item.polarity === 'negative')) return 'RESOLVED-ALREADY';
  return finding.status === 'NEEDS-REVERIFY' ? 'NEEDS-REVERIFY' : 'NEEDS-VERIFY';
}

function applyEvidence(
  finding: AuditFinding,
  evidence: readonly AuditEvidence[],
  status: AuditLifecycleStatus,
): AuditFinding {
  const positive = evidence.filter((item) => item.polarity === 'positive');
  const negative = evidence.filter((item) => item.polarity === 'negative');
  const verifiedAt = latestTimestamp(evidence);
  const verifiedHead = evidence[0]?.verifiedHead ?? finding.verifiedHead;
  const reasonCodes = Array.from(
    new Set<ReasonCode>([...finding.reasonCodes, ...evidence.flatMap((item) => item.reasonCodes)]),
  );

  return {
    ...finding,
    status,
    verifiedAt,
    verifiedHead,
    verifiedEvidence: [...finding.verifiedEvidence, ...positive],
    negativeEvidence: [...finding.negativeEvidence, ...negative],
    statusTransitionEvidence: [...finding.statusTransitionEvidence, ...evidence],
    reasonCodes,
    statusReason:
      evidence.length === 0
        ? 'No provenance-backed systems-audit evidence was available.'
        : 'Systems-audit sidecar evidence evaluated through lifecycle validator.',
    verificationKind: evidence.length > 0 ? 'static' : finding.verificationKind,
  };
}

function toAuditEvidence(finding: AuditFinding, evidence: SystemsAuditEvidence): AuditEvidence {
  return {
    id: `${finding.findingId}:systems:${evidence.id}`,
    mode: 'resource-lifecycle',
    polarity: evidence.polarity,
    targetHead: evidence.targetHead,
    verifiedHead: evidence.verifiedHead,
    verifiedAt: evidence.verifiedAt,
    verifierId: evidence.analyzerId,
    verifierVersion: evidence.analyzerVersion,
    confidence: evidence.confidence,
    reasonCodes: [
      evidence.targetHead === finding.targetHead && evidence.verifiedHead === finding.targetHead
        ? evidence.polarity === 'positive'
          ? 'fresh-positive-evidence'
          : 'fresh-negative-evidence'
        : 'stale-evidence',
    ],
    path: evidence.path,
    line: evidence.line,
    symbol: evidence.symbol,
    detail: `${evidence.detail} Provenance: ${evidence.provenance?.recordKind}@${evidence.provenance?.sidecarSchemaVersion} ${evidence.provenance?.sidecarStateHash}.`,
    graphIndexId: evidence.graphIndexId ?? finding.graphIndexId,
    fileHash: evidence.fileHash,
  };
}

function latestTimestamp(evidence: readonly AuditEvidence[]): string | null {
  return evidence.reduce<string | null>(
    (latest, item) => (latest === null || item.verifiedAt > latest ? item.verifiedAt : latest),
    null,
  );
}
