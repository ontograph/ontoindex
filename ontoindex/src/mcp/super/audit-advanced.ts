import {
  buildAuditBundleProjectionFromEvents,
  buildAuditProjection,
  buildFindingDedupeProjection,
  evaluateAuditScopeGuard,
  generateAuditDispatchPrompt,
  LocalAuditEventStore,
  type AuditImplementationBundle,
  type AuditSessionBundle,
  type AuditSessionEvidence,
  type AuditSessionFinding,
  type AuditStoreSession,
  type DedupeStrategy,
} from '../../core/audit-lifecycle/index.js';
import { clampLimit, resolveAuditRepoHandle } from './audit-ingest.js';

export interface AuditDedupeParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  strategy?: DedupeStrategy;
  maxGroups?: number;
}

export interface AuditDispatchPromptParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  bundleId?: string;
  strategy?: DedupeStrategy;
  redactionMode?: 'none' | 'paths' | 'snippets' | 'sensitive';
  forbidUnverifiedFindings?: boolean;
  allowRuntimeOnlyFindings?: boolean;
  persist?: boolean;
  maxPromptChars?: number;
}

export interface AuditTombstoneCreateParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  findingId: string;
  reason: string;
  invariantId?: string;
  fixCommit?: string;
  evidence?: AuditSessionEvidence[];
  persist?: boolean;
}

export interface AuditScopeGuardParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  bundleId: string;
  changedFiles?: string[];
  changedSymbols?: string[];
  executedTests?: string[];
  requiredTests?: string[];
  persist?: boolean;
}

export interface BundleConflictsParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  bundleIds?: string[];
  strategy?: DedupeStrategy;
  maxConflicts?: number;
}

export async function gnAuditDedupe(
  repoId: string,
  params: AuditDedupeParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const { sessionId, projection } = await loadAuditProjection(repo.repoPath, params);
  const strategies = params.strategy === undefined ? undefined : [params.strategy];
  const dedupe = buildFindingDedupeProjection(
    projection.findings.filter((finding) => finding.sessionId === sessionId),
    strategies,
  );
  const maxGroups = clampLimit(params.maxGroups, 50);
  const groups = dedupe.groups.slice(0, maxGroups);
  return {
    version: 1,
    action: 'audit-dedupe',
    sessionId,
    groups,
    findingToGroups: dedupe.findingToGroups,
    limits: {
      maxGroups,
      emitted: groups.length,
      total: dedupe.groups.length,
      truncated: groups.length < dedupe.groups.length,
    },
    warnings: [],
    skipReasons: [],
  };
}

export async function gnDispatchPrompt(
  repoId: string,
  params: AuditDispatchPromptParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const { sessionId, projection, state } = await loadAuditProjection(repo.repoPath, params);
  const session = requireSession(projection.sessions, sessionId);
  const bundles = loadImplementationBundles(state.events, projection, sessionId, params.strategy);
  const selected = selectBundle(bundles, params.bundleId);
  const findings = projection.findings.filter((finding) =>
    selected.findingIds.includes(finding.id),
  );
  if (params.forbidUnverifiedFindings !== false) assertDispatchFindingsVerified(findings);
  if (params.allowRuntimeOnlyFindings !== true) assertNoRuntimeOnlyFindings(findings);

  const result = generateAuditDispatchPrompt({
    session,
    bundles: [selected],
    findings: undefined,
    bundleId: selected.id,
    verificationTimestamp: new Date().toISOString(),
    redactionMode: params.redactionMode,
    allowUnverifiedFindings: true,
    allowRuntimeOnlyFindings: true,
  });

  if (params.persist !== false) {
    await new LocalAuditEventStore(repo.repoPath).appendEvent({
      id: `evt-dispatch-${selected.id}-${Date.now()}`,
      type: 'BundleDispatched',
      occurredAt: result.verificationTimestamp,
      sessionId,
      bundleId: selected.id,
      dispatchedAt: result.verificationTimestamp,
      metadata: {
        redactionMode: result.redactionMode,
        promptLength: result.prompt.length,
      },
    });
  }

  const maxPromptChars = clampLimit(params.maxPromptChars, 20_000);
  return {
    version: 1,
    action: 'dispatch-prompt',
    sessionId,
    bundleId: result.bundleId,
    targetHead: result.targetHead,
    verificationTimestamp: result.verificationTimestamp,
    redactionMode: result.redactionMode,
    prompt: result.prompt.slice(0, maxPromptChars),
    limits: {
      maxPromptChars,
      promptChars: result.prompt.length,
      truncated: result.prompt.length > maxPromptChars,
    },
    warnings: [],
    skipReasons: [],
  };
}

export async function gnAuditTombstoneCreate(
  repoId: string,
  params: AuditTombstoneCreateParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const { sessionId, projection } = await loadAuditProjection(repo.repoPath, params);
  const session = requireSession(projection.sessions, sessionId);
  const finding = projection.findings.find(
    (candidate) => candidate.sessionId === sessionId && candidate.id === params.findingId,
  );
  if (finding === undefined) throw new Error(`finding does not exist: ${params.findingId}`);

  const occurredAt = new Date().toISOString();
  const evidence =
    params.evidence?.length === undefined || params.evidence.length === 0
      ? [defaultTombstoneEvidence(session, finding, occurredAt, params.reason)]
      : params.evidence;
  const tombstone = {
    tombstonedAt: occurredAt,
    reason: params.reason,
    ...(params.invariantId !== undefined ? { invariantId: params.invariantId } : {}),
    evidence,
  };

  if (params.persist !== false) {
    await new LocalAuditEventStore(repo.repoPath).appendEvent({
      id: `evt-tombstone-${params.findingId}-${Date.now()}`,
      type: 'FindingTombstoned',
      occurredAt,
      sessionId,
      findingId: params.findingId,
      tombstone,
    });
  }

  return {
    version: 1,
    action: 'audit-tombstone-create',
    sessionId,
    findingId: params.findingId,
    status: 'TOMBSTONED',
    tombstone,
    fixCommit: params.fixCommit ?? null,
    warnings: [],
    skipReasons: [],
  };
}

export async function gnScopeGuard(
  repoId: string,
  params: AuditScopeGuardParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const { sessionId, projection, state } = await loadAuditProjection(repo.repoPath, params);
  const bundles = loadImplementationBundles(state.events, projection, sessionId);
  const bundle = selectBundle(bundles, params.bundleId);
  const result = evaluateAuditScopeGuard({
    bundle,
    allBundles: bundles,
    changedFiles: params.changedFiles,
    changedSymbols: params.changedSymbols,
    executedTests: params.executedTests,
    requiredTests: params.requiredTests,
  });

  if (params.persist !== false) {
    await new LocalAuditEventStore(repo.repoPath).appendEvent({
      id: `evt-scope-guard-${bundle.id}-${Date.now()}`,
      type: 'ScopeGuardEvaluated',
      occurredAt: new Date().toISOString(),
      sessionId,
      status: result.status,
      metadata: {
        bundleId: bundle.id,
        issues: result.issues,
        changedFiles: params.changedFiles ?? [],
        changedSymbols: params.changedSymbols ?? [],
        executedTests: params.executedTests ?? [],
      },
    });
  }

  return {
    version: 1,
    action: 'scope-guard',
    sessionId,
    ...result,
    warnings: [],
    skipReasons: [],
  };
}

export async function gnBundleConflicts(
  repoId: string,
  params: BundleConflictsParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const { sessionId, projection, state } = await loadAuditProjection(repo.repoPath, params);
  const requested = new Set(params.bundleIds ?? []);
  const bundles = loadImplementationBundles(state.events, projection, sessionId, params.strategy);
  const conflicts = buildAuditBundleProjectionFromEvents(state.events, sessionId, {
    strategy: params.strategy,
  }).conflicts.filter(
    (conflict) => requested.size === 0 || conflict.bundleIds.some((id) => requested.has(id)),
  );
  const maxConflicts = clampLimit(params.maxConflicts, 50);
  return {
    version: 1,
    action: 'bundle-conflicts',
    sessionId,
    bundleCount: bundles.length,
    conflicts: conflicts.slice(0, maxConflicts),
    limits: {
      maxConflicts,
      emitted: Math.min(conflicts.length, maxConflicts),
      total: conflicts.length,
      truncated: conflicts.length > maxConflicts,
    },
    warnings: [],
    skipReasons: [],
  };
}

async function loadAuditProjection(
  repoPath: string,
  params: { session?: string; sessionId?: string },
) {
  const sessionId = params.sessionId ?? params.session;
  if (!sessionId) throw new Error('session is required');
  const state = await new LocalAuditEventStore(repoPath).load();
  return { sessionId, state, projection: buildAuditProjection(state.events) };
}

function requireSession(
  sessions: readonly AuditStoreSession[],
  sessionId: string,
): AuditStoreSession {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`audit session does not exist: ${sessionId}`);
  return session;
}

function loadImplementationBundles(
  events: Parameters<typeof buildAuditBundleProjectionFromEvents>[0],
  projection: ReturnType<typeof buildAuditProjection>,
  sessionId: string,
  strategy?: DedupeStrategy,
): AuditImplementationBundle[] {
  const generated = buildAuditBundleProjectionFromEvents(events, sessionId, { strategy }).bundles;
  const persisted = projection.bundles
    .filter((bundle) => bundle.sessionId === sessionId)
    .map((bundle) => fromPersistedBundle(bundle));
  const byId = new Map<string, AuditImplementationBundle>();
  for (const bundle of [...generated, ...persisted]) byId.set(bundle.id, bundle);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function fromPersistedBundle(bundle: AuditSessionBundle): AuditImplementationBundle {
  const files = metadataStrings(bundle.metadata.files);
  const symbols = metadataStrings(bundle.metadata.symbols);
  const tests = metadataStrings(bundle.metadata.tests);
  const writeSet = metadataStrings(bundle.metadata.writeSet);
  const rootCauseId = metadataString(bundle.metadata.rootCauseId) ?? `root-cause:${bundle.id}`;
  return {
    id: bundle.id,
    sessionId: bundle.sessionId,
    rootCauseId,
    strategy:
      (metadataString(bundle.metadata.strategy) as DedupeStrategy | undefined) ?? 'root-cause',
    status: 'CREATED',
    findingIds: [...bundle.findingIds].sort(),
    duplicateFindingIds: metadataStrings(bundle.metadata.duplicateFindingIds),
    files,
    symbols,
    tests,
    writeSet,
    estimatedLoc:
      typeof bundle.metadata.estimatedLoc === 'number' ? bundle.metadata.estimatedLoc : 0,
    nonScope: metadataStrings(bundle.metadata.nonScope),
    stopConditions: metadataStrings(bundle.metadata.stopConditions),
    rootCause: {
      id: rootCauseId,
      title: rootCauseId,
      files,
      symbols,
      writeSet,
      testSurface: tests,
      findingIds: [...bundle.findingIds].sort(),
    },
    conflicts: [],
    createdAt: bundle.createdAt,
  };
}

function selectBundle(
  bundles: readonly AuditImplementationBundle[],
  bundleId: string | undefined,
): AuditImplementationBundle {
  const selected =
    bundleId === undefined ? [...bundles] : bundles.filter((bundle) => bundle.id === bundleId);
  if (selected.length !== 1) {
    throw new Error(`expected exactly one bundle; received ${selected.length}`);
  }
  return selected[0];
}

function assertDispatchFindingsVerified(findings: readonly AuditSessionFinding[]): void {
  const unverified = findings.filter(
    (finding) =>
      finding.verification === undefined ||
      finding.verification.verifiedAt.trim().length === 0 ||
      finding.verification.evidence.length === 0 ||
      !['OPEN', 'PARTIAL'].includes(finding.verification.status),
  );
  if (unverified.length > 0) {
    throw new Error(
      `dispatch prompt refused for unverified findings: ${unverified.map((finding) => finding.id).join(', ')}`,
    );
  }
}

function assertNoRuntimeOnlyFindings(findings: readonly AuditSessionFinding[]): void {
  const runtimeOnly = findings.filter(
    (finding) =>
      finding.metadata.runtimeOnly === true ||
      finding.metadata.requiresRuntime === true ||
      finding.metadata.verificationKind === 'runtime' ||
      finding.evidence.some((evidence) => evidence.kind === 'runtime'),
  );
  if (runtimeOnly.length > 0) {
    throw new Error(
      `dispatch prompt refused for runtime-only findings: ${runtimeOnly.map((finding) => finding.id).join(', ')}`,
    );
  }
}

function defaultTombstoneEvidence(
  session: AuditStoreSession,
  finding: AuditSessionFinding,
  verifiedAt: string,
  reason: string,
): AuditSessionEvidence {
  return {
    id: `tombstone-proof:${finding.id}`,
    kind: 'tombstone',
    targetHead: session.targetHead,
    graphIndexId: session.graphIndexId,
    verifierVersion: session.verifierVersion,
    sidecarStateHash: session.sidecarStateHash,
    confidence: 1,
    reasonCodes: ['tombstone-match'],
    data: {
      verifiedAt,
      reason,
    },
  };
}

function metadataString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function metadataStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(metadataStrings);
  return [];
}
