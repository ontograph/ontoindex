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
    description:
      'Discover repositories, routes, tools, and analysis packs. help provides startup guidance; tool_contract compares advertised and callable tools. Both use global handlers without requiring a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['repos', 'routes', 'tools', 'packs', 'groups', 'sync', 'help', 'tool_contract'],
          description: 'The discovery action to perform.',
        },
        topic: {
          type: 'string',
          enum: ['overview', 'docs', 'editing', 'setup'],
          default: 'overview',
          description: 'Optional help focus; current compact response includes all topics.',
        },
        mode: {
          type: 'string',
          enum: ['general', 'audit', 'refactor', 'query-projects'],
          description: 'Optional help or tool_contract mode.',
        },
        query: { type: 'string', description: 'Optional help discovery query.' },
        intent: { type: 'string', description: 'Optional help workflow-intent filter.' },
        evidenceClass: {
          type: 'string',
          enum: [
            'graph_evidence',
            'docs_evidence',
            'audit_evidence',
            'advisory_memory',
            'runtime_diagnostic',
            'unknown',
          ],
          description: 'Optional help evidence-class filter.',
        },
        evidenceClasses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional help evidence-class filters.',
        },
        stability: {
          type: 'string',
          enum: ['stable', 'experimental', 'deprecated'],
          description: 'Optional help stability filter.',
        },
        includeNonAuthoritativeEvidence: {
          type: 'boolean',
          default: false,
          description: 'Include advisory memory and runtime diagnostics in help filtering.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Optional cap for filtered help results.',
        },
        includeFacades: {
          type: 'boolean',
          default: false,
          description: 'Include facade tools in tool_contract callable output.',
        },
        legacyResponse: {
          type: 'boolean',
          default: true,
          description:
            'For help: return legacy shape; false selects the capability response envelope.',
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
        retrieval_diagnostics: {
          type: 'boolean',
          description:
            'For action="semantic", include an opt-in retrieval diagnostics summary with lane counts and lane-specific warnings. Default: false.',
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
        include_explanations: {
          type: 'boolean',
          description:
            'For action="semantic", include bounded explanation text for why symbol-level results ranked. Default: false.',
          default: false,
        },
        include_paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For action="semantic", optional repository-relative path prefixes to keep in emitted results.',
        },
        exclude_paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For action="semantic", optional repository-relative path prefixes to remove from emitted results.',
        },
        limit: {
          type: 'number',
          description:
            'Maximum semantic processes and definitions to return per family. Definitions retain a ceiling of 20; max_symbols bounds symbols per process.',
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
          enum: ['signatures', 'outline', 'full', 'compressed', 'files'],
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
      'Inspect symbol context, evidence packs, API shapes, IPC traces, modules, or related symbols. Context inspection can opt in to sidecar enrichment metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'context',
            'evidence',
            'shape',
            'ipc',
            'graph_walk',
            'propose_location',
            'explore',
            'module',
            'related',
          ],
          description:
            'The inspection action to perform. graph_walk requires walk_action. propose_location requires intent. explore requires query. module requires filePath. related requires symbol.',
        },
        walk_action: {
          type: 'string',
          enum: ['start', 'step', 'status'],
          description: 'Required for graph_walk; no default.',
        },
        walkId: { type: 'string', description: 'Walk ID required for step and status.' },
        seedSymbol: { type: 'string', description: 'Seed symbol required for start.' },
        navigationPolicy: {
          type: 'string',
          enum: ['follow-calls', 'follow-imports', 'expand-outward'],
          default: 'follow-calls',
        },
        maxSteps: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
        maxFrontier: { type: 'integer', default: 100, minimum: 1, maximum: 250 },
        maxExpansionPerStep: { type: 'integer', default: 5, minimum: 1, maximum: 25 },
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
        depth: {
          type: ['number', 'string'],
          minimum: 1,
          maximum: 3,
          description:
            'For explore: shallow, balanced (default), or deep. Other inspect actions use numeric traversal depth 1 to 3.',
        },
        query: { type: 'string', description: 'Required for explore: concept or feature query.' },
        qualityMode: {
          type: 'string',
          enum: ['fast', 'balanced', 'thorough'],
          default: 'balanced',
          description: 'Explore search quality.',
        },
        includeSkeletons: {
          type: 'boolean',
          default: true,
          description: 'Include explore symbol skeletons.',
        },
        includeCitations: {
          type: 'boolean',
          default: true,
          description: 'Include explore graph-path citations.',
        },
        profile: {
          type: 'string',
          enum: ['task-pack', 'retrieval-diagnostics'],
          description: 'Optional explore report profile.',
        },
        format: {
          type: 'string',
          enum: ['json', 'files'],
          description:
            'Explore, module, or related report format; defaults to json in the handler.',
        },
        filePath: {
          type: 'string',
          description: 'Relative or absolute path to the file for module inspection.',
        },
        includeSkeleton: {
          type: 'boolean',
          default: true,
          description: 'Include a text skeleton of the file.',
        },
        includePublicAPI: {
          type: 'boolean',
          default: true,
          description: 'Include the list of exported symbols.',
        },
        includeCoChange: {
          type: 'boolean',
          default: true,
          description: 'Include co-changed file partners from git history.',
        },
        recentTouchDays: {
          type: 'number',
          default: 30,
          description: 'Window in days for recently touched classification.',
        },
        symbol: {
          type: 'string',
          description: 'Canonical nodeId or fuzzy symbol name for related inspection.',
        },
        includeCallers: {
          type: 'boolean',
          default: true,
          description: 'Include upstream callers.',
        },
        includeCallees: {
          type: 'boolean',
          default: true,
          description: 'Include downstream callees.',
        },
        includeCoChanged: {
          type: 'boolean',
          default: true,
          description: 'Include co-changed file partners.',
        },
        includeClusterSiblings: {
          type: 'boolean',
          default: true,
          description: 'Include other symbols in the same Leiden community.',
        },
        includeCrossRepo: {
          type: 'boolean',
          default: false,
          description: 'Include cross-repo references (requires group config).',
        },
        maxItemsPerCategory: {
          type: 'number',
          default: 10,
          description: 'Maximum items returned per category (callers, callees, etc).',
        },
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
        intent: { type: 'string', description: 'Free-text description of the new code to locate.' },
        language: {
          type: 'string',
          description:
            'Target language for the proposed file extension: python uses .py; other values use .ts. Defaults to ts when omitted.',
        },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'impact',
    description:
      'Analyze impact of changes on symbols, routes, or batches of symbols. Use diff for legacy change detection and diff_impact for a PR blast-radius report with optional reviewer and docs evidence. Symbol impact supports opt-in sidecar enrichment with a safety-critical gate.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['symbol', 'batch', 'route', 'diff', 'diff_impact'],
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
        scope: {
          type: 'string',
          enum: ['unstaged', 'staged', 'all', 'compare', 'commit-range', 'branch'],
          description:
            'For diff: unstaged, staged, all, or compare; defaults to unstaged in the handler, and compare requires base_ref. For diff_impact: staged, branch, or commit-range; defaults to staged in the handler, and commit-range uses commitRange.',
        },
        base_ref: {
          type: 'string',
          description: 'For diff: base reference required by compare scope.',
        },
        include_paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For diff: repository-relative path prefixes to include in change detection.',
        },
        commitRange: {
          type: 'string',
          description:
            'For diff_impact: explicit git commit range (for example HEAD~5..HEAD or main...feature). Omit to use staged changes.',
        },
        includePaths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For diff_impact: repository-relative path prefixes to keep in the report. Other changed files are omitted and reported as warnings.',
        },
        includeReviewers: {
          type: 'boolean',
          description:
            'For diff_impact: suggest reviewers from git blame/log history. Defaults to true in the handler.',
        },
        docsEvidence: {
          type: 'boolean',
          description:
            'For diff_impact: opt in to advisory Markdown docs evidence for related requirements, API specs, and route drift. Does not affect risk reporting. Defaults to false in the handler.',
        },
        profile: {
          type: 'string',
          enum: ['pr-pack'],
          description:
            'For diff_impact: optional compact PR readiness profile with a bounded verdict, stop conditions, and next commands; does not run CI, publish, tag, push, or generate a wiki.',
        },
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
            'safe_edit_check',
            'can_delete',
            'pre_commit_audit',
            'review_diff',
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
            'session_lock',
            'session_verify',
            'session_dedupe',
            'session_bundle',
            'session_dispatch',
            'session_review_worker',
            'verify_diff',
            'test_gap',
            'worker_scope_review',
            'pr_marker_scan',
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
            'diff',
            'export',
            'replay',
            'fix_history',
            'dedupe',
            'bundle',
            'bundle_conflicts',
            'scope_guard',
            'ingest',
            'verify',
            'tombstone_create',
            'dispatch_prompt',
            'lint',
          ],
          description:
            'The audit action to perform. session_lock creates, loads, or validates a session lock; create writes the lock and does not support persist: false; load and validate are read-only.',
        },
        lock_action: {
          type: 'string',
          enum: ['create', 'load', 'validate'],
          description:
            'Only for session_lock: lock operation. Omit to use the handler default validate. Create writes the lock; persist: false is unsupported. Load and validate are read-only.',
        },
        currentHead: {
          type: 'string',
          description: 'For session_lock: override current HEAD for validation.',
        },
        graphHash: {
          type: 'string',
          description: 'For session_lock: override graph hash for creation or validation.',
        },
        ontoindexVersion: {
          type: 'string',
          description:
            'For session_lock: override the OntoIndex version recorded when creating the lock.',
        },
        symbol: {
          type: 'string',
          description: 'For safe_edit_check or can_delete: canonical nodeId or fuzzy symbol name.',
        },
        intent: {
          type: 'string',
          enum: ['rename', 'modify-body', 'delete', 'general'],
          description:
            'For safe_edit_check: type of edit planned. Influences verdict thresholds. Defaults to general in the handler.',
        },
        force: {
          type: 'boolean',
          description:
            'For safe_edit_check: bypass BLOCKED verdict guards only after confirming the risk manually. Defaults to false in the handler.',
        },
        docsEvidence: {
          type: 'boolean',
          description:
            'For safe_edit_check or pre_commit_audit: opt in to advisory Markdown docs evidence for related requirements, API specs, and route drift. Does not affect verdict/risk scoring. Defaults to false in the handler.',
        },
        expectedSymbols: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For pre_commit_audit: symbols intended to change. Unexpected changed symbols outside this list are flagged as warnings.',
        },
        includePaths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For pre_commit_audit or review_diff: repository-relative path prefixes to keep in the audit. Changed files outside these prefixes are omitted and reported as warnings.',
        },
        commitRange: {
          type: 'string',
          description:
            'For review_diff: explicit git commit range (for example main...feature), used with scope commit-range.',
        },
        includeCrossRepo: {
          type: 'boolean',
          description:
            'For can_delete: request cross-repo coverage. True cross-repo coverage is currently unavailable; the handler reports a warning.',
        },
        sessionA: { type: 'string', description: 'For diff: previous audit session id.' },
        report: {
          type: 'string',
          description: 'For ingest: audit report path; alias for sourcePath.',
        },
        sourcePath: { type: 'string', description: 'For ingest: audit report path.' },
        target: {
          type: 'string',
          description:
            'For ingest: target git ref; alias for targetRef. Defaults to HEAD in the handler.',
        },
        targetRef: {
          type: 'string',
          description: 'For ingest: target git ref. Defaults to HEAD in the handler.',
        },
        graphIndexId: {
          type: 'string',
          description:
            'For ingest: optional graph index identity attached to candidates. For session_lock: override current graph index id for validation.',
        },
        sessionB: { type: 'string', description: 'For diff: current audit session id.' },
        session: {
          type: 'string',
          description:
            'For replay, export, dedupe, bundle, bundle_conflicts, scope_guard, or dispatch_prompt: audit session id. Optional for lint or verify. For verify, tombstone_create, or session_lock: alias for sessionId; sessionId takes precedence. For tombstone_create or session_lock: session or sessionId is required.',
        },
        sessionId: {
          type: 'string',
          description:
            'For replay, export, dedupe, bundle, bundle_conflicts, scope_guard, or dispatch_prompt: alias for session. Optional for lint or verify. For verify, tombstone_create, or session_lock: audit session id; takes precedence over session. For tombstone_create or session_lock: sessionId or session is required.',
        },
        findingId: {
          type: 'string',
          description:
            'For verify: optional finding id filter. For tombstone_create: required finding id.',
        },
        reason: {
          type: 'string',
          description: 'For tombstone_create: required reason for tombstoning the finding.',
        },
        invariantId: {
          type: 'string',
          description: 'For tombstone_create: optional invariant id attached to the tombstone.',
        },
        fixCommit: {
          type: 'string',
          description: 'For tombstone_create: optional fix commit reference.',
        },
        finding: {
          type: 'object',
          description:
            'For verify: inline lifecycle finding object to verify instead of loading a session.',
        },
        maxEvidence: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description:
            'For verify: maximum evidence items per finding. Defaults to 25 in the handler; cap 100.',
        },
        bundleId: {
          type: 'string',
          description: 'For dispatch_prompt or scope_guard: implementation bundle id.',
        },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'For scope_guard: changed files from the implementation diff.',
        },
        changedSymbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'For scope_guard: changed symbols from the implementation diff.',
        },
        executedTests: {
          type: 'array',
          items: { type: 'string' },
          description: 'For scope_guard: tests actually run by the worker.',
        },
        requiredTests: {
          type: 'array',
          items: { type: 'string' },
          description: 'For scope_guard: override required tests for this guard run.',
        },
        bundleIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'For bundle_conflicts: optional implementation bundle ids to compare.',
        },
        maxConflicts: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description:
            'For bundle_conflicts: maximum conflicts returned. Defaults to 50 in the handler.',
        },
        redactionMode: {
          type: 'string',
          enum: ['none', 'paths', 'snippets', 'sensitive'],
          description:
            'For dispatch_prompt: prompt redaction mode. Defaults to sensitive in the handler.',
        },
        forbidUnverifiedFindings: {
          type: 'boolean',
          description:
            'For dispatch_prompt: reject unverified findings. Defaults to true in the handler.',
        },
        allowRuntimeOnlyFindings: {
          type: 'boolean',
          description:
            'For dispatch_prompt: allow runtime-only findings. Defaults to false in the handler.',
        },
        maxPromptChars: {
          type: 'number',
          minimum: 1,
          maximum: 100000,
          description:
            'For dispatch_prompt: maximum prompt characters. Defaults to 20000 in the handler.',
        },
        strategy: {
          type: 'string',
          enum: ['exact', 'symbol', 'root-cause', 'write-set', 'test-surface'],
          description:
            'For dedupe: optional finding grouping strategy filter. For bundle: finding grouping strategy. For bundle_conflicts: optional bundle strategy filter. Defaults to root-cause for bundle in the handler.',
        },
        maxGroups: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description:
            'For dedupe: maximum duplicate groups returned. Defaults to 50 in the handler.',
        },
        maxBundles: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description:
            'For bundle: maximum implementation bundles returned. Defaults to 25 in the handler.',
        },
        persist: {
          type: 'boolean',
          description:
            'For bundle: persist generated bundles. For dispatch_prompt: persist a BundleDispatched event. For scope_guard: persist a ScopeGuardEvaluated event. For lint: persist lint event when a session is supplied. Defaults to true in the handler. For verify: persist verification/status events; defaults to true only when a session is supplied. For tombstone_create: persist a FindingTombstoned event; defaults to true in the handler.',
        },
        scope: {
          type: 'string',
          enum: [
            'report',
            'bundle',
            'all',
            'unstaged',
            'staged',
            'compare',
            'branch',
            'commit-range',
          ],
          description:
            'For lint: report, bundle, or all; defaults to report in the handler. For verify_diff and test_gap: unstaged, staged, all, or compare. For pre_commit_audit: staged, unstaged, all, or branch; defaults to staged in the handler. For review_diff: staged, branch, or commit-range; defaults to staged in the handler. commit-range uses commitRange when supplied; a missing range retains the handler fallback.',
        },
        advisory: {
          type: 'boolean',
          description:
            'For lint: recommend zero exit even when issues exist. Defaults to false in the handler.',
        },
        cursor: {
          type: 'string',
          description:
            'For lint: opaque cursor returned by a previous response. Keeps deterministic page boundaries for follow-up pages.',
        },
        summary: {
          type: 'boolean',
          description:
            'For lint: return lighter JSON that keeps status and warnings while omitting bulky per-item detail.',
        },
        minimal: {
          type: 'boolean',
          description: 'For lint: return only the core result summary and next action.',
        },
        maxIssues: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'For lint: maximum issues returned. Defaults to 50 in the handler.',
        },
        includeIgnored: {
          type: 'boolean',
          description:
            'For lint: include findings whose target paths match repository ignore/generated policy. Defaults to false in the handler.',
        },
        path: {
          type: 'string',
          description:
            'For source-based audit actions: repository-relative source path or inline source label.',
        },
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'For fix_history: git -G patterns to search in history.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'For fix_history: maximum commits returned. Defaults to 20 in the handler.',
        },
        sourceText: {
          type: 'string',
          description:
            'For ingest: pasted audit report text. For source-based audit actions: inline source text to analyze.',
        },
        source: {
          type: 'string',
          description:
            'For pr_marker_scan: alias for inline source text. For taint: untrusted source symbol/name.',
        },
        evidenceLine: {
          type: 'number',
          description: 'For pr_marker_scan: 1-based evidence line to scan around.',
          minimum: 1,
        },
        windowBefore: {
          type: 'number',
          description:
            'For pr_marker_scan: lines before evidence line. Defaults to 3 in the handler.',
          minimum: 0,
          maximum: 50,
        },
        windowAfter: {
          type: 'number',
          description:
            'For pr_marker_scan: lines after evidence line. Defaults to 3 in the handler.',
          minimum: 0,
          maximum: 50,
        },
        targetHead: {
          type: 'string',
          description:
            'For fix_history: required locked target commit to search from. For replay: optional target HEAD; defaults to current git HEAD in the handler.',
        },
        format: {
          type: 'string',
          enum: ['json', 'markdown', 'both'],
          description: 'For export: export format. Defaults to json in the handler.',
        },
        maxEntries: {
          type: 'number',
          description: 'For diff: maximum entries per diff bucket. Defaults to 100 in the handler.',
          minimum: 1,
          maximum: 500,
        },
        maxFindings: {
          type: 'number',
          description:
            'For ingest: maximum returned findings, default 25 and cap 100; persistence includes all candidates. For verify: maximum findings verified in one response, default 25 and cap 100. For replay or export: maximum findings, default 100 for replay and 500 for export.',
          minimum: 1,
          maximum: 500,
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
    description:
      'Preview rename candidates, replace bodies, stage edits in a sandbox, or use safe_refactor for guarded refactoring. Rename apply is unavailable; review candidates, edit files directly, then verify.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['rename', 'replace', 'sandbox', 'safe_refactor'],
          description: 'The refactoring action to perform.',
        },
        operation: {
          type: 'string',
          enum: ['stage', 'apply'],
          description: 'For action "sandbox", use "stage" (default) or "apply".',
        },
        repo: repoProperty,
        target: {
          type: 'string',
          description:
            'Symbol name or UID alias for rename/replace actions; alias for symbol in safe_refactor.',
        },
        intent: {
          type: 'string',
          enum: ['rename', 'modify-body', 'extract', 'move', 'split-function', 'convert-to-method'],
          description: 'Required for safe_refactor: refactor operation to perform.',
        },
        symbol: {
          type: 'string',
          description: 'For safe_refactor: preferred canonical nodeId or fuzzy symbol name.',
        },
        params: {
          type: 'object',
          description:
            'Required for safe_refactor: operation-specific parameters such as newName, newBody, sourceLineRange, or targetFile.',
        },
        dryRun: {
          type: 'boolean',
          description:
            'For safe_refactor: preview changes without applying. Defaults to true in the handler.',
        },
        preChecks: {
          type: 'boolean',
          description:
            'For safe_refactor: run the pre-edit safety check. Defaults to true in the handler.',
        },
        force: {
          type: 'boolean',
          description:
            'For safe_refactor: override BLOCKED/DANGEROUS only after manual confirmation. Defaults to false in the handler.',
        },
        confirm: {
          type: 'boolean',
          description:
            'For safe_refactor: required true with dryRun false to apply supported operations; rename apply is unavailable. Defaults to false in the handler.',
        },
      },
      required: ['action'],
      additionalProperties: true,
    },
  },
  {
    name: 'manage',
    description:
      'Manage OntoIndex sessions, internal route maps, index freshness, and durable analysis jobs. ensure_fresh is read-only by default; autoAnalyze=true explicitly submits a durable analysis job when refresh is required. analyze_job observes or cancels a job. For action "session", "list" requires session_id and lists keys within that session; "get" requires session_id/key; "set" requires session_id/key/value. Session fields are not required for action "route_map", "analyze_job", or "ensure_fresh". quality_mode requires level and changes process-wide environment settings independently of any repository; duration is advisory and both values apply for the lifetime of the process.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['session', 'route_map', 'analyze_job', 'ensure_fresh', 'diagnose', 'quality_mode'],
          description: 'The management action to perform. analyze_job requires jobId.',
        },
        jobId: {
          type: 'string',
          description: 'Required for analyze_job: durable analysis job ID.',
        },
        level: {
          type: 'string',
          enum: ['fast', 'balanced', 'thorough'],
          description: 'Quality preset to apply.',
        },
        duration: {
          type: 'string',
          enum: ['session', 'until-revert'],
          description:
            'Advisory only — both values set process.env for the lifetime of the process. Default: session.',
          default: 'session',
        },
        checkLsp: {
          type: 'boolean',
          default: true,
          description: 'For diagnose: probe language-server availability on PATH. Default: true.',
        },
        checkEmbeddings: {
          type: 'boolean',
          default: true,
          description: 'For diagnose: check whether embeddings are populated. Default: true.',
        },
        checkIndexFreshness: {
          type: 'boolean',
          default: true,
          description: 'For diagnose: check index freshness against HEAD. Default: true.',
        },
        checkToolContract: {
          type: 'boolean',
          default: true,
          description: 'For diagnose: compare advertised and callable MCP tools. Default: true.',
        },
        job_action: {
          type: 'string',
          enum: ['status', 'cancel'],
          description: 'Only for analyze_job. Omit for status.',
        },
        withEmbeddings: {
          type: 'boolean',
          description: 'Also check and populate embeddings. Default: false.',
          default: false,
        },
        requiredGraphCapabilities: {
          type: 'array',
          items: { type: 'string', enum: ['symbols', 'impact', 'processes'] },
          description:
            'Required graph capabilities for freshness and managed analysis. Values are deduplicated and normalized; default: ["symbols"].',
          default: ['symbols'],
        },
        autoAnalyze: {
          type: 'boolean',
          description:
            'Submit a durable ontoindex analyze job when refresh is required. Default: false.',
          default: false,
        },
        killMcpForLock: {
          type: 'boolean',
          description:
            'Advisory only: report lock-release guidance before analyzing. OntoIndex will not terminate MCP processes. Default: false.',
          default: false,
        },
        legacyResponse: {
          type: 'boolean',
          description:
            'Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope.',
          default: true,
        },
        operation: {
          type: 'string',
          enum: ['get', 'set', 'list'],
          description: 'Required for action "session": use "get", "set", or "list".',
        },
        session_id: {
          type: 'string',
          description:
            'Required for action "session" with every operation. Must not contain "/" or "\\".',
        },
        key: {
          type: 'string',
          description: 'Required for action "session" with operation "get" or "set".',
        },
        value: {
          type: 'string',
          description: 'Value to store. Required for action "session" with operation "set".',
        },
        repo: repoProperty,
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
