/**
 * gn_safe_edit_check — pre-edit risk synthesis super-function (Phase 2 W2a).
 *
 * Composes graph primitives + LSP best-effort to produce a deterministic
 * EditCheckReport before a developer modifies a symbol.
 *
 * Pure facade — no caching, no DB writes, no process-global side effects.
 *
 * Verdict matrix is DETERMINISTIC: same inputs → same verdict.
 * No randomness; recentTouchDays is computed from stored graph data, not wall-clock.
 *
 */

import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import {
  runImpactKernel,
  SAFE_EDIT_DOWNSTREAM_RELATION_TYPES,
  SAFE_EDIT_UPSTREAM_RELATION_TYPES,
  type ImpactKernelRawCounts,
} from '../../core/impact/impact-kernel.js';
import { lspBridge } from '../../core/lsp/bridge.js';
import {
  createEnvelopeFromLegacy,
  type CapabilityResponseEnvelope,
} from '../shared/response-envelope.js';
import {
  BACKEND_FALLBACK_ACTION_NAMES,
  getRegisteredFacadeToolNames,
  getRegisteredSuperToolNames,
} from '../shared/tool-registry.js';
import { resolveTargetContext } from '../shared/target-context.js';
import { findTestFiles, type TestCoverageResult } from './_helpers/test-coverage.js';
import { collectAdvisoryDocsEvidence, type AdvisoryDocsEvidenceReport } from './docs-evidence.js';
import {
  summarizeBasedOnReads,
  type BasedOnReadsSummary,
  recordEvidenceReadSafe,
} from '../../core/runtime/evidence-read-ledger.js';

// ---------------------------------------------------------------------------
// Public API (per plan §3)
// ---------------------------------------------------------------------------

export interface ResolvedSymbol {
  nodeId: string;
  name: string;
  filePath: string;
  kind: string;
}

export interface SafeEditCheckParams {
  symbol: string; // canonical nodeId or fuzzy name
  intent?: 'rename' | 'modify-body' | 'delete' | 'general'; // default: 'general'
  force?: boolean; // bypass verdict guards
  docsEvidence?: boolean; // opt-in advisory Markdown docs evidence
  legacyResponse?: boolean;
}

export interface RequiredRead {
  /** nodeId or file path of the symbol/file that must be read before editing. */
  symbol: string;
  /** Why this read is required. */
  reason: string;
}

export interface RecommendedAction {
  /** The tool to invoke for this edit. */
  tool: string;
  /** Params to pass to the tool. */
  params: object;
  /** Why this action is recommended for this intent. */
  rationale: string;
}

export interface EditCheckReport {
  version: 1;
  symbol: ResolvedSymbol;
  verdict: 'SAFE' | 'CAUTION' | 'DANGEROUS' | 'BLOCKED';
  reasoning: string;
  basedOnReads?: BasedOnReadsSummary;
  blastRadius: {
    upstreamCount: number;
    upstreamFiles: string[];
    downstreamCount: number;
    transitiveImpact: { processCount: number; clusterCount: number };
  };
  testCoverage: {
    coveringTests: string[];
    likelihoodOfCoverage: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  };
  coChangeNetwork: {
    siblings: string[];
    recentTouchDays: number;
  };
  lspRefs?: Array<{ filePath: string; line: number; column: number }>;
  recommendedTool: 'gn_safe_refactor' | 'rename_symbol' | 'update_symbol_body' | 'manual';
  /** Visibility of the recommendedTool: public (super), facade, backend-fallback, or manual. */
  recommendedToolVisibility?: 'public' | 'facade' | 'backend-fallback' | 'manual';
  /**
   * Symbols or files an agent should read before executing the edit.
   * Populated for rename and modify-body intents.
   */
  requiredReads?: RequiredRead[];
  /**
   * Structured action plan for the recommended edit step.
   * Populated for rename and modify-body intents.
   */
  recommendedAction?: RecommendedAction;
  preChecks: Array<{ check: string; passed: boolean; detail: string }>;
  warnings: string[];
  suggestedNext: Array<{
    tool: string;
    params: object;
    reason: string;
    /** Visibility of this tool: public (super), facade, backend-fallback, or unknown. */
    visibility?: 'public' | 'facade' | 'backend-fallback' | 'unknown';
  }>;
  docEvidence?: AdvisoryDocsEvidenceReport;
  relatedDocs?: AdvisoryDocsEvidenceReport['relatedDocs'];
  rawCounts?: {
    upstream: ImpactKernelRawCounts;
    downstream: ImpactKernelRawCounts;
  };
}

// ---------------------------------------------------------------------------
// Canonical nodeId pattern (same as find-related.ts)
// ---------------------------------------------------------------------------

const CANONICAL_NODE_ID_RE = /^[A-Z]\w+:/;
const IMPACT_QUERY_CONCURRENCY = 3;

type QueryRow = Record<string, unknown> & { [index: number]: unknown };

type ImpactResultTuple = [
  UpstreamResult,
  DownstreamResult,
  number,
  number,
  TestCoverageResult,
  string[],
  number,
  boolean,
];

type LspReference = {
  uri?: unknown;
  range?: {
    start?: {
      line?: unknown;
      character?: unknown;
    };
  };
};

async function runLimited<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function runLimitedTuple<T extends readonly unknown[]>(
  tasks: { [K in keyof T]: () => Promise<T[K]> },
  concurrency: number,
): Promise<T> {
  return (await runLimited<Awaited<T[number]>>(
    tasks as Array<() => Promise<Awaited<T[number]>>>,
    concurrency,
  )) as unknown as T;
}

function rowString(row: QueryRow, key: string, index: number): string {
  return (row[key] ?? row[index] ?? '') as string;
}

function rowNumber(row: QueryRow, key: string, index: number): number {
  return Number(row[key] ?? row[index] ?? 0);
}

function isLspReference(value: unknown): value is LspReference {
  return typeof value === 'object' && value !== null;
}

function lspPositionNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function definitionRank(row: QueryRow): number {
  const content = rowString(row, 'content', 5).trim();
  if (content) {
    const compact = content.replace(/\s+/g, ' ');
    const hasBody = /{|=>/.test(content) || /\)\s*:\s*\n\s+\S/.test(content);
    const declarationOnly =
      compact.endsWith(';') && !content.includes('{') && !content.includes('=>');
    const stubOnly =
      /\bpass\b|\.\.\.|not implemented|unimplemented!?/.test(compact) && !content.includes('{');
    if (declarationOnly || stubOnly) return -1;
    if (hasBody) return 1;
  }
  const startLine = rowNumber(row, 'startLine', 6);
  const endLine = rowNumber(row, 'endLine', 7);
  return endLine > startLine ? 0.5 : 0;
}

// ---------------------------------------------------------------------------
// Internal helpers — each makes exactly ONE executeParameterized call.
// All are best-effort: errors return a zero/empty result, never throw.
// The main facade schedules these through a small concurrency limiter so a
// single MCP request cannot fan out all graph probes at once.
// ---------------------------------------------------------------------------

async function resolveSymbol(repoId: string, symbol: string): Promise<ResolvedSymbol | null> {
  if (CANONICAL_NODE_ID_RE.test(symbol)) {
    try {
      const rows = (await executeParameterized(
        repoId,
        `MATCH (s) WHERE s.id = $id
         RETURN s.id AS nodeId, s.name AS name, s.filePath AS filePath, labels(s)[0] AS kind
         LIMIT 1`,
        { id: symbol },
      )) as QueryRow[];
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        nodeId: rowString(row, 'nodeId', 0),
        name: rowString(row, 'name', 1),
        filePath: rowString(row, 'filePath', 2),
        kind: rowString(row, 'kind', 3),
      };
    } catch {
      return null;
    }
  }

  try {
    const candidates = (await executeParameterized(
      repoId,
      `MATCH (s) WHERE s.name = $name
       OPTIONAL MATCH (caller)-[r:CodeRelation]->(s) WHERE r.type = 'CALLS'
       RETURN s.id AS nodeId, s.name AS name, s.filePath AS filePath, labels(s)[0] AS kind,
              COUNT(caller) AS callerCount, s.content AS content, s.startLine AS startLine,
              s.endLine AS endLine
       ORDER BY callerCount DESC
       LIMIT 20`,
      { name: symbol },
    )) as QueryRow[];
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const rankDelta = definitionRank(b) - definitionRank(a);
      if (rankDelta !== 0) return rankDelta;
      return rowNumber(b, 'callerCount', 4) - rowNumber(a, 'callerCount', 4);
    });
    const row = candidates[0];
    return {
      nodeId: rowString(row, 'nodeId', 0),
      name: rowString(row, 'name', 1),
      filePath: rowString(row, 'filePath', 2),
      kind: rowString(row, 'kind', 3),
    };
  } catch {
    return null;
  }
}

interface UpstreamResult {
  count: number;
  files: string[];
  rawCounts?: ImpactKernelRawCounts;
  warnings: string[];
}

interface DownstreamResult {
  count: number;
  rawCounts?: ImpactKernelRawCounts;
  warnings: string[];
}

/** Kernel-backed direct upstream callers via CALLS/REFERENCES. */
async function fetchUpstream(repoId: string, symbol: ResolvedSymbol): Promise<UpstreamResult> {
  try {
    const result = await runImpactKernel(
      { id: repoId },
      {
        id: symbol.nodeId,
        name: symbol.name,
        type: symbol.kind,
        filePath: symbol.filePath,
      },
      {
        direction: 'upstream',
        maxDepth: 1,
        relationTypes: SAFE_EDIT_UPSTREAM_RELATION_TYPES,
        includeTests: false,
        minConfidence: 0,
        countScope: 'unique-direct-nodes',
      },
    );
    const files = [...new Set(result.impacted.map((node) => node.filePath).filter(Boolean))];
    return {
      count: result.rawCounts.direct,
      files,
      rawCounts: result.rawCounts,
      warnings: result.warnings,
    };
  } catch (err) {
    return {
      count: 0,
      files: [],
      warnings: [
        `safe-edit upstream impact failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

/** Kernel-backed direct downstream callees via CALLS/REFERENCES/IMPORTS. */
async function fetchDownstream(repoId: string, symbol: ResolvedSymbol): Promise<DownstreamResult> {
  try {
    const result = await runImpactKernel(
      { id: repoId },
      {
        id: symbol.nodeId,
        name: symbol.name,
        type: symbol.kind,
        filePath: symbol.filePath,
      },
      {
        direction: 'downstream',
        maxDepth: 1,
        relationTypes: SAFE_EDIT_DOWNSTREAM_RELATION_TYPES,
        includeTests: false,
        minConfidence: 0,
        countScope: 'unique-direct-nodes',
      },
    );
    return {
      count: result.rawCounts.direct,
      rawCounts: result.rawCounts,
      warnings: result.warnings,
    };
  } catch (err) {
    return {
      count: 0,
      warnings: [
        `safe-edit downstream impact failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

/** Single-call: number of Processes this symbol participates in. */
async function fetchProcessCount(repoId: string, nodeId: string): Promise<number> {
  try {
    const rows = (await executeParameterized(
      repoId,
      `MATCH (target {id: $id})-[r:CodeRelation]->(p:Process)
       WHERE r.type = 'PARTICIPATES_IN'
       RETURN count(p) AS processCount
       LIMIT 1`,
      { id: nodeId },
    )) as QueryRow[];
    return rows.length > 0 ? rowNumber(rows[0], 'processCount', 0) : 0;
  } catch {
    return 0;
  }
}

/** Single-call: number of Community clusters this symbol belongs to. */
async function fetchClusterCount(repoId: string, nodeId: string): Promise<number> {
  try {
    const rows = (await executeParameterized(
      repoId,
      `MATCH (target {id: $id})-[r:CodeRelation]->(c:Community)
       WHERE r.type = 'MEMBER_OF'
       RETURN count(c) AS clusterCount
       LIMIT 1`,
      { id: nodeId },
    )) as QueryRow[];
    return rows.length > 0 ? rowNumber(rows[0], 'clusterCount', 0) : 0;
  } catch {
    return 0;
  }
}

/** Single-call: co-changed sibling file paths. */
async function fetchCoChangeSiblings(repoId: string, filePath: string): Promise<string[]> {
  try {
    const rows = (await executeParameterized(
      repoId,
      `MATCH (f:File {filePath: $path})-[r:CodeRelation {type: 'CO_CHANGED_WITH'}]-(other:File)
       RETURN other.filePath AS otherPath, r.confidence AS conf
       ORDER BY r.confidence DESC
       LIMIT 10`,
      { path: filePath },
    )) as QueryRow[];
    return rows.map((row) => rowString(row, 'otherPath', 0)).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Single-call: most recent co-change date, returned as days-ago integer.
 * Returns 0 (recently touched) when no date is available — safe default.
 */
async function fetchRecentTouchDays(repoId: string, filePath: string): Promise<number> {
  try {
    const rows = (await executeParameterized(
      repoId,
      `MATCH (f:File {filePath: $path})-[r:CodeRelation {type: 'CO_CHANGED_WITH'}]-(other:File)
       RETURN r.lastDate AS lastDate
       ORDER BY r.lastDate DESC
       LIMIT 1`,
      { path: filePath },
    )) as QueryRow[];
    if (rows.length === 0) return 0;
    const lastDateStr = rowString(rows[0], 'lastDate', 0);
    if (!lastDateStr) return 0;
    const lastDate = new Date(lastDateStr);
    if (Number.isNaN(lastDate.getTime())) return 0;
    return Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

/** Single-call: whether the symbol is exported. */
async function fetchIsExported(repoId: string, nodeId: string): Promise<boolean> {
  try {
    const rows = (await executeParameterized(
      repoId,
      `MATCH (s {id: $id}) RETURN s.isExported AS isExported LIMIT 1`,
      { id: nodeId },
    )) as QueryRow[];
    if (rows.length === 0) return false;
    const val = rows[0].isExported ?? rows[0][0];
    return val === true || val === 'true' || val === 1;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Verdict synthesis (deterministic)
// ---------------------------------------------------------------------------

function computeVerdict(
  upstream: UpstreamResult,
  processCount: number,
  isExported: boolean,
  likelihood: EditCheckReport['testCoverage']['likelihoodOfCoverage'],
  recentTouchDays: number,
  force: boolean,
): { verdict: EditCheckReport['verdict']; reasoning: string } {
  // BLOCKED: HIGH risk (upstream > 100 AND isExported) without force.
  const isHighRisk = upstream.count > 100 && isExported;
  if (isHighRisk && !force) {
    return {
      verdict: 'BLOCKED',
      reasoning: `Symbol has ${upstream.count} upstream callers and is exported — high blast radius. Use force:true to override.`,
    };
  }

  // DANGEROUS: transitive processCount > 5 OR upstream > 100 OR exported public API.
  if (processCount > 5 || upstream.count > 100 || isExported) {
    return {
      verdict: 'DANGEROUS',
      reasoning: [
        processCount > 5 ? `participates in ${processCount} execution processes` : '',
        upstream.count > 100 ? `${upstream.count} upstream callers` : '',
        isExported ? 'exported public API' : '',
      ]
        .filter(Boolean)
        .join('; '),
    };
  }

  // CAUTION: upstream 10-100 OR no test coverage OR recently untouched (>30 days).
  if (upstream.count >= 10 || likelihood === 'NONE' || recentTouchDays > 30) {
    return {
      verdict: 'CAUTION',
      reasoning: [
        upstream.count >= 10 ? `${upstream.count} upstream callers` : '',
        likelihood === 'NONE' ? 'no test coverage detected' : '',
        recentTouchDays > 30 ? `last co-changed ${recentTouchDays} days ago` : '',
      ]
        .filter(Boolean)
        .join('; '),
    };
  }

  return {
    verdict: 'SAFE',
    reasoning: 'Low blast radius, well-tested, recently active.',
  };
}

function computeRecommendedTool(
  intent: NonNullable<SafeEditCheckParams['intent']>,
  upstream: UpstreamResult,
): EditCheckReport['recommendedTool'] {
  if (intent === 'rename') {
    return 'rename_symbol';
  }
  if (intent === 'modify-body') {
    return 'update_symbol_body';
  }
  if (intent === 'delete') {
    return 'manual';
  }

  // intent === 'general': infer from blast radius.
  if (upstream.files.length > 1) {
    // Cross-file impact -> prefer structured rename
    return 'rename_symbol';
  }

  // Single-file impact -> body modification
  return 'update_symbol_body';
}
// ---------------------------------------------------------------------------
// Tool visibility classification
// ---------------------------------------------------------------------------

/** Lazy-initialised sets so registry is only read once. */
let _superNames: ReadonlySet<string> | undefined;
let _facadeNames: ReadonlySet<string> | undefined;

function superToolNames(): ReadonlySet<string> {
  _superNames ??= new Set(getRegisteredSuperToolNames());
  return _superNames;
}
function facadeToolNames(): ReadonlySet<string> {
  _facadeNames ??= new Set(getRegisteredFacadeToolNames());
  return _facadeNames;
}

/** Classify a tool name against the registry.
 *  'public'           — super tool, discoverable in all modes.
 *  'facade'           — facade tool, discoverable in all modes.
 *  'backend-fallback' — callable direct action, NOT in public MCP discovery.
 *  'manual'           — not a real callable tool (e.g. 'manual').
 *  'unknown'          — not found in any known set.
 */
function classifyToolVisibility(
  toolName: string,
): 'public' | 'facade' | 'backend-fallback' | 'manual' | 'unknown' {
  if (toolName === 'manual') return 'manual';
  if (superToolNames().has(toolName)) return 'public';
  if (facadeToolNames().has(toolName)) return 'facade';
  if (BACKEND_FALLBACK_ACTION_NAMES.has(toolName)) return 'backend-fallback';
  return 'unknown';
}

/** Build the requiredReads list for rename and modify-body intents. */
function buildRequiredReads(
  intent: NonNullable<SafeEditCheckParams['intent']>,
  symbol: ResolvedSymbol,
  upstreamFiles: string[],
): RequiredRead[] | undefined {
  if (intent === 'rename') {
    const reads: RequiredRead[] = [
      {
        symbol: symbol.nodeId,
        reason: 'Inspect current name and signature before renaming.',
      },
    ];
    for (const filePath of upstreamFiles.slice(0, 5)) {
      reads.push({ symbol: filePath, reason: 'Caller file affected by the rename.' });
    }
    return reads;
  }
  if (intent === 'modify-body') {
    return [
      {
        symbol: symbol.nodeId,
        reason: 'Read current body to understand what to replace.',
      },
    ];
  }
  return undefined;
}

/** Build the recommendedAction for rename and modify-body intents. */
function buildRecommendedAction(
  intent: NonNullable<SafeEditCheckParams['intent']>,
  symbol: ResolvedSymbol,
): RecommendedAction | undefined {
  if (intent === 'rename') {
    return {
      tool: 'rename_symbol',
      params: { symbol: symbol.nodeId, newName: 'REPLACE_ME' },
      rationale:
        'Use graph-aware rename to update all call sites atomically. Re-run with the desired newName.',
    };
  }
  if (intent === 'modify-body') {
    return {
      tool: 'update_symbol_body',
      params: { symbol: symbol.nodeId, newBody: 'REPLACE_ME' },
      rationale:
        'Use update_symbol_body to replace the function body with minimal diff. Re-run with the desired newBody.',
    };
  }
  return undefined;
}

function buildSuggestedNext(
  verdict: EditCheckReport['verdict'],
  intent: NonNullable<SafeEditCheckParams['intent']>,
  symbol: ResolvedSymbol,
): EditCheckReport['suggestedNext'] {
  const suggestions: EditCheckReport['suggestedNext'] = [];

  if (verdict === 'BLOCKED') {
    const tool = 'gn_safe_edit_check';
    suggestions.push({
      tool,
      params: { symbol: symbol.nodeId, intent, force: true },
      reason: 'Re-run with force:true to override the BLOCKED guard.',
      visibility: classifyToolVisibility(tool) as
        | 'public'
        | 'facade'
        | 'backend-fallback'
        | 'unknown',
    });
    return suggestions;
  }

  if (verdict === 'DANGEROUS' || verdict === 'CAUTION') {
    const tool = 'gn_find_related';
    suggestions.push({
      tool,
      params: { symbol: symbol.nodeId, includeCallers: true },
      reason: 'Inspect callers before editing.',
      visibility: classifyToolVisibility(tool) as
        | 'public'
        | 'facade'
        | 'backend-fallback'
        | 'unknown',
    });
  }

  if (intent === 'rename') {
    const tool = 'rename_symbol';
    suggestions.push({
      tool,
      params: { symbol: symbol.nodeId, newName: 'REPLACE_ME' },
      reason:
        'Use graph-aware rename to update all call sites atomically. Re-run with the desired newName.',
      visibility: classifyToolVisibility(tool) as
        | 'public'
        | 'facade'
        | 'backend-fallback'
        | 'unknown',
    });
  }

  if (intent === 'modify-body') {
    const tool = 'update_symbol_body';
    suggestions.push({
      tool,
      params: { symbol: symbol.nodeId, newBody: 'REPLACE_ME' },
      reason:
        'Use update_symbol_body to replace the function body with minimal diff. Re-run with the desired newBody.',
      visibility: classifyToolVisibility(tool) as
        | 'public'
        | 'facade'
        | 'backend-fallback'
        | 'unknown',
    });
  }

  if (intent === 'delete' || verdict === 'SAFE') {
    const tool = 'gn_can_delete';
    suggestions.push({
      tool,
      params: { symbol: symbol.nodeId },
      reason: 'Verify full safety before deletion.',
      visibility: classifyToolVisibility(tool) as
        | 'public'
        | 'facade'
        | 'backend-fallback'
        | 'unknown',
    });
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function gnSafeEditCheck(
  repoId: string,
  params: SafeEditCheckParams & { legacyResponse?: true },
): Promise<EditCheckReport>;
export async function gnSafeEditCheck(
  repoId: string,
  params: SafeEditCheckParams & { legacyResponse: false },
): Promise<CapabilityResponseEnvelope<Record<string, unknown>>>;
export async function gnSafeEditCheck(
  repoId: string,
  params: SafeEditCheckParams,
): Promise<EditCheckReport | CapabilityResponseEnvelope<Record<string, unknown>>>;
export async function gnSafeEditCheck(
  repoId: string,
  params: SafeEditCheckParams,
): Promise<EditCheckReport | CapabilityResponseEnvelope<Record<string, unknown>>> {
  const warnings: string[] = [];
  const intent = params.intent ?? 'general';
  const force = params.force ?? false;
  const targetContext = await resolveTargetContext({
    repo: repoId,
    checkSidecar: params.docsEvidence === true,
  });

  // --- 1. Resolve symbol ------------------------------------------------
  const resolved = await resolveSymbol(repoId, params.symbol);

  if (resolved?.nodeId) {
    recordEvidenceReadSafe({
      readClass: 'graph_evidence',
      surface: 'mcp',
      tool: 'gn_safe_edit_check',
      target: resolved.nodeId,
      targetType: 'symbol',
      repo: repoId,
    });
  }

  if (!resolved || !resolved.nodeId) {
    warnings.push('symbol not found in index');
    const report: EditCheckReport = {
      version: 1,
      symbol: { nodeId: '', name: params.symbol, filePath: '', kind: '' },
      verdict: 'SAFE',
      reasoning: 'Symbol not found in index — no graph risk assessed.',
      blastRadius: {
        upstreamCount: 0,
        upstreamFiles: [],
        downstreamCount: 0,
        transitiveImpact: { processCount: 0, clusterCount: 0 },
      },
      testCoverage: { coveringTests: [], likelihoodOfCoverage: 'NONE' },
      coChangeNetwork: { siblings: [], recentTouchDays: 0 },
      recommendedTool: 'manual',
      preChecks: [
        {
          check: 'symbol_in_index',
          passed: false,
          detail: 'Symbol not found in graph index.',
        },
      ],
      warnings,
      suggestedNext: [],
    };
    if (params.legacyResponse !== false) {
      return report;
    }
    return createEnvelopeFromLegacy({
      legacy: report as unknown as Record<string, unknown>,
      tool: 'gn_safe_edit_check',
      status: 'degraded',
      targetContext,
      capabilitiesUsed: ['symbol-graph'],
      nextTools: ['gn_find_related', 'gn_explain_module'],
      evidence: report.preChecks,
    });
  }

  // --- 2. Impact analysis with bounded DB concurrency ---------------------
  const impactResults = await runLimitedTuple<ImpactResultTuple>(
    [
      () => fetchUpstream(repoId, resolved),
      () => fetchDownstream(repoId, resolved),
      () => fetchProcessCount(repoId, resolved.nodeId),
      () => fetchClusterCount(repoId, resolved.nodeId),
      () => findTestFiles(repoId, resolved.filePath, resolved.name),
      () => fetchCoChangeSiblings(repoId, resolved.filePath),
      () => fetchRecentTouchDays(repoId, resolved.filePath),
      () => fetchIsExported(repoId, resolved.nodeId),
    ],
    IMPACT_QUERY_CONCURRENCY,
  );

  const [
    upstream,
    downstream,
    processCount,
    clusterCount,
    testCoverage,
    coChangeSiblings,
    recentTouchDays,
    isExported,
  ] = impactResults;
  warnings.push(...upstream.warnings, ...downstream.warnings);

  // --- 3. LSP refs (best-effort, never throws) --------------------------
  let lspRefs: EditCheckReport['lspRefs'];
  let lspDowngraded = false;
  try {
    const ext = resolved.filePath
      ? resolved.filePath.substring(resolved.filePath.lastIndexOf('.'))
      : '';
    const client = ext ? await lspBridge.getClient(ext) : null;
    if (client) {
      const rawRefs: unknown = await client.findReferences(resolved.filePath, 0, 0);
      if (Array.isArray(rawRefs)) {
        lspRefs = rawRefs.map((ref) => {
          if (!isLspReference(ref)) {
            return { filePath: '', line: 0, column: 0 };
          }
          const uri = typeof ref.uri === 'string' ? ref.uri : '';
          return {
            filePath: uri.replace('file://', ''),
            line: lspPositionNumber(ref.range?.start?.line),
            column: lspPositionNumber(ref.range?.start?.character),
          };
        });
      }
    } else {
      warnings.push('LSP client unavailable for file extension — LSP refs skipped.');
      lspDowngraded = true;
    }
  } catch (err) {
    warnings.push('LSP find-references failed: ' + String(err));
    lspDowngraded = true;
  }

  // --- 3b. LSP rename validation (best-effort, rename intent only) -------
  let lspRenameValidation: { supported: boolean; placeholder?: string } | undefined;
  if (intent === 'rename') {
    try {
      const prepareResult = await lspBridge.validateRename(resolved.filePath, 0, 0);
      lspRenameValidation = {
        supported: prepareResult.supported,
        placeholder: prepareResult.placeholder,
      };
    } catch {
      // best-effort — never propagates
    }
  }

  // --- 4. Pre-checks ---------------------------------------------------
  const preChecks: EditCheckReport['preChecks'] = [
    {
      check: 'symbol_in_index',
      passed: true,
      detail: `Resolved to ${resolved.kind} node at ${resolved.filePath}.`,
    },
    {
      check: 'test_coverage',
      passed: testCoverage.likelihoodOfCoverage !== 'NONE',
      detail: `Coverage likelihood: ${testCoverage.likelihoodOfCoverage}. Tests: ${testCoverage.coveringTests.length}.`,
    },
    {
      check: 'blast_radius',
      passed: upstream.count < 10,
      detail: `${upstream.count} upstream callers, ${downstream.count} downstream callees.`,
    },
  ];
  if (intent === 'rename') {
    preChecks.push({
      check: 'lsp_rename_ready',
      passed: lspRenameValidation?.supported === true,
      detail:
        lspRenameValidation?.supported === true
          ? `LSP confirms rename is supported${lspRenameValidation.placeholder ? ` (placeholder: ${lspRenameValidation.placeholder})` : ''}.`
          : 'LSP rename readiness could not be confirmed — graph-only rename.',
    });
  }

  // --- 5. Verdict synthesis (deterministic) ----------------------------
  const { verdict, reasoning } = computeVerdict(
    upstream,
    processCount,
    isExported,
    testCoverage.likelihoodOfCoverage,
    recentTouchDays,
    force,
  );

  // --- 6. Recommended tool + suggestedNext ----------------------------
  const recommendedTool = computeRecommendedTool(intent, upstream);
  const recommendedToolVisibility = classifyToolVisibility(recommendedTool) as
    | 'public'
    | 'facade'
    | 'backend-fallback'
    | 'manual';
  const suggestedNext = buildSuggestedNext(verdict, intent, resolved);
  const requiredReads = buildRequiredReads(intent, resolved, upstream.files);
  const recommendedAction = buildRecommendedAction(intent, resolved);
  const docsEvidence =
    params.docsEvidence === true
      ? await collectAdvisoryDocsEvidence(repoId, [
          { nodeId: resolved.nodeId, name: resolved.name, filePath: resolved.filePath },
        ])
      : undefined;

  const report: EditCheckReport = {
    version: 1,
    symbol: resolved,
    verdict,
    reasoning,
    basedOnReads: summarizeBasedOnReads(),
    blastRadius: {
      upstreamCount: upstream.count,
      upstreamFiles: upstream.files,
      downstreamCount: downstream.count,
      transitiveImpact: { processCount, clusterCount },
    },
    testCoverage,
    coChangeNetwork: { siblings: coChangeSiblings, recentTouchDays },
    ...(lspRefs !== undefined ? { lspRefs } : {}),
    recommendedTool,
    recommendedToolVisibility,
    ...(requiredReads !== undefined ? { requiredReads } : {}),
    ...(recommendedAction !== undefined ? { recommendedAction } : {}),
    preChecks,
    warnings,
    suggestedNext,
    ...(docsEvidence ? { docEvidence: docsEvidence, relatedDocs: docsEvidence.relatedDocs } : {}),
    ...(upstream.rawCounts && downstream.rawCounts
      ? { rawCounts: { upstream: upstream.rawCounts, downstream: downstream.rawCounts } }
      : {}),
  };
  if (params.legacyResponse !== false) {
    return report;
  }

  const docsQualityDegraded =
    params.docsEvidence === true &&
    docsEvidence !== undefined &&
    docsEvidence.sidecar.status !== 'available';

  return createEnvelopeFromLegacy({
    legacy: report as unknown as Record<string, unknown>,
    tool: 'gn_safe_edit_check',
    status:
      verdict === 'BLOCKED'
        ? 'blocked'
        : lspDowngraded || docsQualityDegraded || warnings.length > 0
          ? 'degraded'
          : 'ok',
    targetContext,
    capabilitiesUsed: [
      'symbol-graph',
      'impact-kernel',
      'test-coverage',
      ...(lspRefs !== undefined ? ['lsp-references'] : []),
      ...(params.docsEvidence === true ? ['docs-evidence'] : []),
    ],
    typeAwareClaimsDowngraded: lspDowngraded,
    lspCapability: lspCapabilityForPath(resolved.filePath),
    sidecarAffectsQuality: docsQualityDegraded,
    nextTools: uniqueStrings([
      ...report.suggestedNext.map((suggestion) => suggestion.tool),
      'gn_safe_refactor',
      'gn_pre_commit_audit',
    ]),
    evidence: [...report.preChecks, ...((docsEvidence?.docEvidence ?? []) as unknown[])],
  });
}

function lspCapabilityForPath(filePath: string): string {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.js')) {
    return 'typescript-lsp';
  }
  if (filePath.endsWith('.py')) return 'python-lsp';
  if (filePath.endsWith('.rs')) return 'rust-lsp';
  return 'lsp';
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}
