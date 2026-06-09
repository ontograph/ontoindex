import {
  DOCS_REPORT_LIMITS,
  DOCS_REPORT_VERSION,
  type DocsReportEnvelope,
} from './docs-contracts.js';
import type {
  MarkdownAcceptanceCriterionFact,
  MarkdownCodeMentionFact,
  MarkdownDocumentFact,
  MarkdownLineSpan,
  MarkdownRequirementFact,
  MarkdownTestMentionFact,
} from './markdown-document-facts.js';
import type {
  MarkdownDocResolutionRecord,
  MarkdownDocResolutionStatus,
} from './markdown-doc-resolver.js';
import type { GraphIdentityCandidate } from './markdown-graph-identity-provider.js';

export type RequirementTraceEvidenceClass =
  | 'declared'
  | 'linked'
  | 'resolved'
  | 'structural'
  | 'tested';

export type RequirementTraceStatus = 'implemented' | 'partial' | 'missing' | 'ambiguous' | 'stale';

export interface RequirementTraceDocEvidence {
  docPath: string;
  headingPath: string[];
  lineSpan: MarkdownLineSpan;
  excerpt: string;
  source: MarkdownRequirementFact['source'];
  title?: string;
  metadata?: MarkdownRequirementFact['metadata'];
}

export interface RequirementTraceAcceptanceCriterion {
  criterion: string;
  ordinal: number;
  docPath: string;
  headingPath: string[];
  lineSpan: MarkdownLineSpan;
  excerpt: string;
}

export interface RequirementTraceImplementationEvidence {
  kind: 'requirement' | 'code-mention';
  status: MarkdownDocResolutionStatus;
  evidenceKind: MarkdownDocResolutionRecord['evidenceKind'];
  docPath: string;
  factKey: string;
  confidence: number;
  reasons: string[];
  lineSpan?: MarkdownLineSpan;
  target?: GraphIdentityCandidate;
  candidates: GraphIdentityCandidate[];
}

export interface RequirementTraceTestEvidence {
  mention: string;
  status: MarkdownDocResolutionStatus | 'declared';
  docPath: string;
  headingPath: string[];
  lineSpan: MarkdownLineSpan;
  confidence: number;
  reasons: string[];
  targetPath?: string;
  target?: GraphIdentityCandidate;
  candidates: GraphIdentityCandidate[];
}

export interface RequirementTraceItem {
  requirementId: string;
  title?: string;
  status: RequirementTraceStatus;
  reason: string;
  confidence: number;
  docs: RequirementTraceDocEvidence[];
  acceptanceCriteria: RequirementTraceAcceptanceCriterion[];
  implementationEvidence: RequirementTraceImplementationEvidence[];
  tests: RequirementTraceTestEvidence[];
  evidenceClasses: RequirementTraceEvidenceClass[];
  suggestedActions: string[];
}

export interface CreateMarkdownRequirementTraceReportInput {
  baseReport: DocsReportEnvelope;
  facts: readonly MarkdownDocumentFact[];
  resolutions: readonly MarkdownDocResolutionRecord[];
  requirementId?: string;
  warnings?: readonly string[];
  maxItems?: number;
  maxCandidatesPerFact?: number;
}

interface RequirementContext {
  facts: MarkdownRequirementFact[];
  criteria: MarkdownAcceptanceCriterionFact[];
  codeMentions: MarkdownCodeMentionFact[];
  tests: MarkdownTestMentionFact[];
  resolutions: MarkdownDocResolutionRecord[];
}

export function createMarkdownRequirementTraceReport(
  input: CreateMarkdownRequirementTraceReportInput,
): DocsReportEnvelope<RequirementTraceItem> {
  const maxItems =
    input.maxItems ?? input.baseReport.limits.maxItems ?? DOCS_REPORT_LIMITS.maxItems;
  const maxCandidatesPerFact =
    input.maxCandidatesPerFact ??
    input.baseReport.limits.maxCandidatesPerFact ??
    DOCS_REPORT_LIMITS.maxCandidatesPerFact;
  const requirementFacts = input.facts.filter(isRequirementFact);
  const contexts = buildRequirementContexts(requirementFacts, input.facts, input.resolutions);
  const filtered = input.requirementId
    ? contexts.filter(([requirementId]) => requirementId === input.requirementId)
    : contexts;
  const allItems = filtered
    .map(([, context]) => createTraceItem(context, input.baseReport, maxCandidatesPerFact))
    .sort(compareTraceItems);
  const items = allItems.slice(0, maxItems);
  const truncated = allItems.length > items.length;
  const warnings = [...input.baseReport.warnings, ...(input.warnings ?? [])];
  if (input.requirementId && allItems.length === 0) {
    warnings.push(`requirement ${input.requirementId} not found`);
  }
  if (truncated) {
    warnings.push(`requirement trace truncated to ${maxItems} item(s)`);
  }

  return {
    version: DOCS_REPORT_VERSION,
    repo: input.baseReport.repo,
    sidecar: input.baseReport.sidecar,
    summary: createSummary(items, allItems.length, requirementFacts.length, input),
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

function buildRequirementContexts(
  requirements: readonly MarkdownRequirementFact[],
  facts: readonly MarkdownDocumentFact[],
  resolutions: readonly MarkdownDocResolutionRecord[],
): Array<[string, RequirementContext]> {
  const contexts = new Map<string, RequirementContext>();
  const orderedRequirements = [...requirements].sort(compareRequirementFacts);
  for (const fact of orderedRequirements) {
    getContext(contexts, fact.requirementId).facts.push(fact);
  }

  for (const fact of facts) {
    if (isAcceptanceCriterionFact(fact)) {
      const requirementId =
        fact.requirementId ?? findContainingRequirementId(fact, orderedRequirements);
      if (requirementId) getContext(contexts, requirementId).criteria.push(fact);
    } else if (isTestMentionFact(fact)) {
      const requirementId = findContainingRequirementId(fact, orderedRequirements);
      if (requirementId) getContext(contexts, requirementId).tests.push(fact);
    } else if (isCodeMentionFact(fact)) {
      const lineSpan = fact.evidence.lineSpan;
      const docPath = docPathFromChunkKey(fact.chunkKey);
      const requirementId = docPath
        ? findContainingRequirementId({ docPath, lineSpan }, orderedRequirements)
        : undefined;
      if (requirementId) getContext(contexts, requirementId).codeMentions.push(fact);
    }
  }

  const factKeyOwners = createFactKeyOwners(contexts);
  for (const resolution of resolutions) {
    const requirementId =
      factKeyOwners.get(resolution.factKey) ??
      findContainingResolutionRequirementId(resolution, orderedRequirements);
    if (requirementId) getContext(contexts, requirementId).resolutions.push(resolution);
  }

  return [...contexts.entries()];
}

function getContext(
  contexts: Map<string, RequirementContext>,
  requirementId: string,
): RequirementContext {
  const existing = contexts.get(requirementId);
  if (existing) return existing;
  const context: RequirementContext = {
    facts: [],
    criteria: [],
    codeMentions: [],
    tests: [],
    resolutions: [],
  };
  contexts.set(requirementId, context);
  return context;
}

function createFactKeyOwners(
  contexts: ReadonlyMap<string, RequirementContext>,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [requirementId, context] of contexts) {
    for (const fact of context.facts) owners.set(fact.normalizedKey, requirementId);
    for (const fact of context.criteria) owners.set(fact.normalizedKey, requirementId);
    for (const fact of context.tests) owners.set(fact.normalizedKey, requirementId);
    for (const fact of context.codeMentions) owners.set(codeMentionFactKey(fact), requirementId);
  }
  return owners;
}

function createTraceItem(
  context: RequirementContext,
  baseReport: DocsReportEnvelope,
  maxCandidatesPerFact: number,
): RequirementTraceItem {
  const requirementId = context.facts[0]?.requirementId ?? 'unknown';
  const docs = context.facts.map(createDocEvidence).sort(compareDocEvidence);
  const criteria = context.criteria.map(createAcceptanceCriterion).sort(compareCriteria);
  const implementationEvidence = context.resolutions
    .filter(
      (record) => record.subjectKind === 'requirement' || record.subjectKind === 'code-mention',
    )
    .map((record) => createImplementationEvidence(record, maxCandidatesPerFact))
    .sort(compareImplementationEvidence);
  const tests = createTestEvidence(context, maxCandidatesPerFact);
  const evidenceClasses = classifyEvidence(context, implementationEvidence, tests);
  const status = classifyStatus(baseReport, implementationEvidence, tests, evidenceClasses);
  const confidence = computeConfidence(implementationEvidence, tests);
  const reason = createReason(status, baseReport, implementationEvidence, tests, evidenceClasses);
  return {
    requirementId,
    title: context.facts.find((fact) => fact.title)?.title,
    status,
    reason,
    confidence,
    docs,
    acceptanceCriteria: criteria,
    implementationEvidence,
    tests,
    evidenceClasses,
    suggestedActions: createSuggestedActions(
      status,
      evidenceClasses,
      implementationEvidence,
      tests,
    ),
  };
}

function createDocEvidence(fact: MarkdownRequirementFact): RequirementTraceDocEvidence {
  return {
    docPath: fact.docPath,
    headingPath: [...fact.headingPath],
    lineSpan: fact.lineSpan,
    excerpt: fact.evidence.text,
    source: fact.source,
    title: fact.title,
    metadata: fact.metadata,
  };
}

function createAcceptanceCriterion(
  fact: MarkdownAcceptanceCriterionFact,
): RequirementTraceAcceptanceCriterion {
  return {
    criterion: fact.criterion,
    ordinal: fact.ordinal,
    docPath: fact.docPath,
    headingPath: [...fact.headingPath],
    lineSpan: fact.lineSpan,
    excerpt: fact.evidence.text,
  };
}

function createImplementationEvidence(
  record: MarkdownDocResolutionRecord,
  maxCandidatesPerFact: number,
): RequirementTraceImplementationEvidence {
  return {
    kind: record.subjectKind === 'code-mention' ? 'code-mention' : 'requirement',
    status: record.status,
    evidenceKind: record.evidenceKind,
    docPath: record.docPath,
    factKey: record.factKey,
    confidence: record.confidence,
    reasons: [...record.reasons],
    lineSpan: record.lineSpan,
    target: record.targetGraphIdentity,
    candidates: record.candidates.slice(0, maxCandidatesPerFact),
  };
}

function createTestEvidence(
  context: RequirementContext,
  maxCandidatesPerFact: number,
): RequirementTraceTestEvidence[] {
  const resolutionByFactKey = new Map(
    context.resolutions
      .filter((record) => record.subjectKind === 'test-mention')
      .map((record) => [record.factKey, record]),
  );
  return context.tests
    .map((fact) => {
      const resolution = resolutionByFactKey.get(fact.normalizedKey);
      const status: RequirementTraceTestEvidence['status'] = resolution?.status ?? 'declared';
      return {
        mention: fact.mention,
        status,
        docPath: fact.docPath,
        headingPath: [...fact.headingPath],
        lineSpan: fact.lineSpan,
        confidence: resolution?.confidence ?? fact.confidence,
        reasons: resolution?.reasons ? [...resolution.reasons] : [],
        targetPath: fact.targetPath,
        target: resolution?.targetGraphIdentity,
        candidates: resolution?.candidates.slice(0, maxCandidatesPerFact) ?? [],
      };
    })
    .sort(compareTestEvidence);
}

function classifyEvidence(
  context: RequirementContext,
  implementationEvidence: readonly RequirementTraceImplementationEvidence[],
  tests: readonly RequirementTraceTestEvidence[],
): RequirementTraceEvidenceClass[] {
  const classes = new Set<RequirementTraceEvidenceClass>();
  if (context.facts.length > 0) classes.add('declared');
  if (context.criteria.length > 0 || implementationEvidence.length > 0 || tests.length > 0) {
    classes.add('linked');
  }
  if (
    implementationEvidence.some((evidence) => evidence.status === 'resolved') ||
    tests.some((test) => test.status === 'resolved')
  ) {
    classes.add('resolved');
  }
  if (implementationEvidence.some((evidence) => evidence.evidenceKind === 'graph-structural')) {
    classes.add('structural');
  }
  if (tests.some((test) => test.status === 'resolved')) classes.add('tested');
  return ['declared', 'linked', 'resolved', 'structural', 'tested'].filter((key) =>
    classes.has(key as RequirementTraceEvidenceClass),
  ) as RequirementTraceEvidenceClass[];
}

function classifyStatus(
  baseReport: DocsReportEnvelope,
  implementationEvidence: readonly RequirementTraceImplementationEvidence[],
  tests: readonly RequirementTraceTestEvidence[],
  evidenceClasses: readonly RequirementTraceEvidenceClass[],
): RequirementTraceStatus {
  if (
    baseReport.sidecar.status === 'stale' ||
    baseReport.sidecar.staleReasons.length > 0 ||
    implementationEvidence.some((evidence) => evidence.status === 'stale') ||
    tests.some((test) => test.status === 'stale')
  ) {
    return 'stale';
  }
  if (
    implementationEvidence.some((evidence) => evidence.status === 'ambiguous') ||
    tests.some((test) => test.status === 'ambiguous')
  ) {
    return 'ambiguous';
  }
  if (baseReport.sidecar.status === 'partial') return 'partial';
  if (
    implementationEvidence.some((evidence) => evidence.status === 'resolved') ||
    evidenceClasses.includes('resolved')
  ) {
    return 'implemented';
  }
  if (evidenceClasses.some((evidenceClass) => evidenceClass !== 'declared')) return 'partial';
  return 'missing';
}

function computeConfidence(
  implementationEvidence: readonly RequirementTraceImplementationEvidence[],
  tests: readonly RequirementTraceTestEvidence[],
): number {
  const values = [
    ...implementationEvidence.map((evidence) => evidence.confidence),
    ...tests.map((test) => test.confidence),
  ].filter((value) => Number.isFinite(value));
  if (values.length === 0) return 0;
  return Math.max(...values);
}

function createReason(
  status: RequirementTraceStatus,
  baseReport: DocsReportEnvelope,
  implementationEvidence: readonly RequirementTraceImplementationEvidence[],
  tests: readonly RequirementTraceTestEvidence[],
  evidenceClasses: readonly RequirementTraceEvidenceClass[],
): string {
  if (status === 'stale') {
    return baseReport.sidecar.staleReasons[0] ?? 'stale resolution evidence';
  }
  if (status === 'ambiguous') return 'multiple graph candidates remain unresolved';
  if (status === 'partial') {
    if (baseReport.sidecar.status === 'partial') return 'sidecar coverage is partial';
    return 'requirement has linked evidence but no resolved implementation';
  }
  if (status === 'implemented') {
    return tests.some((test) => test.status === 'resolved') || evidenceClasses.includes('tested')
      ? 'resolved implementation evidence with tests'
      : 'resolved implementation evidence without resolved tests';
  }
  if (implementationEvidence.some((evidence) => evidence.status === 'unresolved')) {
    return (
      implementationEvidence.find((evidence) => evidence.status === 'unresolved')?.reasons[0] ??
      'unresolved implementation evidence'
    );
  }
  return 'no implementation evidence found';
}

function createSuggestedActions(
  status: RequirementTraceStatus,
  evidenceClasses: readonly RequirementTraceEvidenceClass[],
  implementationEvidence: readonly RequirementTraceImplementationEvidence[],
  tests: readonly RequirementTraceTestEvidence[],
): string[] {
  if (status === 'stale') return ['refresh markdown sidecar and resolution records'];
  if (status === 'ambiguous')
    return ['add explicit code symbol or file anchors for this requirement'];
  if (status === 'missing') return ['add code evidence or implement the requirement'];
  const actions: string[] = [];
  if (!evidenceClasses.includes('tested')) actions.push('link or add a resolved test mention');
  if (
    implementationEvidence.some((evidence) => evidence.status === 'unresolved') ||
    tests.some((test) => test.status === 'unresolved')
  ) {
    actions.push('resolve unresolved documentation references');
  }
  return actions;
}

function createSummary(
  items: readonly RequirementTraceItem[],
  totalMatched: number,
  totalDeclared: number,
  input: CreateMarkdownRequirementTraceReportInput,
): Record<string, unknown> {
  return {
    ...input.baseReport.summary,
    report: 'requirement-trace',
    requirements: {
      declared: totalDeclared,
      matched: totalMatched,
      emitted: items.length,
      byStatus: countBy(items.map((item) => item.status)),
      byEvidenceClass: countBy(items.flatMap((item) => item.evidenceClasses)),
      filterId: input.requirementId,
    },
  };
}

function findContainingResolutionRequirementId(
  resolution: MarkdownDocResolutionRecord,
  requirements: readonly MarkdownRequirementFact[],
): string | undefined {
  if (!resolution.lineSpan) return undefined;
  return findContainingRequirementId(
    { docPath: resolution.docPath, lineSpan: resolution.lineSpan },
    requirements,
  );
}

function findContainingRequirementId(
  fact: { docPath: string; lineSpan: MarkdownLineSpan },
  requirements: readonly MarkdownRequirementFact[],
): string | undefined {
  const sameDoc = requirements.filter((requirement) => requirement.docPath === fact.docPath);
  let owner: MarkdownRequirementFact | undefined;
  for (const requirement of sameDoc) {
    if (requirement.lineSpan.start > fact.lineSpan.start) break;
    owner = requirement;
  }
  return owner?.requirementId;
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

function docPathFromChunkKey(chunkKey: string): string | undefined {
  const [kind, docPath] = chunkKey.split(':');
  return kind === 'markdown-chunk' && docPath ? docPath : undefined;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function compareRequirementFacts(
  left: MarkdownRequirementFact,
  right: MarkdownRequirementFact,
): number {
  if (left.docPath !== right.docPath) return left.docPath.localeCompare(right.docPath);
  return left.lineSpan.start - right.lineSpan.start;
}

function compareDocEvidence(
  left: RequirementTraceDocEvidence,
  right: RequirementTraceDocEvidence,
): number {
  if (left.docPath !== right.docPath) return left.docPath.localeCompare(right.docPath);
  return left.lineSpan.start - right.lineSpan.start;
}

function compareCriteria(
  left: RequirementTraceAcceptanceCriterion,
  right: RequirementTraceAcceptanceCriterion,
): number {
  if (left.docPath !== right.docPath) return left.docPath.localeCompare(right.docPath);
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  return left.lineSpan.start - right.lineSpan.start;
}

function compareImplementationEvidence(
  left: RequirementTraceImplementationEvidence,
  right: RequirementTraceImplementationEvidence,
): number {
  if (left.docPath !== right.docPath) return left.docPath.localeCompare(right.docPath);
  if (left.factKey !== right.factKey) return left.factKey.localeCompare(right.factKey);
  return right.confidence - left.confidence;
}

function compareTestEvidence(
  left: RequirementTraceTestEvidence,
  right: RequirementTraceTestEvidence,
): number {
  if (left.docPath !== right.docPath) return left.docPath.localeCompare(right.docPath);
  if (left.lineSpan.start !== right.lineSpan.start)
    return left.lineSpan.start - right.lineSpan.start;
  return left.mention.localeCompare(right.mention);
}

function compareTraceItems(left: RequirementTraceItem, right: RequirementTraceItem): number {
  return left.requirementId.localeCompare(right.requirementId);
}

function isRequirementFact(fact: MarkdownDocumentFact): fact is MarkdownRequirementFact {
  return fact.kind === 'markdown-requirement';
}

function isAcceptanceCriterionFact(
  fact: MarkdownDocumentFact,
): fact is MarkdownAcceptanceCriterionFact {
  return fact.kind === 'markdown-acceptance-criterion';
}

function isTestMentionFact(fact: MarkdownDocumentFact): fact is MarkdownTestMentionFact {
  return fact.kind === 'markdown-test-mention';
}

function isCodeMentionFact(fact: MarkdownDocumentFact): fact is MarkdownCodeMentionFact {
  return fact.kind === 'markdown-code-mention';
}
