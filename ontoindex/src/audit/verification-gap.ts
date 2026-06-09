import { execFileSync } from 'child_process';
import type { AuditResponse, AuditCoverage } from 'ontoindex-shared';
import path from 'path';
import fs from 'fs';
import { executeParameterized } from '../core/lbug/pool-adapter.js';
import type { LbugQueryRow } from '../core/lbug/pool-adapter.js';

interface VerificationGapOptions {
  repoId?: string;
  repoPath: string;
  baseRef?: string;
}

type CountRow = LbugQueryRow & {
  readonly hits: number;
  readonly 0?: number;
};

const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs', '.cts', '.mts']);

const TEST_FILE_RE = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/i;
const TEST_PATH_RE = /(^|[/\\])tests?([/\\]|$)|(^|[/\\])__tests__([/\\]|$)/i;
const SKIP_DIRS = new Set([
  '.git',
  '.ontoindex',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'tmp',
]);
const MAX_TEST_FILES = 10_000;
const MAX_TEST_FILE_BYTES = 1024 * 1024;

type TestImportIndex = Map<string, Set<string>>;

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isTestFile(filePath: string): boolean {
  return TEST_FILE_RE.test(filePath) || TEST_PATH_RE.test(filePath);
}

function toRepoRelative(repoPath: string, filePath: string): string {
  return path.relative(repoPath, filePath).split(path.sep).join('/');
}

function normalizeModuleKey(filePath: string): string {
  let normalized = path.resolve(filePath);
  const ext = path.extname(normalized).toLowerCase();
  if (CODE_EXTENSIONS.has(ext)) normalized = normalized.slice(0, -ext.length);
  if (normalized.endsWith(`${path.sep}index`)) {
    normalized = normalized.slice(0, -`${path.sep}index`.length);
  }
  return normalized;
}

function mapRuntimeExtensionCandidates(resolved: string): string[] {
  const ext = path.extname(resolved).toLowerCase();
  const base = ext ? resolved.slice(0, -ext.length) : resolved;
  const candidates = new Set<string>();

  if (!ext) {
    for (const candidateExt of CODE_EXTENSIONS) {
      candidates.add(`${base}${candidateExt}`);
      candidates.add(path.join(base, `index${candidateExt}`));
    }
    return Array.from(candidates);
  }

  candidates.add(resolved);
  candidates.add(path.join(base, `index${ext}`));

  if (ext === '.js' || ext === '.jsx') {
    for (const sourceExt of ['.ts', '.tsx']) {
      candidates.add(`${base}${sourceExt}`);
      candidates.add(path.join(base, `index${sourceExt}`));
    }
  } else if (ext === '.mjs') {
    for (const sourceExt of ['.mts', '.ts']) {
      candidates.add(`${base}${sourceExt}`);
      candidates.add(path.join(base, `index${sourceExt}`));
    }
  } else if (ext === '.cjs') {
    for (const sourceExt of ['.cts', '.ts']) {
      candidates.add(`${base}${sourceExt}`);
      candidates.add(path.join(base, `index${sourceExt}`));
    }
  }

  return Array.from(candidates);
}

function extractModuleSpecifiers(content: string): string[] {
  const matches = content.matchAll(
    /(?:import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]/g,
  );
  const specifiers = new Set<string>();
  for (const match of matches) {
    const specifier = match[1]?.trim();
    if (specifier) specifiers.add(specifier);
  }
  return Array.from(specifiers);
}

function resolveImportSpecifier(repoPath: string, testFile: string, specifier: string): string[] {
  if (!(specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('src/'))) {
    return [];
  }

  const resolved = specifier.startsWith('src/')
    ? path.resolve(repoPath, specifier)
    : path.resolve(path.dirname(testFile), specifier);

  return mapRuntimeExtensionCandidates(resolved)
    .filter((candidate) => {
      const rel = path.relative(repoPath, candidate);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    })
    .filter((candidate) => fs.existsSync(candidate));
}

function indexResolvedImports(
  index: TestImportIndex,
  resolvedFile: string,
  testFile: string,
): void {
  const key = normalizeModuleKey(resolvedFile);
  let tests = index.get(key);
  if (!tests) {
    tests = new Set<string>();
    index.set(key, tests);
  }
  tests.add(testFile);
}

function buildVerificationGapGraphQuery(): string {
  return `
    MATCH (test:File)-[r:CodeRelation]->(target)
    WHERE (test.filePath CONTAINS '.test.'
       OR test.filePath CONTAINS '.spec.'
       OR test.filePath STARTS WITH 'test/'
       OR test.filePath STARTS WITH 'tests/'
       OR test.filePath CONTAINS '/__tests__/')
      AND r.type IN ['VERIFIES', 'CALLS', 'IMPORTS']
      AND target.filePath = $src
    RETURN count(target) as hits
  `;
}

async function walkForTestFiles(dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_TEST_FILES) return;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_TEST_FILES) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkForTestFiles(abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = abs.split(path.sep).join('/');
    if (isTestFile(rel) && isCodeFile(rel)) out.push(abs);
  }
}

function resolveBaseCommit(repoPath: string, baseRef: string): string {
  return execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  }).trim();
}

async function buildTestImportIndex(repoPath: string): Promise<TestImportIndex> {
  const testFiles: string[] = [];
  await walkForTestFiles(repoPath, testFiles);

  const index: TestImportIndex = new Map();
  for (const testFile of testFiles) {
    let content: string;
    try {
      const stat = await fs.promises.stat(testFile);
      if (stat.size > MAX_TEST_FILE_BYTES) continue;
      content = await fs.promises.readFile(testFile, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of extractModuleSpecifiers(content)) {
      for (const resolved of resolveImportSpecifier(repoPath, testFile, specifier)) {
        indexResolvedImports(index, resolved, testFile);
      }
    }
  }

  return index;
}

/**
 * Identify missing test coverage for changed code.
 */
export async function auditVerificationGap(
  options: VerificationGapOptions,
): Promise<AuditResponse> {
  const { repoId, repoPath, baseRef = 'HEAD~1' } = options;

  // 1. Identify changed files using git
  let changedFiles: string[] = [];
  try {
    const baseCommit = resolveBaseCommit(repoPath, baseRef);
    const output = execFileSync('git', ['diff', '--name-only', baseCommit, '--'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    changedFiles = output.split('\n').filter((f) => f.trim() !== '');
  } catch (e) {
    // Best effort: if git fails, we can't detect "changes"
    return {
      summary:
        'Failed to identify changed files via git. Ensure you are in a git repository and the baseRef is valid.',
      coverage: [],
    };
  }

  // 2. Filter to source files
  const sourceFiles = changedFiles.filter((f) => {
    const isCode =
      f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.jsx');
    const isTest =
      f.includes('.test.') ||
      f.includes('.spec.') ||
      f.startsWith('test/') ||
      f.startsWith('tests/');
    return isCode && !isTest;
  });

  const coverage: AuditCoverage[] = [];
  const importIndex = await buildTestImportIndex(repoPath);

  for (const src of sourceFiles) {
    // Strategy A: Naming Convention
    const baseName = path.basename(src, path.extname(src));
    const dirName = path.dirname(src);
    const backendAlias = baseName.startsWith('backend-') ? baseName.slice('backend-'.length) : null;

    const testCandidates = [
      path.join(repoPath, dirName, `${baseName}.test.ts`),
      path.join(repoPath, dirName, `${baseName}.test.js`),
      path.join(repoPath, dirName, `${baseName}.spec.ts`),
      path.join(repoPath, dirName, `${baseName}.spec.js`),
      path.join(repoPath, 'test', 'unit', `${baseName}.test.ts`),
      path.join(repoPath, 'test', 'unit', `${baseName}.spec.ts`),
      path.join(repoPath, 'test', 'integration', `${baseName}.test.ts`),
      path.join(repoPath, 'test', 'integration', `${baseName}.spec.ts`),
      path.join(repoPath, 'test', src.replace('src/', '')).replace(/\.ts$/, '.test.ts'),
      path.join(repoPath, 'test', src.replace('src/', '')).replace(/\.js$/, '.test.js'),
    ];
    if (backendAlias) {
      testCandidates.push(
        path.join(repoPath, 'test', 'unit', `${backendAlias}.test.ts`),
        path.join(repoPath, 'test', 'unit', `${backendAlias}.spec.ts`),
        path.join(repoPath, 'test', 'integration', `${backendAlias}.test.ts`),
        path.join(repoPath, 'test', 'integration', `${backendAlias}.spec.ts`),
      );
    }

    const existingTest = testCandidates.find((t) => fs.existsSync(t));
    const directTestImports = Array.from(
      importIndex.get(normalizeModuleKey(path.resolve(repoPath, src))) ?? [],
    ).map((testFile) => toRepoRelative(repoPath, testFile));

    // Strategy B: Graph Trace (if repoId provided)
    let graphVerified = false;
    if (repoId) {
      try {
        const result = await executeParameterized<CountRow>(
          repoId,
          buildVerificationGapGraphQuery(),
          {
            src,
          },
        );
        if (result.length > 0 && (result[0].hits > 0 || result[0][0] > 0)) {
          graphVerified = true;
        }
      } catch (e) {}
    }

    if (directTestImports.length > 0) {
      coverage.push({
        file: src,
        status: 'covered',
        gap: `Direct test import found in ${directTestImports.slice(0, 3).join(', ')}.`,
      });
    } else if (graphVerified) {
      coverage.push({
        file: src,
        status: 'covered',
        gap: 'Verified by graph trace: symbols in this file are imported or called by test files.',
      });
    } else if (existingTest) {
      coverage.push({
        file: src,
        status: 'weakly_covered',
        gap: 'Matching test file exists by naming convention, but no direct call trace found in graph.',
      });
    } else {
      coverage.push({
        file: src,
        status: 'uncovered',
        gap: 'No matching test file found and no call trace detected from known tests.',
      });
    }
  }

  const uncoveredCount = coverage.filter((c) => c.status === 'uncovered').length;

  return {
    summary:
      uncoveredCount > 0
        ? `Detected ${uncoveredCount} changed files without test coverage`
        : 'All changed files have some level of test coverage',
    coverage,
  };
}
