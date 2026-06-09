import fs from 'node:fs/promises';
import path from 'node:path';

import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import {
  type DocsReportEnvelope,
  type DocsSidecarStatus,
  type SourceIndexIdentity,
} from '../../core/ingestion/enrichment/docs-contracts.js';
import {
  createDocsSidecarStatusReport,
  createDocsSourceIndexIdentity,
  createMarkdownSidecarSnapshotManifest,
  createMissingDocsSidecarStatusReport,
  getDocsSidecarStaleReasons,
} from '../../core/ingestion/enrichment/docs-sidecar-status.js';
import { isMarkdownApiSpecFact } from '../../core/ingestion/enrichment/markdown-document-facts.js';
import type { MarkdownDocumentFact } from '../../core/ingestion/enrichment/markdown-document-facts.js';
import type { MarkdownDocResolutionRecord } from '../../core/ingestion/enrichment/markdown-doc-resolver.js';
import {
  createMarkdownApiDriftReport,
  type ApiDriftItem,
  type ApiDriftRouteEvidence,
} from '../../core/ingestion/enrichment/markdown-api-drift.js';
import {
  createDocsInlineContextBundle,
  type DocsInlineContextBundle,
  type DocsInlineContextKind,
} from '../../core/ingestion/enrichment/docs-inline-context.js';
import {
  createMarkdownRequirementTraceReport,
  type RequirementTraceImplementationEvidence,
  type RequirementTraceItem,
  type RequirementTraceTestEvidence,
} from '../../core/ingestion/enrichment/markdown-requirement-trace.js';
import {
  createMarkdownKnowledgeReport,
  type MarkdownKnowledgeReportItem,
} from '../../core/ingestion/enrichment/markdown-knowledge-report.js';
import {
  createCodeRouteCandidatesFromAuditRecords,
  createDocRouteCandidates,
} from '../../core/ingestion/enrichment/markdown-route-candidates.js';
import { collectMarkdownSidecarDocuments } from '../../core/ingestion/enrichment/markdown-sidecar-collector.js';
import {
  createEmptySidecarStoreState,
  getSidecarStorePath,
  LocalSidecarStore,
  type SidecarStoreState,
} from '../../core/ingestion/enrichment/sidecar-store.js';
import {
  paginateMcpItems,
  resolveMcpResponseMode,
  shouldExposeCursor,
  type McpResponseCursor,
  type McpResponseMode,
} from '../shared/response-limits.js';
import type { RouteDataAuditRecord } from '../../core/ingestion/enrichment/route-data-audit.js';
import { MEMORIES_DIR, loadMemories } from '../memory-parser.js';
import { getCurrentCommit } from '../../storage/git.js';
import { listRegisteredRepos } from '../../storage/repo-manager.js';
import {
  type BasedOnReadsSummary,
  recordEvidenceReadSafe,
  summarizeBasedOnReads,
} from '../../core/runtime/evidence-read-ledger.js';

export type DocsAction = 'trace' | 'drift' | 'context' | 'readiness';
export type DocsMcpFormat = 'json' | 'inline' | 'both';

export interface DocsMcpParams {
  action?: DocsAction;
  repo?: string;
  id?: string;
  includeMemories?: boolean;
  maxItems?: number;
  limit?: number;
  cursor?: string;
  summary?: boolean;
  minimal?: boolean;
  maxCandidatesPerFact?: number;
  format?: DocsMcpFormat;
  maxTokens?: number;
  maxEvidenceItems?: number;
}

const MAX_DOCS_MCP_ITEMS = 100;
const DEFAULT_DOCS_MCP_ITEMS = 25;
const MAX_DOCS_MCP_CANDIDATES_PER_FACT = 20;
const DEFAULT_INLINE_CONTEXT_TOKENS = 900;
const MAX_INLINE_CONTEXT_TOKENS = 4000;
const DEFAULT_INLINE_CONTEXT_EVIDENCE_ITEMS = 6;
const MAX_INLINE_CONTEXT_EVIDENCE_ITEMS = 50;

export interface DocsMcpFullReport {
  version: 1;
  action: DocsAction;
  report: string;
  responseMode: Exclude<McpResponseMode, 'minimal'>;
  repo: {
    id: string;
    path?: string;
    sourceIndexId?: string;
    indexedAt?: string;
    sourceCommitHash?: string;
  };
  sidecar: {
    status: DocsSidecarStatus;
    staleReasons: string[];
    degradedReasons: Record<string, number>;
  };
  primaryGraphFacts: unknown[];
  docsEvidence: unknown[];
  summary: Record<string, unknown>;
  warnings: string[];
  advisoryMemories?: DocsAdvisoryMemorySummary;
  basedOnReads?: BasedOnReadsSummary;
  limits: {
    truncated: boolean;
    maxItems: number;
    maxCandidatesPerFact: number;
    emitted: number;
    total?: number;
  };
  skipReasons: string[];
  cursor?: McpResponseCursor;
  nextAction?: string;
  inlineContext?: DocsInlineContextBundle;
}

export interface DocsMcpMinimalReport {
  version: 1;
  action: DocsAction;
  report: string;
  responseMode: 'minimal';
  result: {
    sidecarStatus: DocsSidecarStatus;
    skipReasons: string[];
    summary: Record<string, unknown>;
    emitted: number;
    total: number;
    truncated: boolean;
  };
  advisoryMemories?: DocsAdvisoryMemorySummary;
  basedOnReads?: BasedOnReadsSummary;
  cursor?: McpResponseCursor;
  nextAction: string;
}

export type DocsMcpReport = DocsMcpFullReport | DocsMcpMinimalReport;

type DocsEnvelope = DocsReportEnvelope;

interface DocsRepoHandle {
  id: string;
  name: string;
  repoPath: string;
  storagePath: string;
  indexedAt?: string;
  lastCommit?: string;
  stats?: SourceIndexIdentity['graphStats'];
}

interface LoadedDocsSidecar {
  baseReport: DocsReportEnvelope;
  state: SidecarStoreState;
  storeMissing: boolean;
}

interface DocsAdvisoryMemorySummary {
  boundary: 'advisory-only';
  note: string;
  availability: {
    status: 'missing' | 'empty' | 'available';
    directory: typeof MEMORIES_DIR;
    total: number;
  };
  validity: {
    valid: number;
    invalid: number;
  };
  freshness: {
    fresh: number;
    'stale-index': number;
    unknown: number;
    invalid: number;
  };
}

export async function gnDocs(repoId: string, params: DocsMcpParams): Promise<DocsMcpReport> {
  const repo = await resolveRepoHandle(repoId, params.repo);
  return runDocsMcpAction(repo, params);
}

export async function runDocsMcpAction(
  repo: DocsRepoHandle,
  params: DocsMcpParams,
): Promise<DocsMcpReport> {
  const action = params.action ?? 'readiness';
  const responseMode = resolveMcpResponseMode(params);
  const loaded = await loadDocsSidecar(repo);
  const advisoryMemories =
    params.includeMemories && (action === 'context' || action === 'readiness')
      ? await summarizeAdvisoryMemories(repo)
      : undefined;
  const maxItems = normalizePositiveInt(
    params.maxItems ?? params.limit,
    DEFAULT_DOCS_MCP_ITEMS,
    MAX_DOCS_MCP_ITEMS,
  );
  const maxCandidatesPerFact = normalizePositiveInt(
    params.maxCandidatesPerFact,
    loaded.baseReport.limits.maxCandidatesPerFact,
    MAX_DOCS_MCP_CANDIDATES_PER_FACT,
  );

  recordEvidenceReadSafe({
    readClass: 'docs_evidence',
    surface: 'mcp',
    tool: 'gn_docs',
    target: action,
    targetType: 'action',
    repo: repo.id,
  });

  if (action === 'readiness') {
    if (responseMode === 'minimal') {
      return createMinimalDocsReport(
        action,
        loaded.baseReport,
        loaded.storeMissing,
        {
          emitted: 0,
          total: 0,
          truncated: false,
        },
        undefined,
        undefined,
        advisoryMemories,
      );
    }
    return withInlineContext(
      compactDocsEnvelope(action, loaded.baseReport, [], loaded.storeMissing, [], {
        maxItems,
        maxCandidatesPerFact,
        responseMode,
        nextAction: createDocsNextAction(action, loaded.baseReport, undefined, loaded.storeMissing),
        advisoryMemories,
      }),
      params,
    );
  }

  if (action === 'context') {
    const knowledgeMaxItems = createKnowledgeContextDerivationLimit(maxItems, params.cursor);
    const report = createKnowledgeContextEnvelope(
      createMarkdownKnowledgeReport({
        baseReport: loaded.baseReport,
        facts: collectMarkdownFacts(loaded.state),
        resolutions: collectMarkdownDocResolutionRecords(loaded.state),
        maxItems: knowledgeMaxItems,
        maxCandidatesPerFact,
      }),
      loaded.baseReport,
    );
    return finalizeDocsItemsReport(
      action,
      report,
      loaded.storeMissing,
      params,
      responseMode,
      maxItems,
      maxCandidatesPerFact,
      compactKnowledgeItem,
      summarizeKnowledgeItem,
      extractKnowledgeGraphFacts,
      advisoryMemories,
    );
  }

  if (loaded.storeMissing) {
    if (responseMode === 'minimal') {
      return createMinimalDocsReport(action, loaded.baseReport, true, {
        emitted: 0,
        total: 0,
        truncated: false,
      });
    }
    return withInlineContext(
      compactDocsEnvelope(action, loaded.baseReport, [], true, [], {
        maxItems,
        maxCandidatesPerFact,
        responseMode,
        nextAction: createDocsNextAction(action, loaded.baseReport, undefined, true),
      }),
      params,
    );
  }

  if (action === 'trace') {
    recordEvidenceReadSafe({
      readClass: 'docs_evidence',
      surface: 'mcp',
      tool: 'gn_docs',
      target: params.id || 'trace',
      targetType: params.id ? 'requirement_id' : 'action',
      repo: repo.id,
    });
    const report = createMarkdownRequirementTraceReport({
      baseReport: loaded.baseReport,
      facts: collectMarkdownFacts(loaded.state),
      resolutions: collectMarkdownDocResolutionRecords(loaded.state),
      requirementId: params.id,
      maxItems: Number.MAX_SAFE_INTEGER,
      maxCandidatesPerFact,
    });
    return finalizeDocsItemsReport(
      action,
      report,
      loaded.storeMissing,
      params,
      responseMode,
      maxItems,
      maxCandidatesPerFact,
      compactTraceItem,
      summarizeTraceItem,
      extractTraceGraphFacts,
    );
  }

  const warnings: string[] = [];
  recordEvidenceReadSafe({
    readClass: 'docs_evidence',
    surface: 'mcp',
    tool: 'gn_docs',
    target: 'drift',
    targetType: 'action',
    repo: repo.id,
  });
  const facts = collectMarkdownFacts(loaded.state);
  const report = createMarkdownApiDriftReport({
    baseReport: loaded.baseReport,
    docCandidates: createDocRouteCandidates(facts.filter(isMarkdownApiSpecFact)),
    codeCandidates: createCodeRouteCandidatesFromAuditRecords(
      await collectCodeRouteCandidates(repo.id, warnings),
    ),
    warnings,
    maxItems: Number.MAX_SAFE_INTEGER,
    maxCandidatesPerFact,
  });
  return finalizeDocsItemsReport(
    action,
    report,
    loaded.storeMissing,
    params,
    responseMode,
    maxItems,
    maxCandidatesPerFact,
    compactDriftItem,
    summarizeDriftItem,
    extractDriftGraphFacts,
  );
}

async function loadDocsSidecar(repo: DocsRepoHandle): Promise<LoadedDocsSidecar> {
  const storePath = getSidecarStorePath(repo.storagePath);
  let storeMissing = false;
  try {
    await fs.access(storePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') storeMissing = true;
    else throw error;
  }

  if (storeMissing) {
    return {
      baseReport: createMissingDocsSidecarStatusReport(repo.repoPath),
      state: createEmptySidecarStoreState(),
      storeMissing,
    };
  }

  const warnings: string[] = [];
  let state: SidecarStoreState;
  try {
    state = await new LocalSidecarStore(storePath).load();
  } catch (error) {
    state = createEmptySidecarStoreState();
    warnings.push(`sidecar store unreadable: ${(error as Error).message}`);
  }

  const identity = createDocsSourceIndexIdentity(
    {
      repoPath: repo.repoPath,
      indexedAt: repo.indexedAt ?? '',
      lastCommit: repo.lastCommit ?? '',
      stats: repo.stats,
    },
    repo.repoPath,
  );

  const manifest = await createManifest(identity, repo.repoPath, warnings);

  // Persist the manifest so export and other flows can reuse it without rescanning
  if (manifest) {
    try {
      await new LocalSidecarStore(storePath).setManifest(manifest);
      state.manifest = manifest;
    } catch {
      // best-effort: manifest is already built and usable; persistence failure is non-fatal
    }
  }

  const result: LoadedDocsSidecar = {
    baseReport: createDocsSidecarStatusReport(
      identity,
      state,
      getDocsSidecarStaleReasons(identity, getCurrentCommit(repo.repoPath)),
      warnings,
      manifest,
    ),
    state,
    storeMissing,
  };

  recordEvidenceReadSafe({
    readClass: 'docs_evidence',
    surface: 'gn_docs:load_sidecar',
    target: storePath,
    targetType: 'sidecar_store',
    repo: repo.id,
    tool: 'gn_docs',
  });

  return result;
}

async function createManifest(
  identity: SourceIndexIdentity,
  repoPath: string,
  warnings: string[],
): Promise<DocsReportEnvelope['manifest']> {
  const currentCommit = getCurrentCommit(repoPath);
  if (!currentCommit) return undefined;
  try {
    return createMarkdownSidecarSnapshotManifest(
      identity,
      await collectMarkdownSidecarDocuments(repoPath, currentCommit),
    );
  } catch (error) {
    warnings.push(`markdown manifest unavailable: ${(error as Error).message}`);
    return undefined;
  }
}

function compactDocsEnvelope(
  action: DocsAction,
  envelope: DocsEnvelope,
  docsEvidence: unknown[],
  storeMissing: boolean,
  primaryGraphFacts: unknown[] = [],
  limits?: {
    maxItems: number;
    maxCandidatesPerFact: number;
    emitted?: number;
    total?: number;
    truncated?: boolean;
    responseMode?: Exclude<McpResponseMode, 'minimal'>;
    cursor?: McpResponseCursor;
    nextAction?: string;
    advisoryMemories?: DocsAdvisoryMemorySummary;
  },
): DocsMcpFullReport {
  return {
    version: 1,
    action,
    report: reportName(action, envelope),
    responseMode: limits?.responseMode ?? 'full',
    repo: {
      id: envelope.repo.id,
      path: envelope.repo.path,
      sourceIndexId: envelope.repo.sourceIndexId,
      indexedAt: envelope.repo.indexedAt,
      sourceCommitHash: envelope.repo.sourceCommitHash,
    },
    sidecar: {
      status: envelope.sidecar.status,
      staleReasons: envelope.sidecar.staleReasons,
      degradedReasons: envelope.sidecar.degradedReasons,
    },
    primaryGraphFacts,
    docsEvidence,
    summary: envelope.summary,
    warnings: envelope.warnings,
    ...(limits?.advisoryMemories ? { advisoryMemories: limits.advisoryMemories } : {}),
    basedOnReads: summarizeBasedOnReads(),
    limits: {
      truncated: limits?.truncated ?? envelope.limits.truncated,
      maxItems: limits?.maxItems ?? envelope.limits.maxItems,
      maxCandidatesPerFact: limits?.maxCandidatesPerFact ?? envelope.limits.maxCandidatesPerFact,
      emitted: limits?.emitted ?? docsEvidence.length,
      total: limits?.total ?? readTotal(envelope),
    },
    skipReasons: createSkipReasons(
      envelope.sidecar.status,
      envelope.sidecar.staleReasons,
      storeMissing,
    ),
    ...(limits?.cursor ? { cursor: limits.cursor } : {}),
    ...(limits?.nextAction ? { nextAction: limits.nextAction } : {}),
  };
}

function extractTraceGraphFacts(items: readonly RequirementTraceItem[]): unknown[] {
  return items.flatMap((item) => [
    ...item.implementationEvidence.flatMap((evidence) =>
      compactGraphCandidates(
        item.requirementId,
        evidence.factKey,
        evidence.target,
        evidence.candidates,
      ),
    ),
    ...item.tests.flatMap((evidence) =>
      compactGraphCandidates(
        item.requirementId,
        evidence.mention,
        evidence.target,
        evidence.candidates,
      ),
    ),
  ]);
}

function extractDriftGraphFacts(items: readonly ApiDriftItem[]): unknown[] {
  return items.flatMap((item) =>
    item.code.map((evidence) => ({
      kind: 'code-route',
      routeKey: item.routeKey,
      method: evidence.method,
      path: evidence.path,
      filePath: evidence.filePath,
      id: evidence.id,
      framework: evidence.framework,
      confidence: evidence.confidence,
      state: evidence.state,
      ambiguous: evidence.ambiguous,
      unsupported: evidence.unsupported,
    })),
  );
}

function extractKnowledgeGraphFacts(_items: readonly MarkdownKnowledgeReportItem[]): unknown[] {
  return [];
}

function createKnowledgeContextDerivationLimit(maxItems: number, cursor?: string): number {
  if (!cursor) return maxItems + 1;
  const match = /^gn-page-v1:(\d+):(\d+)$/.exec(cursor);
  if (!match) return maxItems + 1;
  const [, pageSizeText, offsetText] = match;
  const pageSize = normalizePositiveInt(
    Number.parseInt(pageSizeText, 10),
    maxItems,
    MAX_DOCS_MCP_ITEMS,
  );
  const offset = normalizePositiveInt(Number.parseInt(offsetText, 10), 0, MAX_DOCS_MCP_ITEMS);
  return Math.min(offset + pageSize + 1, MAX_DOCS_MCP_ITEMS + 1);
}

function compactGraphCandidates(
  requirementId: string,
  factKey: string,
  target: unknown,
  candidates: readonly unknown[],
): unknown[] {
  const facts: unknown[] = candidates.map((candidate) => ({
    kind: 'graph-candidate',
    requirementId,
    factKey,
    candidate,
  }));
  if (target) {
    facts.unshift({
      kind: 'graph-target',
      requirementId,
      factKey,
      target,
    });
  }
  return facts;
}

function compactTraceItem(item: RequirementTraceItem): Record<string, unknown> {
  return {
    requirementId: item.requirementId,
    title: item.title,
    status: item.status,
    reason: item.reason,
    confidence: item.confidence,
    evidenceClasses: item.evidenceClasses,
    docs: item.docs.map((doc) => ({
      path: doc.docPath,
      lineSpan: doc.lineSpan,
      headingPath: doc.headingPath,
      source: doc.source,
    })),
    acceptanceCriteria: item.acceptanceCriteria.length,
    implementationEvidence: item.implementationEvidence.map(compactImplementationEvidence),
    tests: item.tests.map(compactTestEvidence),
    suggestedActions: item.suggestedActions,
  };
}

function summarizeTraceItem(item: RequirementTraceItem): Record<string, unknown> {
  return {
    requirementId: item.requirementId,
    title: item.title,
    status: item.status,
    reason: item.reason,
    confidence: item.confidence,
    evidenceClasses: item.evidenceClasses,
    docCount: item.docs.length,
    acceptanceCriteriaCount: item.acceptanceCriteria.length,
    implementationEvidenceCount: item.implementationEvidence.length,
    testCount: item.tests.length,
    suggestedActions: item.suggestedActions,
  };
}

function compactImplementationEvidence(
  evidence: RequirementTraceImplementationEvidence,
): Record<string, unknown> {
  return {
    kind: evidence.kind,
    status: evidence.status,
    evidenceKind: evidence.evidenceKind,
    docPath: evidence.docPath,
    factKey: evidence.factKey,
    confidence: evidence.confidence,
    target: evidence.target,
    candidates: evidence.candidates,
    candidateCount: evidence.candidates.length,
    reasons: evidence.reasons,
  };
}

function compactTestEvidence(evidence: RequirementTraceTestEvidence): Record<string, unknown> {
  return {
    mention: evidence.mention,
    status: evidence.status,
    docPath: evidence.docPath,
    lineSpan: evidence.lineSpan,
    confidence: evidence.confidence,
    targetPath: evidence.targetPath,
    target: evidence.target,
    candidates: evidence.candidates,
    candidateCount: evidence.candidates.length,
    reasons: evidence.reasons,
  };
}

function compactDriftItem(item: ApiDriftItem): Record<string, unknown> {
  return {
    routeKey: item.routeKey,
    status: item.status,
    method: item.method,
    path: item.path,
    reason: item.reason,
    confidence: item.confidence,
    docs: item.docs.map(compactRouteEvidence),
    code: item.code.map(compactRouteEvidence),
    suggestedActions: item.suggestedActions,
  };
}

function createKnowledgeContextEnvelope(
  report: DocsReportEnvelope<MarkdownKnowledgeReportItem>,
  baseReport: DocsEnvelope,
): DocsReportEnvelope<MarkdownKnowledgeReportItem> {
  const summary = { ...baseReport.summary };
  const knowledge = report.summary.knowledge;
  if (knowledge !== undefined) summary.knowledge = knowledge;
  return {
    ...report,
    summary,
  };
}

function compactKnowledgeItem(item: MarkdownKnowledgeReportItem): Record<string, unknown> {
  return {
    kind: 'knowledge-concept',
    conceptId: item.conceptId,
    label: item.label,
    aliases: item.aliases,
    sourceDocuments: item.sourceDocuments,
    sourceFactKeys: item.sourceFactKeys,
    resolutionKeys: item.resolutionKeys,
    linkedGraphIdentities: item.linkedGraphIdentities,
    evidenceClass: item.evidenceClass,
    authority: item.authority,
    freshness: item.freshness,
    confidence: item.confidence,
    clusterEdgeReasons: item.clusterEdgeReasons,
    suggestedNextChecks: item.suggestedNextChecks,
    metrics: item.metrics,
    flags: item.flags,
    bounds: item.bounds,
  };
}

function summarizeKnowledgeItem(item: MarkdownKnowledgeReportItem): Record<string, unknown> {
  return {
    kind: 'knowledge-concept',
    conceptId: item.conceptId,
    label: item.label,
    evidenceClass: item.evidenceClass,
    authority: item.authority,
    freshness: item.freshness,
    confidence: item.confidence,
    documentCount: item.metrics.documentCount,
    sourceFactCount: item.metrics.sourceFactCount,
    resolutionCount: item.metrics.resolutionCount,
    linkedGraphIdentityCount: item.metrics.linkedGraphIdentityCount,
    emittedGraphIdentityCount: item.metrics.emittedGraphIdentityCount,
    flags: item.flags,
    suggestedNextChecks: item.suggestedNextChecks,
  };
}

function summarizeDriftItem(item: ApiDriftItem): Record<string, unknown> {
  return {
    routeKey: item.routeKey,
    status: item.status,
    method: item.method,
    path: item.path,
    reason: item.reason,
    confidence: item.confidence,
    docCount: item.docs.length,
    codeCount: item.code.length,
    suggestedActions: item.suggestedActions,
  };
}

function compactRouteEvidence(evidence: ApiDriftRouteEvidence): Record<string, unknown> {
  return {
    source: evidence.source,
    method: evidence.method,
    path: evidence.path,
    confidence: evidence.confidence,
    state: evidence.state,
    id: evidence.id,
    filePath: evidence.filePath,
    lineSpan: evidence.lineSpan,
    framework: evidence.framework,
    unsupported: evidence.unsupported,
    ambiguous: evidence.ambiguous,
    normalizationReasons: evidence.normalizationReasons,
  };
}

function collectMarkdownFacts(state: SidecarStoreState): MarkdownDocumentFact[] {
  return state.enrichments.flatMap((record) =>
    record.records.filter((fact): fact is MarkdownDocumentFact => isMarkdownDocumentFact(fact)),
  );
}

function collectMarkdownDocResolutionRecords(
  state: SidecarStoreState,
): MarkdownDocResolutionRecord[] {
  return state.enrichments.flatMap((record) =>
    record.records.filter((fact): fact is MarkdownDocResolutionRecord =>
      isMarkdownDocResolutionRecord(fact),
    ),
  );
}

function isMarkdownDocumentFact(value: { kind: string }): value is MarkdownDocumentFact {
  return value.kind.startsWith('markdown-') && value.kind !== 'markdown-doc-resolution';
}

function isMarkdownDocResolutionRecord(value: {
  kind: string;
}): value is MarkdownDocResolutionRecord {
  return value.kind === 'markdown-doc-resolution';
}

async function collectCodeRouteCandidates(
  repoId: string,
  warnings: string[],
): Promise<RouteDataAuditRecord[]> {
  try {
    const rows = await executeParameterized<RouteQueryRow>(
      repoId,
      `
      MATCH (n:Route)
      RETURN n.name AS path, n.filePath AS sourceFile, n.id AS handler
      LIMIT 1000
      `,
      {},
    );
    recordEvidenceReadSafe({
      readClass: 'graph_evidence',
      surface: 'gn_docs:collect_code_routes',
      target: 'Route LIMIT 1000',
      targetType: 'route_query',
      repo: repoId,
      tool: 'gn_docs',
    });
    return rows.map(routeRowToAuditRecord);
  } catch (error) {
    warnings.push(`code route candidates unavailable: ${(error as Error).message}`);
    return [];
  }
}

interface RouteQueryRow {
  readonly [key: string]: unknown;
  readonly [index: number]: unknown;
  readonly path?: string;
  readonly sourceFile?: string;
  readonly handler?: string;
}

function routeRowToAuditRecord(row: RouteQueryRow): RouteDataAuditRecord {
  const routePath = rowValue(row, 'path', 0);
  const sourceFile = rowValue(row, 'sourceFile', 1);
  const handler = rowValue(row, 'handler', 2);
  return {
    ...(routePath ? { path: routePath } : {}),
    ...(sourceFile ? { sourceFile, handler: sourceFile } : handler ? { handler } : {}),
    source: 'route-node',
  };
}

function rowValue(row: RouteQueryRow, key: string, index: number): string | undefined {
  const value = row[key] ?? row[index] ?? row[String(index)];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function resolveRepoHandle(repoId: string, requestedRepo?: string): Promise<DocsRepoHandle> {
  const repos = await listRegisteredRepos();
  const repo = repos.find(
    (entry) =>
      entry.name === repoId ||
      entry.path === repoId ||
      entry.name === requestedRepo ||
      entry.path === requestedRepo,
  );
  if (!repo) throw new Error(`Repository not found: ${requestedRepo ?? repoId}`);
  return {
    id: repo.name,
    name: repo.name,
    repoPath: repo.path,
    storagePath: repo.storagePath,
    indexedAt: repo.indexedAt,
    lastCommit: repo.lastCommit,
    stats: repo.stats,
  };
}

function createSkipReasons(
  status: DocsSidecarStatus,
  staleReasons: readonly string[],
  storeMissing: boolean,
): string[] {
  const reasons = new Set<string>();
  if (storeMissing || status === 'missing') reasons.add('sidecar-missing');
  if (status === 'stale' || staleReasons.length > 0) reasons.add('sidecar-stale');
  if (status === 'partial') reasons.add('sidecar-partial');
  if (status === 'failed') reasons.add('sidecar-failed');
  if (status === 'queued' || status === 'running') reasons.add(`sidecar-${status}`);
  return [...reasons];
}

function readTotal(envelope: DocsEnvelope): number | undefined {
  const requirements = envelope.summary.requirements;
  if (isRecord(requirements) && typeof requirements.matched === 'number')
    return requirements.matched;
  const api = envelope.summary.api;
  if (isRecord(api) && typeof api.matched === 'number') return api.matched;
  return undefined;
}

function reportName(action: DocsAction, envelope: DocsEnvelope): string {
  return typeof envelope.summary.report === 'string' ? envelope.summary.report : `docs-${action}`;
}

function withInlineContext(report: DocsMcpReport, params: DocsMcpParams): DocsMcpReport {
  if (report.responseMode === 'minimal') return report;
  if (params.format !== 'inline' && params.format !== 'both') return report;
  return {
    ...report,
    inlineContext: createDocsInlineContextBundle({
      kind: docsActionToInlineKind(report.action),
      report: report as unknown as Record<string, unknown>,
      maxTokens: normalizePositiveInt(
        params.maxTokens,
        DEFAULT_INLINE_CONTEXT_TOKENS,
        MAX_INLINE_CONTEXT_TOKENS,
      ),
      maxEvidenceItems: normalizePositiveInt(
        params.maxEvidenceItems,
        DEFAULT_INLINE_CONTEXT_EVIDENCE_ITEMS,
        MAX_INLINE_CONTEXT_EVIDENCE_ITEMS,
      ),
    }),
  };
}

function docsActionToInlineKind(action: DocsAction): DocsInlineContextKind {
  if (action === 'readiness') return 'edit-readiness';
  return action;
}

function finalizeDocsItemsReport<TItem>(
  action: DocsAction,
  envelope: DocsReportEnvelope<TItem>,
  storeMissing: boolean,
  params: DocsMcpParams,
  responseMode: McpResponseMode,
  maxItems: number,
  maxCandidatesPerFact: number,
  toFullItem: (item: TItem) => Record<string, unknown>,
  toSummaryItem: (item: TItem) => Record<string, unknown>,
  extractGraphFacts: (items: readonly TItem[]) => unknown[],
  advisoryMemories?: DocsAdvisoryMemorySummary,
): DocsMcpReport {
  const page = paginateMcpItems(envelope.items, { pageSize: maxItems, cursor: params.cursor });
  const cursor = shouldExposeCursor(page.page) ? page.page : undefined;
  const truncated = page.page.offset > 0 || page.page.hasMore;
  const nextAction = createDocsNextAction(action, envelope, cursor, storeMissing);

  if (responseMode === 'minimal') {
    return createMinimalDocsReport(
      action,
      envelope,
      storeMissing,
      {
        emitted: page.page.returned,
        total: envelope.items.length,
        truncated,
      },
      cursor,
      nextAction,
      advisoryMemories,
    );
  }

  const docsEvidence = page.items.map(responseMode === 'summary' ? toSummaryItem : toFullItem);
  const primaryGraphFacts = responseMode === 'summary' ? [] : extractGraphFacts(page.items);
  return withInlineContext(
    compactDocsEnvelope(action, envelope, docsEvidence, storeMissing, primaryGraphFacts, {
      maxItems: page.page.pageSize,
      maxCandidatesPerFact,
      emitted: page.page.returned,
      total: envelope.items.length,
      truncated,
      responseMode,
      cursor,
      nextAction,
      advisoryMemories,
    }),
    params,
  );
}

function createDocsNextAction(
  action: DocsAction,
  envelope: DocsEnvelope,
  cursor: McpResponseCursor | undefined,
  storeMissing: boolean,
): string {
  if (cursor?.next) return `Rerun ${action} with cursor:"${cursor.next}" to fetch the next page.`;
  const skipReasons = createSkipReasons(
    envelope.sidecar.status,
    envelope.sidecar.staleReasons,
    storeMissing,
  );
  if (skipReasons.includes('sidecar-missing')) {
    return 'Markdown docs sidecar is missing; run `ontoindex docs refresh` or `ontoindex analyze --markdown-sidecar` before relying on this report.';
  }
  if (skipReasons.includes('sidecar-stale') || skipReasons.includes('sidecar-partial')) {
    return 'Run `ontoindex docs refresh` (or `ontoindex analyze --markdown-sidecar`) before using this report for write decisions.';
  }
  if (envelope.warnings.length > 0) return 'Review warnings before acting on this report.';
  return 'No follow-up required.';
}

function createMinimalDocsReport(
  action: DocsAction,
  envelope: DocsEnvelope,
  storeMissing: boolean,
  limits: { emitted: number; total: number; truncated: boolean },
  cursor?: McpResponseCursor,
  nextAction = createDocsNextAction(action, envelope, cursor, storeMissing),
  advisoryMemories?: DocsAdvisoryMemorySummary,
): DocsMcpMinimalReport {
  return {
    version: 1,
    action,
    report: reportName(action, envelope),
    responseMode: 'minimal',
    result: {
      sidecarStatus: envelope.sidecar.status,
      skipReasons: createSkipReasons(
        envelope.sidecar.status,
        envelope.sidecar.staleReasons,
        storeMissing,
      ),
      summary: envelope.summary,
      emitted: limits.emitted,
      total: limits.total,
      truncated: limits.truncated,
    },
    ...(advisoryMemories ? { advisoryMemories } : {}),
    basedOnReads: summarizeBasedOnReads(),
    ...(cursor ? { cursor } : {}),
    nextAction,
  };
}

async function summarizeAdvisoryMemories(repo: DocsRepoHandle): Promise<DocsAdvisoryMemorySummary> {
  const memoriesDir = path.resolve(repo.repoPath, MEMORIES_DIR);
  let availability: DocsAdvisoryMemorySummary['availability']['status'] = 'missing';
  try {
    await fs.access(memoriesDir);
    availability = 'empty';
  } catch {
    availability = 'missing';
  }

  const memories = availability === 'missing' ? [] : await loadMemories(repo.repoPath);
  if (memories.length > 0) {
    availability = 'available';
  }

  const validity = memories.reduce(
    (counts, memory) => {
      if (memory.valid) counts.valid += 1;
      else counts.invalid += 1;
      return counts;
    },
    { valid: 0, invalid: 0 },
  );
  const freshness = memories.reduce(
    (counts, memory) => {
      if (!memory.valid) {
        counts.invalid += 1;
        return counts;
      }
      switch (memory.frontMatter.freshness) {
        case 'fresh':
          counts.fresh += 1;
          return counts;
        case 'stale-index':
          counts['stale-index'] += 1;
          return counts;
        case 'unknown':
          counts.unknown += 1;
          return counts;
        default:
          counts.invalid += 1;
          return counts;
      }
    },
    { fresh: 0, 'stale-index': 0, unknown: 0, invalid: 0 },
  );

  const result: DocsAdvisoryMemorySummary = {
    boundary: 'advisory-only',
    note: 'Advisory memories are separate from docs evidence, trace/drift items, graph facts, and readiness decisions.',
    availability: {
      status: availability,
      directory: MEMORIES_DIR,
      total: memories.length,
    },
    validity,
    freshness,
  };

  const aggregateFreshness =
    freshness['stale-index'] > 0 ? 'stale' : freshness.invalid > 0 ? 'invalid' : 'fresh';

  recordEvidenceReadSafe({
    readClass: 'advisory_memory',
    surface: 'gn_docs:summarize_advisory_memories',
    target: memoriesDir,
    targetType: 'directory',
    repo: repo.id,
    tool: 'gn_docs',
    notAuditEvidence: true,
    memoryFreshness: aggregateFreshness === 'stale' ? 'stale-index' : aggregateFreshness,
  });

  return result;
}

function normalizePositiveInt(value: unknown, fallback: number, max: number): number {
  const normalized =
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
  return Math.min(normalized, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
