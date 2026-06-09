import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GraphRAGBackend } from './types';

/**
 * Execute Cypher queries with optional vector embedding.
 */
export const ensureCypherLimit = (cypher: string, fallbackLimit = 100): string => {
  if (/\blimit\s+\d+\b/i.test(cypher)) return cypher;
  return `${cypher.trim().replace(/;+\s*$/, '')} LIMIT ${fallbackLimit}`;
};

export const createCypherTool = (backend: GraphRAGBackend) => {
  const { executeQuery, search: backendSearch } = backend;

  return tool(
    async ({ query, cypher }: { query?: string; cypher: string }) => {
      try {
        if (cypher.includes('{{QUERY_VECTOR}}')) {
          if (!query) {
            return "Error: Your Cypher contains {{QUERY_VECTOR}} but you didn't provide a 'query' to embed. Add a natural language query.";
          }
          try {
            const semanticResults = await backendSearch(query, { limit: 10, mode: 'semantic' });
            if (semanticResults.length === 0) {
              return 'Semantic search returned no results. Embeddings may not be generated yet.';
            }
            const formatted = semanticResults
              .map(
                (r, i) =>
                  `[${i + 1}] ${r.label || 'File'}: ${r.name || r.filePath?.split('/').pop() || '?'} (score: ${(r.score ?? 0).toFixed(3)})\n    File: ${r.filePath || 'n/a'}`,
              )
              .join('\n');
            return `Semantic search for "${query}" (${semanticResults.length} results):\n\n${formatted}`;
          } catch {
            return 'Semantic search not available. Embeddings may not be generated. Use a non-vector Cypher query instead.';
          }
        }

        const boundedCypher = ensureCypherLimit(cypher);
        const results = await executeQuery(boundedCypher);

        if (results.length === 0) {
          return 'Query returned no results.';
        }

        const firstRow = results[0];
        const columnNames =
          typeof firstRow === 'object' && !Array.isArray(firstRow) ? Object.keys(firstRow) : [];

        if (columnNames.length > 0) {
          const header = `| ${columnNames.join(' | ')} |`;
          const separator = `|${columnNames.map(() => '---').join('|')}|`;

          const rows = results
            .slice(0, 50)
            .map((row) => {
              const values = columnNames.map((col) => {
                const val = row[col];
                if (val === null || val === undefined) return '';
                if (typeof val === 'object') return JSON.stringify(val);
                const str = String(val).replace(/\|/g, '\\|');
                return str.length > 60 ? str.slice(0, 57) + '...' : str;
              });
              return `| ${values.join(' | ')} |`;
            })
            .join('\n');

          const truncated = results.length > 50 ? `\n\n_(${results.length - 50} more rows)_` : '';
          return `**${results.length} results:**\n\n${header}\n${separator}\n${rows}${truncated}`;
        }

        const formatted = results.slice(0, 50).map((row, i) => {
          return `[${i + 1}] ${JSON.stringify(row)}`;
        });
        const truncated = results.length > 50 ? `\n... (${results.length - 50} more)` : '';
        return `${results.length} results:\n${formatted.join('\n')}${truncated}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Cypher error: ${message}\n\nCheck your query syntax. Node tables: File, Folder, Function, Class, Interface, Method, CodeElement. Relation: CodeRelation with type property (CONTAINS, DEFINES, IMPORTS, CALLS). Example: MATCH (f:File)-[:CodeRelation {type: 'IMPORTS'}]->(g:File) RETURN f, g`;
      }
    },
    {
      name: 'cypher',
      description: `Execute a Cypher query against the code graph. Use for structural queries like finding callers, tracing imports, class inheritance, or custom traversals.

Node tables: File, Folder, Function, Class, Interface, Method, CodeElement
Relation: CodeRelation (single table with 'type' property: CONTAINS, DEFINES, IMPORTS, CALLS, EXTENDS, IMPLEMENTS)

Example queries:
    - Functions calling a function: MATCH (caller:Function)-[:CodeRelation {type: 'CALLS'}]->(fn:Function {name: 'validate'}) RETURN caller.name, caller.filePath LIMIT 50
    - Class inheritance: MATCH (child:Class)-[:CodeRelation {type: 'EXTENDS'}]->(parent:Class) RETURN child.name, parent.name LIMIT 50
    - Classes implementing interface: MATCH (c:Class)-[:CodeRelation {type: 'IMPLEMENTS'}]->(i:Interface) RETURN c.name, i.name LIMIT 50
    - Files importing a file: MATCH (f:File)-[:CodeRelation {type: 'IMPORTS'}]->(target:File) WHERE target.name = 'utils.ts' RETURN f.name LIMIT 50
    - All connections (with confidence): MATCH (n)-[r:CodeRelation]-(m) WHERE n.name = 'MyClass' AND r.confidence > 0.8 RETURN m.name, r.type, r.confidence LIMIT 50
    - Find fuzzy matches: MATCH (n)-[r:CodeRelation]-(m) WHERE r.confidence < 0.8 RETURN n.name, r.reason LIMIT 50

For semantic+graph queries, include {{QUERY_VECTOR}} placeholder and provide a 'query' parameter:
CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', {{QUERY_VECTOR}}, 10) YIELD node AS emb, distance
WITH emb, distance WHERE distance < 0.5
    MATCH (n:Function {id: emb.nodeId}) RETURN n LIMIT 50

    Queries without an explicit LIMIT are automatically capped at 100 rows.`,
      schema: z.object({
        cypher: z.string().describe('The Cypher query to execute'),
        query: z
          .string()
          .optional()
          .nullable()
          .describe(
            'Natural language query to embed (required if cypher contains {{QUERY_VECTOR}})',
          ),
      }),
    },
  );
};
