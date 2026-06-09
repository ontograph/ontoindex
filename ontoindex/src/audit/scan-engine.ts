/**
 * Pure-JS multi-pattern file scanner used by audit tools.
 *
 * The bundle ships a native C++ implementation in native/audit-scan/
 * with this JS path as the fallback. On main we only carry the JS
 * fallback so the audit tools can run without the native addon.
 */
import { readFile, stat } from 'fs/promises';
import safeRegex from 'safe-regex';

interface AuditScanPattern {
  id: string;
  kind: 'literal' | 'regex';
  expression: string;
  case_sensitive?: boolean;
}

interface AuditScanRequest {
  files: string[];
  patterns: AuditScanPattern[];
  context_lines?: number;
  max_hits?: number;
  max_hits_per_file?: number;
  max_file_bytes?: number;
}

interface AuditScanHit {
  pattern_id: string;
  file: string;
  line: number;
  column: number;
  match_text: string;
}

interface AuditScanResult {
  hits: AuditScanHit[];
}

export async function scanAuditPatterns(request: AuditScanRequest): Promise<AuditScanResult> {
  return scanAuditPatternsJS(request);
}

const DEFAULT_MAX_HITS = 20_000;
const DEFAULT_MAX_HITS_PER_FILE = 1_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const MAX_REGEX_LINE_LENGTH = 20_000;

type CompiledPattern =
  | { pattern: AuditScanPattern; kind: 'literal' }
  | { pattern: AuditScanPattern; kind: 'regex'; regex: RegExp };

async function scanAuditPatternsJS(request: AuditScanRequest): Promise<AuditScanResult> {
  const hits: AuditScanHit[] = [];
  const maxHits = clampLimit(request.max_hits, DEFAULT_MAX_HITS);
  const maxHitsPerFile = clampLimit(request.max_hits_per_file, DEFAULT_MAX_HITS_PER_FILE);
  const maxFileBytes = clampLimit(request.max_file_bytes, DEFAULT_MAX_FILE_BYTES);
  const patterns = compilePatterns(request.patterns);

  for (let i = 0; i < request.files.length && hits.length < maxHits; i++) {
    const filePath = request.files[i];
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > maxFileBytes) continue;

      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      let fileHits = 0;

      for (const compiled of patterns) {
        if (hits.length >= maxHits || fileHits >= maxHitsPerFile) break;
        const fileRemaining = maxHitsPerFile - fileHits;
        if (compiled.kind === 'literal') {
          fileHits += scanLiteral(compiled.pattern, lines, filePath, hits, maxHits, fileRemaining);
        } else {
          fileHits += scanRegex(
            compiled.pattern,
            compiled.regex,
            lines,
            filePath,
            hits,
            maxHits,
            fileRemaining,
          );
        }
      }
    } catch {
      // Silently skip files that can't be read
    }

    if (i % 25 === 24) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  hits.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    return a.pattern_id.localeCompare(b.pattern_id);
  });

  return { hits };
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function compilePatterns(patterns: AuditScanPattern[]): CompiledPattern[] {
  const compiled: CompiledPattern[] = [];
  for (const pattern of patterns) {
    if (pattern.kind === 'literal') {
      if (pattern.expression.length > 0) compiled.push({ kind: 'literal', pattern });
      continue;
    }
    if (pattern.kind !== 'regex') continue;
    try {
      if (!safeRegex(pattern.expression)) continue;
      const flags = pattern.case_sensitive === false ? 'gi' : 'g';
      compiled.push({ kind: 'regex', pattern, regex: new RegExp(pattern.expression, flags) });
    } catch {
      // Skip invalid or unsafe regexes; audit tools are best-effort.
    }
  }
  return compiled;
}

function scanLiteral(
  pattern: AuditScanPattern,
  lines: string[],
  filePath: string,
  hits: AuditScanHit[],
  maxHits: number,
  maxHitsPerFile: number,
): number {
  const searchStr = pattern.expression;
  const caseSensitive = pattern.case_sensitive !== false;
  const strToSearch = caseSensitive ? searchStr : searchStr.toLowerCase();
  let added = 0;

  for (let i = 0; i < lines.length; i++) {
    if (hits.length >= maxHits || added >= maxHitsPerFile) break;
    const line = lines[i];
    const lineToSearch = caseSensitive ? line : line.toLowerCase();
    let start = 0;
    while (true) {
      if (hits.length >= maxHits || added >= maxHitsPerFile) break;
      const index = lineToSearch.indexOf(strToSearch, start);
      if (index === -1) break;
      hits.push({
        pattern_id: pattern.id,
        file: filePath,
        line: i + 1,
        column: index + 1,
        match_text: line.substring(index, index + searchStr.length),
      });
      added++;
      start = index + 1;
    }
  }
  return added;
}

function scanRegex(
  pattern: AuditScanPattern,
  re: RegExp,
  lines: string[],
  filePath: string,
  hits: AuditScanHit[],
  maxHits: number,
  maxHitsPerFile: number,
): number {
  let added = 0;
  for (let i = 0; i < lines.length; i++) {
    if (hits.length >= maxHits || added >= maxHitsPerFile) break;
    const line = lines[i];
    if (line.length > MAX_REGEX_LINE_LENGTH) continue;
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      if (hits.length >= maxHits || added >= maxHitsPerFile) break;
      if (typeof m.index !== 'number') continue;
      hits.push({
        pattern_id: pattern.id,
        file: filePath,
        line: i + 1,
        column: m.index + 1,
        match_text: m[0],
      });
      added++;
    }
  }
  return added;
}
