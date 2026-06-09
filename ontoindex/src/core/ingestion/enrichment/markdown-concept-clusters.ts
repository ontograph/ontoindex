import { createHash } from 'node:crypto';

import type { GraphIdentityCandidate } from './markdown-graph-identity-provider.js';
import type {
  MarkdownChunkFact,
  MarkdownCodeMentionFact,
  MarkdownDocumentFact,
} from './markdown-document-facts.js';
import { normalizeMarkdownAnchor } from './markdown-document-facts.js';
import type { MarkdownDocResolutionRecord } from './markdown-doc-resolver.js';

export type MarkdownConceptEvidenceClass = 'docs_evidence';
export type MarkdownKnowledgeAuthority = 'authoritative' | 'advisory';
export type MarkdownConceptFreshness = 'fresh' | 'stale' | 'unknown';
export type MarkdownConceptConfidence = 'high' | 'medium' | 'low';
export type MarkdownConceptSidecarFreshness = MarkdownConceptFreshness | 'missing';

export type MarkdownConceptClusterEdgeReasonKind =
  | 'same-normalized-label'
  | 'same-adr-id'
  | 'same-requirement-id'
  | 'same-route'
  | 'same-file'
  | 'same-symbol'
  | 'same-owner'
  | 'same-heading-path';

export interface MarkdownConceptGraphIdentity {
  type: GraphIdentityCandidate['type'] | 'process' | 'cluster';
  id: string;
  name?: string;
  filePath?: string;
  method?: string;
  routePath?: string;
  confidence?: number;
  resolutionStatus?: MarkdownDocResolutionRecord['status'];
  resolutionKey?: string;
  sourceIndexId?: string;
  graphSchemaVersion?: number;
}

export interface MarkdownConceptClusterEdgeReason {
  reason: MarkdownConceptClusterEdgeReasonKind;
  value: string;
  sourceFactKeys: string[];
  resolutionKeys: string[];
}

export interface MarkdownKnowledgeConceptCluster {
  id: string;
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
  clusterEdgeReasons: MarkdownConceptClusterEdgeReason[];
}

export interface MarkdownConceptSidecarState {
  freshness?: MarkdownConceptSidecarFreshness;
  reasons?: readonly string[];
}

export interface DeriveMarkdownConceptClustersInput {
  facts: readonly MarkdownDocumentFact[];
  resolutions?: readonly MarkdownDocResolutionRecord[];
  sidecar?: MarkdownConceptSidecarState;
  maxConcepts?: number;
}

export interface DerivedMarkdownConceptClusters {
  sidecar: {
    freshness: MarkdownConceptSidecarFreshness;
    reasons: string[];
  };
  concepts: MarkdownKnowledgeConceptCluster[];
  totalConcepts: number;
  warnings: string[];
}

interface ConceptNode {
  index: number;
  label: string;
  normalizedLabel: string;
  docPath?: string;
  sourceFactKey: string;
  resolutionKeys: string[];
  resolutionStatuses: MarkdownDocResolutionRecord['status'][];
  linkedGraphIdentities: MarkdownConceptGraphIdentity[];
  signals: Signal[];
}

interface Signal {
  reason: MarkdownConceptClusterEdgeReasonKind;
  value: string;
  sourceFactKey: string;
  resolutionKeys: string[];
}

export function deriveMarkdownConceptClusters(
  input: DeriveMarkdownConceptClustersInput,
): DerivedMarkdownConceptClusters {
  const sidecarFreshness = normalizeSidecarFreshness(input.sidecar, input.facts.length);
  const maxConcepts = normalizeLimit(input.maxConcepts ?? 100);
  const chunkByKey = new Map<string, MarkdownChunkFact>();
  for (const fact of input.facts) {
    if (fact.kind === 'markdown-chunk') {
      chunkByKey.set(fact.chunkKey, fact);
    }
  }

  const resolutionsByFactKey = groupResolutions(input.resolutions ?? []);
  const nodes: ConceptNode[] = [];
  for (const fact of input.facts) {
    const node = createConceptNode(fact, nodes.length, chunkByKey, resolutionsByFactKey);
    if (node !== undefined) nodes.push(node);
  }
  const unionFind = new UnionFind(nodes.length);
  const signalBuckets = groupSignals(nodes);

  for (const bucket of signalBuckets.values()) {
    const nodeIndexes = [...new Set(bucket.map((signal) => signal.nodeIndex))];
    if (nodeIndexes.length < 2) continue;
    const [first, ...rest] = nodeIndexes;
    for (const nodeIndex of rest) unionFind.union(first, nodeIndex);
  }

  const clustersByRoot = new Map<number, ConceptNode[]>();
  for (const node of nodes) {
    const root = unionFind.find(node.index);
    const list = clustersByRoot.get(root) ?? [];
    list.push(node);
    clustersByRoot.set(root, list);
  }

  const allConcepts = [...clustersByRoot.values()]
    .map((clusterNodes) => createCluster(clusterNodes, sidecarFreshness))
    .sort(compareClusters);
  const concepts = allConcepts.slice(0, maxConcepts);

  return {
    sidecar: {
      freshness: sidecarFreshness,
      reasons: [...(input.sidecar?.reasons ?? [])].sort(),
    },
    concepts,
    totalConcepts: allConcepts.length,
    warnings: createWarnings(sidecarFreshness, allConcepts.length, maxConcepts),
  };
}

function createConceptNode(
  fact: MarkdownDocumentFact,
  index: number,
  chunkByKey: ReadonlyMap<string, MarkdownChunkFact>,
  resolutionsByFactKey: ReadonlyMap<string, MarkdownDocResolutionRecord[]>,
): ConceptNode | undefined {
  if (fact.kind === 'markdown-link') return undefined;

  const sourceFactKey = factKey(fact);
  const resolutions = resolutionsByFactKey.get(sourceFactKey) ?? [];
  const chunk = sourceChunk(fact, chunkByKey);
  const docPath = factDocPath(fact, chunk);
  const headingPath = factHeadingPath(fact, chunk);
  const label = factLabel(fact, docPath);
  const normalizedLabel = normalizeConceptLabel(
    fact.kind === 'markdown-entity' ? fact.normalizedLabel : label,
  );

  if (normalizedLabel.length === 0) return undefined;

  const resolutionKeys = resolutions.map((record) => record.resolutionKey).sort();
  const signals: Signal[] = [];
  addSignal(signals, 'same-normalized-label', normalizedLabel, sourceFactKey, resolutionKeys);
  addSignal(
    signals,
    'same-heading-path',
    headingSignal(docPath, headingPath),
    sourceFactKey,
    resolutionKeys,
  );
  for (const adrId of extractAdrIds([label, docPath, ...headingPath, factEvidenceText(fact)])) {
    addSignal(signals, 'same-adr-id', adrId, sourceFactKey, resolutionKeys);
  }
  for (const requirementId of factRequirementIds(fact)) {
    addSignal(signals, 'same-requirement-id', requirementId, sourceFactKey, resolutionKeys);
  }
  for (const route of factRoutes(fact, resolutions)) {
    addSignal(signals, 'same-route', route, sourceFactKey, resolutionKeys);
  }
  for (const file of factFiles(fact, resolutions)) {
    addSignal(signals, 'same-file', file, sourceFactKey, resolutionKeys);
  }
  for (const symbol of factSymbols(fact, resolutions)) {
    addSignal(signals, 'same-symbol', symbol, sourceFactKey, resolutionKeys);
  }
  for (const owner of factOwners(fact)) {
    addSignal(signals, 'same-owner', owner, sourceFactKey, resolutionKeys);
  }

  return {
    index,
    label,
    normalizedLabel,
    docPath,
    sourceFactKey,
    resolutionKeys,
    resolutionStatuses: resolutions.map((record) => record.status),
    linkedGraphIdentities: linkedGraphIdentities(fact, resolutions),
    signals,
  };
}

function createCluster(
  nodes: readonly ConceptNode[],
  sidecarFreshness: MarkdownConceptSidecarFreshness,
): MarkdownKnowledgeConceptCluster {
  const labels = sortedUnique(nodes.map((node) => node.label));
  const label = selectClusterLabel(nodes);
  const sourceFactKeys = sortedUnique(nodes.map((node) => node.sourceFactKey));
  const resolutionKeys = sortedUnique(nodes.flatMap((node) => node.resolutionKeys));
  const clusterEdgeReasons = clusterReasons(nodes);
  const freshness = conceptFreshness(nodes, sidecarFreshness);
  const authority = conceptAuthority(nodes);

  return {
    id: createConceptId(label, sourceFactKeys, clusterEdgeReasons),
    label,
    aliases: labels.filter((alias) => alias !== label),
    sourceDocuments: sortedUnique(nodes.map((node) => node.docPath).filter(isNonEmptyString)),
    sourceFactKeys,
    resolutionKeys,
    linkedGraphIdentities: sortedGraphIdentities(
      nodes.flatMap((node) => node.linkedGraphIdentities),
    ),
    evidenceClass: 'docs_evidence',
    authority,
    freshness,
    confidence: conceptConfidence(nodes, clusterEdgeReasons),
    clusterEdgeReasons,
  };
}

function groupResolutions(
  resolutions: readonly MarkdownDocResolutionRecord[],
): Map<string, MarkdownDocResolutionRecord[]> {
  const grouped = new Map<string, MarkdownDocResolutionRecord[]>();
  for (const record of resolutions) {
    const list = grouped.get(record.factKey) ?? [];
    list.push(record);
    grouped.set(record.factKey, list);
  }
  for (const list of grouped.values()) {
    list.sort(compareResolutionRecords);
  }
  return grouped;
}

function groupSignals(
  nodes: readonly ConceptNode[],
): Map<string, Array<Signal & { nodeIndex: number }>> {
  const grouped = new Map<string, Array<Signal & { nodeIndex: number }>>();
  for (const node of nodes) {
    for (const signal of node.signals) {
      const key = `${signal.reason}:${signal.value}`;
      const list = grouped.get(key) ?? [];
      list.push({ ...signal, nodeIndex: node.index });
      grouped.set(key, list);
    }
  }
  return grouped;
}

function clusterReasons(nodes: readonly ConceptNode[]): MarkdownConceptClusterEdgeReason[] {
  const grouped = new Map<string, Signal[]>();
  for (const node of nodes) {
    for (const signal of node.signals) {
      const key = `${signal.reason}:${signal.value}`;
      const list = grouped.get(key) ?? [];
      list.push(signal);
      grouped.set(key, list);
    }
  }

  return [...grouped.values()]
    .filter((signals) => new Set(signals.map((signal) => signal.sourceFactKey)).size > 1)
    .map((signals) => ({
      reason: signals[0].reason,
      value: signals[0].value,
      sourceFactKeys: sortedUnique(signals.map((signal) => signal.sourceFactKey)),
      resolutionKeys: sortedUnique(signals.flatMap((signal) => signal.resolutionKeys)),
    }))
    .sort(compareClusterReasons);
}

function selectClusterLabel(nodes: readonly ConceptNode[]): string {
  const counts = new Map<string, { label: string; normalized: string; count: number }>();
  for (const node of nodes) {
    const current = counts.get(node.normalizedLabel) ?? {
      label: node.label,
      normalized: node.normalizedLabel,
      count: 0,
    };
    counts.set(node.normalizedLabel, {
      ...current,
      label: preferLabel(current.label, node.label),
      count: current.count + 1,
    });
  }
  return [...counts.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.label.length !== b.label.length) return a.label.length - b.label.length;
    return a.label.localeCompare(b.label);
  })[0].label;
}

function preferLabel(a: string, b: string): string {
  if (a.length !== b.length) return a.length < b.length ? a : b;
  return a.localeCompare(b) <= 0 ? a : b;
}

function conceptFreshness(
  nodes: readonly ConceptNode[],
  sidecarFreshness: MarkdownConceptSidecarFreshness,
): MarkdownConceptFreshness {
  if (sidecarFreshness === 'stale') return 'stale';
  if (nodes.some((node) => node.resolutionStatuses.includes('stale'))) return 'stale';
  if (sidecarFreshness === 'fresh') return 'fresh';
  return 'unknown';
}

function conceptAuthority(nodes: readonly ConceptNode[]): MarkdownKnowledgeAuthority {
  const hasAuthoritativeLink = nodes.some((node) =>
    node.linkedGraphIdentities.some(
      (identity) => identity.resolutionStatus === 'resolved' && (identity.confidence ?? 0) >= 0.8,
    ),
  );
  return hasAuthoritativeLink ? 'authoritative' : 'advisory';
}

function conceptConfidence(
  nodes: readonly ConceptNode[],
  reasons: readonly MarkdownConceptClusterEdgeReason[],
): MarkdownConceptConfidence {
  const factCount = new Set(nodes.map((node) => node.sourceFactKey)).size;
  const reasonKinds = new Set(reasons.map((reason) => reason.reason)).size;
  const hasLinkedGraphIdentity = nodes.some((node) => node.linkedGraphIdentities.length > 0);
  const hasResolution = nodes.some((node) => node.resolutionKeys.length > 0);
  const score =
    (factCount > 1 ? 1 : 0) +
    (reasonKinds > 1 ? 1 : 0) +
    (hasLinkedGraphIdentity ? 1 : 0) +
    (hasResolution ? 1 : 0);

  if (score >= 3) return 'high';
  if (score >= 1) return 'medium';
  return 'low';
}

function linkedGraphIdentities(
  fact: MarkdownDocumentFact,
  resolutions: readonly MarkdownDocResolutionRecord[],
): MarkdownConceptGraphIdentity[] {
  const identities: MarkdownConceptGraphIdentity[] = [];

  if (fact.kind === 'markdown-api-spec') {
    identities.push({
      type: 'route',
      id: fact.routeKey,
      method: fact.method,
      routePath: fact.path,
    });
  } else if (fact.kind === 'markdown-test-mention' && fact.targetPath !== undefined) {
    identities.push({ type: 'test-file', id: fact.targetPath, filePath: fact.targetPath });
  } else if (fact.kind === 'markdown-code-mention') {
    const type = fact.target.type;
    if (fact.target.id !== undefined) {
      identities.push({ type, id: fact.target.id, filePath: fact.target.filePath });
    } else if (fact.target.filePath !== undefined) {
      identities.push({ type: 'file', id: fact.target.filePath, filePath: fact.target.filePath });
    }
  }

  for (const record of resolutions) {
    const candidates =
      record.targetGraphIdentity !== undefined ? [record.targetGraphIdentity] : record.candidates;
    for (const candidate of candidates) {
      identities.push({
        ...graphIdentityFromCandidate(candidate),
        resolutionStatus: record.status,
        resolutionKey: record.resolutionKey,
      });
    }
  }

  return sortedGraphIdentities(identities);
}

function graphIdentityFromCandidate(
  candidate: GraphIdentityCandidate,
): MarkdownConceptGraphIdentity {
  return {
    type: candidate.type,
    id: candidate.id,
    name: candidate.name,
    filePath: candidate.filePath,
    method: candidate.method,
    routePath: candidate.routePath,
    confidence: candidate.confidence,
    sourceIndexId: candidate.sourceIndexId,
    graphSchemaVersion: candidate.graphSchemaVersion,
  };
}

function factKey(fact: MarkdownDocumentFact): string {
  switch (fact.kind) {
    case 'markdown-chunk':
      return fact.chunkKey;
    case 'markdown-entity':
      return fact.entityKey;
    case 'markdown-code-mention':
      return codeMentionFactKey(fact);
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

function codeMentionFactKey(fact: MarkdownCodeMentionFact): string {
  return [
    'markdown-code-mention',
    fact.chunkKey,
    fact.evidence.lineSpan.start,
    fact.evidence.lineSpan.end,
    fact.evidence.text,
  ].join(':');
}

function factLabel(
  fact: Exclude<MarkdownDocumentFact, { kind: 'markdown-link' }>,
  docPath?: string,
): string {
  switch (fact.kind) {
    case 'markdown-chunk':
      return fact.headingPath.at(-1) ?? basenameConcept(docPath ?? fact.docPath);
    case 'markdown-entity':
      return fact.label;
    case 'markdown-code-mention':
      return fact.evidence.text;
    case 'markdown-requirement':
      return fact.title ?? fact.requirementId;
    case 'markdown-acceptance-criterion':
      return fact.requirementId ?? fact.criterion;
    case 'markdown-api-spec':
      return fact.routeKey;
    case 'markdown-test-mention':
      return fact.mention;
    case 'markdown-doc-owner':
      return fact.owner;
  }
}

function factDocPath(fact: MarkdownDocumentFact, chunk?: MarkdownChunkFact): string | undefined {
  if ('docPath' in fact && typeof fact.docPath === 'string') return fact.docPath;
  return chunk?.docPath;
}

function factHeadingPath(fact: MarkdownDocumentFact, chunk?: MarkdownChunkFact): string[] {
  if ('headingPath' in fact && Array.isArray(fact.headingPath)) return [...fact.headingPath];
  return [...(chunk?.headingPath ?? [])];
}

function sourceChunk(
  fact: MarkdownDocumentFact,
  chunkByKey: ReadonlyMap<string, MarkdownChunkFact>,
): MarkdownChunkFact | undefined {
  if ('sourceChunkKey' in fact && typeof fact.sourceChunkKey === 'string') {
    return chunkByKey.get(fact.sourceChunkKey);
  }
  if (fact.kind === 'markdown-code-mention') {
    return chunkByKey.get(fact.chunkKey);
  }
  if (fact.kind === 'markdown-entity') {
    return chunkByKey.get(fact.sourceChunkKey);
  }
  return undefined;
}

function factEvidenceText(fact: MarkdownDocumentFact): string {
  if ('evidence' in fact && typeof fact.evidence === 'object' && fact.evidence !== null) {
    const text = (fact.evidence as { text?: unknown; raw?: unknown }).text;
    const raw = (fact.evidence as { text?: unknown; raw?: unknown }).raw;
    return typeof text === 'string' ? text : typeof raw === 'string' ? raw : '';
  }
  return '';
}

function factRequirementIds(fact: MarkdownDocumentFact): string[] {
  if (fact.kind === 'markdown-requirement') return [normalizeRequirementId(fact.requirementId)];
  if (fact.kind === 'markdown-acceptance-criterion' && fact.requirementId !== undefined) {
    return [normalizeRequirementId(fact.requirementId)];
  }
  return extractRequirementIds([factEvidenceText(fact)]);
}

function factRoutes(
  fact: MarkdownDocumentFact,
  resolutions: readonly MarkdownDocResolutionRecord[],
): string[] {
  const routes: string[] = [];
  if (fact.kind === 'markdown-api-spec') routes.push(fact.routeKey);
  for (const identity of resolutionCandidates(resolutions)) {
    if (identity.type === 'route') {
      routes.push(
        identity.method !== undefined && identity.routePath !== undefined
          ? `${identity.method} ${identity.routePath}`
          : identity.id,
      );
    }
  }
  return sortedUnique(routes.map(normalizeRoute).filter(isNonEmptyString));
}

function factFiles(
  fact: MarkdownDocumentFact,
  resolutions: readonly MarkdownDocResolutionRecord[],
): string[] {
  const files: string[] = [];
  if (fact.kind === 'markdown-code-mention' && fact.target.filePath !== undefined) {
    files.push(fact.target.filePath);
  } else if (fact.kind === 'markdown-test-mention' && fact.targetPath !== undefined) {
    files.push(fact.targetPath);
  }
  for (const identity of resolutionCandidates(resolutions)) {
    if (identity.filePath !== undefined) files.push(identity.filePath);
    if (
      (identity.type === 'file' || identity.type === 'test-file') &&
      identity.filePath === undefined
    ) {
      files.push(identity.id);
    }
  }
  return sortedUnique(files.map(normalizePathSignal).filter(isNonEmptyString));
}

function factSymbols(
  fact: MarkdownDocumentFact,
  resolutions: readonly MarkdownDocResolutionRecord[],
): string[] {
  const symbols: string[] = [];
  if (fact.kind === 'markdown-code-mention' && fact.target.type === 'symbol') {
    symbols.push(fact.target.id ?? fact.evidence.text);
  }
  for (const identity of resolutionCandidates(resolutions)) {
    if (identity.type === 'symbol') symbols.push(identity.id);
  }
  return sortedUnique(symbols.map(normalizeSymbolSignal).filter(isNonEmptyString));
}

function factOwners(fact: MarkdownDocumentFact): string[] {
  if (fact.kind === 'markdown-doc-owner') return [normalizeOwner(fact.owner)];
  if ('metadata' in fact && hasOwnerMetadata(fact.metadata)) {
    return [normalizeOwner(fact.metadata.owner)];
  }
  return [];
}

function hasOwnerMetadata(value: unknown): value is { owner: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { owner?: unknown }).owner === 'string'
  );
}

function resolutionCandidates(
  resolutions: readonly MarkdownDocResolutionRecord[],
): GraphIdentityCandidate[] {
  return resolutions.flatMap((record) =>
    record.targetGraphIdentity !== undefined ? [record.targetGraphIdentity] : record.candidates,
  );
}

function addSignal(
  signals: Signal[],
  reason: MarkdownConceptClusterEdgeReasonKind,
  value: string | undefined,
  sourceFactKey: string,
  resolutionKeys: readonly string[],
): void {
  if (value === undefined || value.trim().length === 0) return;
  signals.push({
    reason,
    value,
    sourceFactKey,
    resolutionKeys: [...resolutionKeys],
  });
}

function headingSignal(
  docPath: string | undefined,
  headingPath: readonly string[],
): string | undefined {
  if (docPath === undefined || headingPath.length === 0) return undefined;
  return `${normalizePathSignal(docPath)}#${headingPath.map(normalizeConceptLabel).join('/')}`;
}

function extractAdrIds(values: readonly (string | undefined)[]): string[] {
  const ids: string[] = [];
  for (const value of values) {
    if (value === undefined) continue;
    for (const match of value.matchAll(/\bADR[-_\s]?0*(\d{1,5})\b/gi)) {
      ids.push(`ADR-${match[1].padStart(4, '0')}`);
    }
    const pathMatch = value.match(/(?:^|\/)0*(\d{4,5})-[^/]+\.md$/i);
    if (pathMatch !== null) ids.push(`ADR-${pathMatch[1].padStart(4, '0')}`);
  }
  return sortedUnique(ids);
}

function extractRequirementIds(values: readonly string[]): string[] {
  const ids: string[] = [];
  for (const value of values) {
    for (const match of value.matchAll(/\bREQ-[A-Z0-9][A-Z0-9._-]*\b/gi)) {
      ids.push(normalizeRequirementId(match[0]));
    }
  }
  return sortedUnique(ids);
}

function normalizeRequirementId(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeRoute(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizePathSignal(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

function normalizeSymbolSignal(value: string): string {
  return value.trim();
}

function normalizeOwner(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeConceptLabel(value: string): string {
  return normalizeMarkdownAnchor(value);
}

function basenameConcept(path: string): string {
  const basename = path.split('/').at(-1) ?? path;
  return basename.replace(/\.md$/i, '');
}

function createConceptId(
  label: string,
  sourceFactKeys: readonly string[],
  reasons: readonly MarkdownConceptClusterEdgeReason[],
): string {
  const normalizedLabel = normalizeConceptLabel(label) || 'concept';
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        sourceFactKeys,
        reasons: reasons.map((reason) => [reason.reason, reason.value]),
      }),
    )
    .digest('hex')
    .slice(0, 12);
  return `markdown-concept:${normalizedLabel}:${hash}`;
}

function sortedGraphIdentities(
  identities: readonly MarkdownConceptGraphIdentity[],
): MarkdownConceptGraphIdentity[] {
  const byKey = new Map<string, MarkdownConceptGraphIdentity>();
  for (const identity of identities) {
    const key = [
      identity.type,
      identity.id,
      identity.filePath ?? '',
      identity.resolutionKey ?? '',
    ].join(':');
    byKey.set(key, identity);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    if (a.id !== b.id) return a.id.localeCompare(b.id);
    return (a.resolutionKey ?? '').localeCompare(b.resolutionKey ?? '');
  });
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter(isNonEmptyString))].sort();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeSidecarFreshness(
  sidecar: MarkdownConceptSidecarState | undefined,
  factCount: number,
): MarkdownConceptSidecarFreshness {
  if (sidecar?.freshness !== undefined) return sidecar.freshness;
  return factCount === 0 ? 'missing' : 'unknown';
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('maxConcepts must be a positive integer');
  }
  return value;
}

function createWarnings(
  sidecarFreshness: MarkdownConceptSidecarFreshness,
  conceptCount: number,
  maxConcepts: number,
): string[] {
  const warnings: string[] = [];
  if (sidecarFreshness === 'missing') warnings.push('markdown-sidecar-missing');
  if (sidecarFreshness === 'stale') warnings.push('markdown-sidecar-stale');
  if (conceptCount > maxConcepts) warnings.push('markdown-concepts-truncated');
  return warnings;
}

function compareResolutionRecords(
  a: MarkdownDocResolutionRecord,
  b: MarkdownDocResolutionRecord,
): number {
  return a.resolutionKey.localeCompare(b.resolutionKey);
}

function compareClusterReasons(
  a: MarkdownConceptClusterEdgeReason,
  b: MarkdownConceptClusterEdgeReason,
): number {
  if (a.reason !== b.reason) return a.reason.localeCompare(b.reason);
  return a.value.localeCompare(b.value);
}

function compareClusters(
  a: MarkdownKnowledgeConceptCluster,
  b: MarkdownKnowledgeConceptCluster,
): number {
  if (a.label !== b.label) return a.label.localeCompare(b.label);
  return a.id.localeCompare(b.id);
}

class UnionFind {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parents[index];
    if (parent === index) return index;
    const root = this.find(parent);
    this.parents[index] = root;
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    const [parent, child] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
    this.parents[child] = parent;
  }
}
