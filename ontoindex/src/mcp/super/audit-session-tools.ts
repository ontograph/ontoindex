import { createRequire } from 'node:module';
import path from 'node:path';

import {
  buildAuditProjection,
  buildAuditReplayPlan,
  buildAuditSessionDiff,
  createAuditSessionLockFromStore,
  loadAndValidateAuditSessionLock,
  loadAuditSessionLock,
  LocalAuditEventStore,
  scanPrMarkersInSource,
  scanPrMarkersNearPath,
  type AuditSessionBundle,
  type AuditSessionFinding,
  type AuditSessionLockValidationResult,
  type StaleAuditSessionLockResult,
} from '../../core/audit-lifecycle/index.js';
import { execFileText } from '../../core/process/exec-file.js';
import { gnAuditDedupe, gnDispatchPrompt, gnScopeGuard } from './audit-advanced.js';
import { runAuditBundle } from './audit-bundle.js';
import { resolveAuditRepoHandle, runAuditIngest } from './audit-ingest.js';
import { runAuditVerify } from './audit-verify.js';

const require = createRequire(import.meta.url);

export interface AuditSessionLockParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  action?: 'create' | 'load' | 'validate';
  currentHead?: string;
  graphIndexId?: string;
  graphHash?: string;
  ontoindexVersion?: string;
}

export interface AuditPrMarkerScanParams {
  repo?: string;
  path?: string;
  sourceText?: string;
  source?: string;
  evidenceLine: number;
  windowBefore?: number;
  windowAfter?: number;
}

export interface AuditDiffParams {
  repo?: string;
  sessionA: string;
  sessionB: string;
  maxEntries?: number;
}

export interface AuditReplayParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  targetHead?: string;
  maxFindings?: number;
}

export interface AuditExportParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  format?: 'json' | 'markdown' | 'both';
  maxFindings?: number;
}

export interface AuditSessionStartParams {
  repo?: string;
  targetRef?: string;
  sourcePath?: string;
  pastedText?: string;
  graphIndexId?: string;
  strictFresh?: boolean;
  persist?: boolean;
  maxFindings?: number;
}

export interface AuditSessionVerifyParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  findingId?: string;
  proofMode?: 'heuristic' | 'path-sensitive' | 'resource-ledger' | 'runtime-required';
  maxFindings?: number;
  maxEvidence?: number;
  persist?: boolean;
}

export interface AuditSessionDedupeParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  strategy?: 'exact' | 'symbol' | 'root-cause' | 'write-set' | 'test-surface';
  maxGroups?: number;
}

export interface AuditSessionBundleParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  strategy?: 'exact' | 'symbol' | 'root-cause' | 'write-set' | 'test-surface';
  maxBundles?: number;
  maxLoc?: number;
  maxFiles?: number;
  parallelism?: number;
  persist?: boolean;
}

export interface AuditSessionDispatchParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  bundleId?: string;
  redactionMode?: 'none' | 'paths' | 'snippets' | 'sensitive';
  maxPromptChars?: number;
  persist?: boolean;
}

export interface AuditSessionReviewWorkerParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  bundleId?: string;
  changedFiles?: string[];
  changedSymbols?: string[];
  executedTests?: string[];
  requiredTests?: string[];
  persist?: boolean;
}

export async function gnAuditSessionLock(
  repoId: string,
  params: AuditSessionLockParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const sessionId = requiredSession(params);
  const action = params.action ?? 'validate';
  if (action === 'create') {
    const lock = await createAuditSessionLockFromStore({
      repoRoot: repo.repoPath,
      sessionId,
      graphHash: params.graphHash,
      ontoindexVersion: params.ontoindexVersion ?? packageVersion(),
    });
    return { version: 1, action: 'audit-session-lock', operation: 'create', lock };
  }
  if (action === 'load') {
    const lock = await loadAuditSessionLock(repo.repoPath, sessionId);
    return { version: 1, action: 'audit-session-lock', operation: 'load', lock };
  }

  const current = await currentSessionState(repo.repoPath, sessionId, params);
  const result = await loadAndValidateAuditSessionLock(repo.repoPath, sessionId, current);
  return summarizeSessionLockValidation(result);
}

export async function gnAuditPrMarkerScan(
  repoId: string,
  params: AuditPrMarkerScanParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const inline = params.sourceText ?? params.source;
  const evidenceLine = requirePositiveInteger(params.evidenceLine, 'evidenceLine');
  const result =
    inline !== undefined
      ? scanPrMarkersInSource({
          file: params.path ?? '<source>',
          sourceText: inline,
          evidenceLine,
          windowBefore: params.windowBefore,
          windowAfter: params.windowAfter,
        })
      : await scanPrMarkersNearPath({
          filePath: path.isAbsolute(requiredPath(params.path))
            ? requiredPath(params.path)
            : path.join(repo.repoPath, requiredPath(params.path)),
          displayFile: requiredPath(params.path),
          evidenceLine,
          windowBefore: params.windowBefore,
          windowAfter: params.windowAfter,
        });
  return {
    version: 1,
    action: 'audit-pr-marker-scan',
    suggestedStatus: result.markers.some((marker) => marker.suggestedTag === 'DECISION-GATED')
      ? 'DECISION-GATED'
      : result.markers.length > 0
        ? 'HOLD'
        : 'NEEDS-VERIFY',
    ...result,
    warnings: [],
    skipReasons: [],
  };
}

export async function gnAuditDiff(
  repoId: string,
  params: AuditDiffParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const projection = buildAuditProjection(
    (await new LocalAuditEventStore(repo.repoPath).load()).events,
  );
  const sessionA = requireProjectedSession(projection.sessions, params.sessionA);
  const sessionB = requireProjectedSession(projection.sessions, params.sessionB);
  const diff = buildAuditSessionDiff(
    sessionA,
    projection.findings.filter((finding) => finding.sessionId === params.sessionA),
    sessionB,
    projection.findings.filter((finding) => finding.sessionId === params.sessionB),
  );
  const maxEntries = clamp(params.maxEntries, 100);
  return {
    version: 1,
    action: 'audit-diff',
    sessionA: diff.sessionA,
    sessionB: diff.sessionB,
    summary: diff.summary,
    added: diff.added.slice(0, maxEntries),
    removed: diff.removed.slice(0, maxEntries),
    statusChanged: diff.statusChanged.slice(0, maxEntries),
    unchanged: diff.unchanged.slice(0, maxEntries),
    limits: {
      maxEntries,
      truncated:
        diff.added.length > maxEntries ||
        diff.removed.length > maxEntries ||
        diff.statusChanged.length > maxEntries ||
        diff.unchanged.length > maxEntries,
    },
    warnings: [],
    skipReasons: [],
  };
}

export async function gnAuditReplay(
  repoId: string,
  params: AuditReplayParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const sessionId = requiredSession(params);
  const projection = buildAuditProjection(
    (await new LocalAuditEventStore(repo.repoPath).load()).events,
  );
  const session = requireProjectedSession(projection.sessions, sessionId);
  const targetHead = params.targetHead ?? (await currentGitHead(repo.repoPath));
  const plan = buildAuditReplayPlan(
    session,
    projection.findings.filter((finding) => finding.sessionId === sessionId),
    targetHead,
  );
  const maxFindings = clamp(params.maxFindings, 100);
  return {
    version: 1,
    action: 'audit-replay',
    session: plan.session,
    targetHead: plan.targetHead,
    findings: plan.findings.slice(0, maxFindings),
    limits: {
      maxFindings,
      emitted: Math.min(plan.findings.length, maxFindings),
      total: plan.findings.length,
      truncated: plan.findings.length > maxFindings,
    },
    warnings: [],
    skipReasons: [],
  };
}

export async function gnAuditExport(
  repoId: string,
  params: AuditExportParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const sessionId = requiredSession(params);
  const projection = buildAuditProjection(
    (await new LocalAuditEventStore(repo.repoPath).load()).events,
  );
  const session = requireProjectedSession(projection.sessions, sessionId);
  const maxFindings = clamp(params.maxFindings, 500);
  const findings = projection.findings
    .filter((finding) => finding.sessionId === sessionId)
    .slice(0, maxFindings);
  const json = {
    session,
    findings,
    bundles: projection.bundles.filter((bundle) => bundle.sessionId === sessionId),
    lintRuns: projection.lintRuns.filter((run) => run.sessionId === sessionId),
    scopeGuardEvaluations: projection.scopeGuardEvaluations.filter(
      (evaluation) => evaluation.sessionId === sessionId,
    ),
  };
  const format = params.format ?? 'json';
  return {
    version: 1,
    action: 'audit-export',
    sessionId,
    format,
    ...(format === 'json' || format === 'both' ? { json } : {}),
    ...(format === 'markdown' || format === 'both'
      ? { markdown: renderAuditExportMarkdown(json) }
      : {}),
    limits: {
      maxFindings,
      emitted: findings.length,
      total: projection.findings.filter((finding) => finding.sessionId === sessionId).length,
      truncated:
        findings.length <
        projection.findings.filter((finding) => finding.sessionId === sessionId).length,
    },
    warnings: [],
    skipReasons: [],
  };
}

export async function gnAuditSessionStart(
  repoId: string,
  params: AuditSessionStartParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const ingest = await runAuditIngest(repo.repoPath, {
    sourcePath: params.sourcePath,
    sourceText: params.pastedText,
    targetRef: params.targetRef,
    graphIndexId: params.graphIndexId,
    persist: params.persist,
    maxFindings: params.maxFindings,
  });
  const sessionId = requireStringField(ingest.sessionId, 'ingest.sessionId');
  const lock = await createAuditSessionLockFromStore({
    repoRoot: repo.repoPath,
    sessionId,
    ontoindexVersion: packageVersion(),
  });
  return {
    version: 1,
    action: 'audit-session-start',
    ok: true,
    strictFresh: params.strictFresh !== false,
    sessionId,
    ingest,
    lock,
    warnings: collectWarnings(ingest),
    skipReasons: [],
  };
}

export async function gnAuditSessionVerify(
  repoId: string,
  params: AuditSessionVerifyParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const sessionId = requiredSession(params);
  const lockValidation = await validateManagerSession(repo.repoPath, sessionId);
  if (lockValidation.ok === false) {
    return managerRefusal('audit-session-verify', sessionId, lockValidation);
  }

  const verify = await runAuditVerify(
    repo.repoPath,
    {
      sessionId,
      findingId: params.findingId,
      maxFindings: params.maxFindings,
      maxEvidence: params.maxEvidence,
      persist: params.persist,
    },
    repo.id,
  );
  const tombstoneMatches = await enforceRepeatedFindingTombstones({
    repoPath: repo.repoPath,
    sessionId,
    findingId: params.findingId,
    persist: params.persist !== false,
  });
  applyTombstoneMatchesToVerifyReport(verify, tombstoneMatches);
  return {
    version: 1,
    action: 'audit-session-verify',
    ok: true,
    sessionId,
    proofMode: params.proofMode ?? 'heuristic',
    lockValidation,
    verify,
    tombstoneMatches,
    warnings: [
      ...new Set([
        ...collectWarnings(verify),
        ...tombstoneMatches.flatMap((match) => match.warnings),
      ]),
    ],
    skipReasons: [],
  };
}

export async function gnAuditSessionDedupe(
  repoId: string,
  params: AuditSessionDedupeParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const sessionId = requiredSession(params);
  const lockValidation = await validateManagerSession(repo.repoPath, sessionId);
  if (lockValidation.ok === false) {
    return managerRefusal('audit-session-dedupe', sessionId, lockValidation);
  }

  const dedupe = await gnAuditDedupe(repo.repoPath, {
    sessionId,
    strategy: params.strategy,
    maxGroups: params.maxGroups,
  });
  return {
    version: 1,
    action: 'audit-session-dedupe',
    ok: true,
    sessionId,
    lockValidation,
    dedupe,
    warnings: collectWarnings(dedupe),
    skipReasons: [],
  };
}

export async function gnAuditSessionBundle(
  repoId: string,
  params: AuditSessionBundleParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const sessionId = requiredSession(params);
  const lockValidation = await validateManagerSession(repo.repoPath, sessionId);
  if (lockValidation.ok === false) {
    return managerRefusal('audit-session-bundle', sessionId, lockValidation);
  }

  const dedupe = await gnAuditDedupe(repo.repoPath, {
    sessionId,
    strategy: params.strategy,
  });
  const bundle = await runAuditBundle(repo.repoPath, {
    sessionId,
    strategy: params.strategy,
    maxBundles: params.maxBundles,
    persist: params.persist,
  });
  const blockedBundles = summarizeBundleFilters(bundle, params);
  return {
    version: 1,
    action: 'audit-session-bundle',
    ok: true,
    sessionId,
    lockValidation,
    dedupe,
    bundle,
    managerLimits: {
      maxLoc: params.maxLoc ?? null,
      maxFiles: params.maxFiles ?? null,
      parallelism: params.parallelism ?? 1,
    },
    dispatchableBundleIds: listDispatchableBundleIds(bundle, blockedBundles),
    blockedBundles,
    warnings: [...new Set([...collectWarnings(dedupe), ...collectWarnings(bundle)])],
    skipReasons: [],
  };
}

export async function gnAuditSessionDispatch(
  repoId: string,
  params: AuditSessionDispatchParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const sessionId = requiredSession(params);
  const lockValidation = await validateManagerSession(repo.repoPath, sessionId);
  if (lockValidation.ok === false) {
    return managerRefusal('audit-session-dispatch', sessionId, lockValidation);
  }

  const managerState = await loadManagerState(repo.repoPath, sessionId);
  const bundle = selectPersistedBundle(managerState.projection.bundles, sessionId, params.bundleId);
  if (bundle === undefined) {
    return managerError(
      'audit-session-dispatch',
      sessionId,
      'BUNDLE_REQUIRED',
      'Run gn_audit_session_bundle before dispatching worker prompts.',
    );
  }
  const blockedFindings = collectDispatchBlocks(bundle, managerState.projection.findings);
  const duplicateOnlyChildren =
    bundle.findingIds.length > 0 &&
    bundle.findingIds.every((findingId) => bundle.duplicateFindingIds.includes(findingId));
  if (blockedFindings.length > 0 || duplicateOnlyChildren) {
    return {
      version: 1,
      action: 'audit-session-dispatch',
      ok: false,
      code: 'DISPATCH_BLOCKED',
      message: duplicateOnlyChildren
        ? 'Dispatch refused duplicate-only bundle children.'
        : 'Dispatch refused non-dispatchable findings.',
      sessionId,
      bundleId: bundle.id,
      blockedFindings,
      duplicateOnlyChildren,
      warnings: [],
      skipReasons: duplicateOnlyChildren
        ? ['duplicate-only-children']
        : blockedFindings.map((finding) => finding.reason),
    };
  }

  const dispatch = await gnDispatchPrompt(repo.repoPath, {
    sessionId,
    bundleId: bundle.id,
    redactionMode: params.redactionMode,
    maxPromptChars: params.maxPromptChars,
    persist: params.persist,
  });
  return {
    version: 1,
    action: 'audit-session-dispatch',
    ok: true,
    sessionId,
    bundleId: bundle.id,
    lockValidation,
    dispatch,
    warnings: collectWarnings(dispatch),
    skipReasons: [],
  };
}

export async function gnAuditSessionReviewWorker(
  repoId: string,
  params: AuditSessionReviewWorkerParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const sessionId = requiredSession(params);
  const lockValidation = await validateManagerSession(repo.repoPath, sessionId);
  if (lockValidation.ok === false) {
    return managerRefusal('audit-session-review-worker', sessionId, lockValidation);
  }

  const managerState = await loadManagerState(repo.repoPath, sessionId);
  const bundle = selectPersistedBundle(managerState.projection.bundles, sessionId, params.bundleId);
  if (bundle === undefined) {
    return managerError(
      'audit-session-review-worker',
      sessionId,
      'BUNDLE_REQUIRED',
      'Run gn_audit_session_bundle before reviewing worker output.',
    );
  }

  const review = await gnScopeGuard(repo.repoPath, {
    sessionId,
    bundleId: bundle.id,
    changedFiles: params.changedFiles,
    changedSymbols: params.changedSymbols,
    executedTests: params.executedTests,
    requiredTests: params.requiredTests,
    persist: params.persist,
  });
  const status = requireStringField(review.status, 'review.status');
  return {
    version: 1,
    action: 'audit-session-review-worker',
    ok: status === 'PASS',
    sessionId,
    bundleId: bundle.id,
    lockValidation,
    review,
    warnings: collectWarnings(review),
    skipReasons: status === 'PASS' ? [] : ['scope-guard-failed'],
  };
}

async function currentSessionState(
  repoPath: string,
  sessionId: string,
  params: AuditSessionLockParams,
) {
  const projection = buildAuditProjection((await new LocalAuditEventStore(repoPath).load()).events);
  const session = requireProjectedSession(projection.sessions, sessionId);
  return {
    targetHead: params.currentHead ?? (await currentGitHead(repoPath)),
    graphIndexId: params.graphIndexId ?? session.graphIndexId,
    graphHash: params.graphHash ?? session.sidecarStateHash,
  };
}

function summarizeSessionLockValidation(
  result: AuditSessionLockValidationResult,
): Record<string, unknown> {
  if (result.status === 'VALID_SESSION') {
    return {
      version: 1,
      action: 'audit-session-lock',
      operation: 'validate',
      status: result.status,
      ok: result.ok,
      sessionId: result.sessionId,
      lock: result.lock,
      warnings: [],
      skipReasons: [],
    };
  }
  const stale = result as StaleAuditSessionLockResult;
  return {
    version: 1,
    action: 'audit-session-lock',
    operation: 'validate',
    status: result.status,
    ok: result.ok,
    sessionId: result.sessionId,
    lock: result.lock,
    code: stale.code,
    message: stale.message,
    current: stale.current,
    staleFields: stale.staleFields,
    warnings: [],
    skipReasons: [],
  };
}

function requireProjectedSession<T extends { id: string }>(
  sessions: readonly T[],
  sessionId: string,
): T {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`audit session does not exist: ${sessionId}`);
  return session;
}

async function currentGitHead(repoPath: string): Promise<string> {
  return (
    await execFileText('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { timeoutMs: 5_000 })
  ).trim();
}

function requiredSession(params: { session?: string; sessionId?: string }): string {
  const sessionId = params.sessionId ?? params.session;
  if (!sessionId) throw new Error('session is required');
  return sessionId;
}

function requiredPath(value: string | undefined): string {
  if (!value) throw new Error('path or sourceText is required');
  return value;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${fieldName} must be a positive integer`);
  return parsed;
}

function clamp(value: unknown, defaultValue: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(1, Math.min(500, parsed));
}

function packageVersion(): string {
  try {
    const pkg = require('../../../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function validateManagerSession(
  repoPath: string,
  sessionId: string,
): Promise<
  | AuditSessionLockValidationResult
  | { ok: false; code: 'SESSION_LOCK_REQUIRED'; message: string; sessionId: string }
> {
  try {
    return await loadAndValidateAuditSessionLock(
      repoPath,
      sessionId,
      await currentSessionState(repoPath, sessionId, {}),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        ok: false,
        code: 'SESSION_LOCK_REQUIRED',
        message: `audit session lock is required for ${sessionId}`,
        sessionId,
      };
    }
    throw error;
  }
}

async function loadManagerState(repoPath: string, sessionId: string) {
  const state = await new LocalAuditEventStore(repoPath).load();
  const projection = buildAuditProjection(state.events);
  requireProjectedSession(projection.sessions, sessionId);
  return { state, projection };
}

interface RepeatedFindingTombstoneMatch {
  findingId: string;
  matchedFindingId: string;
  matchedSessionId: string;
  warnings: string[];
}

async function enforceRepeatedFindingTombstones(input: {
  repoPath: string;
  sessionId: string;
  findingId?: string;
  persist: boolean;
}): Promise<RepeatedFindingTombstoneMatch[]> {
  const store = new LocalAuditEventStore(input.repoPath);
  const projection = buildAuditProjection((await store.load()).events);
  const candidates = projection.findings
    .filter((finding) => finding.sessionId === input.sessionId)
    .filter((finding) => input.findingId === undefined || finding.id === input.findingId)
    .filter(
      (finding) =>
        finding.status === 'OPEN' || finding.status === 'PARTIAL' || finding.status === 'BUNDLED',
    );
  const tombstones = projection.findings
    .filter((finding) => finding.sessionId !== input.sessionId)
    .filter(
      (
        finding,
      ): finding is AuditSessionFinding & {
        tombstone: NonNullable<AuditSessionFinding['tombstone']>;
      } => finding.tombstone !== undefined,
    )
    .sort(
      (left, right) =>
        right.tombstone.tombstonedAt.localeCompare(left.tombstone.tombstonedAt) ||
        left.id.localeCompare(right.id),
    );

  const matches: RepeatedFindingTombstoneMatch[] = [];
  for (const finding of candidates) {
    const matched = tombstones.find((candidate) => candidate.fingerprint === finding.fingerprint);
    if (matched === undefined) continue;
    matches.push({
      findingId: finding.id,
      matchedFindingId: matched.id,
      matchedSessionId: matched.sessionId,
      warnings: [`Repeated finding matched tombstone ${matched.id}.`],
    });
    if (!input.persist) continue;
    await store.appendEvent({
      id: `evt-repeated-tombstone-${finding.id}-${Date.now()}`,
      type: 'FindingTombstoned',
      occurredAt: new Date().toISOString(),
      sessionId: input.sessionId,
      findingId: finding.id,
      tombstone: {
        tombstonedAt: new Date().toISOString(),
        reason: `Repeated finding matched tombstone ${matched.id}: ${matched.tombstone.reason}`,
        invariantId: matched.tombstone.invariantId,
        evidence: matched.tombstone.evidence.map((evidence) => ({ ...evidence })),
      },
    });
  }
  return matches;
}

function applyTombstoneMatchesToVerifyReport(
  report: Record<string, unknown>,
  matches: readonly RepeatedFindingTombstoneMatch[],
): void {
  const findings = Array.isArray(report.findings)
    ? (report.findings as Array<Record<string, unknown>>)
    : [];
  const matchesByFindingId = new Map(matches.map((match) => [match.findingId, match]));
  for (const finding of findings) {
    const findingId = requireOptionalStringField(finding.findingId);
    if (findingId === undefined) continue;
    const match = matchesByFindingId.get(findingId);
    if (match === undefined) continue;
    finding.status = 'TOMBSTONED';
    finding.statusReason = `Repeated finding matched tombstone ${match.matchedFindingId}.`;
    finding.tombstoneMatch = match.matchedFindingId;
  }
}

function summarizeBundleFilters(
  report: Record<string, unknown>,
  params: AuditSessionBundleParams,
): Array<{ bundleId: string; reasons: string[] }> {
  const bundles = Array.isArray(report.bundles)
    ? (report.bundles as Array<Record<string, unknown>>)
    : [];
  return bundles
    .map((bundle) => {
      const reasons: string[] = [];
      const bundleId = requireStringField(bundle.id, 'bundle.id');
      if (
        typeof params.maxLoc === 'number' &&
        typeof bundle.estimatedLoc === 'number' &&
        bundle.estimatedLoc > params.maxLoc
      ) {
        reasons.push(`estimatedLoc>${params.maxLoc}`);
      }
      if (
        typeof params.maxFiles === 'number' &&
        Array.isArray(bundle.files) &&
        bundle.files.length > params.maxFiles
      ) {
        reasons.push(`files>${params.maxFiles}`);
      }
      return { bundleId, reasons };
    })
    .filter((bundle) => bundle.reasons.length > 0);
}

function listDispatchableBundleIds(
  report: Record<string, unknown>,
  blockedBundles: readonly { bundleId: string }[],
): string[] {
  const blocked = new Set(blockedBundles.map((bundle) => bundle.bundleId));
  const bundles = Array.isArray(report.bundles)
    ? (report.bundles as Array<Record<string, unknown>>)
    : [];
  return bundles
    .map((bundle) => requireOptionalStringField(bundle.id))
    .filter((bundleId): bundleId is string => bundleId !== undefined && !blocked.has(bundleId));
}

function selectPersistedBundle(
  bundles: readonly AuditSessionBundle[],
  sessionId: string,
  bundleId: string | undefined,
): ReturnType<typeof fromPersistedBundle> | undefined {
  const candidates = bundles
    .filter((bundle) => bundle.sessionId === sessionId)
    .map((bundle) => fromPersistedBundle(bundle));
  const selected =
    bundleId === undefined ? candidates : candidates.filter((bundle) => bundle.id === bundleId);
  if (selected.length === 0) {
    return undefined;
  }
  if (selected.length > 1) {
    throw new Error(`expected exactly one bundle; received ${selected.length}`);
  }
  return selected[0];
}

function fromPersistedBundle(bundle: AuditSessionBundle) {
  return {
    id: bundle.id,
    sessionId: bundle.sessionId,
    findingIds: [...bundle.findingIds].sort(),
    duplicateFindingIds: metadataStrings(bundle.metadata.duplicateFindingIds),
    files: metadataStrings(bundle.metadata.files),
    symbols: metadataStrings(bundle.metadata.symbols),
    tests: metadataStrings(bundle.metadata.tests),
    writeSet: metadataStrings(bundle.metadata.writeSet),
  };
}

function collectDispatchBlocks(
  bundle: ReturnType<typeof fromPersistedBundle>,
  findings: readonly AuditSessionFinding[],
): Array<{
  findingId: string;
  currentStatus: string;
  verificationStatus?: string;
  reason: string;
}> {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const blockedStatuses = new Set(['NEEDS-VERIFY', 'NEEDS-REVERIFY', 'HOLD']);
  return bundle.findingIds.flatMap((findingId) => {
    const finding = byId.get(findingId);
    if (finding === undefined) {
      return [
        {
          findingId,
          currentStatus: 'missing',
          reason: 'missing-finding',
        },
      ];
    }
    const verificationStatus = finding.verification?.status;
    if (
      blockedStatuses.has(finding.status) ||
      (verificationStatus !== undefined && blockedStatuses.has(verificationStatus))
    ) {
      return [
        {
          findingId,
          currentStatus: finding.status,
          ...(verificationStatus !== undefined ? { verificationStatus } : {}),
          reason: 'blocked-status',
        },
      ];
    }
    if (
      finding.status === 'TOMBSTONED' ||
      finding.status === 'FALSE-POSITIVE' ||
      finding.status === 'RESOLVED-ALREADY'
    ) {
      return [
        {
          findingId,
          currentStatus: finding.status,
          ...(verificationStatus !== undefined ? { verificationStatus } : {}),
          reason: 'terminal-status',
        },
      ];
    }
    if (finding.verification === undefined || finding.verification.evidence.length === 0) {
      return [
        {
          findingId,
          currentStatus: finding.status,
          reason: 'missing-verification',
        },
      ];
    }
    return [];
  });
}

function managerRefusal(
  action: string,
  sessionId: string,
  validation:
    | AuditSessionLockValidationResult
    | { ok: false; code: string; message: string; sessionId: string },
): Record<string, unknown> {
  if ('status' in validation && validation.status === 'STALE_SESSION') {
    return {
      version: 1,
      action,
      ok: false,
      code: validation.code,
      message: validation.message,
      sessionId,
      lockValidation: validation,
      warnings: validation.lock.staleWarnings ?? [],
      skipReasons: ['stale-session'],
    };
  }
  if ('code' in validation) {
    return managerError(action, sessionId, validation.code, validation.message);
  }
  return managerError(
    action,
    sessionId,
    'SESSION_LOCK_REQUIRED',
    `audit session lock is required for ${sessionId}`,
  );
}

function managerError(
  action: string,
  sessionId: string,
  code: string,
  message: string,
): Record<string, unknown> {
  return {
    version: 1,
    action,
    ok: false,
    code,
    message,
    sessionId,
    warnings: [],
    skipReasons: [code.toLowerCase()],
  };
}

function collectWarnings(report: Record<string, unknown>): string[] {
  return Array.isArray(report.warnings)
    ? report.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
}

function requireStringField(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requireOptionalStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function metadataStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(metadataStrings);
  return [];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function renderAuditExportMarkdown(input: {
  session: { id: string; targetRepo: string; targetHead: string };
  findings: Array<{ id: string; status: string; title: string }>;
  bundles: Array<{ id: string; findingIds: string[] }>;
}): string {
  const counts = new Map<string, number>();
  for (const finding of input.findings) {
    counts.set(finding.status, (counts.get(finding.status) ?? 0) + 1);
  }
  return [
    '## Audit Result',
    '',
    'Target:',
    `- Repo: ${input.session.targetRepo}`,
    `- Target HEAD: ${input.session.targetHead}`,
    `- Session: ${input.session.id}`,
    '',
    'Findings:',
    ...Array.from(counts.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `- ${status}: ${count}`),
    '',
    'Bundles:',
    ...input.bundles.map((bundle) => `- ${bundle.id}: ${bundle.findingIds.join(', ')}`),
    '',
    'Finding Details:',
    ...input.findings.map((finding) => `- ${finding.id} [${finding.status}]: ${finding.title}`),
    '',
  ].join('\n');
}
