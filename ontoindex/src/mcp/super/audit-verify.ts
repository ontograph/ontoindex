import {
  FINDING_VERIFIER_VERSION,
  LocalAuditEventStore,
  type AuditEvidence as LifecycleEvidence,
  type AuditFinding as LifecycleFinding,
  type AuditFindingVerification,
  type AuditLifecycleStatus,
  type VerifyFindingResult,
  verifyFindingFreshEvidence,
} from '../../core/audit-lifecycle/index.js';
import { createEnvelopeFromLegacy } from '../shared/response-envelope.js';
import { resolveTargetContext } from '../shared/target-context.js';
import { clampLimit, resolveAuditRepoHandle } from './audit-ingest.js';

export interface AuditVerifyParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  findingId?: string;
  finding?: LifecycleFinding;
  graphIndexId?: string;
  maxFindings?: number;
  maxEvidence?: number;
  maxTestFiles?: number;
  persist?: boolean;
  legacyResponse?: boolean;
}

const DEFAULT_MAX_EVIDENCE = 25;

export async function gnAuditVerify(
  repoId: string,
  params: AuditVerifyParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  return runAuditVerify(repo.repoPath, params, repo.id);
}

export async function runAuditVerify(
  repoPath: string,
  params: AuditVerifyParams,
  repoNameOrPath = repoPath,
): Promise<Record<string, unknown>> {
  const sessionId = params.sessionId ?? params.session;
  const findings = params.finding
    ? [normalizeInlineFinding(params.finding)]
    : await loadLifecycleFindings(repoPath, sessionId, params.findingId);
  const maxFindings = clampLimit(params.maxFindings, 25);
  const maxEvidence = clampLimit(params.maxEvidence, DEFAULT_MAX_EVIDENCE);
  const selected = findings.slice(0, maxFindings);
  const results: VerifyFindingResult[] = [];

  for (const finding of selected) {
    results.push(
      await verifyFindingFreshEvidence({
        repoPath,
        finding,
        graphIndexId: params.graphIndexId,
        maxTestFiles: params.maxTestFiles,
      }),
    );
  }

  if (params.persist !== false && sessionId) {
    await persistVerifyResults(repoPath, sessionId, results);
  }

  const report = {
    version: 1,
    action: 'audit-verify',
    sessionId,
    verifiedCount: results.length,
    findings: results.map((result) => summarizeVerifyResult(result, maxEvidence)),
    limits: {
      maxFindings,
      maxEvidence,
      emitted: results.length,
      total: findings.length,
      truncated: results.length < findings.length,
    },
    warnings: [...new Set(results.flatMap((result) => result.warnings))],
    skipReasons: [],
  };
  if (params.legacyResponse !== false) {
    return report;
  }

  const targetContext = await resolveTargetContext({
    repo: params.repo ?? repoNameOrPath,
  });

  return createEnvelopeFromLegacy({
    legacy: report as Record<string, unknown>,
    tool: 'gn_audit_verify',
    status: report.warnings.length > 0 || report.limits.truncated ? 'degraded' : 'ok',
    targetContext,
    capabilitiesUsed: ['audit-lifecycle', 'filesystem-evidence', 'git-history', 'freshness-policy'],
    nextTools: ['gn_fix_history', 'gn_audit_dedupe', 'gn_audit_bundle'],
    evidence: results.flatMap((result) => [
      ...result.evidence.slice(0, maxEvidence),
      ...result.negativeEvidence.slice(0, maxEvidence),
    ]),
  });
}

function normalizeInlineFinding(value: unknown): LifecycleFinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('inline finding must be an object');
  }
  const finding = value as Record<string, unknown>;
  const source = normalizeFindingSource(finding.source);
  const fingerprint = normalizeFingerprint(finding.fingerprint);
  return {
    findingId: requiredString(finding.findingId, 'finding.findingId'),
    title: requiredString(finding.title, 'finding.title'),
    severity: normalizeSeverity(finding.severity),
    status: normalizeStatus(finding.status),
    source,
    targetRepo: requiredString(finding.targetRepo, 'finding.targetRepo'),
    ...(optionalString(finding.targetRef) ? { targetRef: optionalString(finding.targetRef) } : {}),
    targetHead: requiredString(finding.targetHead, 'finding.targetHead'),
    graphIndexId: requiredString(finding.graphIndexId, 'finding.graphIndexId'),
    claimedEvidence: stringArray(finding.claimedEvidence),
    verifiedEvidence: evidenceArray(finding.verifiedEvidence),
    negativeEvidence: evidenceArray(finding.negativeEvidence),
    statusReason: optionalString(finding.statusReason) ?? '',
    fixCommit: nullableString(finding.fixCommit),
    confidence: typeof finding.confidence === 'number' ? finding.confidence : 0,
    reasonCodes: reasonCodeArray(finding.reasonCodes),
    fingerprint,
    claimDsl:
      finding.claimDsl && typeof finding.claimDsl === 'object' && !Array.isArray(finding.claimDsl)
        ? (finding.claimDsl as LifecycleFinding['claimDsl'])
        : null,
    verificationKind: normalizeVerificationKind(finding.verificationKind),
    verifiedAt: nullableString(finding.verifiedAt),
    verifiedHead: nullableString(finding.verifiedHead),
    statusChangedAt: nullableString(finding.statusChangedAt),
    statusChangedBy: optionalString(finding.statusChangedBy) ?? 'ontoindex',
    statusTransitionEvidence: evidenceArray(finding.statusTransitionEvidence),
    reopenTrigger:
      finding.reopenTrigger &&
      typeof finding.reopenTrigger === 'object' &&
      !Array.isArray(finding.reopenTrigger)
        ? (finding.reopenTrigger as LifecycleFinding['reopenTrigger'])
        : null,
    blocker:
      finding.blocker && typeof finding.blocker === 'object' && !Array.isArray(finding.blocker)
        ? (finding.blocker as LifecycleFinding['blocker'])
        : null,
    ...(finding.decisionGate &&
    typeof finding.decisionGate === 'object' &&
    !Array.isArray(finding.decisionGate)
      ? { decisionGate: finding.decisionGate as NonNullable<LifecycleFinding['decisionGate']> }
      : {}),
    tombstoneMatch: nullableString(finding.tombstoneMatch),
  };
}

function normalizeFindingSource(value: unknown): LifecycleFinding['source'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('finding.source must be an object');
  }
  const source = value as Record<string, unknown>;
  return {
    path: requiredString(source.path, 'finding.source.path'),
    hash: requiredString(source.hash, 'finding.source.hash'),
    ingestedAt: requiredString(source.ingestedAt, 'finding.source.ingestedAt'),
    dirtyWorktree: typeof source.dirtyWorktree === 'boolean' ? source.dirtyWorktree : false,
  };
}

function normalizeFingerprint(value: unknown): LifecycleFinding['fingerprint'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('finding.fingerprint must be an object');
  }
  const fingerprint = value as Record<string, unknown>;
  return {
    location: requiredString(fingerprint.location, 'finding.fingerprint.location'),
    claim: requiredString(fingerprint.claim, 'finding.fingerprint.claim'),
    ...(optionalString(fingerprint.history)
      ? { history: optionalString(fingerprint.history) }
      : {}),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function reasonCodeArray(value: unknown): LifecycleFinding['reasonCodes'] {
  return Array.isArray(value)
    ? value.filter((item): item is LifecycleFinding['reasonCodes'][number] => typeof item === 'string')
    : [];
}

function evidenceArray(value: unknown): LifecycleEvidence[] {
  return Array.isArray(value)
    ? value.filter((item): item is LifecycleEvidence => typeof item === 'object' && item !== null)
    : [];
}

function normalizeSeverity(value: unknown): LifecycleFinding['severity'] {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL'
    ? value
    : 'LOW';
}

function normalizeStatus(value: unknown): LifecycleFinding['status'] {
  return value === 'OPEN' ||
    value === 'RESOLVED-ALREADY' ||
    value === 'PARTIAL' ||
    value === 'FALSE-POSITIVE' ||
    value === 'NEEDS-VERIFY' ||
    value === 'DECISION-GATED' ||
    value === 'HOLD' ||
    value === 'NEEDS-REVERIFY'
    ? value
    : 'NEEDS-VERIFY';
}

function normalizeVerificationKind(value: unknown): LifecycleFinding['verificationKind'] {
  return value === 'static' ||
    value === 'dynamic' ||
    value === 'runtime' ||
    value === 'manual' ||
    value === 'hybrid' ||
    value === 'unsupported'
    ? value
    : 'static';
}

export async function loadLifecycleFindings(
  repoPath: string,
  sessionId?: string,
  findingId?: string,
): Promise<LifecycleFinding[]> {
  if (!sessionId) throw new Error('session or finding is required for audit verify');
  const state = await new LocalAuditEventStore(repoPath).load();
  const findings = state.events
    .filter((event) => event.type === 'FindingCandidateCreated')
    .filter((event) => event.sessionId === sessionId)
    .filter((event) => !findingId || event.findingId === findingId)
    .map((event) => event.finding.metadata.auditLifecycleFinding)
    .filter(isLifecycleFinding);

  if (findings.length === 0) {
    throw new Error(`No audit findings found for session ${sessionId}`);
  }
  return findings;
}

function summarizeVerifyResult(
  result: VerifyFindingResult,
  maxEvidence: number,
): Record<string, unknown> {
  const evidence = result.evidence.slice(0, maxEvidence);
  const negativeEvidence = result.negativeEvidence.slice(0, maxEvidence);
  return {
    findingId: result.finding.findingId,
    title: result.finding.title,
    status: result.finding.status,
    statusReason: result.finding.statusReason,
    confidence: result.finding.confidence,
    reasonCodes: result.finding.reasonCodes,
    claimDsl: result.finding.claimDsl,
    claimedEvidence: result.finding.claimedEvidence,
    verifiedAt: result.finding.verifiedAt,
    verifiedHead: result.finding.verifiedHead,
    verificationKind: result.finding.verificationKind,
    fixCommit: result.finding.fixCommit,
    evidence,
    negativeEvidence,
    comments: result.comments.slice(0, maxEvidence),
    testMentions: result.testMentions.slice(0, maxEvidence),
    fixHistory: result.fixHistory.slice(0, maxEvidence),
    limits: {
      maxEvidence,
      evidenceTruncated: evidence.length < result.evidence.length,
      negativeEvidenceTruncated: negativeEvidence.length < result.negativeEvidence.length,
    },
  };
}

async function persistVerifyResults(
  repoPath: string,
  sessionId: string,
  results: readonly VerifyFindingResult[],
): Promise<void> {
  const store = new LocalAuditEventStore(repoPath);
  for (const result of results) {
    const occurredAt = result.finding.verifiedAt ?? new Date().toISOString();
    await store.appendEvent({
      id: `evt-verify-${result.finding.findingId}-${Date.now()}`,
      type: 'FindingVerified',
      occurredAt,
      sessionId,
      findingId: result.finding.findingId,
      verification: toStoreVerification(result.finding.status, result.finding.reasonCodes, [
        ...result.evidence,
        ...result.negativeEvidence,
      ]),
    });
    await store.appendEvent({
      id: `evt-status-${result.finding.findingId}-${Date.now()}`,
      type: 'FindingStatusChanged',
      occurredAt,
      sessionId,
      findingId: result.finding.findingId,
      status: toStoreStatus(result.finding.status),
      reason: result.finding.statusReason,
    });
  }
}

function toStoreVerification(
  status: AuditLifecycleStatus,
  reasonCodes: readonly string[],
  evidence: readonly LifecycleEvidence[],
): AuditFindingVerification {
  return {
    verifiedAt: new Date().toISOString(),
    status: toStoreStatus(status),
    evidence: evidence.map((item) => ({
      id: item.id,
      kind: item.mode,
      targetHead: item.targetHead,
      graphIndexId: item.graphIndexId ?? 'unknown',
      verifierVersion: item.verifierVersion,
      sidecarStateHash: 'sidecar:unavailable',
      confidence: item.confidence === 'high' ? 1 : item.confidence === 'medium' ? 0.5 : 0.1,
      reasonCodes: item.reasonCodes,
      data: { polarity: item.polarity, path: item.path, line: item.line, detail: item.detail },
    })),
    reasonCodes: [...reasonCodes],
    verifierVersion: FINDING_VERIFIER_VERSION,
  };
}

function toStoreStatus(status: AuditLifecycleStatus) {
  return status === 'DECISION-GATED' ? 'HOLD' : status;
}

function isLifecycleFinding(value: unknown): value is LifecycleFinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { findingId?: unknown }).findingId === 'string'
  );
}
