import type { EnrichmentFact } from './enrichment-record.js';

export const CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION = 1;

export type MarkdownDocumentFactKind =
  | 'markdown-chunk'
  | 'markdown-link'
  | 'markdown-entity'
  | 'markdown-code-mention'
  | 'markdown-requirement'
  | 'markdown-acceptance-criterion'
  | 'markdown-api-spec'
  | 'markdown-test-mention'
  | 'markdown-doc-owner';

export interface MarkdownLineSpan {
  start: number;
  end: number;
}

export interface MarkdownDocumentIdentity {
  docPath: string;
  fileHash: string;
  sourceCommitHash: string;
}

export interface MarkdownFrontmatterMetadata {
  ontoindexKind?: string;
  service?: string;
  owner?: string;
  status?: string;
}

export interface MarkdownRawEvidence {
  text: string;
  raw: string;
  lineSpan: MarkdownLineSpan;
}

export interface MarkdownTypedFactBase extends EnrichmentFact {
  schemaVersion: typeof CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION;
  docPath: string;
  headingPath: string[];
  lineSpan: MarkdownLineSpan;
  sourceChunkKey: string;
  normalizedKey: string;
  confidence: number;
  evidence: MarkdownRawEvidence;
  metadata?: MarkdownFrontmatterMetadata;
}

export interface MarkdownChunkFact extends EnrichmentFact {
  kind: 'markdown-chunk';
  docPath: string;
  fileHash: string;
  sourceCommitHash: string;
  headingPath: string[];
  lineSpan: MarkdownLineSpan;
  chunkIndex: number;
  normalizedAnchor: string;
  contentHash: string;
  chunkKey: string;
  excerpt?: string;
}

export interface MarkdownLinkFact extends EnrichmentFact {
  kind: 'markdown-link';
  fromChunkKey: string;
  toDocPath?: string;
  toHeadingPath?: string[];
  href: string;
  text: string;
  lineSpan: MarkdownLineSpan;
}

export type MarkdownEntityType =
  | 'concept'
  | 'adr'
  | 'module'
  | 'service'
  | 'person'
  | 'product'
  | 'tag';

export interface MarkdownEntityFact extends EnrichmentFact {
  kind: 'markdown-entity';
  entityKey: string;
  label: string;
  normalizedLabel: string;
  entityType: MarkdownEntityType;
  sourceChunkKey: string;
  evidence: {
    text: string;
    lineSpan: MarkdownLineSpan;
  };
}

export type MarkdownCodeMentionTargetType = 'file' | 'symbol' | 'process' | 'cluster';
export type MarkdownCodeMentionResolutionStatus = 'resolved' | 'ambiguous' | 'unresolved' | 'stale';
export type MarkdownCodeMentionResolutionReason =
  | 'no-resolver-configured'
  | 'resolver-returned-no-match'
  | 'resolver-returned-unresolved'
  | (string & {});

export interface MarkdownCodeMentionTarget {
  type: MarkdownCodeMentionTargetType;
  id?: string;
  filePath?: string;
}

export interface MarkdownCodeMentionCandidate extends MarkdownCodeMentionTarget {
  confidence: number;
}

export interface MarkdownCodeMentionFact extends EnrichmentFact {
  kind: 'markdown-code-mention';
  chunkKey: string;
  target: MarkdownCodeMentionTarget;
  confidence: number;
  resolutionStatus: MarkdownCodeMentionResolutionStatus;
  resolutionReason?: MarkdownCodeMentionResolutionReason;
  candidates?: MarkdownCodeMentionCandidate[];
  evidence: {
    text: string;
    lineSpan: MarkdownLineSpan;
  };
}

export interface MarkdownRequirementFact extends MarkdownTypedFactBase {
  kind: 'markdown-requirement';
  requirementId: string;
  title?: string;
  source: 'heading' | 'body';
}

export interface MarkdownAcceptanceCriterionFact extends MarkdownTypedFactBase {
  kind: 'markdown-acceptance-criterion';
  criterion: string;
  ordinal: number;
  requirementId?: string;
}

export type MarkdownHttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS'
  | 'TRACE';

export interface MarkdownApiSpecFact extends MarkdownTypedFactBase {
  kind: 'markdown-api-spec';
  method: MarkdownHttpMethod;
  path: string;
  routeKey: string;
}

export interface MarkdownTestMentionFact extends MarkdownTypedFactBase {
  kind: 'markdown-test-mention';
  mention: string;
  targetPath?: string;
  resolvable: boolean;
  unsafeReason?: 'absolute-path' | 'path-outside-repo';
}

export interface MarkdownDocOwnerFact extends MarkdownTypedFactBase {
  kind: 'markdown-doc-owner';
  owner: string;
  service?: string;
  status?: string;
  ontoindexKind?: string;
}

export type MarkdownDocumentFact =
  | MarkdownChunkFact
  | MarkdownLinkFact
  | MarkdownEntityFact
  | MarkdownCodeMentionFact
  | MarkdownRequirementFact
  | MarkdownAcceptanceCriterionFact
  | MarkdownApiSpecFact
  | MarkdownTestMentionFact
  | MarkdownDocOwnerFact;

export function isMarkdownRequirementFact(fact: EnrichmentFact): fact is MarkdownRequirementFact {
  return fact.kind === 'markdown-requirement';
}

export function isMarkdownAcceptanceCriterionFact(
  fact: EnrichmentFact,
): fact is MarkdownAcceptanceCriterionFact {
  return fact.kind === 'markdown-acceptance-criterion';
}

export function isMarkdownApiSpecFact(fact: EnrichmentFact): fact is MarkdownApiSpecFact {
  return fact.kind === 'markdown-api-spec';
}

export function isMarkdownTestMentionFact(fact: EnrichmentFact): fact is MarkdownTestMentionFact {
  return fact.kind === 'markdown-test-mention';
}

export function isMarkdownDocOwnerFact(fact: EnrichmentFact): fact is MarkdownDocOwnerFact {
  return fact.kind === 'markdown-doc-owner';
}

export function normalizeMarkdownAnchor(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function createMarkdownChunkKey(input: {
  docPath: string;
  fileHash: string;
  headingPath: readonly string[];
  normalizedAnchor: string;
  contentHash: string;
}): string {
  return [
    'markdown-chunk',
    input.docPath,
    input.fileHash,
    input.headingPath.join('/'),
    input.normalizedAnchor,
    input.contentHash,
  ].join(':');
}
