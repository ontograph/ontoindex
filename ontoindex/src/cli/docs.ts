import os from 'node:os';

import { closeLbug, executeParameterized, initLbug } from '../core/lbug/pool-adapter.js';
import {
  DOCS_REPORT_LIMITS,
  type DocsReportEnvelope,
  type DocsSidecarStatus,
  type SourceIndexIdentity,
} from '../core/ingestion/enrichment/docs-contracts.js';
import {
  createDocsSidecarStatusReport,
  createDocsSourceIndexIdentity,
  createMarkdownSidecarSnapshotManifest,
  createMissingDocsSidecarStatusReport,
  getDocsSidecarStaleReasons,
} from '../core/ingestion/enrichment/docs-sidecar-status.js';
import {
  collectMarkdownSidecarDocuments,
  createMarkdownSidecarScopeHash,
  type CollectedMarkdownSidecarDocuments,
} from '../core/ingestion/enrichment/markdown-sidecar-collector.js';
import {
  createMarkdownDocumentEnrichmentQueueRequest,
  MARKDOWN_DOCUMENT_ANALYZER_ID,
} from '../core/ingestion/enrichment/markdown-sidecar-request.js';
import {
  createMarkdownSidecarRunnerExecutor,
  MARKDOWN_DOCUMENT_DEFAULT_ANALYZER_VERSION,
} from '../core/ingestion/enrichment/markdown-sidecar-runner.js';
import {
  createLocalSidecarRunnerCallbacks,
  runSidecarRunnerOnce,
  type SidecarRunnerOutcome,
} from '../core/ingestion/enrichment/sidecar-runner.js';
import {
  createEmptySidecarStoreState,
  getSidecarStorePath,
  LocalSidecarStore,
  type SidecarStoreState,
} from '../core/ingestion/enrichment/sidecar-store.js';
import type { MarkdownDocumentFact } from '../core/ingestion/enrichment/markdown-document-facts.js';
import {
  createMarkdownRequirementTraceReport,
  type RequirementTraceItem,
} from '../core/ingestion/enrichment/markdown-requirement-trace.js';
import {
  createMarkdownApiDriftReport,
  type ApiDriftItem,
} from '../core/ingestion/enrichment/markdown-api-drift.js';
import {
  createMarkdownKnowledgeReport,
  type MarkdownKnowledgeReportItem,
} from '../core/ingestion/enrichment/markdown-knowledge-report.js';
import { isMarkdownApiSpecFact } from '../core/ingestion/enrichment/markdown-document-facts.js';
import {
  createCodeRouteCandidatesFromAuditRecords,
  createDocRouteCandidates,
  type NormalizedRouteCandidate,
} from '../core/ingestion/enrichment/markdown-route-candidates.js';
import type { RouteDataAuditRecord } from '../core/ingestion/enrichment/route-data-audit.js';
import type { MarkdownDocResolutionRecord } from '../core/ingestion/enrichment/markdown-doc-resolver.js';
import { getCurrentCommit, getGitRoot, isGitRepo } from '../storage/git.js';
import { findRepo, getStoragePaths } from '../storage/repo-manager.js';

function resolveRepoPath(options: { repo?: string }): string | null {
  if (options.repo) {
    return options.repo;
  }
  const cwd = process.cwd();
  if (isGitRepo(cwd)) {
    return getGitRoot(cwd) ?? cwd;
  }
  return null;
}

export const sidecarStatusCommand = async (options: {
  json?: boolean;
  strict?: boolean;
  repo?: string;
}) => {
  const repoPath = resolveRepoPath(options);
  if (!repoPath) {
    console.error('Not a git repository and no --repo specified.');
    process.exit(options.strict ? 1 : 0);
  }

  const repo = await findRepo(repoPath);
  if (!repo) {
    emitReport(createMissingDocsSidecarStatusReport(repoPath), options.json);
    process.exit(options.strict ? 1 : 0);
  }

  const { storagePath } = getStoragePaths(repo.repoPath);
  const store = new LocalSidecarStore(getSidecarStorePath(storagePath));
  const warnings: string[] = [];
  let state: SidecarStoreState;
  try {
    state = await store.load();
  } catch (error) {
    state = createEmptySidecarStoreState();
    warnings.push(`sidecar store unreadable: ${(error as Error).message}`);
  }

  const identity = createDocsSourceIndexIdentity(repo.meta, repo.repoPath);
  const currentCommit = getCurrentCommit(repo.repoPath);
  let manifest;
  if (currentCommit) {
    try {
      const collection = await collectMarkdownSidecarDocuments(repo.repoPath, currentCommit);
      manifest = createMarkdownSidecarSnapshotManifest(identity, collection);
    } catch (error) {
      warnings.push(`markdown manifest unavailable: ${(error as Error).message}`);
    }
  }
  const staleReasons = getDocsSidecarStaleReasons(identity, currentCommit);
  const payload = createDocsSidecarStatusReport(identity, state, staleReasons, warnings, manifest);

  emitReport(payload, options.json);
  exitForStrictStatus(payload.sidecar.status, options.strict);
};

export const sidecarRunCommand = async (
  type: string,
  options: { json?: boolean; repo?: string },
) => {
  if (type !== 'markdown') {
    console.error('Only "markdown" sidecar is supported.');
    process.exit(1);
  }

  const repoPath = resolveRepoPath(options);
  if (!repoPath) {
    console.error('Not a git repository and no --repo specified.');
    process.exit(1);
  }

  const repo = await findRepo(repoPath);
  if (!repo) {
    console.error('Repository not indexed.');
    process.exit(1);
  }

  const currentCommit = getCurrentCommit(repo.repoPath);
  if (!currentCommit) {
    console.error('Failed to get current commit.');
    process.exit(1);
  }

  const identity = createDocsSourceIndexIdentity(repo.meta, repo.repoPath);
  const collection = await collectMarkdownSidecarDocuments(repo.repoPath, currentCommit);
  const manifest = createMarkdownSidecarSnapshotManifest(identity, collection);
  const { storagePath } = getStoragePaths(repo.repoPath);
  const store = new LocalSidecarStore(getSidecarStorePath(storagePath));

  await ensureMarkdownRequest(store, identity, collection);

  const executeRequest = createMarkdownSidecarRunnerExecutor({
    store,
    documents: collection.documents,
    resolveCodeMention: () => undefined,
  });
  const runnerOwnerId = `pid-${process.pid}-${Date.now()}`;
  const callbacks = createLocalSidecarRunnerCallbacks({
    store,
    executeRequest,
    observeThrottle: () => ({
      logicalCpuCount: os.cpus().length,
      observedCpuPercent: 0,
      workerCount: 0,
      foregroundActive: false,
    }),
    ownerId: () => runnerOwnerId,
    pid: () => process.pid,
    now: () => new Date().toISOString(),
  });

  const outcomes: SidecarRunnerOutcome[] = [];
  for (;;) {
    const outcome = await runSidecarRunnerOnce(callbacks, {
      sourceIndexId: identity.sourceIndexId,
      analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
      leaseMs: 30_000,
      staleHeartbeatMs: 60_000,
    });
    outcomes.push(outcome);
    if (!outcome.executed) break;
  }

  const state = await store.load();
  const staleReasons = getDocsSidecarStaleReasons(identity, currentCommit);
  const warnings: string[] = [];
  for (const outcome of outcomes) {
    if (!('reason' in outcome)) continue;
    if (outcome.reason !== 'idle') {
      warnings.push(`sidecar runner stopped: ${outcome.reason}`);
    }
  }
  const payload = {
    ...createDocsSidecarStatusReport(identity, state, staleReasons, warnings, manifest),
    manifest,
  };

  emitReport(payload, options.json);
  if (payload.sidecar.status === 'failed') {
    process.exit(1);
  }
};

export const traceCommand = async (options: {
  requirements?: boolean;
  json?: boolean;
  repo?: string;
  id?: string;
}) => {
  if (!options.requirements) {
    console.error('Only docs trace --requirements is supported.');
    process.exit(1);
  }

  const repoPath = resolveRepoPath(options);
  if (!repoPath) {
    console.error('Not a git repository and no --repo specified.');
    process.exit(1);
  }

  const repo = await findRepo(repoPath);
  if (!repo) {
    const missing = createMissingDocsSidecarStatusReport(repoPath);
    emitReport(
      createMarkdownRequirementTraceReport({
        baseReport: missing,
        facts: [],
        resolutions: [],
        requirementId: options.id,
      }),
      options.json,
    );
    return;
  }

  const { baseReport, state } = await loadDocsSidecarReport(repo.repoPath, repo.meta);
  const facts = collectMarkdownFacts(state);
  const resolutions = collectMarkdownDocResolutionRecords(state);
  const payload = createMarkdownRequirementTraceReport({
    baseReport,
    facts,
    resolutions,
    requirementId: options.id,
  });
  emitReport(payload, options.json);
};

export const driftCommand = async (options: { api?: boolean; json?: boolean; repo?: string }) => {
  if (!options.api) {
    console.error('Only docs drift --api is supported.');
    process.exit(1);
  }

  const repoPath = resolveRepoPath(options);
  if (!repoPath) {
    console.error('Not a git repository and no --repo specified.');
    process.exit(1);
  }

  const repo = await findRepo(repoPath);
  if (!repo) {
    const missing = createMissingDocsSidecarStatusReport(repoPath);
    emitReport(
      createMarkdownApiDriftReport({
        baseReport: missing,
        docCandidates: [],
        codeCandidates: [],
      }),
      options.json,
    );
    return;
  }

  const { baseReport, state } = await loadDocsSidecarReport(repo.repoPath, repo.meta);
  const facts = collectMarkdownFacts(state);
  const docCandidates = createDocRouteCandidates(facts.filter(isMarkdownApiSpecFact));
  const warnings: string[] = [];
  const codeCandidates = await collectCodeRouteCandidates(repo.repoPath, warnings);
  const payload = createMarkdownApiDriftReport({
    baseReport,
    docCandidates,
    codeCandidates,
    warnings,
  });
  emitReport(payload, options.json);
};

export const knowledgeCommand = async (options: {
  json?: boolean;
  repo?: string;
  maxItems?: string | number;
  maxCandidatesPerFact?: string | number;
}) => {
  const repoPath = resolveRepoPath(options);
  if (!repoPath) {
    console.error('Not a git repository and no --repo specified.');
    process.exit(1);
  }

  const maxItems = toBoundedPositiveInteger(options.maxItems, DOCS_REPORT_LIMITS.maxItems);
  const maxCandidatesPerFact = toBoundedPositiveInteger(
    options.maxCandidatesPerFact,
    DOCS_REPORT_LIMITS.maxCandidatesPerFact,
  );

  const repo = await findRepo(repoPath);
  if (!repo) {
    const missing = createMissingDocsSidecarStatusReport(repoPath);
    emitReport(
      createMarkdownKnowledgeReport({
        baseReport: missing,
        facts: [],
        resolutions: [],
        maxItems,
        maxCandidatesPerFact,
      }),
      options.json,
    );
    return;
  }

  const { baseReport, state } = await loadDocsSidecarReport(repo.repoPath, repo.meta);
  const facts = collectMarkdownFacts(state);
  const resolutions = collectMarkdownDocResolutionRecords(state);
  const payload = createMarkdownKnowledgeReport({
    baseReport,
    facts,
    resolutions,
    maxItems,
    maxCandidatesPerFact,
  });
  emitReport(payload, options.json);
};

async function ensureMarkdownRequest(
  store: LocalSidecarStore,
  identity: SourceIndexIdentity,
  collection: CollectedMarkdownSidecarDocuments,
): Promise<void> {
  const state = await store.load();
  const hasActiveMarkdownRequest = state.requests.some(
    (request) =>
      request.sourceIndexId === identity.sourceIndexId &&
      request.analyzerId === MARKDOWN_DOCUMENT_ANALYZER_ID &&
      request.purpose === 'markdown-document-enrichment' &&
      (request.status === 'queued' || request.status === 'running'),
  );
  if (hasActiveMarkdownRequest) return;

  const decision = createMarkdownDocumentEnrichmentQueueRequest({
    enabled: true,
    repoId: identity.repoId,
    sourceIndexId: identity.sourceIndexId,
    scopeHash: collection.scopeHash || createMarkdownSidecarScopeHash(collection.documents),
    requestedAt: new Date().toISOString(),
    analyzerVersion: MARKDOWN_DOCUMENT_DEFAULT_ANALYZER_VERSION,
    priority: 'user-requested',
  });
  if (decision.queued) {
    await store.submitRequest(decision.request);
  }
}

function emitReport(payload: DocsReportEnvelope, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (payload.summary.report === 'requirement-trace') {
    emitRequirementTraceText(payload as DocsReportEnvelope<RequirementTraceItem>);
    return;
  }
  if (payload.summary.report === 'api-drift') {
    emitApiDriftText(payload as DocsReportEnvelope<ApiDriftItem>);
    return;
  }
  if (payload.summary.report === 'knowledge') {
    emitKnowledgeText(payload as DocsReportEnvelope<MarkdownKnowledgeReportItem>);
    return;
  }

  console.log(`Status: ${payload.sidecar.status}`);
  const requests = payload.summary.requests as Record<string, number> | undefined;
  const enrichments = payload.summary.enrichments as Record<string, number> | undefined;
  if (requests) console.log(`Queued: ${requests.queued ?? 0}`);
  if (enrichments) console.log(`Complete: ${enrichments.complete ?? 0}`);
}

async function loadDocsSidecarReport(
  repoPath: string,
  meta: Parameters<typeof createDocsSourceIndexIdentity>[0],
): Promise<{ baseReport: DocsReportEnvelope; state: SidecarStoreState }> {
  const { storagePath } = getStoragePaths(repoPath);
  const store = new LocalSidecarStore(getSidecarStorePath(storagePath));
  const warnings: string[] = [];
  let state: SidecarStoreState;
  try {
    state = await store.load();
  } catch (error) {
    state = createEmptySidecarStoreState();
    warnings.push(`sidecar store unreadable: ${(error as Error).message}`);
  }

  const identity = createDocsSourceIndexIdentity(meta, repoPath);
  const currentCommit = getCurrentCommit(repoPath);
  let manifest;
  if (currentCommit) {
    try {
      const collection = await collectMarkdownSidecarDocuments(repoPath, currentCommit);
      manifest = createMarkdownSidecarSnapshotManifest(identity, collection);
    } catch (error) {
      warnings.push(`markdown manifest unavailable: ${(error as Error).message}`);
    }
  }
  const staleReasons = getDocsSidecarStaleReasons(identity, currentCommit);
  return {
    baseReport: createDocsSidecarStatusReport(identity, state, staleReasons, warnings, manifest),
    state,
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
  repoPath: string,
  warnings: string[],
): Promise<NormalizedRouteCandidate[]> {
  const { lbugPath } = getStoragePaths(repoPath);
  const repoId = repoPath;
  try {
    await initLbug(repoId, lbugPath);
    const rows = await executeParameterized<RouteQueryRow>(
      repoId,
      `
      MATCH (n:Route)
      RETURN n.name AS path, n.filePath AS sourceFile, n.id AS handler
      LIMIT 1000
      `,
      {},
    );
    return createCodeRouteCandidatesFromAuditRecords(rows.map(routeRowToAuditRecord));
  } catch (error) {
    warnings.push(`code route candidates unavailable: ${(error as Error).message}`);
    return [];
  } finally {
    await closeLbug(repoId).catch(() => undefined);
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

function emitRequirementTraceText(payload: DocsReportEnvelope<RequirementTraceItem>): void {
  const summary = payload.summary.requirements as
    | { emitted?: number; matched?: number; byStatus?: Record<string, number> }
    | undefined;
  console.log(`Status: ${payload.sidecar.status}`);
  console.log(
    `Requirements: ${summary?.emitted ?? payload.items.length}/${summary?.matched ?? payload.items.length}`,
  );
  for (const item of payload.items) {
    console.log(`${item.requirementId}: ${item.status} (${item.reason})`);
  }
}

function emitApiDriftText(payload: DocsReportEnvelope<ApiDriftItem>): void {
  const summary = payload.summary.api as
    | { emitted?: number; matched?: number; byStatus?: Record<string, number> }
    | undefined;
  console.log(`Status: ${payload.sidecar.status}`);
  console.log(`API drift: ${summary?.emitted ?? payload.items.length}/${summary?.matched ?? 0}`);
  for (const item of payload.items) {
    console.log(`${item.routeKey}: ${item.status} (${item.reason})`);
  }
}

function emitKnowledgeText(payload: DocsReportEnvelope<MarkdownKnowledgeReportItem>): void {
  const summary = payload.summary.knowledge as
    | {
        totalConcepts?: number;
        emittedConcepts?: number;
        sourceFacts?: number;
        staleConcepts?: number;
        disconnectedConcepts?: number;
        overloadedConcepts?: number;
        orphanAdrLikeConcepts?: number;
        hubConcepts?: number;
        authority?: string;
        diagnosticSidecarStatus?: string;
        suggestedNextChecks?: string[];
      }
    | undefined;
  console.log(`Status: ${payload.sidecar.status}`);
  console.log(`Diagnostic sidecar status: ${summary?.diagnosticSidecarStatus ?? 'partial'}`);
  console.log(
    `Concepts: ${summary?.emittedConcepts ?? payload.items.length}/${summary?.totalConcepts ?? payload.items.length} (${summary?.authority ?? 'advisory'}, facts: ${summary?.sourceFacts ?? 0})`,
  );
  console.log(
    `Flags: stale=${summary?.staleConcepts ?? 0}, disconnected=${summary?.disconnectedConcepts ?? 0}, overloaded=${summary?.overloadedConcepts ?? 0}, orphanAdrLike=${summary?.orphanAdrLikeConcepts ?? 0}, hub=${summary?.hubConcepts ?? 0}`,
  );
  for (const item of payload.items) {
    const flags = knowledgeFlags(item);
    console.log(
      `${item.label}: ${item.freshness}/${item.confidence}/${item.evidenceClass} flags=${flags} docs=${item.metrics.documentCount} facts=${item.metrics.sourceFactCount} links=${item.metrics.linkedGraphIdentityCount}`,
    );
    const rationale = item.rationaleSnippets[0];
    if (rationale) {
      console.log(
        `  rationale: ${formatKnowledgeSource(rationale.docPath, rationale.lineSpan)} ${rationale.excerpt}`,
      );
    }
    const schema = item.schemaEvidence[0];
    if (schema) {
      console.log(
        `  schema: ${schema.routeKey} ${formatKnowledgeSource(schema.docPath, schema.lineSpan)}`,
      );
    }
  }
  if (payload.warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of payload.warnings) console.log(`- ${warning}`);
  }
  const checks = summary?.suggestedNextChecks ?? [];
  if (checks.length > 0) {
    console.log('Suggested checks:');
    for (const check of checks) console.log(`- ${check}`);
  }
}

function formatKnowledgeSource(
  docPath: string | undefined,
  lineSpan: { start: number; end: number } | undefined,
): string {
  const path = docPath ?? 'unknown-doc';
  if (!lineSpan) return path;
  return `${path}:${lineSpan.start}-${lineSpan.end}`;
}

function knowledgeFlags(item: MarkdownKnowledgeReportItem): string {
  const flags = Object.entries(item.flags)
    .filter(([, enabled]) => enabled)
    .map(([flag]) => flag);
  return flags.length > 0 ? flags.join(',') : 'none';
}

function exitForStrictStatus(status: DocsSidecarStatus, strict: boolean | undefined): void {
  if (strict && (status === 'failed' || status === 'stale' || status === 'partial')) {
    process.exit(1);
  }
}

function toBoundedPositiveInteger(
  value: string | number | undefined,
  upperBound: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.min(Math.floor(parsed), upperBound);
}
