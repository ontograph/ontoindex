import { executeParameterized } from '../lbug/pool-adapter.js';
import { buildMermaidCallFlow, buildMermaidInterModuleGraph } from './wiki-diagrams.js';

interface RepoHandle {
  readonly id: string;
}

/**
 * Scan markdown for "live mermaid" tags and replace them with actual Mermaid code blocks.
 *
 * Tag format: <!-- gn-mermaid: [type] query -->
 * Types: call_flow, inter_module
 */
export async function processMarkdownForLiveDiagrams(
  markdown: string,
  repo: RepoHandle,
): Promise<string> {
  const tagRegex = /<!--\s*gn-mermaid:\s*(call_flow|inter_module)\s+(.*?)\s*-->/g;
  let match;
  let processed = markdown;

  // We need to execute queries sequentially to keep it simple for the prototype
  while ((match = tagRegex.exec(markdown)) !== null) {
    const fullMatch = match[0];
    const type = match[1];
    const query = match[2];

    try {
      const rows = await executeParameterized(repo.id, query, {});
      let mermaid = '';

      if (type === 'call_flow') {
        const edges = rows.map((r: any) => ({
          fromName: r.fromName ?? r[0],
          toName: r.toName ?? r[1],
        }));
        mermaid = buildMermaidCallFlow(edges);
      } else if (type === 'inter_module') {
        const edges = rows.map((r: any) => ({
          from: r.from ?? r[0],
          to: r.to ?? r[1],
          count: r.count ?? r[2] ?? 1,
        }));
        mermaid = buildMermaidInterModuleGraph(edges);
      }

      const block = mermaid
        ? `\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n`
        : '\n\n*(No data for diagram)*\n\n';
      processed = processed.replace(fullMatch, block);
    } catch (e) {
      console.warn(`[live-mermaid] Failed to execute query: ${query}`, e);
      processed = processed.replace(
        fullMatch,
        `\n\n> **Error rendering diagram:** ${e instanceof Error ? e.message : String(e)}\n\n`,
      );
    }
  }

  return processed;
}
