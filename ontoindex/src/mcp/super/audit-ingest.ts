import path from 'node:path';

import {
  FINDING_VERIFIER_VERSION,
  LocalAuditEventStore,
  type AuditFindingInput,
  type AuditFindingIngestResult,
  ingestAuditFindings,
} from '../../core/audit-lifecycle/index.js';
import { listRegisteredRepos } from '../../storage/repo-manager.js';

export interface AuditIngestParams {
  repo?: string;
  report?: string;
  sourcePath?: string;
  sourceText?: string;
  target?: string;
  targetRef?: string;
  graphIndexId?: string;
  persist?: boolean;
  maxFindings?: number;
}

export interface AuditRepoHandle {
  id: string;
  repoPath: string;
}

const DEFAULT_MAX_FINDINGS = 25;
const MAX_FINDINGS = 100;

export async function gnAuditIngest(
  repoId: string,
  params: AuditIngestParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  return runAuditIngest(repo.repoPath, params);
}

export async function runAuditIngest(
  repoPath: string,
  params: AuditIngestParams,
): Promise<Record<string, unknown>> {
  const result = await ingestAuditFindings({
    repoPath,
    targetRepo: path.basename(repoPath),
    targetRef: params.targetRef ?? params.target,
    sourcePath: params.sourcePath ?? params.report,
    sourceText: params.sourceText,
    graphIndexId: params.graphIndexId,
  });

  if (params.persist !== false) {
    await persistIngest(repoPath, result);
  }

  return summarizeIngest(result, clampLimit(params.maxFindings));
}

export async function resolveAuditRepoHandle(
  repoId: string,
  requestedRepo?: string,
): Promise<AuditRepoHandle> {
  const target = requestedRepo ?? repoId;
  if (path.isAbsolute(target)) {
    return { id: path.basename(target), repoPath: target };
  }

  const repos = await listRegisteredRepos();
  const repo = repos.find(
    (entry) =>
      entry.name === repoId ||
      entry.path === repoId ||
      entry.name === requestedRepo ||
      entry.path === requestedRepo,
  );
  if (!repo) throw new Error(`Repository not found: ${target}`);
  return { id: repo.name, repoPath: repo.path };
}

export function clampLimit(value: unknown, defaultValue = DEFAULT_MAX_FINDINGS): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(1, Math.min(MAX_FINDINGS, parsed));
}

export function summarizeIngest(
  result: AuditFindingIngestResult,
  maxFindings = DEFAULT_MAX_FINDINGS,
): Record<string, unknown> {
  const emittedFindings = result.findings.slice(0, maxFindings);
  return {
    version: 1,
    action: 'audit-ingest',
    sessionId: result.sessionId,
    targetRepo: result.targetRepo,
    targetRef: result.targetRef,
    targetHead: result.targetHead,
    sourcePath: result.sourcePath,
    sourceHash: result.sourceHash,
    graphIndexId: result.graphIndexId,
    rawCount: result.rawCount,
    dedupedCount: result.dedupedCount,
    duplicatesCollapsed: result.duplicatesCollapsed,
    duplicateGroups: result.duplicateGroups,
    freshness: result.freshness,
    freshnessMetadata: result.freshnessMetadata,
    findings: emittedFindings.map((finding) => ({
      findingId: finding.findingId,
      title: finding.title,
      severity: finding.severity,
      status: finding.status,
      statusReason: finding.statusReason,
      reasonCodes: finding.reasonCodes,
      sourceLine: finding.sourceLine,
      claimedEvidence: finding.claimedEvidence,
      evidenceQuality: finding.evidenceQuality,
      duplicateChildren: finding.duplicateChildren,
      claimDsl: finding.claimDsl,
    })),
    limits: {
      maxFindings,
      emitted: emittedFindings.length,
      total: result.findings.length,
      truncated: emittedFindings.length < result.findings.length,
    },
    warnings: result.freshnessMetadata.warnings,
    skipReasons: [],
  };
}

async function persistIngest(repoPath: string, result: AuditFindingIngestResult): Promise<void> {
  const store = new LocalAuditEventStore(repoPath);
  await store.createSession({
    id: result.sessionId,
    targetRepo: result.targetRepo,
    targetHead: result.targetHead,
    sourceHash: result.sourceHash,
    graphIndexId: result.graphIndexId,
    verifierVersion: FINDING_VERIFIER_VERSION,
    sidecarStateHash: result.freshness.sidecarStateHash ?? 'sidecar:unavailable',
    createdAt: result.ingestedAt,
    sourcePath: result.sourcePath,
    metadata: {
      targetRef: result.targetRef,
      rawCount: result.rawCount,
      dedupedCount: result.dedupedCount,
      duplicatesCollapsed: result.duplicatesCollapsed,
      freshnessMetadata: result.freshnessMetadata,
    },
  });

  for (const finding of result.findings) {
    await store.createFindingCandidate({
      id: finding.findingId,
      sessionId: result.sessionId,
      title: finding.title,
      fingerprint: JSON.stringify(finding.fingerprint),
      status: 'NEEDS-VERIFY',
      summary: finding.statusReason,
      severity: finding.severity,
      metadata: {
        auditLifecycleFinding: finding,
      },
    } satisfies AuditFindingInput);
  }
}
