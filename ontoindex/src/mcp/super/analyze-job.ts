import { cancelAnalysisJob, getAnalysisJob } from '../../core/analysis/analysis-coordinator.js';
import { gnEnsureFresh } from './ensure-fresh.js';

export interface AnalyzeJobParams {
  repo?: string;
  jobId: string;
  action?: 'status' | 'cancel';
}

export async function gnAnalyzeJob(repoId: string, params: AnalyzeJobParams): Promise<unknown> {
  const freshness = await gnEnsureFresh(repoId, { repo: params.repo });
  if (!freshness.repoPath) return { error: 'Repository path could not be resolved.' };
  if (params.action === 'cancel') {
    const result = await cancelAnalysisJob(freshness.repoPath, params.jobId);
    return { ...result, repoLabel: freshness.repoLabel, repoPath: freshness.repoPath };
  }
  const job = await getAnalysisJob(freshness.repoPath, params.jobId);
  return job
    ? { job, repoLabel: freshness.repoLabel, repoPath: freshness.repoPath }
    : {
        error: 'Analysis job not found.',
        repoLabel: freshness.repoLabel,
        repoPath: freshness.repoPath,
      };
}
