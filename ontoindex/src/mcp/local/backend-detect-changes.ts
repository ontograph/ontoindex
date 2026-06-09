import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { parseDiffHunks, type FileDiff } from '../../storage/git.js';
import { execFile } from 'child_process';
import type { ChangedFileSymbol } from '../../core/review/review-types.js';

interface DetectChangesRepoHandle {
  id: string;
  repoPath: string;
}

type QueryRow = Record<string, unknown> | readonly unknown[];

type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

// Extends the canonical ChangedFileSymbol shape from the shared review core.
interface ChangedSymbol extends ChangedFileSymbol {
  change_type: 'touched';
}

interface ChangedStep {
  symbol: unknown;
  step: unknown;
}

interface AffectedProcess {
  id: unknown;
  name: unknown;
  process_type: unknown;
  step_count: unknown;
  changed_steps: ChangedStep[];
}

interface DetectChangesSummary {
  changed_count: number;
  affected_count: number;
  risk_level: RiskLevel;
  message?: string;
  changed_files?: number;
}

interface DetectChangesSuccess {
  summary: DetectChangesSummary;
  changed_symbols: ChangedSymbol[];
  affected_processes: AffectedProcess[];
  warnings: string[];
}

interface DetectChangesError {
  error: string;
  summary?: undefined;
  changed_symbols?: undefined;
  affected_processes?: undefined;
  warnings?: undefined;
}

export type DetectChangesResult = DetectChangesSuccess | DetectChangesError;

function rowFallbackValue(row: QueryRow, key: string, index: number): unknown {
  const record = row as Record<string, unknown>;
  const indexed = Array.isArray(row) ? row[index] : record[String(index)];
  return record[key] || indexed;
}

function boundedEnvInt(name: string, defaultValue: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(raw)) return defaultValue;
  return Math.max(min, Math.min(raw, max));
}

const GIT_DIFF_TIMEOUT_MS = boundedEnvInt(
  'ONTOINDEX_DETECT_CHANGES_GIT_TIMEOUT_MS',
  5_000,
  500,
  60_000,
);
const GIT_DIFF_MAX_BUFFER = boundedEnvInt(
  'ONTOINDEX_DETECT_CHANGES_DIFF_MAX_BUFFER',
  16 * 1024 * 1024,
  1024 * 1024,
  256 * 1024 * 1024,
);
const MAX_DIFF_FILES = boundedEnvInt('ONTOINDEX_DETECT_CHANGES_MAX_FILES', 200, 1, 5000);
const MAX_HUNKS_PER_FILE = boundedEnvInt(
  'ONTOINDEX_DETECT_CHANGES_MAX_HUNKS_PER_FILE',
  100,
  1,
  1000,
);
const MAX_TOTAL_HUNKS = boundedEnvInt('ONTOINDEX_DETECT_CHANGES_MAX_TOTAL_HUNKS', 5000, 1, 50_000);
const MAX_CHANGED_SYMBOLS = boundedEnvInt(
  'ONTOINDEX_DETECT_CHANGES_MAX_CHANGED_SYMBOLS',
  1000,
  1,
  20_000,
);
const MAX_PROCESS_SYMBOL_IDS = boundedEnvInt(
  'ONTOINDEX_DETECT_CHANGES_MAX_PROCESS_SYMBOL_IDS',
  1000,
  1,
  20_000,
);

function logQueryError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`OntoIndex [${context}]: ${msg}`);
}

function execGitCapture(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: repoPath,
        encoding: 'utf-8',
        maxBuffer: GIT_DIFF_MAX_BUFFER,
        timeout: GIT_DIFF_TIMEOUT_MS,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function detectChanges(
  repo: DetectChangesRepoHandle,
  params: {
    scope?: string;
    base_ref?: string;
  },
): Promise<DetectChangesResult> {
  const scope = params.scope || 'unstaged';
  const warnings: string[] = [];

  let diffArgs: string[];
  switch (scope) {
    case 'staged':
      diffArgs = ['diff', '--staged', '-U0'];
      break;
    case 'all':
      diffArgs = ['diff', 'HEAD', '-U0'];
      break;
    case 'compare':
      if (!params.base_ref) return { error: 'base_ref is required for "compare" scope' };
      diffArgs = ['diff', params.base_ref, '-U0'];
      break;
    case 'unstaged':
    default:
      diffArgs = ['diff', '-U0'];
      break;
  }

  let diffOutput: string;
  try {
    diffOutput = await execGitCapture(repo.repoPath, diffArgs);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Git diff failed: ${message}` };
  }

  const fileDiffs: FileDiff[] = parseDiffHunks(diffOutput, {
    maxFiles: MAX_DIFF_FILES + 1,
    maxHunksPerFile: MAX_HUNKS_PER_FILE,
    maxTotalHunks: MAX_TOTAL_HUNKS,
  });
  if (fileDiffs.length > MAX_DIFF_FILES) {
    fileDiffs.length = MAX_DIFF_FILES;
    warnings.push(`Diff file scan capped at ${MAX_DIFF_FILES} files`);
  }

  if (fileDiffs.length === 0) {
    return {
      summary: {
        changed_count: 0,
        affected_count: 0,
        risk_level: 'none',
        message: 'No changes detected.',
      },
      changed_symbols: [],
      affected_processes: [],
      warnings,
    };
  }

  const changedSymbols: ChangedSymbol[] = [];
  for (const fileDiff of fileDiffs) {
    if (changedSymbols.length >= MAX_CHANGED_SYMBOLS) {
      warnings.push(`Changed symbol scan capped at ${MAX_CHANGED_SYMBOLS} symbols`);
      break;
    }
    if (fileDiff.hunks.length === 0) continue;

    const overlapConditions = fileDiff.hunks
      .map((_, i) => `(n.startLine <= $hunkEnd${i} AND n.endLine >= $hunkStart${i})`)
      .join(' OR ');

    const queryParams: Record<string, unknown> = { filePath: fileDiff.filePath };
    fileDiff.hunks.forEach((hunk, i) => {
      queryParams[`hunkStart${i}`] = hunk.startLine;
      queryParams[`hunkEnd${i}`] = hunk.endLine;
    });

    const symbolQuery = `
      MATCH (n) WHERE n.filePath ENDS WITH $filePath
        AND n.startLine IS NOT NULL AND n.endLine IS NOT NULL
        AND (${overlapConditions})
      RETURN n.id AS id, n.name AS name, labels(n)[0] AS type,
             n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
      LIMIT ${Math.max(1, MAX_CHANGED_SYMBOLS - changedSymbols.length)}
    `;

    try {
      const rows = (await executeParameterized(repo.id, symbolQuery, queryParams)) as QueryRow[];
      for (const sym of rows) {
        changedSymbols.push({
          id: rowFallbackValue(sym, 'id', 0),
          name: rowFallbackValue(sym, 'name', 1),
          type: rowFallbackValue(sym, 'type', 2),
          filePath: rowFallbackValue(sym, 'filePath', 3),
          change_type: 'touched',
        });
      }
    } catch (e) {
      logQueryError('detect-changes:file-symbols', e);
    }
  }

  const affectedProcesses = new Map<unknown, AffectedProcess>();
  if (changedSymbols.length > 0) {
    const uniqueSymIds = Array.from(new Set(changedSymbols.map((s) => s.id).filter(Boolean)));
    const symIds = uniqueSymIds.slice(0, MAX_PROCESS_SYMBOL_IDS);
    if (uniqueSymIds.length > symIds.length) {
      warnings.push(`Process impact lookup capped at ${MAX_PROCESS_SYMBOL_IDS} changed symbols`);
    }
    const symNameById = new Map<unknown, unknown>(changedSymbols.map((s) => [s.id, s.name]));
    try {
      const procs = (await executeParameterized(
        repo.id,
        `
        MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
        WHERE n.id IN $ids
        RETURN n.id AS nodeId, p.id AS pid, p.heuristicLabel AS label,
               p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        LIMIT 5000
      `,
        { ids: symIds },
      )) as QueryRow[];
      for (const proc of procs) {
        const nodeId = rowFallbackValue(proc, 'nodeId', 0);
        const pid = rowFallbackValue(proc, 'pid', 1);
        if (!affectedProcesses.has(pid)) {
          affectedProcesses.set(pid, {
            id: pid,
            name: rowFallbackValue(proc, 'label', 2),
            process_type: rowFallbackValue(proc, 'processType', 3),
            step_count: rowFallbackValue(proc, 'stepCount', 4),
            changed_steps: [],
          });
        }
        affectedProcesses.get(pid)!.changed_steps.push({
          symbol: symNameById.get(nodeId) ?? nodeId,
          step: rowFallbackValue(proc, 'step', 5),
        });
      }
    } catch (e) {
      logQueryError('detect-changes:process-lookup', e);
    }
  }

  const processCount = affectedProcesses.size;
  const risk =
    processCount === 0
      ? 'low'
      : processCount <= 5
        ? 'medium'
        : processCount <= 15
          ? 'high'
          : 'critical';

  return {
    summary: {
      changed_count: changedSymbols.length,
      affected_count: processCount,
      changed_files: fileDiffs.length,
      risk_level: risk,
    },
    changed_symbols: changedSymbols,
    affected_processes: Array.from(affectedProcesses.values()),
    warnings,
  };
}
