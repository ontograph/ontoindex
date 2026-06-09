import { buildAuditProjection } from './audit-projection.js';
import type { AuditEvent } from './audit-event-store.js';
import type {
  AuditFinding,
  AuditFindingStatus,
  AuditSession,
  AuditSessionSnapshot,
  AuditSnapshotMode,
} from './audit-session.js';
import {
  evaluateFreshnessGatePolicy,
  type AuditFreshnessPolicyInput,
} from '../../mcp/shared/freshness-policy.js';
import {
  buildFindingDedupeProjection,
  getFindingEstimatedLoc,
  getFindingFiles,
  getFindingNonScope,
  getFindingStopConditions,
  getFindingSymbols,
  getFindingTests,
  getFindingWriteSet,
  type DedupeGroup,
  type DedupeStrategy,
  type RootCause,
} from './finding-dedupe.js';

export type BundleConflictKind = 'file' | 'symbol' | 'test-surface' | 'write-set';

export interface AuditBundleConflict {
  kind: BundleConflictKind;
  value: string;
  bundleIds: string[];
  findingIds: string[];
}

export interface AuditImplementationBundle {
  id: string;
  sessionId: string;
  rootCauseId: string;
  strategy: DedupeStrategy;
  status: 'CREATED';
  findingIds: string[];
  duplicateFindingIds: string[];
  files: string[];
  symbols: string[];
  tests: string[];
  writeSet: string[];
  estimatedLoc: number;
  nonScope: string[];
  stopConditions: string[];
  rootCause: RootCause;
  conflicts: AuditBundleConflict[];
  snapshotMode?: AuditSnapshotMode;
  staleWarnings?: string[];
  sessionSnapshot?: AuditSessionSnapshot;
  createdAt: string;
}

export interface AuditBundleProjection {
  sessionId: string;
  targetHead: string;
  sourceHash: string;
  snapshotMode?: AuditSnapshotMode;
  staleWarnings?: string[];
  sessionSnapshot?: AuditSessionSnapshot;
  bundles: AuditImplementationBundle[];
  excludedFindingIds: string[];
  dedupeGroups: DedupeGroup[];
  conflicts: AuditBundleConflict[];
}

export interface AuditBundleProjectionOptions {
  createdAt?: string;
  includeStatuses?: readonly AuditFindingStatus[];
  excludeStatuses?: readonly AuditFindingStatus[];
  strategy?: DedupeStrategy;
  freshnessPolicy?: AuditFreshnessPolicyInput;
}

const DEFAULT_IMPLEMENTATION_STATUSES = new Set<AuditFindingStatus>(['OPEN', 'PARTIAL']);
const DEFAULT_EXCLUDED_STATUSES = new Set<AuditFindingStatus>([
  'RESOLVED-ALREADY',
  'FALSE-POSITIVE',
  'HOLD',
  'NEEDS-VERIFY',
  'NEEDS-REVERIFY',
]);

export function buildAuditBundleProjectionFromEvents(
  events: readonly AuditEvent[],
  sessionId: string,
  options: AuditBundleProjectionOptions = {},
): AuditBundleProjection {
  const projection = buildAuditProjection(events, options.createdAt);
  const session = projection.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) {
    throw new Error(`audit session does not exist: ${sessionId}`);
  }
  return buildAuditBundleProjection(
    session,
    projection.findings.filter((finding) => finding.sessionId === sessionId),
    options,
  );
}

export function buildAuditBundleProjection(
  session: AuditSession,
  findings: readonly AuditFinding[],
  options: AuditBundleProjectionOptions = {},
): AuditBundleProjection {
  const createdAt = normalizeCreatedAt(options.createdAt);
  const sessionSnapshot = getSessionSnapshot(session);
  const implementationStatuses = new Set(
    options.includeStatuses ?? DEFAULT_IMPLEMENTATION_STATUSES,
  );
  const excludedStatuses = new Set(options.excludeStatuses ?? DEFAULT_EXCLUDED_STATUSES);
  const eligibleFindings = findings
    .filter((finding) => finding.sessionId === session.id)
    .filter((finding) => implementationStatuses.has(finding.status))
    .filter((finding) => !excludedStatuses.has(finding.status))
    .filter((finding) => isDispatchableFinding(finding, options.freshnessPolicy))
    .sort(byFindingId);
  const excludedFindingIds = findings
    .filter((finding) => finding.sessionId === session.id)
    .filter(
      (finding) =>
        excludedStatuses.has(finding.status) ||
        !isDispatchableFinding(finding, options.freshnessPolicy),
    )
    .map((finding) => finding.id)
    .sort();
  const dedupeProjection = buildFindingDedupeProjection(eligibleFindings);
  const strategy = options.strategy ?? 'root-cause';
  const sourceGroups = dedupeProjection.groups.filter((group) => group.strategy === strategy);
  const bundleGroups =
    sourceGroups.length > 0
      ? sourceGroups
      : eligibleFindings.map((finding) => ({
          id: `${strategy}:${finding.id}`,
          strategy,
          key: finding.id,
          findingIds: [finding.id],
        }));
  const findingById = new Map(eligibleFindings.map((finding) => [finding.id, finding]));
  const bundles = bundleGroups
    .map((group) => createBundle(session, group, findingById, createdAt))
    .sort((left, right) => left.id.localeCompare(right.id));
  const conflicts = detectBundleConflicts(bundles);
  const conflictsByBundle = new Map<string, AuditBundleConflict[]>();
  for (const conflict of conflicts) {
    for (const bundleId of conflict.bundleIds) {
      conflictsByBundle.set(bundleId, [...(conflictsByBundle.get(bundleId) ?? []), conflict]);
    }
  }
  const bundlesWithConflicts = bundles.map((bundle) => ({
    ...bundle,
    conflicts: conflictsByBundle.get(bundle.id) ?? [],
  }));

  return {
    sessionId: session.id,
    targetHead: session.targetHead,
    sourceHash: session.sourceHash,
    ...(sessionSnapshot !== undefined
      ? {
          snapshotMode: sessionSnapshot.mode,
          staleWarnings: [...sessionSnapshot.staleWarnings],
          sessionSnapshot,
        }
      : {}),
    bundles: bundlesWithConflicts,
    excludedFindingIds,
    dedupeGroups: dedupeProjection.groups,
    conflicts,
  };
}

export function detectBundleConflicts(
  bundles: readonly AuditImplementationBundle[],
): AuditBundleConflict[] {
  return [
    ...detectConflictsForKind(bundles, 'file', (bundle) => bundle.files),
    ...detectConflictsForKind(bundles, 'symbol', (bundle) => bundle.symbols),
    ...detectConflictsForKind(bundles, 'test-surface', (bundle) => bundle.tests),
    ...detectConflictsForKind(bundles, 'write-set', (bundle) => bundle.writeSet),
  ].sort((left, right) =>
    `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`),
  );
}

function createBundle(
  session: AuditSession,
  group: DedupeGroup,
  findingById: ReadonlyMap<string, AuditFinding>,
  createdAt: string,
): AuditImplementationBundle {
  const findings = group.findingIds.map((findingId) => {
    const finding = findingById.get(findingId);
    if (finding === undefined) {
      throw new Error(`bundle references missing finding: ${findingId}`);
    }
    return finding;
  });
  const findingIds = findings.map((finding) => finding.id).sort();
  const rootCause =
    group.rootCause ??
    ({
      id: `root-cause:${stableKey(group.key)}`,
      title: findings[0]?.title ?? group.key,
      files: sortedStrings(findings.flatMap(getFindingFiles)),
      symbols: sortedStrings(findings.flatMap(getFindingSymbols)),
      writeSet: sortedStrings(findings.flatMap(getFindingWriteSet)),
      testSurface: sortedStrings(findings.flatMap(getFindingTests)),
      findingIds,
    } satisfies RootCause);
  return {
    id: `bundle:${session.id}:${stableKey(`${group.strategy}:${group.key}`)}`,
    sessionId: session.id,
    rootCauseId: rootCause.id,
    strategy: group.strategy,
    status: 'CREATED',
    findingIds,
    duplicateFindingIds: findingIds.slice(1),
    files: sortedStrings(findings.flatMap(getFindingFiles)),
    symbols: sortedStrings(findings.flatMap(getFindingSymbols)),
    tests: sortedStrings(findings.flatMap(getFindingTests)),
    writeSet: sortedStrings(findings.flatMap(getFindingWriteSet)),
    estimatedLoc: findings.reduce((total, finding) => total + getFindingEstimatedLoc(finding), 0),
    nonScope: sortedStrings(findings.flatMap(getFindingNonScope)),
    stopConditions: sortedStrings(findings.flatMap(getFindingStopConditions)),
    rootCause,
    conflicts: [],
    ...snapshotMetadata(session),
    createdAt,
  };
}

function detectConflictsForKind(
  bundles: readonly AuditImplementationBundle[],
  kind: BundleConflictKind,
  values: (bundle: AuditImplementationBundle) => readonly string[],
): AuditBundleConflict[] {
  const owners = new Map<string, AuditImplementationBundle[]>();
  for (const bundle of bundles) {
    for (const value of values(bundle)) {
      owners.set(value, [...(owners.get(value) ?? []), bundle]);
    }
  }
  return [...owners.entries()]
    .filter(([, ownerBundles]) => ownerBundles.length > 1)
    .map(([value, ownerBundles]) => ({
      kind,
      value,
      bundleIds: ownerBundles.map((bundle) => bundle.id).sort(),
      findingIds: sortedStrings(ownerBundles.flatMap((bundle) => bundle.findingIds)),
    }));
}

function isDispatchableFinding(
  finding: AuditFinding,
  policy: AuditFreshnessPolicyInput | undefined,
): boolean {
  if (policy === undefined) return true;
  return evaluateFreshnessGatePolicy({
    ...policy,
    evidenceTargetHead: evidenceTargetHead(finding),
  }).dispatchable;
}

function evidenceTargetHead(finding: AuditFinding): string | null {
  const evidenceHead =
    finding.verification?.evidence[0]?.targetHead ?? finding.evidence[0]?.targetHead;
  return typeof evidenceHead === 'string' && evidenceHead.trim().length > 0 ? evidenceHead : null;
}

function snapshotMetadata(
  session: AuditSession,
): Pick<AuditImplementationBundle, 'snapshotMode' | 'staleWarnings' | 'sessionSnapshot'> {
  const snapshot = getSessionSnapshot(session);
  if (snapshot === undefined) return {};
  return {
    snapshotMode: snapshot.mode,
    staleWarnings: [...snapshot.staleWarnings],
    sessionSnapshot: snapshot,
  };
}

function getSessionSnapshot(session: AuditSession): AuditSessionSnapshot | undefined {
  if (session.snapshot !== undefined) return session.snapshot;
  if (session.snapshotMode === undefined) return undefined;
  return {
    mode: session.snapshotMode,
    targetHead: session.targetHead,
    graphIndexId: session.graphIndexId,
    changedFiles: sortedStrings(session.changedFiles ?? []),
    changedSymbols: sortedStrings(session.changedSymbols ?? []),
    staleWarnings: sortedStrings(session.staleWarnings ?? []),
  };
}

function normalizeCreatedAt(value: string | undefined): string {
  return value === undefined ? new Date(0).toISOString() : new Date(value).toISOString();
}

function byFindingId(left: AuditFinding, right: AuditFinding): number {
  return left.id.localeCompare(right.id);
}

function sortedStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
