import {
  type AuditDiffFindingLike,
  type AuditDiffSessionLike,
  type AuditEvidenceSummary,
  findingId,
  fingerprintKey,
  summarizeAuditEvidence,
} from './audit-diff.js';

export type AuditReplayReason =
  | 'status-needs-verification'
  | 'target-head-changed'
  | 'finding-target-head-mismatch'
  | 'verified-head-mismatch'
  | 'evidence-target-head-mismatch';

export type AuditReplayAction = 'verify' | 'reverify';

export interface AuditReplayFindingPlan {
  id: string;
  fingerprint?: string;
  status: string;
  title?: string;
  action: AuditReplayAction;
  targetHead: string;
  previousTargetHead?: string;
  evidence: AuditEvidenceSummary;
  reasons: AuditReplayReason[];
}

export interface AuditReplayPlan {
  session: {
    id: string;
    targetHead?: string;
    graphIndexId?: string;
    verifierVersion?: string;
    sidecarStateHash?: string;
  };
  targetHead: string;
  findings: AuditReplayFindingPlan[];
}

export function buildAuditReplayPlan(
  session: AuditDiffSessionLike,
  findings: readonly AuditDiffFindingLike[],
  targetHead: string,
): AuditReplayPlan {
  const normalizedTargetHead = requireTargetHead(targetHead);
  const sessionTargetHead = session.targetHead?.trim();

  return {
    session: {
      id: sessionId(session),
      ...(sessionTargetHead !== undefined && sessionTargetHead.length > 0
        ? { targetHead: sessionTargetHead }
        : {}),
      ...(session.graphIndexId !== undefined ? { graphIndexId: session.graphIndexId } : {}),
      ...(session.verifierVersion !== undefined
        ? { verifierVersion: session.verifierVersion }
        : {}),
      ...(session.sidecarStateHash !== undefined
        ? { sidecarStateHash: session.sidecarStateHash }
        : {}),
    },
    targetHead: normalizedTargetHead,
    findings: findings
      .map((finding) => planFindingReplay(finding, sessionTargetHead, normalizedTargetHead))
      .filter((finding): finding is AuditReplayFindingPlan => finding !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function planFindingReplay(
  finding: AuditDiffFindingLike,
  sessionTargetHead: string | undefined,
  targetHead: string,
): AuditReplayFindingPlan | undefined {
  const reasons = replayReasons(finding, sessionTargetHead, targetHead);
  if (reasons.length === 0) {
    return undefined;
  }

  const fingerprint = fingerprintKey(finding.fingerprint);
  const previousTargetHead = finding.targetHead ?? sessionTargetHead;

  return {
    id: findingId(finding),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    status: finding.status,
    ...(finding.title !== undefined ? { title: finding.title } : {}),
    action: finding.status === 'NEEDS-VERIFY' ? 'verify' : 'reverify',
    targetHead,
    ...(previousTargetHead !== undefined ? { previousTargetHead } : {}),
    evidence: summarizeAuditEvidence(finding),
    reasons,
  };
}

function replayReasons(
  finding: AuditDiffFindingLike,
  sessionTargetHead: string | undefined,
  targetHead: string,
): AuditReplayReason[] {
  const reasons = new Set<AuditReplayReason>();
  const findingTargetHead = finding.targetHead;
  const verifiedHead = finding.verifiedHead ?? undefined;
  const evidence = [
    ...(finding.evidence ?? []),
    ...(finding.verifiedEvidence ?? []),
    ...(finding.negativeEvidence ?? []),
    ...(finding.statusTransitionEvidence ?? []),
  ];
  const findingFreshAtTarget =
    findingTargetHead === targetHead &&
    (verifiedHead === undefined || verifiedHead === targetHead) &&
    evidence.every(
      (item) =>
        (item.targetHead === undefined || item.targetHead === targetHead) &&
        (item.verifiedHead === undefined || item.verifiedHead === targetHead),
    );

  if (finding.status === 'NEEDS-VERIFY' || finding.status === 'NEEDS-REVERIFY') {
    reasons.add('status-needs-verification');
  }
  if (
    sessionTargetHead !== undefined &&
    sessionTargetHead.length > 0 &&
    sessionTargetHead !== targetHead &&
    !findingFreshAtTarget
  ) {
    reasons.add('target-head-changed');
  }
  if (findingTargetHead !== undefined && findingTargetHead !== targetHead) {
    reasons.add('finding-target-head-mismatch');
  }
  if (verifiedHead !== undefined && verifiedHead !== targetHead) {
    reasons.add('verified-head-mismatch');
  }
  if (
    evidence.some(
      (item) =>
        (item.targetHead !== undefined && item.targetHead !== targetHead) ||
        (item.verifiedHead !== undefined && item.verifiedHead !== targetHead),
    )
  ) {
    reasons.add('evidence-target-head-mismatch');
  }

  return [...reasons].sort();
}

function sessionId(session: AuditDiffSessionLike): string {
  const id = session.id ?? session.sessionId;
  if (id === undefined || id.trim().length === 0) {
    throw new Error('audit session must include id or sessionId');
  }
  return id;
}

function requireTargetHead(targetHead: string): string {
  const normalized = targetHead.trim();
  if (normalized.length === 0) {
    throw new Error('targetHead must be a non-empty string');
  }
  return normalized;
}
