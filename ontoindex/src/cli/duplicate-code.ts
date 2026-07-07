/**
 * Duplicate-Code Command (exact mode)
 *
 * Advisory, CLI-only wrapper over `jscpd` (invoked via `npx`). See
 * ADR_DUPLICATE_CODE_DISCOVERY.md. Semantic mode is proof-gated and not built.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const JSCPD_VERSION = '5.0.11';

// Generated/vendor/build/lockfile paths skipped by default (ADR non-goal:
// never scan these). jscpd v5 respects .gitignore by default.
export const DEFAULT_IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/*.min.js',
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
];

export interface DuplicateCodeOptions {
  mode?: string;
  minLines?: string | number;
  minTokens?: string | number;
  include?: string[];
  exclude?: string[];
  json?: boolean;
  path?: string;
  output?: string;
}

/**
 * Build the argv passed to `npx` (excluding the leading `npx` binary itself).
 * Pure function so command construction is unit-testable without spawning.
 *
 * Targets the current `jscpd`/`cpd` CLI (v5): the `json` reporter writes a
 * `jscpd-report.json` file into `outDir`, `.gitignore` is respected by default,
 * and thresholds use the long `--min-lines` / `--min-tokens` flags.
 */
export function buildJscpdArgs(options: DuplicateCodeOptions, outDir: string): string[] {
  const args = ['--yes', `jscpd@${JSCPD_VERSION}`];
  args.push('--reporters', 'json');
  args.push('--output', outDir);
  args.push('--silent');
  args.push('--no-tips');

  const minLines = Number(options.minLines);
  if (Number.isFinite(minLines) && minLines > 0) {
    args.push('--min-lines', String(minLines));
  }
  const minTokens = Number(options.minTokens);
  if (Number.isFinite(minTokens) && minTokens > 0) {
    args.push('--min-tokens', String(minTokens));
  }

  const ignores = [...DEFAULT_IGNORE_GLOBS, ...(options.exclude ?? [])];
  args.push('--ignore', ignores.join(','));

  for (const pattern of options.include ?? []) {
    args.push('--pattern', pattern);
  }

  args.push(options.path && options.path.length > 0 ? options.path : '.');
  return args;
}

/** Report filename written by the jscpd json reporter inside --output. */
export const JSCPD_REPORT_FILE = 'jscpd-report.json';

export interface DuplicateGroup {
  id: number;
  format: string;
  files: Array<{ path: string; startLine: number; endLine: number }>;
  lines: number;
  tokens: number;
}

export interface NormalizedReport {
  detector: string;
  detectorVersion: string;
  thresholds: { minLines?: number; minTokens?: number };
  duplicationPercent?: number;
  ignoredPathsSummary: string[];
  groups: DuplicateGroup[];
}

/**
 * Normalize raw jscpd JSON into the ADR-required report shape. Pure function.
 * Tolerates missing fields so a parse failure never throws mid-report.
 */
export function normalizeJscpdJson(raw: unknown, options: DuplicateCodeOptions): NormalizedReport {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const duplicates = Array.isArray(obj.duplicates) ? obj.duplicates : [];
  const statistics = (obj.statistics ?? {}) as Record<string, unknown>;
  const total = (statistics.total ?? {}) as Record<string, unknown>;

  const groups: DuplicateGroup[] = duplicates.map((d, i) => {
    const dup = (d ?? {}) as Record<string, unknown>;
    const first = (dup.firstFile ?? {}) as Record<string, unknown>;
    const second = (dup.secondFile ?? {}) as Record<string, unknown>;
    const toFile = (f: Record<string, unknown>) => ({
      path: String(f.name ?? ''),
      startLine: Number(f.start ?? 0),
      endLine: Number(f.end ?? 0),
    });
    return {
      id: i + 1,
      format: String(dup.format ?? ''),
      files: [toFile(first), toFile(second)],
      lines: Number(dup.lines ?? 0),
      tokens: Number(dup.tokens ?? 0),
    };
  });

  const minLines = Number(options.minLines);
  const minTokens = Number(options.minTokens);

  return {
    detector: 'jscpd',
    detectorVersion: JSCPD_VERSION,
    thresholds: {
      minLines: Number.isFinite(minLines) && minLines > 0 ? minLines : undefined,
      minTokens: Number.isFinite(minTokens) && minTokens > 0 ? minTokens : undefined,
    },
    duplicationPercent:
      typeof total.percentage === 'number' ? (total.percentage as number) : undefined,
    ignoredPathsSummary: [...DEFAULT_IGNORE_GLOBS, ...(options.exclude ?? [])],
    groups,
  };
}

const MAX_SUMMARY_GROUPS = 20;

/** Bounded, human-readable summary. Pure function. */
export function formatSummary(report: NormalizedReport): string {
  const lines: string[] = [];
  lines.push(
    `Duplicate-code (${report.detector}@${report.detectorVersion}): ${report.groups.length} group(s)` +
      (report.duplicationPercent !== undefined
        ? `, ${report.duplicationPercent.toFixed(2)}% duplicated`
        : ''),
  );
  const shown = report.groups.slice(0, MAX_SUMMARY_GROUPS);
  for (const g of shown) {
    const [a, b] = g.files;
    lines.push(
      `  #${g.id} ${g.lines} lines / ${g.tokens} tokens: ` +
        `${a.path}:${a.startLine}-${a.endLine} <=> ${b.path}:${b.startLine}-${b.endLine}`,
    );
  }
  const remaining = report.groups.length - shown.length;
  if (remaining > 0) {
    lines.push(`  ... ${remaining} more group(s)`);
  }
  return lines.join('\n');
}

function runNpx(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Args passed as an array (never a shell string) to avoid injection.
    const child = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

export const duplicateCodeCommand = async (options?: DuplicateCodeOptions): Promise<void> => {
  const opts = options ?? {};
  const mode = (opts.mode ?? 'exact').toLowerCase();

  if (mode === 'both') {
    console.error(
      "Mode 'both' was removed (see ADR_DUPLICATE_CODE_DISCOVERY.md). Run --mode exact or --mode semantic.",
    );
    process.exitCode = 2;
    return;
  }
  if (mode === 'semantic') {
    console.error(
      'Semantic mode is not implemented yet; it is proof-gated in ADR_DUPLICATE_CODE_DISCOVERY.md.',
    );
    process.exitCode = 2;
    return;
  }
  if (mode !== 'exact') {
    console.error(`Unknown mode '${mode}'. Use --mode exact.`);
    process.exitCode = 2;
    return;
  }

  // The json reporter writes to a file, so scan into a throwaway temp dir and
  // read the report back rather than parsing stdout.
  const outDir = await mkdtemp(join(tmpdir(), 'ontoindex-dupe-'));
  const args = buildJscpdArgs(opts, outDir);

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await runNpx(args);
  } catch (err) {
    await rm(outDir, { recursive: true, force: true });
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      console.error(
        `Could not run 'npx'. Install Node.js (>=20) so 'npx jscpd@${JSCPD_VERSION}' can run.`,
      );
    } else {
      console.error(
        `Failed to launch jscpd via npx. Ensure network access so 'npx jscpd@${JSCPD_VERSION}' can be fetched. (${e.message})`,
      );
    }
    process.exitCode = 1;
    return;
  }

  let raw: string;
  try {
    raw = await readFile(join(outDir, JSCPD_REPORT_FILE), 'utf8');
  } catch {
    await rm(outDir, { recursive: true, force: true });
    console.error(
      `jscpd did not produce a report (exit ${result.code}). Ensure 'npx jscpd@${JSCPD_VERSION}' can run and reach the network.\n${result.stderr.trim()}`,
    );
    process.exitCode = 1;
    return;
  }
  await rm(outDir, { recursive: true, force: true });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('Could not parse jscpd JSON report.');
    process.exitCode = 1;
    return;
  }

  const report = normalizeJscpdJson(parsed, opts);
  if (opts.output) {
    await mkdir(dirname(opts.output), { recursive: true });
    await writeFile(opts.output, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSummary(report));
  }
};
