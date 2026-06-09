import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { extractCppPosixResourceFacts } from '../../core/systems-audit/resource-extractor-cpp.js';
import { createEnvelopeFromLegacy } from '../shared/response-envelope.js';
import { resolveTargetContext } from '../shared/target-context.js';

export interface ResourceTraceParams {
  repo?: string;
  path?: string;
  source?: string;
  sourceText?: string;
  processIdentity?: string;
  maxRecords?: number;
  legacyResponse?: boolean;
}

export interface PathVerifyParams {
  repo?: string;
  path?: string;
  source?: string;
  sourceText?: string;
  symbol?: string;
  when: string;
  must?: string[];
  mustNot?: string[];
  maxEvidence?: number;
  legacyResponse?: boolean;
}

export interface TestSuggestionsParams {
  repo?: string;
  findingId?: string;
  symbol?: string;
  path?: string;
  claimPattern?: string;
  risk?: string;
  legacyResponse?: boolean;
}

export async function gnResourceTrace(
  repoId: string,
  params: ResourceTraceParams,
): Promise<Record<string, unknown>> {
  const input = await loadSource(repoId, params);
  const report = extractCppPosixResourceFacts({
    source: input.source,
    filePath: input.filePath,
    fileHash: sha256(input.source),
    sourceIndexId: 'mcp:frontier',
    sourceCommitHash: 'working-tree',
    processIdentity: params.processIdentity,
    maxRecords: params.maxRecords,
  }) as unknown as Record<string, unknown>;
  if (params.legacyResponse !== false) {
    return report;
  }
  return wrapSystemsEnvelope(repoId, 'gn_resource_trace', params, report, {
    capabilitiesUsed: ['filesystem-source', 'systems-resource-extractor'],
    nextTools: ['gn_trace_boundary', 'gn_path_verify', 'gn_test_suggestions'],
    evidence: readArray(report, 'records'),
  });
}

export async function gnPathVerify(
  repoId: string,
  params: PathVerifyParams,
): Promise<Record<string, unknown>> {
  const input = await loadSource(repoId, params);
  const lines = input.source.split('\n');
  const triggerIndex = lines.findIndex((line) => lineMatches(line, params.when));
  const maxEvidence = clamp(params.maxEvidence, 25);
  if (triggerIndex < 0) {
    const report = {
      version: 1,
      action: 'path-verify',
      status: 'NEEDS-VERIFY',
      symbol: params.symbol,
      path: input.filePath,
      when: params.when,
      missing: [params.when],
      violations: [],
      evidence: [],
      warnings: ['trigger condition not found in bounded source text'],
      skipReasons: [],
    };
    if (params.legacyResponse !== false) {
      return report;
    }
    return wrapSystemsEnvelope(repoId, 'gn_path_verify', params, report, {
      capabilitiesUsed: ['filesystem-source', 'path-verifier'],
      nextTools: ['gn_resource_trace', 'gn_trace_boundary'],
      evidence: [],
    });
  }

  const window = lines.slice(triggerIndex, Math.min(lines.length, triggerIndex + 80));
  const must = params.must ?? [];
  const mustNot = params.mustNot ?? [];
  const missing = must.filter((pattern) => !window.some((line) => lineMatches(line, pattern)));
  const violations = mustNot.filter((pattern) => window.some((line) => lineMatches(line, pattern)));
  const evidence = window
    .map((line, offset) => ({ line: triggerIndex + offset + 1, text: line.trim() }))
    .filter((item) => item.text.length > 0)
    .slice(0, maxEvidence);

  const report = {
    version: 1,
    action: 'path-verify',
    status: missing.length === 0 && violations.length === 0 ? 'PASS' : 'FAIL',
    symbol: params.symbol,
    path: input.filePath,
    when: params.when,
    must,
    mustNot,
    missing,
    violations,
    evidence,
    warnings: [],
    skipReasons: [],
  };
  if (params.legacyResponse !== false) {
    return report;
  }
  return wrapSystemsEnvelope(repoId, 'gn_path_verify', params, report, {
    capabilitiesUsed: ['filesystem-source', 'path-verifier'],
    nextTools: ['gn_resource_trace', 'gn_trace_boundary'],
    evidence,
  });
}

export async function gnTestSuggestions(
  repoId: string,
  params: TestSuggestionsParams,
): Promise<Record<string, unknown>> {
  const symbol = params.symbol ?? 'auditedSymbol';
  const safeName = symbol
    .split(/::|\.|\/|\\/g)
    .filter(Boolean)
    .slice(-2)
    .join('_')
    .replace(/[^A-Za-z0-9_]/g, '_');
  const basePath = params.path ?? inferTestPath(symbol);
  const risk = params.risk ?? params.claimPattern ?? 'audit-invariant';
  const report = {
    version: 1,
    action: 'test-suggestions',
    findingId: params.findingId,
    symbol,
    suggestions: [
      {
        file: basePath,
        case: `test_${safeName}_${normalizeCase(risk)}`,
        target: symbol,
        assertion: `Assert the ${risk} invariant remains true for ${symbol}.`,
        required: true,
      },
    ],
    warnings: [],
    skipReasons: [],
  };
  if (params.legacyResponse !== false) {
    return report;
  }
  return wrapSystemsEnvelope(repoId, 'gn_test_suggestions', params, report, {
    capabilitiesUsed: ['audit-test-suggestions'],
    nextTools: ['gn_audit_verify', 'gn_scope_guard'],
    evidence: readArray(report, 'suggestions'),
  });
}

async function loadSource(
  repoId: string,
  params: { repo?: string; source?: string; sourceText?: string; path?: string },
): Promise<{ source: string; filePath: string }> {
  const inline = params.sourceText ?? params.source;
  if (inline !== undefined) return { source: inline, filePath: params.path ?? '<source>' };
  if (!params.path) throw new Error('path or sourceText is required');
  const input = await resolveRepoInputPath(repoId, params.repo, params.path);
  return {
    source: await fs.readFile(input.absolutePath, 'utf8'),
    filePath: input.repoRelativePath,
  };
}

async function resolveRepoInputPath(
  repoId: string,
  requestedRepo: string | undefined,
  inputPath: string,
): Promise<{ absolutePath: string; repoRelativePath: string }> {
  const repoRoot = await resolveRepoRoot(repoId, requestedRepo);
  const repoRootReal = await realpathOrResolved(repoRoot);
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(repoRootReal, inputPath);
  assertInsideRepo(repoRootReal, candidate, inputPath);

  const candidateReal = await realpathOrResolved(candidate);
  assertInsideRepo(repoRootReal, candidateReal, inputPath);

  return {
    absolutePath: candidateReal,
    repoRelativePath: path.relative(repoRootReal, candidateReal) || path.basename(candidateReal),
  };
}

async function resolveRepoRoot(repoId: string, requestedRepo: string | undefined): Promise<string> {
  const target = requestedRepo ?? repoId;
  if (path.isAbsolute(target)) return path.resolve(target);

  const repos = await readRegisteredRepos();
  const repo = repos.find(
    (entry) =>
      entry.name === target ||
      entry.path === target ||
      entry.name === repoId ||
      entry.path === repoId,
  );
  if (!repo) {
    throw new Error(
      `Repository not found for path resolution: ${target}. Pass an absolute repo path or a registered repo name.`,
    );
  }
  return path.resolve(repo.path);
}

async function readRegisteredRepos(): Promise<{ name: string; path: string }[]> {
  const registryPath = path.join(
    process.env.ONTOINDEX_HOME || path.join(os.homedir(), '.ontoindex'),
    'registry.json',
  );
  try {
    const raw = await fs.readFile(registryPath, 'utf8');
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter(isRegisteredRepo);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw new Error(
      `Failed to read OntoIndex registry for path resolution: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isRegisteredRepo(value: unknown): value is { name: string; path: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { path?: unknown }).path === 'string'
  );
}

async function realpathOrResolved(inputPath: string): Promise<string> {
  try {
    return await fs.realpath(inputPath);
  } catch (error) {
    if (isMissingPathError(error)) return path.resolve(inputPath);
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function assertInsideRepo(repoRoot: string, candidate: string, inputPath: string): void {
  const relative = path.relative(repoRoot, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`Path is outside repository: ${inputPath}. Use a path under ${repoRoot}.`);
}

function lineMatches(line: string, pattern: string): boolean {
  const normalizedLine = normalizeExpr(line);
  const normalizedPattern = normalizeExpr(pattern);
  return normalizedLine.includes(normalizedPattern);
}

function normalizeExpr(value: string): string {
  return value.replace(/\s+/g, '').replace(/;$/u, '');
}

function inferTestPath(symbol: string): string {
  const leaf =
    symbol
      .split(/::|\.|\//g)
      .filter(Boolean)
      .at(-1) ?? 'Audit';
  return `test/Unit${leaf.replace(/[^A-Za-z0-9]/g, '')}.cpp`;
}

function normalizeCase(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'audit'
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function clamp(value: unknown, defaultValue: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(1, Math.min(100, parsed));
}

async function wrapSystemsEnvelope(
  repoId: string,
  tool: 'gn_resource_trace' | 'gn_path_verify' | 'gn_test_suggestions',
  params: { legacyResponse?: boolean },
  report: Record<string, unknown>,
  options: {
    capabilitiesUsed: readonly string[];
    nextTools: readonly string[];
    evidence?: readonly unknown[];
  },
): Promise<Record<string, unknown>> {
  if (params.legacyResponse !== false) {
    return report;
  }
  const targetContext = await resolveTargetContext({ repo: repoId });
  return createEnvelopeFromLegacy({
    legacy: report,
    tool,
    status: typeof report['status'] === 'string' ? (report['status'] as string) : 'ok',
    targetContext,
    capabilitiesUsed: options.capabilitiesUsed,
    nextTools: options.nextTools,
    evidence: options.evidence,
  }) as unknown as Record<string, unknown>;
}

function readArray(report: Record<string, unknown>, key: string): unknown[] {
  const value = report[key];
  return Array.isArray(value) ? value : [];
}
