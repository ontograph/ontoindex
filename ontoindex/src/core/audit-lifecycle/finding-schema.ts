import type {
  AuditEvidence,
  AuditFinding,
  AuditLifecycleStatus,
  AuditStatusProjection,
  AuditValidationIssue,
  ReasonCode,
} from './audit-types.js';
import { classifyUnsupportedClaim, type VerifierCapability } from './verifier-capabilities.js';

function freshAtTarget(evidence: AuditEvidence, targetHead: string): boolean {
  return evidence.targetHead === targetHead && evidence.verifiedHead === targetHead;
}

function hasFreshEvidence(
  evidence: readonly AuditEvidence[],
  targetHead: string,
  polarities: readonly AuditEvidence['polarity'][],
): boolean {
  return evidence.some(
    (item) => polarities.includes(item.polarity) && freshAtTarget(item, targetHead),
  );
}

function issue(code: ReasonCode, message: string): AuditValidationIssue {
  return { code, message };
}

export function validateFindingLifecycle(
  finding: AuditFinding,
  capabilities?: readonly VerifierCapability[],
): AuditValidationIssue[] {
  const issues: AuditValidationIssue[] = [];
  const unsupported = classifyUnsupportedClaim(finding.claimDsl, capabilities);
  const runtimeOnly = isRuntimeOnlyFinding(finding);

  if (
    (!unsupported.supported || runtimeOnly) &&
    !(finding.status === 'HOLD' && (unsupported.behavior === 'HOLD' || runtimeOnly))
  ) {
    issues.push(
      ...(runtimeOnly
        ? (['runtime-required'] satisfies ReasonCode[])
        : unsupported.reasonCodes
      ).map((code) => issue(code, `claim cannot be machine-verified for status ${finding.status}`)),
    );
  }

  if (finding.verifiedHead && finding.verifiedHead !== finding.targetHead) {
    issues.push(issue('target-head-mismatch', 'verifiedHead must match targetHead'));
  }

  if (finding.verifiedEvidence.some((evidence) => !freshAtTarget(evidence, finding.targetHead))) {
    issues.push(issue('stale-evidence', 'verified evidence must be refreshed at targetHead'));
  }

  switch (finding.status) {
    case 'OPEN':
      if (!unsupported.supported || runtimeOnly) {
        issues.push(issue('unsupported-claim-kind', 'unsupported claims cannot be OPEN'));
      }
      if (
        !hasFreshEvidence(finding.verifiedEvidence, finding.targetHead, ['positive']) ||
        finding.verifiedHead !== finding.targetHead ||
        !finding.verifiedAt
      ) {
        issues.push(
          issue('missing-status-proof', 'OPEN requires fresh positive evidence at targetHead'),
        );
      }
      break;
    case 'RESOLVED-ALREADY':
    case 'FALSE-POSITIVE':
      if (
        !hasFreshEvidence(finding.negativeEvidence, finding.targetHead, [
          'negative',
          'fix-proof',
          'tombstone-proof',
        ])
      ) {
        issues.push(
          issue(
            'missing-status-proof',
            `${finding.status} requires negative evidence, fix proof, or tombstone proof`,
          ),
        );
      }
      break;
    case 'HOLD':
      if (!finding.blocker) {
        issues.push(issue('missing-blocker-metadata', 'HOLD requires blocker metadata'));
      }
      if (!finding.reopenTrigger) {
        issues.push(issue('missing-reopen-trigger', 'HOLD requires a reopen trigger'));
      }
      if (!['runtime', 'dynamic', 'manual', 'unsupported'].includes(finding.verificationKind)) {
        issues.push(
          issue(
            'runtime-required',
            'HOLD requires runtime, external, manual, or unsupported verification context',
          ),
        );
      }
      break;
    case 'DECISION-GATED':
      if (!finding.decisionGate) {
        issues.push(
          issue('decision-required', 'DECISION-GATED requires owner and unblock condition'),
        );
      }
      break;
    case 'PARTIAL':
      if (!hasFreshEvidence(finding.verifiedEvidence, finding.targetHead, ['positive'])) {
        issues.push(issue('partial-verification', 'PARTIAL requires some fresh positive evidence'));
      }
      break;
    case 'NEEDS-VERIFY':
    case 'NEEDS-REVERIFY':
      break;
  }

  return issues;
}

export function projectFindingStatus(
  finding: AuditFinding,
  capabilities?: readonly VerifierCapability[],
): AuditStatusProjection {
  const issues = validateFindingLifecycle(finding, capabilities);
  const reasonCodes = Array.from(new Set(issues.map((validationIssue) => validationIssue.code)));

  if (finding.status === 'OPEN' && reasonCodes.length === 0) {
    return { status: 'OPEN', reasonCodes: ['fresh-positive-evidence'], warnings: [] };
  }

  if (finding.status === 'OPEN') {
    return { status: 'NEEDS-VERIFY', reasonCodes, warnings: issues };
  }

  if (finding.status === 'HOLD') {
    return {
      status: reasonCodes.length === 0 ? 'HOLD' : 'NEEDS-VERIFY',
      reasonCodes,
      warnings: issues,
    };
  }

  if (
    (finding.status === 'RESOLVED-ALREADY' || finding.status === 'FALSE-POSITIVE') &&
    reasonCodes.includes('missing-status-proof')
  ) {
    return { status: 'NEEDS-VERIFY', reasonCodes, warnings: issues };
  }

  if (reasonCodes.includes('stale-evidence') || reasonCodes.includes('target-head-mismatch')) {
    return { status: 'NEEDS-REVERIFY', reasonCodes, warnings: issues };
  }

  return { status: finding.status, reasonCodes, warnings: issues };
}

export function assertValidFindingStatus(
  finding: AuditFinding,
  capabilities?: readonly VerifierCapability[],
): AuditFinding {
  const issues = validateFindingLifecycle(finding, capabilities);
  if (issues.length > 0) {
    throw new Error(
      `Invalid audit finding ${finding.findingId}: ${issues
        .map((validationIssue) => validationIssue.code)
        .join(', ')}`,
    );
  }
  return finding;
}

export function createFindingWithProjectedStatus(
  finding: AuditFinding,
  capabilities?: readonly VerifierCapability[],
): AuditFinding {
  const projection = projectFindingStatus(finding, capabilities);
  return {
    ...finding,
    status: projection.status as AuditLifecycleStatus,
    reasonCodes: Array.from(new Set([...finding.reasonCodes, ...projection.reasonCodes])),
  };
}

function isRuntimeOnlyFinding(finding: AuditFinding): boolean {
  if (finding.claimDsl?.requiresRuntime || finding.claimDsl?.evidenceMode === 'runtime')
    return true;
  if (finding.verificationKind === 'runtime') return true;
  if (finding.reasonCodes.includes('runtime-required')) return true;
  if (finding.verifiedEvidence.some((evidence) => evidence.mode === 'runtime')) return true;
  return hasRuntimeOnlyHeuristic(
    [
      finding.title,
      finding.statusReason,
      finding.claimedEvidence.join('\n'),
      finding.claimDsl?.kind,
      finding.claimDsl?.risk,
      JSON.stringify(finding.claimDsl?.pattern ?? {}),
    ]
      .filter((item): item is string => typeof item === 'string')
      .join('\n'),
  );
}

function hasRuntimeOnlyHeuristic(value: string): boolean {
  return /\b(runtime|telemetry|cgroup(?:s)?|host behavior|privileged container|load-only|race under load|under load)\b/i.test(
    value,
  );
}
