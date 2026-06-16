/**
 * LadybugDB Schema Definitions
 *
 * Hybrid Schema:
 * - Separate node tables for each code element type (File, Function, Class, etc.)
 * - Single CodeRelation table with 'type' property for all relationships
 *
 * This allows LLMs to write natural Cypher queries like:
 *   MATCH (f:Function)-[r:CodeRelation {type: 'CALLS'}]->(g:Function) RETURN f, g
 */

// Import from shared package (single source of truth) — used in DDL templates below
import {
  NODE_TABLES as BASE_NODE_TABLES,
  REL_TABLE_NAME,
  REL_TYPES,
  EMBEDDING_TABLE_NAME,
} from 'ontoindex-shared';

export const NODE_TABLES = BASE_NODE_TABLES;
// Re-export so downstream consumers keep the same import path
export { REL_TABLE_NAME, REL_TYPES, EMBEDDING_TABLE_NAME };
export type { NodeTableName, RelType } from 'ontoindex-shared';

// ============================================================================
// NODE TABLE SCHEMAS
// ============================================================================

export const FILE_SCHEMA = `
CREATE NODE TABLE File (
  id STRING,
  name STRING,
  filePath STRING,
  content STRING,
  PRIMARY KEY (id)
)`;

export const FOLDER_SCHEMA = `
CREATE NODE TABLE Folder (
  id STRING,
  name STRING,
  filePath STRING,
  PRIMARY KEY (id)
)`;

export const FUNCTION_SCHEMA = `
CREATE NODE TABLE Function (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

export const CLASS_SCHEMA = `
CREATE NODE TABLE Class (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

export const INTERFACE_SCHEMA = `
CREATE NODE TABLE Interface (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

export const METHOD_SCHEMA = `
CREATE NODE TABLE Method (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  parameterCount INT32,
  returnType STRING,
  declarationFilePath STRING,
  declarationStartLine INT64,
  declarationEndLine INT64,
  definitionFilePath STRING,
  definitionStartLine INT64,
  definitionEndLine INT64,
  PRIMARY KEY (id)
)`;

export const CODE_ELEMENT_SCHEMA = `
CREATE NODE TABLE CodeElement (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

// ============================================================================
// CONCEPT NODE TABLE (for promoted docs-sidecar concepts)
// ============================================================================

export const CONCEPT_SCHEMA = `
CREATE NODE TABLE Concept (
  id STRING,
  name STRING,
  filePath STRING,
  aliases STRING[],
  sourceDocuments STRING[],
  sourceFactKeys STRING[],
  resolutionKeys STRING[],
  authority STRING,
  confidence STRING,
  evidenceClass STRING,
  freshness STRING,
  PRIMARY KEY (id)
)`;

// ============================================================================
// COMMUNITY NODE TABLE (for Leiden algorithm clusters)
// ============================================================================

export const COMMUNITY_SCHEMA = `
CREATE NODE TABLE Community (
  id STRING,
  label STRING,
  heuristicLabel STRING,
  keywords STRING[],
  description STRING,
  enrichedBy STRING,
  cohesion DOUBLE,
  symbolCount INT32,
  PRIMARY KEY (id)
)`;

// ============================================================================
// PROCESS NODE TABLE (for execution flow detection)
// ============================================================================

export const PROCESS_SCHEMA = `
CREATE NODE TABLE Process (
  id STRING,
  label STRING,
  heuristicLabel STRING,
  processType STRING,
  stepCount INT32,
  communities STRING[],
  entryPointId STRING,
  terminalId STRING,
  PRIMARY KEY (id)
)`;

// ============================================================================
// SUMMARY NODE TABLE (for recursive repository/community/concept summaries)
// ============================================================================

export const SUMMARY_NODE_SCHEMA = `
CREATE NODE TABLE SummaryNode (
  id STRING,
  name STRING,
  filePath STRING,
  level INT64,
  summaryKind STRING,
  summarizedCommunityIds STRING[],
  summarizedConceptIds STRING[],
  summarizedNodeIds STRING[],
  truncated BOOLEAN,
  depth INT64,
  description STRING,
  communityLabel STRING,
  heuristicLabel STRING,
  cohesion DOUBLE,
  symbolCount INT32,
  memberCount INT32,
  includedMemberCount INT32,
  membersTruncated BOOLEAN,
  conceptCount INT32,
  includedConceptCount INT32,
  conceptsTruncated BOOLEAN,
  groundingCount INT32,
  includedGroundingCount INT32,
  groundingsTruncated BOOLEAN,
  sourceDocuments STRING[],
  sourceFactKeys STRING[],
  resolutionKeys STRING[],
  authority STRING,
  evidenceClass STRING,
  freshness STRING,
  confidence STRING,
  omittedCommunityCount INT32,
  PRIMARY KEY (id)
)`;

// ============================================================================
// MULTI-LANGUAGE NODE TABLE SCHEMAS
// ============================================================================

// Generic code element with startLine/endLine for C, C++, Rust, Go, Java, C#
// description: optional metadata (e.g. Eloquent $fillable fields, relationship targets)
const CODE_ELEMENT_BASE = (name: string) => `
CREATE NODE TABLE \`${name}\` (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

const STRUCT_SCHEMA = CODE_ELEMENT_BASE('Struct');
const ENUM_SCHEMA = CODE_ELEMENT_BASE('Enum');
const MACRO_SCHEMA = CODE_ELEMENT_BASE('Macro');
const TYPEDEF_SCHEMA = CODE_ELEMENT_BASE('Typedef');
const UNION_SCHEMA = CODE_ELEMENT_BASE('Union');
const NAMESPACE_SCHEMA = CODE_ELEMENT_BASE('Namespace');
const TRAIT_SCHEMA = CODE_ELEMENT_BASE('Trait');
const IMPL_SCHEMA = CODE_ELEMENT_BASE('Impl');
const TYPE_ALIAS_SCHEMA = CODE_ELEMENT_BASE('TypeAlias');
const CONST_SCHEMA = `
CREATE NODE TABLE \`Const\` (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;
const STATIC_SCHEMA = CODE_ELEMENT_BASE('Static');
const VARIABLE_SCHEMA = CODE_ELEMENT_BASE('Variable');
const PROPERTY_SCHEMA = CODE_ELEMENT_BASE('Property');
const RECORD_SCHEMA = CODE_ELEMENT_BASE('Record');
const DELEGATE_SCHEMA = CODE_ELEMENT_BASE('Delegate');
const ANNOTATION_SCHEMA = CODE_ELEMENT_BASE('Annotation');
const CONSTRUCTOR_SCHEMA = CODE_ELEMENT_BASE('Constructor');
const TEMPLATE_SCHEMA = CODE_ELEMENT_BASE('Template');
const MODULE_SCHEMA = CODE_ELEMENT_BASE('Module');
// API route endpoints (Next.js, Express, etc.)
const ROUTE_SCHEMA = `
CREATE NODE TABLE Route (
  id STRING,
  name STRING,
  filePath STRING,
  responseKeys STRING[],
  errorKeys STRING[],
  middleware STRING[],
  PRIMARY KEY (id)
)`;

// MCP tool definitions
const TOOL_SCHEMA = `
CREATE NODE TABLE Tool (
  id STRING,
  name STRING,
  filePath STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

// Markdown heading sections
const SECTION_SCHEMA = `
CREATE NODE TABLE Section (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  level INT64,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

// ============================================================================
// RELATION TABLE SCHEMA
// Single table with 'type' property - connects all node tables
// ============================================================================

const quoteRelEndpoint = (table: string): string => `\`${table}\``;

const RELATION_ENDPOINTS = NODE_TABLES.flatMap((from) =>
  NODE_TABLES.map((to) => `  FROM ${quoteRelEndpoint(from)} TO ${quoteRelEndpoint(to)}`),
).join(',\n');

export const RELATION_SCHEMA = `
CREATE REL TABLE ${REL_TABLE_NAME} (
${RELATION_ENDPOINTS},
  type STRING,
  confidence DOUBLE,
  reason STRING,
  step INT32
)`;

// ============================================================================
// EMBEDDING TABLE SCHEMA
// Separate table for vector storage to avoid copy-on-write overhead
// ============================================================================

/** Embedding vector dimensions. Default 384 (snowflake-arctic-embed-xs). */
const _rawDims = parseInt(process.env.ONTOINDEX_EMBEDDING_DIMS ?? '384', 10);
if (Number.isNaN(_rawDims) || _rawDims <= 0) {
  throw new Error(
    `ONTOINDEX_EMBEDDING_DIMS must be a positive integer, got "${process.env.ONTOINDEX_EMBEDDING_DIMS}"`,
  );
}
export const EMBEDDING_DIMS = _rawDims;

/** HNSW vector index name for the CodeEmbedding table. */
export const EMBEDDING_INDEX_NAME = 'code_embedding_idx';

/**
 * Sentinel value for "no content hash available" — used in legacy DBs and null rows.
 * Nodes with this hash are always treated as stale and re-embedded.
 */
export const STALE_HASH_SENTINEL = '';

export const EMBEDDING_SCHEMA = `
CREATE NODE TABLE ${EMBEDDING_TABLE_NAME} (
  id STRING,
  nodeId STRING,
  chunkIndex INT32,
  startLine INT64,
  endLine INT64,
  embedding FLOAT[${EMBEDDING_DIMS}],
  contentHash STRING,
  PRIMARY KEY (id)
)`;

/**
 * Create vector index for semantic search
 * Uses HNSW (Hierarchical Navigable Small World) algorithm with cosine similarity
 */
export const CREATE_VECTOR_INDEX_QUERY = `
CALL CREATE_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}', 'embedding', metric := 'cosine')
`;

// ============================================================================
// ALL SCHEMA QUERIES IN ORDER
// Node tables must be created before relationship tables that reference them
// ============================================================================

export const NODE_SCHEMA_QUERIES = [
  FILE_SCHEMA,
  FOLDER_SCHEMA,
  FUNCTION_SCHEMA,
  CLASS_SCHEMA,
  INTERFACE_SCHEMA,
  METHOD_SCHEMA,
  CODE_ELEMENT_SCHEMA,
  COMMUNITY_SCHEMA,
  CONCEPT_SCHEMA,
  PROCESS_SCHEMA,
  SUMMARY_NODE_SCHEMA,
  // Multi-language support
  STRUCT_SCHEMA,
  ENUM_SCHEMA,
  MACRO_SCHEMA,
  TYPEDEF_SCHEMA,
  UNION_SCHEMA,
  NAMESPACE_SCHEMA,
  TRAIT_SCHEMA,
  IMPL_SCHEMA,
  TYPE_ALIAS_SCHEMA,
  CONST_SCHEMA,
  STATIC_SCHEMA,
  VARIABLE_SCHEMA,
  PROPERTY_SCHEMA,
  RECORD_SCHEMA,
  DELEGATE_SCHEMA,
  ANNOTATION_SCHEMA,
  CONSTRUCTOR_SCHEMA,
  TEMPLATE_SCHEMA,
  MODULE_SCHEMA,
  // Markdown support
  SECTION_SCHEMA,
  // API routes
  ROUTE_SCHEMA,
  // MCP tools
  TOOL_SCHEMA,
];

export const REL_SCHEMA_QUERIES = [RELATION_SCHEMA];

export const SCHEMA_QUERIES = [...NODE_SCHEMA_QUERIES, ...REL_SCHEMA_QUERIES, EMBEDDING_SCHEMA];
