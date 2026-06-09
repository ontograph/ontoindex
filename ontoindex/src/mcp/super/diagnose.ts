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
import { gnToolContract, type ToolContractReport } from './tool-contract.js';
import {
  createEnvelopeFromLegacy,
  type CapabilityResponseEnvelope,
} from '../shared/response-envelope.js';
import { resolveTargetContext, type TargetContext } from '../shared/target-context.js';
import { execFileText } from '../../core/process/exec-file.js';
import { getResourceContractSummaries } from '../resources.js';
import {
  createEmptyEvidenceReadClassCounts,
  type EvidenceReadClass,
} from '../../core/runtime/evidence-read-ledger.js';

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
  legacyResponse?: boolean;
}

export interface DiagnoseReport {
  version: 1;
  indexFreshness?: { isStale: boolean; indexedCommit: string; currentCommit: string };
  embeddings?: { count: number; populated: boolean };
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
  degradedContext: {
    status: 'ok' | 'degraded';
    reasons: string[];
    affectedAreas: string[];
    confidence: 'full' | 'reduced';
  };
  targetContext?: TargetContext;
  toolContract?: Pick<
    ToolContractReport,
    'status' | 'runtime' | 'advertised' | 'callable' | 'missing' | 'extras'
  >;
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

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

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
  let hasFreshReport = false;

  if (checkIndexFreshness || checkEmbeddings) {
    let freshReport;
    try {
      freshReport = await gnEnsureFresh(repoId, { autoAnalyze: false });
    } catch (err) {
      warnings.push('gnEnsureFresh failed: ' + (err instanceof Error ? err.message : String(err)));
    }

    if (freshReport) {
      hasFreshReport = true;
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
      }
    }
  }

  // ---- 2. Embeddings --------------------------------------------------------
  // Only populate when checkEmbeddings was requested AND we successfully obtained
  // a freshReport. If gnEnsureFresh threw, there is no data to report.
  let embeddings: DiagnoseReport['embeddings'];
  if (checkEmbeddings && hasFreshReport) {
    embeddings = { count: embeddingsCount, populated: embeddingsCount > 0 };

    if (embeddingsCount === 0) {
      recommendations.push({
        severity: 'INFO',
        detail: 'Embeddings not populated',
        fix: 'ontoindex analyze --embeddings',
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

  if (setup.mcp.autoAnalyze === 'enabled') {
    recommendations.push({
      severity: 'WARN',
      detail: 'ONTOINDEX_MCP_AUTO_ANALYZE is enabled; MCP startup may trigger broad index work.',
      fix: 'Set ONTOINDEX_MCP_AUTO_ANALYZE=0 for bounded startup behavior.',
    });
  }

  // ---- 5. Shared target context ---------------------------------------------
  let targetContext: DiagnoseReport['targetContext'];
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
        detail: `Target context ${targetContext.status}: ${targetContext.action ?? 'resolve repository target'}`,
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

  // ---- 8. Degraded context synthesis ----------------------------------------
  const degradedReasons: string[] = [];
  const degradedAreas = new Set<string>();

  if (indexFreshness?.isStale) {
    degradedReasons.push('index-stale');
    degradedAreas.add('freshness');
  }
  if (embeddings?.populated === false) {
    degradedReasons.push('embeddings-unavailable');
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

  const degradedContext: DiagnoseReport['degradedContext'] = {
    status: degradedReasons.length > 0 ? 'degraded' : 'ok',
    reasons: degradedReasons,
    affectedAreas: [...degradedAreas],
    confidence: degradedReasons.length > 0 ? 'reduced' : 'full',
  };

  // ---- 8. Assemble report ---------------------------------------------------
  const report: DiagnoseReport = {
    version: 1,
    ...(indexFreshness !== undefined ? { indexFreshness } : {}),
    ...(embeddings !== undefined ? { embeddings } : {}),
    ...(lspAvailable !== undefined ? { lspAvailable } : {}),
    ...(targetContext !== undefined ? { targetContext } : {}),
    ...(toolContract !== undefined ? { toolContract } : {}),
    classification,
    setup,
    responseLimits,
    degradedContext,
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
      'classification-summary',
      'setup-summary',
      'response-limits',
    ],
    capabilitiesMissing: [
      ...(embeddings?.populated === false ? ['embeddings'] : []),
      ...(lspAvailable?.typescript === false ? ['typescript-lsp'] : []),
      ...(lspAvailable?.python === false ? ['python-lsp'] : []),
      ...(lspAvailable?.rust === false ? ['rust-lsp'] : []),
      ...(setup.mcp.autoAnalyze === 'enabled' ? ['bounded-startup-policy'] : []),
    ],
    semanticFallbackUsed: checkEmbeddings && embeddings?.populated === false,
    diagnosticsRequested: true,
    nextTools: ['gn_ensure_fresh', 'gn_quality_mode', 'gn_tool_contract'],
  });
}
