import { createHash } from 'node:crypto';

import { decideEnrichmentFreshness } from './enrichment-record.js';
import type { EnrichmentFact, EnrichmentRecord, EnrichmentSnapshot } from './enrichment-record.js';

export type PassiveGraphIdentityType = 'file' | 'symbol' | 'process' | 'cluster';

export interface PassiveGraphIdentity {
  type: PassiveGraphIdentityType;
  id: string;
  filePath?: string;
}

export interface PassiveGraphFactCandidate {
  fact: EnrichmentFact;
  record: EnrichmentRecord;
  reason: string;
  score: number;
  factKey?: string;
}

export type PassiveGraphExpansionSkipReason =
  | 'stale-enrichment'
  | 'incomplete-index'
  | 'top-k-exceeded'
  | 'max-depth-exceeded'
  | 'identity-type-not-allowed'
  | 'invalid-score';

export interface PassiveGraphExpansionOptions {
  topK: number;
  maxDepth: number;
  allowedIdentityTypes: readonly PassiveGraphIdentityType[];
  snapshot: EnrichmentSnapshot;
  indexComplete?: boolean;
  incompleteIndexReason?: string;
}

export interface PassiveRelatedFact {
  factKey: string;
  kind: string;
  score: number;
  source: {
    analyzerId: string;
    analyzerVersion: string;
    filePath: string;
  };
  explanation: {
    retriever: 'passive-graph-expansion';
    sourceFactKind: string;
    expansionReason: string;
  };
}

export interface PassiveRelatedIdentity extends PassiveGraphIdentity {
  factKey: string;
  sourceFactKind: string;
  expansionReason: string;
  score: number;
  depth: number;
}

export interface PassiveGraphExpansionSkip {
  factKey?: string;
  reason: PassiveGraphExpansionSkipReason;
  detail?: string;
}

export interface PassiveGraphExpansionResult<TPrimary> {
  primaryResults: readonly TPrimary[];
  relatedFacts: PassiveRelatedFact[];
  relatedIdentities: PassiveRelatedIdentity[];
  relatedSymbols: PassiveRelatedIdentity[];
  relatedFiles: PassiveRelatedIdentity[];
  skipped: PassiveGraphExpansionSkip[];
  summary: {
    candidateCount: number;
    expandedFactCount: number;
    skippedFactCount: number;
    degraded: boolean;
    degradedReasons: Partial<Record<PassiveGraphExpansionSkipReason, number>>;
  };
  explanation: {
    retrievers: Array<{
      name: 'passive-graph-expansion';
      factCount: number;
      identityCount: number;
    }>;
  };
}

export function expandPassiveGraph<TPrimary>(
  primaryResults: readonly TPrimary[],
  candidates: readonly PassiveGraphFactCandidate[],
  options: PassiveGraphExpansionOptions,
): PassiveGraphExpansionResult<TPrimary> {
  const topK = normalizePositiveInteger(options.topK, 'topK');
  const maxDepth = normalizeNonNegativeInteger(options.maxDepth, 'maxDepth');
  const allowedIdentityTypes = new Set(options.allowedIdentityTypes);
  const relatedFacts: PassiveRelatedFact[] = [];
  const relatedIdentities: PassiveRelatedIdentity[] = [];
  const relatedSymbols: PassiveRelatedIdentity[] = [];
  const relatedFiles: PassiveRelatedIdentity[] = [];
  const skipped: PassiveGraphExpansionSkip[] = [];
  const degradedReasons: Partial<Record<PassiveGraphExpansionSkipReason, number>> = {};
  const seenIdentities = new Set<string>();
  const seenSymbols = new Set<string>();
  const seenFiles = new Set<string>();

  if (options.indexComplete === false) {
    for (const candidate of candidates) {
      addSkip(skipped, degradedReasons, {
        factKey: passiveFactKey(candidate),
        reason: 'incomplete-index',
        detail: options.incompleteIndexReason,
      });
    }
    return buildResult(
      primaryResults,
      candidates,
      relatedFacts,
      relatedIdentities,
      relatedSymbols,
      relatedFiles,
      skipped,
      degradedReasons,
    );
  }

  for (const candidate of candidates) {
    const factKey = passiveFactKey(candidate);

    if (relatedFacts.length >= topK) {
      addSkip(skipped, degradedReasons, { factKey, reason: 'top-k-exceeded' });
      continue;
    }

    if (!Number.isFinite(candidate.score)) {
      addSkip(skipped, degradedReasons, { factKey, reason: 'invalid-score' });
      continue;
    }

    const freshness = decideEnrichmentFreshness(candidate.record, options.snapshot);
    if (!freshness.usable) {
      addSkip(skipped, degradedReasons, {
        factKey,
        reason: 'stale-enrichment',
        detail: freshness.reason,
      });
      continue;
    }

    relatedFacts.push({
      factKey,
      kind: candidate.fact.kind,
      score: candidate.score,
      source: {
        analyzerId: candidate.record.analyzerId,
        analyzerVersion: candidate.record.analyzerVersion,
        filePath: candidate.record.filePath,
      },
      explanation: {
        retriever: 'passive-graph-expansion',
        sourceFactKind: candidate.fact.kind,
        expansionReason: candidate.reason,
      },
    });

    if (maxDepth < 1) {
      addSkip(skipped, degradedReasons, { factKey, reason: 'max-depth-exceeded' });
      continue;
    }

    for (const identity of identitiesFromFact(candidate.fact)) {
      if (!allowedIdentityTypes.has(identity.type)) {
        addSkip(skipped, degradedReasons, {
          factKey,
          reason: 'identity-type-not-allowed',
          detail: identity.type,
        });
        continue;
      }

      const related = {
        ...identity,
        factKey,
        sourceFactKind: candidate.fact.kind,
        expansionReason: candidate.reason,
        score: candidate.score,
        depth: 1,
      };
      const key = identityKey(identity);

      if (relatedIdentities.length >= topK && !seenIdentities.has(key)) {
        addSkip(skipped, degradedReasons, {
          factKey,
          reason: 'top-k-exceeded',
          detail: identity.type,
        });
        continue;
      }

      addUnique(relatedIdentities, seenIdentities, key, related);
      if (identity.type === 'symbol') {
        addUnique(relatedSymbols, seenSymbols, key, related);
      } else if (identity.type === 'file') {
        addUnique(relatedFiles, seenFiles, key, related);
      }
    }
  }

  return buildResult(
    primaryResults,
    candidates,
    relatedFacts,
    relatedIdentities,
    relatedSymbols,
    relatedFiles,
    skipped,
    degradedReasons,
  );
}

function identitiesFromFact(fact: EnrichmentFact): PassiveGraphIdentity[] {
  const identities: PassiveGraphIdentity[] = [];
  const seen = new Set<string>();
  addSubjectIdentity(identities, fact.subject);
  addSubjectIdentity(identities, fact.from);
  addSubjectIdentity(identities, fact.to);
  addSubjectIdentity(identities, fact.suggestedAnchor);

  if (Array.isArray(fact.referencedFiles)) {
    for (const item of fact.referencedFiles) {
      if (isRecord(item) && nonEmptyString(item.filePath)) {
        identities.push({ type: 'file', id: item.filePath, filePath: item.filePath });
      }
    }
  }

  return identities.filter((identity) => {
    const key = identityKey(identity);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addSubjectIdentity(identities: PassiveGraphIdentity[], input: unknown): void {
  if (!isRecord(input) || input.type === 'unresolved') return;
  if (
    (input.type === 'file' ||
      input.type === 'symbol' ||
      input.type === 'process' ||
      input.type === 'cluster') &&
    nonEmptyString(input.id)
  ) {
    const identity: PassiveGraphIdentity = { type: input.type, id: input.id };
    if (nonEmptyString(input.filePath)) {
      identity.filePath = input.filePath;
    }
    identities.push(identity);
  }
}

function passiveFactKey(candidate: PassiveGraphFactCandidate): string {
  if (nonEmptyString(candidate.factKey)) {
    return candidate.factKey;
  }
  return createHash('sha256')
    .update(
      stableJson({
        analyzerId: candidate.record.analyzerId,
        analyzerVersion: candidate.record.analyzerVersion,
        sourceIndexId: candidate.record.sourceIndexId,
        sourceCommitHash: candidate.record.sourceCommitHash,
        filePath: candidate.record.filePath,
        fileHash: candidate.record.fileHash,
        kind: candidate.fact.kind,
        fact: candidate.fact,
      }),
    )
    .digest('hex');
}

function addSkip(
  skipped: PassiveGraphExpansionSkip[],
  degradedReasons: Partial<Record<PassiveGraphExpansionSkipReason, number>>,
  skip: PassiveGraphExpansionSkip,
): void {
  skipped.push(skip);
  degradedReasons[skip.reason] = (degradedReasons[skip.reason] ?? 0) + 1;
}

function addUnique<T>(target: T[], seen: Set<string>, key: string, value: T): void {
  if (seen.has(key)) return;
  seen.add(key);
  target.push(value);
}

function identityKey(identity: PassiveGraphIdentity): string {
  return `${identity.type}:${identity.id}:${identity.filePath ?? ''}`;
}

function buildResult<TPrimary>(
  primaryResults: readonly TPrimary[],
  candidates: readonly PassiveGraphFactCandidate[],
  relatedFacts: PassiveRelatedFact[],
  relatedIdentities: PassiveRelatedIdentity[],
  relatedSymbols: PassiveRelatedIdentity[],
  relatedFiles: PassiveRelatedIdentity[],
  skipped: PassiveGraphExpansionSkip[],
  degradedReasons: Partial<Record<PassiveGraphExpansionSkipReason, number>>,
): PassiveGraphExpansionResult<TPrimary> {
  return {
    primaryResults,
    relatedFacts,
    relatedIdentities,
    relatedSymbols,
    relatedFiles,
    skipped,
    summary: {
      candidateCount: candidates.length,
      expandedFactCount: relatedFacts.length,
      skippedFactCount: skipped.length,
      degraded: skipped.length > 0,
      degradedReasons,
    },
    explanation: {
      retrievers: [
        {
          name: 'passive-graph-expansion',
          factCount: relatedFacts.length,
          identityCount: relatedIdentities.length,
        },
      ],
    },
  };
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

function normalizeNonNegativeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
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

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function nonEmptyString(input: unknown): input is string {
  return typeof input === 'string' && input.trim().length > 0;
}
