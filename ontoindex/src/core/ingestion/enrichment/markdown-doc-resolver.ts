import { DOCS_REPORT_LIMITS, type SourceIndexIdentity } from './docs-contracts.js';
import type { EnrichmentFact } from './enrichment-record.js';
import type {
  MarkdownApiSpecFact,
  MarkdownCodeMentionFact,
  MarkdownDocumentFact,
  MarkdownLineSpan,
  MarkdownRequirementFact,
  MarkdownTestMentionFact,
} from './markdown-document-facts.js';
import type {
  GraphIdentityCandidate,
  GraphIdentityProvider,
} from './markdown-graph-identity-provider.js';

export const CURRENT_MARKDOWN_DOC_RESOLUTION_SCHEMA_VERSION = 1;
export const MARKDOWN_DOC_RESOLVER_ID = 'ontoindex.markdown-doc-resolver';
export const MARKDOWN_DOC_RESOLVER_VERSION = '1.0.0';

export type MarkdownDocResolutionStatus = 'resolved' | 'ambiguous' | 'unresolved' | 'stale';
export type MarkdownDocResolutionSubjectKind =
  | 'code-mention'
  | 'test-mention'
  | 'requirement'
  | 'route';
export type MarkdownDocResolutionEvidenceKind = 'graph-structural' | 'lexical-requirement-id';

export interface MarkdownRequirementLexicalEvidence {
  requirementId: string;
  graphIdentity: GraphIdentityCandidate;
  filePath?: string;
  lineSpan?: MarkdownLineSpan;
  excerpt?: string;
  confidence?: number;
}

export interface MarkdownDocResolutionRecord extends EnrichmentFact {
  kind: 'markdown-doc-resolution';
  schemaVersion: typeof CURRENT_MARKDOWN_DOC_RESOLUTION_SCHEMA_VERSION;
  resolverId: typeof MARKDOWN_DOC_RESOLVER_ID;
  resolverVersion: string;
  sourceIndexId: string;
  sourceCommitHash?: string;
  graphSchemaVersion: number;
  graphDigest?: string;
  docPath: string;
  factKey: string;
  factKind: MarkdownDocumentFact['kind'];
  subjectKind: MarkdownDocResolutionSubjectKind;
  resolutionKey: string;
  status: MarkdownDocResolutionStatus;
  confidence: number;
  evidenceKind: MarkdownDocResolutionEvidenceKind;
  reasons: string[];
  targetGraphIdentity?: GraphIdentityCandidate;
  candidates: GraphIdentityCandidate[];
  lineSpan?: MarkdownLineSpan;
}

export interface ResolveMarkdownDocumentFactsInput {
  facts: readonly MarkdownDocumentFact[];
  sourceIndex: SourceIndexIdentity;
  provider: GraphIdentityProvider;
  lexicalRequirementEvidence?: readonly MarkdownRequirementLexicalEvidence[];
  resolverVersion?: string;
  maxCandidatesPerFact?: number;
}

export async function resolveMarkdownDocumentFacts(
  input: ResolveMarkdownDocumentFactsInput,
): Promise<MarkdownDocResolutionRecord[]> {
  const maxCandidates = input.maxCandidatesPerFact ?? DOCS_REPORT_LIMITS.maxCandidatesPerFact;
  const lexicalEvidence = groupLexicalRequirementEvidence(input.lexicalRequirementEvidence ?? []);
  const records: MarkdownDocResolutionRecord[] = [];

  for (const fact of input.facts) {
    if (fact.kind === 'markdown-code-mention') {
      records.push(
        await resolveCodeMention(fact, input.sourceIndex, input.provider, maxCandidates, input),
      );
    } else if (fact.kind === 'markdown-test-mention') {
      records.push(
        await resolveTestMention(fact, input.sourceIndex, input.provider, maxCandidates, input),
      );
    } else if (fact.kind === 'markdown-api-spec') {
      records.push(
        await resolveRoute(fact, input.sourceIndex, input.provider, maxCandidates, input),
      );
    } else if (fact.kind === 'markdown-requirement') {
      records.push(
        resolveRequirement(fact, input.sourceIndex, lexicalEvidence, maxCandidates, input),
      );
    }
  }

  return records;
}

async function resolveCodeMention(
  fact: MarkdownCodeMentionFact,
  sourceIndex: SourceIndexIdentity,
  provider: GraphIdentityProvider,
  maxCandidates: number,
  input: ResolveMarkdownDocumentFactsInput,
): Promise<MarkdownDocResolutionRecord> {
  const candidates = await provider.findSymbols({
    mention: fact.evidence.text,
    filePathHint: fact.target.filePath,
    maxCandidates,
  });
  return recordFromCandidates({
    fact,
    factKey: codeMentionFactKey(fact),
    subjectKind: 'code-mention',
    evidenceKind: 'graph-structural',
    sourceIndex,
    candidates,
    maxCandidates,
    input,
    unresolvedReason: 'symbol-not-found',
  });
}

async function resolveTestMention(
  fact: MarkdownTestMentionFact,
  sourceIndex: SourceIndexIdentity,
  provider: GraphIdentityProvider,
  maxCandidates: number,
  input: ResolveMarkdownDocumentFactsInput,
): Promise<MarkdownDocResolutionRecord> {
  if (!fact.resolvable) {
    return createResolutionRecord({
      fact,
      factKey: typedFactKey(fact),
      subjectKind: 'test-mention',
      evidenceKind: 'graph-structural',
      sourceIndex,
      status: 'unresolved',
      confidence: 0,
      reasons: [fact.unsafeReason ?? 'test-mention-not-resolvable'],
      candidates: [],
      input,
    });
  }

  const candidates = await provider.findTestFiles({
    mention: fact.mention,
    pathHint: fact.targetPath,
    maxCandidates,
  });
  return recordFromCandidates({
    fact,
    factKey: typedFactKey(fact),
    subjectKind: 'test-mention',
    evidenceKind: 'graph-structural',
    sourceIndex,
    candidates,
    maxCandidates,
    input,
    unresolvedReason: 'test-file-not-found',
  });
}

async function resolveRoute(
  fact: MarkdownApiSpecFact,
  sourceIndex: SourceIndexIdentity,
  provider: GraphIdentityProvider,
  maxCandidates: number,
  input: ResolveMarkdownDocumentFactsInput,
): Promise<MarkdownDocResolutionRecord> {
  const candidates = await provider.findRoutes({
    method: fact.method,
    path: fact.path,
    maxCandidates,
  });
  return recordFromCandidates({
    fact,
    factKey: typedFactKey(fact),
    subjectKind: 'route',
    evidenceKind: 'graph-structural',
    sourceIndex,
    candidates,
    maxCandidates,
    input,
    unresolvedReason: 'route-not-found',
  });
}

function resolveRequirement(
  fact: MarkdownRequirementFact,
  sourceIndex: SourceIndexIdentity,
  lexicalEvidence: ReadonlyMap<string, MarkdownRequirementLexicalEvidence[]>,
  maxCandidates: number,
  input: ResolveMarkdownDocumentFactsInput,
): MarkdownDocResolutionRecord {
  const candidates = (lexicalEvidence.get(fact.requirementId) ?? [])
    .map((evidence) => ({
      ...evidence.graphIdentity,
      confidence: normalizeConfidence(evidence.confidence ?? evidence.graphIdentity.confidence),
    }))
    .slice(0, maxCandidates);

  return recordFromCandidates({
    fact,
    factKey: typedFactKey(fact),
    subjectKind: 'requirement',
    evidenceKind: 'lexical-requirement-id',
    sourceIndex,
    candidates,
    maxCandidates,
    input,
    unresolvedReason: 'requirement-id-not-found-in-code',
  });
}

function recordFromCandidates(input: {
  fact: MarkdownDocumentFact;
  factKey: string;
  subjectKind: MarkdownDocResolutionSubjectKind;
  evidenceKind: MarkdownDocResolutionEvidenceKind;
  sourceIndex: SourceIndexIdentity;
  candidates: readonly GraphIdentityCandidate[];
  maxCandidates: number;
  input: ResolveMarkdownDocumentFactsInput;
  unresolvedReason: string;
}): MarkdownDocResolutionRecord {
  const candidates = capAndSortCandidates(input.candidates, input.maxCandidates);
  const staleCandidates = candidates.filter((candidate) =>
    isStaleCandidate(candidate, input.sourceIndex),
  );
  if (staleCandidates.length > 0) {
    return createResolutionRecord({
      ...input,
      status: 'stale',
      confidence: maxConfidence(staleCandidates),
      reasons: ['stale-graph-identity'],
      candidates,
      targetGraphIdentity: staleCandidates[0],
    });
  }

  if (candidates.length === 0) {
    return createResolutionRecord({
      ...input,
      status: 'unresolved',
      confidence: 0,
      reasons: [input.unresolvedReason],
      candidates: [],
    });
  }

  if (candidates.length === 1) {
    return createResolutionRecord({
      ...input,
      status: 'resolved',
      confidence: candidates[0].confidence,
      reasons: ['single-candidate'],
      candidates,
      targetGraphIdentity: candidates[0],
    });
  }

  return createResolutionRecord({
    ...input,
    status: 'ambiguous',
    confidence: maxConfidence(candidates),
    reasons: ['multiple-candidates'],
    candidates,
  });
}

function createResolutionRecord(input: {
  fact: MarkdownDocumentFact;
  factKey: string;
  subjectKind: MarkdownDocResolutionSubjectKind;
  evidenceKind: MarkdownDocResolutionEvidenceKind;
  sourceIndex: SourceIndexIdentity;
  status: MarkdownDocResolutionStatus;
  confidence: number;
  reasons: readonly string[];
  candidates: readonly GraphIdentityCandidate[];
  input: ResolveMarkdownDocumentFactsInput;
  targetGraphIdentity?: GraphIdentityCandidate;
}): MarkdownDocResolutionRecord {
  const candidates = [...input.candidates];
  const targetGraphIdentity = input.targetGraphIdentity;
  const resolverVersion = input.input.resolverVersion ?? MARKDOWN_DOC_RESOLVER_VERSION;
  return {
    kind: 'markdown-doc-resolution',
    schemaVersion: CURRENT_MARKDOWN_DOC_RESOLUTION_SCHEMA_VERSION,
    resolverId: MARKDOWN_DOC_RESOLVER_ID,
    resolverVersion,
    sourceIndexId: input.sourceIndex.sourceIndexId,
    sourceCommitHash: input.sourceIndex.sourceCommitHash,
    graphSchemaVersion: input.sourceIndex.graphSchemaVersion,
    graphDigest: input.sourceIndex.graphDigest,
    docPath: factDocPath(input.fact),
    factKey: input.factKey,
    factKind: input.fact.kind,
    subjectKind: input.subjectKind,
    resolutionKey: createResolutionKey({
      sourceIndex: input.sourceIndex,
      resolverVersion,
      factKey: input.factKey,
      status: input.status,
      targetGraphIdentity,
      candidates,
    }),
    status: input.status,
    confidence: normalizeConfidence(input.confidence),
    evidenceKind: input.evidenceKind,
    reasons: [...input.reasons],
    targetGraphIdentity,
    candidates,
    lineSpan: factLineSpan(input.fact),
  };
}

function createResolutionKey(input: {
  sourceIndex: SourceIndexIdentity;
  resolverVersion: string;
  factKey: string;
  status: MarkdownDocResolutionStatus;
  targetGraphIdentity?: GraphIdentityCandidate;
  candidates: readonly GraphIdentityCandidate[];
}): string {
  const targetKey =
    input.targetGraphIdentity !== undefined
      ? graphIdentityKey(input.targetGraphIdentity)
      : input.candidates.map(graphIdentityKey).join(',');
  return [
    input.sourceIndex.sourceIndexId,
    input.sourceIndex.graphSchemaVersion,
    MARKDOWN_DOC_RESOLVER_ID,
    input.resolverVersion,
    input.factKey,
    targetKey || input.status,
  ]
    .map(encodeURIComponent)
    .join(':');
}

function groupLexicalRequirementEvidence(
  evidence: readonly MarkdownRequirementLexicalEvidence[],
): Map<string, MarkdownRequirementLexicalEvidence[]> {
  const byRequirementId = new Map<string, MarkdownRequirementLexicalEvidence[]>();
  for (const item of evidence) {
    const list = byRequirementId.get(item.requirementId) ?? [];
    list.push(item);
    byRequirementId.set(item.requirementId, list);
  }
  for (const list of byRequirementId.values()) {
    list.sort((a, b) => compareCandidates(a.graphIdentity, b.graphIdentity));
  }
  return byRequirementId;
}

function capAndSortCandidates(
  candidates: readonly GraphIdentityCandidate[],
  maxCandidates: number,
): GraphIdentityCandidate[] {
  return [...candidates]
    .map((candidate) => ({ ...candidate, confidence: normalizeConfidence(candidate.confidence) }))
    .sort(compareCandidates)
    .slice(0, maxCandidates);
}

function compareCandidates(a: GraphIdentityCandidate, b: GraphIdentityCandidate): number {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  const aPath = a.filePath ?? '';
  const bPath = b.filePath ?? '';
  if (aPath !== bPath) return aPath.localeCompare(bPath);
  return graphIdentityKey(a).localeCompare(graphIdentityKey(b));
}

function isStaleCandidate(
  candidate: GraphIdentityCandidate,
  sourceIndex: SourceIndexIdentity,
): boolean {
  return (
    (candidate.sourceIndexId !== undefined &&
      candidate.sourceIndexId !== sourceIndex.sourceIndexId) ||
    (candidate.graphSchemaVersion !== undefined &&
      candidate.graphSchemaVersion !== sourceIndex.graphSchemaVersion)
  );
}

function maxConfidence(candidates: readonly GraphIdentityCandidate[]): number {
  return candidates.reduce((max, candidate) => Math.max(max, candidate.confidence), 0);
}

function graphIdentityKey(identity: GraphIdentityCandidate): string {
  return [identity.type, identity.id].join(':');
}

function typedFactKey(
  fact: MarkdownApiSpecFact | MarkdownRequirementFact | MarkdownTestMentionFact,
): string {
  return fact.normalizedKey;
}

function codeMentionFactKey(fact: MarkdownCodeMentionFact): string {
  return [
    'markdown-code-mention',
    fact.chunkKey,
    fact.evidence.lineSpan.start,
    fact.evidence.lineSpan.end,
    fact.evidence.text,
  ].join(':');
}

function factDocPath(fact: MarkdownDocumentFact): string {
  if ('docPath' in fact && typeof fact.docPath === 'string') return fact.docPath;
  return '';
}

function factLineSpan(fact: MarkdownDocumentFact): MarkdownLineSpan | undefined {
  if ('lineSpan' in fact && isLineSpan(fact.lineSpan)) return fact.lineSpan;
  if ('evidence' in fact && typeof fact.evidence === 'object' && fact.evidence !== null) {
    const lineSpan = (fact.evidence as { lineSpan?: MarkdownLineSpan }).lineSpan;
    if (isLineSpan(lineSpan)) return lineSpan;
  }
  return undefined;
}

function isLineSpan(value: unknown): value is MarkdownLineSpan {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MarkdownLineSpan).start === 'number' &&
    typeof (value as MarkdownLineSpan).end === 'number'
  );
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('resolution confidence must be a finite number from 0 to 1');
  }
  return value;
}
