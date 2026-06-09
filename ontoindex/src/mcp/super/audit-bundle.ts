import {
  buildAuditBundleProjectionFromEvents,
  LocalAuditEventStore,
  type AuditImplementationBundle,
} from '../../core/audit-lifecycle/index.js';
import { clampLimit, resolveAuditRepoHandle } from './audit-ingest.js';

export interface AuditBundleParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  strategy?: 'exact' | 'symbol' | 'root-cause' | 'write-set' | 'test-surface';
  maxBundles?: number;
  persist?: boolean;
}

export async function gnAuditBundle(
  repoId: string,
  params: AuditBundleParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  return runAuditBundle(repo.repoPath, params);
}

export async function runAuditBundle(
  repoPath: string,
  params: AuditBundleParams,
): Promise<Record<string, unknown>> {
  const sessionId = params.sessionId ?? params.session;
  if (!sessionId) throw new Error('session is required for audit bundle');

  const maxBundles = clampLimit(params.maxBundles, 25);
  const store = new LocalAuditEventStore(repoPath);
  const state = await store.load();
  const projection = buildAuditBundleProjectionFromEvents(state.events, sessionId, {
    strategy: params.strategy,
  });
  const emittedBundles = projection.bundles.slice(0, maxBundles);

  if (params.persist !== false) {
    for (const bundle of emittedBundles) {
      await store.appendEvent({
        id: `evt-bundle-${bundle.id}-${Date.now()}`,
        type: 'FindingBundled',
        occurredAt: bundle.createdAt,
        sessionId,
        bundleId: bundle.id,
        bundle: {
          id: bundle.id,
          sessionId,
          findingIds: bundle.findingIds,
          status: 'CREATED',
          createdAt: bundle.createdAt,
          metadata: {
            rootCauseId: bundle.rootCauseId,
            strategy: bundle.strategy,
            duplicateFindingIds: bundle.duplicateFindingIds,
            files: bundle.files,
            symbols: bundle.symbols,
            tests: bundle.tests,
            impactTargets: bundle.symbols,
            writeSet: bundle.writeSet,
            estimatedLoc: bundle.estimatedLoc,
            nonScope: bundle.nonScope,
            stopConditions: bundle.stopConditions,
          },
        },
      });
    }
  }

  return {
    version: 1,
    action: 'audit-bundle',
    sessionId,
    targetHead: projection.targetHead,
    sourceHash: projection.sourceHash,
    bundles: emittedBundles.map(summarizeBundle),
    excludedFindingIds: projection.excludedFindingIds,
    conflicts: projection.conflicts,
    limits: {
      maxBundles,
      emitted: emittedBundles.length,
      total: projection.bundles.length,
      truncated: emittedBundles.length < projection.bundles.length,
    },
    warnings: [],
    skipReasons: [],
  };
}

function summarizeBundle(bundle: AuditImplementationBundle): Record<string, unknown> {
  return {
    id: bundle.id,
    sessionId: bundle.sessionId,
    rootCauseId: bundle.rootCauseId,
    strategy: bundle.strategy,
    status: bundle.status,
    findingIds: bundle.findingIds,
    duplicateFindingIds: bundle.duplicateFindingIds,
    files: bundle.files,
    symbols: bundle.symbols,
    tests: bundle.tests,
    writeSet: bundle.writeSet,
    estimatedLoc: bundle.estimatedLoc,
    nonScope: bundle.nonScope,
    stopConditions: bundle.stopConditions,
    conflicts: bundle.conflicts,
    createdAt: bundle.createdAt,
  };
}
