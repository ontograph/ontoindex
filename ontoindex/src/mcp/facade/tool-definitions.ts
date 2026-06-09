import { ToolDefinition } from '../tools.js';
import { RETRIEVAL_POLICY_NAMES } from '../../core/ingestion/enrichment/index.js';
import { CONTEXT_NEIGHBORHOOD_MODES } from '../local/backend-context-neighborhood.js';

const repoProperty = { type: 'string', description: 'Repository name or path.' };
const serviceProperty = {
  type: 'string',
  minLength: 1,
  description:
    'Optional monorepo service root. In group mode (@repo), prefix-matches member file paths.',
};
const enrichmentProperties = {
  consume_enrichment_facts: {
    type: 'boolean',
    description: 'Opt in to sidecar enrichment facts under the top-level enrichment envelope.',
    default: false,
  },
  allow_low_confidence: {
    type: 'boolean',
    description: 'Allow low-confidence sidecar enrichment records.',
    default: false,
  },
};
const passiveMarkdownProperties = {
  retrieval_policy: {
    type: 'string',
    enum: [...RETRIEVAL_POLICY_NAMES],
    description:
      'Named retrieval expansion policy. Defaults to graph-only behavior unless explicitly set.',
  },
  include_passive_related_facts: {
    type: 'boolean',
    description:
      'Opt in to HippoRAG-style passive related fact metadata when consume_enrichment_facts is true.',
    default: false,
  },
  include_markdown_context: {
    type: 'boolean',
    description:
      'Include Markdown document context when enrichment facts and passive related facts are enabled.',
    default: false,
  },
  include_markdown_ppr: {
    type: 'boolean',
    description: 'Include bounded Markdown document-only PPR metadata with Markdown context.',
    default: false,
  },
};
const contextNeighborhoodProperties = {
  neighborhood_mode: {
    type: 'string',
    enum: [...CONTEXT_NEIGHBORHOOD_MODES],
    description:
      'Explicit bounded context neighborhood mode. When omitted, context keeps the default symbol view.',
  },
  route: { type: 'string', description: 'Route identity for route-neighborhood.' },
  process_id: { type: 'string', description: 'Process identity for process-neighborhood.' },
  requirement_id: {
    type: 'string',
    description: 'Requirement identity for requirement-neighborhood.',
  },
  api_doc_id: { type: 'string', description: 'API docs identity for api-doc-neighborhood.' },
  doc_path: { type: 'string', description: 'Markdown document path identity.' },
  depth: { type: 'number', minimum: 1, maximum: 3, description: 'Maximum traversal depth.' },
  limit: { type: 'number', minimum: 1, maximum: 100, description: 'Maximum emitted items.' },
  maxCandidates: {
    type: 'number',
    minimum: 1,
    maximum: 20,
    description: 'Maximum ambiguous identity candidates.',
  },
};

/**
 * OntoIndex MCP Facade Tools (M-1)
 *
 * These consolidate the ~40 internal MCP tools into 7 action-dispatched facades.
 */
export const ONTOINDEX_FACADE_TOOLS: ToolDefinition[] = [
  {
    name: 'discover',
    description: 'Discover repositories, routes, tools, and analysis packs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['repos', 'routes', 'tools', 'packs', 'groups', 'sync'],
          description: 'The discovery action to perform.',
        },
        repo: repoProperty,
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'search',
    description:
      'Search the knowledge graph using semantic, Cypher, or repomap queries. Semantic search can opt in to sidecar enrichment, passive related facts, Markdown context, and Markdown PPR metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['semantic', 'cypher', 'repomap'],
          description: 'The search action to perform.',
        },
        repo: repoProperty,
        service: serviceProperty,
        query: {
          type: 'string',
          description:
            'Search query or Cypher statement. For action="semantic", this can also carry the existing typed-query document when typed_query is true.',
        },
        typed_query: {
          type: 'boolean',
          description:
            'Parse query as the existing typed-query document when action="semantic". Current degraded capabilities: @group searches fall back to plain semantic search, vec/hyde lanes downgrade when embeddings are unavailable, and graph lanes may fall back to BM25 seeds when traversal is unavailable.',
          default: false,
        },
        structured_output: {
          type: 'boolean',
          description:
            'For action="semantic", include structured_retrieval candidates, evidence references, and capability state when the backend can produce them. Default: false.',
          default: false,
        },
        task_context: {
          type: 'string',
          description: 'What you are working on. Helps semantic ranking.',
        },
        goal: {
          type: 'string',
          description: 'What you want to find. Helps semantic ranking.',
        },
        limit: {
          type: 'number',
          description: 'Maximum semantic processes/results to return.',
          default: 5,
          minimum: 1,
          maximum: 100,
        },
        max_symbols: {
          type: 'number',
          description: 'Maximum symbols per semantic process.',
          default: 10,
          minimum: 1,
          maximum: 200,
        },
        include_content: {
          type: 'boolean',
          description: 'Include full symbol source content for semantic results.',
          default: false,
        },
        include_skeleton: {
          type: 'boolean',
          description: 'Include AST skeletons for top semantic result files.',
          default: true,
        },
        ...enrichmentProperties,
        ...passiveMarkdownProperties,
        focus: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repomap focus file paths or symbol names.',
        },
        token_budget: {
          type: 'number',
          description: 'Repomap token budget.',
          default: 4000,
        },
        format: {
          type: 'string',
          enum: ['signatures', 'outline', 'full', 'compressed'],
          description: 'Repomap output format.',
          default: 'signatures',
        },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'inspect',
    description:
      'Inspect symbol context, evidence packs, API shapes, or IPC traces. Context inspection can opt in to sidecar enrichment metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['context', 'evidence', 'shape', 'ipc'],
          description: 'The inspection action to perform.',
        },
        repo: repoProperty,
        service: serviceProperty,
        target: {
          type: 'string',
          description:
            'Facade alias. Maps to name for context, targets[0] for evidence, route for shape, and symbol_name for IPC.',
        },
        name: { type: 'string', description: 'Context symbol name.' },
        uid: { type: 'string', description: 'Context symbol UID.' },
        file_path: { type: 'string', description: 'Context file path disambiguator.' },
        kind: { type: 'string', description: 'Context symbol kind disambiguator.' },
        include_content: {
          type: 'boolean',
          description: 'Include full symbol source content in context results.',
          default: false,
        },
        ...enrichmentProperties,
        ...passiveMarkdownProperties,
        ...contextNeighborhoodProperties,
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Evidence-pack targets such as file:line or symbol names.',
        },
        include_snippet: {
          type: 'boolean',
          description: 'Include evidence-pack snippets.',
          default: true,
        },
        context_lines: {
          type: 'number',
          description: 'Evidence-pack context lines.',
          default: 3,
        },
        route: { type: 'string', description: 'API route for shape checks.' },
        symbol_name: { type: 'string', description: 'IPC trace symbol name.' },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'impact',
    description:
      'Analyze impact of changes on symbols, routes, or batches of symbols. Symbol impact supports opt-in sidecar enrichment with a safety-critical gate.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['symbol', 'batch', 'route', 'diff'],
          description: 'The impact analysis action to perform.',
        },
        repo: repoProperty,
        service: serviceProperty,
        target: {
          type: 'string',
          description:
            'Symbol name, UID, route, or batch seed. Facade maps route target to route and batch target to targets[0].',
        },
        target_uid: { type: 'string', description: 'Direct symbol UID for symbol impact.' },
        direction: {
          type: 'string',
          enum: ['upstream', 'downstream'],
          description: 'Impact direction for symbol and batch analysis. Defaults to upstream.',
          default: 'upstream',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Batch impact target symbols.',
        },
        route: { type: 'string', description: 'Route for API impact.' },
        file_path: { type: 'string', description: 'Symbol file-path disambiguator.' },
        kind: { type: 'string', description: 'Symbol kind disambiguator.' },
        maxDepth: {
          type: 'number',
          description: 'Maximum graph traversal depth.',
          default: 3,
          minimum: 1,
          maximum: 32,
        },
        crossDepth: {
          type: 'number',
          description: 'Maximum cross-repo traversal depth.',
          default: 1,
          minimum: 1,
          maximum: 32,
        },
        relationTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relationship types to include.',
        },
        includeTests: {
          type: 'boolean',
          description: 'Include test relationships in impact traversal.',
          default: false,
        },
        minConfidence: {
          type: 'number',
          description: 'Minimum relationship confidence.',
          default: 0,
          minimum: 0,
          maximum: 1,
        },
        timeoutMs: {
          type: 'number',
          description: 'Impact timeout in milliseconds.',
          minimum: 1,
          maximum: 3600000,
        },
        ...enrichmentProperties,
        allow_safety_critical_enrichment: {
          type: 'boolean',
          description: 'Allow sidecar fact consumption for safety-critical impact analysis.',
          default: false,
        },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'audit',
    description:
      'Run architectural audits, manager-level audit session workflows, write-through verification, and systems-audit checks.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'report',
            'dead_code',
            'tech_debt',
            'hotspots',
            'cycles',
            'coupling',
            'violations',
            'coverage',
            'migration',
            'drift',
            'build',
            'graph_diff',
            'requirements',
            'patterns',
            'rerun',
            'session_start',
            'session_verify',
            'session_dedupe',
            'session_bundle',
            'session_dispatch',
            'session_review_worker',
            'verify_diff',
            'test_gap',
            'worker_scope_review',
            'logic',
            'trace_boundary',
            'resource_trace',
            'path_verify',
            'test_suggestions',
            'extract_fsm',
            'error_topology',
            'concurrency',
            'pressure',
            'taint',
            'abi',
            'simulate_fault',
          ],
          description: 'The audit action to perform.',
        },
        repo: repoProperty,
        legacyResponse: {
          type: 'boolean',
          description:
            'Forward legacy response mode to envelope-capable audit actions. Default: true. Set false to opt into the capability-aware response envelope where supported.',
          default: true,
        },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'refactor',
    description: 'Perform safe refactoring: rename symbols, replace bodies, or stage in sandbox.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['rename', 'replace', 'sandbox'],
          description: 'The refactoring action to perform.',
        },
        repo: repoProperty,
        target: {
          type: 'string',
          description: 'Symbol name or UID alias for rename/replace actions.',
        },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'manage',
    description: 'Manage OntoIndex sessions and internal route maps.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['session', 'route_map'],
          description: 'The management action to perform.',
        },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'docs',
    description:
      'Docs-specific safe agent tools over stabilized docs JSON contracts. Returns compact typed reports for docs trace, docs drift, docs context, and docs readiness without exposing raw docs graph queries.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['trace', 'drift', 'context', 'readiness'],
          description: 'The docs action to perform.',
        },
        repo: repoProperty,
        id: {
          type: 'string',
          description: 'Requirement id filter for action="trace".',
        },
        includeMemories: {
          type: 'boolean',
          description:
            'Opt in to advisory memory summary metadata for action="context" or "readiness". Ignored for trace/drift and never used as docs evidence or readiness authority.',
        },
        maxItems: {
          type: 'number',
          description: 'Maximum compact docs evidence items to return.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
        limit: {
          type: 'number',
          description: 'Alias for maxItems, for consistency with other bounded MCP tools.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
        cursor: {
          type: 'string',
          description:
            'Opaque cursor returned by a previous docs response. Keeps deterministic page boundaries for follow-up pages.',
        },
        summary: {
          type: 'boolean',
          description:
            'Return lighter JSON that keeps status, freshness, and warnings while omitting heavy nested evidence.',
          default: false,
        },
        minimal: {
          type: 'boolean',
          description: 'Return only the core result summary and next action.',
          default: false,
        },
        maxCandidatesPerFact: {
          type: 'number',
          description: 'Maximum ambiguous candidates retained per docs evidence fact.',
          default: 5,
          minimum: 1,
          maximum: 20,
        },
        format: {
          type: 'string',
          enum: ['json', 'inline', 'both'],
          description:
            'Optional derived formatter. Omitted/json returns canonical compact JSON only; inline/both also include inlineContext text derived from the JSON report.',
          default: 'json',
        },
        maxTokens: {
          type: 'number',
          description: 'Maximum estimated tokens for inlineContext when format is inline or both.',
          default: 900,
          minimum: 80,
          maximum: 4000,
        },
        maxEvidenceItems: {
          type: 'number',
          description: 'Maximum evidence bullets included in inlineContext.',
          default: 6,
          minimum: 1,
          maximum: 50,
        },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
];
