import fs from 'node:fs/promises';

import {
  createDocsSidecarStatusReport,
  createDocsSourceIndexIdentity,
  createMissingDocsSidecarStatusReport,
  getDocsSidecarStaleReasons,
} from '../../core/ingestion/enrichment/docs-sidecar-status.js';
import type {
  DocsSidecarStatus,
  SourceIndexIdentity,
} from '../../core/ingestion/enrichment/docs-contracts.js';
import type { EnrichmentRecordStatus } from '../../core/ingestion/enrichment/enrichment-record.js';
import {
  isMarkdownApiSpecFact,
  isMarkdownRequirementFact,
  type MarkdownDocumentFact,
} from '../../core/ingestion/enrichment/markdown-document-facts.js';
import type { MarkdownDocResolutionRecord } from '../../core/ingestion/enrichment/markdown-doc-resolver.js';
import {
  createEmptySidecarStoreState,
  getSidecarStorePath,
  LocalSidecarStore,
  type SidecarStoreState,
} from '../../core/ingestion/enrichment/sidecar-store.js';
import { getCurrentCommit } from '../../storage/git.js';
import { listRegisteredRepos } from '../../storage/repo-manager.js';

export interface AdvisoryDocsEvidenceTarget {
  nodeId?: string;
  name?: string;
  filePath?: string;
  routePath?: string;
  method?: string;
}

export interface AdvisoryDocsEvidenceReport {
  enabled: true;
  sidecar: {
    status: DocsSidecarStatus;
    staleReasons: string[];
    degradedReasons: Record<string, number>;
  };
  freshness: {
    statusCounts: Partial<Record<EnrichmentRecordStatus, number>>;
    stale: boolean;
    reasons: string[];
  };
  docEvidence: Array<{
    kind: 'requirement' | 'api-spec' | 'route-drift' | 'doc-link';
    docPath: string;
    lineSpan?: { start: number; end: number };
    requirementId?: string;
    routeKey?: string;
    method?: string;
    path?: string;
    confidence: number;
    status: string;
    reasons: string[];
    ambiguous: boolean;
    stale: boolean;
  }>;
  relatedDocs: Array<{
    docPath: string;
    evidenceCount: number;
    confidence: number;
    reasons: string[];
    freshness: 'fresh' | 'stale' | 'degraded' | 'missing';
  }>;
  limits: {
    maxEvidence: number;
    maxRelatedDocs: number;
    totalEvidence: number;
    truncated: boolean;
  };
}

interface RepoHandle {
  name: string;
  path: string;
  storagePath: string;
  indexedAt?: string;
  lastCommit?: string;
  stats?: SourceIndexIdentity['graphStats'];
}

const MAX_DOC_EVIDENCE = 12;
const MAX_RELATED_DOCS = 5;

export async function collectAdvisoryDocsEvidence(
  repoId: string,
  targets: readonly AdvisoryDocsEvidenceTarget[],
): Promise<AdvisoryDocsEvidenceReport> {
  const repo = await resolveRepo(repoId);
  if (!repo) return missingReport(repoId, ['repo-not-registered']);

  const loaded = await loadSidecar(repo);
  const statusCounts = countStatuses(loaded.state);
  const records = collectResolutionRecords(loaded.state);
  const facts = new Map(collectMarkdownFacts(loaded.state).map((fact) => [factKey(fact), fact]));
  const targetSet = createTargetSet(targets);
  const matched = records
    .filter((record) => isRelevantResolution(record, targetSet))
    .map((record) => toEvidenceItem(record, facts.get(record.factKey)))
    .filter((item): item is AdvisoryDocsEvidenceReport['docEvidence'][number] => item !== null)
    .sort((a, b) => b.confidence - a.confidence || a.docPath.localeCompare(b.docPath));

  const docEvidence = matched.slice(0, MAX_DOC_EVIDENCE);
  const sidecarStale =
    loaded.base.sidecar.status === 'stale' || loaded.base.sidecar.staleReasons.length > 0;
  const freshnessReasons = [
    ...loaded.base.sidecar.staleReasons,
    ...Object.entries(loaded.base.sidecar.degradedReasons).map(
      ([reason, count]) => `${reason}:${count}`,
    ),
  ];

  return {
    enabled: true,
    sidecar: loaded.base.sidecar,
    freshness: {
      statusCounts,
      stale: sidecarStale || (statusCounts.stale ?? 0) > 0,
      reasons: freshnessReasons,
    },
    docEvidence,
    relatedDocs: summarizeRelatedDocs(docEvidence, loaded.base.sidecar.status),
    limits: {
      maxEvidence: MAX_DOC_EVIDENCE,
      maxRelatedDocs: MAX_RELATED_DOCS,
      totalEvidence: matched.length,
      truncated: matched.length > docEvidence.length,
    },
  };
}

async function resolveRepo(repoId: string): Promise<RepoHandle | null> {
  const repos = await listRegisteredRepos();
  return (
    repos.find((repo) => repo.name === repoId || repo.path === repoId) ??
    repos.find((repo) => repo.name === 'OntoIndex') ??
    null
  );
}

async function loadSidecar(repo: RepoHandle): Promise<{
  base: ReturnType<typeof createMissingDocsSidecarStatusReport>;
  state: SidecarStoreState;
}> {
  const storePath = getSidecarStorePath(repo.storagePath);
  try {
    await fs.access(storePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        base: createMissingDocsSidecarStatusReport(repo.path),
        state: createEmptySidecarStoreState(),
      };
    }
    throw error;
  }

  let state: SidecarStoreState;
  const warnings: string[] = [];
  try {
    state = await new LocalSidecarStore(storePath).load();
  } catch (error) {
    state = createEmptySidecarStoreState();
    warnings.push(`sidecar store unreadable: ${(error as Error).message}`);
  }
  const identity = createDocsSourceIndexIdentity(
    {
      repoPath: repo.path,
      indexedAt: repo.indexedAt ?? '',
      lastCommit: repo.lastCommit ?? '',
      stats: repo.stats,
    },
    repo.path,
  );
  return {
    base: createDocsSidecarStatusReport(
      identity,
      state,
      getDocsSidecarStaleReasons(identity, getCurrentCommit(repo.path)),
      warnings,
    ),
    state,
  };
}

function missingReport(repoId: string, reasons: string[]): AdvisoryDocsEvidenceReport {
  const base = createMissingDocsSidecarStatusReport(repoId);
  return {
    enabled: true,
    sidecar: base.sidecar,
    freshness: { statusCounts: {}, stale: false, reasons },
    docEvidence: [],
    relatedDocs: [],
    limits: {
      maxEvidence: MAX_DOC_EVIDENCE,
      maxRelatedDocs: MAX_RELATED_DOCS,
      totalEvidence: 0,
      truncated: false,
    },
  };
}

function countStatuses(state: SidecarStoreState): Partial<Record<EnrichmentRecordStatus, number>> {
  const counts: Partial<Record<EnrichmentRecordStatus, number>> = {};
  for (const record of state.enrichments) {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
  }
  return counts;
}

function collectMarkdownFacts(state: SidecarStoreState): MarkdownDocumentFact[] {
  return state.enrichments.flatMap((record) =>
    record.records.filter(
      (fact): fact is MarkdownDocumentFact =>
        typeof fact.kind === 'string' &&
        fact.kind.startsWith('markdown-') &&
        fact.kind !== 'markdown-doc-resolution',
    ),
  );
}

function collectResolutionRecords(state: SidecarStoreState): MarkdownDocResolutionRecord[] {
  return state.enrichments.flatMap((record) =>
    record.records.filter(
      (fact): fact is MarkdownDocResolutionRecord => fact.kind === 'markdown-doc-resolution',
    ),
  );
}

function createTargetSet(targets: readonly AdvisoryDocsEvidenceTarget[]): Set<string> {
  const values = new Set<string>();
  for (const target of targets) {
    add(values, 'id', target.nodeId);
    add(values, 'name', target.name);
    add(values, 'file', target.filePath);
    add(values, 'route', target.routePath);
    if (target.method && target.routePath)
      add(values, 'routeKey', `${target.method.toUpperCase()} ${target.routePath}`);
  }
  return values;
}

function isRelevantResolution(record: MarkdownDocResolutionRecord, targets: Set<string>): boolean {
  if (targets.size === 0) return false;
  const identities = [record.targetGraphIdentity, ...record.candidates].filter(Boolean);
  return identities.some(
    (candidate) =>
      targets.has(`id:${candidate.id}`) ||
      targets.has(`name:${candidate.name ?? ''}`) ||
      targets.has(`file:${candidate.filePath ?? ''}`) ||
      targets.has(`route:${candidate.routePath ?? ''}`) ||
      targets.has(`routeKey:${candidate.method ?? ''} ${candidate.routePath ?? ''}`),
  );
}

function toEvidenceItem(
  record: MarkdownDocResolutionRecord,
  fact: MarkdownDocumentFact | undefined,
): AdvisoryDocsEvidenceReport['docEvidence'][number] | null {
  const base = {
    docPath: record.docPath,
    lineSpan: record.lineSpan,
    confidence: record.confidence,
    status: record.status,
    reasons: record.reasons,
    ambiguous: record.status === 'ambiguous' || record.candidates.length > 1,
    stale: record.status === 'stale' || record.reasons.some((reason) => reason.includes('stale')),
  };
  if (fact && isMarkdownRequirementFact(fact)) {
    return { ...base, kind: 'requirement', requirementId: fact.requirementId };
  }
  if (fact && isMarkdownApiSpecFact(fact)) {
    return {
      ...base,
      kind: record.status === 'stale' ? 'route-drift' : 'api-spec',
      routeKey: fact.routeKey,
      method: fact.method,
      path: fact.path,
    };
  }
  return { ...base, kind: 'doc-link' };
}

function summarizeRelatedDocs(
  evidence: AdvisoryDocsEvidenceReport['docEvidence'],
  sidecarStatus: DocsSidecarStatus,
): AdvisoryDocsEvidenceReport['relatedDocs'] {
  const docs = new Map<string, AdvisoryDocsEvidenceReport['relatedDocs'][number]>();
  for (const item of evidence) {
    const existing = docs.get(item.docPath);
    const reasons = [...new Set([...(existing?.reasons ?? []), ...item.reasons])];
    const freshness = item.stale
      ? 'stale'
      : sidecarStatus === 'missing'
        ? 'missing'
        : sidecarStatus === 'partial'
          ? 'degraded'
          : 'fresh';
    docs.set(item.docPath, {
      docPath: item.docPath,
      evidenceCount: (existing?.evidenceCount ?? 0) + 1,
      confidence: Math.max(existing?.confidence ?? 0, item.confidence),
      reasons,
      freshness,
    });
  }
  return [...docs.values()]
    .sort((a, b) => b.confidence - a.confidence || a.docPath.localeCompare(b.docPath))
    .slice(0, MAX_RELATED_DOCS);
}

function factKey(fact: MarkdownDocumentFact): string {
  if (isMarkdownRequirementFact(fact)) return fact.normalizedKey;
  if (isMarkdownApiSpecFact(fact)) return fact.normalizedKey;
  return `${fact.kind}:${'docPath' in fact ? fact.docPath : ''}`;
}

function add(values: Set<string>, prefix: string, value: string | undefined): void {
  if (value) values.add(`${prefix}:${value}`);
}
