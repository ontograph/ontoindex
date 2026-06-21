import fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildAuditProjection,
  loadAndValidateAuditSessionLock,
  LocalAuditEventStore,
  type AuditSessionBundle,
} from '../../core/audit-lifecycle/index.js';
import {
  isTestFilePath,
  runImpactKernel,
  SAFE_EDIT_UPSTREAM_RELATION_TYPES,
  type ImpactKernelRepoHandle,
} from '../../core/impact/impact-kernel.js';
import { execFileText } from '../../core/process/exec-file.js';
import { detectChanges } from '../local/backend-detect-changes.js';
import { semanticSearch } from '../local/backend-query.js';
import { resolveSymbolCandidates } from '../local/backend-symbol-resolution.js';
import { resolveAuditRepoHandle } from './audit-ingest.js';
import { gnScopeGuard } from './audit-advanced.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_IMPACT_SYMBOLS = 25;
const DEFAULT_TEST_EVIDENCE_LIMIT = 25;
const MAX_TEST_EVIDENCE_LIMIT = 100;
const PRODUCTION_SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cbl',
  '.cob',
  '.cobol',
  '.copybook',
  '.cpp',
  '.cpy',
  '.cs',
  '.cxx',
  '.dart',
  '.gemspec',
  '.go',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.java',
  '.jcl',
  '.job',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.php',
  '.php3',
  '.php4',
  '.php5',
  '.php8',
  '.phtml',
  '.proc',
  '.py',
  '.rake',
  '.rb',
  '.rs',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
]);

type DiffScope = 'unstaged' | 'staged' | 'all' | 'compare';

export interface VerificationSymbolRecord {
  id?: string;
  name: string;
  filePath?: string;
  type?: string;
}

export interface VerificationDiffReport {
  changedFiles: string[];
  changedSymbols: string[];
  impactedSymbols: string[];
  executedTests: string[];
  symbolRecords: VerificationSymbolRecord[];
  warnings: string[];
}

export interface VerifyDiffParams {
  repo?: string;
  scope?: DiffScope;
  diffRef?: string;
  baseRef?: string;
  expectedFiles?: string[];
  expectedSymbols?: string[];
  expectedTests?: string[];
  changedFiles?: string[];
  changedSymbols?: string[];
  executedTests?: string[];
}

export interface TestGapParams {
  repo?: string;
  scope?: DiffScope;
  diffRef?: string;
  baseRef?: string;
  changedFiles?: string[];
  changedSymbols?: string[];
  executedTests?: string[];
  symbol?: string;
  filePath?: string;
  query?: string;
  maxItems?: number;
}

export interface WorkerScopeReviewParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  bundleId?: string;
  commit?: string;
  changedFiles?: string[];
  changedSymbols?: string[];
  executedTests?: string[];
  requiredTests?: string[];
}

export interface VerifyDiffEvaluationInput {
  expectedFiles?: readonly string[];
  expectedSymbols?: readonly string[];
  expectedTests?: readonly string[];
  actual: VerificationDiffReport;
}

export interface VerifyDiffEvaluationResult {
  status: 'PASS' | 'FAIL';
  unexpectedChangedFiles: string[];
  unexpectedChangedSymbols: string[];
  missingRequiredTests: string[];
  unexpectedImpactedSymbols: string[];
}

export interface TestGapEvaluationInput {
  symbolRecords: readonly VerificationSymbolRecord[];
  executedTests?: readonly string[];
  linkedTestsBySymbol?: ReadonlyMap<string, readonly string[]>;
}

export async function gnVerifyDiff(
  repoId: string,
  params: VerifyDiffParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const actual = await collectVerificationDiff(repo, params);
  const result = evaluateVerifyDiff({
    expectedFiles: params.expectedFiles,
    expectedSymbols: params.expectedSymbols,
    expectedTests: params.expectedTests,
    actual,
  });
  return {
    version: 1,
    action: 'verify-diff',
    status: result.status,
    expected: {
      files: normalizeStrings(params.expectedFiles),
      symbols: normalizeStrings(params.expectedSymbols),
      tests: normalizeStrings(params.expectedTests),
    },
    actual: summarizeActual(actual),
    unexpectedChangedFiles: result.unexpectedChangedFiles,
    unexpectedChangedSymbols: result.unexpectedChangedSymbols,
    unexpectedImpactedSymbols: result.unexpectedImpactedSymbols,
    missingRequiredTests: result.missingRequiredTests,
    warnings: actual.warnings,
    skipReasons: [],
  };
}

export async function gnTestGap(
  repoId: string,
  params: TestGapParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  if (hasTargetMode(params)) {
    return buildTargetTestGapReport(repo, params);
  }
  const actual = await collectVerificationDiff(repo, params);
  const linkedTestsBySymbol = await collectLinkedTestsBySymbol(repo, actual.symbolRecords);
  const report = buildTestGapReport({
    symbolRecords: actual.symbolRecords,
    executedTests: actual.executedTests,
    linkedTestsBySymbol,
  });
  return {
    ...report,
    actual: summarizeActual(actual),
    warnings: [...actual.warnings, ...collectWarnings(report)],
  };
}

async function buildTargetTestGapReport(
  repo: ImpactKernelRepoHandle,
  params: TestGapParams,
): Promise<Record<string, unknown>> {
  const warnings: string[] = [];
  const target = resolveTestGapTarget(params, warnings);
  const maxItems = clampLimit(params.maxItems);
  const symbolRecords = await resolveTargetSymbolRecords(repo, target, maxItems, warnings);
  const fallbackRecord = targetToSymbolRecord(repo.repoPath, target);
  const records = symbolRecords.length > 0 ? symbolRecords : [fallbackRecord];
  const linkedTestsBySymbol = await collectLinkedTestsBySymbol(repo, records);
  const linkedTests = normalizeStrings(
    records.flatMap((record) => linkedTestsBySymbol.get(record.name) ?? []),
  );
  const heuristicTests = (
    await findHeuristicTestFiles(repo.repoPath, fallbackRecord, maxItems + 1)
  ).filter((test) => !linkedTests.includes(test));
  const omittedHeuristic = Math.max(0, heuristicTests.length - maxItems);
  const evidence = [
    ...linkedTests.map((testFile) => ({
      testFile,
      testNames: [path.basename(testFile, path.extname(testFile))],
      reason: 'Graph-linked test evidence for target symbol.',
      evidenceClass: 'graph',
      confidence: 'high',
    })),
    ...heuristicTests.slice(0, Math.max(0, maxItems - linkedTests.length)).map((testFile) => ({
      testFile,
      testNames: [path.basename(testFile, path.extname(testFile))],
      reason: 'Test file path/name matches the target.',
      evidenceClass: 'path-heuristic',
      confidence: 'medium',
    })),
  ];
  const targetedCoverage =
    evidence.length > 0 ? 'found' : target.kind === 'query' ? 'unknown' : 'not-found';

  return {
    version: 1,
    action: 'test-gap',
    mode: 'target',
    status: targetedCoverage === 'found' ? 'PASS' : 'NEEDS-VERIFY',
    target,
    resolvedSymbols: records
      .filter((record) => record.id)
      .map((record) => ({
        id: record.id,
        name: record.name,
        filePath: record.filePath ?? null,
        type: record.type ?? null,
      })),
    evidence,
    runCommand: await inferTestCommand(
      repo.repoPath,
      fallbackRecord.filePath,
      evidence[0]?.testFile,
    ),
    targetedCoverage,
    omittedCounts: omittedHeuristic > 0 ? { heuristicTests: omittedHeuristic } : {},
    nextTools: targetedCoverage === 'found' ? [] : ['gn_test_suggestions'],
    heuristics: {
      filenameDerivedCoverage: 'heuristic',
      note: 'Filename-derived coverage remains heuristic until JUnit, coverage, or test-index data is ingested.',
    },
    warnings,
    skipReasons: [],
  };
}

export async function gnWorkerScopeReview(
  repoId: string,
  params: WorkerScopeReviewParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  const sessionId = requireSession(params);
  const lockValidation = await validateWorkerSession(repo.repoPath, sessionId);
  if (lockValidation.ok === false) {
    return {
      version: 1,
      action: 'worker-scope-review',
      ok: false,
      status: 'FAIL',
      sessionId,
      code: lockValidation.code,
      message: lockValidation.message,
      lockValidation,
      warnings: [],
      skipReasons: ['invalid-session-lock'],
    };
  }

  const projection = buildAuditProjection(
    (await new LocalAuditEventStore(repo.repoPath).load()).events,
  );
  const bundle = selectBundle(projection.bundles, sessionId, params.bundleId);
  if (bundle === undefined) {
    return {
      version: 1,
      action: 'worker-scope-review',
      ok: false,
      status: 'FAIL',
      sessionId,
      code: 'BUNDLE_REQUIRED',
      message: 'Run gn_audit_session_bundle before reviewing worker output.',
      warnings: [],
      skipReasons: ['bundle-required'],
    };
  }

  const actual = await collectVerificationDiff(repo, {
    scope: params.commit ? 'compare' : 'unstaged',
    diffRef: params.commit,
    changedFiles: params.changedFiles,
    changedSymbols: params.changedSymbols,
    executedTests: params.executedTests,
  });
  const scopeGuard = (await gnScopeGuard(repo.repoPath, {
    sessionId,
    bundleId: bundle.id,
    changedFiles: actual.changedFiles,
    changedSymbols: actual.changedSymbols,
    executedTests: actual.executedTests,
    requiredTests: params.requiredTests,
    persist: false,
  })) as { status: string; issues: unknown[] };
  const verifyDiff = evaluateVerifyDiff({
    expectedFiles: [...bundle.files, ...bundle.writeSet, ...bundle.tests],
    expectedSymbols: bundle.symbols,
    expectedTests: params.requiredTests ?? bundle.tests,
    actual,
  });

  const hintedFile =
    actual.symbolRecords.find((record) => record.filePath && !isTestFilePath(record.filePath))
      ?.filePath ?? bundle.files[0];
  const symbolRecords = actual.symbolRecords.map((record) =>
    record.filePath !== undefined
      ? record
      : { ...record, ...(hintedFile ? { filePath: hintedFile } : {}) },
  );
  const linkedTestsBySymbol = new Map(
    symbolRecords.map((record) => [
      record.name,
      bundle.symbols.includes(record.name) ? [...bundle.tests] : [],
    ]),
  );
  const testGap = buildTestGapReport({
    symbolRecords,
    executedTests: actual.executedTests,
    linkedTestsBySymbol,
  });
  const ok =
    scopeGuard.status === 'PASS' &&
    verifyDiff.status === 'PASS' &&
    requireStringField(testGap.status, 'testGap.status') === 'PASS';

  return {
    version: 1,
    action: 'worker-scope-review',
    ok,
    status: ok ? 'PASS' : 'FAIL',
    sessionId,
    bundleId: bundle.id,
    lockValidation,
    scopeGuard,
    verifyDiff,
    testGap,
    actual: summarizeActual(actual),
    warnings: [...actual.warnings, ...collectWarnings(testGap)],
    skipReasons: ok ? [] : collectSkipReasons(scopeGuard, verifyDiff, testGap),
  };
}

export function evaluateVerifyDiff(input: VerifyDiffEvaluationInput): VerifyDiffEvaluationResult {
  const expectedFiles = new Set(normalizeStrings(input.expectedFiles));
  const expectedSymbols = new Set(normalizeStrings(input.expectedSymbols));
  const expectedTests = new Set(normalizeStrings(input.expectedTests));

  const unexpectedChangedFiles = input.actual.changedFiles.filter(
    (file) => !expectedFiles.has(file),
  );
  const unexpectedChangedSymbols = input.actual.changedSymbols.filter(
    (symbol) => !expectedSymbols.has(symbol),
  );
  const missingRequiredTests = [...expectedTests].filter(
    (test) => !input.actual.executedTests.includes(test),
  );
  const unexpectedImpactedSymbols = input.actual.impactedSymbols.filter(
    (symbol) => !expectedSymbols.has(symbol),
  );
  const status =
    unexpectedChangedFiles.length > 0 ||
    unexpectedChangedSymbols.length > 0 ||
    missingRequiredTests.length > 0
      ? 'FAIL'
      : 'PASS';
  return {
    status,
    unexpectedChangedFiles,
    unexpectedChangedSymbols,
    missingRequiredTests,
    unexpectedImpactedSymbols,
  };
}

export function buildTestGapReport(input: TestGapEvaluationInput): Record<string, unknown> {
  const executedTests = normalizeStrings(input.executedTests);
  const linkedTestsBySymbol = input.linkedTestsBySymbol ?? new Map<string, readonly string[]>();
  const gaps: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];

  for (const record of input.symbolRecords) {
    if (!record.name) continue;
    if (!isProductionSymbolRecord(record)) continue;
    const linkedTests = normalizeStrings(linkedTestsBySymbol.get(record.name));
    const executedFromLinks = executedTests.filter((test) => linkedTests.includes(test));
    const heuristicExecuted = heuristicExecutedTests(record, executedTests).filter(
      (test) => !executedFromLinks.includes(test),
    );
    if (linkedTests.length > 0 || executedFromLinks.length > 0 || heuristicExecuted.length > 0) {
      continue;
    }
    gaps.push({
      symbol: record.name,
      filePath: record.filePath ?? null,
      linkedTests,
      executedTests: executedFromLinks,
      heuristicTestPatterns: heuristicTestPatterns(record),
      coverageStatus: 'missing-test-evidence',
      note: 'Filename-derived coverage remains heuristic until JUnit, coverage, or test-index data is ingested.',
    });
  }

  return {
    version: 1,
    action: 'test-gap',
    status: gaps.length === 0 ? 'PASS' : 'FAIL',
    heuristics: {
      filenameDerivedCoverage: 'heuristic',
      note: 'Filename-derived coverage remains heuristic until JUnit, coverage, or test-index data is ingested.',
    },
    changedProductionSymbolCount: input.symbolRecords.filter(isProductionSymbolRecord).length,
    gaps,
    warnings,
    skipReasons: [],
  };
}

export async function collectVerificationDiff(
  repo: { id: string; repoPath: string },
  params: {
    scope?: DiffScope;
    diffRef?: string;
    baseRef?: string;
    changedFiles?: string[];
    changedSymbols?: string[];
    executedTests?: string[];
  },
): Promise<VerificationDiffReport> {
  const warnings: string[] = [];
  const { scope, baseRef } = resolveDiffScope(params.scope, params.diffRef ?? params.baseRef);
  const changedFiles =
    params.changedFiles !== undefined
      ? normalizeStrings(params.changedFiles)
      : await listChangedFiles(repo.repoPath, scope, baseRef);

  let symbolRecords: VerificationSymbolRecord[] = [];
  if (params.changedSymbols !== undefined) {
    symbolRecords = normalizeStrings(params.changedSymbols).map((name) => ({ name }));
    warnings.push(
      'Impacted-symbol and graph-linked test scans were skipped for supplied changedSymbols without graph ids.',
    );
  } else {
    const detectResult = await detectChanges(
      repo,
      scope === 'compare' ? { scope, base_ref: baseRef } : { scope },
    );
    if ('error' in detectResult) {
      warnings.push(detectResult.error);
    } else {
      symbolRecords = Array.isArray(detectResult.changed_symbols)
        ? detectResult.changed_symbols.map(asSymbolRecord).filter(isDefined)
        : [];
      warnings.push(...normalizeStrings(detectResult.warnings));
    }
  }

  const impactedSymbols =
    params.changedSymbols !== undefined
      ? []
      : await collectImpactedSymbols(repo, symbolRecords, warnings);

  return {
    changedFiles,
    changedSymbols: normalizeStrings(symbolRecords.map((record) => record.name)),
    impactedSymbols,
    executedTests: normalizeStrings(params.executedTests),
    symbolRecords,
    warnings,
  };
}

async function collectLinkedTestsBySymbol(
  repo: ImpactKernelRepoHandle,
  symbolRecords: readonly VerificationSymbolRecord[],
): Promise<Map<string, readonly string[]>> {
  const linkedTestsBySymbol = new Map<string, readonly string[]>();
  for (const record of symbolRecords.slice(0, MAX_IMPACT_SYMBOLS)) {
    if (!record.id) continue;
    try {
      const result = await runImpactKernel(
        repo,
        {
          id: record.id,
          name: record.name,
          filePath: record.filePath,
          type: record.type,
        },
        {
          direction: 'upstream',
          maxDepth: 1,
          relationTypes: SAFE_EDIT_UPSTREAM_RELATION_TYPES,
          includeTests: true,
          countScope: 'unique-direct-nodes',
        },
      );
      const tests = Array.from(
        new Set(
          result.impacted
            .map((node) => node.filePath)
            .filter(
              (filePath): filePath is string => Boolean(filePath) && isTestFilePath(filePath),
            ),
        ),
      ).sort();
      linkedTestsBySymbol.set(record.name, tests);
    } catch {
      linkedTestsBySymbol.set(record.name, []);
    }
  }
  return linkedTestsBySymbol;
}

async function collectImpactedSymbols(
  repo: ImpactKernelRepoHandle,
  symbolRecords: readonly VerificationSymbolRecord[],
  warnings: string[],
): Promise<string[]> {
  const impacted = new Set<string>();
  for (const record of symbolRecords.slice(0, MAX_IMPACT_SYMBOLS)) {
    if (!record.id) continue;
    try {
      const result = await runImpactKernel(
        repo,
        {
          id: record.id,
          name: record.name,
          filePath: record.filePath,
          type: record.type,
        },
        {
          direction: 'upstream',
          maxDepth: 1,
          relationTypes: SAFE_EDIT_UPSTREAM_RELATION_TYPES,
          includeTests: false,
          countScope: 'unique-direct-nodes',
        },
      );
      warnings.push(...result.warnings.map((warning) => `${record.name}: ${warning}`));
      for (const node of result.impacted) {
        if (node.filePath && isTestFilePath(node.filePath)) continue;
        const name = String(node.name ?? '').trim();
        if (!name || name === record.name) continue;
        impacted.add(name);
      }
    } catch (error) {
      warnings.push(
        `Impact scan failed for ${record.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (symbolRecords.length > MAX_IMPACT_SYMBOLS) {
    warnings.push(`Impact scan capped at ${MAX_IMPACT_SYMBOLS} changed symbols.`);
  }
  return [...impacted].sort();
}

async function listChangedFiles(
  repoPath: string,
  scope: DiffScope,
  baseRef?: string,
): Promise<string[]> {
  const args =
    scope === 'staged'
      ? ['-C', repoPath, 'diff', '--cached', '--name-only']
      : scope === 'all'
        ? ['-C', repoPath, 'diff', 'HEAD', '--name-only']
        : scope === 'compare'
          ? ['-C', repoPath, 'diff', baseRef ?? 'HEAD', '--name-only']
          : ['-C', repoPath, 'diff', '--name-only'];
  const output = await execFileText('git', args, {
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return normalizeStrings(output.split('\n'));
}

function resolveDiffScope(
  scope: DiffScope | undefined,
  diffRef: string | undefined,
): { scope: DiffScope; baseRef?: string } {
  if (diffRef) {
    return { scope: 'compare', baseRef: diffRef };
  }
  return { scope: scope ?? 'unstaged' };
}

function hasTargetMode(params: TestGapParams): boolean {
  return Boolean(params.symbol || params.filePath || params.query);
}

function resolveTestGapTarget(
  params: TestGapParams,
  warnings: string[],
): { kind: 'symbol' | 'filePath' | 'query'; value: string } {
  const targets = [
    params.symbol ? ({ kind: 'symbol', value: params.symbol } as const) : undefined,
    params.filePath ? ({ kind: 'filePath', value: params.filePath } as const) : undefined,
    params.query ? ({ kind: 'query', value: params.query } as const) : undefined,
  ].filter(isDefined);
  if (targets.length > 1) {
    warnings.push(
      'gn_test_gap target mode accepts one of symbol, filePath, or query; using first.',
    );
  }
  const target = targets[0];
  if (!target) throw new Error('symbol, filePath, or query is required for target mode');
  return target;
}

function targetToSymbolRecord(
  repoPath: string | undefined,
  target: {
    kind: 'symbol' | 'filePath' | 'query';
    value: string;
  },
): VerificationSymbolRecord {
  if (target.kind === 'filePath') {
    const filePath =
      (repoPath ? normalizeRepoRelativePath(repoPath, target.value) : undefined) ??
      normalizeRepoPath(target.value);
    return { name: path.basename(filePath).replace(/\.[^.]+$/u, ''), filePath };
  }
  return { name: target.value.trim() };
}

async function resolveTargetSymbolRecords(
  repo: ImpactKernelRepoHandle,
  target: { kind: 'symbol' | 'filePath' | 'query'; value: string },
  limit: number,
  warnings: string[],
): Promise<VerificationSymbolRecord[]> {
  try {
    if (target.kind === 'symbol') {
      const outcome = await resolveSymbolCandidates(repo, { name: target.value }, {});
      if (outcome.kind === 'ok') return [resolvedSymbolToRecord(outcome.symbol)];
      if (outcome.kind === 'ambiguous') {
        warnings.push(`Symbol target "${target.value}" was ambiguous; using top candidates.`);
        return outcome.candidates.slice(0, limit).map(resolvedSymbolToRecord);
      }
      warnings.push(`Symbol target "${target.value}" was not found in the graph.`);
      return [];
    }
    if (target.kind === 'filePath') {
      const filePath =
        (repo.repoPath ? normalizeRepoRelativePath(repo.repoPath, target.value) : undefined) ??
        normalizeRepoPath(target.value);
      return await resolveFileSymbolRecords(repo, filePath, limit);
    }
    const results = await semanticSearch(repo, target.value, limit).catch((error) => {
      warnings.push(
        `Semantic query expansion unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    });
    return results
      .map((result) => ({
        id: typeof result.nodeId === 'string' ? result.nodeId : undefined,
        name: String(result.name ?? '').trim(),
        filePath: typeof result.filePath === 'string' ? result.filePath : undefined,
        type: typeof result.type === 'string' ? result.type : undefined,
      }))
      .filter((record) => record.id && record.name);
  } catch (error) {
    warnings.push(
      `Target graph resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

async function resolveFileSymbolRecords(
  repo: ImpactKernelRepoHandle,
  filePath: string,
  limit: number,
): Promise<VerificationSymbolRecord[]> {
  const { executeParameterized } = await import('../../core/lbug/pool-adapter.js');
  const rows = (await executeParameterized(
    repo.id,
    `
    MATCH (n) WHERE n.filePath ENDS WITH $filePath
      AND n.name IS NOT NULL
    RETURN n.id AS id, n.name AS name, labels(n)[0] AS type,
           n.filePath AS filePath
    LIMIT $limit
    `,
    { filePath, limit },
  )) as Array<Record<string, unknown>>;
  return rows
    .map((row) => ({
      id: typeof row.id === 'string' ? row.id : undefined,
      name: String(row.name ?? '').trim(),
      filePath: typeof row.filePath === 'string' ? row.filePath : filePath,
      type: typeof row.type === 'string' ? row.type : undefined,
    }))
    .filter((record) => record.id && record.name);
}

function resolvedSymbolToRecord(symbol: {
  id: string;
  name: string;
  type?: string;
  filePath?: string;
}): VerificationSymbolRecord {
  return {
    id: symbol.id,
    name: symbol.name,
    ...(symbol.filePath ? { filePath: symbol.filePath } : {}),
    ...(symbol.type ? { type: symbol.type } : {}),
  };
}

async function findHeuristicTestFiles(
  repoPath: string | undefined,
  record: VerificationSymbolRecord,
  limit: number,
): Promise<string[]> {
  if (!repoPath) return [];
  const normalizedFile = record.filePath
    ? normalizeRepoRelativePath(repoPath, record.filePath)
    : undefined;
  if (normalizedFile && isTestFilePath(normalizedFile)) return [normalizedFile];
  const stem = heuristicStem(record).toLowerCase();
  const terms = normalizeStrings(record.name.toLowerCase().split(/[^a-z0-9]+/u)).filter(
    (term) => term.length > 2,
  );
  const tests = await listTestFiles(repoPath, Math.max(limit, MAX_TEST_EVIDENCE_LIMIT));
  return tests
    .filter((testFile) => {
      const lowered = testFile.toLowerCase();
      if (stem && lowered.includes(stem)) return true;
      return terms.length > 0 && terms.every((term) => lowered.includes(term));
    })
    .slice(0, limit);
}

async function listTestFiles(repoPath: string, cap: number): Promise<string[]> {
  const found: string[] = [];
  async function visit(relativeDir: string): Promise<void> {
    if (found.length >= cap) return;
    const absoluteDir = path.join(repoPath, relativeDir);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= cap) return;
      if (entry.name.startsWith('.') || shouldSkipTestWalkDir(entry.name)) continue;
      const relativePath = normalizeRepoPath(path.join(relativeDir, entry.name));
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile() && isTestFilePath(relativePath)) {
        found.push(relativePath);
      }
    }
  }
  await visit('');
  return found.sort();
}

function shouldSkipTestWalkDir(name: string): boolean {
  return ['build', 'coverage', 'dist', 'node_modules', 'tmp', 'vendor'].includes(name);
}

async function inferTestCommand(
  repoPath: string | undefined,
  targetFile: string | undefined,
  testFile: string | undefined,
): Promise<string | undefined> {
  if (!repoPath) return undefined;
  const startFile = testFile ?? targetFile;
  const packageDir = await findNearestPackageDir(repoPath, startFile);
  if (packageDir === undefined) return undefined;
  const packageJsonPath = path.join(repoPath, packageDir, 'package.json');
  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    if (typeof packageJson.scripts?.test !== 'string') return undefined;
  } catch {
    return undefined;
  }
  if (!testFile) return packageDir ? `npm --prefix ${packageDir} test` : 'npm test';
  const testArg = packageDir ? path.relative(packageDir, testFile) : testFile;
  return packageDir
    ? `npm --prefix ${packageDir} test -- ${normalizeRepoPath(testArg)}`
    : `npm test -- ${testFile}`;
}

async function findNearestPackageDir(
  repoPath: string,
  startFile: string | undefined,
): Promise<string | undefined> {
  let dir = startFile
    ? path.dirname(normalizeRepoRelativePath(repoPath, startFile) ?? normalizeRepoPath(startFile))
    : '';
  while (true) {
    try {
      await fs.access(path.join(repoPath, dir, 'package.json'));
      return dir;
    } catch {
      const next = path.dirname(dir);
      if (next === dir || next === '.') {
        try {
          await fs.access(path.join(repoPath, 'package.json'));
          return '';
        } catch {
          return undefined;
        }
      }
      dir = next;
    }
  }
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TEST_EVIDENCE_LIMIT;
  return Math.max(1, Math.min(MAX_TEST_EVIDENCE_LIMIT, Math.trunc(value)));
}

function normalizeRepoRelativePath(repoPath: string, value: string): string | undefined {
  const absoluteRepoPath = path.resolve(repoPath);
  const absoluteInputPath = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(absoluteRepoPath, value);
  const relativePath = path.relative(absoluteRepoPath, absoluteInputPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return normalizeRepoPath(relativePath || path.basename(absoluteInputPath));
}

function normalizeRepoPath(value: string): string {
  return value
    .split(path.sep)
    .join('/')
    .replace(/^\.\/+/u, '');
}

function asSymbolRecord(value: unknown): VerificationSymbolRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const name = String(record.name ?? record.id ?? '').trim();
  if (!name) return undefined;
  return {
    ...(record.id ? { id: String(record.id) } : {}),
    name,
    ...(record.filePath ? { filePath: String(record.filePath) } : {}),
    ...(record.type ? { type: String(record.type) } : {}),
  };
}

function summarizeActual(actual: VerificationDiffReport): Record<string, unknown> {
  return {
    changedFiles: actual.changedFiles,
    changedSymbols: actual.changedSymbols,
    impactedSymbols: actual.impactedSymbols,
    executedTests: actual.executedTests,
  };
}

function collectWarnings(report: Record<string, unknown>): string[] {
  return Array.isArray(report.warnings) ? normalizeStrings(report.warnings) : [];
}

function collectSkipReasons(
  scopeGuard: { status: string },
  verifyDiff: VerifyDiffEvaluationResult,
  testGap: Record<string, unknown>,
): string[] {
  const reasons: string[] = [];
  if (scopeGuard.status !== 'PASS') reasons.push('scope-guard-failed');
  if (verifyDiff.status !== 'PASS') reasons.push('verify-diff-failed');
  if (requireStringField(testGap.status, 'testGap.status') !== 'PASS') reasons.push('test-gap');
  return reasons;
}

async function validateWorkerSession(repoPath: string, sessionId: string) {
  const projection = buildAuditProjection((await new LocalAuditEventStore(repoPath).load()).events);
  const session = requireProjectedSession(projection.sessions, sessionId);
  const currentHead = (
    await execFileText('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
      timeoutMs: GIT_TIMEOUT_MS,
    })
  ).trim();
  try {
    return await loadAndValidateAuditSessionLock(repoPath, sessionId, {
      targetHead: currentHead,
      graphIndexId: session.graphIndexId,
      graphHash: session.sidecarStateHash,
    });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        ok: false,
        code: 'SESSION_LOCK_REQUIRED',
        message: `audit session lock is required for ${sessionId}`,
        sessionId,
      };
    }
    throw error;
  }
}

function requireProjectedSession<T extends { id: string }>(
  sessions: readonly T[],
  sessionId: string,
): T {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`audit session does not exist: ${sessionId}`);
  return session;
}

function selectBundle(
  bundles: readonly AuditSessionBundle[],
  sessionId: string,
  bundleId: string | undefined,
): ReturnType<typeof fromPersistedBundle> | undefined {
  const candidates = bundles
    .filter((bundle) => bundle.sessionId === sessionId)
    .map((bundle) => fromPersistedBundle(bundle));
  const selected =
    bundleId === undefined ? candidates : candidates.filter((bundle) => bundle.id === bundleId);
  if (selected.length === 0) return undefined;
  if (selected.length > 1)
    throw new Error(`expected exactly one bundle; received ${selected.length}`);
  return selected[0];
}

function fromPersistedBundle(bundle: AuditSessionBundle) {
  return {
    id: bundle.id,
    sessionId: bundle.sessionId,
    findingIds: [...bundle.findingIds].sort(),
    duplicateFindingIds: metadataStrings(bundle.metadata.duplicateFindingIds),
    files: metadataStrings(bundle.metadata.files),
    symbols: metadataStrings(bundle.metadata.symbols),
    tests: metadataStrings(bundle.metadata.tests),
    writeSet: metadataStrings(bundle.metadata.writeSet),
  };
}

function metadataStrings(value: unknown): string[] {
  return Array.isArray(value) ? normalizeStrings(value) : [];
}

function requireSession(params: { session?: string; sessionId?: string }): string {
  const sessionId = params.sessionId ?? params.session;
  if (!sessionId) throw new Error('session is required');
  return sessionId;
}

function requireStringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value;
}

function heuristicExecutedTests(
  record: VerificationSymbolRecord,
  executedTests: readonly string[],
): string[] {
  const stem = heuristicStem(record);
  if (!stem) return [];
  const lowered = stem.toLowerCase();
  return Array.from(
    new Set(
      executedTests.filter((test) => {
        const candidate = test.toLowerCase();
        return (
          candidate.includes(`/${lowered}.test.`) ||
          candidate.includes(`/${lowered}.spec.`) ||
          candidate.endsWith(`/${lowered}`) ||
          candidate.includes(`/${lowered}_test.`)
        );
      }),
    ),
  ).sort();
}

function heuristicTestPatterns(record: VerificationSymbolRecord): string[] {
  const stem = heuristicStem(record);
  if (!stem) return [];
  return [`**/${stem}.test.*`, `**/${stem}.spec.*`, `**/${stem}_test.*`];
}

function heuristicStem(record: VerificationSymbolRecord): string {
  if (record.filePath) {
    const base = path.basename(record.filePath).replace(/\.[^.]+$/u, '');
    if (base && base !== 'index') return base;
    const dir = path.basename(path.dirname(record.filePath));
    if (dir) return dir;
  }
  return record.name.replace(/[^a-z0-9_-]+/giu, '').toLowerCase();
}

function isProductionSymbolRecord(record: VerificationSymbolRecord): boolean {
  if (!record.filePath) return true;
  if (isTestFilePath(record.filePath)) return false;
  const extension = path.extname(record.filePath).toLowerCase();
  return extension.length === 0 || PRODUCTION_SOURCE_EXTENSIONS.has(extension);
}

function normalizeStrings(values: readonly unknown[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? []).map((value) => String(value ?? '').trim()).filter((value) => value.length > 0),
    ),
  ).sort();
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
