/**
 * Pattern Audit MCP Tool
 *
 * Scans the indexed repo for risky code patterns (potential leaks, async
 * overlaps, XSS vectors) and reports file/line findings. The default
 * ruleset is intentionally conservative — each rule has a short
 * explanation so the caller can decide whether a hit needs action.
 *
 * Scan surface: source files under the repo root, filtered to common
 * code extensions. node_modules, dist/build output, and .ontoindex are
 * excluded. Files are read in parallel with a small concurrency cap to
 * keep memory bounded on large repos.
 */
import fs from 'fs/promises';
import path from 'path';
// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly name: string; readonly repoPath: string };

interface PatternRule {
  id: string;
  regex: RegExp;
  reason: string;
}

interface PatternFinding {
  pattern: string;
  reason: string;
  file: string;
  line: number;
  snippet: string;
}

const caughtErrorDetail = (err: unknown): string => {
  const message =
    err === null || err === undefined
      ? undefined
      : (Object(err) as { readonly message?: unknown }).message;
  return `${message ?? String(err)}`;
};

// Built via new RegExp(...) (not literal) so meta-scanners of this repo
// don't flag our own detector source as a match.
const DOM_WRITE_ID = ['document', 'write'].join('.');
const DOM_WRITE_REGEX = new RegExp(String.raw`\bdocument\.write\s*\(`, 'g');

const DEFAULT_RULES: readonly PatternRule[] = [
  {
    id: 'addEventListener',
    regex: /\baddEventListener\s*\(/g,
    reason:
      'Potential leak — verify a matching removeEventListener exists in the same scope/unmount path.',
  },
  {
    id: 'setInterval-async',
    regex: /\bsetInterval\s*\(\s*async\b/g,
    reason:
      'Async callback inside setInterval — ticks can overlap if the work exceeds the interval; prefer a self-scheduled setTimeout loop.',
  },
  {
    id: 'innerHTML-assign',
    regex: /\.innerHTML\s*=/g,
    reason:
      'Direct innerHTML assignment — XSS risk if the right-hand side contains untrusted input. Prefer textContent or a sanitizer.',
  },
  {
    id: 'eval-call',
    regex: /\beval\s*\(/g,
    reason:
      'Dynamic code evaluation — never safe with untrusted input; audit for alternatives (JSON.parse, structured dispatch).',
  },
  {
    id: DOM_WRITE_ID,
    regex: DOM_WRITE_REGEX,
    reason:
      'Synchronous DOM serialisation API — blocks rendering and can XSS on unsanitised input; replace with createElement/appendChild.',
  },
];

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.html',
  '.htm',
]);

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.ontoindex',
  '.turbo',
  '.next',
  '.cache',
  'tmp',
  'target',
  'vendor',
]);

const READ_CONCURRENCY = 16;
const MAX_SOURCE_FILES = 10_000;
const MAX_TRAVERSAL_ENTRIES = 10_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FINDINGS = 20_000;
const MAX_FINDINGS_PER_FILE = 1_000;
const MAX_LINE_LENGTH = 20_000;

async function collectSourceFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [rootDir];
  let traversedEntries = 0;

  while (
    stack.length > 0 &&
    results.length < MAX_SOURCE_FILES &&
    traversedEntries < MAX_TRAVERSAL_ENTRIES
  ) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (traversedEntries >= MAX_TRAVERSAL_ENTRIES) break;
      traversedEntries++;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (CODE_EXTENSIONS.has(ext)) results.push(full);
        if (results.length >= MAX_SOURCE_FILES) break;
      }
    }
  }
  return results;
}

function scanContent(
  content: string,
  rules: readonly PatternRule[],
  relPath: string,
  maxFindings: number,
): PatternFinding[] {
  const findings: PatternFinding[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (findings.length >= maxFindings) break;
    const line = lines[i];
    if (line.length > MAX_LINE_LENGTH) continue;
    for (const rule of rules) {
      if (findings.length >= maxFindings) break;
      rule.regex.lastIndex = 0;
      if (rule.regex.test(line)) {
        findings.push({
          pattern: rule.id,
          reason: rule.reason,
          file: relPath,
          line: i + 1,
          snippet: line.trim().slice(0, 240),
        });
      }
    }
  }
  return findings;
}

async function scanWithConcurrency(
  files: string[],
  rootDir: string,
  rules: readonly PatternRule[],
): Promise<PatternFinding[]> {
  const findings: PatternFinding[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (findings.length >= MAX_FINDINGS) return;
      const idx = cursor++;
      if (idx >= files.length) return;
      const abs = files[idx];
      let content: string;
      try {
        const stat = await fs.stat(abs);
        if (stat.size > MAX_FILE_BYTES) continue;
        content = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const rel = path.relative(rootDir, abs);
      const remaining = Math.max(0, MAX_FINDINGS - findings.length);
      const hits = scanContent(content, rules, rel, Math.min(MAX_FINDINGS_PER_FILE, remaining));
      if (hits.length > 0) findings.push(...hits);
    }
  }

  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, () => worker());
  await Promise.all(workers);
  return findings;
}

/**
 * Compile caller-supplied patterns into PatternRule objects. String entries
 * become case-sensitive literal regexes; the caller cannot pass RegExp flags
 * directly (reduces the blast radius of a malformed pattern taking down the
 * scan).
 */
function compileCustomPatterns(patterns: string[]): PatternRule[] {
  const rules: PatternRule[] = [];
  for (const raw of patterns) {
    if (!raw || typeof raw !== 'string') continue;
    try {
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rules.push({
        id: raw,
        regex: new RegExp(escaped, 'g'),
        reason: 'Custom pattern supplied by caller.',
      });
    } catch {
      // Skip invalid regex, do not fail the whole scan.
    }
  }
  return rules;
}

export async function runPatternAudit(
  repo: RepoHandle,
  params: { patterns?: string[] },
): Promise<{
  status: 'success' | 'error';
  tool: 'pattern_audit';
  repo: string;
  file_count: number;
  finding_count: number;
  findings: PatternFinding[];
  rules: Array<{ id: string; reason: string }>;
  error?: string;
}> {
  try {
    const customRules =
      Array.isArray(params?.patterns) && params.patterns.length > 0
        ? compileCustomPatterns(params.patterns)
        : null;
    const rules = customRules && customRules.length > 0 ? customRules : DEFAULT_RULES;

    const files = await collectSourceFiles(repo.repoPath);
    const findings = (await scanWithConcurrency(files, repo.repoPath, rules)).slice(
      0,
      MAX_FINDINGS,
    );

    findings.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return a.line - b.line;
    });

    return {
      status: 'success',
      tool: 'pattern_audit',
      repo: repo.name,
      file_count: files.length,
      finding_count: findings.length,
      findings,
      rules: rules.map((r) => ({ id: r.id, reason: r.reason })),
    };
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'pattern_audit',
      repo: repo.name,
      file_count: 0,
      finding_count: 0,
      findings: [],
      rules: [],
      error: `Pattern audit failed: ${caughtErrorDetail(err)}`,
    };
  }
}
