import type {
  AuditBundle,
  AuditFinding,
  AuditFindingStatus,
  AuditSession,
} from './audit-session.js';
import type { AuditEvent } from './audit-event-store.js';

export const AUDIT_PROJECTION_SCHEMA_VERSION = 1;

export interface AuditProjection {
  schemaVersion: typeof AUDIT_PROJECTION_SCHEMA_VERSION;
  rebuiltAt: string;
  lastEventId?: string;
  sessions: AuditSession[];
  findings: AuditFinding[];
  bundles: AuditBundle[];
  lintRuns: Array<{
    id: string;
    sessionId: string;
    status: string;
    findingIds: string[];
    lintedAt: string;
    warnings: string[];
  }>;
  scopeGuardEvaluations: Array<{
    id: string;
    sessionId: string;
    status: string;
    evaluatedAt: string;
    metadata: Record<string, unknown>;
  }>;
}

export function buildAuditProjection(
  events: readonly AuditEvent[],
  rebuiltAt = new Date().toISOString(),
): AuditProjection {
  const sessions = new Map<string, AuditSession>();
  const findings = new Map<string, AuditFinding>();
  const bundles = new Map<string, AuditBundle>();
  const lintRuns: AuditProjection['lintRuns'] = [];
  const scopeGuardEvaluations: AuditProjection['scopeGuardEvaluations'] = [];
  let lastEventId: string | undefined;

  for (const event of events) {
    lastEventId = event.id;
    switch (event.type) {
      case 'AuditIngested':
        sessions.set(event.session.id, {
          ...event.session,
          metadata: { ...event.session.metadata },
        });
        break;
      case 'FindingCandidateCreated':
        findings.set(event.finding.id, {
          ...event.finding,
          evidence: [...event.finding.evidence],
          metadata: { ...event.finding.metadata },
          updatedAt: event.occurredAt,
        });
        break;
      case 'FindingVerified':
        updateFinding(findings, event.findingId, event.occurredAt, (finding) => ({
          ...finding,
          status: event.verification.status,
          verification: {
            ...event.verification,
            evidence: [...event.verification.evidence],
            reasonCodes: [...event.verification.reasonCodes],
          },
          evidence: [...finding.evidence, ...event.verification.evidence],
        }));
        break;
      case 'FindingStatusChanged':
        updateFinding(findings, event.findingId, event.occurredAt, (finding) => ({
          ...finding,
          status: event.status,
        }));
        break;
      case 'FindingTombstoned':
        updateFinding(findings, event.findingId, event.occurredAt, (finding) => ({
          ...finding,
          status: 'TOMBSTONED',
          tombstone: {
            ...event.tombstone,
            evidence: [...event.tombstone.evidence],
          },
          evidence: [...finding.evidence, ...event.tombstone.evidence],
        }));
        break;
      case 'FindingBundled':
        bundles.set(event.bundle.id, {
          ...event.bundle,
          findingIds: [...event.bundle.findingIds].sort(),
          metadata: { ...event.bundle.metadata },
        });
        for (const findingId of event.bundle.findingIds) {
          updateFinding(findings, findingId, event.occurredAt, (finding) => ({
            ...finding,
            status: 'BUNDLED',
            bundleId: event.bundle.id,
          }));
        }
        break;
      case 'BundleDispatched':
        updateBundle(bundles, event.bundleId, (bundle) => ({
          ...bundle,
          status: 'DISPATCHED',
          dispatchedAt: event.dispatchedAt,
        }));
        for (const findingId of bundles.get(event.bundleId)?.findingIds ?? []) {
          updateFinding(findings, findingId, event.occurredAt, (finding) => ({
            ...finding,
            status: 'DISPATCHED',
          }));
        }
        break;
      case 'AuditLinted':
        lintRuns.push({
          id: event.id,
          sessionId: event.sessionId,
          status: event.status,
          findingIds: [...event.findingIds].sort(),
          lintedAt: event.occurredAt,
          warnings: [...event.warnings].sort(),
        });
        break;
      case 'ScopeGuardEvaluated':
        scopeGuardEvaluations.push({
          id: event.id,
          sessionId: event.sessionId,
          status: event.status,
          evaluatedAt: event.occurredAt,
          metadata: { ...event.metadata },
        });
        break;
    }
  }

  return {
    schemaVersion: AUDIT_PROJECTION_SCHEMA_VERSION,
    rebuiltAt,
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    sessions: [...sessions.values()].sort(byId),
    findings: [...findings.values()].sort(byId),
    bundles: [...bundles.values()].sort(byId),
    lintRuns: lintRuns.sort(byId),
    scopeGuardEvaluations: scopeGuardEvaluations.sort(byId),
  };
}

function updateFinding(
  findings: Map<string, AuditFinding>,
  findingId: string,
  updatedAt: string,
  update: (finding: AuditFinding) => AuditFinding,
): void {
  const current = findings.get(findingId);
  if (current === undefined) {
    throw new Error(`finding does not exist in projection: ${findingId}`);
  }
  findings.set(findingId, { ...update(current), updatedAt });
}

function updateBundle(
  bundles: Map<string, AuditBundle>,
  bundleId: string,
  update: (bundle: AuditBundle) => AuditBundle,
): void {
  const current = bundles.get(bundleId);
  if (current === undefined) {
    throw new Error(`bundle does not exist in projection: ${bundleId}`);
  }
  bundles.set(bundleId, update(current));
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

export function isTerminalAuditStatus(status: AuditFindingStatus): boolean {
  return status === 'RESOLVED-ALREADY' || status === 'FALSE-POSITIVE' || status === 'TOMBSTONED';
}
