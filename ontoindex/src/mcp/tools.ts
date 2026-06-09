/**
 * MCP Tool Definitions
 *
 * Defines the tools that OntoIndex exposes to external AI agents.
 * All tools support an optional `repo` parameter for multi-repo setups.
 */

import { RETRIEVAL_POLICY_NAMES } from '../core/ingestion/enrichment/index.js';
import { CONTEXT_NEIGHBORHOOD_MODES } from './local/backend-context-neighborhood.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description?: string;
        default?: unknown;
        items?: { type: string };
        enum?: string[];
        minimum?: number;
        maximum?: number;
        minLength?: number;
      }
    >;
    required: string[];
    additionalProperties?: boolean;
  };
}

/**
 * Internal OntoIndex MCP Tool Handlers.
 * These are no longer exported as public tools, but are used by the facade dispatch layer.
 */
export const INTERNAL_TOOL_HANDLERS: ToolDefinition[] = [
  {
    name: 'list_repos',
    description: `List all indexed repositories available to OntoIndex.

Returns each repo's name, path, indexed date, last commit, and stats.

WHEN TO USE: First step when multiple repos are indexed, or to discover available repos.
AFTER THIS: READ ontoindex://repo/{name}/context for the repo you want to work with.

When multiple repos are indexed, you MUST specify the "repo" parameter
on other tools (query, context, impact, etc.) to target the correct one.`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'query',
    description: `Query the code knowledge graph for execution flows related to a concept.
Returns processes (call chains) ranked by relevance, each with its symbols and file locations.

WHEN TO USE: Understanding how code works together. Use this when you need execution flows and relationships, not just file matches. Complements grep/IDE search.
AFTER THIS: Use context() on a specific symbol for 360-degree view (callers, callees, categorized refs).

Returns results grouped by process (execution flow):
- processes: ranked execution flows with relevance priority
- process_symbols: all symbols in those flows with file locations and module (functional area)
- definitions: standalone types/interfaces not in any process

Hybrid ranking: BM25 keyword + semantic vector search, ranked by Reciprocal Rank Fusion.

GROUP MODE: set "repo" to "@<groupName>" to search all member repos in that group (merged via RRF), or "@<groupName>/<groupRepoPath>" to run against a single member (same path keys as in group.yaml). If you use "@<groupName>" only, the member repo defaults to the lexicographically first key in group.yaml "repos". Prefer resources for contracts/status (see migration from legacy group_* tools).

SERVICE: optional monorepo path prefix (POSIX-style, case-sensitive segments). When "repo" starts with "@", only processes whose symbols fall under that prefix are included. For a normal indexed repo name (no leading @), this field is currently ignored by the server.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword search query' },
        task_context: {
          type: 'string',
          description: 'What you are working on (e.g., "adding OAuth support"). Helps ranking.',
        },
        goal: {
          type: 'string',
          description:
            'What you want to find (e.g., "existing auth validation logic"). Helps ranking.',
        },
        limit: {
          type: 'number',
          description: 'Max processes to return (default: 5)',
          default: 5,
          minimum: 1,
          maximum: 100,
        },
        max_symbols: {
          type: 'number',
          description: 'Max symbols per process (default: 10)',
          default: 10,
          minimum: 1,
          maximum: 200,
        },
        include_content: {
          type: 'boolean',
          description: 'Include full symbol source code (default: false)',
          default: false,
        },
        retrieval_policy: {
          type: 'string',
          enum: [...RETRIEVAL_POLICY_NAMES],
          description:
            'Named retrieval expansion policy. Defaults to graph-only behavior unless explicitly set.',
        },
        consume_enrichment_facts: {
          type: 'boolean',
          description:
            'Opt in to consuming sidecar enrichment facts under the top-level enrichment envelope (default: false)',
          default: false,
        },
        include_passive_related_facts: {
          type: 'boolean',
          description:
            'Opt in to HippoRAG-style passive related fact metadata when consume_enrichment_facts is true (default: false)',
          default: false,
        },
        include_markdown_context: {
          type: 'boolean',
          description:
            'Opt in to Markdown document context metadata when consume_enrichment_facts and include_passive_related_facts are true (default: false)',
          default: false,
        },
        include_markdown_ppr: {
          type: 'boolean',
          description:
            'Opt in to bounded Markdown document-only PPR metadata when Markdown context is enabled (default: false)',
          default: false,
        },
        allow_low_confidence: {
          type: 'boolean',
          description:
            'Allow low-confidence sidecar enrichment records when consume_enrichment_facts is true (default: false)',
          default: false,
        },
        include_skeleton: {
          type: 'boolean',
          description:
            'Include AST skeleton (exported symbol names/line-ranges) for top result files (default: true). Set ONTOINDEX_SKELETON_DEFAULT=0 to change the default.',
          default: true,
        },
        repo: {
          type: 'string',
          description:
            'Indexed repository name or path, or group mode "@<groupName>" / "@<groupName>/<memberPath>" (member path keys from group.yaml). Omit when only one indexed repo exists.',
        },
        service: {
          type: 'string',
          minLength: 1,
          description:
            'Optional monorepo service root (relative path, "/" separators). In group mode (@repo), prefix-matches symbol file paths; ignored for a normal repo name. Empty string is rejected server-side.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'cypher',
    description: `Execute Cypher query against the code knowledge graph.

WHEN TO USE: Complex structural queries that search/explore can't answer. READ ontoindex://repo/{name}/schema first for the full schema.
AFTER THIS: Use context() on result symbols for deeper context.

SCHEMA:
- Nodes: File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process, Route, Tool
- Multi-language nodes (use backticks): \`Struct\`, \`Enum\`, \`Trait\`, \`Impl\`, etc.
- All edges via single CodeRelation table with 'type' property
- Edge types: CONTAINS, DEFINES, CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, ACCESSES, METHOD_OVERRIDES, METHOD_IMPLEMENTS, MEMBER_OF, STEP_IN_PROCESS, HANDLES_ROUTE, FETCHES, HANDLES_TOOL, ENTRY_POINT_OF
- Edge properties: type (STRING), confidence (DOUBLE), reason (STRING), step (INT32)

EXAMPLES:
• Find callers of a function:
  MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b:Function {name: "validateUser"}) RETURN a.name, a.filePath

• Find community members:
  MATCH (f)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community) WHERE c.heuristicLabel = "Auth" RETURN f.name

• Trace a process:
  MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process) WHERE p.heuristicLabel = "UserLogin" RETURN s.name, r.step ORDER BY r.step

• Find all methods of a class:
  MATCH (c:Class {name: "UserService"})-[r:CodeRelation {type: 'HAS_METHOD'}]->(m:Method) RETURN m.name, m.parameterCount, m.returnType

• Find all properties of a class:
  MATCH (c:Class {name: "User"})-[r:CodeRelation {type: 'HAS_PROPERTY'}]->(p:Property) RETURN p.name, p.declaredType

• Find all writers of a field:
  MATCH (f:Function)-[r:CodeRelation {type: 'ACCESSES', reason: 'write'}]->(p:Property) WHERE p.name = "address" RETURN f.name, f.filePath

• Find method overrides (MRO resolution):
  MATCH (winner:Method)-[r:CodeRelation {type: 'METHOD_OVERRIDES'}]->(loser:Method) RETURN winner.name, winner.filePath, loser.filePath, r.reason

• Detect diamond inheritance:
  MATCH (d:Class)-[:CodeRelation {type: 'EXTENDS'}]->(b1), (d)-[:CodeRelation {type: 'EXTENDS'}]->(b2), (b1)-[:CodeRelation {type: 'EXTENDS'}]->(a), (b2)-[:CodeRelation {type: 'EXTENDS'}]->(a) WHERE b1 <> b2 RETURN d.name, b1.name, b2.name, a.name

OUTPUT: Returns { markdown, row_count } — results formatted as a Markdown table for easy reading.

TIPS:
- All relationships use single CodeRelation table — filter with {type: 'CALLS'} etc.
- Community = auto-detected functional area (Leiden algorithm). Properties: heuristicLabel, cohesion, symbolCount, keywords, description, enrichedBy
- Process = execution flow trace from entry point to terminal. Properties: heuristicLabel, processType, stepCount, communities, entryPointId, terminalId
- Use heuristicLabel (not label) for human-readable community/process names`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Cypher query to execute' },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'context',
    description: `360-degree view of a single code symbol.
Shows categorized incoming/outgoing references (calls, imports, extends, implements, methods, properties, overrides), process participation, and file location.

WHEN TO USE: After query() to understand a specific symbol in depth. When you need to know all callers, callees, and what execution flows a symbol participates in.
AFTER THIS: Use impact() if planning changes, or READ ontoindex://repo/{name}/process/{processName} for full execution trace.

Handles disambiguation: if multiple symbols share the same name, returns ranked candidates (each with a relevance score) for you to pick from. Use uid for zero-ambiguity lookup, or narrow the search with file_path and/or kind hints.

Explicit context neighborhoods require neighborhood_mode and return bounded nodes, edges, docs evidence, freshness, and limit metadata. Omitting neighborhood_mode preserves the default context response.

NOTE: ACCESSES edges (field read/write tracking) are included in context results with reason 'read' or 'write'. CALLS edges resolve through field access chains and method-call chains (e.g., user.address.getCity().save() produces CALLS edges at each step).

GROUP MODE: set "repo" to "@<groupName>" to run context in each member repo (aggregated list), or "@<groupName>/<groupRepoPath>" for one member. If you use "@<groupName>" only, the member defaults to the lexicographically first key in group.yaml "repos".

SERVICE: optional monorepo path prefix (case-sensitive path segments). When "repo" starts with "@", prefix-matches resolved symbol file paths; when a hit is outside the prefix, that member returns an empty payload for the symbol. Ignored for a normal indexed repo name.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name (e.g., "validateUser", "AuthService")' },
        uid: {
          type: 'string',
          description: 'Direct symbol UID from prior tool results (zero-ambiguity lookup)',
        },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        kind: {
          type: 'string',
          description:
            "Kind filter to disambiguate common names (e.g. 'Function', 'Class', 'Method', 'Interface', 'Constructor')",
        },
        include_content: {
          type: 'boolean',
          description: 'Include full symbol source code (default: false)',
          default: false,
        },
        retrieval_policy: {
          type: 'string',
          enum: [...RETRIEVAL_POLICY_NAMES],
          description:
            'Named retrieval expansion policy. Defaults to graph-only behavior unless explicitly set.',
        },
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
        depth: {
          type: 'number',
          description: 'Maximum neighborhood traversal depth.',
          minimum: 1,
          maximum: 3,
        },
        limit: {
          type: 'number',
          description: 'Maximum nodes, edges, and docs evidence items.',
          minimum: 1,
          maximum: 100,
        },
        maxCandidates: {
          type: 'number',
          description: 'Maximum ambiguous identity candidates to return.',
          minimum: 1,
          maximum: 20,
        },
        consume_enrichment_facts: {
          type: 'boolean',
          description:
            'Opt in to consuming sidecar enrichment facts under the top-level enrichment envelope (default: false)',
          default: false,
        },
        allow_low_confidence: {
          type: 'boolean',
          description:
            'Allow low-confidence sidecar enrichment records when consume_enrichment_facts is true (default: false)',
          default: false,
        },
        repo: {
          type: 'string',
          description:
            'Indexed repository name or path, or group mode "@<groupName>" / "@<groupName>/<memberPath>". Omit if only one repo is indexed.',
        },
        service: {
          type: 'string',
          minLength: 1,
          description:
            'Optional monorepo service root (relative path). Applies in group mode (@repo) only; ignored for a normal repo name. Empty string is rejected server-side.',
        },
      },
      required: [],
    },
  },
  {
    name: 'detect_changes',
    description: `Analyze uncommitted git changes and find affected execution flows.
Maps git diff hunks to indexed symbols, then traces which processes are impacted.

WHEN TO USE: Before committing — to understand what your changes affect. Pre-commit review, PR preparation.
AFTER THIS: Review affected processes. Use context() on high-risk symbols. READ ontoindex://repo/{name}/process/{name} for full traces.
POST-EDIT VERIFICATION: detect_changes remains available for diff impact. For explicit write-through verification, use gn_verify_diff(), gn_test_gap(), or gn_worker_scope_review().

Returns: changed symbols, affected processes, and a risk summary.`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'What to analyze: "unstaged" (default), "staged", "all", or "compare"',
          enum: ['unstaged', 'staged', 'all', 'compare'],
          default: 'unstaged',
        },
        base_ref: {
          type: 'string',
          description: 'Branch/commit for "compare" scope (e.g., "main")',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'cycle_detect',
    description: `Detect circular dependencies in the code graph.
Finds strongly connected components over IMPORTS and/or CALLS edges, then reports the components that form cycles.

WHEN TO USE: Before a major refactor, when incremental builds feel sticky, or when a subsystem seems impossible to untangle. Import cycles are especially useful for build/layering work; call cycles are useful for behavioral entanglement.
AFTER THIS: Use impact() on any cycle member to understand blast radius. For raw edge inspection, use context() or cypher().

OUTPUT:
- cycles: SCCs with more than one member (or self-loops when min_cycle_length = 1), sorted by size
- each cycle: members [{ id, name, filePath, kind }], edge_types present inside the cycle, cycle_length, affected_files
- summary: total_cycles, largest_cycle_size, affected_files`,
    inputSchema: {
      type: 'object',
      properties: {
        edge_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge types to include (default: ["IMPORTS", "CALLS"])',
        },
        min_cycle_length: {
          type: 'number',
          description: 'Minimum cycle length to report (default: 2)',
          default: 2,
          minimum: 1,
          maximum: 1000,
        },
        file_filter: {
          type: 'string',
          description: 'Glob pattern limiting the analyzed subgraph (e.g. "browser/src/**")',
        },
        limit: {
          type: 'number',
          description: 'Max cycles to return (default: 30)',
          default: 30,
          minimum: 1,
          maximum: 200,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'coupling_matrix',
    description: `Compute module coupling metrics (fan-in, fan-out, instability) per community/module.

Based on Robert Martin's package metrics:
- Ca (afferent): incoming edges from other modules
- Ce (efferent): outgoing edges to other modules
- Instability = Ce / (Ca + Ce). Range 0..1. 0 = maximally stable, 1 = maximally unstable.

WHEN TO USE:
- "Which modules are safe to change?" — low instability means many dependents
- "Which modules have too many responsibilities?" — high Ce means too many outbound deps
- "Find isolated/orphan modules" — Ca=0 and Ce=0

OUTPUT: communities ranked by instability with Ca, Ce, symbol counts, and optional cross-community edge examples.`,
    inputSchema: {
      type: 'object',
      properties: {
        min_symbols: {
          type: 'number',
          description: 'Minimum symbol count to include a module (default: 5)',
          default: 5,
          minimum: 0,
          maximum: 100000,
        },
        flag_threshold: {
          type: 'number',
          description: 'Instability threshold to flag as HIGH (default: 0.8)',
          default: 0.8,
          minimum: 0,
          maximum: 1,
        },
        include_cross_edges: {
          type: 'boolean',
          description: 'Include example cross-module edge pairs in output (default: false)',
          default: false,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'migration_progress',
    description: `Track completion of a codebase-wide migration from one pattern to another.
Scans matching files for regex patterns and reports remaining legacy usage versus replacement usage.

WHEN TO USE:
- "How far along is the setTimeout → timerRegistry migration?"
- "How many files still use the legacy auth API?"
- Sprint tracking by module/community

OUTPUT:
- summary: total_old_sites, total_new_sites, pct_migrated, files_remaining
- by_module: per-community breakdown
- remaining_files: files still containing old_pattern
- done_files: files with new_pattern but zero old_pattern`,
    inputSchema: {
      type: 'object',
      properties: {
        old_pattern: {
          type: 'string',
          description: 'Regex matching the legacy/old pattern to phase out',
        },
        new_pattern: {
          type: 'string',
          description: 'Regex matching the new/replacement pattern',
        },
        file_glob: {
          type: 'string',
          description: 'Glob limiting which files to scan (e.g. "browser/src/**/*.ts")',
        },
        exclude_patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'File glob patterns to exclude',
        },
        label: {
          type: 'string',
          description: 'Human-readable migration label for report headers',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['old_pattern', 'new_pattern'],
    },
  },
  {
    name: 'boundary_violations',
    description: `Detect imports or calls that violate declared architecture layer boundaries.
Given a set of rules (from_glob → to_glob must not exist), scans CALLS/IMPORTS edges for violations.

WHEN TO USE:
- "Does browser/ ever import from wsd/ directly?"
- "Does common/ import from browser/?"
- CI gate for architecture rule enforcement

RULE FORMAT: array of { from, to, label?, forbidden_edge_types? } or a JSON file containing that array.

OUTPUT:
- violations: offending edges with source file, target file, edge type, and rule label
- summary: rules_checked, rules_clean, rules_violated, total_violations
- clean_rules: rules with no violations`,
    inputSchema: {
      type: 'object',
      properties: {
        rules: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Array of { from: string, to: string, label?: string, forbidden_edge_types?: string[] }',
        },
        rules_file: {
          type: 'string',
          description: 'Path to a JSON file containing the rules array',
        },
        limit_per_rule: {
          type: 'number',
          description: 'Max violations to return per rule (default: 20)',
          default: 20,
          minimum: 1,
          maximum: 200,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'type_coverage',
    description: `Audit TypeScript/JavaScript type-safety hygiene.
Finds explicit any, non-null assertions, unsafe casts, and TypeScript suppression comments, then ranks them by enclosing function caller count.

WHEN TO USE:
- "Where are the worst type-safety holes?"
- Before stricter TS migrations
- To prioritize unsafe syntax in widely-called functions

OUTPUT: ranked findings with file, line, pattern type, enclosing symbol callerCount, and composite risk score.`,
    inputSchema: {
      type: 'object',
      properties: {
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Patterns to check (default: all): explicit_any, non_null_assertion, unsafe_cast, type_suppression',
        },
        file_glob: {
          type: 'string',
          description: 'Limit scan to files matching glob (e.g. "browser/src/**/*.ts")',
        },
        min_caller_count: {
          type: 'number',
          description: 'Only return symbols with at least this many callers (default: 0)',
          default: 0,
          minimum: 0,
          maximum: 100000,
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 50)',
          default: 50,
          minimum: 1,
          maximum: 500,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'rename',
    description: `Multi-file coordinated rename using the knowledge graph + text search.
Finds all references via graph (high confidence) and regex text search (lower confidence). Preview by default.

WHEN TO USE: Renaming a function, class, method, or variable across the codebase. Safer than find-and-replace.
AFTER THIS: Run gn_verify_diff() and gn_test_gap() to verify no unexpected side effects.

Each edit is tagged with confidence:
- "graph": found via knowledge graph relationships (high confidence, safe to accept)
- "text_search": found via regex text search (lower confidence, review carefully)`,
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: { type: 'string', description: 'Current symbol name to rename' },
        symbol_uid: {
          type: 'string',
          description: 'Direct symbol UID from prior tool results (zero-ambiguity)',
        },
        new_name: { type: 'string', description: 'The new name for the symbol' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        dry_run: {
          type: 'boolean',
          description: 'Preview edits without modifying files (default: true)',
          default: true,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['new_name'],
    },
  },
  {
    name: 'impact',
    description: `Analyze the blast radius of changing a code symbol.
Returns affected symbols grouped by depth, plus risk assessment, affected execution flows, and affected modules.

WHEN TO USE: Before making code changes — especially refactoring, renaming, or modifying shared code. Shows what would break.
AFTER THIS: Review d=1 items (WILL BREAK). Use context() on high-risk symbols.

Output includes:
- risk: LOW / MEDIUM / HIGH / CRITICAL
- summary: direct callers, processes affected, modules affected
- affected_processes: which execution flows break and at which step
- affected_modules: which functional areas are hit (direct vs indirect)
- byDepth: all affected symbols grouped by traversal depth

Depth groups:
- d=1: WILL BREAK (direct callers/importers)
- d=2: LIKELY AFFECTED (indirect)
- d=3: MAY NEED TESTING (transitive)

TIP: Default traversal uses CALLS/IMPORTS/EXTENDS/IMPLEMENTS. For class members, include HAS_METHOD and HAS_PROPERTY in relationTypes. For field access analysis, include ACCESSES in relationTypes.

Handles disambiguation: when multiple symbols share the target name, returns ranked candidates (each with a relevance score) instead of silently picking one. Use target_uid for zero-ambiguity lookup, or narrow with file_path and/or kind hints.

EdgeType: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, METHOD_OVERRIDES, METHOD_IMPLEMENTS, ACCESSES
Confidence: 1.0 = certain, <0.8 = fuzzy match

GROUP MODE: set "repo" to "@<groupName>" for cross-repo impact anchored at the default member (lexicographically first key in group.yaml "repos"), or "@<groupName>/<groupRepoPath>" to choose the member (same path keys as in group.yaml). Phase-1 walk runs in that member; cross-boundary fan-out uses the group bridge.

SERVICE: optional monorepo path prefix (case-sensitive path segments). When "repo" starts with "@", scopes the local impact walk and cross-repo symbol paths to files under that prefix; ignored for a normal indexed repo name.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name of function, class, or file to analyze' },
        target_uid: {
          type: 'string',
          description:
            'Direct symbol UID from prior tool results (zero-ambiguity lookup, skips target resolution)',
        },
        direction: {
          type: 'string',
          description: 'upstream (what depends on this) or downstream (what this depends on)',
        },
        file_path: {
          type: 'string',
          description: 'File path hint to disambiguate common names',
        },
        kind: {
          type: 'string',
          description:
            "Kind filter to disambiguate common names (e.g. 'Function', 'Class', 'Method', 'Interface', 'Constructor')",
        },
        maxDepth: {
          type: 'number',
          description: 'Max relationship depth (default: 3, server clamps to 1–32)',
          default: 3,
          minimum: 1,
          maximum: 32,
        },
        crossDepth: {
          type: 'number',
          description:
            'Cross-repository hop depth via contract bridge (default: 1; values above server maximum are clamped)',
          default: 1,
          minimum: 1,
          maximum: 32,
        },
        relationTypes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, METHOD_OVERRIDES, METHOD_IMPLEMENTS, ACCESSES (default: usage-based, ACCESSES excluded by default)',
        },
        includeTests: { type: 'boolean', description: 'Include test files (default: false)' },
        minConfidence: {
          type: 'number',
          description:
            'Minimum edge confidence 0–1 (default: 0 when omitted; server clamps to 0–1)',
          default: 0,
          minimum: 0,
          maximum: 1,
        },
        repo: {
          type: 'string',
          description:
            'Indexed repository name or path, or group mode "@<groupName>" / "@<groupName>/<memberPath>". Omit if only one repo is indexed.',
        },
        service: {
          type: 'string',
          minLength: 1,
          description:
            'Optional monorepo service root (relative path). Applies when "repo" is group mode (@…); ignored for a normal repo name. Empty string is rejected server-side.',
        },
        subgroup: {
          type: 'string',
          description:
            'Optional group subgroup prefix (member repo paths) limiting which repos participate in cross fan-out.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Wall-clock budget in milliseconds for the Phase-1 local impact leg (default 30000)',
          minimum: 1,
          maximum: 3600000,
        },
        timeout: {
          type: 'number',
          description: 'Alias of timeoutMs (milliseconds) when timeoutMs is omitted',
          minimum: 1,
          maximum: 3600000,
        },
        consume_enrichment_facts: {
          type: 'boolean',
          description:
            'Opt in to consuming sidecar enrichment facts under the top-level enrichment envelope (default: false)',
          default: false,
        },
        allow_low_confidence: {
          type: 'boolean',
          description:
            'Allow low-confidence sidecar enrichment records when consume_enrichment_facts is true (default: false)',
          default: false,
        },
        allow_safety_critical_enrichment: {
          type: 'boolean',
          description:
            'Allow sidecar enrichment fact consumption for safety-critical impact analysis (default: false)',
          default: false,
        },
      },
      required: ['target', 'direction'],
    },
  },
  {
    name: 'route_map',
    description: `Show API route mappings: which components/hooks fetch which API endpoints, and which handler files serve them.

WHEN TO USE: Understanding API consumption patterns, finding orphaned routes. For pre-change analysis, prefer \`api_impact\` which combines this data with mismatch detection and risk assessment.
AFTER THIS: Use impact() on specific route handlers to see full blast radius.

Returns: route nodes with their handlers, middleware wrapper chains (e.g., withAuth, withRateLimit), and consumers.`,
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description: 'Filter by route path (e.g., "/api/grants"). Omit for all routes.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'tool_map',
    description: `Show MCP/RPC tool definitions: which tools are defined, where they're handled, and their descriptions.

WHEN TO USE: Understanding tool APIs, finding tool implementations, impact analysis for tool changes.

Returns: tool nodes with their handler files and descriptions.`,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Filter by tool name. Omit for all tools.' },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: [],
    },
  },
  {
    name: 'shape_check',
    description: `Check response shapes for API routes against their consumers' property accesses.

WHEN TO USE: Detecting mismatches between what an API route returns and what consumers expect. Finding shape drift. For pre-change analysis, prefer \`api_impact\` which combines this data with mismatch detection and risk assessment.
REQUIRES: Route nodes with responseKeys (extracted from .json({...}) calls during indexing).

Returns routes that have both detected response keys AND consumers. Shows top-level keys each endpoint returns (e.g., data, pagination, error) and what keys each consumer accesses. Reports MISMATCH status when a consumer accesses keys not present in the route's response shape.`,
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description: 'Check a specific route (e.g., "/api/grants"). Omit to check all routes.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'analysis_catalog',
    description: `List OntoIndex analysis packs and suites discovered from local pack manifests.

WHEN TO USE: Understanding which CodeQL-style analysis packs are available in the current repo, which suites bundle them, and which packs are stable vs experimental.
AFTER THIS: READ ontoindex://repo/{name}/analysis-packs or ontoindex://repo/{name}/analysis-suites for the same catalog as structured resources.

Returns: discovered pack manifests, suite manifests, summary counts, and manifest validation errors.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Optional pack kind filter: library, query, or model.',
          enum: ['library', 'query', 'model'],
        },
        tier: {
          type: 'string',
          description: 'Optional lifecycle tier filter: stable or experimental.',
          enum: ['stable', 'experimental'],
        },
        id: {
          type: 'string',
          description: 'Optional substring filter against pack/suite ids and names.',
        },
        target: {
          type: 'string',
          description:
            'Optional exact pack or suite id to resolve into an execution plan (expands suite -> packs -> tool runs).',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'api_impact',
    description: `Pre-change impact report for an API route handler.

WHEN TO USE: BEFORE modifying any API route handler. Shows what consumers depend on, what response fields they access, what middleware protects the route, and what execution flows it triggers. Requires at least "route" or "file" parameter.

Risk levels: LOW (0-3 consumers), MEDIUM (4-9 or any mismatches), HIGH (10+ consumers or mismatches with 4+ consumers). Mismatches with confidence "low" indicate the consumer file fetches multiple routes — property attribution is approximate.

Returns: single route object when one match, or { routes: [...], total: N } for multiple matches. Combines route_map, shape_check, and impact data.`,
    inputSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', description: 'Route path (e.g., "/api/grants")' },
        file: { type: 'string', description: 'Handler file path (alternative to route)' },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: [],
    },
  },
  {
    name: 'group_list',
    description: `List all configured repository groups, or return details for one group (repos, manifest links).

WHEN TO USE: Discover groups before group_sync. Optional "name" returns a single group's config.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name. Omit to list all groups.' },
      },
      required: [],
    },
  },
  {
    name: 'group_sync',
    description: `Rebuild the Contract Registry (contracts.json) for a group: extract HTTP contracts, apply manifest links, exact-match cross-links.

WHEN TO USE: After changing group.yaml or re-indexing member repos.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        skipEmbeddings: {
          type: 'boolean',
          description: 'Exact + BM25 only (Demo PR: same as default exact path)',
        },
        exactOnly: { type: 'boolean', description: 'Exact match only in cascade' },
      },
      required: ['name'],
    },
  },
  {
    name: 'route',
    description: `Intent classifier — maps a natural-language question to the best OntoIndex tool.

WHEN TO USE:
- You have a free-form question and are unsure whether to call query, context, impact, or repomap.
- You want a one-shot suggestion (tool name + reason + example invocation) before making the real call.

HOW IT WORKS:
Keyword-based heuristic over the question text. Recognized intents:
- "what calls" / "who calls" / "callers of" → context
- "break" / "safe to change" / "what breaks" / "impact" → impact
- "how does" / "how works" / "architecture" / "flow" → query
- "show me the files" / "structure" / "overview of the repo" → repomap
- Anything else → query (default)

OUTPUT: { tool, reason, suggestion } with a ready-to-use tool invocation.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The natural-language question to classify.',
        },
        repo: {
          type: 'string',
          description: 'Repository name (optional, auto-detected if only one repo indexed)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'session',
    description: `Persistent key-value session store for agents, scoped to the indexed repo.

Session data lives under <repoPath>/.ontoindex/sessions/<session_id>.json with a 1 MB cap per session. Session IDs must not contain path separators.

WHEN TO USE:
- Preserve agent state across conversations (e.g. a plan outline, a list of files to revisit).
- Share small structured context between MCP tool invocations in a long-running task.

ACTIONS:
- get({ session_id, key }) → returns { value } or { value: null } if missing.
- set({ session_id, key, value }) → writes and returns { status: "success" }.
- list({ session_id }) → returns { keys: [...] } for the session file.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'One of "get", "set", "list".',
          enum: ['get', 'set', 'list'],
        },
        session_id: {
          type: 'string',
          description: 'Session identifier. Must not contain "/" or "\\".',
        },
        key: {
          type: 'string',
          description: 'Key to read or write. Required for get/set.',
        },
        value: {
          type: 'string',
          description: 'Value to store. Required for set.',
        },
        repo: {
          type: 'string',
          description: 'Repository name (optional, auto-detected if only one repo indexed)',
        },
      },
      required: ['action', 'session_id'],
    },
  },
  {
    name: 'audit_rerun',
    description: `Re-verify existing audit findings against live code.
Loads an audit JSON file and re-scans the relevant files to see if findings still exist or have been fixed.

WHEN TO USE: Checking progress on an audit, or verifying that reported issues have actually been resolved.
AFTER THIS: Update the audit file status based on the results.`,
    inputSchema: {
      type: 'object',
      properties: {
        audit_file: {
          type: 'string',
          description: 'Path to the audit JSON file (e.g., "audits/security.json").',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['audit_file'],
    },
  },
  {
    name: 'build_residue_audit',
    description: `Detect forbidden domains or "residue" in build/source files.
Scans for terms like "PdfFile", "Print", or "presentation" that shouldn't be in the final build.

WHEN TO USE: Pre-release check or when verifying that feature-flagged code or forbidden domains are not leaking into builds.`,
    inputSchema: {
      type: 'object',
      properties: {
        forbidden_domains: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of forbidden domains to scan for (e.g., ["PdfFile", "Print"]). Defaults to a standard set if omitted.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'cross_doc_drift',
    description: `Detect contradictions between project plans, state docs, and audit findings.
Identifies items marked as "done" or "resolved" in plans that still have open findings in audit files.

WHEN TO USE: Verifying project status or ensuring that audit remediation is correctly reflected in documentation.
AFTER THIS: Update plans or resolve remaining audit items based on the identified drift.`,
    inputSchema: {
      type: 'object',
      properties: {
        plan_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of Markdown plan files to check. Defaults to docs/**/*.md if omitted.',
        },
        audit_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of Audit JSON files to check. Defaults to audits/*.json if omitted.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'evidence_pack',
    description: `Resolve symbols, files, or specific line references to exact code evidence (snippets).
Returns exact file locations and code snippets with context.

WHEN TO USE: Collecting evidence for an audit, or when you need the exact implementation of multiple symbols at once.
AFTER THIS: Review the snippets to understand implementation details or to verify audit findings.`,
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of symbols (e.g., "login"), files (e.g., "src/auth.ts"), or path:line (e.g., "src/auth.ts:123").',
        },
        include_snippet: {
          type: 'boolean',
          description: 'Include code snippets in the response (default: true)',
          default: true,
        },
        context_lines: {
          type: 'number',
          description: 'Number of lines of context around each hit (default: 3)',
          default: 3,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['targets'],
    },
  },
  {
    name: 'pattern_audit',
    description: `Detect risky code patterns (leaks, overlaps, weak checks) in the codebase.
Scans for patterns like "addEventListener" (potential leak), "setInterval(async" (overlap risk), or ".innerHTML" (XSS risk).

WHEN TO USE: Security or performance audit, or when looking for common implementation pitfalls.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'verification_gap',
    description: `Identify missing test coverage for changed code.
Compares changed source files (since a base commit) against existing test files and call traces in the graph.

WHEN TO USE: After making changes but before submitting a PR, to ensure everything is covered by tests.
AFTER THIS: Add tests for any reported gaps.`,
    inputSchema: {
      type: 'object',
      properties: {
        base_ref: {
          type: 'string',
          description: 'Base git reference to compare against (default: "HEAD~1").',
          default: 'HEAD~1',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'ipc_trace',
    description: `Trace execution flows across the JS-to-C++ (Native) bridge.
Finds how a JavaScript call connects to its underlying C++ implementation by tracing Node-API registrations and bridge files.

WHEN TO USE: Auditing sensitive logic that spans both JS and C++, or when debugging native addon integration.
AFTER THIS: Review the flow steps to understand the full cross-language call chain.`,
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: {
          type: 'string',
          description: 'The name of the function or symbol to trace (e.g., "scanAuditPatterns").',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['symbol_name'],
    },
  },
  {
    name: 'requirements_trace',
    description: `Map requirement IDs (e.g., "REQ-001") to implementation and test code.
Scans the codebase for requirement IDs in comments or strings and generates a traceability report.

WHEN TO USE: Compliance audits, verifying requirement coverage, or generating a Traceability Matrix.
AFTER THIS: Review the coverage status and add missing implementation or tests for requirements.`,
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Specific list of requirement IDs to trace. If omitted, discovers all IDs matching id_pattern.',
        },
        id_pattern: {
          type: 'string',
          description:
            'Regex pattern used to discover requirement IDs (default: "[A-Z]{2,}-\\\\d+").',
          default: '[A-Z]{2,}-\\d+',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'impact_batch',
    description: `Analyze the combined blast radius of changing multiple code symbols simultaneously.
Compute upstream/downstream impact for N symbols in a single batch operation.

WHEN TO USE: Refactoring multiple related symbols, assessing impact of a PR that changes 5+ functions, or determining if changes can be merged independently.
Output includes per-symbol impact + union statistics (shared callers, total blast radius).

BENEFIT: Processes N symbols ~2x slower than 1 symbol (not N times slower like N serial impact() calls).

Output:
- perSymbol: impact result for each target (same format as impact() tool)
- union: combined statistics (totalAffectedNodes, totalRelationships, risk level)`,
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of function/class/file names to analyze together',
        },
        direction: {
          type: 'string',
          description: 'upstream (what depends on these) or downstream (what these depend on)',
        },
        maxDepth: {
          type: 'number',
          description: 'Max relationship depth (default: 3)',
          default: 3,
        },
        relationTypes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, OVERRIDES, ACCESSES (default: usage-based, ACCESSES excluded by default)',
        },
        includeTests: { type: 'boolean', description: 'Include test files (default: false)' },
        minConfidence: { type: 'number', description: 'Minimum confidence 0-1 (default: 0.7)' },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['targets', 'direction'],
    },
  },
  {
    name: 'hotspot_analysis',
    description: `Identify high-risk code hotspots by combining git history (churn, authors) with graph structure (callers, complexity).

WHEN TO USE:
- "What should I refactor first?" — find code that is both complex AND frequently modified
- "Where are the landmines?" — discover high-churn code with many dependents
- "Who should review this PR?" — ownership analysis for changed files
- "What files silently change together?" — discover hidden coupling the call graph misses

METRICS:
- churn_x_complexity: Files ranked by (commit frequency × caller count). High = dangerous.
- change_coupling: File pairs that co-change in >30% of commits but may lack call/import edges.
- ownership: Files ranked by author count + recent activity.

OUTPUT: Ranked list of hotspots with scores, file paths, and actionable context.`,
    inputSchema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          description:
            'Analysis type: "churn_x_complexity" (default), "change_coupling", or "ownership"',
          enum: ['churn_x_complexity', 'change_coupling', 'ownership'],
          default: 'churn_x_complexity',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 20)',
          default: 20,
        },
        since: {
          type: 'string',
          description:
            'Time window for git history (default: "6 months"). Examples: "3 months", "1 year"',
          default: '6 months',
        },
        repo: {
          type: 'string',
          description: 'Repository name (optional)',
        },
      },
      required: [],
    },
  },
  {
    name: 'graph_diff',
    description: `Compare the current dependency graph against a previous snapshot to find structural changes: added/removed edges, new cross-module couplings, and symbols that gained or lost callers.

WHEN TO USE:
- "What changed structurally since last analysis?" — see new/removed dependency edges
- "Did any new cross-module couplings appear?" — detect architectural drift
- "Which functions gained new callers?" — find dependency growth
- Before merging: verify no unwanted structural changes crept in

HOW IT WORKS:
1. Loads the saved snapshot (from last successful 'ontoindex analyze')
2. Queries the current graph for all CALLS/IMPORTS edges
3. Diffs: edges in current but not snapshot (added), edges in snapshot but not current (removed)
4. Flags cross-community edges (architectural boundary crossings)

OUTPUT: Added/removed edges with source/target info, cross-community flags, and summary stats.`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum edges to return per category (default: 50)',
          default: 50,
        },
        repo: {
          type: 'string',
          description: 'Repository name (optional)',
        },
      },
      required: [],
    },
  },
  {
    name: 'tech_debt',
    description: `Identify the riskiest symbols in the codebase by combining structural complexity (line count, parameter count, caller count) with git churn (commit frequency).

WHEN TO USE:
- "What are the most dangerous functions to change?" — find symbols that are complex, heavily depended on, AND frequently modified
- "Where should I refactor first?" — prioritized list of tech debt targets
- "What has the highest blast radius AND complexity?" — combination of impact + complexity analysis

SCORING:
Each symbol gets a composite risk score = (lineCount/20) × (callerCount+1) × (parameterCount/3+1) × log2(commits+1).
Higher score = more dangerous to change and more beneficial to simplify.

OUTPUT: Ranked list of symbols with risk scores, line counts, caller counts, parameter counts, and git churn data.`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 20)',
          default: 20,
        },
        min_lines: {
          type: 'number',
          description: 'Minimum line count to include (default: 10)',
          default: 10,
        },
        since: {
          type: 'string',
          description:
            'Time window for git churn (default: "6 months"). Examples: "3 months", "1 year"',
          default: '6 months',
        },
        repo: {
          type: 'string',
          description: 'Repository name (optional)',
        },
      },
      required: [],
    },
  },
  {
    name: 'dead_code',
    description: `Identify unreachable code via mark-and-sweep reachability from entry points.

WHEN TO USE:
- "What code is actually dead?" — find Function/Method/Class/Constructor nodes that nothing reaches
- "What can we safely delete?" — prioritized list of removal candidates with confidence buckets
- Pre-refactor cleanup: discover orphans that accumulated since last audit

HOW IT WORKS:
1. Seed roots = (a) exported symbols (isExported=true), (b) test-file contents, (c) entry-point files (index.*, main.*, cli/*, bin/*)
2. BFS forward through CALLS / IMPORTS / DEFINES / HAS_METHOD / HAS_PROPERTY / EXTENDS / IMPLEMENTS / OVERRIDES / METHOD_OVERRIDES edges
3. Any Function / Method / Class / Constructor not in the reached set is flagged

OUTPUT BUCKETS:
- unreached: not reachable from any root — high-confidence dead
- test_only: only reachable via test-file roots — candidate if the test itself is redundant
- exported_uncalled: exported but no internal call — may be public API consumed externally (review manually)

Each entry carries includes_deprecated_tag: boolean — true when the file region near the symbol's startLine contains a @deprecated or @internal JSDoc tag. Use this to prioritise safe deletions or suppress false-positive noise.

FALSE POSITIVES: framework-invoked handlers (Express routes, React components in JSX), decorators, reflection, dynamic require(), event handlers registered at runtime. Treat output as a review queue, not an auto-delete list.

VERIFICATION PASS (default on): after BFS, every candidate is re-checked with the id-anchored match used by \`context\`. If any incoming edge exists that the bulk BFS missed, the candidate is dropped and counted in verifiedReachableCount. Disable with verify=false for a faster, noisier sweep.

CHURN SIGNAL: each entry includes \`confidence: 'high'|'medium'|'low'\` derived from 90-day git churn on the entry's file (high=0 commits, medium=1–2, low=3+). When repoPath is unavailable, confidence defaults to 'medium'. Use min_stale_days to restrict results to files with no recent commits.`,
    inputSchema: {
      type: 'object',
      properties: {
        include_tests: {
          type: 'boolean',
          description:
            'Treat test files as reachability roots (default: true). Set false to also flag test-only symbols as dead.',
          default: true,
        },
        include_exported: {
          type: 'boolean',
          description:
            'Include the exported_uncalled bucket (exported symbols with no internal caller). Default: true.',
          default: true,
        },
        verify: {
          type: 'boolean',
          description:
            'Re-check each candidate with an id-anchored incoming-ref query (same pattern as context). Filters false positives the bulk BFS missed. Default: true.',
          default: true,
        },
        limit: {
          type: 'number',
          description: 'Maximum dead-symbol entries to return (default: 200)',
          default: 200,
        },
        min_stale_days: {
          type: 'number',
          description:
            'Only return entries whose file has 0 commits in the last N days. Omit to return all entries with confidence annotations.',
        },
        exclude_patterns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Glob patterns for file paths or symbol names to exclude from results. Applied after BFS; matched entries are counted in suppressed_count but not returned.',
        },
        includeIgnored: {
          type: 'boolean',
          description:
            'Include paths that repository policy would otherwise filter as ignored or generated. Default: false.',
          default: false,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'sandbox',
    description: `Stage or apply a batch of mutations inside a sandboxed transaction.

WHEN TO USE: Preview multi-step edits (stage) before committing them (apply). "stage" is idempotent and gate-free; "apply" requires { confirm: true } AND a backend started with --confirm-writes. Missing either fails closed.

Current surface is the confirmation gate only — the write path is wired but deferred, so callers can depend on the safety contract today.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['stage', 'apply'],
          description: 'stage (default) or apply',
        },
        confirm: {
          type: 'boolean',
          description: 'Required for action="apply". Must be true to proceed.',
        },
        payload: {
          type: 'object',
          description: 'Caller-defined mutation payload (opaque to the gate).',
        },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: [],
    },
  },
  {
    name: 'repomap',
    description: `Graph-ranked context summary for AI agents. Returns the most relevant symbols and their relationships within a token budget, ranked by personalized PageRank.

WHEN TO USE:
- Before editing code: get the most important context for the files you're about to change
- Understanding unfamiliar code: find the highest-impact symbols near your focus area
- Context window management: fit maximum relevant context into a limited token budget

HOW IT WORKS:
1. Runs personalized PageRank on the call/import graph, boosting your focus files
2. Ranks all symbols by graph importance relative to your edit context
3. Serializes top-ranked symbols (name, type, signature, key relationships) within token budget
4. Returns structured context that fits exactly within your budget

OUTPUT: Ranked symbols with signatures, callers/callees, and process participation.
Unlike query() which searches by keyword, repomap ranks by GRAPH PROXIMITY to your focus.`,
    inputSchema: {
      type: 'object',
      properties: {
        focus: {
          type: 'array',
          description:
            'File paths or symbol names to focus on (seeds for PageRank). These are the files/symbols you are editing or investigating.',
          items: { type: 'string' },
        },
        token_budget: {
          type: 'number',
          description:
            'Maximum number of tokens in the response (default: 4000). Controls how many symbols are included.',
          default: 4000,
        },
        format: {
          type: 'string',
          description:
            'Output format: "signatures" (compact), "outline" (medium), "full" (verbose), "compressed" (signature-only bodies)',
          enum: ['signatures', 'outline', 'full', 'compressed'],
          default: 'signatures',
        },
        repo: {
          type: 'string',
          description: 'Repository name (optional, auto-detected if only one repo indexed)',
        },
      },
      required: ['focus'],
    },
  },
  {
    name: 'replace_symbol',
    description: `Structured rewrite of a symbol's body, addressed by graph UID.

WHEN TO USE: AST-accurate replacement of a function/method body without touching signature, decorators, or surrounding comments. Always preview with { dry_run: true } first, then rerun with { dry_run: false, confirm: true } to write.

Two-layer gate: non-dry runs require BOTH { confirm: true } on the call AND a backend started with --confirm-writes. Missing call confirm throws "Explicit confirmation required"; a backend with writes disabled throws "Write operations are disabled" even when the caller confirmed.`,
    inputSchema: {
      type: 'object',
      properties: {
        uid: {
          type: 'string',
          description: 'Graph UID of the target symbol (e.g. "Function:validateUser").',
        },
        new_body: { type: 'string', description: 'Replacement body source (no signature).' },
        dry_run: {
          type: 'boolean',
          description: 'Preview only — skips the gate and returns { success, dry_run: true }.',
        },
        confirm: {
          type: 'boolean',
          description: 'Required when dry_run is false. Must be true to proceed.',
        },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'get_symbol_info',
    description: `Get structural metadata and full source for a symbol by its graph UID.

WHEN TO USE: Before editing a symbol with update_symbol_body. Ensures you have the exact implementation and context.`,
    inputSchema: {
      type: 'object',
      properties: {
        uid: {
          type: 'string',
          description: 'Graph UID of the symbol (e.g. "Function:src/auth.ts:login")',
        },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'update_symbol_body',
    description: `Replace the implementation of a function, method, or class body using its graph UID.

WHEN TO USE: Precision editing without line-number drift. OntoIndex handles the AST-accurate replacement.
GATE: Requires --confirm-writes on the backend.`,
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Graph UID of the symbol' },
        new_body: { type: 'string', description: 'The new source code for the symbol body' },
        dry_run: { type: 'boolean', description: 'Preview change only', default: true },
        confirm: { type: 'boolean', description: 'Required for write operations', default: false },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: ['uid', 'new_body'],
    },
  },
  {
    name: 'rename_symbol',
    description: `Rename a symbol across the entire codebase using its graph UID.

WHEN TO USE: After get_symbol_info to get the UID, when you need zero-ambiguity rename.
Safer than rename() for common names (e.g., "init", "run") where string matching is ambiguous.
Uses the same graph+text-search engine as rename() but anchored by UID.
AFTER THIS: Run gn_verify_diff() and gn_test_gap() to verify no unexpected side effects.`,
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Graph UID of the symbol (from get_symbol_info)' },
        new_name: { type: 'string', description: 'New name for the symbol' },
        dry_run: { type: 'boolean', description: 'Preview only (default: true)', default: true },
        confirm: {
          type: 'boolean',
          description: 'Required for write (dry_run: false)',
          default: false,
        },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: ['uid', 'new_name'],
    },
  },
  {
    name: 'extract_function',
    description: `Extract a function or method into a named helper using its graph UID.

WHEN TO USE: To split a long function into smaller helpers without breaking call sites.
GATE: requires --confirm-writes server flag and confirm:true param.
AFTER THIS: Run gn_verify_diff() and gn_test_gap() to verify no unexpected side effects.`,
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Graph UID of the source symbol.' },
        new_name: { type: 'string', description: 'Name for the extracted helper.' },
        target_file: {
          type: 'string',
          description: 'Optional file path to place the helper. Defaults to the same file.',
        },
        dry_run: { type: 'boolean', description: 'Preview only (default: true).', default: true },
        confirm: {
          type: 'boolean',
          description: 'Required for write (dry_run: false).',
          default: false,
        },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: ['uid', 'new_name'],
    },
  },
  {
    name: 'move_symbol',
    description: `Move a symbol to a different file using its graph UID.

WHEN TO USE: To relocate a function/class without breaking imports.
GATE: requires --confirm-writes and confirm:true.`,
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string' },
        target_file: { type: 'string' },
        dry_run: { type: 'boolean', default: true },
        confirm: { type: 'boolean', default: false },
        repo: { type: 'string' },
      },
      required: ['uid', 'target_file'],
    },
  },
];

export const ONTOINDEX_TOOLS = INTERNAL_TOOL_HANDLERS;
