/**
 * gn_diagnose — Read-only system-status report with actionable recommendations.
 *
 * Checks index freshness, embeddings, LSP server availability, and ONTOINDEX_*
 * environment variables, then synthesises a ranked recommendation list.
 *
 * This is a fully read-only super-function: it never modifies the index,
 * environment, or filesystem.
 */

import { gnEnsureFresh } from './ensure-fresh.js';
import type { EmbeddingDriftStatus } from './ensure-fresh.js';
import { gnToolContract } from './tool-contract.js';
import type { ToolContractReport } from './tool-contract.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  getAuditProjectionPath,
  computeAuditFreshness,
} from '../../core/audit-lifecycle/index.js';
import { createEnvelopeFromLegacy } from '../shared/response-envelope.js';
import type { CapabilityResponseEnvelope } from '../shared/response-envelope.js';
import { shellQuote } from '../shared/repo-resolution-errors.js';
import { resolveTargetContext } from '../shared/target-context.js';
import type { ScopeConfidence, TargetContext } from '../shared/target-context.js';
import { execFileText } from '../../core/process/exec-file.js';
import {
  collectFileScopePreview,
  explainPathScope,
} from '../../core/indexing/file-scope-preview.js';
import { getSemanticVectorBackendStatus } from '../../core/embeddings/zvec-semantic-backend.js';
import type { SemanticVectorBackendStatus } from '../../core/embeddings/zvec-semantic-backend.js';
import type {
  FileScopeExplanation,
  FileScopePreview,
} from '../../core/indexing/file-scope-preview.js';
import type { RuntimeHealthSnapshot } from '../../core/runtime/runtime-health.js';
import { readToolTelemetrySummary } from '../local/tool-telemetry.js';
import { RESPONSE_GUARD_MAX_BYTES } from '../local/response-guard.js';
import { getResourceContractSummaries } from '../resources.js';
import { createEmptyEvidenceReadClassCounts } from '../../core/runtime/evidence-read-ledger.js';
import type { EvidenceReadClass } from '../../core/runtime/evidence-read-ledger.js';
import { getStoragePaths } from '../../storage/repo-manager.js';
import { getLbugRuntimeDiagnostics } from '../../core/lbug/lbug-adapter.js';

const WHICH_TIMEOUT_MS = 2_000;
const WHICH_MAX_BUFFER = 64 * 1024;
const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_MCP_CYPHER_LIMIT_MAX = 5_000;
const DEFAULT_PROCESS_DETAIL_STEP_LIMIT = 1_000;
const DEFAULT_HTTP_MCP_MAX_SESSIONS = 32;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiagnoseParams {
  checkLsp?: boolean; // default: true
  checkEmbeddings?: boolean; // default: true
  checkIndexFreshness?: boolean; // default: true
  checkToolContract?: boolean; // default: true
  includeFileScopePreview?: boolean;
  explainFile?: string;
  fileScopeLimit?: number;
  legacyResponse?: boolean;
}

export interface AuditFreshnessReport {
  status: 'clean' | 'stale' | 'dirty' | 'missing' | 'unknown';
  targetHead?: string;
  currentHead?: string;
  sessionId?: string;
  repairCommand?: string;
}

export interface McpResourceBridgeReport {
  exposed: boolean;
  exposedTo: string[];
}

function auditReplayCommand(sessionId: string | undefined): string | undefined {
  const normalized = sessionId?.trim();
  if (!normalized) return undefined;
  return `gn_audit_replay({session: "${normalized}"})`;
}

function hasCodexCompatibleMcpSection(content: string): boolean {
  return /^\[mcp_servers\.ontoindex(?:\.[^\]]+)?\]/m.test(content);
}

export interface DiagnoseReport {
  version: 1;
  indexFreshness?: { isStale: boolean; indexedCommit: string; currentCommit: string };
  embeddings?: {
    count: number;
    populated: boolean;
    status: EmbeddingDriftStatus;
    reason?: string;
    repairCommand?: string;
  };
  lspAvailable?: { typescript: boolean; python: boolean; rust: boolean };
  classification: {
    evidenceClasses: Array<{
      evidenceClass: EvidenceReadClass;
      auditAuthority: 'verified-only' | 'context-only' | 'advisory-only' | 'none';
      note: string;
    }>;
    resourceContracts: {
      definitions: number;
      templates: number;
      total: number;
      byEvidenceClass: Record<EvidenceReadClass, number>;
      suitability: { auditEligible: number; docs: number; diagnostics: number };
    };
  };
  setup: {
    mcp: {
      repoFilter: string | null;
      autoAnalyze: 'enabled' | 'disabled' | 'unset';
      startupTimeoutMs: number;
      startupTrace: boolean;
    };
    auth: {
      httpApiToken: 'configured-env-token' | 'generated-per-process';
      enforcement: 'metadata-only';
    };
  };
  responseLimits: {
    mcpCypherLimitMax: number;
    processDetailStepLimit: number;
    httpMcpSessionCap: number;
    truncationPolicy: string;
  };
  responseBudgetHealth: {
    guardLimitBytes: number;
    recentOversizedTools: string[];
    guardedPreviewAvailable: true;
  };
  toolTelemetrySummary: {
    recentOversizedCount: number;
    recentOversizedTools: string[];
  };
  runtimeContextSummary: {
    repoLabel?: string;
    repoPath?: string;
    targetHead?: string;
    indexedHead?: string;
    freshness: 'fresh' | 'stale' | 'unknown';
    scopeConfidence?: ScopeConfidence;
    dirtyWorktree: boolean | null;
    dirtyFileCount: number | null;
    embeddings: 'available' | 'absent' | 'unknown';
    sidecar: string;
    qualityMode: string;
    nextRepairCommands: string[];
  };
  vectorBackend?: SemanticVectorBackendStatus;
  degradedContext: {
    status: 'ok' | 'degraded';
    reasons: string[];
    affectedAreas: string[];
    confidence: 'full' | 'reduced';
  };
  misconfiguration: {
    status: 'ok' | 'fail';
    severity?: 'P1';
    reason?: 'mcp-service-target-mismatch';
    requestedRepo?: string;
    activeRepoLabel?: string;
    activeRepoPath?: string;
    mcpRepo?: string;
    projectCwd?: string;
    processCwd?: string;
    recommendedCommand?: string;
  };
  targetContext?: TargetContext;
  runtimeHealth?: RuntimeHealthSnapshot;
  fileScopePreview?: FileScopePreview;
  fileScopeExplanation?: FileScopeExplanation;
  toolContract?: Pick<
    ToolContractReport,
    'status' | 'runtime' | 'advertised' | 'callable' | 'missing' | 'extras'
  >;
  auditFreshness?: AuditFreshnessReport;
  mcpResourceBridge?: McpResourceBridgeReport;
  support?: {
    lbugStore: {
      path: string;
      exists: boolean;
      sizeBytes?: number;
      modifiedAt?: string;
      walPresent: boolean;
      lockPresent: boolean;
    };
    ladybugExtensions: {
      hintDir: string | null;
      ftsAvailable: boolean;
      vectorAvailable: boolean;
    };
    timeoutHints: {
      nativeGetAllMs: number;
    };
  };
  envVars: Record<string, string | undefined>;
  recommendations: Array<{ severity: 'INFO' | 'WARN' | 'ERROR'; detail: string; fix: string }>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Probe whether a binary is on PATH via `which`. Returns true if found. */
async function probeWhich(binaryName: string): Promise<boolean> {
  try {
    await execFileText('which', [binaryName], {
      timeoutMs: WHICH_TIMEOUT_MS,
      maxBuffer: WHICH_MAX_BUFFER,
    });
    return true;
  } catch {
    // ENOENT (not found) or non-zero exit — treat as unavailable
    return false;
  }
}

/** Collect all ONTOINDEX_* keys from process.env. */
function collectOntoIndexEnv(): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ONTOINDEX_')) {
      result[key] = process.env[key];
    }
  }
  return result;
}

function parseTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  options?: { min?: number; max?: number },
): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const min = options?.min ?? 1;
  const max = options?.max ?? Number.MAX_SAFE_INTEGER;
  return Math.max(min, Math.min(max, parsed));
}

function buildClassificationSummary(): DiagnoseReport['classification'] {
  const contracts = getResourceContractSummaries();
  const byEvidenceClass = createEmptyEvidenceReadClassCounts();

  let definitions = 0;
  let templates = 0;
  let auditEligible = 0;
  let docs = 0;
  let diagnostics = 0;

  for (const entry of contracts) {
    byEvidenceClass[entry.contract.evidenceClass] += 1;
    if (entry.kind === 'definition') definitions += 1;
    else templates += 1;
    if (entry.contract.suitability.audit === 'verified-only') auditEligible += 1;
    if (entry.contract.suitability.docs) docs += 1;
    if (entry.contract.suitability.diagnostics) diagnostics += 1;
  }

  return {
    evidenceClasses: [
      {
        evidenceClass: 'graph_evidence',
        auditAuthority: 'verified-only',
        note: 'Supports audit findings when freshness/verification gates pass.',
      },
      {
        evidenceClass: 'docs_evidence',
        auditAuthority: 'context-only',
        note: 'Documentation context only; cannot override code evidence.',
      },
      {
        evidenceClass: 'audit_evidence',
        auditAuthority: 'verified-only',
        note: 'Produced by audit/verification gates and can support status decisions.',
      },
      {
        evidenceClass: 'runtime_diagnostic',
        auditAuthority: 'none',
        note: 'Operational diagnostics only; not audit evidence.',
      },
      {
        evidenceClass: 'advisory_memory',
        auditAuthority: 'advisory-only',
        note: 'Advisory memory only; never authoritative for audit status.',
      },
      {
        evidenceClass: 'unknown',
        auditAuthority: 'none',
        note: 'Unclassified source; avoid recommendation authority until classified.',
      },
    ],
    resourceContracts: {
      definitions,
      templates,
      total: contracts.length,
      byEvidenceClass,
      suitability: { auditEligible, docs, diagnostics },
    },
  };
}

function buildSetupSummary(envVars: Record<string, string | undefined>): DiagnoseReport['setup'] {
  const autoAnalyzeRaw = envVars['ONTOINDEX_MCP_AUTO_ANALYZE'];
  const autoAnalyze =
    autoAnalyzeRaw === undefined ? 'unset' : parseTruthy(autoAnalyzeRaw) ? 'enabled' : 'disabled';

  return {
    mcp: {
      repoFilter: envVars['ONTOINDEX_MCP_REPO']?.trim() || null,
      autoAnalyze,
      startupTimeoutMs: parsePositiveInt(
        envVars['ONTOINDEX_MCP_STARTUP_TIMEOUT_MS'],
        DEFAULT_MCP_STARTUP_TIMEOUT_MS,
      ),
      startupTrace: parseTruthy(envVars['ONTOINDEX_MCP_STARTUP_TRACE']),
    },
    auth: {
      httpApiToken:
        envVars['ONTOINDEX_HTTP_TOKEN'] && envVars['ONTOINDEX_HTTP_TOKEN']!.trim().length > 0
          ? 'configured-env-token'
          : 'generated-per-process',
      enforcement: 'metadata-only',
    },
  };
}

function buildResponseLimits(
  envVars: Record<string, string | undefined>,
): DiagnoseReport['responseLimits'] {
  return {
    mcpCypherLimitMax: parsePositiveInt(
      envVars['ONTOINDEX_MCP_CYPHER_LIMIT_MAX'] ?? envVars['ONTOINDEX_API_QUERY_LIMIT_MAX'],
      DEFAULT_MCP_CYPHER_LIMIT_MAX,
      { max: 50_000 },
    ),
    processDetailStepLimit: parsePositiveInt(
      envVars['ONTOINDEX_PROCESS_DETAIL_STEP_LIMIT'],
      DEFAULT_PROCESS_DETAIL_STEP_LIMIT,
      { max: 10_000 },
    ),
    httpMcpSessionCap: parsePositiveInt(
      envVars['ONTOINDEX_HTTP_MCP_MAX_SESSIONS'],
      DEFAULT_HTTP_MCP_MAX_SESSIONS,
      { max: 256 },
    ),
    truncationPolicy:
      'Bounded responses preferred. Surfaces emit truncation/cursor markers when limits clip output.',
  };
}

async function readOptionalFileStat(filePath: string): Promise<{
  exists: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
}> {
  try {
    const info = await fs.stat(filePath);
    return {
      exists: true,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    };
  } catch {
    return { exists: false };
  }
}

async function buildSupportDiagnostics(repoPath: string): Promise<NonNullable<DiagnoseReport['support']>> {
  const { lbugPath } = getStoragePaths(repoPath);
  const [storeStat, walStat, lockStat, runtime] = await Promise.all([
    readOptionalFileStat(lbugPath),
    readOptionalFileStat(`${lbugPath}.wal`),
    readOptionalFileStat(`${lbugPath}.lock`),
    getLbugRuntimeDiagnostics(),
  ]);
  return {
    lbugStore: {
      path: lbugPath,
      exists: storeStat.exists,
      ...(storeStat.sizeBytes === undefined ? {} : { sizeBytes: storeStat.sizeBytes }),
      ...(storeStat.modifiedAt === undefined ? {} : { modifiedAt: storeStat.modifiedAt }),
      walPresent: walStat.exists,
      lockPresent: lockStat.exists,
    },
    ladybugExtensions: {
      hintDir: runtime.extensionHintDir,
      ftsAvailable: runtime.extensions.fts.available,
      vectorAvailable: runtime.extensions.vector.available,
    },
    timeoutHints: {
      nativeGetAllMs: runtime.getAllTimeoutMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

function buildMisconfigurationReport(
  repoId: string,
  envVars: Record<string, string | undefined>,
  targetContext: TargetContext | undefined,
): DiagnoseReport['misconfiguration'] {
  const mcpRepo = envVars['ONTOINDEX_MCP_REPO']?.trim() || undefined;
  const projectCwd = envVars['ONTOINDEX_MCP_PROJECT_CWD']?.trim() || undefined;
  const processCwd = process.cwd();
  const activeRepoPath = targetContext?.repoPath;
  const activeRepoLabel = targetContext?.repoLabel ?? targetContext?.repoKey;
  const pathMismatch =
    activeRepoPath !== undefined &&
    ((projectCwd !== undefined && path.resolve(projectCwd) !== path.resolve(activeRepoPath)) ||
      (mcpRepo !== undefined &&
        path.isAbsolute(mcpRepo) &&
        path.resolve(mcpRepo) !== path.resolve(activeRepoPath)));
  const targetMismatch =
    targetContext?.status === 'ambiguous' || targetContext?.status === 'not-found' || pathMismatch;

  if (!targetMismatch) return { status: 'ok' };

  const restartPath = activeRepoPath ?? projectCwd ?? mcpRepo ?? '/absolute/path/to/project';
  return {
    status: 'fail',
    severity: 'P1',
    reason: 'mcp-service-target-mismatch',
    requestedRepo: repoId,
    ...(activeRepoLabel !== undefined ? { activeRepoLabel } : {}),
    ...(activeRepoPath !== undefined ? { activeRepoPath } : {}),
    ...(mcpRepo !== undefined ? { mcpRepo } : {}),
    ...(projectCwd !== undefined ? { projectCwd } : {}),
    processCwd,
    recommendedCommand: `ontoindex mcp --project ${shellQuote(restartPath)}${
      repoId ? ` --repo ${shellQuote(repoId)}` : ''
    }`,
  };
}

function buildRuntimeContextSummary(options: {
  targetContext?: TargetContext;
  runtimeHealth?: RuntimeHealthSnapshot;
  indexFreshness?: DiagnoseReport['indexFreshness'];
  embeddings?: DiagnoseReport['embeddings'];
  recommendations: DiagnoseReport['recommendations'];
}): DiagnoseReport['runtimeContextSummary'] {
  const { targetContext, runtimeHealth, indexFreshness, embeddings, recommendations } = options;
  const nextRepairCommands = [...new Set(recommendations.map((r) => r.fix).filter(Boolean))].slice(
    0,
    5,
  );
  return {
    ...(targetContext?.status === 'ok'
        ? {
            repoLabel: targetContext.repoLabel ?? targetContext.repoKey,
            repoPath: targetContext.repoPath,
            targetHead: targetContext.targetHead ?? targetContext.currentHead ?? undefined,
            indexedHead: targetContext.indexedHead ?? undefined,
            scopeConfidence: targetContext.scopeConfidence ?? 'unknown',
          }
        : runtimeHealth
        ? {
            repoLabel: runtimeHealth.repoLabel,
            repoPath: runtimeHealth.repoPath,
            targetHead: runtimeHealth.currentCommit || undefined,
            indexedHead: runtimeHealth.indexedCommit || undefined,
            scopeConfidence: 'unknown',
          }
        : {}),
    freshness:
      indexFreshness === undefined ? 'unknown' : indexFreshness.isStale ? 'stale' : 'fresh',
    dirtyWorktree: targetContext?.dirtyWorktree ?? runtimeHealth?.dirtyWorktree ?? null,
    dirtyFileCount: targetContext?.dirtyFileCount ?? null,
    embeddings:
      embeddings === undefined
        ? 'unknown'
        : embeddings.status === 'ok'
          ? 'available'
          : embeddings.status === 'metadata-unavailable'
            ? 'unknown'
            : 'absent',
    sidecar:
      targetContext?.status === 'ok'
        ? targetContext.sidecar.status
        : (targetContext?.status ?? 'unknown'),
    qualityMode: targetContext?.status === 'ok' ? targetContext.qualityMode : 'unknown',
    nextRepairCommands,
  };
}

export async function gnDiagnose(
  repoId: string,
  params: DiagnoseParams & { legacyResponse?: true },
): Promise<DiagnoseReport>;
export async function gnDiagnose(
  repoId: string,
  params: DiagnoseParams & { legacyResponse: false },
): Promise<CapabilityResponseEnvelope<Record<string, unknown>>>;
export async function gnDiagnose(
  repoId: string,
  params: DiagnoseParams,
): Promise<DiagnoseReport | CapabilityResponseEnvelope<Record<string, unknown>>>;
export async function gnDiagnose(
  repoId: string,
  params: DiagnoseParams,
): Promise<DiagnoseReport | CapabilityResponseEnvelope<Record<string, unknown>>> {
  const warnings: string[] = [];
  const recommendations: DiagnoseReport['recommendations'] = [];

  const checkLsp = params.checkLsp !== false;
  const checkEmbeddings = params.checkEmbeddings !== false;
  const checkIndexFreshness = params.checkIndexFreshness !== false;
  const checkToolContract = params.checkToolContract !== false;

  // ---- 1. Index freshness (via gnEnsureFresh in read-only mode) -------------
  let indexFreshness: DiagnoseReport['indexFreshness'];
  let embeddingsCount = 0;
  let embeddingsStatus: EmbeddingDriftStatus | undefined;
  let embeddingsReason: string | undefined;
  let embeddingsRepairCommand: string | undefined;
  let hasFreshReport = false;
  let runtimeHealth: RuntimeHealthSnapshot | undefined;
  let freshRepoPath: string | undefined;

  if (checkIndexFreshness || checkEmbeddings) {
    let freshReport;
    try {
      freshReport = await gnEnsureFresh(repoId, { autoAnalyze: false });
    } catch (err) {
      warnings.push('gnEnsureFresh failed: ' + (err instanceof Error ? err.message : String(err)));
    }

    if (freshReport) {
      hasFreshReport = true;
      runtimeHealth = freshReport.runtimeHealth;
      freshRepoPath = freshReport.repoPath;
      // Propagate any warnings from gnEnsureFresh
      for (const w of freshReport.warnings) {
        warnings.push(w);
      }

      if (checkIndexFreshness) {
        indexFreshness = {
          isStale: freshReport.preCheck.isStale,
          indexedCommit: freshReport.preCheck.indexedCommit,
          currentCommit: freshReport.preCheck.currentCommit,
        };

        if (freshReport.preCheck.isStale) {
          recommendations.push({
            severity: 'WARN',
            detail: `Index is stale (indexed ${freshReport.preCheck.indexedCommit} vs current ${freshReport.preCheck.currentCommit})`,
            fix: 'gn_ensure_fresh({autoAnalyze: true})',
          });
        }
      }

      if (checkEmbeddings) {
        embeddingsCount = freshReport.embeddingsStatus.count;
        embeddingsStatus = freshReport.embeddingsStatus.status;
        embeddingsReason = freshReport.embeddingsStatus.reason;
        embeddingsRepairCommand = freshReport.embeddingsStatus.repairCommand;
      }
    }
  }

  // ---- 2. Embeddings --------------------------------------------------------
  // Only populate when checkEmbeddings was requested AND we successfully obtained
  // a freshReport. If gnEnsureFresh threw, there is no data to report.
  let embeddings: DiagnoseReport['embeddings'];
  if (checkEmbeddings && hasFreshReport) {
    embeddings = {
      count: embeddingsCount,
      populated: embeddingsStatus === 'ok',
      status: embeddingsStatus ?? (embeddingsCount > 0 ? 'metadata-unavailable' : 'missing'),
      ...(embeddingsReason !== undefined ? { reason: embeddingsReason } : {}),
      ...(embeddingsRepairCommand !== undefined ? { repairCommand: embeddingsRepairCommand } : {}),
    };

    if (embeddings.status !== 'ok') {
      const severity =
        embeddings.status === 'drifted'
          ? 'ERROR'
          : embeddings.status === 'missing'
            ? 'INFO'
            : 'WARN';
      recommendations.push({
        severity,
        detail:
          embeddings.status === 'drifted'
            ? 'Embeddings metadata drift detected'
            : embeddings.status === 'missing'
              ? 'Embeddings not populated'
              : 'Embedding metadata unavailable',
        fix:
          embeddings.repairCommand ??
          (embeddings.status === 'missing'
            ? 'ontoindex analyze --embeddings'
            : 'ontoindex analyze'),
      });
    }
  }

  // ---- 3. LSP probes --------------------------------------------------------
  let lspAvailable: DiagnoseReport['lspAvailable'];
  if (checkLsp) {
    const [tsAvailable, pyAvailable, rustAvailable] = await Promise.all([
      probeWhich('typescript-language-server'),
      probeWhich('pyright'),
      probeWhich('rust-analyzer'),
    ]);

    lspAvailable = {
      typescript: tsAvailable,
      python: pyAvailable,
      rust: rustAvailable,
    };

    if (!tsAvailable) {
      recommendations.push({
        severity: 'INFO',
        detail: 'typescript-language-server not in PATH',
        fix: 'npm install -g typescript-language-server',
      });
    }
    if (!pyAvailable) {
      recommendations.push({
        severity: 'INFO',
        detail: 'pyright not in PATH',
        fix: 'npm install -g pyright',
      });
    }
    if (!rustAvailable) {
      recommendations.push({
        severity: 'INFO',
        detail: 'rust-analyzer not in PATH',
        fix: 'Install rust-analyzer via rustup or your system package manager',
      });
    }
  }

  // ---- 4. Env vars ----------------------------------------------------------
  const envVars = collectOntoIndexEnv();
  const classification = buildClassificationSummary();
  const setup = buildSetupSummary(envVars);
  const responseLimits = buildResponseLimits(envVars);
  const toolTelemetrySummary = await readToolTelemetrySummary({ limit: 5 });
  const responseBudgetHealth: DiagnoseReport['responseBudgetHealth'] = {
    guardLimitBytes: RESPONSE_GUARD_MAX_BYTES,
    recentOversizedTools: toolTelemetrySummary.recentOversizedTools,
    guardedPreviewAvailable: true,
  };

  if (setup.mcp.autoAnalyze === 'enabled') {
    recommendations.push({
      severity: 'WARN',
      detail: 'ONTOINDEX_MCP_AUTO_ANALYZE is enabled; MCP startup may trigger broad index work.',
      fix: 'Set ONTOINDEX_MCP_AUTO_ANALYZE=0 for bounded startup behavior.',
    });
  }

  // ---- 5. Shared target context ---------------------------------------------
  let targetContext: DiagnoseReport['targetContext'];
  let vectorBackend: DiagnoseReport['vectorBackend'];
  try {
    targetContext = await resolveTargetContext({
      repo: repoId,
      checkSidecar: true,
      readiness: {
        ...(checkEmbeddings && hasFreshReport ? { embeddingsCount } : {}),
        ...(lspAvailable !== undefined ? { lspAvailable } : {}),
      },
    });
    warnings.push(...targetContext.warnings);
    if (targetContext.status === 'ambiguous' || targetContext.status === 'not-found') {
      recommendations.push({
        severity: 'ERROR',
        detail: `Target context ${targetContext.status}: ${
          targetContext.action ?? 'resolve repository target'
        }`,
        fix: 'Pass an explicit repo name or absolute repo path.',
      });
    } else if (targetContext.status === 'no-index') {
      recommendations.push({
        severity: 'WARN',
        detail: `Target context unavailable: ${targetContext.action ?? 'no OntoIndex index'}`,
        fix: 'Run ontoindex analyze for the target repository.',
      });
    }
  } catch (err) {
    warnings.push(
      'resolveTargetContext failed: ' + (err instanceof Error ? err.message : String(err)),
    );
  }

  const requestedVectorBackend = envVars['ONTOINDEX_VECTOR_BACKEND']?.trim().toLowerCase();
  if (requestedVectorBackend === 'zvec' || requestedVectorBackend === 'auto') {
    const vectorRepoPath =
      targetContext?.status === 'ok'
        ? targetContext.repoPath
        : (freshRepoPath ?? runtimeHealth?.repoPath);
    try {
      vectorBackend = await getSemanticVectorBackendStatus({
        id: repoId,
        repoPath: vectorRepoPath,
      });
      if (vectorBackend.actualBackend !== 'zvec') {
        recommendations.push({
          severity: 'WARN',
          detail: `Requested vector backend ${vectorBackend.requestedBackend} fell back to LadybugDB${
            vectorBackend.fallbackReason ? `: ${vectorBackend.fallbackReason}` : ''
          }`,
          fix: 'Refresh the zvec mirror or unset ONTOINDEX_VECTOR_BACKEND to stay on LadybugDB.',
        });
      }
    } catch (err) {
      warnings.push(
        'zvec backend diagnostics failed: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // ---- 6. MCP tool contract -------------------------------------------------
  let toolContract: DiagnoseReport['toolContract'];
  if (checkToolContract) {
    const contract = await gnToolContract();
    toolContract = {
      status: contract.status,
      runtime: contract.runtime,
      advertised: contract.advertised,
      callable: contract.callable,
      missing: contract.missing,
      extras: contract.extras,
    };
    if (contract.status === 'drift') {
      recommendations.push({
        severity: 'ERROR',
        detail: `MCP tool contract drift: ${contract.missing.length} advertised missing, ${contract.extras.length} registered but hidden from help`,
        fix: 'Run gn_tool_contract({}); rebuild/restart the MCP server and refresh mcp_on_demand tool metadata.',
      });
      warnings.push(...contract.warnings);
    }
  }

  // ---- 7. Quality-mode recommendation (no ONTOINDEX_INTENT_ENSEMBLE) ---------
  if (envVars['ONTOINDEX_INTENT_ENSEMBLE'] === undefined) {
    recommendations.push({
      severity: 'INFO',
      detail: 'Default quality mode: fast (ONTOINDEX_INTENT_ENSEMBLE not set)',
      fix: 'gn_quality_mode({level: "balanced"})',
    });
  }

  // ---- 8. Optional file-scope diagnostics -----------------------------------
  let fileScopePreview: DiagnoseReport['fileScopePreview'];
  let fileScopeExplanation: DiagnoseReport['fileScopeExplanation'];
  const fileScopeRepoPath =
    targetContext?.status === 'ok'
      ? targetContext.repoPath
      : (freshRepoPath ?? runtimeHealth?.repoPath);
  const fileScopeLimit = Math.max(1, Math.min(params.fileScopeLimit ?? 10, 100));

  if ((params.includeFileScopePreview || params.explainFile) && !fileScopeRepoPath) {
    warnings.push('file-scope diagnostics requested but repo path could not be resolved');
  } else if (fileScopeRepoPath) {
    try {
      if (params.includeFileScopePreview) {
        fileScopePreview = await collectFileScopePreview(fileScopeRepoPath, {
          limit: fileScopeLimit,
        });
      }
      if (params.explainFile) {
        fileScopeExplanation = await explainPathScope(fileScopeRepoPath, params.explainFile);
      }
    } catch (err) {
      warnings.push(
        'file-scope diagnostics failed: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // ---- 8.5. Audit freshness diagnostics -------------------------------------
  let auditFreshness: DiagnoseReport['auditFreshness'];
  const auditRepoPath =
    targetContext?.status === 'ok'
      ? targetContext.repoPath
      : (freshRepoPath ?? runtimeHealth?.repoPath);

  if (auditRepoPath) {
    try {
      const projectionPath = getAuditProjectionPath(auditRepoPath);
      const raw = await fs.readFile(projectionPath, 'utf8');
      const projection = JSON.parse(raw);
      const latestSession = projection.sessions?.[projection.sessions.length - 1];
      if (latestSession && latestSession.targetHead) {
        const targetHead = latestSession.targetHead;
        const sessionId = latestSession.id;
        const repairCommand = auditReplayCommand(sessionId);
        try {
          const freshness = await computeAuditFreshness(auditRepoPath, { ref: targetHead });
          const status = freshness.state; // 'clean' | 'dirty' | 'stale' | 'partial'
          auditFreshness = {
            status: status === 'partial' ? 'unknown' : status,
            targetHead,
            currentHead: freshness.currentHead,
            sessionId,
            ...(status === 'clean' || !repairCommand ? {} : { repairCommand }),
          };

          if (status === 'stale') {
            recommendations.push({
              severity: 'WARN',
              detail: `Audit projection is stale (target ${targetHead.slice(0, 12)} vs current ${freshness.currentHead?.slice(0, 12)})`,
              fix:
                repairCommand ??
                'Replay or restart the audit session against the current target HEAD.',
            });
          } else if (status === 'dirty') {
            recommendations.push({
              severity: 'WARN',
              detail: `Audit projection target has dirty worktree (${freshness.dirtyFiles.length} files changed)`,
              fix: repairCommand
                ? `commit, stash, or clean the worktree, then rerun ${repairCommand}`
                : 'Commit, stash, or clean the worktree, then replay or restart the audit session.',
            });
          }
        } catch (err) {
          auditFreshness = {
            status: 'unknown',
            targetHead,
            sessionId,
            ...(repairCommand ? { repairCommand } : {}),
          };
          warnings.push(`computeAuditFreshness failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        auditFreshness = { status: 'missing' };
      }
    } catch (error: any) {
      if (error && error.code === 'ENOENT') {
        auditFreshness = { status: 'missing' };
      } else {
        auditFreshness = { status: 'unknown' };
        warnings.push(`failed to load audit projection status: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    auditFreshness = { status: 'unknown' };
  }

  // ---- 8.6. MCP resource bridge diagnostics ---------------------------------
  let mcpResourceBridge: DiagnoseReport['mcpResourceBridge'];
  try {
    const bridgeReport = await checkMcpResourceBridge();
    mcpResourceBridge = bridgeReport;
    if (!bridgeReport.exposed) {
      recommendations.push({
        severity: 'INFO',
        detail: 'OntoIndex MCP server is not registered in known client configurations (Claude Code, Cursor, OpenCode, Codex, Ontocode).',
        fix: 'Run ontoindex setup to register the MCP server in your tools.',
      });
    }
  } catch (err) {
    mcpResourceBridge = { exposed: false, exposedTo: [] };
    warnings.push(`checkMcpResourceBridge failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- 8.7. Support diagnostics ---------------------------------------------
  let support: DiagnoseReport['support'];
  if (auditRepoPath) {
    try {
      support = await buildSupportDiagnostics(auditRepoPath);
    } catch (err) {
      warnings.push(
        `support diagnostics failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---- 9. Degraded context synthesis ----------------------------------------
  const misconfiguration = buildMisconfigurationReport(repoId, envVars, targetContext);
  if (misconfiguration.status === 'fail') {
    recommendations.unshift({
      severity: 'ERROR',
      detail: `P1 MCP service target mismatch: requested "${repoId}" but active target is ${
        misconfiguration.activeRepoLabel ?? '<unresolved>'
      }${misconfiguration.activeRepoPath ? ` at ${misconfiguration.activeRepoPath}` : ''}.`,
      fix:
        misconfiguration.recommendedCommand ??
        'Restart MCP with ontoindex mcp --project <target-repo> [--repo <label>].',
    });
  }

  const degradedReasons: string[] = [];
  const degradedAreas = new Set<string>();

  if (misconfiguration.status === 'fail') {
    degradedReasons.push('mcp-service-target-mismatch');
    degradedAreas.add('repo-targeting');
  }
  if (indexFreshness?.isStale) {
    degradedReasons.push('index-stale');
    degradedAreas.add('freshness');
  }
  if (embeddings?.status === 'missing') {
    degradedReasons.push('embeddings-unavailable');
    degradedAreas.add('retrieval');
    degradedReasons.push('embeddings-missing');
    degradedAreas.add('retrieval');
  }
  if (embeddings?.status === 'metadata-unavailable') {
    degradedReasons.push('embeddings-metadata-unavailable');
    degradedAreas.add('retrieval');
  }
  if (embeddings?.status === 'drifted') {
    degradedReasons.push('embeddings-drifted');
    degradedAreas.add('retrieval');
  }
  if (lspAvailable?.typescript === false) {
    degradedReasons.push('typescript-lsp-missing');
    degradedAreas.add('lsp');
  }
  if (lspAvailable?.python === false) {
    degradedReasons.push('python-lsp-missing');
    degradedAreas.add('lsp');
  }
  if (lspAvailable?.rust === false) {
    degradedReasons.push('rust-lsp-missing');
    degradedAreas.add('lsp');
  }
  if (targetContext && targetContext.status !== 'ok') {
    degradedReasons.push(`target-context-${targetContext.status}`);
    degradedAreas.add('repo-targeting');
  }
  if (vectorBackend?.actualBackend !== undefined && vectorBackend.actualBackend !== 'zvec') {
    degradedReasons.push(
      vectorBackend.circuitBroken ? 'vector-backend-circuit-broken' : 'vector-backend-fallback',
    );
    degradedAreas.add('retrieval');
  }
  if (toolContract?.status === 'drift') {
    degradedReasons.push('tool-contract-drift');
    degradedAreas.add('mcp-contract');
  }
  if (setup.mcp.autoAnalyze === 'enabled') {
    degradedReasons.push('mcp-auto-analyze-enabled');
    degradedAreas.add('setup');
  }
  if (warnings.length > 0) {
    degradedReasons.push('runtime-warnings');
    degradedAreas.add('runtime');
  }

  if (auditFreshness?.status === 'stale') {
    degradedReasons.push('audit-stale');
    degradedAreas.add('audit-freshness');
  }
  if (auditFreshness?.status === 'dirty') {
    degradedReasons.push('audit-dirty');
    degradedAreas.add('audit-freshness');
  }

  const degradedContext: DiagnoseReport['degradedContext'] = {
    status: degradedReasons.length > 0 ? 'degraded' : 'ok',
    reasons: degradedReasons,
    affectedAreas: [...degradedAreas],
    confidence: degradedReasons.length > 0 ? 'reduced' : 'full',
  };

  const runtimeContextSummary = buildRuntimeContextSummary({
    targetContext,
    runtimeHealth,
    indexFreshness,
    embeddings,
    recommendations,
  });

  // ---- 10. Assemble report --------------------------------------------------
  const report: DiagnoseReport = {
    version: 1,
    ...(indexFreshness !== undefined ? { indexFreshness } : {}),
    ...(embeddings !== undefined ? { embeddings } : {}),
    ...(lspAvailable !== undefined ? { lspAvailable } : {}),
    ...(targetContext !== undefined ? { targetContext } : {}),
    ...(runtimeHealth !== undefined ? { runtimeHealth } : {}),
    ...(fileScopePreview !== undefined ? { fileScopePreview } : {}),
    ...(fileScopeExplanation !== undefined ? { fileScopeExplanation } : {}),
    ...(toolContract !== undefined ? { toolContract } : {}),
    ...(vectorBackend !== undefined ? { vectorBackend } : {}),
    auditFreshness,
    mcpResourceBridge,
    ...(support !== undefined ? { support } : {}),
    classification,
    setup,
    responseLimits,
    responseBudgetHealth,
    toolTelemetrySummary,
    runtimeContextSummary,
    degradedContext,
    misconfiguration,
    envVars,
    recommendations,
    warnings,
  };

  if (params.legacyResponse !== false) {
    return report;
  }

  return createEnvelopeFromLegacy({
    legacy: report as unknown as Record<string, unknown>,
    tool: 'gn_diagnose',
    status: degradedContext.status,
    targetContext: targetContext ?? {
      scope: 'global',
      reason: 'diagnostics completed without a resolved repository target',
    },
    capabilitiesUsed: [
      'target-context',
      ...(checkIndexFreshness ? ['freshness-probe'] : []),
      ...(checkEmbeddings ? ['embeddings-probe'] : []),
      ...(checkLsp ? ['lsp-probe'] : []),
      ...(checkToolContract ? ['tool-contract'] : []),
      ...(vectorBackend ? ['vector-backend-status'] : []),
      'classification-summary',
      'setup-summary',
      'response-limits',
      'audit-freshness-probe',
      'mcp-resource-bridge-probe',
    ],
    capabilitiesMissing: [
      ...(embeddings?.status === 'missing' ? ['embeddings'] : []),
      ...(embeddings?.status === 'metadata-unavailable' ? ['embedding-metadata'] : []),
      ...(embeddings?.status === 'drifted' ? ['embedding-drift'] : []),
      ...(lspAvailable?.typescript === false ? ['typescript-lsp'] : []),
      ...(lspAvailable?.python === false ? ['python-lsp'] : []),
      ...(lspAvailable?.rust === false ? ['rust-lsp'] : []),
      ...(setup.mcp.autoAnalyze === 'enabled' ? ['bounded-startup-policy'] : []),
    ],
    semanticFallbackUsed: checkEmbeddings && embeddings?.status === 'missing',
    diagnosticsRequested: true,
    nextTools: ['gn_ensure_fresh', 'gn_quality_mode', 'gn_tool_contract'],
  });
}


async function checkMcpResourceBridge(): Promise<{ exposed: boolean; exposedTo: string[] }> {
  const exposedTo: string[] = [];
  const home = os.homedir();

  // 1. Claude Code
  try {
    const claudeJsonPath = path.join(home, '.claude.json');
    const contentStr = await fs.readFile(claudeJsonPath, 'utf8');
    const parsed = JSON.parse(contentStr);
    if (parsed?.mcpServers?.ontoindex) {
      exposedTo.push('Claude Code');
    }
  } catch {
    // ignore
  }

  // 2. Cursor
  try {
    const cursorMcpPath = path.join(home, '.cursor', 'mcp.json');
    const contentStr = await fs.readFile(cursorMcpPath, 'utf8');
    const parsed = JSON.parse(contentStr);
    if (parsed?.mcpServers?.ontoindex) {
      exposedTo.push('Cursor');
    }
  } catch {
    // ignore
  }

  // 3. OpenCode
  try {
    const opencodeJsonPath = path.join(home, '.config', 'opencode', 'opencode.json');
    const contentStr = await fs.readFile(opencodeJsonPath, 'utf8');
    const parsed = JSON.parse(contentStr);
    if (parsed?.mcp?.ontoindex) {
      exposedTo.push('OpenCode');
    }
  } catch {
    // ignore
  }

  // 4. Ontocode
  try {
    const codexConfigPath = path.join(home, '.codex', 'config.toml');
    const contentStr = await fs.readFile(codexConfigPath, 'utf8');
    if (hasCodexCompatibleMcpSection(contentStr)) {
      exposedTo.push('Codex');
    }
  } catch {
    // ignore
  }

  // 5. Ontocode
  try {
    const ontocodeConfigPath = path.join(home, '.ontocode', 'config.toml');
    const contentStr = await fs.readFile(ontocodeConfigPath, 'utf8');
    if (hasCodexCompatibleMcpSection(contentStr)) {
      exposedTo.push('Ontocode');
    }
  } catch {
    // ignore
  }

  return {
    exposed: exposedTo.length > 0,
    exposedTo,
  };
}
