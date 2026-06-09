/**
 * Local Backend (Multi-Repo)
 *
 * Provides tool implementations using local .ontoindex/ indexes.
 * Supports multiple indexed repositories via a global registry.
 * LadybugDB connections are opened lazily per repo on first query.
 */

import path from 'path';
import fs from 'fs/promises';
import { RepoHandle, BackendPort } from 'ontoindex-shared';
import { recordToolCall } from './tool-telemetry.js';
import { guardResponseSize } from './response-guard.js';
import {
  initLbug,
  closeLbug,
  isLbugReady,
  isLbugDbPathReady,
} from '../../core/lbug/pool-adapter.js';
export { isWriteQuery } from '../../core/lbug/pool-adapter.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at MCP server startup — crashes on unsupported Node ABI versions (#89)
// git utilities available if needed
// import { isGitRepo, getCurrentCommit, getGitRoot } from '../../storage/git.js';
import { listRegisteredRepos, type RegistryEntry } from '../../storage/repo-manager.js';
import {
  appendIndexCapabilityWarnings,
  loadIndexCapabilityWarnings,
} from '../../storage/index-capabilities.js';
import { GroupService, type GroupToolPort } from '../../core/group/service.js';
import { resolveAtGroupMemberRepoPath } from '../../core/group/resolve-at-member.js';
import {
  consumeEnrichmentFacts,
  expandPassiveGraph,
  getSidecarStorePath,
  loadSidecarStoreState,
  runMarkdownDocumentPpr,
  resolveRetrievalPolicy,
  selectPassiveFactCandidates,
  type EnrichmentFact,
  type EnrichmentFactConsumptionRejectionReason,
  type EnrichmentRecord,
  type EnrichmentRecordStatus,
  type EnrichmentSnapshot,
  type EnrichmentReadPolicyDecision,
  type MarkdownDocumentPprEdge,
  type MarkdownDocumentPprNode,
  type MarkdownDocumentPprResult,
  type PassiveFactQueryTarget,
  type PassiveGraphFactCandidate,
  type RetrievalPolicyConfig,
  type RetrievalPolicyName,
  type SidecarRequestStatus,
} from '../../core/ingestion/enrichment/index.js';
import { detectChanges as detectChangesImpl } from './backend-detect-changes.js';
import { impactByUid as impactByUidImpl, runImpact } from './backend-impact.js';
import { formatCypherAsMarkdown, queryCypher } from './backend-query.js';
import { query as queryImpl } from './backend-search.js';
import { context as contextImpl } from './backend-context.js';
import { runContextNeighborhood } from './backend-context-neighborhood.js';
import {
  routeMap as routeMapImpl,
  shapeCheck as shapeCheckImpl,
  OverviewResult,
} from './backend-overview.js';
import { apiImpact as apiImpactImpl, toolMap as toolMapImpl } from './backend-api-analysis.js';
import {
  queryClusterDetail as queryClusterDetailImpl,
  queryClusters as queryClustersImpl,
  queryProcessDetail as queryProcessDetailImpl,
  queryProcesses as queryProcessesImpl,
} from './backend-resources.js';
import { renameSymbol } from './backend-rename.js';
import { runRepomap } from './backend-repomap.js';
import { runAuditRerun } from './backend-audit-rerun.js';
import { runBuildResidueAudit } from './backend-build-residue.js';
import { runCrossDocDrift } from './backend-cross-doc-drift.js';
import { runEvidencePack } from './backend-evidence-pack.js';
import { runGraphDiff } from './backend-graph-diff.js';
import { runHotspotAnalysis } from './backend-hotspot-analysis.js';
import { runImpactBatch } from './backend-impact-batch.js';
import { runTechDebt } from './backend-tech-debt.js';
import { runVerificationGap } from './backend-verification-gap.js';
import { runIpcTrace } from './backend-ipc-trace.js';
import { runRequirementsTrace } from './backend-requirements-trace.js';
import { runDeadCode } from './backend-dead-code.js';
import { runAuditReport } from './backend-audit-report.js';
import { runPatternAudit } from './backend-pattern-audit.js';
import { runAnalysisCatalog } from './backend-analysis-catalog.js';
import { runCycleDetect } from './backend-cycle-detect.js';
import { runCouplingMatrix } from './backend-coupling-matrix.js';
import { runMigrationProgress } from './backend-migration-progress.js';
import { runBoundaryViolations } from './backend-boundary-violations.js';
import { runTypeCoverage } from './backend-type-coverage.js';
import { routeTool } from './backend-route.js';
import { runDocsMcpAction } from '../super/docs.js';
import { manageSession } from './backend-session.js';
import {
  sandbox as sandboxImpl,
  replaceSymbol as replaceSymbolImpl,
  getSymbolInfo as getSymbolInfoImpl,
  updateSymbolBody as updateSymbolBodyImpl,
  extractFunctionByUid as extractFunctionByUidImpl,
  moveSymbolByUid as moveSymbolByUidImpl,
} from './backend-symbol-mutations.js';
import { canonicalize } from './path-util.js';
import { normalizeLimit } from './tool-utils.js';
import {
  buildAvailableRepoLabels,
  ensureRepoInitialized,
  resolveRepoFromHandles,
} from './local-backend-repo-runtime.js';
import type {
  AnalysisCatalogParams,
  ApiImpactParams,
  AuditReportParams,
  AuditRerunParams,
  BoundaryViolationsParams,
  BuildResidueAuditParams,
  ContextParams,
  CouplingMatrixParams,
  CrossDocDriftParams,
  CypherParams,
  CycleDetectParams,
  DeadCodeParams,
  DetectChangesParams,
  EvidencePackParams,
  ExtractFunctionParams,
  GetSymbolInfoParams,
  GraphDiffParams,
  HotspotAnalysisParams,
  ImpactBatchParams,
  ImpactParams,
  IpcTraceParams,
  MigrationProgressParams,
  MoveSymbolParams,
  DocsMcpParams,
  OverviewParams,
  PatternAuditParams,
  QueryParams,
  RenameByUidParams,
  RenameParams,
  RepomapParams,
  ReplaceSymbolParams,
  RequirementsTraceParams,
  RouteIntentParams,
  RouteMapParams,
  SandboxParams,
  SessionParams,
  ShapeCheckParams,
  TechDebtParams,
  ToolMapParams,
  TypeCoverageParams,
  UpdateSymbolBodyParams,
  VerificationGapParams,
} from './tool-params.js';
// AI context generation is CLI-only (ontoindex analyze)
// import { generateAIContextFiles } from '../../cli/ai-context.js';

export { VALID_NODE_LABELS } from './backend-query.js';
export {
  isTestFilePath,
  VALID_RELATION_TYPES,
  IMPACT_RELATION_CONFIDENCE,
} from './backend-impact.js';

interface CodebaseContext {
  projectName: string;
  stats: {
    fileCount: number;
    functionCount: number;
    communityCount: number;
    processCount: number;
  };
}

type NormalizedToolParams = Record<string, unknown>;
type RepoToolHandler = (repo: RepoHandle, params: NormalizedToolParams) => Promise<unknown>;
type GlobalToolHandler = (params: unknown) => Promise<unknown>;
type RepoAgnosticToolName = (typeof REPO_AGNOSTIC_TOOL_NAMES)[number];
type QueryResult = Awaited<ReturnType<typeof queryImpl>>;
type CypherQueryResult = Awaited<ReturnType<typeof queryCypher>>;
type ContextResult = Awaited<ReturnType<typeof contextImpl>>;
type RenameResult = Awaited<ReturnType<typeof renameSymbol>>;
type RenameLookupResult = ContextResult &
  (
    | {
        symbol: { name: string; filePath?: string; startLine?: number };
        incoming: {
          calls?: Array<{ filePath?: string }>;
          imports?: Array<{ filePath?: string }>;
          extends?: Array<{ filePath?: string }>;
          implements?: Array<{ filePath?: string }>;
        };
      }
    | { error: unknown }
    | { status: 'ambiguous'; candidates?: unknown }
  );
type ImpactResult = Awaited<ReturnType<typeof runImpact>>;
type ImpactByUidResult = Awaited<ReturnType<typeof impactByUidImpl>>;
type GetSymbolInfoResult = Awaited<ReturnType<typeof getSymbolInfoImpl>>;
type UpdateSymbolBodyResult = Awaited<ReturnType<typeof updateSymbolBodyImpl>>;
type ExtractFunctionByUidResult = Awaited<ReturnType<typeof extractFunctionByUidImpl>>;
type MoveSymbolByUidResult = Awaited<ReturnType<typeof moveSymbolByUidImpl>>;
type QueryClustersResult = Awaited<ReturnType<typeof queryClustersImpl>>;
type QueryProcessesResult = Awaited<ReturnType<typeof queryProcessesImpl>>;
type QueryClusterDetailResult = Awaited<ReturnType<typeof queryClusterDetailImpl>>;
type QueryProcessDetailResult = Awaited<ReturnType<typeof queryProcessDetailImpl>>;
type QueryClusterDetailWrapperResult = QueryClusterDetailResult &
  (
    | { error: string; cluster?: never; members?: never }
    | {
        error?: undefined;
        cluster: {
          id: unknown;
          label: string | undefined;
          heuristicLabel: string | undefined;
          cohesion: number;
          symbolCount: number;
          subCommunities: number;
        };
        members: Array<{ name: unknown; type: unknown; filePath: unknown }>;
      }
  );
type QueryProcessDetailWrapperResult = QueryProcessDetailResult &
  (
    | { error: string; process?: never; steps?: never; truncated?: never; stepLimit?: never }
    | {
        error?: undefined;
        process: {
          id: unknown;
          label: unknown;
          heuristicLabel: unknown;
          processType: unknown;
          stepCount: number;
          truncated: boolean;
        };
        truncated: boolean;
        stepLimit: number;
        steps: Array<{ step: unknown; name: unknown; type: unknown; filePath: unknown }>;
      }
  );
type ListReposResult = Array<{
  name: string;
  path: string;
  indexedAt: string;
  lastCommit: string;
  stats?: RepoHandle['stats'];
}>;

type EnrichmentStatusCounts = Record<EnrichmentRecordStatus, number>;
type EnrichmentRequestCounts = Pick<Record<SidecarRequestStatus, number>, 'queued' | 'running'>;
type PassiveGraphExpansionUnknown = ReturnType<typeof expandPassiveGraph<unknown>>;
type LocalEnrichmentExplanation = {
  retrievers: Array<Record<string, unknown> & { name: string }>;
};
type MarkdownDocsSourcePlane = 'markdown-docs-sidecar';
type MarkdownDocsEvidenceSource = {
  sourcePlane: MarkdownDocsSourcePlane;
  analyzerId: string;
  analyzerVersion: string;
  sourceIndexId: string;
  sourceCommitHash: string;
  filePath: string;
  fileHash: string;
  status: EnrichmentRecordStatus;
  freshnessReason: EnrichmentReadPolicyDecision['freshness']['reason'];
  readPolicyReason: EnrichmentReadPolicyDecision['reason'];
  partial: boolean;
  used: boolean;
  rejectionReason?: EnrichmentFactConsumptionRejectionReason;
  pathReasons?: string[];
};
type MarkdownDocsEvidenceFact = {
  kind: string;
  lineSpan?: { start: number; end: number };
  requirementId?: string;
  title?: string;
  criterion?: string;
  method?: string;
  path?: string;
  routeKey?: string;
  resolutionStatus?: string;
  resolutionReason?: string;
  candidates?: unknown[];
};
type MarkdownRelatedDoc = {
  docPath: string;
  fileHash?: string;
  sourceCommitHash?: string;
  chunkCount: number;
  sourcePlane: MarkdownDocsSourcePlane;
  freshness: MarkdownDocsEvidenceSource[];
  degradedReasons?: string[];
  pathReasons?: string[];
};
type MarkdownRelatedChunk = {
  chunkKey?: string;
  docPath: string;
  fileHash?: string;
  sourceCommitHash?: string;
  headingPath: string[];
  lineSpan: { start: number; end: number };
  chunkIndex?: number;
  normalizedAnchor?: string;
  contentHash?: string;
  excerpt?: string;
  sourcePlane: MarkdownDocsSourcePlane;
  freshness: MarkdownDocsEvidenceSource[];
  degradedReasons?: string[];
  pathReasons?: string[];
  evidence?: MarkdownDocsEvidenceFact[];
};
type RetrievalPolicyMetadata = {
  name: RetrievalPolicyName;
  sourcePlanes: RetrievalPolicyConfig['sourcePlanes'];
  docsExpansion: boolean;
  passiveExpansion: boolean;
  neighborhood: RetrievalPolicyConfig['neighborhood'];
  pathReasons: string[];
  freshness?: MarkdownDocsEvidenceMetadata['freshness'];
  truncation?: MarkdownDocsEvidenceMetadata['limits'];
  skipReasons?: Record<string, number>;
};
type MarkdownDocsEvidenceMetadata = {
  sourcePlane: MarkdownDocsSourcePlane;
  freshness: {
    statusCounts: Partial<Record<EnrichmentRecordStatus, number>>;
    reasonCounts: Partial<Record<EnrichmentReadPolicyDecision['freshness']['reason'], number>>;
  };
  skipReasons: Partial<Record<EnrichmentFactConsumptionRejectionReason, number>>;
  degraded: {
    partialRecordCount: number;
    staleRecordCount: number;
    ambiguousLinkCount: number;
    staleLinkCount: number;
  };
  ambiguousLinks: MarkdownDocsEvidenceFact[];
  staleLinks: MarkdownDocsEvidenceFact[];
  limits: {
    maxRelatedDocs: number;
    maxRelatedChunks: number;
    relatedDocCount: number;
    relatedChunkCount: number;
    relatedDocsTruncated: boolean;
    relatedChunksTruncated: boolean;
    truncated: boolean;
  };
};
type MarkdownContextMetadata = {
  relatedDocs: MarkdownRelatedDoc[];
  relatedChunks: MarkdownRelatedChunk[];
  markdownPpr?: MarkdownDocumentPprResult;
  docsEvidence: MarkdownDocsEvidenceMetadata;
  explanation: LocalEnrichmentExplanation;
};
type MarkdownContextFactEntry = {
  fact: EnrichmentFact;
  source: MarkdownDocsEvidenceSource;
};
interface LocalEnrichmentConsumptionOptions {
  consumeFacts?: boolean;
  includePassiveRelatedFacts?: boolean;
  includeMarkdownContext?: boolean;
  includeMarkdownPpr?: boolean;
  allowLowConfidence?: boolean;
  allowSafetyCriticalImpact?: boolean;
  safetyCriticalImpact?: boolean;
  passiveTargets?: PassiveFactQueryTarget[];
  primaryResults?: readonly unknown[];
  retrievalPolicy?: RetrievalPolicyConfig;
}

type LocalEnrichmentConsumptionMetadata =
  | {
      used: false;
      factConsumption?: never;
      facts?: never;
    }
  | {
      used: boolean;
      factConsumption: ReturnType<typeof consumeEnrichmentFacts>['summary'];
      visibleRecords: ReturnType<typeof consumeEnrichmentFacts>['visibleRecords'];
      facts?: EnrichmentFact[];
      relatedFacts?: PassiveGraphExpansionUnknown['relatedFacts'];
      relatedSymbols?: PassiveGraphExpansionUnknown['relatedSymbols'];
      relatedIdentities?: PassiveGraphExpansionUnknown['relatedIdentities'];
      relatedDocs?: MarkdownRelatedDoc[];
      relatedChunks?: MarkdownRelatedChunk[];
      markdownPpr?: MarkdownDocumentPprResult;
      docsEvidence?: MarkdownDocsEvidenceMetadata;
      retrievalPolicy?: RetrievalPolicyMetadata;
      explanation?: LocalEnrichmentExplanation;
      summary?: {
        passiveFactSelection: ReturnType<typeof selectPassiveFactCandidates>['summary'];
        passiveGraphExpansion: PassiveGraphExpansionUnknown['summary'];
      };
    };

type LocalEnrichmentMetadata =
  | ({
      status: 'available';
      recordStatusCounts: EnrichmentStatusCounts;
      requests: EnrichmentRequestCounts;
      lock: {
        ownerId: string;
        heartbeatAt: string;
      } | null;
    } & LocalEnrichmentConsumptionMetadata)
  | ({
      status: 'unavailable';
      reason: 'missing-store';
      recordStatusCounts: EnrichmentStatusCounts;
      requests: EnrichmentRequestCounts;
      lock: null;
    } & LocalEnrichmentConsumptionMetadata)
  | ({
      status: 'error';
      error: string;
      recordStatusCounts: EnrichmentStatusCounts;
      requests: EnrichmentRequestCounts;
      lock: null;
    } & LocalEnrichmentConsumptionMetadata);

const ENRICHMENT_RECORD_STATUSES: readonly EnrichmentRecordStatus[] = [
  'queued',
  'running',
  'complete',
  'partial',
  'failed',
  'cancelled',
  'stale',
  'superseded',
];
const MARKDOWN_DOCS_SOURCE_PLANE: MarkdownDocsSourcePlane = 'markdown-docs-sidecar';
const MAX_MARKDOWN_RELATED_DOCS = 5;
const MAX_MARKDOWN_RELATED_CHUNKS = 10;

function emptyEnrichmentRecordStatusCounts(): EnrichmentStatusCounts {
  return Object.fromEntries(
    ENRICHMENT_RECORD_STATUSES.map((status) => [status, 0]),
  ) as EnrichmentStatusCounts;
}

function emptyEnrichmentRequestCounts(): EnrichmentRequestCounts {
  return { queued: 0, running: 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObjectResponse(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function passiveTargetsFromQueryResult(result: QueryResult): PassiveFactQueryTarget[] {
  if (!isObjectResponse(result)) return [];
  const targets: PassiveFactQueryTarget[] = [];
  const seen = new Set<string>();
  for (const item of [
    ...arrayField(result, 'definitions'),
    ...arrayField(result, 'process_symbols'),
  ]) {
    if (!isObjectResponse(item)) continue;
    if (typeof item.id === 'string') {
      addPassiveTarget(targets, seen, { type: 'symbol', id: item.id });
    }
    if (typeof item.filePath === 'string') {
      addPassiveTarget(targets, seen, { type: 'file', filePath: item.filePath });
    }
  }
  for (const process of arrayField(result, 'processes')) {
    if (isObjectResponse(process) && typeof process.id === 'string') {
      addPassiveTarget(targets, seen, { type: 'process', id: process.id });
    }
  }
  return targets;
}

function primaryResultsFromQueryResult(result: QueryResult): readonly unknown[] {
  if (!isObjectResponse(result)) return [];
  return arrayField(result, 'definitions');
}

function passiveTargetsFromContextResult(result: ContextResult): PassiveFactQueryTarget[] {
  if (!isObjectResponse(result)) return [];
  const targets: PassiveFactQueryTarget[] = [];
  const seen = new Set<string>();
  const symbol = result.symbol;
  if (isObjectResponse(symbol)) {
    if (typeof symbol.uid === 'string') {
      addPassiveTarget(targets, seen, { type: 'symbol', id: symbol.uid });
    }
    if (typeof symbol.filePath === 'string') {
      addPassiveTarget(targets, seen, { type: 'file', filePath: symbol.filePath });
    }
  }
  for (const process of arrayField(result, 'processes')) {
    if (isObjectResponse(process) && typeof process.id === 'string') {
      addPassiveTarget(targets, seen, { type: 'process', id: process.id });
    }
  }
  return targets;
}

function primaryResultsFromContextResult(result: ContextResult): readonly unknown[] {
  if (!isObjectResponse(result)) return [];
  return isObjectResponse(result.symbol) ? [result.symbol] : [];
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function addPassiveTarget(
  targets: PassiveFactQueryTarget[],
  seen: Set<string>,
  target: PassiveFactQueryTarget,
): void {
  const key = `${target.type}:${target.id ?? ''}:${target.filePath ?? ''}:${target.fileHash ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  targets.push(target);
}

function attachRetrievalPolicyMetadata<T>(
  result: T,
  enrichment: Record<string, unknown> | undefined,
  policy: RetrievalPolicyConfig | undefined,
): T {
  if (!policy || !isObjectResponse(result)) return result;
  return {
    ...result,
    retrievalPolicy: enrichment?.retrievalPolicy ?? {
      name: policy.name,
      sourcePlanes: policy.sourcePlanes,
      docsExpansion: policy.docsExpansion,
      passiveExpansion: policy.passiveExpansion,
      neighborhood: policy.neighborhood,
      pathReasons: [policy.pathReason],
      ...retrievalPolicySkipMetadata(enrichment),
    },
    ...(Array.isArray(enrichment?.relatedDocs) && { relatedDocs: enrichment.relatedDocs }),
  } as T;
}

function retrievalPolicySkipMetadata(enrichment: Record<string, unknown> | undefined): {
  skipReasons?: Record<string, number>;
} {
  if (enrichment?.status === 'unavailable' && enrichment.reason === 'missing-store') {
    return { skipReasons: { 'sidecar-missing': 1 } };
  }
  if (enrichment?.status === 'error') {
    return { skipReasons: { 'sidecar-error': 1 } };
  }
  return {};
}

function passiveCandidateKey(candidate: PassiveGraphFactCandidate): string {
  return [
    candidate.record.analyzerId,
    candidate.record.analyzerVersion,
    candidate.record.sourceIndexId,
    candidate.record.sourceCommitHash,
    candidate.record.filePath,
    candidate.record.fileHash,
    JSON.stringify(candidate.fact),
  ].join('\0');
}

function extractMarkdownContextMetadata(
  entries: readonly MarkdownContextFactEntry[],
  options: { includePpr?: boolean; retrievalPolicy?: RetrievalPolicyConfig } = {},
): MarkdownContextMetadata {
  const policy = options.retrievalPolicy;
  const policyPathReasons = policy ? [policy.pathReason] : undefined;
  const filteredEntries = filterMarkdownEntriesByPolicy(entries, policy);
  const relatedChunks: MarkdownRelatedChunk[] = [];
  const docs = new Map<string, MarkdownRelatedDoc>();
  const chunksByKey = new Map<string, MarkdownRelatedChunk>();
  const chunkEvidence = new Map<string, MarkdownDocsEvidenceFact[]>();
  const freshnessStatusCounts: MarkdownDocsEvidenceMetadata['freshness']['statusCounts'] = {};
  const freshnessReasonCounts: MarkdownDocsEvidenceMetadata['freshness']['reasonCounts'] = {};
  const skipReasons: MarkdownDocsEvidenceMetadata['skipReasons'] = {};
  const ambiguousLinks: MarkdownDocsEvidenceFact[] = [];
  const staleLinks: MarkdownDocsEvidenceFact[] = [];
  let partialRecordCount = 0;
  let staleRecordCount = 0;

  for (const { fact, source } of filteredEntries) {
    freshnessStatusCounts[source.status] = (freshnessStatusCounts[source.status] ?? 0) + 1;
    freshnessReasonCounts[source.freshnessReason] =
      (freshnessReasonCounts[source.freshnessReason] ?? 0) + 1;
    if (source.rejectionReason) {
      skipReasons[source.rejectionReason] = (skipReasons[source.rejectionReason] ?? 0) + 1;
    }
    if (source.partial) partialRecordCount += 1;
    if (source.status === 'stale' || source.rejectionReason === 'stale-rejected') {
      staleRecordCount += 1;
    }

    const evidence = toMarkdownDocsEvidenceFact(fact);
    const sourceChunkKey = markdownFactSourceChunkKey(fact);
    if (evidence && sourceChunkKey) {
      const list = chunkEvidence.get(sourceChunkKey) ?? [];
      list.push(evidence);
      chunkEvidence.set(sourceChunkKey, list);
      const chunk = chunksByKey.get(sourceChunkKey);
      if (chunk) chunk.evidence = list;
      if (evidence.resolutionStatus === 'ambiguous') ambiguousLinks.push(evidence);
      if (evidence.resolutionStatus === 'stale') staleLinks.push(evidence);
    }

    if (!isMarkdownChunkFact(fact)) continue;
    const chunk = toMarkdownRelatedChunk(fact, source);
    const evidenceList = chunk.chunkKey ? chunkEvidence.get(chunk.chunkKey) : undefined;
    if (evidenceList && evidenceList.length > 0) chunk.evidence = evidenceList;
    relatedChunks.push(chunk);
    if (chunk.chunkKey) chunksByKey.set(chunk.chunkKey, chunk);
    const docKey = `${chunk.docPath}\0${chunk.fileHash ?? ''}\0${chunk.sourceCommitHash ?? ''}`;
    const doc = docs.get(docKey);
    if (doc) {
      doc.chunkCount += 1;
      doc.freshness.push(source);
      doc.degradedReasons = mergeDegradedReasons(
        doc.degradedReasons,
        degradedReasonsForSource(source),
      );
      doc.pathReasons = mergeDegradedReasons(doc.pathReasons, policyPathReasons ?? []);
    } else {
      docs.set(docKey, {
        docPath: chunk.docPath,
        fileHash: chunk.fileHash,
        sourceCommitHash: chunk.sourceCommitHash,
        chunkCount: 1,
        sourcePlane: MARKDOWN_DOCS_SOURCE_PLANE,
        freshness: [source],
        degradedReasons: degradedReasonsForSource(source),
        ...(policyPathReasons && { pathReasons: policyPathReasons }),
      });
    }
  }

  relatedChunks.sort(compareMarkdownChunks);
  const allRelatedDocs = [...docs.values()].sort((left, right) =>
    left.docPath.localeCompare(right.docPath),
  );
  const relatedDocs = allRelatedDocs.slice(0, MAX_MARKDOWN_RELATED_DOCS);
  const boundedRelatedChunks = relatedChunks.slice(0, MAX_MARKDOWN_RELATED_CHUNKS);
  const relatedDocsTruncated = allRelatedDocs.length > relatedDocs.length;
  const relatedChunksTruncated = relatedChunks.length > boundedRelatedChunks.length;
  const markdownPpr =
    options.includePpr === true
      ? runMarkdownDocumentPpr(
          ...createMarkdownPprArgs(
            filteredEntries.map((entry) => entry.fact),
            boundedRelatedChunks,
          ),
        )
      : undefined;

  return {
    relatedDocs,
    relatedChunks: boundedRelatedChunks,
    ...(markdownPpr && { markdownPpr }),
    docsEvidence: {
      sourcePlane: MARKDOWN_DOCS_SOURCE_PLANE,
      freshness: {
        statusCounts: freshnessStatusCounts,
        reasonCounts: freshnessReasonCounts,
      },
      skipReasons,
      degraded: {
        partialRecordCount,
        staleRecordCount,
        ambiguousLinkCount: ambiguousLinks.length,
        staleLinkCount: staleLinks.length,
      },
      ambiguousLinks: ambiguousLinks.slice(0, MAX_MARKDOWN_RELATED_CHUNKS),
      staleLinks: staleLinks.slice(0, MAX_MARKDOWN_RELATED_CHUNKS),
      limits: {
        maxRelatedDocs: MAX_MARKDOWN_RELATED_DOCS,
        maxRelatedChunks: MAX_MARKDOWN_RELATED_CHUNKS,
        relatedDocCount: allRelatedDocs.length,
        relatedChunkCount: relatedChunks.length,
        relatedDocsTruncated,
        relatedChunksTruncated,
        truncated: relatedDocsTruncated || relatedChunksTruncated,
      },
    },
    explanation: {
      retrievers: [
        {
          name: 'markdown-passive-graph',
          factCount: entries.length,
          docCount: allRelatedDocs.length,
          chunkCount: relatedChunks.length,
          ...(relatedChunks.length === 0 && { degradedReasons: { 'missing-markdown-facts': 1 } }),
          ...((relatedDocsTruncated || relatedChunksTruncated) && {
            truncated: true,
            limits: {
              maxRelatedDocs: MAX_MARKDOWN_RELATED_DOCS,
              maxRelatedChunks: MAX_MARKDOWN_RELATED_CHUNKS,
            },
          }),
        },
      ],
    },
  };
}

function filterMarkdownEntriesByPolicy(
  entries: readonly MarkdownContextFactEntry[],
  policy: RetrievalPolicyConfig | undefined,
): MarkdownContextFactEntry[] {
  if (!policy?.markdownFactKinds) return [...entries];
  const allowedKinds = new Set(policy.markdownFactKinds);
  const chunkKeys = new Set<string>();
  for (const { fact } of entries) {
    if (!isObjectResponse(fact) || !allowedKinds.has(String(fact.kind))) continue;
    const chunkKey = markdownFactSourceChunkKey(fact);
    if (chunkKey) chunkKeys.add(chunkKey);
  }
  return entries.filter(({ fact }) => {
    if (!isObjectResponse(fact)) return false;
    if (allowedKinds.has(String(fact.kind))) return true;
    return fact.kind === 'markdown-chunk' && chunkKeys.has(String(fact.chunkKey ?? ''));
  });
}

function createRetrievalPolicyMetadata(
  policy: RetrievalPolicyConfig,
  markdownContext: MarkdownContextMetadata | undefined,
): RetrievalPolicyMetadata {
  return {
    name: policy.name,
    sourcePlanes: policy.sourcePlanes,
    docsExpansion: policy.docsExpansion,
    passiveExpansion: policy.passiveExpansion,
    neighborhood: policy.neighborhood,
    pathReasons: [policy.pathReason],
    ...(markdownContext && {
      freshness: markdownContext.docsEvidence.freshness,
      truncation: markdownContext.docsEvidence.limits,
      skipReasons: markdownContext.docsEvidence.skipReasons,
    }),
  };
}

function addPolicyPathReasons<T>(
  values: readonly T[],
  policy: RetrievalPolicyConfig | undefined,
): T[] {
  if (!policy) return [...values];
  return values.map((value) =>
    isObjectResponse(value) ? ({ ...value, pathReasons: [policy.pathReason] } as T) : value,
  );
}

function createMarkdownPprArgs(
  facts: readonly EnrichmentFact[],
  seedChunks: readonly MarkdownRelatedChunk[],
): [
  nodes: MarkdownDocumentPprNode[],
  edges: MarkdownDocumentPprEdge[],
  options: Parameters<typeof runMarkdownDocumentPpr>[2],
] {
  const nodes = new Map<string, MarkdownDocumentPprNode>();
  const edges: MarkdownDocumentPprEdge[] = [];
  const seedIds = seedChunks
    .map((chunk) => chunk.chunkKey)
    .filter((chunkKey): chunkKey is string => typeof chunkKey === 'string' && chunkKey.length > 0);

  for (const chunk of seedChunks) {
    if (chunk.chunkKey === undefined) continue;
    const docId = markdownDocNodeId(chunk.docPath);
    const sectionId = markdownSectionNodeId(chunk.docPath, chunk.headingPath);
    addMarkdownPprNode(nodes, { id: docId, type: 'doc' });
    addMarkdownPprNode(nodes, { id: sectionId, type: 'section' });
    addMarkdownPprNode(nodes, { id: chunk.chunkKey, type: 'chunk' });
    addMarkdownPprEdge(edges, docId, sectionId, 'has-section');
    addMarkdownPprEdge(edges, sectionId, chunk.chunkKey, 'has-chunk');
    addMarkdownPprEdge(edges, chunk.chunkKey, sectionId, 'same-section');
    addMarkdownPprEdge(edges, chunk.chunkKey, docId, 'same-doc');
  }

  for (const fact of facts) {
    if (!isObjectResponse(fact)) continue;
    const chunkKey = typeof fact.chunkKey === 'string' ? fact.chunkKey : undefined;
    if (chunkKey === undefined || !nodes.has(chunkKey)) continue;
    if (fact.kind === 'markdown-code-mention') {
      const mentionId = `markdown-mention:${chunkKey}:${stableJson(fact.target ?? fact.mention ?? '')}`;
      addMarkdownPprNode(nodes, { id: mentionId, type: 'mention' });
      addMarkdownPprEdge(edges, chunkKey, mentionId, 'mentions');
      addMarkdownPprEdge(edges, mentionId, chunkKey, 'mention-source');
    } else if (fact.kind === 'markdown-entity') {
      const entityId =
        typeof fact.entityKey === 'string'
          ? fact.entityKey
          : `markdown-entity:${chunkKey}:${stableJson(fact.label ?? '')}`;
      addMarkdownPprNode(nodes, { id: entityId, type: 'entity' });
      addMarkdownPprEdge(edges, chunkKey, entityId, 'has-entity');
      addMarkdownPprEdge(edges, entityId, chunkKey, 'entity-source');
    } else if (fact.kind === 'markdown-link') {
      const linkId =
        typeof fact.href === 'string'
          ? `markdown-link:${fact.href}`
          : `markdown-link:${chunkKey}:${stableJson(fact)}`;
      addMarkdownPprNode(nodes, { id: linkId, type: 'link' });
      addMarkdownPprEdge(edges, chunkKey, linkId, 'links-to');
      addMarkdownPprEdge(edges, linkId, chunkKey, 'cites');
    }
  }

  return [
    [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges.sort((left, right) =>
      [left.from, left.to, left.type]
        .join('\0')
        .localeCompare([right.from, right.to, right.type].join('\0')),
    ),
    {
      seedIds,
      allowedNodeTypes: ['doc', 'section', 'chunk', 'entity', 'link', 'mention'],
      topK: 8,
      maxHops: 2,
      maxVisitedNodes: 25,
      restartProbability: 0.15,
    },
  ];
}

function addMarkdownPprNode(
  nodes: Map<string, MarkdownDocumentPprNode>,
  node: MarkdownDocumentPprNode,
): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function addMarkdownPprEdge(
  edges: MarkdownDocumentPprEdge[],
  from: string,
  to: string,
  type: string,
): void {
  edges.push({ from, to, type });
}

function markdownDocNodeId(docPath: string): string {
  return `markdown-doc:${docPath}`;
}

function markdownSectionNodeId(docPath: string, headingPath: readonly string[]): string {
  return `markdown-section:${docPath}:${headingPath.join('/')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isObjectResponse(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isMarkdownChunkFact(fact: EnrichmentFact): fact is EnrichmentFact & {
  kind: 'markdown-chunk';
  docPath: string;
  headingPath: string[];
  lineSpan: { start: number; end: number };
  chunkKey?: string;
  fileHash?: string;
  sourceCommitHash?: string;
  chunkIndex?: number;
  normalizedAnchor?: string;
  contentHash?: string;
  excerpt?: string;
} {
  if (!isObjectResponse(fact)) return false;
  if (fact.kind !== 'markdown-chunk') return false;
  if (typeof fact.docPath !== 'string') return false;
  if (
    !Array.isArray(fact.headingPath) ||
    !fact.headingPath.every((part) => typeof part === 'string')
  ) {
    return false;
  }
  const lineSpan = fact.lineSpan;
  return (
    isObjectResponse(lineSpan) &&
    typeof lineSpan.start === 'number' &&
    typeof lineSpan.end === 'number'
  );
}

function toMarkdownRelatedChunk(
  fact: EnrichmentFact & {
    kind: 'markdown-chunk';
    docPath: string;
    headingPath: string[];
    lineSpan: { start: number; end: number };
    chunkKey?: string;
    fileHash?: string;
    sourceCommitHash?: string;
    chunkIndex?: number;
    normalizedAnchor?: string;
    contentHash?: string;
    excerpt?: string;
  },
  source: MarkdownDocsEvidenceSource,
): MarkdownRelatedChunk {
  const degradedReasons = degradedReasonsForSource(source);
  return {
    chunkKey: typeof fact.chunkKey === 'string' ? fact.chunkKey : undefined,
    docPath: fact.docPath,
    fileHash: typeof fact.fileHash === 'string' ? fact.fileHash : undefined,
    sourceCommitHash: typeof fact.sourceCommitHash === 'string' ? fact.sourceCommitHash : undefined,
    headingPath: fact.headingPath,
    lineSpan: fact.lineSpan,
    chunkIndex: typeof fact.chunkIndex === 'number' ? fact.chunkIndex : undefined,
    normalizedAnchor: typeof fact.normalizedAnchor === 'string' ? fact.normalizedAnchor : undefined,
    contentHash: typeof fact.contentHash === 'string' ? fact.contentHash : undefined,
    excerpt: typeof fact.excerpt === 'string' ? fact.excerpt : undefined,
    sourcePlane: MARKDOWN_DOCS_SOURCE_PLANE,
    freshness: [source],
    ...(degradedReasons.length > 0 && { degradedReasons }),
    ...(source.pathReasons && { pathReasons: source.pathReasons }),
  };
}

function isMarkdownDocumentFact(fact: EnrichmentFact): boolean {
  return (
    isObjectResponse(fact) && typeof fact.kind === 'string' && fact.kind.startsWith('markdown-')
  );
}

function markdownFactSourceChunkKey(fact: EnrichmentFact): string | undefined {
  if (!isObjectResponse(fact)) return undefined;
  if (typeof fact.sourceChunkKey === 'string') return fact.sourceChunkKey;
  if (typeof fact.chunkKey === 'string') return fact.chunkKey;
  if (typeof fact.fromChunkKey === 'string') return fact.fromChunkKey;
  return undefined;
}

function toMarkdownDocsEvidenceFact(fact: EnrichmentFact): MarkdownDocsEvidenceFact | undefined {
  if (!isObjectResponse(fact)) return undefined;
  if (
    fact.kind !== 'markdown-requirement' &&
    fact.kind !== 'markdown-acceptance-criterion' &&
    fact.kind !== 'markdown-api-spec' &&
    fact.kind !== 'markdown-code-mention'
  ) {
    return undefined;
  }
  const evidence: MarkdownDocsEvidenceFact = { kind: String(fact.kind) };
  const lineSpan =
    isObjectResponse(fact.lineSpan) && typeof fact.lineSpan.start === 'number'
      ? fact.lineSpan
      : isObjectResponse(fact.evidence) &&
          isObjectResponse(fact.evidence.lineSpan) &&
          typeof fact.evidence.lineSpan.start === 'number'
        ? fact.evidence.lineSpan
        : undefined;
  if (
    isObjectResponse(lineSpan) &&
    typeof lineSpan.start === 'number' &&
    typeof lineSpan.end === 'number'
  ) {
    evidence.lineSpan = { start: lineSpan.start, end: lineSpan.end };
  }
  if (typeof fact.requirementId === 'string') evidence.requirementId = fact.requirementId;
  if (typeof fact.title === 'string') evidence.title = fact.title;
  if (typeof fact.criterion === 'string') evidence.criterion = fact.criterion;
  if (typeof fact.method === 'string') evidence.method = fact.method;
  if (typeof fact.path === 'string') evidence.path = fact.path;
  if (typeof fact.routeKey === 'string') evidence.routeKey = fact.routeKey;
  if (typeof fact.resolutionStatus === 'string') evidence.resolutionStatus = fact.resolutionStatus;
  if (typeof fact.resolutionReason === 'string') evidence.resolutionReason = fact.resolutionReason;
  if (Array.isArray(fact.candidates)) evidence.candidates = fact.candidates.slice(0, 5);
  return evidence;
}

function degradedReasonsForSource(source: MarkdownDocsEvidenceSource): string[] {
  const reasons: string[] = [];
  if (source.partial) reasons.push('partial');
  if (source.status === 'stale' || source.rejectionReason === 'stale-rejected')
    reasons.push('stale');
  if (source.rejectionReason) reasons.push(source.rejectionReason);
  return [...new Set(reasons)];
}

function mergeDegradedReasons(
  left: string[] | undefined,
  right: readonly string[],
): string[] | undefined {
  if ((left?.length ?? 0) === 0 && right.length === 0) return undefined;
  return [...new Set([...(left ?? []), ...right])];
}

function createMarkdownDocsEvidenceSource(
  record: EnrichmentRecord,
  decision: EnrichmentReadPolicyDecision,
  rejectionReason?: EnrichmentFactConsumptionRejectionReason,
  retrievalPolicy?: RetrievalPolicyConfig,
): MarkdownDocsEvidenceSource {
  return {
    sourcePlane: MARKDOWN_DOCS_SOURCE_PLANE,
    analyzerId: record.analyzerId,
    analyzerVersion: record.analyzerVersion,
    sourceIndexId: record.sourceIndexId,
    sourceCommitHash: record.sourceCommitHash,
    filePath: record.filePath,
    fileHash: record.fileHash,
    status: record.status,
    freshnessReason: decision.freshness.reason,
    readPolicyReason: decision.reason,
    partial: decision.partial,
    used: rejectionReason === undefined,
    ...(rejectionReason && { rejectionReason }),
    ...(retrievalPolicy && { pathReasons: [retrievalPolicy.pathReason] }),
  };
}

function shouldIncludeDegradedMarkdownRecord(
  record: EnrichmentRecord,
  reason: EnrichmentFactConsumptionRejectionReason,
): boolean {
  return (
    record.records.some(isMarkdownDocumentFact) &&
    (reason === 'stale-rejected' || record.status === 'stale')
  );
}

function compareMarkdownChunks(left: MarkdownRelatedChunk, right: MarkdownRelatedChunk): number {
  return (
    left.docPath.localeCompare(right.docPath) ||
    left.lineSpan.start - right.lineSpan.start ||
    (left.chunkIndex ?? 0) - (right.chunkIndex ?? 0) ||
    (left.chunkKey ?? '').localeCompare(right.chunkKey ?? '')
  );
}

function isStartupTraceEnabled(): boolean {
  const raw = process.env.ONTOINDEX_MCP_STARTUP_TRACE?.toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function logStartupTrace(message: string, startedAt?: number): void {
  if (!isStartupTraceEnabled()) return;
  const suffix = startedAt === undefined ? '' : ` (${Date.now() - startedAt}ms)`;
  console.error(`[ontoindex:mcp:init] ${message}${suffix}`);
}

const REPO_AGNOSTIC_TOOL_NAMES = [
  'list_repos',
  'gn_help',
  'gn_tool_contract',
  'gn_quality_mode',
  'gn_diagnose',
] as const;

const REPO_AGNOSTIC_TOOL_METHODS = new Set<string>(REPO_AGNOSTIC_TOOL_NAMES);

function isRepoAgnosticToolName(method: string): method is RepoAgnosticToolName {
  return REPO_AGNOSTIC_TOOL_METHODS.has(method);
}

/** Compile-time set of all valid MCP tool method names. */
const KNOWN_METHODS = new Set<string>([
  ...REPO_AGNOSTIC_TOOL_NAMES,
  'query',
  'cypher',
  'context',
  'impact',
  'detect_changes',
  'cycle_detect',
  'coupling_matrix',
  'migration_progress',
  'boundary_violations',
  'type_coverage',
  'rename',
  'rename_symbol',
  'search',
  'explore',
  'overview',
  'route_map',
  'shape_check',
  'tool_map',
  'api_impact',
  'repomap',
  'route',
  'analysis_catalog',
  'session',
  'pattern_audit',
  'audit_rerun',
  'build_residue_audit',
  'cross_doc_drift',
  'evidence_pack',
  'graph_diff',
  'hotspot_analysis',
  'impact_batch',
  'tech_debt',
  'verification_gap',
  'community_evidence_pack',
  'ipc_trace',
  'requirements_trace',
  'audit_report',
  'dead_code',
  'sandbox',
  'replace_symbol',
  'get_symbol_info',
  'update_symbol_body',
  'extract_function',
  'move_symbol',
  'discover',
  'search',
  'inspect',
  'impact',
  'audit',
  'refactor',
  'manage',
  'docs',
]);

/**
 * Construction-time knobs. `confirmWrites` is the master switch for
 * mutation tools (replace_symbol, sandbox apply, …): when `false`, any
 * confirmed write still fails closed. Defaults to `false` so a
 * caller that forgets to pass options can never mutate an index.
 */
interface LocalBackendOptions {
  readonly confirmWrites?: boolean;
  readonly repoFilter?: string;
}

export class LocalBackend implements BackendPort {
  private repos: Map<string, RepoHandle> = new Map();
  private contextCache: Map<string, CodebaseContext> = new Map();
  private initializedRepos: Set<string> = new Set();
  private reinitPromises: Map<string, Promise<void>> = new Map();
  private lastStalenessCheck: Map<string, number> = new Map();
  private initPromise: Promise<boolean> | null = null;
  private groupToolSvc: GroupService | null = null;
  private analysisLocks: Map<string, Promise<void>> = new Map();
  private readonly confirmWrites: boolean;
  private readonly repoFilter?: string;
  private readonly globalToolHandlers: Record<RepoAgnosticToolName, GlobalToolHandler>;
  private readonly repoToolHandlers: Record<string, RepoToolHandler>;

  constructor(options: LocalBackendOptions = {}) {
    this.confirmWrites = options.confirmWrites === true;
    this.repoFilter = options.repoFilter?.trim() || undefined;
    this.globalToolHandlers = {
      list_repos: async () => this.listRepos(),
      gn_quality_mode: async (params) => {
        const { gnQualityMode } = await import('../super/quality-mode.js');
        return gnQualityMode(params as any);
      },
      gn_help: async (params) => {
        const { gnHelp } = await import('../super/help.js');
        return gnHelp(params as any);
      },
      gn_tool_contract: async (params) => {
        const { gnToolContract } = await import('../super/tool-contract.js');
        return gnToolContract(params as any);
      },
      gn_diagnose: async (params) => {
        const { gnDiagnose } = await import('../super/diagnose.js');
        return gnDiagnose('', params as any);
      },
    };
    this.repoToolHandlers = {
      query: (repo, params) => this.query(repo, params as QueryParams),
      cypher: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return formatCypherAsMarkdown(await queryCypher(repo, params as CypherParams));
      },
      context: (repo, params) => this.context(repo, params as ContextParams),
      impact: (repo, params) => this.impact(repo, params as ImpactParams),
      detect_changes: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return detectChangesImpl(repo, params as DetectChangesParams);
      },
      cycle_detect: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runCycleDetect(repo, params as CycleDetectParams);
      },
      coupling_matrix: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runCouplingMatrix(repo, params as CouplingMatrixParams);
      },
      migration_progress: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runMigrationProgress(repo, params as MigrationProgressParams);
      },
      boundary_violations: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runBoundaryViolations(repo, params as BoundaryViolationsParams);
      },
      type_coverage: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runTypeCoverage(repo, params as TypeCoverageParams);
      },
      rename: (repo, params) => this.rename(repo, params as RenameParams),
      rename_symbol: (repo, params) => this.renameByUid(repo, params as RenameByUidParams),
      search: (repo, params) => this.query(repo, params as QueryParams),
      explore: (repo, params) => {
        const contextParams = params as ContextParams;
        return this.context(repo, { name: contextParams.name, ...contextParams });
      },
      overview: (repo, params) => this.overview(repo, params as OverviewParams),
      route_map: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return routeMapImpl(repo, params as RouteMapParams);
      },
      shape_check: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return shapeCheckImpl(repo, params as ShapeCheckParams);
      },
      tool_map: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return toolMapImpl(repo, params as ToolMapParams);
      },
      api_impact: async (repo, params) => {
        const apiParams = params as ApiImpactParams;
        if (apiParams.file) canonicalize(repo.repoPath, apiParams.file);
        await this.ensureInitialized(repo.id);
        return apiImpactImpl(repo, apiParams);
      },
      repomap: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runRepomap(repo, params as RepomapParams);
      },
      route: (repo, params) => routeTool(repo, params as RouteIntentParams),
      analysis_catalog: (repo, params) => runAnalysisCatalog(repo, params as AnalysisCatalogParams),
      session: (repo, params) => manageSession(repo, params as SessionParams),
      pattern_audit: (repo, params) => runPatternAudit(repo, params as PatternAuditParams),
      audit_rerun: (repo, params) => runAuditRerun(repo, params as AuditRerunParams),
      build_residue_audit: (repo, params) =>
        runBuildResidueAudit(repo, params as BuildResidueAuditParams),
      cross_doc_drift: (repo, params) => runCrossDocDrift(repo, params as CrossDocDriftParams),
      evidence_pack: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runEvidencePack(repo, params as EvidencePackParams);
      },
      graph_diff: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runGraphDiff(repo, params as GraphDiffParams);
      },
      hotspot_analysis: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runHotspotAnalysis(repo, params as HotspotAnalysisParams);
      },
      impact_batch: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runImpactBatch(repo, params as ImpactBatchParams);
      },
      tech_debt: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runTechDebt(repo, params as TechDebtParams);
      },
      verification_gap: (repo, params) => runVerificationGap(repo, params as VerificationGapParams),
      ipc_trace: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runIpcTrace(repo, params as IpcTraceParams);
      },
      requirements_trace: (repo, params) =>
        runRequirementsTrace(repo, params as RequirementsTraceParams),
      audit_report: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runAuditReport(repo, params as AuditReportParams);
      },
      dead_code: async (repo, params) => {
        await this.ensureInitialized(repo.id);
        return runDeadCode(repo, params as DeadCodeParams);
      },
      sandbox: (repo, params) => this.sandbox(repo, params as SandboxParams),
      replace_symbol: (repo, params) => this.replaceSymbol(repo, params as ReplaceSymbolParams),
      get_symbol_info: (repo, params) => this.getSymbolInfo(repo, params as GetSymbolInfoParams),
      update_symbol_body: (repo, params) =>
        this.updateSymbolBody(repo, params as UpdateSymbolBodyParams),
      extract_function: (repo, params) =>
        this.extractFunctionByUid(repo, params as ExtractFunctionParams),
      move_symbol: (repo, params) => this.moveSymbolByUid(repo, params as MoveSymbolParams),
      docs: (repo, params) => runDocsMcpAction(repo, params as DocsMcpParams),
    };
  }

  /**
   * Cross-repo group tools (CLI). Shares logic with MCP `group_*` handlers.
   */
  getGroupService(): GroupService {
    if (!this.groupToolSvc) {
      const port: GroupToolPort = {
        resolveRepo: (p) => this.resolveRepo(p),
        impact: (r, p, options) => this.impact(r as RepoHandle, { ...p, signal: options?.signal }),
        query: (r, p) => this.query(r as RepoHandle, p),
        impactByUid: (id, uid, d, o) => this.impactByUid(id, uid, d, o),
        context: (r, p) => this.context(r as RepoHandle, p),
      };
      this.groupToolSvc = new GroupService(port);
    }
    return this.groupToolSvc;
  }

  private withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.analysisLocks.get(repoId) ?? Promise.resolve();
    const next = prev.then(fn);
    this.analysisLocks.set(
      repoId,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  async closeRepoConnections(name: string, repoPath: string): Promise<void> {
    const id = this.repoId(name, repoPath);
    await closeLbug(id);
    this.initializedRepos.delete(id);
    this.lastStalenessCheck.delete(id);
    this.reinitPromises.delete(id);
  }

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize from the global registry.
   * Returns true if at least one repo is available.
   */
  async init(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    this.throwIfInitAborted(options.signal);

    if (!this.initPromise) {
      const refreshPromise = (async () => {
        await this.refreshRepos(options.signal);
        return this.repos.size > 0;
      })();
      this.initPromise = refreshPromise;
      void refreshPromise
        .finally(() => {
          if (this.initPromise === refreshPromise) {
            this.initPromise = null;
          }
        })
        .catch(() => {});
    }

    const currentInit = this.initPromise;
    try {
      return await this.waitForInit(currentInit, options.signal);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' && this.initPromise === currentInit) {
        this.initPromise = null;
      }
      throw err;
    }
  }

  /**
   * Re-read the global registry and update the in-memory repo map.
   * New repos are added, existing repos are updated, removed repos are pruned.
   * LadybugDB connections for removed repos are NOT closed (they idle-timeout naturally).
   */
  private makeInitAbortError(): Error {
    const err = new Error('LocalBackend initialization aborted');
    err.name = 'AbortError';
    return err;
  }

  private throwIfInitAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw this.makeInitAbortError();
    }
  }

  private waitForInit(promise: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    if (!signal) return promise;
    this.throwIfInitAborted(signal);

    return new Promise<boolean>((resolve, reject) => {
      const onAbort = () => reject(this.makeInitAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  private async refreshRepos(signal?: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    logStartupTrace('refresh repos: start');
    const entries = await this.loadRegisteredReposForBackend(signal);
    this.throwIfInitAborted(signal);
    logStartupTrace(
      `refresh repos: ${entries.length} registry entr${entries.length === 1 ? 'y' : 'ies'} matched`,
      startedAt,
    );
    const freshIds = new Set<string>();
    const freshRepos = new Map<string, RepoHandle>();
    const freshContextCache = new Map<string, CodebaseContext>();

    for (const entry of entries) {
      this.throwIfInitAborted(signal);
      const id = this.repoIdFromHandles(entry.name, entry.path, freshRepos);
      freshIds.add(id);

      const storagePath = entry.storagePath;
      const lbugPath = path.join(storagePath, 'lbug');

      // MCP startup must be read-only. Warn about stale Kuzu indexes here, but
      // leave deletion/pruning to explicit maintenance commands.
      const hasOldKuzu = await fs
        .stat(path.join(storagePath, 'kuzu'))
        .then(() => true)
        .catch(() => false);
      if (hasOldKuzu) {
        let hasLbug = true;
        try {
          await fs.access(lbugPath);
        } catch {
          hasLbug = false;
        }
        if (!hasLbug) {
          console.error(
            `OntoIndex: "${entry.name}" has a stale KuzuDB index. Run: ontoindex analyze ${entry.path}`,
          );
        }
      }

      this.throwIfInitAborted(signal);
      const handle: RepoHandle = {
        id,
        name: entry.name,
        repoPath: entry.path,
        storagePath,
        lbugPath,
        indexedAt: entry.indexedAt,
        lastCommit: entry.lastCommit,
        stats: entry.stats,
      };

      freshRepos.set(id, handle);

      // Build lightweight context (no LadybugDB needed)
      const s = entry.stats || {};
      freshContextCache.set(id, {
        projectName: entry.name,
        stats: {
          fileCount: s.files || 0,
          functionCount: s.nodes || 0,
          communityCount: s.communities || 0,
          processCount: s.processes || 0,
        },
      });
    }

    this.throwIfInitAborted(signal);
    this.repos = freshRepos;
    this.contextCache = freshContextCache;
    logStartupTrace(`refresh repos: cache updated with ${freshRepos.size} repo(s)`, startedAt);

    // Prune repos that no longer exist in the registry
    for (const id of this.initializedRepos) {
      if (!freshIds.has(id)) {
        this.initializedRepos.delete(id);
      }
    }
    logStartupTrace('refresh repos: complete', startedAt);
  }

  private repoIdFromHandles(
    name: string,
    repoPath: string,
    repos: Map<string, RepoHandle>,
  ): string {
    const base = name.toLowerCase();
    for (const [id, handle] of repos) {
      if (id === base && handle.repoPath !== path.resolve(repoPath)) {
        const hash = Buffer.from(repoPath).toString('base64url').slice(0, 6);
        return `${base}-${hash}`;
      }
    }
    return base;
  }

  /**
   * Generate a stable repo ID from name + path.
   * If names collide, append a hash of the path.
   */
  private repoId(name: string, repoPath: string): string {
    const base = name.toLowerCase();
    // Check for name collision with a different path
    for (const [id, handle] of this.repos) {
      if (id === base && handle.repoPath !== path.resolve(repoPath)) {
        // Collision — use path hash
        const hash = Buffer.from(repoPath).toString('base64url').slice(0, 6);
        return `${base}-${hash}`;
      }
    }
    return base;
  }

  private matchesRepoFilter(entry: RegistryEntry): boolean {
    if (!this.repoFilter) return true;

    const filter = this.repoFilter.toLowerCase();
    if (entry.name.toLowerCase() === filter) return true;

    const resolvedFilter = path.resolve(this.repoFilter);
    if (path.resolve(entry.path) === resolvedFilter) return true;

    return false;
  }

  private abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    this.throwIfInitAborted(signal);

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.makeInitAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  private async loadRegisteredReposForBackend(signal?: AbortSignal): Promise<RegistryEntry[]> {
    const startedAt = Date.now();
    logStartupTrace('registry load: start');
    const entries = await this.abortable(listRegisteredRepos({ validate: false }), signal);
    this.throwIfInitAborted(signal);
    logStartupTrace(
      `registry load: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} loaded`,
      startedAt,
    );
    const filtered = entries.filter((entry) => this.matchesRepoFilter(entry));
    if (this.repoFilter) {
      logStartupTrace(
        `registry filter "${this.repoFilter}": ${filtered.length}/${entries.length} matched`,
        startedAt,
      );
    }
    return filtered;
  }

  // ─── Repo Resolution ─────────────────────────────────────────────

  /**
   * Resolve which repo to use.
   * - If repoParam is given, match by name or path
   * - If only 1 repo, use it
   * - If 0 or multiple without param, throw with helpful message
   *
   * On a miss, re-reads the registry once in case a new repo was indexed
   * while the MCP server was running.
   */
  async resolveRepo(repoParam?: string): Promise<RepoHandle> {
    const result = this.resolveRepoFromCache(repoParam);
    if (result) return result;

    // Miss — refresh registry and try once more
    await this.init();
    const retried = this.resolveRepoFromCache(repoParam);
    if (retried) return retried;

    // Still no match — throw with helpful message
    if (this.repos.size === 0) {
      throw new Error('No indexed repositories. Run: ontoindex analyze');
    }
    const labels = buildAvailableRepoLabels(this.repos);

    if (repoParam) {
      throw new Error(`Repository "${repoParam}" not found. Available: ${labels.join(', ')}`);
    }
    throw new Error(
      `Multiple repositories indexed. Specify which one with the "repo" parameter. Available: ${labels.join(', ')}`,
    );
  }

  /**
   * Try to resolve a repo from the in-memory cache. Returns null on miss.
   */
  private resolveRepoFromCache(repoParam?: string): RepoHandle | null {
    return resolveRepoFromHandles(this.repos, repoParam);
  }

  // ─── Lazy LadybugDB Init ────────────────────────────────────────────

  private async ensureInitialized(repoId: string): Promise<void> {
    const handle = this.repos.get(repoId);
    if (!handle) throw new Error(`Unknown repo: ${repoId}`);
    return this.withRepoLock(repoId, () =>
      ensureRepoInitialized({
        repoId,
        handle,
        initializedRepos: this.initializedRepos,
        reinitPromises: this.reinitPromises,
        lastStalenessCheck: this.lastStalenessCheck,
        isLbugReady,
        isLbugDbPathReady,
        initLbug,
        closeLbug,
      }),
    );
  }

  async ensureRepoInitialized(repoId: string): Promise<void> {
    return this.ensureInitialized(repoId);
  }

  // ─── Public Getters ──────────────────────────────────────────────

  /**
   * Get context for a specific repo (or the single repo if only one).
   */
  getContext(repoId?: string): CodebaseContext | null {
    if (repoId && this.contextCache.has(repoId)) {
      return this.contextCache.get(repoId)!;
    }
    if (this.repos.size === 1) {
      return this.contextCache.values().next().value ?? null;
    }
    return null;
  }

  /**
   * List all registered repos with their metadata.
   * Re-reads the global registry so newly indexed repos are discovered
   * without restarting the MCP server.
   */
  async listRepos(options: { refresh?: boolean } = {}): Promise<ListReposResult> {
    if (options.refresh !== false) {
      await this.init();
    }
    return [...this.repos.values()].map((h) => ({
      name: h.name,
      path: h.repoPath,
      indexedAt: h.indexedAt,
      lastCommit: h.lastCommit,
      stats: h.stats,
    }));
  }

  // ─── Tool Dispatch ───────────────────────────────────────────────

  async callTool(method: string, params: unknown): Promise<unknown> {
    const start = Date.now();
    let ok = true;
    let result: unknown;
    try {
      const rawResult = await this._callToolImpl(method, params);
      const json = JSON.stringify(rawResult ?? '');
      const guardedJson = guardResponseSize(json);
      result = guardedJson === json ? rawResult : JSON.parse(guardedJson);
      return result;
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      const durationMs = Date.now() - start;
      const normalized = this.normalizeToolParams(params);
      const repoName =
        typeof normalized.repo === 'string' && !normalized.repo.startsWith('@')
          ? normalized.repo
          : '';
      let responseSizeBytes = 0;
      try {
        responseSizeBytes = Buffer.byteLength(JSON.stringify(result ?? ''), 'utf8');
      } catch {
        // ignore serialisation errors
      }
      recordToolCall({
        ts: new Date().toISOString(),
        method,
        repo: repoName,
        durationMs,
        responseSizeBytes,
        ok,
      });
    }
  }

  private async _callToolImpl(method: string, params: unknown): Promise<unknown> {
    if (!KNOWN_METHODS.has(method) && !method.startsWith('group_')) {
      throw new Error(`Unknown tool method: ${method}`);
    }
    if (typeof params !== 'object' || params === null) {
      throw new Error(
        `MCP tool "${method}" requires an object params argument, got ${params === null ? 'null' : typeof params}`,
      );
    }
    const normalized = this.normalizeToolParams(params);

    if (isRepoAgnosticToolName(method)) {
      return this.globalToolHandlers[method](normalized);
    }

    if (method.startsWith('group_')) {
      return this.handleGroupTool(method, normalized);
    }

    if (this.isGroupRepoDispatch(method, normalized)) {
      return this.callToolAtGroupRepo(method, normalized);
    }

    return this.dispatchRepoTool(method, normalized);
  }

  private normalizeToolParams(params: unknown): NormalizedToolParams {
    return params && typeof params === 'object' ? { ...(params as Record<string, unknown>) } : {};
  }

  private isGroupRepoDispatch(method: string, params: NormalizedToolParams): boolean {
    if (method !== 'impact' && method !== 'query' && method !== 'context') return false;
    return typeof params.repo === 'string' && params.repo.startsWith('@');
  }

  private async dispatchRepoTool(method: string, params: NormalizedToolParams): Promise<unknown> {
    const repo = await this.resolveRepo(this.getRepoParam(params));
    const handler = this.repoToolHandlers[method];
    if (!handler) throw new Error(`Unknown tool: ${method}`);
    const result = await handler(repo, params);
    if (method !== 'query' && method !== 'context' && method !== 'impact') return result;
    const warnings = await loadIndexCapabilityWarnings(repo.storagePath);
    return appendIndexCapabilityWarnings(result, warnings);
  }

  private async readLocalEnrichmentMetadata(
    repo: RepoHandle,
    options: LocalEnrichmentConsumptionOptions = {},
  ): Promise<LocalEnrichmentMetadata> {
    const recordStatusCounts = emptyEnrichmentRecordStatusCounts();
    const requests = emptyEnrichmentRequestCounts();
    const storePath = getSidecarStorePath(repo.storagePath);

    try {
      await fs.access(storePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {
          used: false,
          status: 'error',
          error: errorMessage(error),
          recordStatusCounts,
          requests,
          lock: null,
        };
      }
      return {
        used: false,
        status: 'unavailable',
        reason: 'missing-store',
        recordStatusCounts,
        requests,
        lock: null,
      };
    }

    try {
      const state = await loadSidecarStoreState(storePath);
      for (const record of state.enrichments) {
        recordStatusCounts[record.status] += 1;
      }
      for (const request of state.requests) {
        if (request.status === 'queued' || request.status === 'running') {
          requests[request.status] += 1;
        }
      }
      const base = {
        used: false,
        status: 'available',
        recordStatusCounts,
        requests,
        lock: state.lock
          ? {
              ownerId: state.lock.ownerId,
              heartbeatAt: state.lock.heartbeatAt,
            }
          : null,
      } satisfies LocalEnrichmentMetadata;

      if (options.consumeFacts !== true) return base;

      const sourceIndexId = this.inferCurrentEnrichmentSourceIndexId(repo, state);
      if (sourceIndexId === undefined) return base;

      const snapshots = new Map<string, EnrichmentSnapshot>();
      const allFacts: EnrichmentFact[] = [];
      const markdownEntries: MarkdownContextFactEntry[] = [];
      const passiveCandidates: PassiveGraphFactCandidate[] = [];
      const seenPassiveCandidates = new Set<string>();
      const allVisibleRecords: ReturnType<typeof consumeEnrichmentFacts>['visibleRecords'] = [];
      const summary: ReturnType<typeof consumeEnrichmentFacts>['summary'] = {
        visibleRecordCount: 0,
        usedRecordCount: 0,
        usedFactCount: 0,
        rejectedRecordCount: 0,
        partialRecordCount: 0,
        rejectionReasons: {},
      };
      const passiveSelectionSummary: ReturnType<typeof selectPassiveFactCandidates>['summary'] = {
        candidateCount: 0,
        rejectedRecordCount: 0,
        rejectionReasons: {},
      };

      for (const record of state.enrichments) {
        const snapshotKey = `${record.filePath}\0${record.fileHash}`;
        let snapshot = snapshots.get(snapshotKey);
        if (!snapshot) {
          snapshot = {
            sourceIndexId,
            sourceCommitHash: repo.lastCommit,
            schemaVersion: record.schemaVersion,
            analyzerVersion: record.analyzerVersion,
            filePath: record.filePath,
            fileHash: record.fileHash,
          };
          snapshots.set(snapshotKey, snapshot);
        }

        if (options.includePassiveRelatedFacts === true) {
          for (const target of options.passiveTargets ?? []) {
            const selected = selectPassiveFactCandidates([record], snapshot, target, {
              allowLowConfidence: options.allowLowConfidence === true,
            });
            for (const candidate of selected.candidates) {
              const key = passiveCandidateKey(candidate);
              if (!seenPassiveCandidates.has(key)) {
                seenPassiveCandidates.add(key);
                passiveCandidates.push(candidate);
              }
            }
            passiveSelectionSummary.candidateCount += selected.summary.candidateCount;
            passiveSelectionSummary.rejectedRecordCount += selected.summary.rejectedRecordCount;
            for (const [reason, count] of Object.entries(selected.summary.rejectionReasons)) {
              passiveSelectionSummary.rejectionReasons[
                reason as keyof typeof passiveSelectionSummary.rejectionReasons
              ] =
                (passiveSelectionSummary.rejectionReasons[
                  reason as keyof typeof passiveSelectionSummary.rejectionReasons
                ] ?? 0) + count;
            }
          }
        }

        const consumed = consumeEnrichmentFacts([record], snapshot, {
          consumeFacts: true,
          allowLowConfidence: options.allowLowConfidence === true,
          allowSafetyCriticalImpact: options.allowSafetyCriticalImpact === true,
          safety: options.safetyCriticalImpact === true ? 'safety-critical-impact' : 'standard',
        });

        for (const usedRecord of consumed.usedRecords) {
          const source = createMarkdownDocsEvidenceSource(
            usedRecord.record,
            usedRecord.decision,
            undefined,
            options.retrievalPolicy,
          );
          for (const fact of usedRecord.facts) {
            if (isMarkdownDocumentFact(fact)) markdownEntries.push({ fact, source });
          }
        }
        for (const rejectedRecord of consumed.rejectedRecords) {
          if (!shouldIncludeDegradedMarkdownRecord(rejectedRecord.record, rejectedRecord.reason))
            continue;
          const source = createMarkdownDocsEvidenceSource(
            rejectedRecord.record,
            rejectedRecord.decision,
            rejectedRecord.reason,
            options.retrievalPolicy,
          );
          for (const fact of rejectedRecord.record.records) {
            if (isMarkdownDocumentFact(fact)) markdownEntries.push({ fact, source });
          }
        }

        allFacts.push(...consumed.facts);
        allVisibleRecords.push(...consumed.visibleRecords);
        summary.visibleRecordCount += consumed.summary.visibleRecordCount;
        summary.usedRecordCount += consumed.summary.usedRecordCount;
        summary.usedFactCount += consumed.summary.usedFactCount;
        summary.rejectedRecordCount += consumed.summary.rejectedRecordCount;
        summary.partialRecordCount += consumed.summary.partialRecordCount;
        for (const [reason, count] of Object.entries(consumed.summary.rejectionReasons)) {
          summary.rejectionReasons[reason as keyof typeof summary.rejectionReasons] =
            (summary.rejectionReasons[reason as keyof typeof summary.rejectionReasons] ?? 0) +
            count;
        }
      }

      passiveSelectionSummary.candidateCount = passiveCandidates.length;
      const passiveExpansion =
        options.includePassiveRelatedFacts === true
          ? expandPassiveGraph(options.primaryResults ?? [], passiveCandidates, {
              topK: 5,
              maxDepth: 1,
              allowedIdentityTypes: ['symbol', 'file', 'process', 'cluster'],
              snapshot:
                snapshots.values().next().value ??
                ({
                  sourceIndexId,
                  sourceCommitHash: repo.lastCommit,
                  filePath: '',
                  fileHash: '',
                } satisfies EnrichmentSnapshot),
            })
          : undefined;
      const markdownContext =
        options.includeMarkdownContext === true
          ? extractMarkdownContextMetadata(markdownEntries, {
              includePpr: options.includeMarkdownPpr,
              retrievalPolicy: options.retrievalPolicy,
            })
          : undefined;
      const retrievalPolicyMetadata = options.retrievalPolicy
        ? createRetrievalPolicyMetadata(options.retrievalPolicy, markdownContext)
        : undefined;
      const explanation: LocalEnrichmentExplanation | undefined =
        passiveExpansion || markdownContext
          ? {
              retrievers: [
                ...(passiveExpansion?.explanation.retrievers ?? []),
                ...(markdownContext?.explanation.retrievers ?? []),
              ],
            }
          : undefined;

      return {
        ...base,
        used: allFacts.length > 0,
        factConsumption: summary,
        visibleRecords: allVisibleRecords,
        facts: allFacts,
        ...(passiveExpansion && {
          relatedFacts: passiveExpansion.relatedFacts,
          relatedSymbols: addPolicyPathReasons(
            passiveExpansion.relatedSymbols,
            options.retrievalPolicy,
          ),
          relatedIdentities: addPolicyPathReasons(
            passiveExpansion.relatedIdentities,
            options.retrievalPolicy,
          ),
          summary: {
            passiveFactSelection: passiveSelectionSummary,
            passiveGraphExpansion: passiveExpansion.summary,
          },
        }),
        ...(markdownContext && {
          relatedDocs: markdownContext.relatedDocs,
          relatedChunks: markdownContext.relatedChunks,
          ...(markdownContext.markdownPpr && { markdownPpr: markdownContext.markdownPpr }),
          docsEvidence: markdownContext.docsEvidence,
        }),
        ...(retrievalPolicyMetadata && { retrievalPolicy: retrievalPolicyMetadata }),
        ...(explanation && { explanation }),
      };
    } catch (error) {
      return {
        used: false,
        status: 'error',
        error: errorMessage(error),
        recordStatusCounts,
        requests,
        lock: null,
      };
    }
  }

  private inferCurrentEnrichmentSourceIndexId(
    repo: RepoHandle,
    state: Awaited<ReturnType<typeof loadSidecarStoreState>>,
  ): string | undefined {
    if (state.lock?.sourceIndexId) return state.lock.sourceIndexId;
    const activeRequest = state.requests.find(
      (request) => request.status === 'queued' || request.status === 'running',
    );
    if (activeRequest) return activeRequest.sourceIndexId;
    const currentRecord = state.enrichments.find(
      (record) =>
        record.sourceCommitHash === repo.lastCommit &&
        (record.status === 'complete' || record.status === 'partial'),
    );
    return currentRecord?.sourceIndexId;
  }

  private async withLocalEnrichmentMetadata<T>(
    repo: RepoHandle,
    result: T,
    options: LocalEnrichmentConsumptionOptions = {},
  ): Promise<T> {
    if (!isObjectResponse(result)) return result;
    return {
      ...result,
      enrichment: await this.readLocalEnrichmentMetadata(repo, options),
    } as T;
  }

  private getRepoParam(params: NormalizedToolParams): string | undefined {
    return typeof params.repo === 'string' ? params.repo : undefined;
  }

  // ─── Tool Implementations ────────────────────────────────────────

  /**
   * Query tool — process-grouped search.
   *
   * 1. Hybrid search (BM25 + semantic) to find matching symbols
   * 2. Trace each match to its process(es) via STEP_IN_PROCESS
   * 3. Group by process, rank by aggregate relevance + internal cluster cohesion
   * 4. Return: { processes, process_symbols, definitions }
   */
  private async query(
    repo: RepoHandle,
    params: {
      query: string;
      task_context?: string;
      goal?: string;
      limit?: number;
      max_symbols?: number;
      include_content?: boolean;
      consume_enrichment_facts?: boolean;
      include_passive_related_facts?: boolean;
      include_markdown_context?: boolean;
      include_markdown_ppr?: boolean;
      allow_low_confidence?: boolean;
      retrieval_policy?: string;
    },
  ): Promise<QueryResult> {
    await this.ensureInitialized(repo.id);
    const result = await queryImpl(repo as any, params);
    const retrievalPolicy = resolveRetrievalPolicy(params.retrieval_policy);
    const enriched = await this.withLocalEnrichmentMetadata(repo, result, {
      consumeFacts:
        params.consume_enrichment_facts === true || retrievalPolicy?.docsExpansion === true,
      includePassiveRelatedFacts:
        retrievalPolicy?.passiveExpansion === true ||
        (params.consume_enrichment_facts === true && params.include_passive_related_facts === true),
      includeMarkdownContext:
        retrievalPolicy?.docsExpansion === true ||
        (params.consume_enrichment_facts === true &&
          params.include_passive_related_facts === true &&
          params.include_markdown_context === true),
      includeMarkdownPpr:
        params.consume_enrichment_facts === true &&
        params.include_passive_related_facts === true &&
        params.include_markdown_context === true &&
        params.include_markdown_ppr === true,
      allowLowConfidence: params.allow_low_confidence,
      passiveTargets: passiveTargetsFromQueryResult(result),
      primaryResults: primaryResultsFromQueryResult(result),
      retrievalPolicy,
    });
    const enrichedRecord: Record<string, unknown> | undefined = isObjectResponse(enriched)
      ? enriched
      : undefined;
    const enrichmentValue = enrichedRecord?.enrichment;
    const enrichment = isObjectResponse(enrichmentValue) ? enrichmentValue : undefined;
    if (
      retrievalPolicy ||
      (params.consume_enrichment_facts === true && params.include_passive_related_facts === true)
    ) {
      return attachRetrievalPolicyMetadata(
        {
          ...enriched,
          explanation: enrichment?.explanation,
        } as unknown as QueryResult,
        enrichment,
        retrievalPolicy,
      );
    }
    return enriched;
  }

  async executeCypher(repoName: string, query: string): Promise<CypherQueryResult> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);
    return queryCypher(repo, { query });
  }

  private async overview(
    repo: RepoHandle,
    params: { showClusters?: boolean; showProcesses?: boolean; limit?: number },
  ): Promise<OverviewResult> {
    await this.ensureInitialized(repo.id);

    const limit = normalizeLimit(params.limit, 20);
    const result: OverviewResult = {
      repo: repo.name,
      repoPath: repo.repoPath,
      stats: repo.stats,
      indexedAt: repo.indexedAt,
      lastCommit: repo.lastCommit,
    };

    if (params.showClusters !== false) {
      result.clusters = (await queryClustersImpl(repo, limit)).clusters;
    }

    if (params.showProcesses !== false) {
      result.processes = (await queryProcessesImpl(repo, limit)).processes;
    }

    return result;
  }

  /**
   * Context tool — 360-degree symbol view with categorized refs.
   * Disambiguation (ranked) when multiple symbols share a name.
   * UID-based direct lookup. No cluster in output.
   */
  private async context(
    repo: RepoHandle,
    params: {
      name?: string;
      uid?: string;
      file_path?: string;
      kind?: string;
      include_content?: boolean;
      consume_enrichment_facts?: boolean;
      include_passive_related_facts?: boolean;
      include_markdown_context?: boolean;
      include_markdown_ppr?: boolean;
      allow_low_confidence?: boolean;
      retrieval_policy?: string;
      neighborhood_mode?: ContextParams['neighborhood_mode'];
      depth?: number;
      limit?: number;
      maxCandidates?: number;
      route?: string;
      process_id?: string;
      requirement_id?: string;
      api_doc_id?: string;
      doc_path?: string;
    },
  ): Promise<ContextResult> {
    if (params.file_path) canonicalize(repo.repoPath, params.file_path);
    await this.ensureInitialized(repo.id);
    if (params.neighborhood_mode) {
      return runContextNeighborhood(repo, params) as Promise<ContextResult>;
    }
    const result = await contextImpl(repo, params);
    const retrievalPolicy = resolveRetrievalPolicy(params.retrieval_policy);
    const enriched = await this.withLocalEnrichmentMetadata(repo, result, {
      consumeFacts:
        params.consume_enrichment_facts === true || retrievalPolicy?.docsExpansion === true,
      includePassiveRelatedFacts:
        retrievalPolicy?.passiveExpansion === true ||
        (params.consume_enrichment_facts === true && params.include_passive_related_facts === true),
      includeMarkdownContext:
        retrievalPolicy?.docsExpansion === true ||
        (params.consume_enrichment_facts === true &&
          params.include_passive_related_facts === true &&
          params.include_markdown_context === true),
      includeMarkdownPpr:
        params.consume_enrichment_facts === true &&
        params.include_passive_related_facts === true &&
        params.include_markdown_context === true &&
        params.include_markdown_ppr === true,
      allowLowConfidence: params.allow_low_confidence,
      passiveTargets: passiveTargetsFromContextResult(result as ContextResult),
      primaryResults: primaryResultsFromContextResult(result as ContextResult),
      retrievalPolicy,
    });
    const enrichedRecord: Record<string, unknown> | undefined = isObjectResponse(enriched)
      ? enriched
      : undefined;
    const enrichmentValue = enrichedRecord?.enrichment;
    const enrichment = isObjectResponse(enrichmentValue) ? enrichmentValue : undefined;
    if (
      retrievalPolicy ||
      (params.consume_enrichment_facts === true && params.include_passive_related_facts === true)
    ) {
      return attachRetrievalPolicyMetadata(
        {
          ...(enriched as Record<string, unknown>),
          explanation: enrichment?.explanation,
        } as unknown as ContextResult,
        enrichment,
        retrievalPolicy,
      );
    }
    return enriched;
  }

  /**
   * Rename tool — multi-file coordinated rename using graph + text search.
   * Graph refs are tagged "graph" (high confidence).
   * Additional refs found via text search are tagged "text_search" (lower confidence).
   */
  private async rename(
    repo: RepoHandle,
    params: {
      symbol_name?: string;
      symbol_uid?: string;
      new_name: string;
      file_path?: string;
      dry_run?: boolean;
    },
  ): Promise<RenameResult> {
    if (params.file_path) canonicalize(repo.repoPath, params.file_path);
    await this.ensureInitialized(repo.id);
    return renameSymbol(
      repo,
      params,
      (name, uid, filePath) =>
        this.context(repo, {
          name,
          uid,
          file_path: filePath,
        }) as Promise<RenameLookupResult>,
    );
  }

  /**
   * rename_symbol — UID-anchored rename. Resolves symbol by UID then delegates
   * to the same renameSymbol engine as `rename`, guaranteeing zero-ambiguity.
   */
  private async renameByUid(
    repo: RepoHandle,
    params: {
      uid: string;
      new_name: string;
      dry_run?: boolean;
      confirm?: boolean;
    },
  ): Promise<RenameResult> {
    await this.ensureInitialized(repo.id);
    return renameSymbol(
      repo,
      { symbol_uid: params.uid, new_name: params.new_name, dry_run: params.dry_run },
      (name, uid, filePath) =>
        this.context(repo, { name, uid, file_path: filePath }) as Promise<RenameLookupResult>,
    );
  }

  private async impact(
    repo: RepoHandle,
    params: {
      target: string;
      target_uid?: string;
      file_path?: string;
      kind?: string;
      direction: 'upstream' | 'downstream';
      maxDepth?: number;
      relationTypes?: string[];
      includeTests?: boolean;
      minConfidence?: number;
      consume_enrichment_facts?: boolean;
      allow_low_confidence?: boolean;
      allow_safety_critical_enrichment?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<ImpactResult> {
    if (params.file_path) canonicalize(repo.repoPath, params.file_path);
    await this.ensureInitialized(repo.id);
    return this.withLocalEnrichmentMetadata(repo, await runImpact(repo, params), {
      consumeFacts: params.consume_enrichment_facts,
      allowLowConfidence: params.allow_low_confidence,
      allowSafetyCriticalImpact: params.allow_safety_critical_enrichment,
      safetyCriticalImpact: true,
    });
  }

  /**
   * UID-based impact for cross-repo fan-out. Same result shape as `impact`.
   * Returns null if the repo is unknown, the UID is missing, or analysis fails.
   */
  async impactByUid(
    repoId: string,
    uid: string,
    direction: string,
    opts: {
      maxDepth: number;
      relationTypes: string[];
      minConfidence: number;
      includeTests: boolean;
    },
  ): Promise<ImpactByUidResult | null> {
    try {
      await this.init();
      await this.ensureInitialized(repoId);
    } catch {
      return null;
    }

    const repo = this.repos.get(repoId);
    if (!repo) return null;
    return impactByUidImpl(repo, uid, direction, opts);
  }

  private handleGroupTool(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'group_list':
        return this.groupList(params);
      case 'group_sync':
        return this.groupSync(params);
      default:
        throw new Error(
          `Unknown group tool: ${method}. Removed tools: use repo "@<groupName>" on impact, query, or context (optional "/<memberPath>"), or MCP resources.`,
        );
    }
  }

  /**
   * Dispatch impact/query/context when `repo` is `@groupName` or `@groupName/memberPath`
   * (group mode — not the global indexed-repo `repo` parameter).
   */
  private async callToolAtGroupRepo(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    await this.init();

    if (
      params.service !== undefined &&
      params.service !== null &&
      String(params.service).trim() === ''
    ) {
      return { error: 'service must not be an empty string' };
    }

    const raw = String(params.repo).slice(1);
    const slash = raw.indexOf('/');
    const groupName = (slash === -1 ? raw : raw.slice(0, slash)).trim();
    const memberRest = slash === -1 ? undefined : raw.slice(slash + 1).trim() || undefined;

    const resolved = await resolveAtGroupMemberRepoPath(groupName, memberRest);
    if (resolved.ok === false) return { error: resolved.error };

    const svc = this.getGroupService();
    if (method === 'impact') {
      const impactArgs: Record<string, unknown> = {
        name: groupName,
        repo: resolved.repoPath,
        target: params.target,
        direction: params.direction,
      };
      if (params.maxDepth !== undefined) impactArgs.maxDepth = params.maxDepth;
      if (params.crossDepth !== undefined) impactArgs.crossDepth = params.crossDepth;
      if (params.relationTypes !== undefined) impactArgs.relationTypes = params.relationTypes;
      if (params.includeTests !== undefined) impactArgs.includeTests = params.includeTests;
      if (params.minConfidence !== undefined) impactArgs.minConfidence = params.minConfidence;
      if (params.service !== undefined && params.service !== null)
        impactArgs.service = params.service;
      if (typeof params.subgroup === 'string') impactArgs.subgroup = params.subgroup;
      if (params.timeoutMs !== undefined) impactArgs.timeoutMs = params.timeoutMs;
      if (params.timeout !== undefined) impactArgs.timeout = params.timeout;
      return svc.groupImpact(impactArgs);
    }
    if (method === 'query') {
      const queryArgs: Record<string, unknown> = {
        name: groupName,
        query: params.query,
      };
      if (typeof params.task_context === 'string') queryArgs.task_context = params.task_context;
      if (typeof params.goal === 'string') queryArgs.goal = params.goal;
      if (typeof params.limit === 'number') queryArgs.limit = params.limit;
      if (typeof params.max_symbols === 'number') queryArgs.max_symbols = params.max_symbols;
      if (params.include_content !== undefined) queryArgs.include_content = params.include_content;
      if (params.service !== undefined && params.service !== null)
        queryArgs.service = params.service;
      if (memberRest !== undefined) {
        queryArgs.subgroup = memberRest;
        queryArgs.subgroupExact = true;
      }
      return svc.groupQuery(queryArgs);
    }
    if (method === 'context') {
      const targetSym =
        typeof params.target === 'string' && params.target.trim() !== ''
          ? params.target.trim()
          : typeof params.name === 'string' && params.name.trim() !== ''
            ? params.name.trim()
            : undefined;
      const contextArgs: Record<string, unknown> = {
        name: groupName,
        target: targetSym,
      };
      if (typeof params.uid === 'string') contextArgs.uid = params.uid;
      if (typeof params.file_path === 'string') contextArgs.file_path = params.file_path;
      if (params.include_content !== undefined)
        contextArgs.include_content = params.include_content;
      if (params.service !== undefined && params.service !== null)
        contextArgs.service = params.service;
      if (memberRest !== undefined) {
        contextArgs.subgroup = memberRest;
        contextArgs.subgroupExact = true;
      }
      return svc.groupContext(contextArgs);
    }
    throw new Error(`Internal: unsupported group-repo tool ${method}`);
  }

  private async groupList(params: Record<string, unknown>): Promise<unknown> {
    return this.getGroupService().groupList(params);
  }

  private async groupSync(params: Record<string, unknown>): Promise<unknown> {
    return this.getGroupService().groupSync(params);
  }

  /**
   * MCP resource body for `ontoindex://group/{name}/contracts` (Issue #794).
   */
  async readGroupContractsResource(
    groupName: string,
    filter: { type?: string; repo?: string; unmatchedOnly?: boolean },
  ): Promise<string> {
    try {
      const params: Record<string, unknown> = { name: groupName };
      if (filter.type !== undefined) params.type = filter.type;
      if (filter.repo !== undefined) params.repo = filter.repo;
      if (filter.unmatchedOnly === true) params.unmatchedOnly = true;
      const raw = await this.getGroupService().groupContracts(params);
      return LocalBackend.formatGroupResourcePayload(raw);
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * MCP resource body for `ontoindex://group/{name}/status` (Issue #794).
   */
  async readGroupStatusResource(groupName: string): Promise<string> {
    try {
      const raw = await this.getGroupService().groupStatus({ name: groupName });
      return LocalBackend.formatGroupResourcePayload(raw);
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private static formatGroupResourcePayload(raw: unknown): string {
    if (raw && typeof raw === 'object' && 'error' in raw) {
      const err = (raw as { error?: unknown }).error;
      if (typeof err === 'string' && err.length > 0) {
        return `error: ${err}`;
      }
    }
    return JSON.stringify(raw, null, 2);
  }

  /**
   * Replace-symbol tool — structured rewrite of a symbol's body.
   *
   * Two-layer gate:
   *   1. `dry_run: true` (default-off in the test) short-circuits to a
   *      no-op success — callers planning a change can preview without
   *      any confirmation.
   *   2. Otherwise the write path requires BOTH `confirm: true` on the
   *      call AND `confirmWrites: true` on the backend. A missing call
   *      confirm throws "Explicit confirmation required"; a backend
   *      with writes disabled throws "Write operations are disabled"
   *      even when the caller confirmed.
   *
   * The actual rewrite is deferred — this is the gate today, same
   * pattern as sandbox(). Future wiring inherits the safety contract.
   */
  private async replaceSymbol(
    _repo: RepoHandle,
    params: { uid?: string; new_body?: string; dry_run?: boolean; confirm?: boolean },
  ): Promise<{ success: true; dry_run: boolean; uid?: string }> {
    return replaceSymbolImpl(_repo, params, this.confirmWrites);
  }

  private async getSymbolInfo(
    repo: RepoHandle,
    params: { uid: string },
  ): Promise<GetSymbolInfoResult> {
    return getSymbolInfoImpl(repo, params, (id) => this.ensureInitialized(id));
  }

  private async updateSymbolBody(
    repo: RepoHandle,
    params: { uid: string; new_body: string; dry_run?: boolean; confirm?: boolean },
  ): Promise<UpdateSymbolBodyResult> {
    return updateSymbolBodyImpl(repo, params, this.confirmWrites, (id) =>
      this.ensureInitialized(id),
    );
  }

  private async extractFunctionByUid(
    repo: RepoHandle,
    params: {
      uid: string;
      new_name: string;
      target_file?: string;
      dry_run?: boolean;
      confirm?: boolean;
    },
  ): Promise<ExtractFunctionByUidResult> {
    return extractFunctionByUidImpl(repo, params, this.confirmWrites, (id) =>
      this.ensureInitialized(id),
    );
  }

  private async moveSymbolByUid(
    repo: RepoHandle,
    params: {
      uid: string;
      target_file: string;
      dry_run?: boolean;
      confirm?: boolean;
    },
  ): Promise<MoveSymbolByUidResult> {
    return moveSymbolByUidImpl(repo, params, this.confirmWrites, (id) =>
      this.ensureInitialized(id),
    );
  }

  /**
   * Sandbox tool — stage/apply mutations inside a write transaction.
   *
   * Current surface is the confirmation gate only: `apply` requires
   * `confirm: true` (same shape as replace_symbol) so an accidental
   * `callTool('sandbox', { action: 'apply' })` can never mutate. `stage`
   * is idempotent and gate-free. The actual write path is deferred —
   * this method ships the gate now so future mutation wiring inherits
   * the safety contract instead of bolting it on later.
   */
  private async sandbox(
    _repo: RepoHandle,
    params: { action?: string; confirm?: boolean; payload?: unknown },
  ): Promise<{ success: true; action: string; payload?: unknown }> {
    return sandboxImpl(_repo, params);
  }

  // ─── Direct Graph Queries (for resources.ts) ────────────────────

  /**
   * Query clusters (communities) directly from graph.
   * Used by getClustersResource — avoids legacy overview() dispatch.
   */
  async queryClusters(repoName?: string, limit = 100): Promise<QueryClustersResult> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);
    return queryClustersImpl(repo, limit);
  }

  /**
   * Query processes directly from graph.
   * Used by getProcessesResource — avoids legacy overview() dispatch.
   */
  async queryProcesses(repoName?: string, limit = 50): Promise<QueryProcessesResult> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);
    return queryProcessesImpl(repo, limit);
  }

  /**
   * Query cluster detail (members) directly from graph.
   * Used by getClusterDetailResource.
   */
  async queryClusterDetail(
    name: string,
    repoName?: string,
  ): Promise<QueryClusterDetailWrapperResult> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);
    return queryClusterDetailImpl(repo, name) as Promise<QueryClusterDetailWrapperResult>;
  }

  /**
   * Query process detail (steps) directly from graph.
   * Used by getProcessDetailResource.
   */
  async queryProcessDetail(
    name: string,
    repoName?: string,
  ): Promise<QueryProcessDetailWrapperResult> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);
    return queryProcessDetailImpl(repo, name) as Promise<QueryProcessDetailWrapperResult>;
  }

  async dispose(): Promise<void> {
    await closeLbug(); // close all connections
    // Note: we intentionally do NOT call disposeEmbedder() here.
    // ONNX Runtime's native cleanup segfaults on macOS and some Linux configs,
    // and importing the embedder module on Node v24+ crashes if onnxruntime
    // was never loaded during the session. Since process.exit(0) follows
    // immediately after disconnect(), the OS reclaims everything. See #38, #89.
    this.repos.clear();
    this.contextCache.clear();
    this.initializedRepos.clear();
  }

  async disconnect(): Promise<void> {
    await this.dispose();
  }
}

type AssertAssignable<Actual extends Expected, Expected> = Actual;
type _LocalBackendConsumesBackendPortSlice = AssertAssignable<
  LocalBackend,
  Pick<BackendPort, 'init' | 'callTool' | 'dispose'>
>;
