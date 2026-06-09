import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { executeParameterized, isLbugReady } from '../../core/lbug/pool-adapter.js';

type RepoHandle = { readonly id: string; readonly name: string; readonly repoPath: string };

interface ModuleRow {
  filePath: string | null;
  communityId: string | null;
  community: string | null;
}

interface FileScanResult {
  file: string;
  old_count: number;
  new_count: number;
  module: string;
}

interface MigrationProgressResult {
  status: 'success' | 'error';
  tool: 'migration_progress';
  repo: string;
  label?: string;
  file_glob: string;
  exclude_patterns: string[];
  summary: {
    total_old_sites: number;
    total_new_sites: number;
    pct_migrated: number;
    files_remaining: number;
    done_files: number;
    scanned_files: number;
  };
  by_module: Array<{
    module: string;
    old_count: number;
    new_count: number;
    pct: number;
    files_remaining: number;
  }>;
  remaining_files: Array<{ file: string; module: string; old_count: number; new_count: number }>;
  done_files: string[];
  error?: string;
}

const DEFAULT_FILE_GLOB = '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}';
const DEFAULT_IGNORE = [
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

function caughtErrorMessage(err: unknown): unknown {
  return (err as { readonly message?: unknown } | null | undefined)?.message ?? String(err);
}

function compileRegex(pattern: string, label: string): RegExp {
  try {
    return new RegExp(pattern, 'g');
  } catch (err: unknown) {
    throw new Error(`Invalid ${label}: ${caughtErrorMessage(err)}`);
  }
}

function countMatches(content: string, regex: RegExp): number {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const matcher = new RegExp(regex.source, flags);
  let count = 0;
  for (const _match of content.matchAll(matcher)) count += 1;
  return count;
}

function countLegacyMatches(content: string, oldRegex: RegExp, newRegex: RegExp): number {
  const oldMatcher = new RegExp(
    oldRegex.source,
    oldRegex.flags.includes('g') ? oldRegex.flags : `${oldRegex.flags}g`,
  );
  const newMatcher = new RegExp(
    newRegex.source,
    newRegex.flags.includes('g') ? newRegex.flags : `${newRegex.flags}g`,
  );
  const protectedRanges: Array<{ start: number; end: number }> = [];
  for (const match of content.matchAll(newMatcher)) {
    if (typeof match.index !== 'number') continue;
    protectedRanges.push({ start: match.index, end: match.index + match[0].length });
  }
  let count = 0;
  for (const match of content.matchAll(oldMatcher)) {
    if (typeof match.index !== 'number') continue;
    const start = match.index;
    const end = match.index + match[0].length;
    const overlapsReplacement = protectedRanges.some(
      (range) => start >= range.start && end <= range.end,
    );
    if (!overlapsReplacement) count += 1;
  }
  return count;
}

function pctMigrated(oldCount: number, newCount: number): number {
  const total = oldCount + newCount;
  if (total === 0) return 100;
  return Number(((newCount / total) * 100).toFixed(1));
}

async function loadModuleMap(repo: RepoHandle): Promise<Map<string, string>> {
  if (!isLbugReady(repo.id)) return new Map();
  try {
    const rows = (await executeParameterized(
      repo.id,
      `
      MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE n.filePath IS NOT NULL
      RETURN n.filePath AS filePath, c.id AS communityId, c.heuristicLabel AS community
      `,
      {},
    )) as ModuleRow[];

    const byFile = new Map<string, Map<string, number>>();
    for (const row of rows || []) {
      if (!row.filePath) continue;
      const label = row.community?.trim() || row.communityId?.trim() || 'Unassigned';
      let counts = byFile.get(row.filePath);
      if (!counts) {
        counts = new Map<string, number>();
        byFile.set(row.filePath, counts);
      }
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    const out = new Map<string, string>();
    for (const [filePath, counts] of byFile) {
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (best) out.set(filePath, best[0]);
    }
    return out;
  } catch {
    return new Map();
  }
}

export async function runMigrationProgress(
  repo: RepoHandle,
  params: {
    old_pattern: string;
    new_pattern: string;
    file_glob?: string;
    exclude_patterns?: string[];
    label?: string;
  },
): Promise<MigrationProgressResult> {
  const fileGlob =
    typeof params?.file_glob === 'string' && params.file_glob.trim().length > 0
      ? params.file_glob.trim()
      : DEFAULT_FILE_GLOB;
  const excludePatterns = Array.isArray(params?.exclude_patterns)
    ? params.exclude_patterns.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
    : [];

  try {
    if (typeof params?.old_pattern !== 'string' || params.old_pattern.trim().length === 0) {
      throw new Error('old_pattern is required');
    }
    if (typeof params?.new_pattern !== 'string' || params.new_pattern.trim().length === 0) {
      throw new Error('new_pattern is required');
    }

    const [moduleMap, files] = await Promise.all([
      loadModuleMap(repo),
      glob(fileGlob, {
        cwd: repo.repoPath,
        nodir: true,
        ignore: [...DEFAULT_IGNORE, ...excludePatterns],
        dot: true,
        posix: true,
      }),
    ]);

    const oldRegex = compileRegex(params.old_pattern, 'old_pattern');
    const newRegex = compileRegex(params.new_pattern, 'new_pattern');
    const perFile: FileScanResult[] = [];

    for (const relFile of files.sort((a, b) => a.localeCompare(b))) {
      const absFile = path.join(repo.repoPath, relFile);
      let content: string;
      try {
        content = await fs.readFile(absFile, 'utf8');
      } catch {
        continue;
      }
      const oldCount = countLegacyMatches(content, oldRegex, newRegex);
      const newCount = countMatches(content, newRegex);
      if (oldCount === 0 && newCount === 0) continue;
      perFile.push({
        file: relFile.replace(/\\/g, '/'),
        old_count: oldCount,
        new_count: newCount,
        module: moduleMap.get(relFile.replace(/\\/g, '/')) ?? 'Unassigned',
      });
    }

    const totalOld = perFile.reduce((sum, file) => sum + file.old_count, 0);
    const totalNew = perFile.reduce((sum, file) => sum + file.new_count, 0);
    const remainingFiles = perFile
      .filter((file) => file.old_count > 0)
      .sort((a, b) => b.old_count - a.old_count || a.file.localeCompare(b.file));
    const doneFiles = perFile
      .filter((file) => file.old_count === 0 && file.new_count > 0)
      .map((file) => file.file)
      .sort((a, b) => a.localeCompare(b));

    const byModuleMap = new Map<
      string,
      { old_count: number; new_count: number; files_remaining: number }
    >();
    for (const file of perFile) {
      const entry = byModuleMap.get(file.module) ?? {
        old_count: 0,
        new_count: 0,
        files_remaining: 0,
      };
      entry.old_count += file.old_count;
      entry.new_count += file.new_count;
      if (file.old_count > 0) entry.files_remaining += 1;
      byModuleMap.set(file.module, entry);
    }

    const byModule = [...byModuleMap.entries()]
      .map(([module, counts]) => ({
        module,
        old_count: counts.old_count,
        new_count: counts.new_count,
        pct: pctMigrated(counts.old_count, counts.new_count),
        files_remaining: counts.files_remaining,
      }))
      .sort(
        (a, b) =>
          b.old_count - a.old_count ||
          b.new_count - a.new_count ||
          a.module.localeCompare(b.module),
      );

    return {
      status: 'success',
      tool: 'migration_progress',
      repo: repo.name,
      ...(typeof params.label === 'string' && params.label.trim().length > 0
        ? { label: params.label.trim() }
        : {}),
      file_glob: fileGlob,
      exclude_patterns: excludePatterns,
      summary: {
        total_old_sites: totalOld,
        total_new_sites: totalNew,
        pct_migrated: pctMigrated(totalOld, totalNew),
        files_remaining: remainingFiles.length,
        done_files: doneFiles.length,
        scanned_files: files.length,
      },
      by_module: byModule,
      remaining_files: remainingFiles.map((file) => ({
        file: file.file,
        module: file.module,
        old_count: file.old_count,
        new_count: file.new_count,
      })),
      done_files: doneFiles,
    };
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'migration_progress',
      repo: repo.name,
      file_glob: fileGlob,
      exclude_patterns: excludePatterns,
      summary: {
        total_old_sites: 0,
        total_new_sites: 0,
        pct_migrated: 0,
        files_remaining: 0,
        done_files: 0,
        scanned_files: 0,
      },
      by_module: [],
      remaining_files: [],
      done_files: [],
      error: `Migration progress failed: ${caughtErrorMessage(err)}`,
    };
  }
}
