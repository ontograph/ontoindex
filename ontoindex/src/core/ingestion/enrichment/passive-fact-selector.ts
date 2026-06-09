import {
  decideEnrichmentReadPolicy,
  type EnrichmentReadPolicyOptions,
  type EnrichmentReadPolicyReason,
} from './enrichment-read-policy.js';
import type { EnrichmentFact, EnrichmentRecord, EnrichmentSnapshot } from './enrichment-record.js';

export type PassiveFactQueryTargetType = 'file' | 'symbol' | 'process' | 'cluster' | 'edge';

export interface PassiveFactQueryTarget {
  type: PassiveFactQueryTargetType;
  id?: string;
  filePath?: string;
  fileHash?: string;
}

export type PassiveFactCandidateReason =
  | 'exact-subject-match'
  | 'referenced-file-match'
  | 'semantic-bridge-fallback';

export type PassiveFactRejectedRecordReason = EnrichmentReadPolicyReason | 'empty-facts';

export interface PassiveFactCandidate {
  fact: EnrichmentFact;
  record: EnrichmentRecord;
  reason: PassiveFactCandidateReason;
  score: number;
}

export interface PassiveFactRejectedRecord {
  record: EnrichmentRecord;
  reason: PassiveFactRejectedRecordReason;
  factCount: number;
}

export interface PassiveFactSelectorResult {
  candidates: PassiveFactCandidate[];
  rejectedRecords: PassiveFactRejectedRecord[];
  summary: {
    candidateCount: number;
    rejectedRecordCount: number;
    rejectionReasons: Partial<Record<PassiveFactRejectedRecordReason, number>>;
  };
}

const REASON_SCORES: Record<PassiveFactCandidateReason, number> = {
  'exact-subject-match': 0.9,
  'referenced-file-match': 0.7,
  'semantic-bridge-fallback': 0.5,
};

export function selectPassiveFactCandidates(
  records: readonly EnrichmentRecord[],
  snapshot: EnrichmentSnapshot,
  target: PassiveFactQueryTarget,
  options: Partial<EnrichmentReadPolicyOptions> = {},
): PassiveFactSelectorResult {
  const candidates: PassiveFactCandidate[] = [];
  const rejectedRecords: PassiveFactRejectedRecord[] = [];
  const rejectionReasons: Partial<Record<PassiveFactRejectedRecordReason, number>> = {};

  for (const record of records) {
    const decision = decideEnrichmentReadPolicy(record, snapshot, options);
    if (!decision.used) {
      rejectRecord(record, decision.reason, rejectedRecords, rejectionReasons);
      continue;
    }

    if (record.records.length === 0) {
      rejectRecord(record, 'empty-facts', rejectedRecords, rejectionReasons);
      continue;
    }

    for (const fact of record.records) {
      const reason = selectCandidateReason(fact, target);
      if (reason === undefined) {
        continue;
      }

      candidates.push({
        fact,
        record,
        reason,
        score: scoreCandidate(reason, fact, record),
      });
    }
  }

  candidates.sort(compareCandidates);

  return {
    candidates,
    rejectedRecords,
    summary: {
      candidateCount: candidates.length,
      rejectedRecordCount: rejectedRecords.length,
      rejectionReasons,
    },
  };
}

function rejectRecord(
  record: EnrichmentRecord,
  reason: PassiveFactRejectedRecordReason,
  rejectedRecords: PassiveFactRejectedRecord[],
  rejectionReasons: Partial<Record<PassiveFactRejectedRecordReason, number>>,
): void {
  rejectedRecords.push({ record, reason, factCount: record.records.length });
  rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
}

function selectCandidateReason(
  fact: EnrichmentFact,
  target: PassiveFactQueryTarget,
): PassiveFactCandidateReason | undefined {
  if (matchesSubject(fact.subject, target)) {
    return 'exact-subject-match';
  }
  if (matchesReferencedFile(fact.referencedFiles, target)) {
    return 'referenced-file-match';
  }
  if (fact.kind === 'semantic-bridge' && matchesSemanticBridgeEndpoint(fact, target)) {
    return 'semantic-bridge-fallback';
  }
  return undefined;
}

function matchesSemanticBridgeEndpoint(
  fact: EnrichmentFact,
  target: PassiveFactQueryTarget,
): boolean {
  return matchesSubject(fact.from, target) || matchesSubject(fact.to, target);
}

function matchesSubject(subject: unknown, target: PassiveFactQueryTarget): boolean {
  if (!isRecord(subject)) {
    return false;
  }

  if (target.type === 'file') {
    return (
      subject.type === 'file' &&
      typeof subject.filePath === 'string' &&
      subject.filePath === target.filePath
    );
  }

  return subject.type === target.type && typeof subject.id === 'string' && subject.id === target.id;
}

function matchesReferencedFile(referencedFiles: unknown, target: PassiveFactQueryTarget): boolean {
  if (target.type !== 'file' || target.filePath === undefined || !Array.isArray(referencedFiles)) {
    return false;
  }

  return referencedFiles.some((file) => {
    if (!isRecord(file) || file.filePath !== target.filePath) {
      return false;
    }
    return target.fileHash === undefined || file.fileHash === target.fileHash;
  });
}

function scoreCandidate(
  reason: PassiveFactCandidateReason,
  fact: EnrichmentFact,
  record: EnrichmentRecord,
): number {
  const factConfidence = typeof fact.confidence === 'number' ? fact.confidence : record.confidence;
  const confidence = factConfidence ?? 0;
  return roundScore(REASON_SCORES[reason] + confidence / 10);
}

function compareCandidates(left: PassiveFactCandidate, right: PassiveFactCandidate): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return stableCandidateKey(left).localeCompare(stableCandidateKey(right));
}

function stableCandidateKey(candidate: PassiveFactCandidate): string {
  return [
    candidate.record.analyzerId,
    candidate.record.analyzerVersion,
    candidate.record.sourceIndexId,
    candidate.record.sourceCommitHash,
    candidate.record.filePath,
    candidate.record.fileHash,
    candidate.fact.kind,
    stableJson(candidate.fact),
  ].join('\0');
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

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
