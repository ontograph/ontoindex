import { findFixHistoryCandidates } from '../../core/audit-lifecycle/index.js';
import { clampLimit, resolveAuditRepoHandle } from './audit-ingest.js';

export interface FixHistoryParams {
  repo?: string;
  targetHead?: string;
  path?: string;
  patterns?: string[];
  limit?: number;
}

export async function gnFixHistory(
  repoId: string,
  params: FixHistoryParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  if (!params.targetHead) throw new Error('targetHead is required for gn_fix_history');
  if (!params.path) throw new Error('path is required for gn_fix_history');
  const limit = clampLimit(params.limit, 20);
  const candidates = await findFixHistoryCandidates({
    repoPath: repo.repoPath,
    targetHead: params.targetHead,
    path: params.path,
    patterns: params.patterns ?? [],
    limit,
  });
  return {
    version: 1,
    action: 'fix-history',
    targetHead: params.targetHead,
    path: params.path,
    candidates,
    limits: {
      maxItems: limit,
      emitted: candidates.length,
      truncated: false,
    },
    warnings: params.patterns?.length ? [] : ['No patterns supplied; fix-history lookup skipped.'],
    skipReasons: params.patterns?.length ? [] : ['missing-patterns'],
  };
}
