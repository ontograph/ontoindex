/**
 * Shared types and helpers for Graph RAG tool definitions.
 *
 * Each tool module in tool-defs/ exposes a `createXxxTool(backend)` factory
 * that returns a LangChain Tool. Factories take the shared GraphRAGBackend
 * here so consumers (tools.ts barrel, tests) can wire them consistently.
 */

import { NODE_TABLES, REL_TYPES } from 'ontoindex-shared';
import type { EnrichedSearchResult, GrepResult } from '../../../services/backend-client';

export type { EnrichedSearchResult, GrepResult };

/**
 * Backend query interface for Graph RAG tools.
 * All queries go through the backend HTTP API.
 */
export interface GraphRAGBackend {
  executeQuery: (cypher: string) => Promise<Record<string, unknown>[]>;
  search: (
    query: string,
    opts?: { limit?: number; mode?: 'hybrid' | 'semantic' | 'bm25'; enrich?: boolean },
  ) => Promise<EnrichedSearchResult[]>;
  grep: (pattern: string, limit?: number) => Promise<GrepResult[]>;
  readFile: (filePath: string) => Promise<string>;
}

export const validLabel = (label: string): boolean =>
  (NODE_TABLES as readonly string[]).includes(label);

export const validRelType = (t: string): boolean => (REL_TYPES as readonly string[]).includes(t);
