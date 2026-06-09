/**
 * gn_explain_module — File/module overview super-function.
 *
 * Aggregates per-file information from the graph (exported symbols, cluster
 * membership, co-change partners, file stats) and optionally a text skeleton
 * into a single structured report, so callers never need to issue multiple
 * Cypher queries manually.
 */

import { constants as fsConstants } from 'fs';
import { access, readFile, stat } from 'fs/promises';
import { isAbsolute, relative, resolve } from 'path';
import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { execFileText } from '../../core/process/exec-file.js';
import { getFileSkeleton } from '../../core/search/skeleton.js';
import { listRegisteredRepos } from '../../storage/repo-manager.js';

const PUBLIC_API_LIMIT = 500;
const SOURCE_READ_MAX_BYTES = 1024 * 1024;
const GIT_LOG_TIMEOUT_MS = 5_000;
const GIT_LOG_MAX_BUFFER = 256 * 1024;

type QueryRow = Record<string, unknown> & { [index: number]: unknown };
type QueryNode = Record<string, unknown>;
type PublicApiKind =
  | 'Function'
  | 'Method'
  | 'Constructor'
  | 'Class'
  | 'Interface'
  | 'Struct'
  | 'Enum'
  | 'TypeAlias'
  | 'Typedef'
  | 'Variable'
  | 'Const'
  | 'Property'
  | 'Namespace'
  | 'Macro'
  | 'Template'
  | 'Trait'
  | 'Impl'
  | 'Record'
  | 'Union'
  | 'Static'
  | 'CodeElement'
  | 'Unknown';

const PUBLIC_API_KIND_BY_LOWERCASE = new Map<string, PublicApiKind>([
  ['function', 'Function'],
  ['arrowfunction', 'Function'],
  ['functiondeclaration', 'Function'],
  ['functiondefinition', 'Function'],
  ['method', 'Method'],
  ['methoddeclaration', 'Method'],
  ['methoddefinition', 'Method'],
  ['constructor', 'Constructor'],
  ['class', 'Class'],
  ['classspecifier', 'Class'],
  ['classdeclaration', 'Class'],
  ['classdefinition', 'Class'],
  ['interface', 'Interface'],
  ['struct', 'Struct'],
  ['structspecifier', 'Struct'],
  ['structdeclaration', 'Struct'],
  ['enum', 'Enum'],
  ['enumspecifier', 'Enum'],
  ['enumdeclaration', 'Enum'],
  ['typealias', 'TypeAlias'],
  ['type', 'TypeAlias'],
  ['typedef', 'Typedef'],
  ['variable', 'Variable'],
  ['declaration', 'Variable'],
  ['const', 'Const'],
  ['property', 'Property'],
  ['field', 'Property'],
  ['fielddeclaration', 'Property'],
  ['member', 'Property'],
  ['namespace', 'Namespace'],
  ['namespacedefinition', 'Namespace'],
  ['macro', 'Macro'],
  ['template', 'Template'],
  ['templatedeclaration', 'Template'],
  ['trait', 'Trait'],
  ['impl', 'Impl'],
  ['record', 'Record'],
  ['union', 'Union'],
  ['unionspecifier', 'Union'],
  ['static', 'Static'],
  ['module', 'Namespace'],
  ['package', 'Namespace'],
  ['codeelement', 'CodeElement'],
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExplainModuleParams {
  filePath: string;
  includeSkeleton?: boolean; // default: true
  includePublicAPI?: boolean; // default: true
  includeCoChange?: boolean; // default: true
  recentTouchDays?: number; // default: 30
}

export interface ExplainModuleReport {
  version: 1;
  filePath: string;
  fileSkeleton?: string;
  publicAPI: Array<{
    name: string;
    kind: PublicApiKind;
    signature?: string;
    documentation?: string;
  }>;
  cluster?: { name: string; role: string; fileCount: number };
  coChangedFiles: Array<{ path: string; coChangeCount: number }>;
  recentlyTouched: { lastCommitDate: string; daysAgo: number };
  fileStats: { lineCount: number; symbolCount: number; importCount: number };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isQueryNode(value: unknown): value is QueryNode {
  return typeof value === 'object' && value !== null;
}

function toQueryRow(row: unknown): QueryRow {
  return (isQueryNode(row) ? row : {}) as QueryRow;
}

function rowValue(row: QueryRow, key: string, tupleIndex: number): unknown {
  return row[key] ?? row[tupleIndex];
}

function nodeFromRow(row: unknown, key: string): QueryNode {
  const queryRow = toQueryRow(row);
  const node = rowValue(queryRow, key, 0) ?? queryRow;
  return isQueryNode(node) ? node : {};
}

function reportString(value: unknown, fallback: string): string {
  return (value ?? fallback) as string;
}

function optionalReportString(value: unknown): string | undefined {
  return (value ?? undefined) as string | undefined;
}

function reportNumber(value: unknown): number {
  return value as number;
}

/** Map graph node labels to the union type used in the report. */
function normalizeKind(raw: string | undefined): ExplainModuleReport['publicAPI'][0]['kind'] {
  const normalized = (raw ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return PUBLIC_API_KIND_BY_LOWERCASE.get(normalized) ?? 'Unknown';
}

/**
 * Attempt to extract a leading doc-comment for a symbol given the raw source
 * lines and the 1-based start line.  Looks at up to 3 lines immediately above
 * `startLine` for a `/** ... *\/` block or a `//` comment.
 */
function extractLeadingComment(sourceLines: string[], startLine: number): string | undefined {
  const idx = startLine - 1; // convert to 0-based
  if (idx <= 0) return undefined;

  const candidates: string[] = [];
  for (let i = idx - 1; i >= Math.max(0, idx - 3); i--) {
    const line = sourceLines[i].trim();
    if (line.startsWith('*') || line.startsWith('/**') || line.startsWith('*/')) {
      candidates.unshift(line);
    } else if (line.startsWith('//')) {
      candidates.unshift(line);
    } else if (line === '') {
      // allow one blank separator line
    } else {
      break;
    }
  }

  const comment = candidates
    .join('\n')
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .replace(/^\s*\*\s?/gm, '')
    .trim();

  return comment.length > 0 ? comment : undefined;
}

function resolveSafeSourcePath(filePath: string, repoRoot: string): string | undefined {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
  const relativePath = relative(repoRoot, absolutePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined;
  }
  return absolutePath;
}

async function readSourceLines(
  filePath: string,
  repoRoot: string,
  warnings: string[],
): Promise<string[]> {
  const safePath = resolveSafeSourcePath(filePath, repoRoot);
  if (!safePath) {
    warnings.push('source file outside current repo root — skipped source-derived metadata');
    return [];
  }

  try {
    await access(safePath, fsConstants.R_OK);
    const fileStats = await stat(safePath);
    if (!fileStats.isFile()) {
      warnings.push('source path is not a regular file — skipped source-derived metadata');
      return [];
    }
    if (fileStats.size > SOURCE_READ_MAX_BYTES) {
      warnings.push(
        `source file exceeds ${SOURCE_READ_MAX_BYTES} bytes — skipped source-derived metadata`,
      );
      return [];
    }
    return (await readFile(safePath, 'utf8')).split('\n');
  } catch {
    return [];
  }
}

function graphLineCount(fileNode: QueryNode): number | undefined {
  const raw = fileNode.lineCount ?? fileNode.line_count ?? fileNode.lines;
  return typeof raw === 'number' && raw > 0 ? raw : undefined;
}

function skeletonLineCount(skeleton: string | undefined): number | undefined {
  if (!skeleton) return undefined;

  let maxLine = 0;
  for (const match of skeleton.matchAll(/\blines?\s+(\d+)(?:\s*[-–]\s*(\d+))?/gi)) {
    const endLine = Number(match[2] ?? match[1]);
    if (Number.isFinite(endLine) && endLine > maxLine) {
      maxLine = endLine;
    }
  }

  return maxLine > 0 ? maxLine : undefined;
}

// ---------------------------------------------------------------------------
async function resolveRepoRoot(repoId: string): Promise<string> {
  const repos = await listRegisteredRepos();
  const repo = repos.find((candidate) => candidate.name === repoId || candidate.path === repoId);
  return repo?.path ?? process.cwd();
}

// Main function
// ---------------------------------------------------------------------------

export async function gnExplainModule(
  repoId: string,
  params: ExplainModuleParams,
): Promise<ExplainModuleReport> {
  const warnings: string[] = [];
  const repoRoot = await resolveRepoRoot(repoId);

  // ---- 1. Resolve the File node ------------------------------------------
  const fileRows = await executeParameterized(
    repoId,
    'MATCH (f:File {filePath: $path}) RETURN f LIMIT 1',
    {
      path: params.filePath,
    },
  );

  if (fileRows.length === 0) {
    return {
      version: 1,
      filePath: params.filePath,
      publicAPI: [],
      coChangedFiles: [],
      recentlyTouched: { lastCommitDate: '', daysAgo: -1 },
      fileStats: { lineCount: 0, symbolCount: 0, importCount: 0 },
      warnings: ['file not in index — run ontoindex analyze'],
    };
  }

  const fileNode = nodeFromRow(fileRows[0], 'f');

  // ---- 2. File skeleton --------------------------------------------------
  let fileSkeleton: string | undefined;
  if (params.includeSkeleton !== false) {
    const skeleton = await getFileSkeleton(repoId, params.filePath, 2);
    if (skeleton.trim().length > 0) {
      fileSkeleton = skeleton;
    } else {
      warnings.push('file skeleton unavailable for indexed file');
    }
  }

  const needsSourceLines =
    params.includePublicAPI !== false || graphLineCount(fileNode) === undefined;
  const sourceLines = needsSourceLines
    ? await readSourceLines(params.filePath, repoRoot, warnings)
    : [];

  // ---- 3. Public API (exported symbols) ----------------------------------
  let symbolRows: any[] = [];
  const publicAPI: ExplainModuleReport['publicAPI'] = [];
  if (params.includePublicAPI !== false) {
    symbolRows = await executeParameterized(
      repoId,
      `MATCH (f:File {filePath: $path})-[:CodeRelation {type: 'DEFINES'}]->(s)
       WHERE s.isExported = true
       RETURN s LIMIT ${PUBLIC_API_LIMIT}`,
      { path: params.filePath },
    );
    if (symbolRows.length >= PUBLIC_API_LIMIT) {
      warnings.push(`public API truncated at ${PUBLIC_API_LIMIT} exported symbols`);
    }

    for (const row of symbolRows) {
      const s = nodeFromRow(row, 's');
      const startLine: number | undefined =
        typeof s.startLine === 'number' ? s.startLine : undefined;

      let documentation: string | undefined;
      if (sourceLines.length > 0 && startLine !== undefined) {
        documentation = extractLeadingComment(sourceLines, startLine);
      }

      publicAPI.push({
        name: reportString(s.name ?? s.symbolName, '(unknown)'),
        kind: normalizeKind(optionalReportString(s.kind ?? s.type ?? s.label ?? s._label)),
        signature: optionalReportString(s.signature),
        documentation,
      });
    }
  }

  // ---- 4. Cluster info ---------------------------------------------------
  let cluster: ExplainModuleReport['cluster'] | undefined;
  const clusterRows = await executeParameterized(
    repoId,
    `MATCH (f:File {filePath: $path})-[:CodeRelation {type: 'IN_COMMUNITY'}]->(c:Community)
     RETURN c LIMIT 1`,
    { path: params.filePath },
  );
  if (clusterRows.length > 0) {
    const c = nodeFromRow(clusterRows[0], 'c');
    cluster = {
      name: reportString(c.name ?? c.id, '(unnamed)'),
      role: reportString(c.role, 'unknown'),
      fileCount: typeof c.fileCount === 'number' ? c.fileCount : 0,
    };
  }

  // ---- 5. Co-changed files -----------------------------------------------
  const coChangedFiles: ExplainModuleReport['coChangedFiles'] = [];
  if (params.includeCoChange !== false) {
    const coRows = await executeParameterized(
      repoId,
      `MATCH (f:File {filePath: $path})-[r:CodeRelation {type: 'CO_CHANGED_WITH'}]-(other:File)
       RETURN other.filePath AS path, r.confidence AS coChangeCount
       ORDER BY r.confidence DESC LIMIT 10`,
      { path: params.filePath },
    );
    for (const row of coRows) {
      const queryRow = toQueryRow(row);
      coChangedFiles.push({
        path: reportString(rowValue(queryRow, 'path', 0), ''),
        coChangeCount:
          typeof queryRow.coChangeCount === 'number'
            ? queryRow.coChangeCount
            : reportNumber(queryRow[1] ?? 0),
      });
    }
  }

  // ---- 6. Last-commit date -----------------------------------------------
  let lastCommitDate = '';
  let daysAgo = -1;

  // Try graph property first
  const rawLastModified = fileNode.lastModified ?? fileNode.last_modified;
  if (rawLastModified) {
    lastCommitDate = String(rawLastModified);
  } else {
    // Fallback: git log — use array args (no shell injection) and hard process bounds.
    try {
      const gitOut = (
        await execFileText('git', ['log', '-1', '--format=%aI', '--', params.filePath], {
          cwd: repoRoot,
          timeoutMs: GIT_LOG_TIMEOUT_MS,
          maxBuffer: GIT_LOG_MAX_BUFFER,
        })
      ).trim();
      if (gitOut) {
        lastCommitDate = gitOut;
        warnings.push('lastModified not in graph — used git-log fallback');
      }
    } catch {
      warnings.push('could not determine last-commit date (git log failed)');
    }
  }

  if (lastCommitDate) {
    const parsed = Date.parse(lastCommitDate);
    if (!isNaN(parsed)) {
      daysAgo = Math.floor((Date.now() - parsed) / (24 * 3600 * 1000));
    }
  }

  // ---- 7. File stats -----------------------------------------------------
  let lineCount = graphLineCount(fileNode) ?? sourceLines.length;
  if (lineCount === 0) {
    const skeletonCount = skeletonLineCount(fileSkeleton);
    if (skeletonCount !== undefined) {
      lineCount = skeletonCount;
      warnings.push('lineCount estimated from file skeleton');
    }
  }
  if (lineCount === 0 && publicAPI.length > 0) {
    // Fallback: estimate from max endLine of exported symbols
    const maxEndLine = Math.max(
      ...symbolRows.map((row) => {
        const s = nodeFromRow(row, 's');
        return typeof s.endLine === 'number' ? s.endLine : 0;
      }),
    );
    if (maxEndLine > 0) {
      lineCount = maxEndLine;
      warnings.push('lineCount estimated from exported symbols');
    }
  }

  if (lineCount === 0) {
    warnings.push('lineCount not in graph and source file unavailable — returned 0');
  }

  // symbolCount from DEFINES edges
  const symCountRows = await executeParameterized(
    repoId,
    `MATCH (f:File {filePath: $path})-[:CodeRelation {type: 'DEFINES'}]->(s)
     RETURN COUNT(s) AS cnt`,
    { path: params.filePath },
  );
  const symbolCount: number =
    symCountRows.length > 0 ? Number(rowValue(toQueryRow(symCountRows[0]), 'cnt', 0) ?? 0) : 0;

  // importCount from IMPORTS edges
  const impCountRows = await executeParameterized(
    repoId,
    `MATCH (f:File {filePath: $path})-[:CodeRelation {type: 'IMPORTS'}]->(other)
     RETURN COUNT(other) AS cnt`,
    { path: params.filePath },
  );
  const importCount: number =
    impCountRows.length > 0 ? Number(rowValue(toQueryRow(impCountRows[0]), 'cnt', 0) ?? 0) : 0;

  // ---- Assemble report ---------------------------------------------------
  const report: ExplainModuleReport = {
    version: 1,
    filePath: params.filePath,
    publicAPI,
    coChangedFiles,
    recentlyTouched: { lastCommitDate, daysAgo },
    fileStats: { lineCount, symbolCount, importCount },
    warnings,
  };

  if (fileSkeleton !== undefined) {
    report.fileSkeleton = fileSkeleton;
  }
  if (cluster !== undefined) {
    report.cluster = cluster;
  }

  return report;
}
