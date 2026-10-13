import { resolveRegistryEntry } from '../shared/target-context.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Parser from 'tree-sitter';
import { getLanguageFromFilename, SupportedLanguages } from 'ontoindex-shared';
import { resolveContainedRealPath } from '../local/path-util.js';

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
  targetedCoverage?: TestSuggestionsTargetedCoverage | string;
  evidence?: readonly unknown[];
  legacyResponse?: boolean;
}

export interface TestSuggestionsTargetedCoverage {
  existingTests?: readonly unknown[];
  linkedTests?: readonly unknown[];
  executedTests?: readonly unknown[];
  evidence?: readonly unknown[];
  targetedCoverage?: unknown;
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
  const scope = await selectPathConsequence(input, params);
  const maxEvidence = clamp(params.maxEvidence, 25);
  const must = params.must ?? [];
  const mustNot = params.mustNot ?? [];
  const missing = must.filter(
    (pattern) => !scope.evidence.some((item) => lineMatches(item.text, pattern)),
  );
  if (!scope.selected) missing.unshift(params.when);
  const violations = mustNot.filter((pattern) =>
    scope.evidence.some((item) => lineMatches(item.text, pattern)),
  );
  const evidence = scope.evidence.slice(0, maxEvidence);

  const report = {
    version: 1,
    action: 'path-verify',
    status: 'NEEDS-VERIFY',
    symbol: params.symbol,
    path: input.filePath,
    when: params.when,
    must,
    mustNot,
    missing,
    violations,
    evidence,
    warnings: [
      'Static branch observations are advisory; no execution proof is available.',
      ...scope.warnings,
    ],
    skipReasons: scope.selected ? [] : scope.warnings,
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

async function selectPathConsequence(
  input: { source: string; filePath: string },
  params: PathVerifyParams,
): Promise<{ selected: boolean; evidence: { line: number; text: string }[]; warnings: string[] }> {
  const unavailable = (reason: string) => ({ selected: false, evidence: [], warnings: [reason] });
  if (params.when.includes('\uFFFC'))
    return unavailable('trigger contains a reserved literal marker');
  const language =
    input.filePath === '<source>'
      ? SupportedLanguages.CPlusPlus
      : getLanguageFromFilename(input.filePath);
  if (language !== SupportedLanguages.C && language !== SupportedLanguages.CPlusPlus)
    return unavailable('unsupported source language: only C/C++ syntax is scoped');
  if (Buffer.byteLength(input.source, 'utf8') > 256 * 1024)
    return unavailable('source byte limit exceeded (256 KiB)');
  try {
    const { createParserForLanguage } = await import('../../core/tree-sitter/parser-loader.js');
    const parser = await createParserForLanguage(language, input.filePath);
    parser.setTimeoutMicros(100_000);
    const walk = (root: Parser.SyntaxNode, prune = false): Parser.SyntaxNode[] => {
      const nodes: Parser.SyntaxNode[] = [];
      const pending = [root];
      while (pending.length) {
        const node = pending.pop()!;
        if (nodes.length >= 5000) throw new Error('AST node limit exceeded (5000)');
        nodes.push(node);
        if (
          !prune ||
          node === root ||
          !['lambda_expression', 'function_definition'].includes(node.type)
        )
          pending.push(...node.children.slice().reverse());
      }
      return nodes;
    };
    let tree = parser.parse(input.source);
    if (!tree) return unavailable('source parsing timed out');
    let nodes = walk(tree.rootNode);
    let offset = 0;
    // slim: preserve the legacy inline if fragment only; general fragments require a procedure.
    if (
      !nodes.some((node) => node.type === 'function_definition') &&
      !params.symbol &&
      input.filePath === '<source>' &&
      /^\s*if\s*\(/u.test(input.source)
    ) {
      tree = parser.parse(`void __ontoindex_path_verify_fragment() {\n${input.source}\n}`);
      if (!tree) return unavailable('source parsing timed out');
      nodes = walk(tree.rootNode);
      offset = 1;
    }
    if (tree.rootNode.hasError) return unavailable('malformed source: AST contains parse errors');
    const procedureName = (node: Parser.SyntaxNode): string | undefined => {
      let declarator = node.childForFieldName('declarator');
      while (
        declarator &&
        ![
          'identifier',
          'field_identifier',
          'qualified_identifier',
          'destructor_name',
          'operator_name',
        ].includes(declarator.type)
      )
        declarator = declarator.childForFieldName('declarator');
      if (!declarator) return undefined;
      const names = [normalizeExpr(declarator.text)];
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === 'function_definition' || parent.type === 'lambda_expression')
          return undefined;
        if (['namespace_definition', 'class_specifier', 'struct_specifier'].includes(parent.type)) {
          const name = parent.childForFieldName('name');
          if (!name) return undefined;
          names.unshift(normalizeExpr(name.text));
        }
      }
      return names.join('::');
    };
    const procedures = nodes.filter(
      (node) =>
        node.type === 'function_definition' &&
        procedureName(node) !== undefined &&
        (!params.symbol || procedureName(node) === normalizeExpr(params.symbol)),
    );
    if (procedures.length !== 1)
      return unavailable(
        'procedure selection is missing or ambiguous; supply an exact unique symbol',
      );
    const body = procedures[0].childForFieldName('body');
    if (!body) return unavailable('procedure body is unavailable');
    const executableText = (node: Parser.SyntaxNode): string => {
      if (/(?:string|char)_literal/u.test(node.type)) return '\uFFFC';
      if (
        node.type === 'comment' ||
        ['lambda_expression', 'function_definition'].includes(node.type)
      )
        return '';
      if (!node.childCount) return node.text;
      return node.children.map(executableText).filter(Boolean).join(' ');
    };
    const conditionText = (value: string): string => {
      let text = normalizeExpr(value);
      if (text.startsWith('if(') && text.endsWith(')')) text = text.slice(2);
      while (text.startsWith('(') && text.endsWith(')')) {
        let depth = 0;
        const enclosing = [...text].every((char, index) => {
          if (char === '(') depth++;
          if (char === ')') depth--;
          return depth !== 0 || index === text.length - 1;
        });
        if (!enclosing) break;
        text = text.slice(1, -1);
      }
      return text;
    };
    const triggers = walk(body, true).filter((node) => {
      if (node.type !== 'if_statement') return false;
      const condition = node.childForFieldName('condition');
      const value = condition?.childForFieldName('value') ?? condition;
      return value && conditionText(executableText(value)) === conditionText(params.when);
    });
    if (triggers.length !== 1)
      return unavailable('trigger condition not found uniquely in selected procedure');
    const consequence = triggers[0].childForFieldName('consequence');
    if (!consequence) return unavailable('trigger consequence is unavailable');
    const evidence: { line: number; text: string }[] = [];
    const warnings: string[] = [];
    const observe = (node: Parser.SyntaxNode): boolean => {
      if (node.type === 'comment') return true;
      if (node.type === 'compound_statement') {
        for (const child of node.namedChildren) if (!observe(child)) return false;
        return true;
      }
      if (
        ![
          'expression_statement',
          'declaration',
          'return_statement',
          'throw_statement',
          'goto_statement',
          'break_statement',
          'continue_statement',
        ].includes(node.type) ||
        walk(node).some(
          (child) =>
            ['lambda_expression', 'conditional_expression', 'function_definition'].includes(
              child.type,
            ) || ['&&', '||'].includes(child.type),
        )
      ) {
        warnings.push('unsupported control flow ends straight-line observations');
        return false;
      }
      const text = executableText(node).trim();
      if (text) evidence.push({ line: node.startPosition.row + 1 - offset, text });
      return ![
        'return_statement',
        'throw_statement',
        'goto_statement',
        'break_statement',
        'continue_statement',
      ].includes(node.type);
    };
    observe(consequence);
    return { selected: true, evidence, warnings };
  } catch (error) {
    return unavailable(
      `source scope unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function gnTestSuggestions(
  repoId: string,
  params: TestSuggestionsParams,
): Promise<Record<string, unknown>> {
  const symbol = params.symbol ?? 'auditedSymbol';
  const targetedTests = collectTargetedTests(params);
  const suggestedFile = targetedTests[0] ?? params.path ?? inferTestPath(symbol);
  const safeName = symbol
    .split(/::|\.|\/|\\/g)
    .filter(Boolean)
    .slice(-2)
    .join('_')
    .replace(/[^A-Za-z0-9_]/g, '_');
  const risk = params.risk ?? params.claimPattern ?? 'audit-invariant';
  const report = {
    version: 1,
    action: 'test-suggestions',
    findingId: params.findingId,
    symbol,
    suggestions: [
      {
        file: suggestedFile,
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
  if (!path.isAbsolute(inputPath))
    assertInsideRepo(repoRootReal, path.resolve(repoRootReal, inputPath), inputPath);
  const candidateReal = await resolveContainedRealPath(repoRoot, inputPath);

  return {
    absolutePath: candidateReal,
    repoRelativePath: path.relative(repoRootReal, candidateReal) || path.basename(candidateReal),
  };
}

async function resolveRepoRoot(repoId: string, requestedRepo: string | undefined): Promise<string> {
  const target = requestedRepo ?? repoId;
  if (path.isAbsolute(target)) return path.resolve(target);

  const repos = await readRegisteredRepos();
  const result = resolveRegistryEntry(repos, target);
  if (result.status === 'ambiguous') throw new Error(result.action);
  if (result.status !== 'ok') {
    throw new Error(
      `Repository not found for path resolution: ${target}. Pass an absolute repo path or a registered repo name.`,
    );
  }
  return path.resolve(result.entry.path);
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
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    return;
  throw new Error(`Path is outside repository: ${inputPath}. Use a path under ${repoRoot}.`);
}

function lineMatches(line: string, pattern: string): boolean {
  if (pattern.includes('\uFFFC')) return false;
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

function collectTargetedTests(
  params: Pick<TestSuggestionsParams, 'targetedCoverage' | 'evidence'>,
): string[] {
  const targetedCoverage = params.targetedCoverage;
  const topLevelEvidenceTests = collectEvidenceTests(params.evidence);
  if (typeof targetedCoverage === 'string') return topLevelEvidenceTests;
  if (targetedCoverage === undefined) return topLevelEvidenceTests;
  const evidenceTests = collectEvidenceTests(targetedCoverage.evidence);
  if (evidenceTests.length > 0) return evidenceTests;
  return uniqueStrings([
    ...topLevelEvidenceTests,
    ...normalizeStrings(targetedCoverage.existingTests),
    ...normalizeStrings(targetedCoverage.linkedTests),
    ...normalizeStrings(targetedCoverage.executedTests),
  ]);
}

function collectEvidenceTests(evidence: readonly unknown[] | undefined): string[] {
  if (evidence === undefined) return [];
  return evidence.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const testFile = (item as { testFile?: unknown }).testFile;
    return typeof testFile === 'string' && testFile.trim().length > 0 ? [testFile.trim()] : [];
  });
}

function normalizeStrings(values: readonly unknown[] | undefined): string[] {
  if (values === undefined) return [];
  return values.flatMap((value) =>
    typeof value === 'string' ? [value.trim()].filter((item) => item.length > 0) : [],
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
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
