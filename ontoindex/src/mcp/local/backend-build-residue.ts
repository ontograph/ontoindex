/**
 * Build Residue Audit MCP Tool
 *
 * Scans both source and build-output trees for "forbidden domain"
 * strings that should never ship — debug markers (console.log, TODO,
 * FIXME), project-specific feature names, code paths that were meant
 * to be stripped by a build step, etc.
 *
 * The caller supplies the domain list (forbidden_domains). If omitted
 * we fall back to a small generic debug-marker set. Matching is
 * case-insensitive substring — regex is intentionally not exposed here
 * (callers wanting regex go through pattern_audit instead).
 *
 * Unlike pattern_audit this tool explicitly INCLUDES build output
 * directories (dist, build, out, target, .next, .turbo). The whole
 * point is to catch residue that survived the build pipeline.
 */
import fs from 'fs/promises';
import path from 'path';
// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly name: string; readonly repoPath: string };

interface ResidueFinding {
  domain: string;
  file: string;
  line: number;
  snippet: string;
  is_build_output: boolean;
}

const DEFAULT_FORBIDDEN_DOMAINS = ['TODO:', 'FIXME:', 'XXX:', 'HACK:', 'debugger;'];

// Extensions worth scanning — source + built artifacts + config-ish.
const SCAN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.json',
  '.map',
  '.svg',
]);

// Directories treated as "build output" — content still scanned, but
// tagged so callers can filter their own report.
const BUILD_DIRS = new Set(['dist', 'build', 'out', 'target', '.next', '.turbo', 'coverage']);

// Directories we don't touch regardless of input.
const BASE_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.ontoindex',
  '.cache',
  '.idea',
  '.vscode',
  'vendor',
]);

// Default-mode skips to keep the built-in preset focused on likely ship
// residue instead of tests, fixtures, and workspace scratch.
const DEFAULT_NOISE_DIRS = new Set([
  'docs',
  'audit',
  'tmp',
  'test',
  'tests',
  '__tests__',
  'fixtures',
  '__fixtures__',
]);

const BASE_SKIP_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
]);

// Max file size we open — keeps a runaway sourcemap / bundled vendor
// file from blowing memory. 2 MB is enough for typical production JS
// bundles without dragging giant asset dumps through grep.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const READ_CONCURRENCY = 16;

interface ScanTarget {
  abs: string;
  rel: string;
  isBuildOutput: boolean;
}

function formatCaughtError(err: unknown): string {
  const message = err == null ? undefined : (err as { readonly message?: unknown }).message;
  return `${message ?? String(err)}`;
}

function shouldSkipDir(name: string, useDefaultDomains: boolean): boolean {
  return BASE_SKIP_DIRS.has(name) || (useDefaultDomains && DEFAULT_NOISE_DIRS.has(name));
}

function shouldSkipFile(name: string): boolean {
  return BASE_SKIP_FILES.has(name);
}

function shouldSkipResidueTarget(target: ScanTarget, useDefaultDomains: boolean): boolean {
  if (!useDefaultDomains) return false;
  return /(^|\/)backend-build-residue\.(ts|js)$/.test(target.rel);
}

async function collectTargets(rootDir: string, useDefaultDomains: boolean): Promise<ScanTarget[]> {
  const results: ScanTarget[] = [];
  const stack: Array<{ dir: string; inBuild: boolean }> = [{ dir: rootDir, inBuild: false }];

  while (stack.length > 0) {
    const { dir, inBuild } = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name, useDefaultDomains)) continue;
        const nextInBuild = inBuild || BUILD_DIRS.has(entry.name);
        stack.push({ dir: full, inBuild: nextInBuild });
      } else if (entry.isFile()) {
        if (shouldSkipFile(entry.name)) continue;
        const ext = path.extname(entry.name);
        if (!SCAN_EXTENSIONS.has(ext)) continue;
        results.push({
          abs: full,
          rel: path.relative(rootDir, full),
          isBuildOutput: inBuild,
        });
      }
    }
  }
  return results;
}

function scanContent(
  content: string,
  domainsLower: string[],
  domainsOrig: string[],
  target: ScanTarget,
): ResidueFinding[] {
  const findings: ResidueFinding[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    for (let j = 0; j < domainsLower.length; j++) {
      if (lower.includes(domainsLower[j])) {
        findings.push({
          domain: domainsOrig[j],
          file: target.rel,
          line: i + 1,
          snippet: line.trim().slice(0, 240),
          is_build_output: target.isBuildOutput,
        });
      }
    }
  }
  return findings;
}

async function scanAll(
  targets: ScanTarget[],
  domainsLower: string[],
  domainsOrig: string[],
  useDefaultDomains: boolean,
): Promise<ResidueFinding[]> {
  const findings: ResidueFinding[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const target = targets[idx];
      if (shouldSkipResidueTarget(target, useDefaultDomains)) continue;
      let stat;
      try {
        stat = await fs.stat(target.abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      let content: string;
      try {
        content = await fs.readFile(target.abs, 'utf8');
      } catch {
        continue;
      }
      const hits = scanContent(content, domainsLower, domainsOrig, target);
      if (hits.length > 0) findings.push(...hits);
    }
  }

  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, targets.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return findings;
}

export async function runBuildResidueAudit(
  repo: RepoHandle,
  params: { forbidden_domains?: string[] },
): Promise<{
  status: 'success' | 'error';
  tool: 'build_residue_audit';
  repo: string;
  file_count: number;
  finding_count: number;
  build_output_matches: number;
  source_matches: number;
  domains_scanned: string[];
  findings: ResidueFinding[];
  error?: string;
}> {
  try {
    const raw = Array.isArray(params?.forbidden_domains) ? params!.forbidden_domains : [];
    const cleaned = raw
      .filter((d): d is string => typeof d === 'string' && d.length > 0)
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    const useDefaultDomains = cleaned.length === 0;
    const domains = useDefaultDomains ? DEFAULT_FORBIDDEN_DOMAINS.slice() : cleaned;
    const domainsLower = domains.map((d) => d.toLowerCase());

    const targets = await collectTargets(repo.repoPath, useDefaultDomains);
    const findings = await scanAll(targets, domainsLower, domains, useDefaultDomains);

    findings.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return a.line - b.line;
    });

    let buildHits = 0;
    let sourceHits = 0;
    for (const f of findings) {
      if (f.is_build_output) buildHits++;
      else sourceHits++;
    }

    return {
      status: 'success',
      tool: 'build_residue_audit',
      repo: repo.name,
      file_count: targets.length,
      finding_count: findings.length,
      build_output_matches: buildHits,
      source_matches: sourceHits,
      domains_scanned: domains,
      findings,
    };
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'build_residue_audit',
      repo: repo.name,
      file_count: 0,
      finding_count: 0,
      build_output_matches: 0,
      source_matches: 0,
      domains_scanned: [],
      findings: [],
      error: `Build residue audit failed: ${formatCaughtError(err)}`,
    };
  }
}
