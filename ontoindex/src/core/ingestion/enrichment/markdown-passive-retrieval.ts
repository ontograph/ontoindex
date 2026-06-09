import { createHash } from 'node:crypto';

import { decideEnrichmentFreshness } from './enrichment-record.js';
import type { EnrichmentFact, EnrichmentRecord, EnrichmentSnapshot } from './enrichment-record.js';

export interface MarkdownPassiveRetrievalQuery {
  docPath?: string;
  filePath?: string;
  symbolId?: string;
  processId?: string;
  clusterId?: string;
  headingPath?: readonly string[];
  chunkKey?: string;
  entityKey?: string;
}

export interface MarkdownPassiveRetrievalOptions {
  topK: number;
  snapshotsByDocPath?: ReadonlyMap<string, EnrichmentSnapshot> | Record<string, EnrichmentSnapshot>;
}

export interface MarkdownRelatedChunk {
  chunkKey: string;
  docPath: string;
  fileHash: string;
  headingPath: string[];
  lineSpan: { start: number; end: number };
  chunkIndex: number;
  normalizedAnchor: string;
  contentHash: string;
  excerpt?: string;
  excerptPointer?: string;
  score: number;
  reasons: string[];
  mentions: Array<{
    target: unknown;
    confidence?: number;
    resolutionStatus?: string;
    evidence?: unknown;
  }>;
  explanation: {
    retriever: 'markdown-bm25' | 'markdown-code-mentions';
    reasons: string[];
  };
}

export interface MarkdownRelatedDoc {
  docPath: string;
  fileHash: string;
  chunkCount: number;
  score: number;
  headingPaths: string[][];
}

export type MarkdownPassiveRetrievalSkipReason =
  | 'stale-enrichment'
  | 'empty-facts'
  | 'non-markdown-fact'
  | 'top-k-exceeded';

export interface MarkdownPassiveRetrievalResult<TPrimary> {
  primaryResults: readonly TPrimary[];
  relatedChunks: MarkdownRelatedChunk[];
  relatedDocs: MarkdownRelatedDoc[];
  skipped: Array<{
    factKey?: string;
    reason: MarkdownPassiveRetrievalSkipReason;
    detail?: string;
  }>;
  summary: {
    candidateCount: number;
    relatedChunkCount: number;
    relatedDocCount: number;
    degraded: boolean;
    degradedReasons: Partial<Record<MarkdownPassiveRetrievalSkipReason, number>>;
  };
  explanation: {
    retrievers: Array<{
      name: 'markdown-bm25' | 'markdown-code-mentions';
      factCount: number;
      chunkCount: number;
      reasons: string[];
    }>;
  };
}

interface CandidateChunk {
  chunk: MarkdownRelatedChunk;
  factKey: string;
}

const CHUNK_BASE_SCORE = 0.8;
const ENTITY_BASE_SCORE = 0.7;
const MENTION_BASE_SCORE = 0.65;

export function selectMarkdownPassiveRetrieval<TPrimary>(
  primaryResults: readonly TPrimary[],
  records: readonly EnrichmentRecord[],
  query: MarkdownPassiveRetrievalQuery,
  options: MarkdownPassiveRetrievalOptions,
): MarkdownPassiveRetrievalResult<TPrimary> {
  const topK = normalizePositiveInteger(options.topK, 'topK');
  const chunksByKey = new Map<string, CandidateChunk>();
  const chunkFactsByKey = new Map<string, MarkdownRelatedChunk>();
  const usableFacts: Array<{ fact: EnrichmentFact; record: EnrichmentRecord }> = [];
  const mentionFacts: EnrichmentFact[] = [];
  const skipped: MarkdownPassiveRetrievalResult<TPrimary>['skipped'] = [];
  const degradedReasons: Partial<Record<MarkdownPassiveRetrievalSkipReason, number>> = {};
  let candidateCount = 0;

  for (const record of records) {
    const snapshot = snapshotForRecord(record, options.snapshotsByDocPath);
    if (snapshot !== undefined) {
      const freshness = decideEnrichmentFreshness(record, snapshot);
      if (!freshness.usable) {
        addSkip(skipped, degradedReasons, { reason: 'stale-enrichment', detail: freshness.reason });
        continue;
      }
    }
    if (record.records.length === 0) {
      addSkip(skipped, degradedReasons, { reason: 'empty-facts' });
      continue;
    }

    for (const fact of record.records) {
      if (!String(fact.kind).startsWith('markdown-')) {
        continue;
      }
      usableFacts.push({ fact, record });
      if (fact.kind === 'markdown-chunk') {
        const chunk = chunkFromFact(fact, CHUNK_BASE_SCORE, ['chunk-index'], 'markdown-bm25');
        chunkFactsByKey.set(chunk.chunkKey, chunk);
      } else if (fact.kind === 'markdown-code-mention') {
        mentionFacts.push(fact);
      }
    }
  }

  for (const { fact, record } of usableFacts) {
    const candidate = candidateFromFact(fact, record, query, chunkFactsByKey);
    if (candidate !== undefined) {
      candidateCount += 1;
      const existing = chunksByKey.get(candidate.chunk.chunkKey);
      if (existing === undefined || compareCandidate(candidate, existing) < 0) {
        chunksByKey.set(candidate.chunk.chunkKey, candidate);
      }
    }
  }

  for (const candidate of chunksByKey.values()) {
    candidate.chunk.mentions = mentionFacts
      .filter((fact) => fact.chunkKey === candidate.chunk.chunkKey)
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
      .map((fact) => ({
        target: fact.target,
        confidence: typeof fact.confidence === 'number' ? fact.confidence : undefined,
        resolutionStatus:
          typeof fact.resolutionStatus === 'string' ? fact.resolutionStatus : undefined,
        evidence: fact.evidence,
      }));
  }

  const sortedChunks = [...chunksByKey.values()].sort(compareCandidate);
  const relatedChunks = sortedChunks.slice(0, topK).map((candidate) => candidate.chunk);
  for (const candidate of sortedChunks.slice(topK)) {
    addSkip(skipped, degradedReasons, { factKey: candidate.factKey, reason: 'top-k-exceeded' });
  }
  const relatedDocs = docsFromChunks(relatedChunks);

  return {
    primaryResults,
    relatedChunks,
    relatedDocs,
    skipped,
    summary: {
      candidateCount,
      relatedChunkCount: relatedChunks.length,
      relatedDocCount: relatedDocs.length,
      degraded: skipped.length > 0,
      degradedReasons,
    },
    explanation: {
      retrievers: retrieversFromChunks(relatedChunks),
    },
  };
}

function candidateFromFact(
  fact: EnrichmentFact,
  record: EnrichmentRecord,
  query: MarkdownPassiveRetrievalQuery,
  chunkFactsByKey: ReadonlyMap<string, MarkdownRelatedChunk>,
): CandidateChunk | undefined {
  if (fact.kind === 'markdown-chunk' && matchesChunkFact(fact, query)) {
    return {
      factKey: factKey(record, fact),
      chunk: chunkFromFact(fact, CHUNK_BASE_SCORE, ['chunk-match'], 'markdown-bm25'),
    };
  }

  if (fact.kind === 'markdown-entity' && matchesEntityFact(fact, query)) {
    const chunkKey = stringValue(fact.sourceChunkKey);
    if (chunkKey === undefined) return undefined;
    const chunk = chunkFactsByKey.get(chunkKey);
    return {
      factKey: factKey(record, fact),
      chunk: chunk
        ? rescoreChunk(chunk, ENTITY_BASE_SCORE, ['entity-match'], 'markdown-bm25')
        : placeholderChunk(record, chunkKey, ENTITY_BASE_SCORE, ['entity-match'], 'markdown-bm25'),
    };
  }

  if (fact.kind === 'markdown-code-mention' && matchesMentionFact(fact, query)) {
    const chunkKey = stringValue(fact.chunkKey);
    if (chunkKey === undefined) return undefined;
    const score =
      MENTION_BASE_SCORE + (typeof fact.confidence === 'number' ? fact.confidence / 10 : 0);
    const reasons = ['code-mention-match', String(fact.resolutionStatus ?? 'unknown-resolution')];
    const chunk = chunkFactsByKey.get(chunkKey);
    return {
      factKey: factKey(record, fact),
      chunk: chunk
        ? rescoreChunk(chunk, score, reasons, 'markdown-code-mentions')
        : placeholderChunk(record, chunkKey, score, reasons, 'markdown-code-mentions'),
    };
  }

  return undefined;
}

function matchesChunkFact(fact: EnrichmentFact, query: MarkdownPassiveRetrievalQuery): boolean {
  return (
    stringMatches(fact.docPath, query.docPath) ||
    stringMatches(fact.chunkKey, query.chunkKey) ||
    headingMatches(fact.headingPath, query.headingPath)
  );
}

function matchesEntityFact(fact: EnrichmentFact, query: MarkdownPassiveRetrievalQuery): boolean {
  return (
    stringMatches(fact.entityKey, query.entityKey) ||
    stringMatches(fact.sourceChunkKey, query.chunkKey)
  );
}

function matchesMentionFact(fact: EnrichmentFact, query: MarkdownPassiveRetrievalQuery): boolean {
  if (stringMatches(fact.chunkKey, query.chunkKey)) return true;
  if (!isRecord(fact.target)) return false;
  return (
    (query.filePath !== undefined &&
      fact.target.type === 'file' &&
      fact.target.filePath === query.filePath) ||
    (query.symbolId !== undefined &&
      fact.target.type === 'symbol' &&
      fact.target.id === query.symbolId) ||
    (query.processId !== undefined &&
      fact.target.type === 'process' &&
      fact.target.id === query.processId) ||
    (query.clusterId !== undefined &&
      fact.target.type === 'cluster' &&
      fact.target.id === query.clusterId)
  );
}

function chunkFromFact(
  fact: EnrichmentFact,
  score: number,
  reasons: string[],
  retriever: MarkdownRelatedChunk['explanation']['retriever'],
): MarkdownRelatedChunk {
  return {
    chunkKey: stringValue(fact.chunkKey) ?? buildChunkKey(fact),
    docPath: requireString(fact.docPath, 'docPath'),
    fileHash: requireString(fact.fileHash, 'fileHash'),
    headingPath: stringArray(fact.headingPath),
    lineSpan: lineSpan(fact.lineSpan),
    chunkIndex: numberValue(fact.chunkIndex) ?? 0,
    normalizedAnchor: requireString(fact.normalizedAnchor, 'normalizedAnchor'),
    contentHash: requireString(fact.contentHash, 'contentHash'),
    excerpt: stringValue(fact.excerpt),
    excerptPointer: stringValue(fact.excerptPointer),
    score: roundScore(score),
    reasons,
    mentions: [],
    explanation: { retriever, reasons },
  };
}

function placeholderChunk(
  record: EnrichmentRecord,
  chunkKey: string,
  score: number,
  reasons: string[],
  retriever: MarkdownRelatedChunk['explanation']['retriever'],
): MarkdownRelatedChunk {
  return {
    chunkKey,
    docPath: record.filePath,
    fileHash: record.fileHash,
    headingPath: [],
    lineSpan: { start: 0, end: 0 },
    chunkIndex: 0,
    normalizedAnchor: '',
    contentHash: '',
    score: roundScore(score),
    reasons,
    mentions: [],
    explanation: { retriever, reasons },
  };
}

function rescoreChunk(
  chunk: MarkdownRelatedChunk,
  score: number,
  reasons: string[],
  retriever: MarkdownRelatedChunk['explanation']['retriever'],
): MarkdownRelatedChunk {
  return {
    ...chunk,
    score: roundScore(score),
    reasons,
    mentions: [],
    explanation: { retriever, reasons },
  };
}

function docsFromChunks(chunks: readonly MarkdownRelatedChunk[]): MarkdownRelatedDoc[] {
  const docs = new Map<string, MarkdownRelatedDoc>();
  for (const chunk of chunks) {
    const existing = docs.get(chunk.docPath);
    if (existing === undefined) {
      docs.set(chunk.docPath, {
        docPath: chunk.docPath,
        fileHash: chunk.fileHash,
        chunkCount: 1,
        score: chunk.score,
        headingPaths: [chunk.headingPath],
      });
      continue;
    }
    existing.chunkCount += 1;
    existing.score = roundScore(Math.max(existing.score, chunk.score));
    existing.headingPaths.push(chunk.headingPath);
  }
  return [...docs.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.docPath.localeCompare(right.docPath);
  });
}

function retrieversFromChunks(
  chunks: readonly MarkdownRelatedChunk[],
): MarkdownPassiveRetrievalResult<unknown>['explanation']['retrievers'] {
  const byName = new Map<
    MarkdownRelatedChunk['explanation']['retriever'],
    { reasons: Set<string>; chunkCount: number }
  >();
  for (const chunk of chunks) {
    const item = byName.get(chunk.explanation.retriever) ?? {
      reasons: new Set<string>(),
      chunkCount: 0,
    };
    item.chunkCount += 1;
    for (const reason of chunk.reasons) item.reasons.add(reason);
    byName.set(chunk.explanation.retriever, item);
  }
  return [...byName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, item]) => ({
      name,
      factCount: item.chunkCount,
      chunkCount: item.chunkCount,
      reasons: [...item.reasons].sort(),
    }));
}

function snapshotForRecord(
  record: EnrichmentRecord,
  snapshots: MarkdownPassiveRetrievalOptions['snapshotsByDocPath'],
): EnrichmentSnapshot | undefined {
  if (snapshots === undefined) return undefined;
  return snapshots instanceof Map ? snapshots.get(record.filePath) : snapshots[record.filePath];
}

function compareCandidate(left: CandidateChunk, right: CandidateChunk): number {
  if (right.chunk.score !== left.chunk.score) return right.chunk.score - left.chunk.score;
  return [left.chunk.docPath, left.chunk.chunkKey, left.factKey]
    .join('\0')
    .localeCompare([right.chunk.docPath, right.chunk.chunkKey, right.factKey].join('\0'));
}

function addSkip(
  skipped: MarkdownPassiveRetrievalResult<unknown>['skipped'],
  degradedReasons: Partial<Record<MarkdownPassiveRetrievalSkipReason, number>>,
  skip: MarkdownPassiveRetrievalResult<unknown>['skipped'][number],
): void {
  skipped.push(skip);
  degradedReasons[skip.reason] = (degradedReasons[skip.reason] ?? 0) + 1;
}

function factKey(record: EnrichmentRecord, fact: EnrichmentFact): string {
  return createHash('sha256')
    .update(
      stableJson({
        analyzerId: record.analyzerId,
        analyzerVersion: record.analyzerVersion,
        sourceIndexId: record.sourceIndexId,
        sourceCommitHash: record.sourceCommitHash,
        filePath: record.filePath,
        fileHash: record.fileHash,
        fact,
      }),
    )
    .digest('hex');
}

function buildChunkKey(fact: EnrichmentFact): string {
  return [
    stringValue(fact.docPath) ?? '',
    stringValue(fact.fileHash) ?? '',
    stringArray(fact.headingPath).join('/'),
    stringValue(fact.normalizedAnchor) ?? '',
    stringValue(fact.contentHash) ?? '',
  ].join('#');
}

function stringMatches(value: unknown, expected: string | undefined): boolean {
  return expected !== undefined && value === expected;
}

function headingMatches(value: unknown, expected: readonly string[] | undefined): boolean {
  if (expected === undefined || !Array.isArray(value)) return false;
  return stableJson(value) === stableJson(expected);
}

function lineSpan(value: unknown): { start: number; end: number } {
  if (!isRecord(value)) return { start: 0, end: 0 };
  return { start: numberValue(value.start) ?? 0, end: numberValue(value.end) ?? 0 };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function requireString(value: unknown, fieldName: string): string {
  const string = stringValue(value);
  if (string === undefined) {
    throw new Error(`markdown chunk fact is missing ${fieldName}`);
  }
  return string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
