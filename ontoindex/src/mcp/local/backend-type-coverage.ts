import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { normalizeLimit } from './tool-utils.js';
import { executeParameterized, isLbugReady } from '../../core/lbug/pool-adapter.js';

type RepoHandle = { readonly id: string; readonly name: string; readonly repoPath: string };

type MessageBearing = { readonly message?: unknown };

interface SymbolRow {
  id: string | null;
  name: string | null;
  kind: string | null;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  callerCount: number | null;
}

interface TypeCoverageFinding {
  pattern_type: string;
  file: string;
  line: number;
  snippet: string;
  enclosing_symbol?: string;
  symbol_kind?: string;
  caller_count: number;
  risk_score: number;
}

interface TypeCoverageResult {
  status: 'success' | 'error';
  tool: 'type_coverage';
  repo: string;
  patterns_checked: string[];
  file_glob: string;
  min_caller_count: number;
  limit: number;
  file_count: number;
  result_count: number;
  findings: TypeCoverageFinding[];
  error?: string;
}

const DEFAULT_FILE_GLOB = '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}';
const DEFAULT_PATTERNS = [
  'explicit_any',
  'non_null_assertion',
  'unsafe_cast',
  'type_suppression',
] as const;
const VALID_PATTERNS = new Set<string>(DEFAULT_PATTERNS);
const IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.ontoindex/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/tmp/**',
];

function legacyErrorMessage(err: unknown): string {
  const message =
    err !== null && err !== undefined && (typeof err === 'object' || typeof err === 'function')
      ? (err as MessageBearing).message
      : undefined;
  return `${message ?? String(err)}`;
}

function normalizePatterns(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) return [...DEFAULT_PATTERNS];
  const cleaned = input
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => VALID_PATTERNS.has(value));
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : [...DEFAULT_PATTERNS];
}

function regexForPattern(pattern: string): RegExp {
  switch (pattern) {
    case 'explicit_any':
      return /(:\s*any\b|as\s+any\b|<any>)/g;
    case 'type_suppression':
      return /@ts-ignore\b|@ts-nocheck\b|@ts-expect-error\b/g;
    case 'non_null_assertion':
      return /(?:\b[A-Za-z_$][\w$]*|\)|\])!\s*(?=[.\[()?,;]|$)/g;
    case 'unsafe_cast':
      return /as\s+(?!any\b|const\b|unknown\b|never\b)(?:[A-Z_$][\w$<>.,\[\]\s|&?]*|[a-z_$][\w$<>.,\[\]\s|&?]*\[\])/g;
    default:
      return /$^/g;
  }
}

async function loadSymbolRanges(repo: RepoHandle): Promise<Map<string, SymbolRow[]>> {
  if (!isLbugReady(repo.id)) return new Map();
  try {
    const rows = (await executeParameterized(
      repo.id,
      `
      MATCH (n:Function)
      WHERE n.filePath IS NOT NULL AND n.startLine IS NOT NULL AND n.endLine IS NOT NULL
      OPTIONAL MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(n)
      RETURN
        n.id AS id,
        n.name AS name,
        'Function' AS kind,
        n.filePath AS filePath,
        n.startLine AS startLine,
        n.endLine AS endLine,
        count(caller) AS callerCount
      UNION ALL
      MATCH (n:Method)
      WHERE n.filePath IS NOT NULL AND n.startLine IS NOT NULL AND n.endLine IS NOT NULL
      OPTIONAL MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(n)
      RETURN
        n.id AS id,
        n.name AS name,
        'Method' AS kind,
        n.filePath AS filePath,
        n.startLine AS startLine,
        n.endLine AS endLine,
        count(caller) AS callerCount
      UNION ALL
      MATCH (n:Constructor)
      WHERE n.filePath IS NOT NULL AND n.startLine IS NOT NULL AND n.endLine IS NOT NULL
      OPTIONAL MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(n)
      RETURN
        n.id AS id,
        n.name AS name,
        'Constructor' AS kind,
        n.filePath AS filePath,
        n.startLine AS startLine,
        n.endLine AS endLine,
        count(caller) AS callerCount
      `,
      {},
    )) as SymbolRow[];
    const byFile = new Map<string, SymbolRow[]>();
    for (const row of rows || []) {
      if (!row.filePath || typeof row.startLine !== 'number' || typeof row.endLine !== 'number')
        continue;
      let list = byFile.get(row.filePath);
      if (!list) {
        list = [];
        byFile.set(row.filePath, list);
      }
      list.push(row);
    }
    for (const list of byFile.values()) {
      list.sort((a, b) => {
        const aSpan = (a.endLine ?? 0) - (a.startLine ?? 0);
        const bSpan = (b.endLine ?? 0) - (b.startLine ?? 0);
        if (aSpan !== bSpan) return aSpan - bSpan;
        return (a.startLine ?? 0) - (b.startLine ?? 0);
      });
    }
    return byFile;
  } catch {
    return new Map();
  }
}

function pickEnclosingSymbol(
  symbols: SymbolRow[] | undefined,
  line: number,
): SymbolRow | undefined {
  if (!symbols) return undefined;
  return symbols.find((symbol) => (symbol.startLine ?? 0) <= line && (symbol.endLine ?? 0) >= line);
}

function pushMatches(
  findings: TypeCoverageFinding[],
  relFile: string,
  content: string,
  patternType: string,
  regex: RegExp,
  symbols: SymbolRow[] | undefined,
): void {
  const lines = content.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const matcher = new RegExp(
      regex.source,
      regex.flags.includes('g') ? regex.flags : `${regex.flags}g`,
    );
    if (!matcher.test(line)) continue;
    const lineNo = lineIndex + 1;
    const symbol = pickEnclosingSymbol(symbols, lineNo);
    const callerCount = typeof symbol?.callerCount === 'number' ? symbol.callerCount : 0;
    findings.push({
      pattern_type: patternType,
      file: relFile,
      line: lineNo,
      snippet: line.trim().slice(0, 240),
      ...(symbol?.name ? { enclosing_symbol: symbol.name } : {}),
      ...(symbol?.kind ? { symbol_kind: symbol.kind } : {}),
      caller_count: callerCount,
      risk_score: callerCount + 1,
    });
  }
}

export async function runTypeCoverage(
  repo: RepoHandle,
  params: {
    patterns?: string[];
    file_glob?: string;
    min_caller_count?: number;
    limit?: number;
  },
): Promise<TypeCoverageResult> {
  const patterns = normalizePatterns(params?.patterns);
  const fileGlob =
    typeof params?.file_glob === 'string' && params.file_glob.trim().length > 0
      ? params.file_glob.trim()
      : DEFAULT_FILE_GLOB;
  const minCallerCount =
    typeof params?.min_caller_count === 'number' && Number.isFinite(params.min_caller_count)
      ? Math.max(0, Math.trunc(params.min_caller_count))
      : 0;
  const limit = normalizeLimit(params?.limit, 50, 500);

  try {
    const [files, symbolRanges] = await Promise.all([
      glob(fileGlob, {
        cwd: repo.repoPath,
        nodir: true,
        ignore: IGNORE,
        dot: true,
        posix: true,
      }),
      loadSymbolRanges(repo),
    ]);

    const findings: TypeCoverageFinding[] = [];
    for (const relFile of files.sort((a, b) => a.localeCompare(b))) {
      const absFile = path.join(repo.repoPath, relFile);
      let content: string;
      try {
        content = await fs.readFile(absFile, 'utf8');
      } catch {
        continue;
      }
      const symbols = symbolRanges.get(relFile.replace(/\\/g, '/'));
      for (const pattern of patterns) {
        pushMatches(
          findings,
          relFile.replace(/\\/g, '/'),
          content,
          pattern,
          regexForPattern(pattern),
          symbols,
        );
      }
    }

    const filtered = findings
      .filter((finding) => finding.caller_count >= minCallerCount)
      .sort(
        (a, b) =>
          b.risk_score - a.risk_score ||
          b.caller_count - a.caller_count ||
          a.file.localeCompare(b.file) ||
          a.line - b.line,
      )
      .slice(0, limit);

    return {
      status: 'success',
      tool: 'type_coverage',
      repo: repo.name,
      patterns_checked: patterns,
      file_glob: fileGlob,
      min_caller_count: minCallerCount,
      limit,
      file_count: files.length,
      result_count: filtered.length,
      findings: filtered,
    };
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'type_coverage',
      repo: repo.name,
      patterns_checked: patterns,
      file_glob: fileGlob,
      min_caller_count: minCallerCount,
      limit,
      file_count: 0,
      result_count: 0,
      findings: [],
      error: `Type coverage audit failed: ${legacyErrorMessage(err)}`,
    };
  }
}
