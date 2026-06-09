/**
 * Graph Queries for Wiki Generation
 *
 * Encapsulated Cypher queries against the OntoIndex knowledge graph.
 * Uses the MCP-style pooled lbug-adapter for connection management.
 */

import {
  initLbug,
  executeQuery,
  executeParameterized,
  closeLbug,
  touchRepo,
} from '../lbug/pool-adapter.js';
import type { LbugQueryRow } from '../lbug/pool-adapter.js';

const REPO_ID = '__wiki__';
const MAX_WIKI_EXPORT_ROWS = 50_000;
const MAX_WIKI_FILES = 50_000;
const MAX_WIKI_CALL_EDGES = 50_000;
const MAX_WIKI_PROCESS_STEPS = 1_000;

/**
 * Touch the wiki DB connection to prevent idle timeout during long LLM calls.
 */
export function touchWikiDb(): void {
  touchRepo(REPO_ID);
}

export interface FileWithExports {
  filePath: string;
  symbols: Array<{ name: string; type: string }>;
}

interface CallEdge {
  fromFile: string;
  fromName: string;
  toFile: string;
  toName: string;
}

interface ProcessInfo {
  id: string;
  label: string;
  type: string;
  stepCount: number;
  steps: Array<{
    step: number;
    name: string;
    filePath: string;
    type: string;
  }>;
}

type FileExportRow = LbugQueryRow & {
  readonly filePath: string;
  readonly name: string;
  readonly type: string;
  readonly 0?: string;
  readonly 1?: string;
  readonly 2?: string;
};

type FilePathRow = LbugQueryRow & {
  readonly filePath: string;
  readonly 0?: string;
};

type CallEdgeRow = LbugQueryRow & {
  readonly fromFile: string;
  readonly fromName: string;
  readonly toFile: string;
  readonly toName: string;
  readonly 0?: string;
  readonly 1?: string;
  readonly 2?: string;
  readonly 3?: string;
};

type ProcessRow = LbugQueryRow & {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly stepCount: number;
  readonly 0?: string;
  readonly 1?: string;
  readonly 2?: string;
  readonly 3?: number;
};

type ProcessStepRow = LbugQueryRow & {
  readonly name: string;
  readonly filePath: string;
  readonly type: string;
  readonly step: number;
  readonly 0?: string;
  readonly 1?: string;
  readonly 2?: string;
  readonly 3?: number;
};

/**
 * Initialize the LadybugDB connection for wiki generation.
 */
export async function initWikiDb(lbugPath: string): Promise<void> {
  await initLbug(REPO_ID, lbugPath);
}

/**
 * Close the LadybugDB connection.
 */
export async function closeWikiDb(): Promise<void> {
  await closeLbug(REPO_ID);
}

/**
 * Get all source files with their exported symbol names and types.
 */
export async function getFilesWithExports(): Promise<FileWithExports[]> {
  const rows = await executeQuery<FileExportRow>(
    REPO_ID,
    `
    MATCH (f:File)-[:CodeRelation {type: 'DEFINES'}]->(n)
    WHERE n.isExported = true
    RETURN f.filePath AS filePath, n.name AS name, labels(n)[0] AS type
    ORDER BY f.filePath
    LIMIT ${MAX_WIKI_EXPORT_ROWS}
  `,
  );

  const fileMap = new Map<string, FileWithExports>();
  for (const row of rows) {
    const fp = row.filePath || row[0];
    const name = row.name || row[1];
    const type = row.type || row[2];

    let entry = fileMap.get(fp);
    if (!entry) {
      entry = { filePath: fp, symbols: [] };
      fileMap.set(fp, entry);
    }
    entry.symbols.push({ name, type });
  }

  return Array.from(fileMap.values());
}

/**
 * Get all files tracked in the graph (including those with no exports).
 */
export async function getAllFiles(): Promise<string[]> {
  const rows = await executeQuery<FilePathRow>(
    REPO_ID,
    `
    MATCH (f:File)
    RETURN f.filePath AS filePath
    ORDER BY f.filePath
    LIMIT ${MAX_WIKI_FILES}
  `,
  );
  return rows.map((r) => r.filePath || r[0]);
}

/**
 * Get inter-file call edges (calls between different files).
 */
export async function getInterFileCallEdges(): Promise<CallEdge[]> {
  const rows = await executeQuery<CallEdgeRow>(
    REPO_ID,
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath <> b.filePath
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    LIMIT ${MAX_WIKI_CALL_EDGES}
  `,
  );

  return rows.map((r) => ({
    fromFile: r.fromFile || r[0],
    fromName: r.fromName || r[1],
    toFile: r.toFile || r[2],
    toName: r.toName || r[3],
  }));
}

/**
 * Get call edges between files within a specific set (intra-module).
 */
export async function getIntraModuleCallEdges(filePaths: string[]): Promise<CallEdge[]> {
  if (filePaths.length === 0) return [];

  const rows = await executeParameterized<CallEdgeRow>(
    REPO_ID,
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath IN $files AND b.filePath IN $files
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    LIMIT ${MAX_WIKI_CALL_EDGES}
  `,
    { files: filePaths },
  );

  return rows.map((r) => ({
    fromFile: r.fromFile || r[0],
    fromName: r.fromName || r[1],
    toFile: r.toFile || r[2],
    toName: r.toName || r[3],
  }));
}

/**
 * Get call edges crossing module boundaries (external calls from/to module files).
 */
export async function getInterModuleCallEdges(filePaths: string[]): Promise<{
  outgoing: CallEdge[];
  incoming: CallEdge[];
}> {
  if (filePaths.length === 0) return { outgoing: [], incoming: [] };

  const outRows = await executeParameterized<CallEdgeRow>(
    REPO_ID,
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath IN $files AND NOT b.filePath IN $files
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    LIMIT 30
  `,
    { files: filePaths },
  );

  const inRows = await executeParameterized<CallEdgeRow>(
    REPO_ID,
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE NOT a.filePath IN $files AND b.filePath IN $files
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    LIMIT 30
  `,
    { files: filePaths },
  );

  return {
    outgoing: outRows.map((r) => ({
      fromFile: r.fromFile || r[0],
      fromName: r.fromName || r[1],
      toFile: r.toFile || r[2],
      toName: r.toName || r[3],
    })),
    incoming: inRows.map((r) => ({
      fromFile: r.fromFile || r[0],
      fromName: r.fromName || r[1],
      toFile: r.toFile || r[2],
      toName: r.toName || r[3],
    })),
  };
}

/**
 * Get processes (execution flows) that pass through a set of files.
 * Returns top N by step count.
 */
export async function getProcessesForFiles(filePaths: string[], limit = 5): Promise<ProcessInfo[]> {
  if (filePaths.length === 0) return [];

  // Find processes that have steps in the given files
  const procRows = await executeParameterized<ProcessRow>(
    REPO_ID,
    `
    MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
    WHERE s.filePath IN $files
    RETURN DISTINCT p.id AS id, p.heuristicLabel AS label,
           p.processType AS type, p.stepCount AS stepCount
    ORDER BY stepCount DESC
    LIMIT ${limit}
  `,
    { files: filePaths },
  );

  const processes: ProcessInfo[] = [];
  for (const row of procRows) {
    const procId = row.id || row[0];
    const label = row.label || row[1] || procId;
    const type = row.type || row[2] || 'unknown';
    const stepCount = row.stepCount || row[3] || 0;

    // Get the full step trace for this process
    const stepRows = await executeQuery<ProcessStepRow>(
      REPO_ID,
      `
      MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${procId.replace(/'/g, "''")}'})
      RETURN s.name AS name, s.filePath AS filePath, labels(s)[0] AS type, r.step AS step
      ORDER BY r.step
      LIMIT ${MAX_WIKI_PROCESS_STEPS}
    `,
    );

    processes.push({
      id: procId,
      label,
      type,
      stepCount,
      steps: stepRows.map((s) => ({
        step: s.step || s[3] || 0,
        name: s.name || s[0],
        filePath: s.filePath || s[1],
        type: s.type || s[2],
      })),
    });
  }

  return processes;
}

/**
 * Get all processes in the graph (for overview page).
 */
export async function getAllProcesses(limit = 20): Promise<ProcessInfo[]> {
  const procRows = await executeQuery<ProcessRow>(
    REPO_ID,
    `
    MATCH (p:Process)
    RETURN p.id AS id, p.heuristicLabel AS label,
           p.processType AS type, p.stepCount AS stepCount
    ORDER BY stepCount DESC
    LIMIT ${limit}
  `,
  );

  const processes: ProcessInfo[] = [];
  for (const row of procRows) {
    const procId = row.id || row[0];
    const label = row.label || row[1] || procId;
    const type = row.type || row[2] || 'unknown';
    const stepCount = row.stepCount || row[3] || 0;

    const stepRows = await executeQuery<ProcessStepRow>(
      REPO_ID,
      `
      MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${procId.replace(/'/g, "''")}'})
      RETURN s.name AS name, s.filePath AS filePath, labels(s)[0] AS type, r.step AS step
      ORDER BY r.step
      LIMIT ${MAX_WIKI_PROCESS_STEPS}
    `,
    );

    processes.push({
      id: procId,
      label,
      type,
      stepCount,
      steps: stepRows.map((s) => ({
        step: s.step || s[3] || 0,
        name: s.name || s[0],
        filePath: s.filePath || s[1],
        type: s.type || s[2],
      })),
    });
  }

  return processes;
}

/**
 * Get inter-module edges for overview architecture diagram.
 * Groups call edges by source/target module.
 */
export async function getInterModuleEdgesForOverview(
  moduleFiles: Record<string, string[]>,
): Promise<Array<{ from: string; to: string; count: number }>> {
  // Build file-to-module lookup
  const fileToModule = new Map<string, string>();
  for (const [mod, files] of Object.entries(moduleFiles)) {
    for (const f of files) {
      fileToModule.set(f, mod);
    }
  }

  const allEdges = await getInterFileCallEdges();
  const moduleEdgeCounts = new Map<string, number>();

  for (const edge of allEdges) {
    const fromMod = fileToModule.get(edge.fromFile);
    const toMod = fileToModule.get(edge.toFile);
    if (fromMod && toMod && fromMod !== toMod) {
      const key = `${fromMod}|||${toMod}`;
      moduleEdgeCounts.set(key, (moduleEdgeCounts.get(key) || 0) + 1);
    }
  }

  return Array.from(moduleEdgeCounts.entries())
    .map(([key, count]) => {
      const [from, to] = key.split('|||');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);
}
