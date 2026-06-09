/**
 * Audit Report Backend
 *
 * Fans out to 8 existing analysis backends, merges their results,
 * and renders a consolidated Markdown audit report.
 */

import path from 'path';
import {
  buildMermaidInterModuleGraph,
  type InterModuleEdge,
} from '../../core/wiki/wiki-diagrams.js';
import { resolveLLMConfig, callLLM } from '../../core/wiki/llm-client.js';
import { pageKey, getCachedPage, setCachedPage } from '../../core/wiki/wiki-cache.js';
import { runDeadCode } from './backend-dead-code.js';
import { runCycleDetect } from './backend-cycle-detect.js';
import { runCouplingMatrix } from './backend-coupling-matrix.js';
import { runTechDebt } from './backend-tech-debt.js';
import { runHotspotAnalysis } from './backend-hotspot-analysis.js';
import { runBoundaryViolations } from './backend-boundary-violations.js';
import { runVerificationGap } from './backend-verification-gap.js';
import { runGraphDiff } from './backend-graph-diff.js';

type RepoHandle = {
  readonly id: string;
  readonly name: string;
  readonly repoPath: string;
  readonly storagePath: string;
  readonly lastCommit?: string;
};

const AUDIT_CONFIG = {
  RISK_SURFACE_LIMIT: 10,
  DEAD_CODE_LIMIT: 20,
  TECH_DEBT_LIMIT: 10,
  HOTSPOT_LIMIT: 10,
  GRAPH_DIFF_LIMIT: 10,
  FANOUT_CONCURRENCY: 2,
};

// Bumped when the annotation prompt or output contract changes. Cache keys
// include this so prompt edits invalidate prior cached annotations.
const AUDIT_ANNOTATION_PROMPT_VERSION = '1';

const AUDIT_ANNOTATION_SYSTEM_PROMPT =
  'You are a senior code auditor. Given structured findings produced by a static-analysis tool, ' +
  'write 3 to 5 bullet points that INTERPRET the highest-risk items and the relationships between them. ' +
  'Do NOT restate the raw findings — explain what they mean together. ' +
  'Be concrete; refer to specific symbols and files when relevant. ' +
  'No preamble, no closing remarks — only the bullets.';

/**
 * Normalize findings to a deterministic shape for cache-key hashing.
 * Strips volatile fields and rounds floats so minor precision differences
 * across Node.js versions or log-scale inputs don't produce spurious cache misses.
 */
function normalizeForHash(
  findings: AuditReportResult,
): Omit<AuditReportResult, 'generatedAt' | 'annotation' | 'warnings'> {
  const { annotation: _omit, generatedAt: _ts, warnings: _w, ...stable } = findings;
  return {
    ...stable,
    riskSurface: stable.riskSurface.map((r) => ({
      ...r,
      riskScore: Math.round(r.riskScore * 100) / 100,
    })),
    couplingViolations: stable.couplingViolations.map((c) => ({
      ...c,
      instability: Math.round(c.instability * 1000) / 1000,
    })),
    // Sort string arrays so DB-order non-determinism doesn't produce spurious cache misses.
    // verificationGaps is also capped at 50 to bound LLM prompt size.
    boundaryViolations: [...stable.boundaryViolations].sort(),
    verificationGaps: [...stable.verificationGaps].sort().slice(0, 50),
    deadCandidates: [...stable.deadCandidates].sort(),
    recentDrift: [...stable.recentDrift].sort((a, b) =>
      `${a.type}:${a.source}:${a.target}`.localeCompare(`${b.type}:${b.source}:${b.target}`),
    ),
    openCycles: [...stable.openCycles]
      .map((cycle) => [...cycle].sort((a, b) => a.filePath.localeCompare(b.filePath)))
      .sort((a, b) => (a[0]?.filePath ?? '').localeCompare(b[0]?.filePath ?? '')),
  };
}

function buildAnnotationPrompt(findings: AuditReportResult): string {
  // Normalise before serialising: strips volatile fields (generatedAt, annotation)
  // and rounds floats (riskScore to 2dp, instability to 3dp) so the cache key is
  // stable across environments and minor precision jitter.
  const compact = JSON.stringify(normalizeForHash(findings), null, 2);
  return `FINDINGS:\n\n\`\`\`json\n${compact}\n\`\`\`\n\nWrite 3-5 bullet points interpreting these findings.`;
}

/**
 * Generate an LLM annotation for the audit findings, cached by content hash.
 * Returns null when no LLM is configured or the call fails — annotation is
 * always optional, never fatal.
 */
async function generateAnnotation(
  repo: RepoHandle,
  findings: AuditReportResult,
  force: boolean,
): Promise<string | null> {
  const config = await resolveLLMConfig();
  if (!config.apiKey) return null;

  const prompt = buildAnnotationPrompt(findings);
  const cacheDir = path.join(repo.storagePath, 'audit-cache');
  const key = pageKey([prompt], config.model, AUDIT_ANNOTATION_PROMPT_VERSION);

  if (!force) {
    const cached = await getCachedPage(cacheDir, key);
    if (cached !== null) return cached;
  }

  try {
    const response = await callLLM(prompt, config, AUDIT_ANNOTATION_SYSTEM_PROMPT);
    const annotation = response.content.trim();
    if (annotation.length > 0) {
      await setCachedPage(cacheDir, key, annotation);
    }
    return annotation;
  } catch {
    return null;
  }
}

// ─── Minimal fan-out contracts ──────────────────────────────────────────────
// Each interface captures only the fields that runAuditReport reads from the
// corresponding backend. Extra fields from the backend are fine; a missing
// field here becomes a TypeScript error rather than a silent undefined at
// runtime. These are intentionally local — they do not import from the
// backends, which keeps the orchestrator decoupled from internal backend types.

interface DeadCodeFanOut {
  entries: Array<{ name: string; filePath: string }>;
}

interface CycleFanOut {
  cycles: Array<{ members: Array<{ name: string; filePath: string }> }>;
}

interface CouplingFanOut {
  rows: Array<{ community: string; ca: number; ce: number; instability: number }>;
}

interface TechDebtFanOut {
  symbols: Array<{ name: string; filePath: string; score: number; callerCount: number }>;
}

interface HotspotFanOut {
  hotspots: Array<{ file: string; commits: number }>;
}

interface BoundaryFanOut {
  violations: Array<{ source_file: string; target_file: string; rule_label?: string }>;
}

interface VerificationGapFanOut {
  coverage: Array<{ status: string; filePath?: string; file?: string }>;
}

interface GraphDiffFanOut {
  added: Array<{
    source_name?: string;
    source_file?: string;
    target_name?: string;
    target_file?: string;
  }>;
  removed: Array<{ source_file?: string; target_file?: string }>;
}

type DeadCodeRepoHandle = Parameters<typeof runDeadCode>[0];
type CycleDetectRepoHandle = Parameters<typeof runCycleDetect>[0];
type CouplingMatrixRepoHandle = Parameters<typeof runCouplingMatrix>[0];
type TechDebtRepoHandle = Parameters<typeof runTechDebt>[0];
type HotspotAnalysisRepoHandle = Parameters<typeof runHotspotAnalysis>[0];
type BoundaryViolationsRepoHandle = Parameters<typeof runBoundaryViolations>[0];
type VerificationGapRepoHandle = Parameters<typeof runVerificationGap>[0];
type GraphDiffRepoHandle = Parameters<typeof runGraphDiff>[0];

function asDeadCodeRepo(repo: RepoHandle): DeadCodeRepoHandle {
  return repo;
}

function asCycleDetectRepo(repo: RepoHandle): CycleDetectRepoHandle {
  return repo;
}

function asCouplingMatrixRepo(repo: RepoHandle): CouplingMatrixRepoHandle {
  return repo;
}

function asTechDebtRepo(repo: RepoHandle): TechDebtRepoHandle {
  return repo;
}

function asHotspotAnalysisRepo(repo: RepoHandle): HotspotAnalysisRepoHandle {
  return repo;
}

function asBoundaryViolationsRepo(repo: RepoHandle): BoundaryViolationsRepoHandle {
  return repo;
}

function asVerificationGapRepo(repo: RepoHandle): VerificationGapRepoHandle {
  return repo;
}

function asGraphDiffRepo(repo: RepoHandle): GraphDiffRepoHandle {
  return repo;
}

// ─── Public interfaces ───────────────────────────────────────────────────────

export interface RiskItem {
  symbol: string;
  file: string;
  riskScore: number;
  callerCount: number;
  churn: number;
}

export interface AuditReportResult {
  generatedAt: string;
  repo: string;
  commitId: string;
  riskSurface: RiskItem[];
  openCycles: Array<Array<{ name: string; filePath: string }>>;
  couplingViolations: Array<{ module: string; ca: number; ce: number; instability: number }>;
  boundaryViolations: string[];
  verificationGaps: string[];
  deadCandidates: string[];
  recentDrift: Array<{ type: string; source: string; target: string }>;
  /** Names of backends that failed during fan-out; report data is partial when non-empty. */
  warnings: string[];
  annotation?: string;
}

export async function runAuditReport(
  repo: RepoHandle,
  params: { annotate?: boolean; since?: string; force?: boolean },
): Promise<AuditReportResult> {
  const BACKEND_NAMES = [
    'dead-code',
    'cycle-detect',
    'coupling-matrix',
    'tech-debt',
    'hotspot-analysis',
    'boundary-violations',
    'verification-gap',
    'graph-diff',
  ] as const;

  type BackendResult = unknown | Error;
  const backendTasks: Array<() => Promise<BackendResult>> = [
    () =>
      runDeadCode(asDeadCodeRepo(repo), { limit: AUDIT_CONFIG.DEAD_CODE_LIMIT }).catch(
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      ),
    () =>
      runCycleDetect(asCycleDetectRepo(repo), {}).catch((e: unknown) =>
        e instanceof Error ? e : new Error(String(e)),
      ),
    () =>
      runCouplingMatrix(asCouplingMatrixRepo(repo), {}).catch((e: unknown) =>
        e instanceof Error ? e : new Error(String(e)),
      ),
    () =>
      runTechDebt(asTechDebtRepo(repo), {
        limit: AUDIT_CONFIG.TECH_DEBT_LIMIT,
        since: params.since,
      }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    () =>
      runHotspotAnalysis(asHotspotAnalysisRepo(repo), {
        limit: AUDIT_CONFIG.HOTSPOT_LIMIT,
        since: params.since,
      }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    () =>
      runBoundaryViolations(asBoundaryViolationsRepo(repo), {}).catch((e: unknown) =>
        e instanceof Error ? e : new Error(String(e)),
      ),
    () =>
      runVerificationGap(asVerificationGapRepo(repo), {}).catch((e: unknown) =>
        e instanceof Error ? e : new Error(String(e)),
      ),
    () =>
      runGraphDiff(asGraphDiffRepo(repo), { limit: AUDIT_CONFIG.GRAPH_DIFF_LIMIT }).catch(
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      ),
  ];

  const rawResults = await runAuditBackendsBounded(backendTasks, AUDIT_CONFIG.FANOUT_CONCURRENCY);

  const warnings: string[] = [];
  const [
    deadResult,
    cycleResult,
    couplingResult,
    debtResult,
    hotspotResult,
    violationsResult,
    gapResult,
    diffResult,
  ] = rawResults.map((r, i) => {
    if (r instanceof Error) {
      warnings.push(`${BACKEND_NAMES[i]}: ${r.message}`);
      return null;
    }
    return r;
  });

  const dead = (deadResult as DeadCodeFanOut | null)?.entries ?? [];
  const cycles = (cycleResult as CycleFanOut | null)?.cycles ?? [];
  const coupling = (couplingResult as CouplingFanOut | null)?.rows ?? [];
  const debtSymbols = (debtResult as TechDebtFanOut | null)?.symbols ?? [];
  const hotspots = (hotspotResult as HotspotFanOut | null)?.hotspots ?? [];
  const violations = (violationsResult as BoundaryFanOut | null)?.violations ?? [];
  const coverage = (gapResult as VerificationGapFanOut | null)?.coverage ?? [];
  const diff = diffResult as GraphDiffFanOut | null;

  // Build a churn map: filePath → commits count from hotspot data
  const churnMap = new Map<string, number>();
  for (const h of hotspots) {
    if (h.file) churnMap.set(h.file, h.commits);
  }

  const riskSurface: RiskItem[] = debtSymbols
    .map((sym) => {
      const churn = churnMap.get(sym.filePath) ?? 1;
      return {
        symbol: sym.name,
        file: sym.filePath,
        riskScore: Math.round((sym.score ?? 1) * Math.log(1 + Math.max(churn, 1)) * 10000) / 10000,
        callerCount: sym.callerCount ?? 0,
        churn,
      };
    })
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, AUDIT_CONFIG.RISK_SURFACE_LIMIT);

  const openCycles = cycles.map((c) =>
    c.members.map((m) => ({ name: m.name ?? '', filePath: m.filePath ?? '' })),
  );

  const couplingViolations = coupling
    .filter((c) => (c.instability ?? 0) > 0.8)
    .map((c) => ({
      module: c.community ?? 'unknown',
      ca: c.ca ?? 0,
      ce: c.ce ?? 0,
      instability: c.instability ?? 0,
    }));

  const boundaryViolations = violations.map(
    (v) => `${v.source_file} → ${v.target_file}${v.rule_label ? ` (${v.rule_label})` : ''}`,
  );

  const verificationGaps = coverage
    .filter((c) => c.status === 'uncovered')
    .map((c) => c.filePath ?? c.file ?? '')
    .filter(Boolean);

  const deadCandidates = dead.slice(0, 20).map((d) => `${d.name} (${d.filePath})`);

  const recentDrift = [
    ...(diff?.added ?? []).slice(0, 5).map((e) => ({
      type: 'added',
      source: e.source_name ?? e.source_file ?? '',
      target: e.target_name ?? e.target_file ?? '',
    })),
    ...(diff?.removed ?? []).slice(0, 5).map((e) => ({
      type: 'removed',
      source: e.source_file ?? '',
      target: e.target_file ?? '',
    })),
  ];

  const result: AuditReportResult = {
    generatedAt: new Date().toISOString(),
    repo: repo.name,
    commitId: repo.lastCommit ?? '',
    riskSurface,
    openCycles,
    couplingViolations,
    boundaryViolations,
    verificationGaps,
    deadCandidates,
    recentDrift,
    warnings,
  };

  if (params.annotate) {
    const annotation = await generateAnnotation(repo, result, params.force === true);
    if (annotation !== null) {
      result.annotation = annotation;
    }
  }

  return result;
}

async function runAuditBackendsBounded(
  tasks: Array<() => Promise<unknown | Error>>,
  concurrency: number,
): Promise<Array<unknown | Error>> {
  const results: Array<unknown | Error> = new Array(tasks.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function formatAuditReport(result: AuditReportResult): string {
  const date = result.generatedAt.slice(0, 10);
  const sections: string[] = [];

  // Header
  sections.push(
    `# Audit Report — ${result.repo} (${date})\n\nGenerated: ${result.generatedAt} | Commit: ${result.commitId || 'unknown'}`,
  );

  // Risk Surface
  const riskRows = result.riskSurface
    .map(
      (r) =>
        `| ${r.symbol} | ${r.file} | ${r.riskScore.toFixed(2)} | ${r.callerCount} | ${r.churn} |`,
    )
    .join('\n');

  const riskSurfaceParts: string[] = [
    `## Risk Surface (top ${result.riskSurface.length})\n` +
      `| Symbol | File | Risk Score | Callers | Churn |\n` +
      `|--------|------|------------|---------|-------|\n` +
      (riskRows || '| — | — | — | — | — |'),
  ];

  // Top-risk ranking diagram — non-directional subgraph so rank order is not
  // misread as a call relationship between symbols.
  if (result.riskSurface.length > 1) {
    const top = result.riskSurface.slice(0, 5);
    const nodes = top
      .map((item, i) => {
        const id = `R${i + 1}`;
        const label = `#${i + 1}: ${item.symbol}\\n${item.file} | score ${item.riskScore.toFixed(2)}`;
        return `  ${id}["${label}"]`;
      })
      .join('\n');
    const rankDiagram = `flowchart TB\n  subgraph "Top Risk Rankings (by score)"\n${nodes}\n  end`;
    riskSurfaceParts.push(`### Top Risk Rankings\n\n\`\`\`mermaid\n${rankDiagram}\n\`\`\``);
  }

  sections.push(riskSurfaceParts.join('\n\n'));

  // Architectural Issues
  const cycleLines =
    result.openCycles.length > 0
      ? result.openCycles
          .map((members, i) => `- Cycle ${i + 1}: ${members.map((m) => m.name).join(' → ')}`)
          .join('\n')
      : 'No cycles detected.';

  const couplingRows =
    result.couplingViolations.length > 0
      ? result.couplingViolations
          .map((c) => `| ${c.module} | ${c.ca} | ${c.ce} | ${c.instability.toFixed(2)} |`)
          .join('\n')
      : null;

  const couplingTable =
    couplingRows !== null
      ? `| Module | Ca | Ce | Instability |\n|--------|----|----|-------------|\n${couplingRows}`
      : 'No high-instability modules.';

  // Coupling inter-module diagram — show Ce (efferent) dependency weight per module
  let couplingDiagramBlock = '';
  if (result.couplingViolations.length > 1) {
    const violations = result.couplingViolations.slice(0, 10);
    const moduleEdges: InterModuleEdge[] = [];
    for (let i = 0; i + 1 < violations.length; i++) {
      moduleEdges.push({
        from: violations[i].module,
        to: violations[i + 1].module,
        count: Math.round(violations[i].ce),
      });
    }
    const couplingDiagram = buildMermaidInterModuleGraph(moduleEdges);
    if (couplingDiagram) {
      couplingDiagramBlock = `\n\n### Coupling Dependency Graph\n\n\`\`\`mermaid\n${couplingDiagram}\n\`\`\``;
    }
  }

  const boundaryLines =
    result.boundaryViolations.length > 0
      ? result.boundaryViolations.map((v) => `- ${v}`).join('\n')
      : 'No boundary violations.';

  sections.push(
    `## Architectural Issues\n\n` +
      `### Import Cycles (${result.openCycles.length} detected)\n${cycleLines}\n\n` +
      `### Coupling Outliers (instability > 0.8)\n${couplingTable}` +
      couplingDiagramBlock +
      `\n\n### Boundary Violations (${result.boundaryViolations.length})\n${boundaryLines}`,
  );

  // Verification Gaps
  const gapLines =
    result.verificationGaps.length > 0
      ? result.verificationGaps.map((f) => `- ${f}`).join('\n')
      : 'No uncovered files detected.';
  sections.push(`## Verification Gaps (${result.verificationGaps.length})\n${gapLines}`);

  // Dead Code Candidates
  const deadLines =
    result.deadCandidates.length > 0
      ? result.deadCandidates.map((d) => `- ${d}`).join('\n')
      : 'No dead code candidates.';
  sections.push(`## Dead Code Candidates (${result.deadCandidates.length})\n${deadLines}`);

  // Recent Drift
  const driftLines =
    result.recentDrift.length > 0
      ? result.recentDrift.map((d) => `- [${d.type}] ${d.source} → ${d.target}`).join('\n')
      : 'No recent structural drift.';
  sections.push(`## Recent Drift\n${driftLines}`);

  let output = sections.join('\n\n');

  if (result.annotation) {
    output += `\n\n---\n*Interpretation*\n> ${result.annotation}`;
  }

  return output;
}
