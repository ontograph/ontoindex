import { CURRENT_CONTRACT } from '../../contract/versions.js';
import {
  DOCS_REPORT_LIMITS,
  DOCS_REPORT_VERSION,
  DOCS_STALE_REASON_COMMIT_MISMATCH,
  DOCS_STALE_REASON_DOC_HASH_MISMATCH,
  DOCS_STALE_REASON_SOURCE_INDEX_MISMATCH,
  type DocsReportEnvelope,
  type DocsSidecarStatus,
  type DocsStaleReason,
  type MarkdownSidecarSnapshotManifest,
  type SourceIndexGraphStats,
  type SourceIndexIdentity,
} from './docs-contracts.js';
import { type CollectedMarkdownSidecarDocuments } from './markdown-sidecar-collector.js';
import { hashText } from './markdown-sidecar-producer.js';
import { MARKDOWN_DOCUMENT_ANALYZER_ID } from './markdown-sidecar-request.js';
import { MARKDOWN_DOCUMENT_DEFAULT_ANALYZER_VERSION } from './markdown-sidecar-runner.js';
import type { SidecarStoreState } from './sidecar-store.js';

interface ManifestIdentityEvaluation {
  staleReasons: DocsStaleReason[];
  degradedReasons: Record<string, number>;
  summary: Record<string, unknown>;
  warnings: string[];
  hasPartialCoverage: boolean;
}

export interface DocsSidecarRepoMeta {
  repoPath: string;
  lastCommit?: string;
  indexedAt: string;
  stats?: SourceIndexGraphStats;
}

export function createMissingDocsSidecarStatusReport(repoPath: string): DocsReportEnvelope {
  return {
    version: DOCS_REPORT_VERSION,
    repo: {
      id: 'unknown',
      path: repoPath,
    },
    sidecar: {
      status: 'missing',
      staleReasons: [],
      degradedReasons: {},
    },
    summary: {},
    items: [],
    warnings: [],
    limits: { ...DOCS_REPORT_LIMITS },
  };
}

export function createDocsSourceIndexIdentity(
  meta: DocsSidecarRepoMeta,
  repoPath: string,
): SourceIndexIdentity {
  return {
    repoId: meta.repoPath,
    repoPath,
    sourceIndexId: meta.indexedAt,
    indexedAt: meta.indexedAt,
    sourceCommitHash: meta.lastCommit,
    graphSchemaVersion: CURRENT_CONTRACT.graph_schema,
    graphStats: meta.stats,
    graphDigest: undefined,
  };
}

export function createMarkdownSidecarSnapshotManifest(
  identity: SourceIndexIdentity,
  collection: CollectedMarkdownSidecarDocuments,
): MarkdownSidecarSnapshotManifest {
  return {
    repoId: identity.repoId,
    repoPath: identity.repoPath,
    sourceIndexId: identity.sourceIndexId,
    sourceCommitHash: identity.sourceCommitHash ?? '',
    graphSchemaVersion: identity.graphSchemaVersion,
    analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
    analyzerVersion: MARKDOWN_DOCUMENT_DEFAULT_ANALYZER_VERSION,
    files: collection.documents
      .map((document) => ({
        docPath: document.docPath,
        fileHash: hashText(document.source),
      }))
      .sort((left, right) => left.docPath.localeCompare(right.docPath)),
  };
}

export function createDocsSidecarStatusReport(
  identity: SourceIndexIdentity,
  state: SidecarStoreState,
  staleReasons: DocsStaleReason[],
  warnings: string[],
  manifest?: MarkdownSidecarSnapshotManifest,
): DocsReportEnvelope {
  const requestCounts = countByStatus(state.requests);
  const enrichmentCounts = countByStatus(state.enrichments);
  const manifestIdentity = evaluateManifestIdentity(identity, state, manifest);
  const combinedStaleReasons = uniqueStrings([
    ...staleReasons,
    ...manifestIdentity.staleReasons,
  ]) as DocsStaleReason[];
  const status = classifyDocsSidecarStatus(
    state,
    requestCounts,
    enrichmentCounts,
    combinedStaleReasons,
    manifestIdentity.hasPartialCoverage,
  );

  const report: DocsReportEnvelope = {
    version: DOCS_REPORT_VERSION,
    repo: {
      id: identity.repoId,
      path: identity.repoPath,
      sourceIndexId: identity.sourceIndexId,
      indexedAt: identity.indexedAt,
      sourceCommitHash: identity.sourceCommitHash,
      graphSchemaVersion: identity.graphSchemaVersion,
      graphStats: identity.graphStats,
      graphDigest: identity.graphDigest,
    },
    sidecar: {
      status,
      staleReasons: combinedStaleReasons,
      degradedReasons: {
        failed: enrichmentCounts.failed ?? 0,
        partial: enrichmentCounts.partial ?? 0,
        stale: enrichmentCounts.stale ?? 0,
        ...manifestIdentity.degradedReasons,
      },
    },
    summary: {
      queued: requestCounts.queued ?? 0,
      running: Math.max(requestCounts.running ?? 0, state.lock ? 1 : 0),
      complete: enrichmentCounts.complete ?? 0,
      partial: Math.max(requestCounts.partial ?? 0, enrichmentCounts.partial ?? 0),
      failed: Math.max(requestCounts.failed ?? 0, enrichmentCounts.failed ?? 0),
      stale: Math.max(requestCounts.stale ?? 0, enrichmentCounts.stale ?? 0),
      cancelled: Math.max(requestCounts.cancelled ?? 0, enrichmentCounts.cancelled ?? 0),
      superseded: Math.max(requestCounts.superseded ?? 0, enrichmentCounts.superseded ?? 0),
      requests: requestCounts,
      enrichments: enrichmentCounts,
      lock: state.lock
        ? {
            ownerId: state.lock.ownerId,
            pid: state.lock.pid,
            analyzerId: state.lock.analyzerId,
            sourceIndexId: state.lock.sourceIndexId,
            startedAt: state.lock.startedAt,
            heartbeatAt: state.lock.heartbeatAt,
            leaseExpiresAt: state.lock.leaseExpiresAt,
          }
        : null,
      manifest: manifestIdentity.summary,
    },
    items: [],
    warnings: [...warnings, ...manifestIdentity.warnings],
    limits: { ...DOCS_REPORT_LIMITS },
  };
  if (manifest) {
    report.manifest = manifest;
  }
  return report;
}

function countByStatus(records: readonly { status: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function classifyDocsSidecarStatus(
  state: SidecarStoreState,
  requestCounts: Record<string, number>,
  enrichmentCounts: Record<string, number>,
  staleReasons: DocsStaleReason[],
  hasPartialManifestCoverage = false,
): DocsSidecarStatus {
  if (state.lock || (requestCounts.running ?? 0) > 0) return 'running';
  if ((enrichmentCounts.failed ?? 0) > 0 || (requestCounts.failed ?? 0) > 0) return 'failed';
  if (staleReasons.length > 0 && (state.requests.length > 0 || state.enrichments.length > 0)) {
    return 'stale';
  }
  if ((enrichmentCounts.partial ?? 0) > 0 || (requestCounts.partial ?? 0) > 0) return 'partial';
  if ((requestCounts.queued ?? 0) > 0) return 'queued';
  if (hasPartialManifestCoverage) return 'partial';
  if ((enrichmentCounts.complete ?? 0) > 0) return 'complete';
  if (state.requests.length > 0 || state.enrichments.length > 0) return 'available';
  return 'missing';
}

export function getDocsSidecarStaleReasons(
  identity: SourceIndexIdentity,
  currentCommit: string | null,
): DocsStaleReason[] {
  if (!currentCommit || !identity.sourceCommitHash || currentCommit === identity.sourceCommitHash) {
    return [];
  }
  return [DOCS_STALE_REASON_COMMIT_MISMATCH];
}

function evaluateManifestIdentity(
  identity: SourceIndexIdentity,
  state: SidecarStoreState,
  manifest: MarkdownSidecarSnapshotManifest | undefined,
): ManifestIdentityEvaluation {
  const markdownRecords = state.enrichments.filter(isMarkdownEnrichmentRecord);
  const staleReasons = new Set<DocsStaleReason>();
  const degradedReasons: Record<string, number> = {};
  const warnings: string[] = [];
  const files = manifest?.files ?? [];
  const filesByPath = new Map(files.map((file) => [file.docPath, file.fileHash]));
  const freshFiles = new Set<string>();
  let sourceIndexMismatches = 0;
  let docHashMismatches = 0;
  let recordsMissingIdentity = 0;

  for (const request of state.requests) {
    if (request.analyzerId !== MARKDOWN_DOCUMENT_ANALYZER_ID) continue;
    if (request.sourceIndexId !== identity.sourceIndexId) {
      sourceIndexMismatches += 1;
    }
  }

  for (const record of markdownRecords) {
    const sourceIndexId = readString(record, 'sourceIndexId');
    const sourceCommitHash = readString(record, 'sourceCommitHash');
    const filePath = readString(record, 'filePath');
    const fileHash = readString(record, 'fileHash');
    const schemaVersion = readNumber(record, 'schemaVersion');

    if (
      !sourceIndexId ||
      !sourceCommitHash ||
      schemaVersion === undefined ||
      !filePath ||
      !fileHash
    ) {
      recordsMissingIdentity += 1;
      continue;
    }

    if (
      sourceIndexId !== identity.sourceIndexId ||
      (identity.sourceCommitHash && sourceCommitHash !== identity.sourceCommitHash)
    ) {
      sourceIndexMismatches += 1;
    }

    const manifestFileHash = filesByPath.get(filePath);
    if (manifestFileHash === undefined) continue;
    if (fileHash !== manifestFileHash) {
      docHashMismatches += 1;
      continue;
    }
    if (
      sourceIndexId === identity.sourceIndexId &&
      (!identity.sourceCommitHash || sourceCommitHash === identity.sourceCommitHash)
    ) {
      freshFiles.add(filePath);
    }
  }

  const missingFiles = files.filter((file) => !freshFiles.has(file.docPath));
  if (sourceIndexMismatches > 0) {
    staleReasons.add(DOCS_STALE_REASON_SOURCE_INDEX_MISMATCH);
    degradedReasons['source-index-mismatch'] = sourceIndexMismatches;
    warnings.push(`source index mismatch for ${sourceIndexMismatches} markdown sidecar record(s)`);
  }
  if (docHashMismatches > 0) {
    staleReasons.add(DOCS_STALE_REASON_DOC_HASH_MISMATCH);
    degradedReasons['doc-hash-mismatch'] = docHashMismatches;
    warnings.push(`doc hash mismatch for ${docHashMismatches} markdown sidecar record(s)`);
  }
  if (recordsMissingIdentity > 0) {
    degradedReasons['missing-manifest-identity'] = recordsMissingIdentity;
    warnings.push(
      `missing manifest identity on ${recordsMissingIdentity} markdown sidecar record(s)`,
    );
  }
  if (manifest && missingFiles.length > 0 && markdownRecords.length > 0) {
    degradedReasons['missing-manifest-coverage'] = missingFiles.length;
    warnings.push(`missing manifest coverage for ${missingFiles.length} markdown file(s)`);
  }

  return {
    staleReasons: [...staleReasons],
    degradedReasons,
    summary: {
      files: files.length,
      coveredFiles: freshFiles.size,
      missingFiles: missingFiles.length,
      sourceIndexMismatches,
      docHashMismatches,
      recordsMissingIdentity,
      available: manifest !== undefined,
    },
    warnings,
    hasPartialCoverage:
      staleReasons.size === 0 &&
      manifest !== undefined &&
      files.length > 0 &&
      markdownRecords.length > 0 &&
      (missingFiles.length > 0 || recordsMissingIdentity > 0),
  };
}

function isMarkdownEnrichmentRecord(record: unknown): record is Record<string, unknown> {
  if (typeof record !== 'object' || record === null) return false;
  const analyzerId = readString(record, 'analyzerId');
  return analyzerId === undefined || analyzerId === MARKDOWN_DOCUMENT_ANALYZER_ID;
}

function readString(record: object, field: string): string | undefined {
  const value = (record as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(record: object, field: string): number | undefined {
  const value = (record as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
