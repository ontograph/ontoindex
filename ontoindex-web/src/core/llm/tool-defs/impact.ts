import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { REL_TYPES } from 'ontoindex-shared';
import { validRelType } from './types';
import type { GraphRAGBackend } from './types';

export const createImpactTool = (backend: GraphRAGBackend) => {
  const { executeQuery, grep: backendGrep, readFile } = backend;

  return tool(
    async ({
      target,
      direction,
      maxDepth,
      relationTypes,
      includeTests,
      minConfidence,
    }: {
      target: string;
      direction: 'upstream' | 'downstream';
      maxDepth?: number;
      relationTypes?: string[];
      includeTests?: boolean;
      minConfidence?: number;
    }) => {
      const depth = Math.min(maxDepth ?? 3, 10);
      const showTests = includeTests ?? false;
      const minConf = minConfidence ?? 0.7;

      const isTestFile = (path: string): boolean => {
        if (!path) return false;
        const p = path.toLowerCase();
        return (
          p.includes('.test.') ||
          p.includes('.spec.') ||
          p.includes('__tests__') ||
          p.includes('__mocks__') ||
          p.endsWith('.test.ts') ||
          p.endsWith('.test.tsx') ||
          p.endsWith('.spec.ts') ||
          p.endsWith('.spec.tsx')
        );
      };

      const defaultRelTypes = ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];
      const activeRelTypes =
        relationTypes && relationTypes.length > 0
          ? relationTypes.filter((t) => validRelType(t))
          : defaultRelTypes;
      if (activeRelTypes.length === 0) {
        return `No valid relation types provided. Valid types: ${(REL_TYPES as readonly string[]).join(', ')}`;
      }
      const relTypeFilter = activeRelTypes.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');

      const isPathQuery = target.includes('/');
      const escapedTarget = target.replace(/'/g, "''");

      const findTargetQuery = isPathQuery
        ? `
          MATCH (n)
          WHERE n.filePath IS NOT NULL AND n.filePath CONTAINS '${escapedTarget}'
          RETURN n.id AS id, label(n) AS nodeType, n.filePath AS filePath
          LIMIT 10
        `
        : `
          MATCH (n)
          WHERE n.name = '${escapedTarget}'
          RETURN n.id AS id, label(n) AS nodeType, n.filePath AS filePath
          LIMIT 10
        `;

      let targetResults;
      try {
        targetResults = await executeQuery(findTargetQuery);
      } catch (error) {
        return `Error finding target "${target}": ${error}`;
      }

      if (!targetResults || targetResults.length === 0) {
        return `Could not find "${target}" in the codebase. Try using the search tool first to find the exact name.`;
      }

      const allPaths = targetResults
        .map((r: any) => (Array.isArray(r) ? r[2] : r.filePath))
        .filter(Boolean);

      if (targetResults.length > 1 && !target.includes('/')) {
        return `⚠️ AMBIGUOUS TARGET: Multiple files named "${target}" found:\n\n${allPaths.map((p: string, i: number) => `${i + 1}. ${p}`).join('\n')}\n\nPlease specify which file you mean by using a more specific path, e.g.:\n- impact("${allPaths[0].split('/').slice(-3).join('/')}")\n- impact("${allPaths[1]?.split('/').slice(-3).join('/') || allPaths[0]}")`;
      }

      let targetNode = targetResults[0];
      if (target.includes('/') && targetResults.length > 1) {
        const exactMatch = targetResults.find((r: any) => {
          const path = Array.isArray(r) ? r[2] : r.filePath;
          return path && path.toLowerCase().includes(target.toLowerCase());
        });
        if (exactMatch) {
          targetNode = exactMatch;
        } else {
          return `⚠️ AMBIGUOUS TARGET: Could not uniquely match "${target}". Found:\n\n${allPaths.map((p: string, i: number) => `${i + 1}. ${p}`).join('\n')}\n\nPlease use a more specific path.`;
        }
      }

      const targetId = Array.isArray(targetNode) ? targetNode[0] : targetNode.id;
      const targetType = Array.isArray(targetNode) ? targetNode[1] : targetNode.nodeType;
      const targetFilePath = Array.isArray(targetNode) ? targetNode[2] : targetNode.filePath;

      if (import.meta.env.DEV) {
        console.log(
          `🎯 Impact: Found target "${target}" → id=${targetId}, type=${targetType}, filePath=${targetFilePath}`,
        );
      }

      const multipleMatchWarning = '';
      const isFileTarget = targetType === 'File';

      const depthQueries: Promise<any[]>[] = [];

      const d1Query =
        direction === 'upstream'
          ? isFileTarget
            ? `
            MATCH (affected)-[r:CodeRelation]->(callee)
            WHERE callee.filePath = '${(targetFilePath || target).replace(/'/g, "''")}'
              AND r.type IN [${relTypeFilter}]
              AND affected.filePath <> callee.filePath
              AND (r.confidence IS NULL OR r.confidence >= ${minConf})
            RETURN DISTINCT
              affected.id AS id,
              affected.name AS name,
              label(affected) AS nodeType,
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              1 AS depth,
              r.type AS edgeType,
              r.confidence AS confidence,
              r.reason AS reason
            LIMIT 300
          `
            : `
            MATCH (target {id: '${targetId.replace(/'/g, "''")}'})
            MATCH (affected)-[r:CodeRelation]->(target)
            WHERE r.type IN [${relTypeFilter}]
              AND (r.confidence IS NULL OR r.confidence >= ${minConf})
            RETURN DISTINCT
              affected.id AS id,
              affected.name AS name,
              label(affected) AS nodeType,
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              1 AS depth,
              r.type AS edgeType,
              r.confidence AS confidence,
              r.reason AS reason
            LIMIT 300
          `
          : isFileTarget
            ? `
            MATCH (caller)-[r:CodeRelation]->(affected)
            WHERE caller.filePath = '${(targetFilePath || target).replace(/'/g, "''")}'
              AND r.type IN [${relTypeFilter}]
              AND caller.filePath <> affected.filePath
              AND (r.confidence IS NULL OR r.confidence >= ${minConf})
            RETURN DISTINCT
              affected.id AS id,
              affected.name AS name,
              label(affected) AS nodeType,
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              1 AS depth,
              r.type AS edgeType,
              r.confidence AS confidence,
              r.reason AS reason
            LIMIT 300
          `
            : `
            MATCH (target {id: '${targetId.replace(/'/g, "''")}'})
            MATCH (target)-[r:CodeRelation]->(affected)
            WHERE r.type IN [${relTypeFilter}]
              AND (r.confidence IS NULL OR r.confidence >= ${minConf})
            RETURN DISTINCT
              affected.id AS id,
              affected.name AS name,
              label(affected) AS nodeType,
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              1 AS depth,
              r.type AS edgeType,
              r.confidence AS confidence,
              r.reason AS reason
            LIMIT 300
          `;
      if (import.meta.env.DEV) {
        console.log(`🔍 Impact d=1 query:\n${d1Query}`);
      }
      depthQueries.push(
        executeQuery(d1Query)
          .then((results) => {
            if (import.meta.env.DEV) {
              console.log(`📊 Impact d=1 results: ${results.length} rows`);
              if (results.length > 0) {
                console.log('   Sample:', results.slice(0, 3));
              }
            }
            return results;
          })
          .catch((err) => {
            if (import.meta.env.DEV) console.warn('Impact d=1 query failed:', err);
            return [];
          }),
      );

      if (depth >= 2) {
        const d2Query =
          direction === 'upstream'
            ? `
            MATCH (target {id: '${targetId.replace(/'/g, "''")}'})
            MATCH (a)-[r1:CodeRelation]->(target)
            MATCH (affected)-[r2:CodeRelation]->(a)
            WHERE r1.type IN [${relTypeFilter}] AND r2.type IN [${relTypeFilter}]
              AND affected.id <> target.id
              AND (r1.confidence IS NULL OR r1.confidence >= ${minConf})
              AND (r2.confidence IS NULL OR r2.confidence >= ${minConf})
            RETURN DISTINCT
              affected.id AS id,
              affected.name AS name,
              label(affected) AS nodeType,
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              2 AS depth,
              r2.type AS edgeType,
              r2.confidence AS confidence,
              r2.reason AS reason
            LIMIT 200
          `
            : `
            MATCH (target {id: '${targetId.replace(/'/g, "''")}'})
            MATCH (target)-[r1:CodeRelation]->(a)
            MATCH (a)-[r2:CodeRelation]->(affected)
            WHERE r1.type IN [${relTypeFilter}] AND r2.type IN [${relTypeFilter}]
              AND affected.id <> target.id
              AND (r1.confidence IS NULL OR r1.confidence >= ${minConf})
              AND (r2.confidence IS NULL OR r2.confidence >= ${minConf})
            RETURN DISTINCT
              affected.id AS id,
              affected.name AS name,
              label(affected) AS nodeType,
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              2 AS depth,
              r2.type AS edgeType,
              r2.confidence AS confidence,
              r2.reason AS reason
            LIMIT 200
          `;
        depthQueries.push(
          executeQuery(d2Query).catch((err) => {
            if (import.meta.env.DEV) console.warn('Impact d=2 query failed:', err);
            return [];
          }),
        );
      }

      if (depth >= 3) {
        const d3Query =
          direction === 'upstream'
            ? `
            MATCH (target {id: '${targetId.replace(/'/g, "''")}'})
            MATCH (a)-[r1:CodeRelation]->(target)
            MATCH (b)-[r2:CodeRelation]->(a)
            MATCH (affected)-[r3:CodeRelation]->(b)
            WHERE r1.type IN [${relTypeFilter}] AND r2.type IN [${relTypeFilter}] AND r3.type IN [${relTypeFilter}]
              AND affected.id <> target.id AND affected.id <> a.id
              AND (r1.confidence IS NULL OR r1.confidence >= ${minConf})
              AND (r2.confidence IS NULL OR r2.confidence >= ${minConf})
              AND (r3.confidence IS NULL OR r3.confidence >= ${minConf})
            RETURN DISTINCT
              affected.id AS id,
              affected.name AS name,
              label(affected) AS nodeType,
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              3 AS depth,
              r3.type AS edgeType,
              r3.confidence AS confidence,
              r3.reason AS reason
            LIMIT 100
          `
            : `
            MATCH (target {id: '${targetId.replace(/'/g, "''")}'})
            MATCH (target)-[r1:CodeRelation]->(a)
            MATCH (a)-[r2:CodeRelation]->(b)
            MATCH (b)-[r3:CodeRelation]->(affected)
            WHERE r1.type IN [${relTypeFilter}] AND r2.type IN [${relTypeFilter}] AND r3.type IN [${relTypeFilter}]
              AND affected.id <> target.id AND affected.id <> a.id
              AND (r1.confidence IS NULL OR r1.confidence >= ${minConf})
              AND (r2.confidence IS NULL OR r2.confidence >= ${minConf})
              AND (r3.confidence IS NULL OR r3.confidence >= ${minConf})
            RETURN DISTINCT
              affected.id AS id,
              affected.name AS name,
              label(affected) AS nodeType,
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              3 AS depth,
              r3.type AS edgeType,
              r3.confidence AS confidence,
              r3.reason AS reason
            LIMIT 100
          `;
        depthQueries.push(
          executeQuery(d3Query).catch((err) => {
            if (import.meta.env.DEV) console.warn('Impact d=3 query failed:', err);
            return [];
          }),
        );
      }

      const depthResults = await Promise.all(depthQueries);

      interface NodeInfo {
        id: string;
        name: string;
        nodeType: string;
        filePath: string;
        startLine?: number;
        edgeType: string;
        confidence: number;
        reason: string;
      }
      const byDepth: Map<number, NodeInfo[]> = new Map();
      const allNodeIds: string[] = [];
      const seenIds = new Set<string>();

      depthResults.forEach((results, idx) => {
        const d = idx + 1;
        results.forEach((row: any) => {
          const nodeId = Array.isArray(row) ? row[0] : row.id;
          const filePath = Array.isArray(row) ? row[3] : row.filePath;

          if (!showTests && isTestFile(filePath)) return;

          if (nodeId && !seenIds.has(nodeId)) {
            seenIds.add(nodeId);
            if (!byDepth.has(d)) byDepth.set(d, []);

            const info: NodeInfo = {
              id: nodeId,
              name: Array.isArray(row) ? row[1] : row.name,
              nodeType: Array.isArray(row) ? row[2] : row.nodeType,
              filePath: filePath,
              startLine: Array.isArray(row) ? row[4] : row.startLine,
              edgeType: Array.isArray(row) ? row[5] : row.edgeType || 'CALLS',
              confidence: Array.isArray(row) ? row[6] : (row.confidence ?? 1.0),
              reason: Array.isArray(row) ? row[7] : row.reason || '',
            };
            byDepth.get(d)!.push(info);
            allNodeIds.push(nodeId);
          }
        });
      });

      const totalAffected = allNodeIds.length;

      if (totalAffected === 0) {
        if (isFileTarget) {
          const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const targetFileName = (targetFilePath || target).split('/').pop() || target;
          const baseName = targetFileName.replace(/\.[^/.]+$/, '');
          try {
            const hints = await backendGrep(`\\b${escapeRegex(baseName)}\\b`, 15);
            const filtered = hints.filter((h) => h.filePath !== targetFilePath);

            if (filtered.length > 0) {
              const formatted = filtered
                .map((h) => `${h.filePath}:${h.line}: ${h.text}`)
                .join('\n');
              return `No ${direction} dependencies found for "${target}" (types: ${activeRelTypes.join(', ')}), but textual references were detected (graph may be incomplete):\n\n${formatted}${multipleMatchWarning}`;
            }
          } catch {
            // Grep fallback failed — continue to default message
          }
        }

        return `No ${direction} dependencies found for "${target}" (types: ${activeRelTypes.join(', ')}). This code appears to be ${direction === 'upstream' ? 'unused (not called by anything)' : 'self-contained (no outgoing dependencies)'}.${multipleMatchWarning}`;
      }

      const depth1 = byDepth.get(1) || [];
      const depth2 = byDepth.get(2) || [];
      const depth3 = byDepth.get(3) || [];

      const confidenceBuckets = { high: 0, medium: 0, low: 0 };
      for (const nodes of byDepth.values()) {
        for (const n of nodes) {
          const conf = n.confidence ?? 1;
          if (conf >= 0.9) confidenceBuckets.high += 1;
          else if (conf >= 0.8) confidenceBuckets.medium += 1;
          else confidenceBuckets.low += 1;
        }
      }

      const maxIdsForContext = 500;
      const trimmedIds = allNodeIds.slice(0, maxIdsForContext);
      const idList = trimmedIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
      let affectedProcesses: Array<{
        label: string;
        hits: number;
        minStep: number | null;
        stepCount: number | null;
      }> = [];
      let affectedClusters: Array<{ label: string; hits: number; impact: string }> = [];

      if (trimmedIds.length > 0) {
        const processQuery = `
          MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE s.id IN [${idList}]
          RETURN p.label AS label, COUNT(DISTINCT s.id) AS hits, MIN(r.step) AS minStep, p.stepCount AS stepCount
          ORDER BY hits DESC
          LIMIT 20
        `;
        const clusterQuery = `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN [${idList}]
          RETURN c.label AS label, COUNT(DISTINCT s.id) AS hits
          ORDER BY hits DESC
          LIMIT 20
        `;
        const directIdList = depth1.map((n) => `'${n.id.replace(/'/g, "''")}'`).join(', ');
        const directClusterQuery =
          depth1.length > 0
            ? `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN [${directIdList}]
          RETURN DISTINCT c.label AS label
        `
            : '';

        const [processRes, clusterRes, directClusterRes] = await Promise.all([
          executeQuery(processQuery),
          executeQuery(clusterQuery),
          directClusterQuery ? executeQuery(directClusterQuery) : Promise.resolve([]),
        ]);

        const directClusterSet = new Set<string>();
        directClusterRes.forEach((row: any) => {
          const label = Array.isArray(row) ? row[0] : row.label;
          if (label) directClusterSet.add(label);
        });

        affectedProcesses = processRes.map((row: any) => ({
          label: Array.isArray(row) ? row[0] : row.label,
          hits: Array.isArray(row) ? row[1] : row.hits,
          minStep: Array.isArray(row) ? row[2] : row.minStep,
          stepCount: Array.isArray(row) ? row[3] : row.stepCount,
        }));

        affectedClusters = clusterRes.map((row: any) => {
          const label = Array.isArray(row) ? row[0] : row.label;
          const hits = Array.isArray(row) ? row[1] : row.hits;
          const impact = directClusterSet.has(label) ? 'direct' : 'indirect';
          return { label, hits, impact };
        });
      }

      const directCount = depth1.length;
      const processCount = affectedProcesses.length;
      const clusterCount = affectedClusters.length;
      let risk = 'LOW';
      if (directCount >= 30 || processCount >= 5 || clusterCount >= 5 || totalAffected >= 200) {
        risk = 'CRITICAL';
      } else if (
        directCount >= 15 ||
        processCount >= 3 ||
        clusterCount >= 3 ||
        totalAffected >= 100
      ) {
        risk = 'HIGH';
      } else if (directCount >= 5 || totalAffected >= 30) {
        risk = 'MEDIUM';
      }

      const lines: string[] = [
        `🔴 IMPACT: ${target} | ${direction} | ${totalAffected} affected`,
        `Confidence: High ${confidenceBuckets.high} | Medium ${confidenceBuckets.medium} | Low ${confidenceBuckets.low}`,
        ``,
        `AFFECTED PROCESSES:`,
        ...(affectedProcesses.length > 0
          ? affectedProcesses.map(
              (p) =>
                `- ${p.label} - BROKEN at step ${p.minStep ?? '?'} (${p.hits} symbols, ${p.stepCount ?? '?'} steps)`,
            )
          : ['- None found']),
        ``,
        `AFFECTED CLUSTERS:`,
        ...(affectedClusters.length > 0
          ? affectedClusters.map((c) => `- ${c.label} (${c.impact}, ${c.hits} symbols)`)
          : ['- None found']),
        ``,
        `RISK: ${risk}`,
        `- Direct callers: ${directCount}`,
        `- Processes affected: ${processCount}`,
        `- Clusters affected: ${clusterCount}`,
        ``,
      ];

      const formatNode = (n: NodeInfo): string => {
        const fileName = n.filePath?.split('/').pop() || '';
        const loc = n.startLine ? `${fileName}:${n.startLine}` : fileName;
        const confPct = Math.round((n.confidence ?? 1) * 100);
        const fuzzyMarker = confPct < 80 ? '[fuzzy]' : '';
        return `  ${n.nodeType}|${n.name}|${loc}|${n.edgeType}|${confPct}%${fuzzyMarker}`;
      };

      const getCallSiteSnippet = async (n: NodeInfo): Promise<string | null> => {
        if (!n.filePath || !n.startLine) return null;

        try {
          const content = await readFile(n.filePath);
          const lines = content.split('\n');
          const lineIdx = n.startLine - 1;
          if (lineIdx < 0 || lineIdx >= lines.length) return null;

          let snippet = lines[lineIdx].trim();
          if (snippet.length > 80) snippet = snippet.slice(0, 77) + '...';
          return snippet;
        } catch {
          return null;
        }
      };

      if (depth1.length > 0) {
        const header =
          direction === 'upstream'
            ? `d=1 (Directly DEPEND ON ${target}):`
            : `d=1 (${target} USES these):`;
        lines.push(header);
        for (const n of depth1.slice(0, 15)) {
          lines.push(formatNode(n));
          const snippet = await getCallSiteSnippet(n);
          if (snippet) {
            lines.push(`    ↳ "${snippet}"`);
          }
        }
        if (depth1.length > 15) lines.push(`  ... +${depth1.length - 15} more`);
        lines.push(``);
      }

      if (depth2.length > 0) {
        const header =
          direction === 'upstream'
            ? `d=2 (Indirectly DEPEND ON ${target}):`
            : `d=2 (${target} USES these indirectly):`;
        lines.push(header);
        depth2.slice(0, 15).forEach((n) => lines.push(formatNode(n)));
        if (depth2.length > 15) lines.push(`  ... +${depth2.length - 15} more`);
        lines.push(``);
      }

      if (depth3.length > 0) {
        lines.push(`d=3 (Deep impact/dependency):`);
        depth3.slice(0, 5).forEach((n) => lines.push(formatNode(n)));
        if (depth3.length > 5) lines.push(`  ... +${depth3.length - 5} more`);
        lines.push(``);
      }

      lines.push(`✅ GRAPH ANALYSIS COMPLETE (trusted)`);
      lines.push(`⚠️ Optional: grep("${target}") for dynamic patterns`);
      if (multipleMatchWarning) {
        lines.push(multipleMatchWarning);
      }
      lines.push(``);

      return lines.join('\n');
    },
    {
      name: 'impact',
      description: `Analyze the impact of changing a function, class, or file.

Use when users ask:
- "What would break if I changed X?"
- "What depends on X?"
- "Impact analysis for X"

Direction:
- upstream: Find what CALLS/IMPORTS/EXTENDS this target (what would break)
- downstream: Find what this target CALLS/IMPORTS/EXTENDS (dependencies)

Output format (compact tabular):
  Type|Name|File:Line|EdgeType|Confidence%

EdgeType: CALLS, IMPORTS, EXTENDS, IMPLEMENTS
Confidence: 100% = certain, <80% = fuzzy match (may be false positive)

relationTypes filter (optional):
- Default: CALLS, IMPORTS, EXTENDS, IMPLEMENTS (usage-based)
- Can add CONTAINS, DEFINES for structural analysis

Additional output sections:
- Affected processes (with step impact)
- Affected clusters (direct/indirect)
- Risk summary (based on direct callers, processes, clusters)`,
      schema: z.object({
        target: z.string().describe('Name of the function, class, or file to analyze'),
        direction: z
          .enum(['upstream', 'downstream'])
          .describe('upstream = what depends on this; downstream = what this depends on'),
        maxDepth: z
          .number()
          .optional()
          .nullable()
          .describe('Max traversal depth (default: 3, max: 10)'),
        relationTypes: z
          .array(z.string())
          .optional()
          .nullable()
          .describe(
            'Filter by relation types: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, CONTAINS, DEFINES (default: usage-based)',
          ),
        includeTests: z
          .boolean()
          .optional()
          .nullable()
          .describe(
            'Include test files in results (default: false, excludes .test.ts, .spec.ts, __tests__)',
          ),
        minConfidence: z
          .number()
          .optional()
          .nullable()
          .describe('Minimum edge confidence 0-1 (default: 0.7, excludes fuzzy/inferred matches)'),
      }),
    },
  );
};
