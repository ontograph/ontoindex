import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { validLabel } from './types';
import type { GraphRAGBackend } from './types';

export const createExploreTool = (backend: GraphRAGBackend) => {
  const { executeQuery } = backend;

  return tool(
    async ({
      target,
      type,
    }: {
      target: string;
      type?: 'symbol' | 'cluster' | 'process' | null;
    }) => {
      const safeTarget = target.replace(/'/g, "''");
      let resolvedType = type ?? null;
      let processRow: any | null = null;
      let communityRow: any | null = null;
      let symbolRow: any | null = null;

      const getRowValue = (row: any, idx: number, key: string) =>
        Array.isArray(row) ? row[idx] : row[key];

      if (!resolvedType || resolvedType === 'process') {
        const processQuery = `
          MATCH (p:Process)
          WHERE p.id = '${safeTarget}' OR p.label = '${safeTarget}'
          RETURN p.id AS id, p.label AS label, p.processType AS type, p.stepCount AS stepCount
          LIMIT 1
        `;
        const processRes = await executeQuery(processQuery);
        if (processRes.length > 0) {
          processRow = processRes[0];
          resolvedType = 'process';
        }
      }

      if (!resolvedType || resolvedType === 'cluster') {
        const communityQuery = `
          MATCH (c:Community)
          WHERE c.id = '${safeTarget}' OR c.label = '${safeTarget}' OR c.heuristicLabel = '${safeTarget}'
          RETURN c.id AS id, c.label AS label, c.cohesion AS cohesion, c.symbolCount AS symbolCount, c.description AS description
          LIMIT 1
        `;
        const communityRes = await executeQuery(communityQuery);
        if (communityRes.length > 0) {
          communityRow = communityRes[0];
          resolvedType = 'cluster';
        }
      }

      if (!resolvedType || resolvedType === 'symbol') {
        const symbolQuery = `
          MATCH (n)
          WHERE n.name = '${safeTarget}' OR n.id = '${safeTarget}' OR n.filePath = '${safeTarget}'
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath, label(n) AS nodeType
          LIMIT 5
        `;
        const symbolRes = await executeQuery(symbolQuery);
        if (symbolRes.length > 0) {
          symbolRow = symbolRes[0];
          resolvedType = 'symbol';
        }
      }

      if (!resolvedType) {
        return `Could not find "${target}" as a symbol, cluster, or process. Try search first.`;
      }

      if (resolvedType === 'process') {
        const pid = getRowValue(processRow, 0, 'id');
        const label = getRowValue(processRow, 1, 'label');
        const ptype = getRowValue(processRow, 2, 'type');
        const stepCount = getRowValue(processRow, 3, 'stepCount');

        const stepsQuery = `
          MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${pid.replace(/'/g, "''")}'})
          RETURN s.name AS name, s.filePath AS filePath, r.step AS step
          ORDER BY r.step
        `;
        const clustersQuery = `
          MATCH (c:Community)<-[:CodeRelation {type: 'MEMBER_OF'}]-(s)
          MATCH (s)-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${pid.replace(/'/g, "''")}'})
          RETURN DISTINCT c.id AS id, c.label AS label, c.description AS description
          ORDER BY c.label
          LIMIT 20
        `;

        const [steps, clusters] = await Promise.all([
          executeQuery(stepsQuery),
          executeQuery(clustersQuery),
        ]);

        const stepLines = steps.map((row: any) => {
          const name = getRowValue(row, 0, 'name');
          const filePath = getRowValue(row, 1, 'filePath');
          const step = getRowValue(row, 2, 'step');
          return `- ${step}. ${name} (${filePath || 'n/a'})`;
        });

        const clusterLines = clusters.map((row: any) => {
          const clabel = getRowValue(row, 1, 'label');
          const desc = getRowValue(row, 2, 'description');
          return `- ${clabel}${desc ? ` — ${desc}` : ''}`;
        });

        return [
          `PROCESS: ${label}`,
          `Type: ${ptype || 'n/a'}`,
          `Steps: ${stepCount ?? steps.length}`,
          ``,
          `STEPS:`,
          ...(stepLines.length > 0 ? stepLines : ['- None found']),
          ``,
          `CLUSTERS TOUCHED:`,
          ...(clusterLines.length > 0 ? clusterLines : ['- None found']),
        ].join('\n');
      }

      if (resolvedType === 'cluster') {
        const cid = getRowValue(communityRow, 0, 'id');
        const label = getRowValue(communityRow, 1, 'label');
        const cohesion = getRowValue(communityRow, 2, 'cohesion');
        const symbolCount = getRowValue(communityRow, 3, 'symbolCount');
        const description = getRowValue(communityRow, 4, 'description');

        const membersQuery = `
          MATCH (c:Community {id: '${cid.replace(/'/g, "''")}'})<-[:CodeRelation {type: 'MEMBER_OF'}]-(m)
          RETURN m.name AS name, m.filePath AS filePath, label(m) AS nodeType
          LIMIT 50
        `;
        const processesQuery = `
          MATCH (c:Community {id: '${cid.replace(/'/g, "''")}'})<-[:CodeRelation {type: 'MEMBER_OF'}]-(s)
          MATCH (s)-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN DISTINCT p.id AS id, p.label AS label, p.stepCount AS stepCount
          ORDER BY p.stepCount DESC
          LIMIT 20
        `;

        const [members, processes] = await Promise.all([
          executeQuery(membersQuery),
          executeQuery(processesQuery),
        ]);

        const memberLines = members.map((row: any) => {
          const name = getRowValue(row, 0, 'name');
          const filePath = getRowValue(row, 1, 'filePath');
          const nodeType = getRowValue(row, 2, 'nodeType');
          return `- ${nodeType}: ${name} (${filePath || 'n/a'})`;
        });

        const processLines = processes.map((row: any) => {
          const plabel = getRowValue(row, 1, 'label');
          const steps = getRowValue(row, 2, 'stepCount');
          return `- ${plabel} (${steps} steps)`;
        });

        return [
          `CLUSTER: ${label}`,
          `Symbols: ${symbolCount ?? members.length}`,
          `Cohesion: ${cohesion !== null && cohesion !== undefined ? Number(cohesion).toFixed(2) : 'n/a'}`,
          `Description: ${description || 'n/a'}`,
          ``,
          `TOP MEMBERS:`,
          ...(memberLines.length > 0 ? memberLines : ['- None found']),
          ``,
          `PROCESSES TOUCHING THIS CLUSTER:`,
          ...(processLines.length > 0 ? processLines : ['- None found']),
        ].join('\n');
      }

      if (resolvedType === 'symbol') {
        const nodeId = getRowValue(symbolRow, 0, 'id');
        const name = getRowValue(symbolRow, 1, 'name');
        const filePath = getRowValue(symbolRow, 2, 'filePath');
        const nodeType = getRowValue(symbolRow, 3, 'nodeType');

        if (!validLabel(nodeType)) {
          return `Unknown node type "${nodeType}" for symbol "${target}".`;
        }

        const clusterQuery = `
          MATCH (n:${nodeType} {id: '${String(nodeId).replace(/'/g, "''")}'})
          MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          RETURN c.label AS label, c.description AS description
          LIMIT 1
        `;
        const processQuery = `
          MATCH (n:${nodeType} {id: '${String(nodeId).replace(/'/g, "''")}'})
          MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.label AS label, r.step AS step, p.stepCount AS stepCount
          ORDER BY r.step
        `;
        const connectionsQuery = `
          MATCH (n:${nodeType} {id: '${String(nodeId).replace(/'/g, "''")}'})
          OPTIONAL MATCH (n)-[r1:CodeRelation]->(dst)
          OPTIONAL MATCH (src)-[r2:CodeRelation]->(n)
          RETURN
            collect(DISTINCT {name: dst.name, type: r1.type, confidence: r1.confidence}) AS outgoing,
            collect(DISTINCT {name: src.name, type: r2.type, confidence: r2.confidence}) AS incoming
          LIMIT 1
        `;

        const [clusterRes, processRes, connRes] = await Promise.all([
          executeQuery(clusterQuery),
          executeQuery(processQuery),
          executeQuery(connectionsQuery),
        ]);

        const clusterLabel =
          clusterRes.length > 0 ? getRowValue(clusterRes[0], 0, 'label') : 'Unclustered';
        const clusterDesc =
          clusterRes.length > 0 ? getRowValue(clusterRes[0], 1, 'description') : '';

        const processLines = processRes.map((row: any) => {
          const plabel = getRowValue(row, 0, 'label');
          const step = getRowValue(row, 1, 'step');
          const stepCount = getRowValue(row, 2, 'stepCount');
          return `- ${plabel} (step ${step}/${stepCount ?? '?'})`;
        });

        let connections = 'None';
        if (connRes.length > 0) {
          const row = connRes[0];
          const rawOutgoing = Array.isArray(row) ? row[0] : row.outgoing || [];
          const rawIncoming = Array.isArray(row) ? row[1] : row.incoming || [];
          const outgoing = (rawOutgoing || []).filter((c: any) => c && c.name).slice(0, 5);
          const incoming = (rawIncoming || []).filter((c: any) => c && c.name).slice(0, 5);

          const fmt = (c: any, dir: 'out' | 'in') => {
            const conf = c.confidence ? Math.round(c.confidence * 100) : 100;
            return dir === 'out'
              ? `-[${c.type} ${conf}%]-> ${c.name}`
              : `<-[${c.type} ${conf}%]- ${c.name}`;
          };
          const outList = outgoing.map((c: any) => fmt(c, 'out'));
          const inList = incoming.map((c: any) => fmt(c, 'in'));
          if (outList.length || inList.length) {
            connections = [...outList, ...inList].join(', ');
          }
        }

        return [
          `SYMBOL: ${nodeType} ${name}`,
          `ID: ${nodeId}`,
          `File: ${filePath || 'n/a'}`,
          `Cluster: ${clusterLabel}${clusterDesc ? ` — ${clusterDesc}` : ''}`,
          ``,
          `PROCESSES:`,
          ...(processLines.length > 0 ? processLines : ['- None found']),
          ``,
          `CONNECTIONS:`,
          connections,
        ].join('\n');
      }

      return `Unable to explore "${target}".`;
    },
    {
      name: 'explore',
      description:
        'Deep dive on a symbol, cluster, or process. Shows membership, participation, and connections.',
      schema: z.object({
        target: z.string().describe('Name or ID of a symbol, cluster, or process'),
        type: z
          .enum(['symbol', 'cluster', 'process'])
          .optional()
          .nullable()
          .describe('Optional target type (auto-detected if omitted)'),
      }),
    },
  );
};
