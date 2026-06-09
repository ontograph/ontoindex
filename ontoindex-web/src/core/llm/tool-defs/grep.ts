import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GraphRAGBackend } from './types';

export const createGrepTool = (backend: GraphRAGBackend) => {
  const { grep: backendGrep } = backend;

  return tool(
    async ({
      pattern,
      fileFilter,
      caseSensitive,
      maxResults,
    }: {
      pattern: string;
      fileFilter?: string;
      caseSensitive?: boolean;
      maxResults?: number;
    }) => {
      try {
        try {
          new RegExp(pattern, caseSensitive ? 'g' : 'gi');
        } catch (e) {
          return `Invalid regex: ${pattern}. Error: ${e instanceof Error ? e.message : String(e)}`;
        }

        const limit = maxResults ?? 100;
        const fullPattern = fileFilter
          ? `(?=.*${fileFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}).*${pattern}`
          : pattern;

        const results = await backendGrep(fullPattern, limit);

        if (results.length === 0) {
          return `No matches for "${pattern}"${fileFilter ? ` in files matching "${fileFilter}"` : ''}`;
        }

        const formatted = results.map((r) => `${r.filePath}:${r.line}: ${r.text}`).join('\n');
        const truncatedMsg = results.length >= limit ? `\n\n(Showing first ${limit} results)` : '';

        return `Found ${results.length} matches:\n\n${formatted}${truncatedMsg}`;
      } catch (error) {
        return `Grep error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: 'grep',
      description:
        'Search for exact text patterns across all files using regex. Use for finding specific strings, error messages, TODOs, variable names, etc.',
      schema: z.object({
        pattern: z
          .string()
          .describe('Regex pattern to search for (e.g., "TODO", "console\\.log", "API_KEY")'),
        fileFilter: z
          .string()
          .optional()
          .nullable()
          .describe('Only search files containing this string (e.g., ".ts", "src/api")'),
        caseSensitive: z
          .boolean()
          .optional()
          .nullable()
          .describe('Case-sensitive search (default: false)'),
        maxResults: z.number().optional().nullable().describe('Max results (default: 100)'),
      }),
    },
  );
};
