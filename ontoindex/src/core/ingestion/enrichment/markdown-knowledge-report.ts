import {
  DOCS_REPORT_LIMITS,
  DOCS_REPORT_VERSION,
  type DocsReportEnvelope,
  type DocsSidecarStatus,
} from './docs-contracts.js';
import {
  deriveMarkdownConceptClusters,
  type MarkdownConceptClusterEdgeReason,
  type MarkdownConceptConfidence,
  type MarkdownConceptEvidenceClass,
  type MarkdownConceptFreshness,
  type MarkdownConceptGraphIdentity,
  type MarkdownConceptSidecarFreshness,
  type MarkdownKnowledgeAuthority,
  type MarkdownKnowledgeConceptCluster,
} from './markdown-concept-clusters.js';
import type { MarkdownDocumentFact } from './markdown-document-facts.js';
import type { MarkdownDocResolutionRecord } from './markdown-doc-resolver.js';

export type MarkdownKnowledgeDiagnosticSidecarStatus = 'complete' | 'partial' | 'stale' | 'missing';

export interface MarkdownKnowledgeRationaleSnippet {
  sourceFactKey: string;
  factKind: MarkdownDocumentFact['kind'];
  docPath?: string;
  headingPath: string[];
  lineSpan?: { start: number; end: number };
  excerpt: string;
  evidenceClass: 'docs_evidence';
  authority: MarkdownKnowledgeAuthority;
}

export interface MarkdownKnowledgeSchemaEvidence {
  sourceFactKey: string;
  routeKey: string;
  method: string;
  path: string;
  docPath: string;
  lineSpan: { start: number; end: number };
  excerpt: string;
  evidenceClass: 'docs_evidence';
  authority: MarkdownKnowledgeAuthority;
}

export interface MarkdownKnowledgeReportItemMetrics {
  documentCount: number;
  sourceFactCount: number;
  resolutionCount: number;
  linkedGraphIdentityCount: number;
  emittedGraphIdentityCount: number;
  clusterEdgeReasonCount: number;
  degree: number;
  sourceAreaCount: number;
}

export interface MarkdownKnowledgeReportItemFlags {
  stale: boolean;
  disconnected: boolean;
  overloaded: boolean;
  orphanAdrLike: boolean;
  hub: boolean;
}

export interface MarkdownKnowledgeReportBounds {
  linkedGraphIdentitiesTruncated: boolean;
}

export interface MarkdownKnowledgeReportItem {
  conceptId: string;
  label: string;
  aliases: string[];
  sourceDocuments: string[];
  sourceFactKeys: string[];
  resolutionKeys: string[];
  linkedGraphIdentities: MarkdownConceptGraphIdentity[];
  evidenceClass: MarkdownConceptEvidenceClass;
  authority: MarkdownKnowledgeAuthority;
  freshness: MarkdownConceptFreshness;
  confidence: MarkdownConceptConfidence;
  diagnosticSidecarStatus: MarkdownKnowledgeDiagnosticSidecarStatus;
  rationaleSnippets: MarkdownKnowledgeRationaleSnippet[];
  schemaEvidence: MarkdownKnowledgeSchemaEvidence[];
  clusterEdgeReasons: MarkdownConceptClusterEdgeReason[];
  suggestedNextChecks: string[];
  metrics: MarkdownKnowledgeReportItemMetrics;
  flags: MarkdownKnowledgeReportItemFlags;
  bounds: MarkdownKnowledgeReportBounds;
}

export interface CreateMarkdownKnowledgeReportInput {
  baseReport: DocsReportEnvelope;
  facts: readonly MarkdownDocumentFact[];
  resolutions: readonly MarkdownDocResolutionRecord[];
  warnings?: readonly string[];
  maxItems?: number;
  maxCandidatesPerFact?: number;
}

interface SidecarReportState {
  freshness: MarkdownConceptSidecarFreshness;
  reasons: string[];
}

const OVERLOADED_SOURCE_DOCUMENT_THRESHOLD = 4;
const OVERLOADED_SOURCE_FACT_THRESHOLD = 10;
const OVERLOADED_SOURCE_AREA_THRESHOLD = 4;
const HUB_DEGREE_THRESHOLD = 6;

export function createMarkdownKnowledgeReport(
  input: CreateMarkdownKnowledgeReportInput,
): DocsReportEnvelope<MarkdownKnowledgeReportItem> {
  const maxItems =
    input.maxItems ?? input.baseReport.limits.maxItems ?? DOCS_REPORT_LIMITS.maxItems;
  const maxCandidatesPerFact =
    input.maxCandidatesPerFact ??
    input.baseReport.limits.maxCandidatesPerFact ??
    DOCS_REPORT_LIMITS.maxCandidatesPerFact;
  const sidecar = createSidecarReportState(input.baseReport);
  const sourceFactIndex = createSourceFactIndex(input.facts);
  const derived = deriveMarkdownConceptClusters({
    facts: input.facts,
    resolutions: input.resolutions,
    sidecar,
    maxConcepts: maxItems,
  });
  const items = derived.concepts.map((concept) =>
    createReportItem(concept, input.baseReport, maxCandidatesPerFact, sourceFactIndex),
  );
  const conceptTruncated = derived.totalConcepts > items.length;
  const graphIdentityTruncated = items.some((item) => item.bounds.linkedGraphIdentitiesTruncated);
  const truncated = conceptTruncated || graphIdentityTruncated;
  const warnings = createWarnings({
    baseReport: input.baseReport,
    inputWarnings: input.warnings ?? [],
    derivedWarnings: derived.warnings,
    conceptTruncated,
    graphIdentityTruncated,
    maxItems,
    maxCandidatesPerFact,
  });

  return {
    version: DOCS_REPORT_VERSION,
    repo: input.baseReport.repo,
    sidecar: input.baseReport.sidecar,
    summary: {
      ...input.baseReport.summary,
      report: 'knowledge',
      knowledge: createSummary(derived.totalConcepts, items, input.baseReport, input.facts.length),
    },
    items,
    warnings,
    limits: {
      ...input.baseReport.limits,
      truncated,
      maxItems,
      maxCandidatesPerFact,
    },
    manifest: input.baseReport.manifest,
  };
}

function createReportItem(
  concept: MarkdownKnowledgeConceptCluster,
  baseReport: DocsReportEnvelope,
  maxCandidatesPerFact: number,
  sourceFactIndex: SourceFactIndex,
): MarkdownKnowledgeReportItem {
  const sourceAreas = sourceAreaKeys(concept);
  const linkedGraphIdentityCount = concept.linkedGraphIdentities.length;
  const emittedGraphIdentities = concept.linkedGraphIdentities.slice(0, maxCandidatesPerFact);
  const degree = concept.sourceDocuments.length + linkedGraphIdentityCount;
  const flags = createFlags(concept, degree, sourceAreas.length);
  const diagnosticSidecarStatus = normalizeMarkdownKnowledgeDiagnosticSidecarStatus(
    baseReport.sidecar.status,
  );

  return {
    conceptId: concept.id,
    label: concept.label,
    aliases: concept.aliases,
    sourceDocuments: concept.sourceDocuments,
    sourceFactKeys: concept.sourceFactKeys,
    resolutionKeys: concept.resolutionKeys,
    linkedGraphIdentities: emittedGraphIdentities,
    evidenceClass: concept.evidenceClass,
    authority: concept.authority,
    freshness: concept.freshness,
    confidence: concept.confidence,
    diagnosticSidecarStatus,
    rationaleSnippets: createRationaleSnippets(concept, sourceFactIndex, maxCandidatesPerFact),
    schemaEvidence: createSchemaEvidence(concept, sourceFactIndex, maxCandidatesPerFact),
    clusterEdgeReasons: concept.clusterEdgeReasons,
    suggestedNextChecks: createSuggestedNextChecks(concept, flags, baseReport),
    metrics: {
      documentCount: concept.sourceDocuments.length,
      sourceFactCount: concept.sourceFactKeys.length,
      resolutionCount: concept.resolutionKeys.length,
      linkedGraphIdentityCount,
      emittedGraphIdentityCount: emittedGraphIdentities.length,
      clusterEdgeReasonCount: concept.clusterEdgeReasons.length,
      degree,
      sourceAreaCount: sourceAreas.length,
    },
    flags,
    bounds: {
      linkedGraphIdentitiesTruncated: linkedGraphIdentityCount > emittedGraphIdentities.length,
    },
  };
}

function createFlags(
  concept: MarkdownKnowledgeConceptCluster,
  degree: number,
  sourceAreaCount: number,
): MarkdownKnowledgeReportItemFlags {
  const disconnected = concept.linkedGraphIdentities.length === 0;
  const overloaded =
    concept.sourceDocuments.length >= OVERLOADED_SOURCE_DOCUMENT_THRESHOLD ||
    concept.sourceFactKeys.length >= OVERLOADED_SOURCE_FACT_THRESHOLD ||
    sourceAreaCount >= OVERLOADED_SOURCE_AREA_THRESHOLD;
  return {
    stale: concept.freshness === 'stale',
    disconnected,
    overloaded,
    orphanAdrLike: disconnected && isAdrLikeConcept(concept),
    hub: degree >= HUB_DEGREE_THRESHOLD,
  };
}

function createSuggestedNextChecks(
  concept: MarkdownKnowledgeConceptCluster,
  flags: MarkdownKnowledgeReportItemFlags,
  baseReport: DocsReportEnvelope,
): string[] {
  const checks: string[] = [];
  checks.push(...sidecarSuggestedChecks(baseReport));
  if (flags.stale) checks.push('refresh markdown sidecar and resolution records');
  if (flags.disconnected) {
    checks.push('verify or add code, route, test, or file anchors for this concept');
  }
  if (flags.orphanAdrLike) {
    checks.push(
      'link the ADR-like concept to implementation symbols, routes, tests, or requirements',
    );
  }
  if (flags.overloaded) checks.push('split or disambiguate the concept label across documents');
  if (flags.hub) checks.push('review hub concept scope before using it as a narrow edit target');
  if (concept.confidence === 'low') {
    checks.push('verify aliases and cluster edge reasons before acting on this advisory concept');
  }
  if (checks.length === 0) {
    checks.push('review linked graph identities and source documents before acting');
  }
  return sortedUnique(checks);
}

function createSummary(
  totalConcepts: number,
  emittedItems: readonly MarkdownKnowledgeReportItem[],
  baseReport: DocsReportEnvelope,
  factCount: number,
): Record<string, unknown> {
  return {
    totalConcepts,
    emittedConcepts: emittedItems.length,
    sourceFacts: factCount,
    staleConcepts: emittedItems.filter((item) => item.flags.stale).length,
    disconnectedConcepts: emittedItems.filter((item) => item.flags.disconnected).length,
    overloadedConcepts: emittedItems.filter((item) => item.flags.overloaded).length,
    orphanAdrLikeConcepts: emittedItems.filter((item) => item.flags.orphanAdrLike).length,
    hubConcepts: emittedItems.filter((item) => item.flags.hub).length,
    byFreshness: countBy(emittedItems.map((item) => item.freshness)),
    byConfidence: countBy(emittedItems.map((item) => item.confidence)),
    byEvidenceClass: countBy(emittedItems.map((item) => item.evidenceClass)),
    authority: 'advisory',
    sidecarStatus: baseReport.sidecar.status,
    diagnosticSidecarStatus: normalizeMarkdownKnowledgeDiagnosticSidecarStatus(
      baseReport.sidecar.status,
    ),
    suggestedNextChecks: createSummarySuggestedNextChecks(emittedItems, baseReport),
  };
}

interface SourceFactEntry {
  fact: MarkdownDocumentFact;
  docPath?: string;
  headingPath: string[];
  lineSpan?: { start: number; end: number };
  excerpt: string;
}

interface SourceFactIndex {
  byKey: Map<string, SourceFactEntry>;
}

function createSourceFactIndex(facts: readonly MarkdownDocumentFact[]): SourceFactIndex {
  const chunkByKey = new Map<string, Extract<MarkdownDocumentFact, { kind: 'markdown-chunk' }>>();
  for (const fact of facts) {
    if (fact.kind === 'markdown-chunk') chunkByKey.set(fact.chunkKey, fact);
  }

  const byKey = new Map<string, SourceFactEntry>();
  for (const fact of facts) {
    byKey.set(sourceFactKey(fact), createSourceFactEntry(fact, chunkByKey));
  }
  return { byKey };
}

function createRationaleSnippets(
  concept: MarkdownKnowledgeConceptCluster,
  sourceFactIndex: SourceFactIndex,
  limit: number,
): MarkdownKnowledgeRationaleSnippet[] {
  const snippets: MarkdownKnowledgeRationaleSnippet[] = [];
  for (const sourceFactKey of concept.sourceFactKeys) {
    const entry = sourceFactIndex.byKey.get(sourceFactKey);
    if (!entry || entry.excerpt.length === 0) continue;
    snippets.push({
      sourceFactKey,
      factKind: entry.fact.kind,
      docPath: entry.docPath,
      headingPath: entry.headingPath,
      lineSpan: entry.lineSpan,
      excerpt: entry.excerpt,
      evidenceClass: 'docs_evidence',
      authority: concept.authority,
    });
    if (snippets.length >= limit) break;
  }
  return snippets;
}

function createSchemaEvidence(
  concept: MarkdownKnowledgeConceptCluster,
  sourceFactIndex: SourceFactIndex,
  limit: number,
): MarkdownKnowledgeSchemaEvidence[] {
  const evidence: MarkdownKnowledgeSchemaEvidence[] = [];
  for (const sourceFactKey of concept.sourceFactKeys) {
    const entry = sourceFactIndex.byKey.get(sourceFactKey);
    if (!entry || entry.fact.kind !== 'markdown-api-spec') continue;
    evidence.push({
      sourceFactKey,
      routeKey: entry.fact.routeKey,
      method: entry.fact.method,
      path: entry.fact.path,
      docPath: entry.fact.docPath,
      lineSpan: entry.fact.lineSpan,
      excerpt: entry.excerpt,
      evidenceClass: 'docs_evidence',
      authority: concept.authority,
    });
    if (evidence.length >= limit) break;
  }
  return evidence;
}

function createSourceFactEntry(
  fact: MarkdownDocumentFact,
  chunkByKey: ReadonlyMap<string, Extract<MarkdownDocumentFact, { kind: 'markdown-chunk' }>>,
): SourceFactEntry {
  const chunk = sourceChunk(fact, chunkByKey);
  return {
    fact,
    docPath: factDocPath(fact, chunk),
    headingPath: factHeadingPath(fact, chunk),
    lineSpan: factLineSpan(fact),
    excerpt: factExcerpt(fact, chunk),
  };
}

function sourceChunk(
  fact: MarkdownDocumentFact,
  chunkByKey: ReadonlyMap<string, Extract<MarkdownDocumentFact, { kind: 'markdown-chunk' }>>,
): Extract<MarkdownDocumentFact, { kind: 'markdown-chunk' }> | undefined {
  if ('sourceChunkKey' in fact && typeof fact.sourceChunkKey === 'string') {
    return chunkByKey.get(fact.sourceChunkKey);
  }
  if (fact.kind === 'markdown-code-mention') return chunkByKey.get(fact.chunkKey);
  if (fact.kind === 'markdown-entity') return chunkByKey.get(fact.sourceChunkKey);
  return undefined;
}

function sourceFactKey(fact: MarkdownDocumentFact): string {
  switch (fact.kind) {
    case 'markdown-chunk':
      return fact.chunkKey;
    case 'markdown-entity':
      return fact.entityKey;
    case 'markdown-code-mention':
      return [
        'markdown-code-mention',
        fact.chunkKey,
        fact.evidence.lineSpan.start,
        fact.evidence.lineSpan.end,
        fact.evidence.text,
      ].join(':');
    case 'markdown-requirement':
    case 'markdown-acceptance-criterion':
    case 'markdown-api-spec':
    case 'markdown-test-mention':
    case 'markdown-doc-owner':
      return fact.normalizedKey;
    case 'markdown-link':
      return [fact.kind, fact.fromChunkKey, fact.lineSpan.start, fact.lineSpan.end, fact.href].join(
        ':',
      );
  }
}

function factDocPath(
  fact: MarkdownDocumentFact,
  chunk?: Extract<MarkdownDocumentFact, { kind: 'markdown-chunk' }>,
): string | undefined {
  if ('docPath' in fact && typeof fact.docPath === 'string') return fact.docPath;
  return chunk?.docPath;
}

function factHeadingPath(
  fact: MarkdownDocumentFact,
  chunk?: Extract<MarkdownDocumentFact, { kind: 'markdown-chunk' }>,
): string[] {
  if ('headingPath' in fact && Array.isArray(fact.headingPath)) return [...fact.headingPath];
  return [...(chunk?.headingPath ?? [])];
}

function factLineSpan(fact: MarkdownDocumentFact): { start: number; end: number } | undefined {
  if ('lineSpan' in fact && isLineSpan(fact.lineSpan)) return fact.lineSpan;
  if ('evidence' in fact && typeof fact.evidence === 'object' && fact.evidence !== null) {
    const lineSpan = (fact.evidence as { lineSpan?: unknown }).lineSpan;
    if (isLineSpan(lineSpan)) return lineSpan;
  }
  return undefined;
}

function isLineSpan(value: unknown): value is { start: number; end: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { start?: unknown }).start === 'number' &&
    typeof (value as { end?: unknown }).end === 'number'
  );
}

function factExcerpt(
  fact: MarkdownDocumentFact,
  chunk?: Extract<MarkdownDocumentFact, { kind: 'markdown-chunk' }>,
): string {
  if (fact.kind === 'markdown-chunk') return fact.excerpt ?? fact.headingPath.at(-1) ?? '';
  if (fact.kind === 'markdown-link') return fact.text;
  if (fact.kind === 'markdown-entity') return fact.evidence.text;
  if ('evidence' in fact) {
    const evidence = fact.evidence as { text?: string; raw?: string };
    return evidence.text ?? evidence.raw ?? '';
  }
  return chunk?.excerpt ?? '';
}

export function normalizeMarkdownKnowledgeDiagnosticSidecarStatus(
  status: DocsSidecarStatus | string,
): MarkdownKnowledgeDiagnosticSidecarStatus {
  if (status === 'complete' || status === 'available') return 'complete';
  if (status === 'stale') return 'stale';
  if (status === 'missing') return 'missing';
  return 'partial';
}

function createSummarySuggestedNextChecks(
  items: readonly MarkdownKnowledgeReportItem[],
  baseReport: DocsReportEnvelope,
): string[] {
  const checks = [...sidecarSuggestedChecks(baseReport)];
  if (items.length === 0 && baseReport.sidecar.status === 'missing') {
    checks.push('generate markdown sidecar facts before interpreting concept coverage');
  }
  if (items.some((item) => item.flags.disconnected)) {
    checks.push('inspect disconnected concepts before relying on docs-to-code coverage');
  }
  if (items.some((item) => item.flags.overloaded)) {
    checks.push('review overloaded concept labels for false joins');
  }
  return sortedUnique(checks);
}

function createSidecarReportState(baseReport: DocsReportEnvelope): SidecarReportState {
  const reasons = sortedUnique([
    ...baseReport.sidecar.staleReasons,
    ...Object.entries(baseReport.sidecar.degradedReasons).flatMap(([reason, count]) =>
      count > 0 ? [`${reason}:${count}`] : [],
    ),
  ]);
  return {
    freshness: sidecarFreshness(baseReport.sidecar.status, baseReport.sidecar.staleReasons),
    reasons,
  };
}

function sidecarFreshness(
  status: DocsSidecarStatus,
  staleReasons: readonly string[],
): MarkdownConceptSidecarFreshness {
  if (status === 'missing') return 'missing';
  if (status === 'stale' || staleReasons.length > 0) return 'stale';
  if (status === 'available' || status === 'complete') return 'fresh';
  return 'unknown';
}

function sidecarSuggestedChecks(baseReport: DocsReportEnvelope): string[] {
  const checks: string[] = [];
  if (baseReport.sidecar.status === 'missing') {
    checks.push('generate or refresh markdown sidecar facts before interpreting this report');
  }
  if (baseReport.sidecar.status === 'stale' || baseReport.sidecar.staleReasons.length > 0) {
    checks.push('refresh markdown sidecar and resolution records');
  }
  if (baseReport.sidecar.status === 'partial') {
    checks.push(
      'inspect sidecar degraded reasons before acting on missing or disconnected concepts',
    );
  }
  if (baseReport.sidecar.status === 'failed') {
    checks.push('resolve markdown sidecar failure before interpreting this report');
  }
  if (baseReport.sidecar.status === 'queued' || baseReport.sidecar.status === 'running') {
    checks.push('wait for markdown sidecar completion before interpreting this report');
  }
  return checks;
}

function createWarnings(input: {
  baseReport: DocsReportEnvelope;
  inputWarnings: readonly string[];
  derivedWarnings: readonly string[];
  conceptTruncated: boolean;
  graphIdentityTruncated: boolean;
  maxItems: number;
  maxCandidatesPerFact: number;
}): string[] {
  const warnings = [
    ...input.baseReport.warnings,
    ...input.inputWarnings,
    ...input.derivedWarnings,
    ...sidecarWarnings(input.baseReport),
  ];
  if (input.conceptTruncated) {
    warnings.push(`knowledge report truncated to ${input.maxItems} concept(s)`);
  }
  if (input.graphIdentityTruncated) {
    warnings.push(
      `knowledge report graph identities truncated to ${input.maxCandidatesPerFact} per concept`,
    );
  }
  return sortedUnique(warnings);
}

function sidecarWarnings(baseReport: DocsReportEnvelope): string[] {
  const status = baseReport.sidecar.status;
  const warnings: string[] = [];
  if (
    status === 'missing' ||
    status === 'stale' ||
    status === 'partial' ||
    status === 'failed' ||
    status === 'queued' ||
    status === 'running' ||
    baseReport.sidecar.staleReasons.length > 0
  ) {
    warnings.push(`knowledge report degraded by sidecar status ${status}`);
  }
  for (const reason of baseReport.sidecar.staleReasons) {
    warnings.push(`knowledge report sidecar stale: ${reason}`);
  }
  for (const [reason, count] of Object.entries(baseReport.sidecar.degradedReasons).sort()) {
    if (count > 0) warnings.push(`knowledge report sidecar degraded: ${reason}=${count}`);
  }
  return warnings;
}

function sourceAreaKeys(concept: MarkdownKnowledgeConceptCluster): string[] {
  return sortedUnique([
    ...concept.sourceDocuments.map(sourceAreaKey),
    ...concept.linkedGraphIdentities.flatMap((identity) =>
      identity.filePath !== undefined ? [sourceAreaKey(identity.filePath)] : [],
    ),
  ]);
}

function sourceAreaKey(path: string): string {
  const [first = path, second] = path.replace(/\\/g, '/').split('/');
  return second === undefined ? first : `${first}/${second}`;
}

function isAdrLikeConcept(concept: MarkdownKnowledgeConceptCluster): boolean {
  const values = [
    concept.label,
    ...concept.aliases,
    ...concept.sourceDocuments,
    ...concept.clusterEdgeReasons.map((reason) => reason.value),
  ];
  return values.some(
    (value) => /\bADR[-_\s]?0*\d{1,5}\b/i.test(value) || /\/\d{4,5}-[^/]+\.md$/i.test(value),
  );
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}
