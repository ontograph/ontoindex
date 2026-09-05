import path from 'node:path';

import {
  cancelAnalysisJob,
  getAnalysisJob,
  type AnalysisJobRecord,
} from '../../core/analysis/analysis-coordinator.js';
import {
  isValidSourceIdentity,
  readAnalysisPublicationReceipt,
  type AnalysisPublicationReceipt,
} from '../../core/analysis/analysis-publication-receipt.js';
import { resolveActiveIndexGeneration } from '../../storage/repo-manager.js';
import { resolveTargetContext, type TargetContext } from '../shared/target-context.js';
import { gnEnsureFresh, type EnsureFreshReport } from './ensure-fresh.js';

export interface AnalyzeJobParams {
  repo?: string;
  jobId: string;
  action?: 'status' | 'cancel';
}

export type AnalysisRecoveryDisposition =
  | 'REFRESH_RUNNING'
  | 'REFRESHED'
  | 'FAILED'
  | 'FRESHNESS_UNCONFIRMED';

export interface AnalysisRecovery {
  disposition: AnalysisRecoveryDisposition;
  reasonCode: string;
  message: string;
  receipt?: AnalysisPublicationReceipt;
  postCheck?: EnsureFreshReport;
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
    ? {
        job,
        repoLabel: freshness.repoLabel,
        repoPath: freshness.repoPath,
        recovery: await observeRecovery(job, freshness.repoPath),
      }
    : {
        error: 'Analysis job not found.',
        repoLabel: freshness.repoLabel,
        repoPath: freshness.repoPath,
      };
}

async function observeRecovery(
  job: AnalysisJobRecord,
  resolvedRepoPath: string,
): Promise<AnalysisRecovery> {
  if (!isValidSourceIdentity(job.sourceIdentity, job.targetHead, job.sourceManifestDigest)) {
    return terminalUnconfirmed(
      job,
      'JOB_SOURCE_IDENTITY_MISMATCH',
      'The analysis job record does not identify the exact commit or working-tree source requested for analysis.',
    );
  }
  if (!hasRequestedCapabilities(job.requestedCapabilities)) {
    return terminalUnconfirmed(
      job,
      'JOB_CAPABILITIES_UNAVAILABLE',
      'The analysis job record does not contain a valid requested-capabilities identity.',
    );
  }
  if (!isSha256(job.sourceManifestDigest)) {
    return terminalUnconfirmed(
      job,
      'JOB_MANIFEST_IDENTITY_UNAVAILABLE',
      'The analysis job record does not contain a valid source-manifest identity.',
    );
  }
  if (job.status === 'queued' || job.status === 'running') {
    return recovery(
      'REFRESH_RUNNING',
      'ANALYSIS_IN_PROGRESS',
      `Analysis job ${job.id} is ${job.status}.`,
    );
  }
  if (job.status === 'cancelled') {
    return recovery('FAILED', 'CANCELLED', `Analysis job ${job.id} was cancelled.`);
  }
  if (job.status === 'failed') {
    return recovery(
      'FAILED',
      'ANALYSIS_FAILED',
      `Analysis job ${job.id} failed${
        typeof job.exitCode === 'number' ? ` with exit code ${job.exitCode}` : ''
      }.`,
    );
  }
  const activeGeneration = await resolveActiveIndexGeneration(
    path.join(resolvedRepoPath, '.ontoindex'),
  );
  if (!activeGeneration) {
    return terminalUnconfirmed(
      job,
      'ACTIVE_GENERATION_UNAVAILABLE',
      'The active index generation could not be resolved.',
    );
  }

  const receipt = await readAnalysisPublicationReceipt(activeGeneration.generationPath, job.id);
  if (!receipt) {
    return terminalUnconfirmed(
      job,
      'PUBLICATION_RECEIPT_UNAVAILABLE',
      'No valid publication receipt for this job exists in the active generation.',
    );
  }

  const receiptMismatch = validateReceipt(
    job,
    resolvedRepoPath,
    activeGeneration.generationId,
    receipt,
  );
  if (receiptMismatch) {
    return terminalUnconfirmed(job, receiptMismatch.reasonCode, receiptMismatch.message, receipt);
  }

  let postCheck: EnsureFreshReport;
  let targetContext: TargetContext;
  try {
    postCheck = await gnEnsureFresh(resolvedRepoPath, {
      repo: resolvedRepoPath,
      withEmbeddings: job.requestedCapabilities.embeddings,
      requiredGraphCapabilities: job.requestedCapabilities.graphCapabilities,
    });
    targetContext = await resolveTargetContext({
      repo: resolvedRepoPath,
      verifyGraphAuthority: true,
      requiredGraphCapabilities: job.requestedCapabilities.graphCapabilities,
    });
  } catch {
    return terminalUnconfirmed(
      job,
      'POSTCHECK_UNAVAILABLE',
      'The final freshness and graph-authority post-check could not be completed.',
      receipt,
    );
  }
  const postCheckFailure = validatePostCheck(job, receipt, postCheck, targetContext);
  if (postCheckFailure) {
    return terminalUnconfirmed(
      job,
      postCheckFailure.reasonCode,
      postCheckFailure.message,
      receipt,
      postCheck,
    );
  }

  let finalPostCheck: EnsureFreshReport;
  let finalTargetContext: TargetContext;
  let generationAfterFirstPostCheck;
  try {
    generationAfterFirstPostCheck = await resolveActiveIndexGeneration(
      path.join(resolvedRepoPath, '.ontoindex'),
    );
    finalPostCheck = await gnEnsureFresh(resolvedRepoPath, {
      repo: resolvedRepoPath,
      withEmbeddings: job.requestedCapabilities.embeddings,
      requiredGraphCapabilities: job.requestedCapabilities.graphCapabilities,
    });
    finalTargetContext = await resolveTargetContext({
      repo: resolvedRepoPath,
      verifyGraphAuthority: true,
      requiredGraphCapabilities: job.requestedCapabilities.graphCapabilities,
    });
  } catch {
    return terminalUnconfirmed(
      job,
      'FINAL_POSTCHECK_UNAVAILABLE',
      'The final stability post-check could not be completed.',
      receipt,
      postCheck,
    );
  }
  if (
    !generationAfterFirstPostCheck ||
    generationAfterFirstPostCheck.generationId !== receipt.generationId
  ) {
    return terminalUnconfirmed(
      job,
      'ACTIVE_GENERATION_CHANGED',
      'The active index generation changed while the job result was being verified.',
      receipt,
      postCheck,
    );
  }
  const finalPostCheckFailure = validatePostCheck(job, receipt, finalPostCheck, finalTargetContext);
  if (finalPostCheckFailure) {
    return terminalUnconfirmed(
      job,
      finalPostCheckFailure.reasonCode,
      finalPostCheckFailure.message,
      receipt,
      finalPostCheck,
    );
  }

  let generationAfterFinalPostCheck;
  try {
    generationAfterFinalPostCheck = await resolveActiveIndexGeneration(
      path.join(resolvedRepoPath, '.ontoindex'),
    );
  } catch {
    return terminalUnconfirmed(
      job,
      'FINAL_GENERATION_CHECK_UNAVAILABLE',
      'The active index generation could not be checked after final verification.',
      receipt,
      finalPostCheck,
    );
  }
  if (
    !generationAfterFinalPostCheck ||
    generationAfterFinalPostCheck.generationId !== receipt.generationId
  ) {
    return terminalUnconfirmed(
      job,
      'ACTIVE_GENERATION_CHANGED',
      'The active index generation changed while the job result was being verified.',
      receipt,
      finalPostCheck,
    );
  }

  let terminalPostCheck: EnsureFreshReport;
  let terminalTargetContext: TargetContext;
  try {
    terminalPostCheck = await gnEnsureFresh(resolvedRepoPath, {
      repo: resolvedRepoPath,
      withEmbeddings: job.requestedCapabilities.embeddings,
      requiredGraphCapabilities: job.requestedCapabilities.graphCapabilities,
    });
    terminalTargetContext = await resolveTargetContext({
      repo: resolvedRepoPath,
      verifyGraphAuthority: true,
      requiredGraphCapabilities: job.requestedCapabilities.graphCapabilities,
    });
  } catch {
    return terminalUnconfirmed(
      job,
      'TERMINAL_POSTCHECK_UNAVAILABLE',
      'The terminal freshness and graph-authority observation could not be completed.',
      receipt,
      finalPostCheck,
    );
  }
  const terminalPostCheckFailure = validatePostCheck(
    job,
    receipt,
    terminalPostCheck,
    terminalTargetContext,
  );
  if (terminalPostCheckFailure) {
    return terminalUnconfirmed(
      job,
      terminalPostCheckFailure.reasonCode,
      terminalPostCheckFailure.message,
      receipt,
      terminalPostCheck,
    );
  }

  return {
    disposition: 'REFRESHED',
    reasonCode: 'PUBLICATION_VERIFIED',
    message:
      'The publication receipt and current index postconditions prove that the requested refresh succeeded.',
    receipt,
    postCheck: terminalPostCheck,
  };
}

function validateReceipt(
  job: AnalysisJobRecord,
  resolvedRepoPath: string,
  activeGenerationId: string,
  receipt: AnalysisPublicationReceipt,
): { reasonCode: string; message: string } | null {
  if (receipt.jobId !== job.id) {
    return mismatch('RECEIPT_JOB_MISMATCH', 'The publication receipt belongs to a different job.');
  }
  if (path.resolve(receipt.repoPath) !== path.resolve(resolvedRepoPath)) {
    return mismatch(
      'RECEIPT_REPO_MISMATCH',
      'The publication receipt belongs to a different repository.',
    );
  }
  if (path.resolve(job.repoPath) !== path.resolve(resolvedRepoPath)) {
    return mismatch(
      'JOB_REPO_MISMATCH',
      'The analysis job belongs to a different repository than the resolved target.',
    );
  }
  if (receipt.targetHead !== job.targetHead) {
    return mismatch(
      'RECEIPT_TARGET_MISMATCH',
      'The publication receipt target does not match the job target.',
    );
  }
  if (receipt.sourceIdentity !== job.sourceIdentity) {
    return mismatch(
      'RECEIPT_SOURCE_IDENTITY_MISMATCH',
      'The publication receipt source identity does not match the job source identity.',
    );
  }
  if (receipt.optionsDigest !== job.optionsDigest) {
    return mismatch(
      'RECEIPT_OPTIONS_MISMATCH',
      'The publication receipt options do not match the job request.',
    );
  }
  if (!sameCapabilities(receipt.requestedCapabilities, job.requestedCapabilities)) {
    return mismatch(
      'RECEIPT_CAPABILITIES_MISMATCH',
      'The publication receipt capabilities do not match the job request.',
    );
  }
  if (receipt.generationId !== activeGenerationId) {
    return mismatch(
      'RECEIPT_GENERATION_MISMATCH',
      'The publication receipt does not belong to the active index generation.',
    );
  }
  if (job.generationId && job.generationId !== receipt.generationId) {
    return mismatch(
      'JOB_GENERATION_MISMATCH',
      'The terminal job record and publication receipt identify different generations.',
    );
  }
  if (job.sourceManifestDigest.toLowerCase() !== receipt.sourceManifestDigest.toLowerCase()) {
    return mismatch(
      'RECEIPT_MANIFEST_MISMATCH',
      'The publication receipt source manifest does not match the terminal job record.',
    );
  }
  return null;
}

function validatePostCheck(
  job: AnalysisJobRecord,
  receipt: AnalysisPublicationReceipt,
  postCheck: EnsureFreshReport,
  targetContext: TargetContext,
): { reasonCode: string; message: string } | null {
  if (
    postCheck.indexedCommit !== job.targetHead ||
    postCheck.headCommit !== job.targetHead ||
    postCheck.preCheck.indexedCommit !== job.targetHead ||
    postCheck.preCheck.currentCommit !== job.targetHead ||
    postCheck.isStale !== false ||
    postCheck.preCheck.isStale !== false
  ) {
    return mismatch(
      'POSTCHECK_TARGET_MISMATCH',
      'The current checkout and indexed commit do not both match the job target.',
    );
  }
  if (postCheck.dirtyFileCount !== 0) {
    return mismatch(
      'POSTCHECK_WORKTREE_UNCONFIRMED',
      'The final freshness post-check did not prove a clean worktree.',
    );
  }
  if (
    targetContext.status !== 'ok' ||
    targetContext.repoPath === undefined ||
    path.resolve(targetContext.repoPath) !== path.resolve(job.repoPath) ||
    targetContext.targetHead !== job.targetHead ||
    targetContext.currentHead !== job.targetHead ||
    targetContext.indexedHead !== job.targetHead
  ) {
    return mismatch(
      'TARGET_CONTEXT_MISMATCH',
      'The authoritative target context does not match the job target and repository.',
    );
  }
  if (targetContext.dirtyWorktree !== false) {
    return mismatch(
      'TARGET_CONTEXT_WORKTREE_UNCONFIRMED',
      'The authoritative target context did not prove a clean worktree.',
    );
  }
  if (targetContext.snapshotMode !== 'committed-head') {
    return mismatch(
      'TARGET_CONTEXT_SNAPSHOT_MISMATCH',
      'The authoritative target context is not a committed-HEAD snapshot.',
    );
  }
  if (targetContext.changedSinceIndex !== false) {
    return mismatch(
      'TARGET_CONTEXT_INDEX_DRIFT',
      'The authoritative target context reports changes since the published index.',
    );
  }
  if (
    targetContext.graphAuthority?.state !== 'authoritative' ||
    targetContext.graphAuthority.generationId !== receipt.generationId ||
    targetContext.graphAuthority.manifestDigest?.toLowerCase() !==
      receipt.sourceManifestDigest.toLowerCase()
  ) {
    return mismatch(
      'GRAPH_AUTHORITY_UNCONFIRMED',
      'The active graph generation is not authoritative for the published receipt.',
    );
  }
  if (job.requestedCapabilities.embeddings) {
    const requestedModelHash = job.requestedCapabilities.embeddingModelHash;
    if (
      !requestedModelHash ||
      postCheck.embeddingsStatus.status !== 'ok' ||
      postCheck.embeddingsStatus.actualModelHash !== requestedModelHash ||
      targetContext.embeddings.status !== 'available' ||
      targetContext.embeddings.modelHash !== requestedModelHash
    ) {
      return mismatch(
        'EMBEDDINGS_UNCONFIRMED',
        'The job requested embeddings, but the active generation does not prove the requested embedding model identity.',
      );
    }
  }
  return null;
}

function sameCapabilities(
  left: AnalysisPublicationReceipt['requestedCapabilities'],
  right: unknown,
): boolean {
  return (
    hasRequestedCapabilities(right) &&
    left.version === right.version &&
    left.graph === right.graph &&
    left.graphCapabilities.length === right.graphCapabilities.length &&
    left.graphCapabilities.every(
      (capability, index) => capability === right.graphCapabilities[index],
    ) &&
    left.embeddings === right.embeddings &&
    left.embeddingModelHash === right.embeddingModelHash
  );
}

function hasRequestedCapabilities(
  value: unknown,
): value is AnalysisJobRecord['requestedCapabilities'] {
  if (typeof value !== 'object' || value === null) return false;
  const capabilities = value as {
    version?: unknown;
    graph?: unknown;
    graphCapabilities?: unknown;
    embeddings?: unknown;
    embeddingModelHash?: unknown;
  };
  if (
    capabilities.version !== 1 ||
    capabilities.graph !== true ||
    !Array.isArray(capabilities.graphCapabilities) ||
    capabilities.graphCapabilities.length === 0 ||
    typeof capabilities.embeddings !== 'boolean'
  ) {
    return false;
  }
  const graphCapabilities = capabilities.graphCapabilities;
  if (
    graphCapabilities.some(
      (capability) =>
        capability !== 'symbols' && capability !== 'impact' && capability !== 'processes',
    ) ||
    graphCapabilities.some((capability, index) =>
      index > 0
        ? String(graphCapabilities[index - 1]).localeCompare(String(capability)) >= 0
        : false,
    )
  ) {
    return false;
  }
  return capabilities.embeddings
    ? typeof capabilities.embeddingModelHash === 'string' &&
        capabilities.embeddingModelHash.trim().length > 0
    : capabilities.embeddingModelHash === null;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

function mismatch(reasonCode: string, message: string): { reasonCode: string; message: string } {
  return { reasonCode, message };
}

function terminalUnconfirmed(
  job: AnalysisJobRecord,
  reasonCode: string,
  message: string,
  receipt?: AnalysisPublicationReceipt,
  postCheck?: EnsureFreshReport,
): AnalysisRecovery {
  return {
    disposition: job.status === 'failed' ? 'FAILED' : 'FRESHNESS_UNCONFIRMED',
    reasonCode,
    message,
    ...(receipt ? { receipt } : {}),
    ...(postCheck ? { postCheck } : {}),
  };
}

function recovery(
  disposition: AnalysisRecoveryDisposition,
  reasonCode: string,
  message: string,
): AnalysisRecovery {
  return { disposition, reasonCode, message };
}
