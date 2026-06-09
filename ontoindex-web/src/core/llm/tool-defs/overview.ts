import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GraphRAGBackend } from './types';

export const createOverviewTool = (backend: GraphRAGBackend) => {
  const { executeQuery } = backend;

  return tool(
    async () => {
      try {
        const clustersQuery = `
          MATCH (c:Community)
          RETURN c.id AS id, c.label AS label, c.cohesion AS cohesion, c.symbolCount AS symbolCount, c.description AS description
          ORDER BY c.symbolCount DESC
          LIMIT 200
        `;
        const processesQuery = `
          MATCH (p:Process)
          RETURN p.id AS id, p.label AS label, p.processType AS type, p.stepCount AS stepCount, p.communities AS communities
          ORDER BY p.stepCount DESC
          LIMIT 200
        `;
        const depsQuery = `
          MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
          MATCH (a)-[:CodeRelation {type: 'MEMBER_OF'}]->(c1:Community)
          MATCH (b)-[:CodeRelation {type: 'MEMBER_OF'}]->(c2:Community)
          WHERE c1.id <> c2.id
          RETURN c1.label AS \`from\`, c2.label AS \`to\`, COUNT(*) AS calls
          ORDER BY calls DESC
          LIMIT 15
        `;
        const criticalQuery = `
          MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.label AS label, COUNT(r) AS steps
          ORDER BY steps DESC
          LIMIT 10
        `;

        const [clusters, processes, deps, critical] = await Promise.all([
          executeQuery(clustersQuery),
          executeQuery(processesQuery),
          executeQuery(depsQuery),
          executeQuery(criticalQuery),
        ]);

        const clusterLines = clusters.map((row: any) => {
          const label = Array.isArray(row) ? row[1] : row.label;
          const symbols = Array.isArray(row) ? row[3] : row.symbolCount;
          const cohesion = Array.isArray(row) ? row[2] : row.cohesion;
          const desc = Array.isArray(row) ? row[4] : row.description;
          const cohesionText =
            cohesion !== null && cohesion !== undefined ? Number(cohesion).toFixed(2) : '';
          return `| ${label || ''} | ${symbols ?? ''} | ${cohesionText} | ${desc ?? ''} |`;
        });

        const processLines = processes.map((row: any) => {
          const label = Array.isArray(row) ? row[1] : row.label;
          const steps = Array.isArray(row) ? row[3] : row.stepCount;
          const type = Array.isArray(row) ? row[2] : row.type;
          const communities = Array.isArray(row) ? row[4] : row.communities;
          const clusterText = Array.isArray(communities) ? communities.length : communities ? 1 : 0;
          return `| ${label || ''} | ${steps ?? ''} | ${type ?? ''} | ${clusterText} |`;
        });

        const depLines = deps.map((row: any) => {
          const from = Array.isArray(row) ? row[0] : row.from;
          const to = Array.isArray(row) ? row[1] : row.to;
          const calls = Array.isArray(row) ? row[2] : row.calls;
          return `- ${from} -> ${to} (${calls} calls)`;
        });

        const criticalLines = critical.map((row: any) => {
          const label = Array.isArray(row) ? row[0] : row.label;
          const steps = Array.isArray(row) ? row[1] : row.steps;
          return `- ${label} (${steps} steps)`;
        });

        return [
          `CLUSTERS (${clusters.length} total):`,
          `| Cluster | Symbols | Cohesion | Description |`,
          `| --- | --- | --- | --- |`,
          ...clusterLines,
          ``,
          `PROCESSES (${processes.length} total):`,
          `| Process | Steps | Type | Clusters |`,
          `| --- | --- | --- | --- |`,
          ...processLines,
          ``,
          `CLUSTER DEPENDENCIES:`,
          ...(depLines.length > 0 ? depLines : ['- None found']),
          ``,
          `CRITICAL PATHS:`,
          ...(criticalLines.length > 0 ? criticalLines : ['- None found']),
        ].join('\n');
      } catch (error) {
        return `Overview error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: 'overview',
      description:
        'Codebase map showing all clusters and processes, plus cross-cluster dependencies.',
      schema: z.object({}),
    },
  );
};
