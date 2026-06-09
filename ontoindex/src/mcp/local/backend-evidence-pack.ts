/**
 * Evidence Pack MCP Tool
 *
 * Resolves a heterogeneous list of "targets" — symbol names, file
 * paths, or `path:line` references — to concrete code evidence
 * (location + snippet + context lines). This is the tool an audit
 * author calls to pin a finding to a precise location in the tree.
 *
 * Targets are resolved in priority order:
 *   1. `path:line` (if the suffix after the final colon parses as an
 *      integer and the prefix points at an existing repo file).
 *   2. file path (if the target resolves to a regular file).
 *   3. symbol name (LadybugDB lookup by exact name, most recently
 *      indexed filePath wins).
 *
 * All filesystem reads are scoped to the indexed repo root; a target
 * that tries to climb outside the root is reported as unresolved.
 */
import fs from 'fs/promises';
import path from 'path';
import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { resolveContainedRepoPath } from './backend-repo-paths.js';
// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly id: string; readonly name: string; readonly repoPath: string };

interface EvidenceEntry {
  target: string;
  kind: 'line' | 'file' | 'symbol';
  file: string;
  start_line?: number;
  end_line?: number;
  snippet?: string;
  symbol_name?: string;
  symbol_type?: string;
}

interface EvidencePackResult {
  status: 'success' | 'error';
  tool: 'evidence_pack';
  repo: string;
  target_count: number;
  resolved_count: number;
  unresolved_count: number;
  evidence: EvidenceEntry[];
  unresolved: Array<{ target: string; reason: string }>;
  error?: string;
}

type SymbolLookupRow = {
  readonly name?: string;
  readonly type?: string;
  readonly filePath?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly [index: number]: unknown;
};

type SymbolLookupField = 'name' | 'type' | 'filePath' | 'startLine' | 'endLine';

function symbolRowValue<K extends SymbolLookupField>(
  row: SymbolLookupRow,
  key: K,
  index: number,
): SymbolLookupRow[K] {
  return (row[key] ?? row[index]) as SymbolLookupRow[K];
}

function evidencePackFailureDetail(err: unknown): string {
  return (err as { readonly message?: string } | null | undefined)?.message ?? String(err);
}

async function readIfFile(abs: string): Promise<string | null> {
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
    return await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

function sliceSnippet(
  lines: string[],
  startLine: number,
  endLine: number,
  contextLines: number,
): { snippet: string; firstLine: number; lastLine: number } {
  const first = Math.max(1, startLine - contextLines);
  const last = Math.min(lines.length, endLine + contextLines);
  const body = lines.slice(first - 1, last).join('\n');
  return { snippet: body, firstLine: first, lastLine: last };
}

function parseLineSuffix(target: string): { path: string; line: number } | null {
  const colonIdx = target.lastIndexOf(':');
  if (colonIdx <= 0 || colonIdx === target.length - 1) return null;
  const suffix = target.slice(colonIdx + 1);
  if (!/^\d+$/.test(suffix)) return null;
  const lineNum = Number.parseInt(suffix, 10);
  if (lineNum <= 0) return null;
  return { path: target.slice(0, colonIdx), line: lineNum };
}

async function resolveLine(
  repo: RepoHandle,
  target: string,
  contextLines: number,
  includeSnippet: boolean,
): Promise<EvidenceEntry | null> {
  const parsed = parseLineSuffix(target);
  if (!parsed) return null;
  const abs = resolveContainedRepoPath(repo.repoPath, parsed.path);
  if (!abs) return null;
  const content = await readIfFile(abs);
  if (content === null) return null;
  const lines = content.split('\n');
  if (parsed.line > lines.length) return null;

  const rel = path.relative(repo.repoPath, abs);
  const entry: EvidenceEntry = {
    target,
    kind: 'line',
    file: rel,
    start_line: parsed.line,
    end_line: parsed.line,
  };
  if (includeSnippet) {
    const { snippet, firstLine, lastLine } = sliceSnippet(
      lines,
      parsed.line,
      parsed.line,
      contextLines,
    );
    entry.snippet = snippet;
    entry.start_line = firstLine;
    entry.end_line = lastLine;
  }
  return entry;
}

async function resolveFile(
  repo: RepoHandle,
  target: string,
  contextLines: number,
  includeSnippet: boolean,
): Promise<EvidenceEntry | null> {
  const abs = resolveContainedRepoPath(repo.repoPath, target);
  if (!abs) return null;
  const content = await readIfFile(abs);
  if (content === null) return null;
  const lines = content.split('\n');
  const rel = path.relative(repo.repoPath, abs);

  const entry: EvidenceEntry = {
    target,
    kind: 'file',
    file: rel,
    start_line: 1,
    end_line: lines.length,
  };
  if (includeSnippet) {
    // For files we surface a leading window sized like the context
    // budget so the caller sees the head without dragging the entire
    // body through the response.
    const windowSize = Math.max(contextLines * 2, 20);
    entry.snippet = lines.slice(0, windowSize).join('\n');
    entry.end_line = Math.min(lines.length, windowSize);
  }
  return entry;
}

async function resolveSymbol(
  repo: RepoHandle,
  target: string,
  contextLines: number,
  includeSnippet: boolean,
): Promise<EvidenceEntry | null> {
  let rows: SymbolLookupRow[];
  try {
    rows = (await executeParameterized(
      repo.id,
      `
        MATCH (n)
        WHERE n.name = $name
        RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath,
               n.startLine AS startLine, n.endLine AS endLine
        LIMIT 1
      `,
      { name: target },
    )) as SymbolLookupRow[];
  } catch {
    return null;
  }
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  const filePath = symbolRowValue(row, 'filePath', 2);
  const startLine = symbolRowValue(row, 'startLine', 3);
  const endLine = symbolRowValue(row, 'endLine', 4);
  const symbolType = symbolRowValue(row, 'type', 1);
  if (!filePath || typeof startLine !== 'number' || typeof endLine !== 'number') {
    return null;
  }

  const abs = resolveContainedRepoPath(repo.repoPath, filePath);
  if (!abs) {
    return {
      target,
      kind: 'symbol',
      file: filePath,
      start_line: startLine,
      end_line: endLine,
      symbol_name: target,
      symbol_type: symbolType,
    };
  }
  const content = await readIfFile(abs);
  const rel = path.relative(repo.repoPath, abs);
  const entry: EvidenceEntry = {
    target,
    kind: 'symbol',
    file: rel,
    start_line: startLine,
    end_line: endLine,
    symbol_name: target,
    symbol_type: symbolType,
  };
  if (includeSnippet && content !== null) {
    const lines = content.split('\n');
    const { snippet, firstLine, lastLine } = sliceSnippet(lines, startLine, endLine, contextLines);
    entry.snippet = snippet;
    entry.start_line = firstLine;
    entry.end_line = lastLine;
  }
  return entry;
}

export async function runEvidencePack(
  repo: RepoHandle,
  params: { targets?: string[]; include_snippet?: boolean; context_lines?: number },
): Promise<EvidencePackResult> {
  try {
    const rawTargets = Array.isArray(params?.targets) ? params!.targets : [];
    const targets = rawTargets
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const includeSnippet = params?.include_snippet !== false;
    const ctxRaw = typeof params?.context_lines === 'number' ? params!.context_lines : 3;
    const contextLines = Math.max(0, Math.min(ctxRaw, 200));

    const evidence: EvidenceEntry[] = [];
    const unresolved: Array<{ target: string; reason: string }> = [];

    for (const target of targets) {
      const lineHit = await resolveLine(repo, target, contextLines, includeSnippet);
      if (lineHit) {
        evidence.push(lineHit);
        continue;
      }
      const fileHit = await resolveFile(repo, target, contextLines, includeSnippet);
      if (fileHit) {
        evidence.push(fileHit);
        continue;
      }
      const symbolHit = await resolveSymbol(repo, target, contextLines, includeSnippet);
      if (symbolHit) {
        evidence.push(symbolHit);
        continue;
      }
      unresolved.push({
        target,
        reason: 'No matching line, file, or symbol found in this repo.',
      });
    }

    return {
      status: 'success',
      tool: 'evidence_pack',
      repo: repo.name,
      target_count: targets.length,
      resolved_count: evidence.length,
      unresolved_count: unresolved.length,
      evidence,
      unresolved,
    };
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'evidence_pack',
      repo: repo.name,
      target_count: 0,
      resolved_count: 0,
      unresolved_count: 0,
      evidence: [],
      unresolved: [],
      error: `Evidence pack failed: ${evidencePackFailureDetail(err)}`,
    };
  }
}
