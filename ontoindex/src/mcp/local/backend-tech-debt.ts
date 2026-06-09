/**
 * Tech Debt Analysis MCP Tool
 *
 * Ranks the riskiest symbols in the codebase by combining static
 * complexity (line count, parameter count, caller count) with git
 * churn (commits touching the file in the window).
 *
 * Composite score:
 *   (lineCount/20) × (callerCount+1) × (parameterCount/3+1) × log2(commits+1)
 *
 * A high score means a symbol is long, widely-depended-on, has many
 * parameters, AND changes often — the classic "dangerous to touch,
 * beneficial to simplify" profile.
 */
import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { commitsByFile } from './backend-git-history.js';
import { normalizeLimit } from './tool-utils.js';
import { AnalysisResult, DiagnosticFinding } from 'ontoindex-shared';

// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly id: string; readonly name: string; readonly repoPath: string };

/**
 * Maps internal TechDebtEntry to normalized DiagnosticFinding (Phase D).
 */
function mapTechDebtToFindings(entries: TechDebtEntry[]): DiagnosticFinding[] {
  return entries.map((e) => {
    return {
      ruleId: 'GNT-101',
      ruleName: 'High Structural Complexity',
      severity: e.lineCount > 500 ? 'critical' : e.lineCount > 200 ? 'warning' : 'advisory',
      confidence: 0.9,
      message: `${e.type} '${e.name}' has high structural complexity (${e.lineCount} lines, ${e.callerCount} callers).`,
      location: {
        filePath: e.filePath,
        startLine: e.startLine,
        endLine: e.endLine,
        symbolName: e.name,
      },
      properties: {
        lines: e.lineCount,
        callers: e.callerCount,
        parameterCount: e.parameterCount,
        symbolType: e.type,
      },
      suggestion:
        'Consider refactoring this symbol into smaller, more modular units to reduce maintenance risk.',
    };
  });
}

interface TechDebtEntry {
  name: string;
  type: string;
  filePath: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  parameterCount: number;
  callerCount: number;
  commits: number;
  score: number;
}

interface TechDebtResult {
  status: 'success' | 'error';
  tool: 'tech_debt';
  repo: string;
  since: string;
  min_lines: number;
  symbol_count: number;
  symbols: TechDebtEntry[];
  error?: string;
  warnings?: string[];
}

type StructuralRowObject = {
  readonly [index: number]: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly filePath?: unknown;
  readonly startLine?: unknown;
  readonly endLine?: unknown;
  readonly parameterCount?: unknown;
};

type StructuralRowTuple = readonly [
  name?: unknown,
  type?: unknown,
  filePath?: unknown,
  startLine?: unknown,
  endLine?: unknown,
  parameterCount?: unknown,
] &
  StructuralRowObject;

type StructuralRow = StructuralRowObject | StructuralRowTuple;
type StructuralRowField = 'name' | 'type' | 'filePath' | 'startLine' | 'endLine' | 'parameterCount';

type MessageBearing = { readonly message?: unknown };

function legacyErrorMessage(err: unknown): string {
  const message =
    err !== null && err !== undefined && (typeof err === 'object' || typeof err === 'function')
      ? (err as MessageBearing).message
      : undefined;
  return `${message ?? String(err)}`;
}

async function loadStructuralSymbols(
  repoId: string,
  minLines: number,
): Promise<
  Array<{
    name: string;
    type: string;
    filePath: string;
    startLine: number;
    endLine: number;
    parameterCount: number;
  }>
> {
  try {
    const rows = await executeParameterized(repoId, buildStructuralSymbolsQuery(true), {
      minLines,
    });
    return normalizeStructuralRows(rows);
  } catch {
    try {
      const rows = await executeParameterized(repoId, buildStructuralSymbolsQuery(false), {
        minLines,
      });
      return normalizeStructuralRows(rows);
    } catch {
      return [];
    }
  }
}

function buildStructuralSymbolsQuery(includeParameterCount: boolean): string {
  const parameterSelect = includeParameterCount ? 'n.parameterCount' : '0';
  return `
        MATCH (n:Function)
        WHERE n.filePath IS NOT NULL
          AND n.startLine IS NOT NULL
          AND n.endLine IS NOT NULL
          AND (n.endLine - n.startLine + 1) >= $minLines
        RETURN n.name AS name, 'Function' AS type, n.filePath AS filePath,
               n.startLine AS startLine, n.endLine AS endLine,
               ${parameterSelect} AS parameterCount
        UNION ALL
        MATCH (n:Method)
        WHERE n.filePath IS NOT NULL
          AND n.startLine IS NOT NULL
          AND n.endLine IS NOT NULL
          AND (n.endLine - n.startLine + 1) >= $minLines
        RETURN n.name AS name, 'Method' AS type, n.filePath AS filePath,
               n.startLine AS startLine, n.endLine AS endLine,
               ${parameterSelect} AS parameterCount
        UNION ALL
        MATCH (n:Constructor)
        WHERE n.filePath IS NOT NULL
          AND n.startLine IS NOT NULL
          AND n.endLine IS NOT NULL
          AND (n.endLine - n.startLine + 1) >= $minLines
        RETURN n.name AS name, 'Constructor' AS type, n.filePath AS filePath,
               n.startLine AS startLine, n.endLine AS endLine,
               ${parameterSelect} AS parameterCount
      `;
}

function structuralField(row: StructuralRow, key: StructuralRowField, index: number): unknown {
  return row[key] ?? row[index];
}

function normalizeStructuralRows(rows: readonly StructuralRow[]): Array<{
  name: string;
  type: string;
  filePath: string;
  startLine: number;
  endLine: number;
  parameterCount: number;
}> {
  const out: Array<{
    name: string;
    type: string;
    filePath: string;
    startLine: number;
    endLine: number;
    parameterCount: number;
  }> = [];
  for (const row of rows || []) {
    const name = structuralField(row, 'name', 0);
    const type = structuralField(row, 'type', 1);
    const filePath = structuralField(row, 'filePath', 2);
    const startLine = Number(structuralField(row, 'startLine', 3));
    const endLine = Number(structuralField(row, 'endLine', 4));
    const paramRaw = structuralField(row, 'parameterCount', 5);
    const parameterCount = typeof paramRaw === 'number' ? paramRaw : Number(paramRaw) || 0;
    if (typeof name !== 'string' || typeof filePath !== 'string') continue;
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
    out.push({ name, type: type as string, filePath, startLine, endLine, parameterCount });
  }
  return out;
}

async function callerCountsByName(repoId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const rows = await executeParameterized(
      repoId,
      `
        MATCH (src)-[r:CodeRelation]->(tgt)
        WHERE r.type = 'CALLS' AND tgt.name IS NOT NULL AND tgt.filePath IS NOT NULL
        RETURN tgt.name AS name, tgt.filePath AS filePath, count(*) AS callerCount
      `,
      {},
    );
    for (const row of rows || []) {
      const name = row.name ?? row[0];
      const filePath = row.filePath ?? row[1];
      const raw = row.callerCount ?? row[2];
      if (typeof name !== 'string' || typeof filePath !== 'string') continue;
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(num)) counts.set(`${filePath}\x00${name}`, num);
    }
  } catch {
    /* DB unreachable — caller count degrades to 0 for all symbols */
  }
  return counts;
}

export async function runTechDebt(
  repo: RepoHandle,
  params: { limit?: number; min_lines?: number; since?: string },
): Promise<AnalysisResult> {
  const start = Date.now();
  const limit = normalizeLimit(params?.limit, 20, 1000);
  const minLines =
    typeof params?.min_lines === 'number' ? Math.max(1, Math.min(params.min_lines, 10000)) : 10;
  const since =
    typeof params?.since === 'string' && params.since.trim().length > 0 ? params.since : '6 months';

  try {
    const [symbols, callerCounts] = await Promise.all([
      loadStructuralSymbols(repo.id, minLines),
      callerCountsByName(repo.id),
    ]);
    const fileCommits = await commitsByFile(repo.repoPath, since);

    const entries: TechDebtEntry[] = symbols.map((sym) => {
      const lineCount = Math.max(1, sym.endLine - sym.startLine + 1);
      const callerCount = callerCounts.get(`${sym.filePath}\x00${sym.name}`) ?? 0;
      const commits = fileCommits.get(sym.filePath) ?? 0;
      const score =
        (lineCount / 20) *
        (callerCount + 1) *
        (sym.parameterCount / 3 + 1) *
        Math.log2(commits + 1 + 1e-9);
      return {
        name: sym.name,
        type: sym.type,
        filePath: sym.filePath,
        startLine: sym.startLine,
        endLine: sym.endLine,
        lineCount,
        parameterCount: sym.parameterCount,
        callerCount,
        commits,
        score: Number(score.toFixed(3)),
      };
    });

    entries.sort((a, b) => b.score - a.score || b.lineCount - a.lineCount);

    const topEntries = entries.slice(0, limit);
    const summary = `Found ${entries.length} complex symbols exceeding ${minLines} lines. Top ${topEntries.length} ranked by tech debt score (complexity x churn x callers).`;

    return {
      status: 'success',
      tool: 'tech_debt',
      repo: repo.name,
      since,
      min_lines: minLines,
      symbol_count: entries.length,
      symbols: topEntries,
      findings: mapTechDebtToFindings(topEntries),
      summary,
      stats: {
        totalFindings: topEntries.length,
        durationMs: Date.now() - start,
        since,
        minLines,
        totalCandidates: entries.length,
      },
    } as AnalysisResult & TechDebtResult;
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'tech_debt',
      repo: repo.name,
      since,
      min_lines: minLines,
      symbol_count: 0,
      symbols: [],
      error: `Tech debt analysis failed: ${legacyErrorMessage(err)}`,
      findings: [],
      summary: '',
      stats: { totalFindings: 0, durationMs: Date.now() - start },
      errors: [`Tech debt analysis failed: ${legacyErrorMessage(err)}`],
    } as AnalysisResult & TechDebtResult;
  }
}
