/**
 * CLI `report` command group — REV-7.
 *
 * Adds two ranked/lossy discovery subcommands:
 *   ontoindex report hubs
 *   ontoindex report surprising-connections
 *
 * GUARDRAIL: Both commands are explicitly labelled as RANKED DISCOVERY VIEWS.
 * They are never safety-critical. They must never trim or replace complete impact
 * output produced by `ontoindex impact` or `ontoindex review diff`.
 *
 * Hub scores are derived from graph degree, process participation, and community span.
 * Surprising-connection scores are derived from community boundary crossing,
 * directory boundary crossing, edge rarity, and execution-flow presence.
 *
 * See ADR 0020 §4: Hub suppression and surprising connections.
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import { getGitRoot } from '../storage/git.js';
import { getStoragePaths, loadMeta } from '../storage/repo-manager.js';
import { formatIndexCapabilityWarnings } from '../storage/index-capabilities.js';
import { initLbug, closeLbug } from '../core/lbug/pool-adapter.js';
import { executeParameterized } from '../core/lbug/pool-adapter.js';
import { summarizeReasonParts } from '../core/runtime/evidence-diagnostics.js';

const GIT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Shared disclaimer
// ---------------------------------------------------------------------------

export const DISCOVERY_LABEL = '[RANKED DISCOVERY VIEW — lossy, not a complete impact analysis]';

// ---------------------------------------------------------------------------
// Hub types
// ---------------------------------------------------------------------------

export interface HubEntry {
  nodeId: string;
  name: string;
  type: string;
  filePath: string;
  /** Direct callers + direct callees (CALLS + REFERENCES edges). */
  degree: number;
  /** Number of distinct execution flows this node participates in. */
  processFlowCount: number;
  /** Number of distinct communities that include this node. */
  communitySpan: number;
  /** Composite hub score (higher = more central). */
  hubScore: number;
  /** Optional explanation derived only from existing score components. */
  explanation?: HubExplanation;
}

export interface HubExplanation {
  summary: string;
  components: {
    degree: number;
    processFlowCount: number;
    communitySpan: number;
    hubScore: number;
  };
  verifyCommand: string;
}

export interface HubReport {
  repoId: string;
  topN: number;
  hubs: HubEntry[];
  warnings: string[];
  /** Always true — discovery view label, never a complete impact list. */
  isRankedDiscovery: true;
}

// ---------------------------------------------------------------------------
// Surprising-connection types
// ---------------------------------------------------------------------------

export interface SurprisingEdge {
  sourceId: string;
  sourceName: string;
  sourceFile: string;
  sourceCommunity: string;
  targetId: string;
  targetName: string;
  targetFile: string;
  targetCommunity: string;
  /** Canonical relationship type (e.g. CALLS, REFERENCES, IMPORTS). */
  edgeType: string;
  /** True when source and target belong to different communities. */
  crossesCommunityBoundary: boolean;
  /** True when source and target are in different top-level directories. */
  crossesDirectoryBoundary: boolean;
  /** True when this edge appears in at least one execution flow. */
  inExecutionFlow: boolean;
  /** Composite surprise score (higher = more surprising). */
  surpriseScore: number;
  /** Optional explanation derived only from existing edge flags. */
  explanation?: SurprisingEdgeExplanation;
}

export interface SurprisingEdgeExplanation {
  summary: string;
  flags: {
    crossesCommunityBoundary: boolean;
    crossesDirectoryBoundary: boolean;
    inExecutionFlow: boolean;
    edgeType: string;
    surpriseScore: number;
  };
  verifyCommands: string[];
}

export interface SurprisingConnectionsReport {
  repoId: string;
  topN: number;
  edges: SurprisingEdge[];
  warnings: string[];
  /** Always true — discovery view label, never a complete impact list. */
  isRankedDiscovery: true;
}

function withIndexCapabilityWarnings<T extends { warnings: string[] }>(
  report: T,
  warnings: readonly string[],
): T {
  if (warnings.length === 0) return report;
  return {
    ...report,
    warnings: [...new Set([...report.warnings, ...warnings])],
  };
}

// ---------------------------------------------------------------------------
// Hub scoring helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hub score from components.
 *
 * Weights (tunable, but stable per version):
 *   degree:          1.0 per direct neighbour
 *   processFlows:    5.0 per distinct execution flow (cross-concern indicator)
 *   communitySpan:   3.0 per additional community beyond the first
 */
export function computeHubScore(
  degree: number,
  processFlowCount: number,
  communitySpan: number,
): number {
  const spanBonus = Math.max(0, communitySpan - 1);
  return degree * 1.0 + processFlowCount * 5.0 + spanBonus * 3.0;
}

/**
 * Compute a deterministic surprise score from edge attributes.
 *
 * Weights:
 *   crossesCommunityBoundary: 4
 *   crossesDirectoryBoundary: 2
 *   inExecutionFlow:          3
 */
export function computeSurpriseScore(
  crossesCommunityBoundary: boolean,
  crossesDirectoryBoundary: boolean,
  inExecutionFlow: boolean,
): number {
  return (
    (crossesCommunityBoundary ? 4 : 0) +
    (crossesDirectoryBoundary ? 2 : 0) +
    (inExecutionFlow ? 3 : 0)
  );
}

/**
 * Extract top-level directory from a file path (first segment after normalising).
 * Returns '' for root-level files.
 */
export function topLevelDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.length > 1 ? (parts[0] ?? '') : '';
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function impactCommand(symbolName: string): string {
  return `ontoindex impact ${shellQuote(symbolName)}`;
}

function buildHubExplanation(entry: {
  name: string;
  degree: number;
  processFlowCount: number;
  communitySpan: number;
  hubScore: number;
}): HubExplanation {
  const reasons = [`degree ${entry.degree}`];
  if (entry.processFlowCount > 0) reasons.push(`${entry.processFlowCount} process flow(s)`);
  if (entry.communitySpan > 1) reasons.push(`${entry.communitySpan} communities`);
  reasons.push(`score ${entry.hubScore.toFixed(1)}`);
  const reasonSummary = summarizeReasonParts(reasons);

  return {
    summary: `Ranked as hub-like from ${reasonSummary}.`,
    components: {
      degree: entry.degree,
      processFlowCount: entry.processFlowCount,
      communitySpan: entry.communitySpan,
      hubScore: entry.hubScore,
    },
    verifyCommand: impactCommand(entry.name),
  };
}

function buildSurprisingEdgeExplanation(edge: {
  sourceName: string;
  targetName: string;
  edgeType: string;
  crossesCommunityBoundary: boolean;
  crossesDirectoryBoundary: boolean;
  inExecutionFlow: boolean;
  surpriseScore: number;
}): SurprisingEdgeExplanation {
  const flags: string[] = [];
  if (edge.crossesCommunityBoundary) flags.push('crosses community boundary');
  if (edge.crossesDirectoryBoundary) flags.push('crosses directory boundary');
  if (edge.inExecutionFlow) flags.push('appears in an execution flow');
  const flagSummary = summarizeReasonParts(flags, 'no boundary or flow flags');

  return {
    summary: `${edge.edgeType} edge scored as surprising because it ${flagSummary}; score ${edge.surpriseScore}.`,
    flags: {
      crossesCommunityBoundary: edge.crossesCommunityBoundary,
      crossesDirectoryBoundary: edge.crossesDirectoryBoundary,
      inExecutionFlow: edge.inExecutionFlow,
      edgeType: edge.edgeType,
      surpriseScore: edge.surpriseScore,
    },
    verifyCommands: [impactCommand(edge.sourceName), impactCommand(edge.targetName)],
  };
}

// ---------------------------------------------------------------------------
// Text formatters (exported for unit tests)
// ---------------------------------------------------------------------------

export function formatHubsText(report: HubReport): string {
  const lines: string[] = [];
  lines.push(DISCOVERY_LABEL);
  lines.push(`report hubs — repo: ${report.repoId}  top: ${report.topN}`);
  lines.push('');

  if (report.hubs.length === 0) {
    lines.push('no hubs found (index missing, empty graph, or no connected nodes)');
  } else {
    lines.push(
      `${'rank'.padEnd(5)}${'name'.padEnd(40)}${'deg'.padStart(5)}${'proc'.padStart(6)}${'comm'.padStart(6)}${'score'.padStart(8)}`,
    );
    lines.push('─'.repeat(70));
    for (let i = 0; i < report.hubs.length; i++) {
      const h = report.hubs[i]!;
      const rank = String(i + 1).padEnd(5);
      const name = h.name.slice(0, 39).padEnd(40);
      const deg = String(h.degree).padStart(5);
      const proc = String(h.processFlowCount).padStart(6);
      const comm = String(h.communitySpan).padStart(6);
      const score = h.hubScore.toFixed(1).padStart(8);
      lines.push(`${rank}${name}${deg}${proc}${comm}${score}`);
      if (h.filePath) {
        lines.push(`     ${h.filePath}`);
      }
      const explanation = h.explanation ?? buildHubExplanation(h);
      lines.push(`     why: ${explanation.summary} verify with: ${explanation.verifyCommand}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('warnings:');
    for (const w of report.warnings) {
      lines.push(`  • ${w}`);
    }
  }

  lines.push('');
  lines.push(
    'This is a ranked discovery view. To verify blast-radius for a symbol, run: ontoindex impact <symbol>',
  );

  return lines.join('\n');
}

export function formatSurprisingConnectionsText(report: SurprisingConnectionsReport): string {
  const lines: string[] = [];
  lines.push(DISCOVERY_LABEL);
  lines.push(`report surprising-connections — repo: ${report.repoId}  top: ${report.topN}`);
  lines.push('');

  if (report.edges.length === 0) {
    lines.push(
      'no surprising connections found (index missing, empty graph, or no cross-boundary edges)',
    );
  } else {
    for (let i = 0; i < report.edges.length; i++) {
      const e = report.edges[i]!;
      lines.push(`#${i + 1}  score=${e.surpriseScore}  ${e.edgeType}`);
      lines.push(`   from: ${e.sourceName}  (${e.sourceFile})`);
      lines.push(`   to:   ${e.targetName}  (${e.targetFile})`);
      const flags: string[] = [];
      if (e.crossesCommunityBoundary)
        flags.push(`cross-community: ${e.sourceCommunity} → ${e.targetCommunity}`);
      if (e.crossesDirectoryBoundary)
        flags.push(`cross-directory: ${topLevelDir(e.sourceFile)} → ${topLevelDir(e.targetFile)}`);
      if (e.inExecutionFlow) flags.push('in-execution-flow');
      if (flags.length > 0) lines.push(`   flags: ${flags.join('  ')}`);
      const explanation = e.explanation ?? buildSurprisingEdgeExplanation(e);
      lines.push(`   why: ${explanation.summary}`);
      lines.push(`   verify: ${explanation.verifyCommands.join('  or  ')}`);
      lines.push('');
    }
  }

  if (report.warnings.length > 0) {
    lines.push('warnings:');
    for (const w of report.warnings) {
      lines.push(`  • ${w}`);
    }
    lines.push('');
  }

  lines.push(
    'This is a ranked discovery view. To verify blast-radius for a symbol, run: ontoindex impact <symbol>',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

type QueryRow = Record<string, unknown> | readonly unknown[];

function rowStr(row: QueryRow, key: string, index: number, fallback = ''): string {
  const keyed = (row as Record<string, unknown>)[key];
  if (keyed !== undefined && keyed !== null) return String(keyed);
  if (Array.isArray(row) && row[index] !== undefined) return String(row[index]);
  return fallback;
}

function rowNum(row: QueryRow, key: string, index: number): number {
  const keyed = (row as Record<string, unknown>)[key];
  const raw = keyed !== undefined ? keyed : Array.isArray(row) ? row[index] : undefined;
  return Number(raw) || 0;
}

// ---------------------------------------------------------------------------
// Hub data builder
// ---------------------------------------------------------------------------

export async function buildHubReport(repoId: string, topN: number): Promise<HubReport> {
  const warnings: string[] = [];

  // Query degree per symbol (CALLS + REFERENCES in both directions)
  let degreeRows: QueryRow[] = [];
  try {
    degreeRows = (await executeParameterized(
      repoId,
      `MATCH (s)
       WHERE s.id IS NOT NULL AND s.name IS NOT NULL
         AND NOT s:File AND NOT s:Process AND NOT s:Community
       OPTIONAL MATCH (s)-[out:CodeRelation]->(x) WHERE out.type IN ['CALLS', 'REFERENCES']
       OPTIONAL MATCH (caller)-[inc:CodeRelation]->(s) WHERE inc.type IN ['CALLS', 'REFERENCES']
       WITH s, count(DISTINCT out) + count(DISTINCT inc) AS degree
       WHERE degree > 0
       RETURN s.id AS id, s.name AS name, s.type AS stype,
              s.filePath AS filePath, degree
       ORDER BY degree DESC
       LIMIT ${topN * 5}`,
      {},
    )) as QueryRow[];
  } catch (err) {
    warnings.push(`degree query failed: ${err instanceof Error ? err.message : String(err)}`);
    return { repoId, topN, hubs: [], warnings, isRankedDiscovery: true };
  }

  if (degreeRows.length === 0) {
    warnings.push('no connected symbols found in graph');
    return { repoId, topN, hubs: [], warnings, isRankedDiscovery: true };
  }

  // Collect node IDs for batch enrichment
  const candidateIds = degreeRows.map((r) => rowStr(r, 'id', 0)).filter(Boolean);

  // Process flow count per node
  const processCountMap = new Map<string, number>();
  try {
    const procRows = (await executeParameterized(
      repoId,
      `MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
       WHERE n.id IN $ids
       RETURN n.id AS nid, count(DISTINCT p.id) AS procCount`,
      { ids: candidateIds },
    )) as QueryRow[];
    for (const row of procRows) {
      const nid = rowStr(row, 'nid', 0);
      if (nid) processCountMap.set(nid, rowNum(row, 'procCount', 1));
    }
  } catch {
    // best-effort; omitted means 0
  }

  // Community span per node
  const communitySpanMap = new Map<string, number>();
  try {
    const commRows = (await executeParameterized(
      repoId,
      `MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
       WHERE n.id IN $ids
       RETURN n.id AS nid, count(DISTINCT c.id) AS commCount`,
      { ids: candidateIds },
    )) as QueryRow[];
    for (const row of commRows) {
      const nid = rowStr(row, 'nid', 0);
      if (nid) communitySpanMap.set(nid, rowNum(row, 'commCount', 1));
    }
  } catch {
    // best-effort; omitted means 0
  }

  // Build scored hub entries
  const entries: HubEntry[] = degreeRows.map((row) => {
    const nodeId = rowStr(row, 'id', 0);
    const degree = rowNum(row, 'degree', 4);
    const processFlowCount = processCountMap.get(nodeId) ?? 0;
    const communitySpan = communitySpanMap.get(nodeId) ?? 0;
    const hubScore = computeHubScore(degree, processFlowCount, communitySpan);
    const entry = {
      nodeId,
      name: rowStr(row, 'name', 1, '(unknown)'),
      type: rowStr(row, 'stype', 2, 'unknown'),
      filePath: rowStr(row, 'filePath', 3),
      degree,
      processFlowCount,
      communitySpan,
      hubScore,
    };
    return { ...entry, explanation: buildHubExplanation(entry) };
  });

  // Re-sort by hubScore (degree query already approximate; score may reorder)
  entries.sort((a, b) => b.hubScore - a.hubScore);

  return {
    repoId,
    topN,
    hubs: entries.slice(0, topN),
    warnings,
    isRankedDiscovery: true,
  };
}

// ---------------------------------------------------------------------------
// Surprising-connections data builder
// ---------------------------------------------------------------------------

export async function buildSurprisingConnectionsReport(
  repoId: string,
  topN: number,
): Promise<SurprisingConnectionsReport> {
  const warnings: string[] = [];

  // Query edges that cross community boundaries (prime surprising-connection signal)
  let edgeRows: QueryRow[] = [];
  try {
    edgeRows = (await executeParameterized(
      repoId,
      `MATCH (src)-[r:CodeRelation]->(tgt)
       WHERE r.type IN ['CALLS', 'REFERENCES', 'IMPORTS']
         AND src.id IS NOT NULL AND tgt.id IS NOT NULL
         AND src.name IS NOT NULL AND tgt.name IS NOT NULL
         AND NOT src:File AND NOT tgt:File
         AND NOT src:Process AND NOT tgt:Process
       OPTIONAL MATCH (src)-[:CodeRelation {type: 'MEMBER_OF'}]->(sc:Community)
       OPTIONAL MATCH (tgt)-[:CodeRelation {type: 'MEMBER_OF'}]->(tc:Community)
       WITH src, tgt, r,
            coalesce(sc.heuristicLabel, '') AS srcComm,
            coalesce(tc.heuristicLabel, '') AS tgtComm
       WHERE srcComm <> tgtComm OR srcComm = ''
       RETURN src.id AS srcId, src.name AS srcName,
              coalesce(src.filePath, '') AS srcFile,
              tgt.id AS tgtId, tgt.name AS tgtName,
              coalesce(tgt.filePath, '') AS tgtFile,
              r.type AS edgeType,
              srcComm, tgtComm
       LIMIT ${topN * 10}`,
      {},
    )) as QueryRow[];
  } catch (err) {
    warnings.push(`edge query failed: ${err instanceof Error ? err.message : String(err)}`);
    return { repoId, topN, edges: [], warnings, isRankedDiscovery: true };
  }

  if (edgeRows.length === 0) {
    // Fallback: no community data — query any edges (still useful as discovery)
    try {
      edgeRows = (await executeParameterized(
        repoId,
        `MATCH (src)-[r:CodeRelation]->(tgt)
         WHERE r.type IN ['CALLS', 'REFERENCES', 'IMPORTS']
           AND src.id IS NOT NULL AND tgt.id IS NOT NULL
           AND src.name IS NOT NULL AND tgt.name IS NOT NULL
           AND NOT src:File AND NOT tgt:File
         RETURN src.id AS srcId, src.name AS srcName,
                coalesce(src.filePath, '') AS srcFile,
                tgt.id AS tgtId, tgt.name AS tgtName,
                coalesce(tgt.filePath, '') AS tgtFile,
                r.type AS edgeType, '' AS srcComm, '' AS tgtComm
         LIMIT ${topN * 10}`,
        {},
      )) as QueryRow[];
    } catch (err) {
      warnings.push(
        `fallback edge query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { repoId, topN, edges: [], warnings, isRankedDiscovery: true };
    }
  }

  // Collect node IDs for process-flow membership check
  const allNodeIds = [
    ...edgeRows.map((r) => rowStr(r, 'srcId', 0)),
    ...edgeRows.map((r) => rowStr(r, 'tgtId', 3)),
  ].filter(Boolean);

  const inFlowSet = new Set<string>();
  if (allNodeIds.length > 0) {
    try {
      const flowRows = (await executeParameterized(
        repoId,
        `MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
         WHERE n.id IN $ids
         RETURN DISTINCT n.id AS nid`,
        { ids: allNodeIds },
      )) as QueryRow[];
      for (const row of flowRows) {
        const nid = rowStr(row, 'nid', 0);
        if (nid) inFlowSet.add(nid);
      }
    } catch {
      // best-effort
    }
  }

  // Build scored surprising-edge entries
  const edges: SurprisingEdge[] = edgeRows.map((row) => {
    const srcId = rowStr(row, 'srcId', 0);
    const srcName = rowStr(row, 'srcName', 1, '(unknown)');
    const srcFile = rowStr(row, 'srcFile', 2);
    const tgtId = rowStr(row, 'tgtId', 3);
    const tgtName = rowStr(row, 'tgtName', 4, '(unknown)');
    const tgtFile = rowStr(row, 'tgtFile', 5);
    const edgeType = rowStr(row, 'edgeType', 6, 'UNKNOWN');
    const srcComm = rowStr(row, 'srcComm', 7);
    const tgtComm = rowStr(row, 'tgtComm', 8);

    const crossesCommunityBoundary = srcComm !== '' && tgtComm !== '' && srcComm !== tgtComm;
    const crossesDirectoryBoundary =
      topLevelDir(srcFile) !== topLevelDir(tgtFile) &&
      topLevelDir(srcFile) !== '' &&
      topLevelDir(tgtFile) !== '';
    const inExecutionFlow = inFlowSet.has(srcId) || inFlowSet.has(tgtId);

    const entry = {
      sourceId: srcId,
      sourceName: srcName,
      sourceFile: srcFile,
      sourceCommunity: srcComm,
      targetId: tgtId,
      targetName: tgtName,
      targetFile: tgtFile,
      targetCommunity: tgtComm,
      edgeType,
      crossesCommunityBoundary,
      crossesDirectoryBoundary,
      inExecutionFlow,
      surpriseScore: computeSurpriseScore(
        crossesCommunityBoundary,
        crossesDirectoryBoundary,
        inExecutionFlow,
      ),
    };
    return { ...entry, explanation: buildSurprisingEdgeExplanation(entry) };
  });

  // Sort by surpriseScore descending; deduplicate by (srcId, tgtId, edgeType)
  edges.sort((a, b) => b.surpriseScore - a.surpriseScore);
  const seen = new Set<string>();
  const deduped: SurprisingEdge[] = [];
  for (const e of edges) {
    const key = `${e.sourceId}:${e.targetId}:${e.edgeType}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(e);
    }
    if (deduped.length >= topN) break;
  }

  return {
    repoId,
    topN,
    edges: deduped,
    warnings,
    isRankedDiscovery: true,
  };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export interface ReportHubsOptions {
  top?: string;
  json?: boolean;
  repo?: string;
}

export interface ReportSurprisingOptions {
  top?: string;
  json?: boolean;
  repo?: string;
}

async function resolveRepoId(repoOpt?: string): Promise<{ repoRoot: string; repoId: string }> {
  let repoRoot: string;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    repoRoot =
      (repoOpt ? path.resolve(repoOpt) : null) ?? getGitRoot(process.cwd()) ?? process.cwd();
  }
  if (repoOpt) repoRoot = path.resolve(repoOpt);
  const repoId = path.basename(repoRoot).toLowerCase();
  return { repoRoot, repoId };
}

export async function reportHubsCommand(opts: ReportHubsOptions): Promise<void> {
  const topN = Math.max(1, Math.min(200, parseInt(opts.top ?? '20', 10) || 20));
  const { repoRoot, repoId } = await resolveRepoId(opts.repo);

  const { storagePath, lbugPath } = getStoragePaths(repoRoot);
  const meta = await loadMeta(storagePath);

  if (!meta) {
    const msg = 'no OntoIndex index found — run `ontoindex analyze` first';
    if (opts.json) {
      const report: HubReport = {
        repoId,
        topN,
        hubs: [],
        warnings: [msg],
        isRankedDiscovery: true,
      };
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.error(`error: ${msg}`);
      process.exitCode = 1;
    }
    return;
  }

  let report: HubReport;
  try {
    await initLbug(repoId, lbugPath);
    report = await buildHubReport(repoId, topN);
    report = withIndexCapabilityWarnings(report, formatIndexCapabilityWarnings(meta));
  } catch (err) {
    const msg = `hub report failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`error: ${msg}`);
    process.exitCode = 1;
    return;
  } finally {
    try {
      await closeLbug(repoId);
    } catch {
      /* best-effort */
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHubsText(report));
  }
}

export async function reportSurprisingConnectionsCommand(
  opts: ReportSurprisingOptions,
): Promise<void> {
  const topN = Math.max(1, Math.min(200, parseInt(opts.top ?? '20', 10) || 20));
  const { repoRoot, repoId } = await resolveRepoId(opts.repo);

  const { storagePath, lbugPath } = getStoragePaths(repoRoot);
  const meta = await loadMeta(storagePath);

  if (!meta) {
    const msg = 'no OntoIndex index found — run `ontoindex analyze` first';
    if (opts.json) {
      const report: SurprisingConnectionsReport = {
        repoId,
        topN,
        edges: [],
        warnings: [msg],
        isRankedDiscovery: true,
      };
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.error(`error: ${msg}`);
      process.exitCode = 1;
    }
    return;
  }

  let report: SurprisingConnectionsReport;
  try {
    await initLbug(repoId, lbugPath);
    report = await buildSurprisingConnectionsReport(repoId, topN);
    report = withIndexCapabilityWarnings(report, formatIndexCapabilityWarnings(meta));
  } catch (err) {
    const msg = `surprising-connections report failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`error: ${msg}`);
    process.exitCode = 1;
    return;
  } finally {
    try {
      await closeLbug(repoId);
    } catch {
      /* best-effort */
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSurprisingConnectionsText(report));
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerReportCommands(program: Command): void {
  const report = program
    .command('report')
    .description(
      'Ranked/lossy discovery reports (NOT complete impact analysis).\n' +
        'These commands surface structural patterns for exploration only.\n' +
        'For authoritative blast-radius, use: ontoindex impact <symbol>',
    );

  report
    .command('hubs')
    .description(
      'List the most structurally central symbols in the graph.\n' +
        'Ranked by degree, process-flow participation, and community span.\n' +
        'RANKED DISCOVERY VIEW — not a complete impact analysis.',
    )
    .option('-n, --top <n>', 'Number of hubs to show (default: 20, max: 200)', '20')
    .option('--json', 'Emit JSON (includes isRankedDiscovery: true guardrail field)')
    .option('-r, --repo <path>', 'Indexed repository path (default: current git root)')
    .addHelpText(
      'after',
      `
This command is a RANKED DISCOVERY VIEW.
It is lossy: hubs with similar scores may appear in different order across runs.
It never replaces or suppresses complete impact output from \`ontoindex impact\`.

Hub score = degree × 1 + processFlows × 5 + (communitySpan−1) × 3

Examples:
  ontoindex report hubs
  ontoindex report hubs --top 10
  ontoindex report hubs --json
`,
    )
    .action((opts: ReportHubsOptions) => reportHubsCommand(opts));

  report
    .command('surprising-connections')
    .description(
      'List the most surprising cross-boundary edges in the graph.\n' +
        'Ranked by community boundary crossing, directory crossing, and execution-flow presence.\n' +
        'RANKED DISCOVERY VIEW — not a complete impact analysis.',
    )
    .option('-n, --top <n>', 'Number of connections to show (default: 20, max: 200)', '20')
    .option('--json', 'Emit JSON (includes isRankedDiscovery: true guardrail field)')
    .option('-r, --repo <path>', 'Indexed repository path (default: current git root)')
    .addHelpText(
      'after',
      `
This command is a RANKED DISCOVERY VIEW.
It is lossy: edges with equal surprise scores may appear in different order across runs.
It never replaces or suppresses complete impact output from \`ontoindex impact\`.

Each edge includes: source file, target file, edge type, provenance flags.

Surprise score = crossesCommunity × 4 + crossesDirectory × 2 + inExecutionFlow × 3

Examples:
  ontoindex report surprising-connections
  ontoindex report surprising-connections --top 10
  ontoindex report surprising-connections --json
`,
    )
    .action((opts: ReportSurprisingOptions) => reportSurprisingConnectionsCommand(opts));
}
