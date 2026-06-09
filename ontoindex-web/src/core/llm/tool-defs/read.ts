import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GraphRAGBackend } from './types';

export const createReadTool = (backend: GraphRAGBackend) => {
  const { readFile } = backend;

  return tool(
    async ({ filePath }: { filePath: string }) => {
      try {
        const content = await readFile(filePath);

        const MAX_CONTENT = 50000;
        if (content.length > MAX_CONTENT) {
          const lines = content.split('\n').length;
          return `File: ${filePath} (${lines} lines, truncated)\n\n${content.slice(0, MAX_CONTENT)}\n\n... [truncated]`;
        }

        const lines = content.split('\n').length;
        return `File: ${filePath} (${lines} lines)\n\n${content}`;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('not found') || message.includes('404')) {
          return `File not found: "${filePath}". Use grep to search for the correct path.`;
        }
        return `Error reading file: ${message}`;
      }
    },
    {
      name: 'read',
      description:
        'Read the full content of a file. Use to see source code after finding files via search or grep.',
      schema: z.object({
        filePath: z.string().describe('File path to read (can be partial like "src/utils.ts")'),
      }),
    },
  );
};
