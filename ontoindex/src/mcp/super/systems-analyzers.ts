import fs from 'node:fs/promises';
import path from 'node:path';

import { createEnvelopeFromLegacy } from '../shared/response-envelope.js';
import { resolveTargetContext } from '../shared/target-context.js';
import { readRegistry } from '../../storage/repo-manager.js';
import {
  diffAbi,
  type AbiDiffParams,
  type AbiDiffReport,
} from '../../core/systems-audit/abi-diff.js';
import {
  runConcurrencyAudit,
  type ConcurrencyAuditReport,
} from '../../core/systems-audit/concurrency-audit.js';
import {
  analyzeErrorTopology,
  type ErrorTopologyReport,
} from '../../core/systems-audit/error-topology.js';
import {
  simulateFault,
  type FaultSimulationRecord,
} from '../../core/systems-audit/fault-simulation.js';
import { extractFsm, type FsmExtractorReport } from '../../core/systems-audit/fsm-extractor.js';
import {
  runPressureImpact,
  type PressureImpactReport,
} from '../../core/systems-audit/pressure-impact.js';
import { traceTaint, type TaintTraceReport } from '../../core/systems-audit/taint-trace.js';

interface SourceParams {
  sourceText?: string;
  code?: string;
  path?: string;
  filePath?: string;
  legacyResponse?: boolean;
}

interface SourceInput {
  source: string;
  filePath?: string;
  warnings: string[];
}

export interface ExtractFsmParams extends SourceParams {
  target?: string;
  enumName?: string;
  stateVariable?: string;
  maxRecords?: number;
}

export interface ErrorTopologyMcpParams extends SourceParams {
  symbol?: string;
  maxRecords?: number;
}

export interface ConcurrencyAuditMcpParams extends SourceParams {
  symbol?: string;
  maxFindings?: number;
  maxEvidence?: number;
}

export interface PressureImpactMcpParams extends SourceParams {
  symbol?: string;
  maxWarnings?: number;
  maxEvidence?: number;
}

export interface TaintTraceMcpParams extends SourceParams {
  source?: string;
  sourceName?: string;
  sourceSymbol?: string;
  sink?: string;
  sinkName?: string;
  sanitizers?: string[];
  maxPaths?: number;
}

export interface AbiDiffMcpParams {
  sourceStruct?: string;
  sourceText?: string;
  sourcePath?: string;
  targetInterface?: string;
  targetText?: string;
  targetPath?: string;
  sourceLanguage?: AbiDiffParams['sourceLanguage'];
  targetLanguage?: AbiDiffParams['targetLanguage'];
  maxFindings?: number;
  legacyResponse?: boolean;
}

export interface SimulateFaultMcpParams extends SourceParams {
  target?: string;
  targetCall?: string;
  return_value?: string | number | boolean | null;
  returnValue?: string | number | boolean | null;
  trigger_path?: string | string[];
  triggerPath?: string | string[];
  maxBranches?: number;
  maxAssignments?: number;
  maxEarlyReturns?: number;
}

export async function gnExtractFsm(
  repoId: string,
  params: ExtractFsmParams,
): Promise<FsmExtractorReport | Record<string, unknown>> {
  const input = await loadSource(repoId, params);
  const stateVariable = params.stateVariable ?? inferTargetName(params.target) ?? 'state';
  const report = withWarnings(
    extractFsm({
      source: input.source,
      filePath: input.filePath,
      enumName: params.enumName ?? inferTargetName(params.target),
      stateVariable,
      maxRecords: params.maxRecords,
    }),
    input.warnings,
  );
  return wrapSystemsAnalyzerEnvelope(repoId, 'gn_extract_fsm', params, report, {
    capabilitiesUsed: ['filesystem-source', 'fsm-extractor'],
    nextTools: ['gn_path_verify', 'gn_simulate_fault'],
    evidence: readReportArray(report, 'transitions'),
  });
}

export async function gnErrorTopology(
  repoId: string,
  params: ErrorTopologyMcpParams,
): Promise<ErrorTopologyReport | Record<string, unknown>> {
  const input = await loadSource(repoId, params);
  const report = withWarnings(
    analyzeErrorTopology({
      source: input.source,
      filePath: input.filePath,
      symbol: params.symbol,
      maxRecords: params.maxRecords,
    }),
    input.warnings,
  );
  return wrapSystemsAnalyzerEnvelope(repoId, 'gn_error_topology', params, report, {
    capabilitiesUsed: ['filesystem-source', 'error-topology'],
    nextTools: ['gn_simulate_fault', 'gn_test_suggestions'],
    evidence: readReportArray(report, 'findings'),
  });
}

export async function gnConcurrencyAudit(
  repoId: string,
  params: ConcurrencyAuditMcpParams,
): Promise<ConcurrencyAuditReport | Record<string, unknown>> {
  const input = await loadSource(repoId, params);
  const report = withWarnings(
    runConcurrencyAudit({
      source: input.source,
      filePath: input.filePath ?? '<source>',
      symbol: params.symbol,
      maxFindings: params.maxFindings,
      maxEvidence: params.maxEvidence,
    }),
    input.warnings,
  );
  return wrapSystemsAnalyzerEnvelope(repoId, 'gn_concurrency_audit', params, report, {
    capabilitiesUsed: ['filesystem-source', 'concurrency-audit'],
    nextTools: ['gn_audit_logic', 'gn_trace_boundary'],
    evidence: readReportArray(report, 'findings'),
  });
}

export async function gnPressureImpact(
  repoId: string,
  params: PressureImpactMcpParams,
): Promise<PressureImpactReport | Record<string, unknown>> {
  const input = await loadSource(repoId, params);
  const report = runPressureImpact({
    source: input.source,
    filePath: input.filePath ?? '<source>',
    symbol: params.symbol,
    maxWarnings: params.maxWarnings,
    maxEvidence: params.maxEvidence,
  });
  const finalReport =
    input.warnings.length === 0
      ? report
      : { ...report, falsePositiveNotes: [...report.falsePositiveNotes, ...input.warnings] };
  return wrapSystemsAnalyzerEnvelope(repoId, 'gn_pressure_impact', params, finalReport, {
    capabilitiesUsed: ['filesystem-source', 'pressure-impact'],
    nextTools: ['gn_concurrency_audit', 'gn_test_suggestions'],
    evidence: readReportArray(finalReport, 'warnings'),
  });
}

export async function gnTaintTrace(
  repoId: string,
  params: TaintTraceMcpParams,
): Promise<TaintTraceReport | Record<string, unknown>> {
  const input = await loadSource(repoId, params);
  const report = withWarnings(
    traceTaint({
      source: input.source,
      filePath: input.filePath,
      sourceName: params.sourceName ?? params.source ?? params.sourceSymbol ?? 'source',
      sinkName: params.sinkName ?? params.sink ?? 'sink',
      sanitizers: params.sanitizers,
      maxPaths: params.maxPaths,
    }),
    input.warnings,
  );
  return wrapSystemsAnalyzerEnvelope(repoId, 'gn_taint_trace', params, report, {
    capabilitiesUsed: ['filesystem-source', 'taint-trace'],
    nextTools: ['gn_path_verify', 'gn_test_suggestions'],
    evidence: readReportArray(report, 'paths'),
  });
}

export async function gnAbiDiff(
  repoId: string,
  params: AbiDiffMcpParams,
): Promise<AbiDiffReport | Record<string, unknown>> {
  const source = await loadNamedText(
    repoId,
    params.sourceStruct ?? params.sourceText,
    params.sourcePath,
  );
  const target = await loadNamedText(
    repoId,
    params.targetInterface ?? params.targetText,
    params.targetPath,
  );
  const report = withWarnings(
    diffAbi({
      sourceStruct: source.text,
      targetInterface: target.text,
      sourceLanguage: params.sourceLanguage,
      targetLanguage: params.targetLanguage,
      sourcePath: source.filePath,
      targetPath: target.filePath,
      maxFindings: params.maxFindings,
    }),
    [...source.warnings, ...target.warnings],
  );
  return wrapSystemsAnalyzerEnvelope(repoId, 'gn_abi_diff', params, report, {
    capabilitiesUsed: ['filesystem-source', 'abi-diff'],
    typeAwareClaimsDowngraded:
      params.targetLanguage === 'typescript' &&
      (!target.filePath || !target.filePath.endsWith('.ts')),
    lspCapability: 'typescript-lsp',
    nextTools: ['gn_path_verify', 'gn_test_suggestions'],
    evidence: readReportArray(report, 'findings'),
  });
}

export async function gnSimulateFault(
  repoId: string,
  params: SimulateFaultMcpParams,
): Promise<(FaultSimulationRecord & { warnings?: string[] }) | Record<string, unknown>> {
  const input = await loadSource(repoId, params);
  const report = simulateFault({
    sourceText: input.source,
    filePath: input.filePath,
    targetCall: params.targetCall ?? params.target ?? 'target',
    returnValue: params.returnValue ?? params.return_value ?? -1,
    triggerPath: normalizeTriggerPath(params.triggerPath ?? params.trigger_path),
    maxBranches: params.maxBranches,
    maxAssignments: params.maxAssignments,
    maxEarlyReturns: params.maxEarlyReturns,
  });
  const finalReport =
    input.warnings.length === 0 ? report : { ...report, warnings: input.warnings };
  return wrapSystemsAnalyzerEnvelope(repoId, 'gn_simulate_fault', params, finalReport, {
    capabilitiesUsed: ['filesystem-source', 'fault-simulation'],
    nextTools: ['gn_path_verify', 'gn_error_topology'],
    evidence: readReportArray(finalReport, 'branches'),
  });
}

async function loadSource(repoId: string, params: SourceParams): Promise<SourceInput> {
  const inline = params.sourceText ?? params.code;
  if (inline !== undefined) {
    return { source: inline, filePath: params.filePath ?? params.path, warnings: [] };
  }
  const loaded = await loadNamedText(repoId, undefined, params.filePath ?? params.path);
  return { source: loaded.text, filePath: loaded.filePath, warnings: loaded.warnings };
}

async function loadNamedText(
  repoId: string,
  inline: string | undefined,
  inputPath: string | undefined,
): Promise<{ text: string; filePath?: string; warnings: string[] }> {
  if (inline !== undefined) return { text: inline, filePath: inputPath, warnings: [] };
  if (!inputPath) return { text: '', warnings: ['no source text or path supplied'] };

  const resolved = await resolveInputPath(repoId, inputPath);
  try {
    return {
      text: await fs.readFile(resolved.absolutePath, 'utf8'),
      filePath: resolved.repoRelativePath,
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: '',
      filePath: resolved.repoRelativePath,
      warnings: [
        `could not read path ${resolved.repoRelativePath} from repo ${resolved.repoPath}: ${message}`,
      ],
    };
  }
}

interface ResolvedInputPath {
  absolutePath: string;
  repoPath: string;
  repoRelativePath: string;
}

async function resolveRepoPath(repoId: string): Promise<string> {
  if (path.isAbsolute(repoId)) return path.resolve(repoId);

  const registry = await readRegistry();
  const normalizedRepo = repoId.toLowerCase();

  const exactMatches = registry.filter(
    (entry) =>
      entry.name.toLowerCase() === normalizedRepo ||
      path.resolve(entry.path) === path.resolve(repoId),
  );
  if (exactMatches.length === 1) return path.resolve(exactMatches[0].path);

  const fuzzyMatches = registry.filter((entry) =>
    entry.name.toLowerCase().includes(normalizedRepo),
  );
  if (fuzzyMatches.length === 1) return path.resolve(fuzzyMatches[0].path);

  if (fuzzyMatches.length > 1) {
    throw new Error(
      `repo identifier is ambiguous: ${repoId}. Matches: ${fuzzyMatches.map((entry) => entry.path).join(', ')}`,
    );
  }
  if (exactMatches.length > 1) {
    throw new Error(
      `repo identifier is ambiguous: ${repoId}. Matches: ${exactMatches.map((entry) => entry.path).join(', ')}`,
    );
  }

  throw new Error(`repo not found for path resolution: ${repoId}`);
}

function assertPathWithinRepo(repoPath: string, absolutePath: string, inputPath: string): void {
  const relative = path.relative(repoPath, absolutePath);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;

  throw new Error(`Path is outside repository: ${inputPath}. Use a path under ${repoPath}.`);
}

async function resolveInputPath(repoId: string, inputPath: string): Promise<ResolvedInputPath> {
  const repoPath = await resolveRepoPath(repoId);
  const absolutePath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(repoPath, inputPath);

  assertPathWithinRepo(repoPath, absolutePath, inputPath);

  const repoRelativePath = path.relative(repoPath, absolutePath).split(path.sep).join('/');
  return {
    absolutePath,
    repoPath,
    repoRelativePath: repoRelativePath === '' ? '.' : repoRelativePath,
  };
}

function inferTargetName(target: string | undefined): string | undefined {
  if (!target) return undefined;
  return target
    .split(/::|#|\\./)
    .filter(Boolean)
    .at(-1);
}

function normalizeTriggerPath(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return value
    .split(/[,>]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function withWarnings<T extends { warnings?: string[] }>(report: T, warnings: string[]): T {
  if (warnings.length === 0) return report;
  return { ...report, warnings: [...(report.warnings ?? []), ...warnings] };
}

function readReportArray(report: object, key: string): unknown[] {
  const value = (report as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

async function wrapSystemsAnalyzerEnvelope<T extends object>(
  repoId: string,
  tool:
    | 'gn_extract_fsm'
    | 'gn_error_topology'
    | 'gn_concurrency_audit'
    | 'gn_pressure_impact'
    | 'gn_taint_trace'
    | 'gn_abi_diff'
    | 'gn_simulate_fault',
  params: { legacyResponse?: boolean },
  report: T,
  options: {
    capabilitiesUsed: readonly string[];
    nextTools: readonly string[];
    evidence?: readonly unknown[];
    typeAwareClaimsDowngraded?: boolean;
    lspCapability?: string;
  },
): Promise<T | Record<string, unknown>> {
  if (params.legacyResponse !== false) {
    return report;
  }
  const targetContext = await resolveTargetContext({ repo: repoId });
  return createEnvelopeFromLegacy({
    legacy: report,
    tool,
    status:
      typeof (report as Record<string, unknown>)['status'] === 'string'
        ? ((report as Record<string, unknown>)['status'] as string)
        : 'ok',
    targetContext,
    capabilitiesUsed: options.capabilitiesUsed,
    typeAwareClaimsDowngraded: options.typeAwareClaimsDowngraded,
    lspCapability: options.lspCapability,
    nextTools: options.nextTools,
    evidence: options.evidence,
  }) as unknown as Record<string, unknown>;
}
