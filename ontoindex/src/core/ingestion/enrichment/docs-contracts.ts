import type { MARKDOWN_DOCUMENT_ANALYZER_ID } from './markdown-sidecar-request.js';

export const DOCS_REPORT_VERSION = 1 as const;

export const DOCS_REPORT_LIMITS = {
  truncated: false,
  maxItems: 100,
  maxCandidatesPerFact: 5,
} as const;

export const DOCS_SIDECAR_STATUSES = [
  'available',
  'queued',
  'running',
  'complete',
  'partial',
  'stale',
  'failed',
  'missing',
] as const;

export type DocsSidecarStatus = (typeof DOCS_SIDECAR_STATUSES)[number];

export const DOCS_STALE_REASON_COMMIT_MISMATCH = 'commit mismatch' as const;
export const DOCS_STALE_REASON_SOURCE_INDEX_MISMATCH = 'source index mismatch' as const;
export const DOCS_STALE_REASON_DOC_HASH_MISMATCH = 'doc hash mismatch' as const;
export type DocsStaleReason =
  | typeof DOCS_STALE_REASON_COMMIT_MISMATCH
  | typeof DOCS_STALE_REASON_SOURCE_INDEX_MISMATCH
  | typeof DOCS_STALE_REASON_DOC_HASH_MISMATCH
  | (string & {});

export const DOCS_DEGRADED_REASON_KEYS = ['failed', 'partial', 'stale'] as const;
export type DocsDegradedReason = (typeof DOCS_DEGRADED_REASON_KEYS)[number] | (string & {});
export type DocsDegradedReasonCounts = Record<string, number>;

export interface SourceIndexGraphStats {
  files?: number;
  nodes?: number;
  edges?: number;
  relationships?: number;
  communities?: number;
  processes?: number;
  embeddings?: number;
}

export interface SourceIndexIdentity {
  repoId: string;
  repoPath: string;
  sourceIndexId: string;
  indexedAt?: string;
  sourceCommitHash?: string;
  graphSchemaVersion: number;
  graphStats?: SourceIndexGraphStats;
  graphDigest?: string;
}

export interface MarkdownSidecarSnapshotManifest {
  repoId: string;
  repoPath: string;
  sourceIndexId: string;
  sourceCommitHash: string;
  graphSchemaVersion: number;
  analyzerId: typeof MARKDOWN_DOCUMENT_ANALYZER_ID;
  analyzerVersion: string;
  files: Array<{
    docPath: string;
    fileHash: string;
  }>;
}

export interface DocsReportEnvelope<TItem = unknown> {
  version: typeof DOCS_REPORT_VERSION;
  repo: {
    id: string;
    path?: string;
    sourceIndexId?: string;
    indexedAt?: string;
    sourceCommitHash?: string;
    graphSchemaVersion?: number;
    graphStats?: SourceIndexGraphStats;
    graphDigest?: string;
  };
  sidecar: {
    status: DocsSidecarStatus;
    staleReasons: DocsStaleReason[];
    degradedReasons: DocsDegradedReasonCounts;
  };
  summary: Record<string, unknown>;
  items: TItem[];
  warnings: string[];
  limits: {
    truncated: boolean;
    maxItems: number;
    maxCandidatesPerFact: number;
    maxRelatedDocs?: number;
  };
  manifest?: MarkdownSidecarSnapshotManifest;
}
