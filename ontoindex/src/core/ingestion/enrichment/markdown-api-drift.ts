import {
  DOCS_REPORT_LIMITS,
  DOCS_REPORT_VERSION,
  type DocsReportEnvelope,
} from './docs-contracts.js';
import type { MarkdownLineSpan } from './markdown-document-facts.js';
import type { NormalizedRouteCandidate } from './markdown-route-candidates.js';

export type ApiDriftStatus =
  | 'documented-missing-in-code'
  | 'code-missing-in-docs'
  | 'matched'
  | 'mismatch'
  | 'ambiguous'
  | 'unsupported';

export interface ApiDriftRouteEvidence {
  source: NormalizedRouteCandidate['source'];
  method: string;
  path: string;
  confidence: number;
  state: NormalizedRouteCandidate['state'];
  id?: string;
  filePath?: string;
  lineSpan?: MarkdownLineSpan;
  framework?: string;
  normalizationReasons: string[];
  unsupported?: NormalizedRouteCandidate['unsupported'];
  ambiguous?: NormalizedRouteCandidate['ambiguous'];
  metadata?: NormalizedRouteCandidate['metadata'];
}

export interface ApiDriftItem {
  status: ApiDriftStatus;
  routeKey: string;
  method: string;
  path: string;
  reason: string;
  confidence: number;
  docs: ApiDriftRouteEvidence[];
  code: ApiDriftRouteEvidence[];
  suggestedActions: string[];
}

export interface CreateMarkdownApiDriftReportInput {
  baseReport: DocsReportEnvelope;
  docCandidates: readonly NormalizedRouteCandidate[];
  codeCandidates: readonly NormalizedRouteCandidate[];
  warnings?: readonly string[];
  maxItems?: number;
  maxCandidatesPerFact?: number;
}

interface IndexedCandidate {
  candidate: NormalizedRouteCandidate;
  index: number;
}

export function createMarkdownApiDriftReport(
  input: CreateMarkdownApiDriftReportInput,
): DocsReportEnvelope<ApiDriftItem> {
  const maxItems =
    input.maxItems ?? input.baseReport.limits.maxItems ?? DOCS_REPORT_LIMITS.maxItems;
  const maxCandidatesPerFact =
    input.maxCandidatesPerFact ??
    input.baseReport.limits.maxCandidatesPerFact ??
    DOCS_REPORT_LIMITS.maxCandidatesPerFact;
  const docs = input.docCandidates.map((candidate, index) => ({ candidate, index }));
  const code = input.codeCandidates.map((candidate, index) => ({ candidate, index }));
  const warnings = [...input.baseReport.warnings, ...(input.warnings ?? [])];
  const items = buildItems(docs, code, maxCandidatesPerFact);
  const sorted = items.sort(compareItems);
  const emitted = sorted.slice(0, maxItems);
  const truncated = sorted.length > emitted.length;

  if (isDegraded(input.baseReport)) {
    warnings.push(`api drift report degraded by sidecar status ${input.baseReport.sidecar.status}`);
  }
  if (truncated) warnings.push(`api drift report truncated to ${maxItems} item(s)`);

  return {
    version: DOCS_REPORT_VERSION,
    repo: input.baseReport.repo,
    sidecar: input.baseReport.sidecar,
    summary: {
      ...input.baseReport.summary,
      report: 'api-drift',
      api: {
        documentedRoutes: input.docCandidates.length,
        codeRoutes: input.codeCandidates.length,
        emitted: emitted.length,
        matched: sorted.length,
        byStatus: countBy(sorted.map((item) => item.status)),
      },
    },
    items: emitted,
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

function buildItems(
  docs: readonly IndexedCandidate[],
  code: readonly IndexedCandidate[],
  maxCandidates: number,
): ApiDriftItem[] {
  const items: ApiDriftItem[] = [];
  const usedDocs = new Set<number>();
  const usedCode = new Set<number>();
  const all = [...docs, ...code];
  const supportedDocs = docs.filter((entry) => entry.candidate.state === 'supported');
  const supportedCode = code.filter((entry) => entry.candidate.state === 'supported');
  const groups = new Map<string, { docs: IndexedCandidate[]; code: IndexedCandidate[] }>();

  for (const entry of supportedDocs) getGroup(groups, identity(entry.candidate)).docs.push(entry);
  for (const entry of supportedCode) getGroup(groups, identity(entry.candidate)).code.push(entry);

  for (const entry of all.filter((value) => value.candidate.state !== 'supported')) {
    items.push(createUnsupportedItem(entry, maxCandidates));
    markUsed(entry, usedDocs, usedCode);
  }

  for (const [routeKey, group] of groups) {
    if (
      group.docs.length > 1 ||
      group.code.length > 1 ||
      group.docs.some((entry) => entry.candidate.ambiguous) ||
      group.code.some((entry) => entry.candidate.ambiguous)
    ) {
      items.push(createAmbiguousItem(routeKey, group.docs, group.code, maxCandidates));
      for (const entry of [...group.docs, ...group.code]) markUsed(entry, usedDocs, usedCode);
    }
  }

  for (const [routeKey, group] of groups) {
    if (group.docs.length !== 1 || group.code.length !== 1) continue;
    const [doc] = group.docs;
    const [codeCandidate] = group.code;
    if (!doc || !codeCandidate || usedDocs.has(doc.index) || usedCode.has(codeCandidate.index)) {
      continue;
    }
    items.push(createMatchedItem(routeKey, doc, codeCandidate, maxCandidates));
    usedDocs.add(doc.index);
    usedCode.add(codeCandidate.index);
  }

  for (const doc of supportedDocs) {
    if (usedDocs.has(doc.index)) continue;
    const mismatch = supportedCode.find(
      (entry) =>
        !usedCode.has(entry.index) &&
        entry.candidate.path === doc.candidate.path &&
        entry.candidate.method !== doc.candidate.method,
    );
    if (!mismatch) continue;
    items.push(createMismatchItem(doc, mismatch, maxCandidates));
    usedDocs.add(doc.index);
    usedCode.add(mismatch.index);
  }

  for (const doc of supportedDocs) {
    if (usedDocs.has(doc.index)) continue;
    if (code.some((entry) => entry.candidate.path === doc.candidate.path)) continue;
    items.push(createDocumentedMissingItem(doc, maxCandidates));
    usedDocs.add(doc.index);
  }

  for (const codeCandidate of supportedCode) {
    if (usedCode.has(codeCandidate.index)) continue;
    if (docs.some((entry) => entry.candidate.path === codeCandidate.candidate.path)) continue;
    items.push(createCodeMissingItem(codeCandidate, maxCandidates));
    usedCode.add(codeCandidate.index);
  }

  return items;
}

function getGroup(
  groups: Map<string, { docs: IndexedCandidate[]; code: IndexedCandidate[] }>,
  routeKey: string,
): { docs: IndexedCandidate[]; code: IndexedCandidate[] } {
  const existing = groups.get(routeKey);
  if (existing) return existing;
  const group = { docs: [], code: [] };
  groups.set(routeKey, group);
  return group;
}

function createUnsupportedItem(entry: IndexedCandidate, maxCandidates: number): ApiDriftItem {
  const candidate = entry.candidate;
  return {
    status: 'unsupported',
    routeKey: identity(candidate),
    method: candidate.method,
    path: candidate.path,
    reason: candidate.unsupported?.reason ?? 'route candidate is partial or unsupported',
    confidence: candidate.confidence,
    docs: candidate.source === 'doc' ? [routeEvidence(candidate, maxCandidates)] : [],
    code: candidate.source === 'code' ? [routeEvidence(candidate, maxCandidates)] : [],
    suggestedActions:
      candidate.source === 'code'
        ? ['add or improve route extraction metadata before treating this as drift']
        : ['fix documented route method/path metadata before treating this as drift'],
  };
}

function createAmbiguousItem(
  routeKey: string,
  docs: readonly IndexedCandidate[],
  code: readonly IndexedCandidate[],
  maxCandidates: number,
): ApiDriftItem {
  const first = docs[0]?.candidate ?? code[0]?.candidate;
  return {
    status: 'ambiguous',
    routeKey,
    method: first?.method ?? '*',
    path: first?.path ?? '<missing-path>',
    reason: 'multiple route candidates share the same identity',
    confidence: maxConfidence([...docs, ...code]),
    docs: docs
      .map((entry) => routeEvidence(entry.candidate, maxCandidates))
      .slice(0, maxCandidates),
    code: code
      .map((entry) => routeEvidence(entry.candidate, maxCandidates))
      .slice(0, maxCandidates),
    suggestedActions: ['disambiguate duplicate documented or code route candidates'],
  };
}

function createMatchedItem(
  routeKey: string,
  doc: IndexedCandidate,
  code: IndexedCandidate,
  maxCandidates: number,
): ApiDriftItem {
  return {
    status: 'matched',
    routeKey,
    method: doc.candidate.method,
    path: doc.candidate.path,
    reason: 'documented route matches code route',
    confidence: Math.min(doc.candidate.confidence, code.candidate.confidence),
    docs: [routeEvidence(doc.candidate, maxCandidates)],
    code: [routeEvidence(code.candidate, maxCandidates)],
    suggestedActions: [],
  };
}

function createMismatchItem(
  doc: IndexedCandidate,
  code: IndexedCandidate,
  maxCandidates: number,
): ApiDriftItem {
  return {
    status: 'mismatch',
    routeKey: `${doc.candidate.method} ${doc.candidate.path}`,
    method: doc.candidate.method,
    path: doc.candidate.path,
    reason: `documented ${doc.candidate.method} does not match code ${code.candidate.method} for ${doc.candidate.path}`,
    confidence: Math.min(doc.candidate.confidence, code.candidate.confidence),
    docs: [routeEvidence(doc.candidate, maxCandidates)],
    code: [routeEvidence(code.candidate, maxCandidates)],
    suggestedActions: ['align documented HTTP method with code route method'],
  };
}

function createDocumentedMissingItem(doc: IndexedCandidate, maxCandidates: number): ApiDriftItem {
  return {
    status: 'documented-missing-in-code',
    routeKey: identity(doc.candidate),
    method: doc.candidate.method,
    path: doc.candidate.path,
    reason: 'documented route has no supported code route candidate',
    confidence: doc.candidate.confidence,
    docs: [routeEvidence(doc.candidate, maxCandidates)],
    code: [],
    suggestedActions: ['implement the route or remove stale API documentation'],
  };
}

function createCodeMissingItem(code: IndexedCandidate, maxCandidates: number): ApiDriftItem {
  return {
    status: 'code-missing-in-docs',
    routeKey: identity(code.candidate),
    method: code.candidate.method,
    path: code.candidate.path,
    reason: 'code route has no documented API route candidate',
    confidence: code.candidate.confidence,
    docs: [],
    code: [routeEvidence(code.candidate, maxCandidates)],
    suggestedActions: ['document the code route or mark it internal'],
  };
}

function routeEvidence(
  candidate: NormalizedRouteCandidate,
  _maxCandidates: number,
): ApiDriftRouteEvidence {
  return {
    source: candidate.source,
    method: candidate.method,
    path: candidate.path,
    confidence: candidate.confidence,
    state: candidate.state,
    id: candidate.id,
    filePath: candidate.filePath,
    lineSpan: candidate.lineSpan,
    framework: candidate.framework,
    normalizationReasons: [...candidate.normalizationReasons],
    unsupported: candidate.unsupported,
    ambiguous: candidate.ambiguous,
    metadata: candidate.metadata,
  };
}

function markUsed(entry: IndexedCandidate, usedDocs: Set<number>, usedCode: Set<number>): void {
  if (entry.candidate.source === 'doc') usedDocs.add(entry.index);
  else usedCode.add(entry.index);
}

function identity(candidate: NormalizedRouteCandidate): string {
  return `${candidate.method} ${candidate.path}`;
}

function maxConfidence(entries: readonly IndexedCandidate[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.candidate.confidence), 0);
}

function isDegraded(baseReport: DocsReportEnvelope): boolean {
  return (
    baseReport.sidecar.status === 'stale' ||
    baseReport.sidecar.status === 'partial' ||
    baseReport.sidecar.status === 'failed' ||
    baseReport.sidecar.status === 'missing' ||
    baseReport.sidecar.staleReasons.length > 0
  );
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function compareItems(left: ApiDriftItem, right: ApiDriftItem): number {
  const statusOrder = statusRank(left.status) - statusRank(right.status);
  if (statusOrder !== 0) return statusOrder;
  return left.routeKey.localeCompare(right.routeKey);
}

function statusRank(status: ApiDriftStatus): number {
  return [
    'unsupported',
    'ambiguous',
    'mismatch',
    'documented-missing-in-code',
    'code-missing-in-docs',
    'matched',
  ].indexOf(status);
}
