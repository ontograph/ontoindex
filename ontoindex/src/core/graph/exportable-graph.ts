import type { GraphNode, GraphRelationship } from 'ontoindex-shared';
import { NODE_TABLES } from 'ontoindex-shared';
import type { LbugProjectionRow } from '../lbug/lbug-adapter.js';

export const SUMMARY_NODE_TABLES = ['Folder', 'File', 'Community', 'Process', 'Module'] as const;
export const SUMMARY_REL_TYPES = ['CONTAINS', 'IMPORTS'] as const;

export type GraphNodeRow = LbugProjectionRow & {
  id?: GraphNode['id'];
  name?: GraphNode['properties']['name'];
  label?: GraphNode['properties']['name'];
  filePath?: GraphNode['properties']['filePath'];
  startLine?: GraphNode['properties']['startLine'];
  endLine?: GraphNode['properties']['endLine'];
  content?: string;
  responseKeys?: unknown;
  errorKeys?: unknown;
  middleware?: unknown;
  heuristicLabel?: GraphNode['properties']['heuristicLabel'];
  cohesion?: GraphNode['properties']['cohesion'];
  symbolCount?: GraphNode['properties']['symbolCount'];
  description?: GraphNode['properties']['description'];
  processType?: GraphNode['properties']['processType'];
  stepCount?: GraphNode['properties']['stepCount'];
  communities?: GraphNode['properties']['communities'];
  entryPointId?: GraphNode['properties']['entryPointId'];
  terminalId?: GraphNode['properties']['terminalId'];
};

export type GraphRelationshipRow = LbugProjectionRow & {
  sourceId?: GraphRelationship['sourceId'];
  targetId?: GraphRelationship['targetId'];
  type?: GraphRelationship['type'];
  confidence?: GraphRelationship['confidence'];
  reason?: GraphRelationship['reason'];
  step?: GraphRelationship['step'];
};

type GraphCountRow = LbugProjectionRow & {
  count?: number | bigint | string | null;
  COUNT?: number | bigint | string | null;
  'count(n)'?: number | bigint | string | null;
};

export const GRAPH_RELATIONSHIP_QUERY =
  `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, ` +
  `r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`;

export function isIgnorableGraphQueryError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('does not exist') ||
    message.includes('not found') ||
    message.includes('No table named')
  );
}

export function quoteNodeTable(table: string): string {
  return `\`${table.replace(/`/g, '``')}\``;
}

export function getExportableGraphNodeQuery(table: string, includeContent: boolean): string {
  const tableLabel = quoteNodeTable(table);

  if (table === 'File') {
    return includeContent
      ? `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`
      : `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
  }
  if (table === 'Folder') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
  }
  if (table === 'Community') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
  }
  if (table === 'Process') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
  }
  if (table === 'Route') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.responseKeys AS responseKeys, n.errorKeys AS errorKeys, n.middleware AS middleware`;
  }
  if (table === 'Tool') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.description AS description`;
  }
  return includeContent
    ? `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`
    : `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;
}

export function mapExportableGraphNodeRow(
  table: string,
  row: GraphNodeRow,
  includeContent: boolean,
): GraphNode {
  return {
    id: (row.id ?? row[0]) as GraphNode['id'],
    label: table as GraphNode['label'],
    properties: {
      name: row.name ?? row.label ?? row[1],
      filePath: row.filePath ?? row[2],
      startLine: row.startLine,
      endLine: row.endLine,
      content: includeContent ? row.content : undefined,
      responseKeys: row.responseKeys,
      errorKeys: row.errorKeys,
      middleware: row.middleware,
      heuristicLabel: row.heuristicLabel,
      cohesion: row.cohesion,
      symbolCount: row.symbolCount,
      description: row.description,
      processType: row.processType,
      stepCount: row.stepCount,
      communities: row.communities,
      entryPointId: row.entryPointId,
      terminalId: row.terminalId,
    } as GraphNode['properties'],
  };
}

export function mapExportableGraphRelationshipRow(row: GraphRelationshipRow): GraphRelationship {
  return {
    id: `${row.sourceId}_${row.type}_${row.targetId}`,
    type: row.type as GraphRelationship['type'],
    sourceId: row.sourceId as GraphRelationship['sourceId'],
    targetId: row.targetId as GraphRelationship['targetId'],
    confidence: row.confidence as GraphRelationship['confidence'],
    reason: row.reason as GraphRelationship['reason'],
    step: row.step,
  };
}

export function getExportableGraphRelationshipQuery(summary: boolean): string {
  if (!summary) return GRAPH_RELATIONSHIP_QUERY;
  const summaryLabelList = SUMMARY_NODE_TABLES.map((t) => `'${t}'`).join(', ');
  return `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type IN [${SUMMARY_REL_TYPES.map((t) => `'${t}'`).join(', ')}] AND a.label IN [${summaryLabelList}] AND b.label IN [${summaryLabelList}] RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`;
}

function rowCountValue(row: GraphCountRow | undefined): number {
  const raw = row?.count ?? row?.COUNT ?? row?.['count(n)'] ?? row?.[0] ?? 0;
  if (typeof raw === 'bigint') return Number(raw);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function buildExportableGraph(
  runQuery: <TRow extends LbugProjectionRow = LbugProjectionRow>(query: string) => Promise<TRow[]>,
  options: { includeContent?: boolean; summary?: boolean } = {},
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> {
  const includeContent = options.includeContent === true;
  const summary = options.summary === true;
  const nodes: GraphNode[] = [];
  const allowedTables = summary ? SUMMARY_NODE_TABLES : NODE_TABLES;

  for (const table of allowedTables) {
    try {
      const rows = await runQuery<GraphNodeRow>(getExportableGraphNodeQuery(table, includeContent));
      for (const row of rows) {
        nodes.push(mapExportableGraphNodeRow(table, row, includeContent));
      }
    } catch (err) {
      if (!isIgnorableGraphQueryError(err)) throw err;
    }
  }

  const relationships: GraphRelationship[] = [];
  const relRows = await runQuery<GraphRelationshipRow>(getExportableGraphRelationshipQuery(summary));
  for (const row of relRows) {
    relationships.push(mapExportableGraphRelationshipRow(row));
  }

  return { nodes, relationships };
}

export async function estimateExportableGraphRecordCount(
  runQuery: <TRow extends LbugProjectionRow = LbugProjectionRow>(query: string) => Promise<TRow[]>,
  summary = false,
): Promise<number> {
  const allowedTables = summary ? SUMMARY_NODE_TABLES : NODE_TABLES;
  let total = 0;
  for (const table of allowedTables) {
    try {
      const rows = await runQuery<GraphCountRow>(
        `MATCH (n:${quoteNodeTable(table)}) RETURN count(n) AS count`,
      );
      total += rowCountValue(rows[0]);
    } catch (err) {
      if (!isIgnorableGraphQueryError(err)) throw err;
    }
  }

  const relQuery = summary
    ? `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type IN [${SUMMARY_REL_TYPES.map((t) => `'${t}'`).join(', ')}] AND a.label IN [${SUMMARY_NODE_TABLES.map((t) => `'${t}'`).join(', ')}] AND b.label IN [${SUMMARY_NODE_TABLES.map((t) => `'${t}'`).join(', ')}] RETURN count(r) AS count`
    : `MATCH ()-[r:CodeRelation]->() RETURN count(r) AS count`;
  const relRows = await runQuery<GraphCountRow>(relQuery);
  total += rowCountValue(relRows[0]);
  return total;
}
