import fs from 'node:fs/promises';
import path from 'node:path';

import { SOURCE_MANIFEST_CONTRACT } from '../indexing/source-manifest.js';

export const ANALYSIS_REQUESTED_CAPABILITIES_VERSION = 1 as const;
export const ANALYSIS_PUBLICATION_RECEIPT_VERSION = 1 as const;

export const MANAGED_ANALYSIS_ENV = {
  jobId: 'ONTOINDEX_ANALYSIS_JOB_ID',
  targetHead: 'ONTOINDEX_ANALYSIS_TARGET_HEAD',
  optionsDigest: 'ONTOINDEX_ANALYSIS_OPTIONS_DIGEST',
  sourceIdentity: 'ONTOINDEX_ANALYSIS_SOURCE_IDENTITY',
  sourceManifestDigest: 'ONTOINDEX_ANALYSIS_SOURCE_MANIFEST_DIGEST',
  requestedCapabilities: 'ONTOINDEX_ANALYSIS_REQUESTED_CAPABILITIES',
} as const;

const RECEIPT_DIRECTORY = 'analysis-receipts';
const MAX_RECEIPT_BYTES = 64 * 1024;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_HEAD = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const SHA256_DIGEST = /^[0-9a-fA-F]{64}$/;

/** Version 1 of the capabilities requested by a managed analysis job. */
export type AnalysisGraphCapability = 'symbols' | 'impact' | 'processes';
export type AnalysisRequestedCapabilities = {
  version: typeof ANALYSIS_REQUESTED_CAPABILITIES_VERSION;
  graph: true;
  graphCapabilities: AnalysisGraphCapability[];
  embeddings: boolean;
  embeddingModelHash: string | null;
};

export interface ManagedAnalysisContext {
  jobId: string;
  targetHead: string;
  optionsDigest: string;
  sourceIdentity: string;
  sourceManifestDigest: string;
  requestedCapabilities: AnalysisRequestedCapabilities;
}

export interface AnalysisPublicationReceipt {
  version: typeof ANALYSIS_PUBLICATION_RECEIPT_VERSION;
  jobId: string;
  repoPath: string;
  targetHead: string;
  optionsDigest: string;
  sourceIdentity: string;
  sourceManifestDigest: string;
  generationId: string;
  requestedCapabilities: AnalysisRequestedCapabilities;
  analyzerContractVersion: typeof SOURCE_MANIFEST_CONTRACT;
  publishedAt: string;
}

export function parseManagedAnalysisContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ManagedAnalysisContext | undefined {
  const raw = {
    jobId: env[MANAGED_ANALYSIS_ENV.jobId],
    targetHead: env[MANAGED_ANALYSIS_ENV.targetHead],
    optionsDigest: env[MANAGED_ANALYSIS_ENV.optionsDigest],
    sourceIdentity: env[MANAGED_ANALYSIS_ENV.sourceIdentity],
    sourceManifestDigest: env[MANAGED_ANALYSIS_ENV.sourceManifestDigest],
    requestedCapabilities: env[MANAGED_ANALYSIS_ENV.requestedCapabilities],
  };
  const presentCount = Object.values(raw).filter((value) => value !== undefined).length;
  if (presentCount === 0) return undefined;
  if (presentCount !== Object.keys(raw).length) {
    throw new Error('Managed analysis context is incomplete.');
  }

  let requestedCapabilities: unknown;
  try {
    const serialized = raw.requestedCapabilities as string;
    if (serialized.length > 1024) throw new Error('capabilities payload is too large');
    requestedCapabilities = JSON.parse(serialized);
  } catch {
    throw new Error('Managed analysis requested capabilities are malformed.');
  }

  const context: ManagedAnalysisContext = {
    jobId: (raw.jobId as string).trim(),
    targetHead: (raw.targetHead as string).trim(),
    optionsDigest: (raw.optionsDigest as string).trim(),
    sourceIdentity: (raw.sourceIdentity as string).trim(),
    sourceManifestDigest: (raw.sourceManifestDigest as string).trim(),
    requestedCapabilities: requireRequestedCapabilities(requestedCapabilities),
  };
  assertValidManagedAnalysisContext(context);
  return context;
}

export function assertValidManagedAnalysisContext(
  context: ManagedAnalysisContext,
): asserts context is ManagedAnalysisContext {
  requireSafeIdentifier(context.jobId, 'managed analysis job id');
  requireGitHead(context.targetHead, 'managed analysis target HEAD');
  requireSha256(context.optionsDigest, 'managed analysis options digest');
  requireSourceIdentity(context.sourceIdentity, context.targetHead);
  requireSha256(context.sourceManifestDigest, 'managed analysis source manifest digest');
  requireRequestedCapabilities(context.requestedCapabilities);
}

export function analysisPublicationReceiptPath(generationPath: string, jobId: string): string {
  const safeJobId = requireSafeIdentifier(jobId, 'analysis receipt job id');
  return path.join(path.resolve(generationPath), RECEIPT_DIRECTORY, `${safeJobId}.json`);
}

export async function writeAnalysisPublicationReceipt(
  generationPath: string,
  receipt: AnalysisPublicationReceipt,
): Promise<string> {
  const validated = requireAnalysisPublicationReceipt(receipt);
  const receiptPath = analysisPublicationReceiptPath(generationPath, validated.jobId);
  const receiptDirectory = path.dirname(receiptPath);
  await fs.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    receiptDirectory,
    `.${path.basename(receiptPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, receiptPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return receiptPath;
}

/**
 * Read a receipt from a caller-resolved active generation. Missing, malformed,
 * oversized, or identity-mismatched receipts fail closed as `null`.
 */
export async function readAnalysisPublicationReceipt(
  activeGenerationPath: string,
  jobId: string,
): Promise<AnalysisPublicationReceipt | null> {
  try {
    const receiptPath = analysisPublicationReceiptPath(activeGenerationPath, jobId);
    const stat = await fs.stat(receiptPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECEIPT_BYTES) return null;
    const parsed: unknown = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    const receipt = requireAnalysisPublicationReceipt(parsed);
    return receipt.jobId === jobId ? receipt : null;
  } catch {
    return null;
  }
}

function requireAnalysisPublicationReceipt(value: unknown): AnalysisPublicationReceipt {
  if (!isRecord(value)) throw new Error('Analysis publication receipt is malformed.');
  if (value.version !== ANALYSIS_PUBLICATION_RECEIPT_VERSION) {
    throw new Error('Analysis publication receipt version is unsupported.');
  }
  const repoPath = requireNonEmptyString(value.repoPath, 'analysis receipt repository path');
  if (!path.isAbsolute(repoPath) || path.resolve(repoPath) !== repoPath) {
    throw new Error('Analysis receipt repository path must be resolved.');
  }
  const publishedAt = requireNonEmptyString(value.publishedAt, 'analysis receipt publication time');
  if (!Number.isFinite(Date.parse(publishedAt))) {
    throw new Error('Analysis receipt publication time is malformed.');
  }
  if (value.analyzerContractVersion !== SOURCE_MANIFEST_CONTRACT) {
    throw new Error('Analysis receipt analyzer contract is unsupported.');
  }

  const targetHead = requireGitHead(value.targetHead, 'analysis receipt target HEAD');
  return {
    version: ANALYSIS_PUBLICATION_RECEIPT_VERSION,
    jobId: requireSafeIdentifier(value.jobId, 'analysis receipt job id'),
    repoPath,
    targetHead,
    optionsDigest: requireSha256(value.optionsDigest, 'analysis receipt options digest'),
    sourceIdentity: requireSourceIdentity(value.sourceIdentity, targetHead),
    sourceManifestDigest: requireSha256(
      value.sourceManifestDigest,
      'analysis receipt source manifest digest',
    ),
    generationId: requireSafeIdentifier(value.generationId, 'analysis receipt generation id'),
    requestedCapabilities: requireRequestedCapabilities(value.requestedCapabilities),
    analyzerContractVersion: SOURCE_MANIFEST_CONTRACT,
    publishedAt,
  };
}

function requireRequestedCapabilities(value: unknown): AnalysisRequestedCapabilities {
  if (
    !isRecord(value) ||
    value.version !== ANALYSIS_REQUESTED_CAPABILITIES_VERSION ||
    value.graph !== true ||
    !Array.isArray(value.graphCapabilities) ||
    typeof value.embeddings !== 'boolean'
  ) {
    throw new Error('Managed analysis requested capabilities are malformed.');
  }
  const graphCapabilities = [...new Set(value.graphCapabilities)].sort();
  if (
    graphCapabilities.length === 0 ||
    graphCapabilities.length !== value.graphCapabilities.length ||
    graphCapabilities.some(
      (capability) =>
        capability !== 'symbols' && capability !== 'impact' && capability !== 'processes',
    ) ||
    graphCapabilities.some((capability, index) => capability !== value.graphCapabilities[index])
  ) {
    throw new Error('Managed analysis requested capabilities are malformed.');
  }
  const embeddingModelHash = value.embeddingModelHash;
  if (
    (value.embeddings &&
      (typeof embeddingModelHash !== 'string' || embeddingModelHash.trim().length === 0)) ||
    (!value.embeddings && embeddingModelHash !== null)
  ) {
    throw new Error('Managed analysis requested capabilities are malformed.');
  }
  return {
    version: ANALYSIS_REQUESTED_CAPABILITIES_VERSION,
    graph: true,
    graphCapabilities: graphCapabilities as AnalysisGraphCapability[],
    embeddings: value.embeddings,
    embeddingModelHash: value.embeddings ? (embeddingModelHash as string).trim() : null,
  };
}

function requireSafeIdentifier(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${fieldName} is malformed.`);
  }
  return value;
}

function requireGitHead(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !GIT_HEAD.test(value)) {
    throw new Error(`${fieldName} is malformed.`);
  }
  return value;
}

function requireSha256(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw new Error(`${fieldName} is malformed.`);
  }
  return value;
}

function requireSourceIdentity(value: unknown, targetHead: string): string {
  if (value !== `commit:${targetHead}`) {
    throw new Error('Managed analysis source identity is malformed.');
  }
  return value;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} is malformed.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
