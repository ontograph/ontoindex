/**
 * Graph RAG Tools for LangChain Agent
 *
 * Barrel module. Each tool factory lives under ./tool-defs/ — keep logic there
 * and let this file compose the 7-tool array.
 *
 * Tools (in stable order, agents rely on the positional shape):
 * - search: Hybrid search (BM25 + semantic + RRF), grouped by process/cluster
 * - cypher: Execute Cypher queries (auto-embeds {{QUERY_VECTOR}} if present)
 * - grep: Regex pattern search across files
 * - read: Read file content by path
 * - overview: Codebase map (clusters + processes)
 * - explore: Deep dive on a symbol, cluster, or process
 * - impact: Impact analysis (what depends on / is affected by changes)
 */

import { createSearchTool } from './tool-defs/search';
import { createCypherTool } from './tool-defs/cypher';
import { createGrepTool } from './tool-defs/grep';
import { createReadTool } from './tool-defs/read';
import { createOverviewTool } from './tool-defs/overview';
import { createExploreTool } from './tool-defs/explore';
import { createImpactTool } from './tool-defs/impact';
import type { GraphRAGBackend } from './tool-defs/types';

export type { GraphRAGBackend } from './tool-defs/types';

/**
 * Tool factory - creates tools bound to backend HTTP query functions.
 */
export const createGraphRAGTools = (backend: GraphRAGBackend) => [
  createSearchTool(backend),
  createCypherTool(backend),
  createGrepTool(backend),
  createReadTool(backend),
  createOverviewTool(backend),
  createExploreTool(backend),
  createImpactTool(backend),
];
