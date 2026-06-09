import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { EnrichedSearchResult, GraphRAGBackend } from './types';

/**
 * Unified search tool: BM25 + Semantic + RRF, with 1-hop graph context.
 */
export const createSearchTool = (backend: GraphRAGBackend) => {
  const { search: backendSearch } = backend;

  return tool(
    async ({
      query,
      limit,
      groupByProcess,
    }: {
      query: string;
      limit?: number;
      groupByProcess?: boolean;
    }) => {
      const k = limit ?? 10;
      const shouldGroup = groupByProcess ?? true;

      let searchResults: EnrichedSearchResult[];
      try {
        searchResults = await backendSearch(query, { limit: k, enrich: true });
      } catch {
        return 'Search is not available. Please load a repository first.';
      }

      if (searchResults.length === 0) {
        return `No code found matching "${query}". Try different terms or use grep for exact patterns.`;
      }

      type ProcessInfo = { id: string; label: string; step?: number; stepCount?: number };
      type ResultInfo = {
        idx: number;
        nodeId: string;
        name: string;
        label: string;
        filePath: string;
        location: string;
        sources: string;
        score: string;
        connections: string;
        clusterLabel: string;
        processes: ProcessInfo[];
      };

      const results: ResultInfo[] = searchResults.slice(0, k).map((r, i) => {
        const nodeId = r.nodeId || '';
        const name = r.name || r.filePath?.split('/').pop() || 'Unknown';
        const label = r.label || 'File';
        const filePath = r.filePath || '';
        const location = r.startLine ? ` (lines ${r.startLine}-${r.endLine})` : '';
        const sources = r.sources?.join('+') || 'hybrid';
        const score = r.score ? ` [score: ${r.score.toFixed(2)}]` : '';

        let connections = '';
        if (r.connections) {
          const outgoing = (r.connections.outgoing || []).filter((c) => c?.name).slice(0, 3);
          const incoming = (r.connections.incoming || []).filter((c) => c?.name).slice(0, 3);
          const fmt = (
            c: { name: string; type: string; confidence?: number },
            dir: 'out' | 'in',
          ) => {
            const conf = c.confidence ? Math.round(c.confidence * 100) : 100;
            return dir === 'out'
              ? `-[${c.type} ${conf}%]-> ${c.name}`
              : `<-[${c.type} ${conf}%]- ${c.name}`;
          };
          const outList = outgoing.map((c) => fmt(c, 'out'));
          const inList = incoming.map((c) => fmt(c, 'in'));
          if (outList.length || inList.length) {
            connections = `\n    Connections: ${[...outList, ...inList].join(', ')}`;
          }
        }

        const clusterLabel = (r.cluster as string) || 'Unclustered';
        const processes: ProcessInfo[] = (r.processes || []).filter((p) => p.id && p.label);

        return {
          idx: i + 1,
          nodeId,
          name,
          label,
          filePath,
          location,
          sources,
          score,
          connections,
          clusterLabel,
          processes,
        };
      });

      const formatResult = (r: ResultInfo, stepInfo?: ProcessInfo) => {
        const stepLabel = stepInfo?.step
          ? ` (step ${stepInfo.step}/${stepInfo.stepCount ?? '?'})`
          : '';
        return `[${r.idx}] ${r.label}: ${r.name}${r.score}${stepLabel}\n    ID: ${r.nodeId}\n    File: ${r.filePath}${r.location}\n    Cluster: ${r.clusterLabel}\n    Found by: ${r.sources}${r.connections}`;
      };

      if (!shouldGroup) {
        return `Found ${searchResults.length} matches:\n\n${results.map((r) => formatResult(r)).join('\n\n')}`;
      }

      const processMap = new Map<
        string,
        {
          label: string;
          stepCount?: number;
          entries: { result: ResultInfo; step?: number; stepCount?: number }[];
        }
      >();
      const noProcessKey = '__no_process__';

      for (const r of results) {
        if (r.processes.length === 0) {
          if (!processMap.has(noProcessKey)) {
            processMap.set(noProcessKey, { label: 'No process', entries: [] });
          }
          processMap.get(noProcessKey)!.entries.push({ result: r });
          continue;
        }

        for (const p of r.processes) {
          if (!processMap.has(p.id)) {
            processMap.set(p.id, { label: p.label, stepCount: p.stepCount, entries: [] });
          }
          processMap.get(p.id)!.entries.push({ result: r, step: p.step, stepCount: p.stepCount });
        }
      }

      const sortedProcesses = Array.from(processMap.entries()).sort((a, b) => {
        const aCount = a[1].entries.length;
        const bCount = b[1].entries.length;
        return bCount - aCount;
      });

      const lines: string[] = [];
      lines.push(`Found ${searchResults.length} matches grouped by process:`);
      lines.push('');

      for (const [pid, group] of sortedProcesses) {
        const stepInfo = group.stepCount ? `, ${group.stepCount} steps` : '';
        const header =
          pid === noProcessKey
            ? `NO PROCESS (${group.entries.length} matches)`
            : `PROCESS: ${group.label} (${group.entries.length} matches${stepInfo})`;
        lines.push(header);
        group.entries.forEach((entry) => {
          const stepLabel = entry.step
            ? { id: pid, label: group.label, step: entry.step, stepCount: entry.stepCount }
            : undefined;
          lines.push(formatResult(entry.result, stepLabel));
        });
        lines.push('');
      }

      return lines.join('\n').trim();
    },
    {
      name: 'search',
      description:
        'Search for code by keywords or concepts. Combines keyword matching and semantic understanding. Groups results by process with cluster context.',
      schema: z.object({
        query: z
          .string()
          .describe(
            'What you are looking for (e.g., "authentication middleware", "database connection")',
          ),
        groupByProcess: z
          .boolean()
          .optional()
          .nullable()
          .describe('Group results by process (default: true)'),
        limit: z.number().optional().nullable().describe('Max results to return (default: 10)'),
      }),
    },
  );
};
