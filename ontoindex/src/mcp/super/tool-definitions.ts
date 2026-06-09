/**
 * Super-Function Tool Definitions (Phase 1 W1d + Phase 2 W2d + Phase 3 W3d + Phase 4 W4d)
 *
 * JSON Schema definitions for the gn_* super-function MCP tools.
 * Kept separate from the facade tools so the two surface categories
 * remain visually and structurally distinct (different prefix, different
 * dispatch path).
 *
 * Registration pattern: parallel ONTOINDEX_SUPER_TOOLS array + SUPER_NAMES Set,
 * mirroring the ONTOINDEX_FACADE_TOOLS / FACADE_NAMES pattern in server.ts.
 *
 * Phase 2 W2d adds: gn_safe_edit_check, gn_can_delete, gn_pre_commit_audit.
 * Phase 3 W3d adds: gn_safe_refactor, gn_ensure_fresh, gn_quality_mode.
 * Phase 4 W4d adds: gn_diff_impact, gn_diagnose, gn_propose_location.
 * Phase 5 W5a adds: gn_help.
 */

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description?: string;
        enum?: string[];
        items?: { type: string };
        default?: unknown;
        minimum?: number;
        maximum?: number;
      }
    >;
    required: string[];
  };
}

const legacyResponseProperty = {
  type: 'boolean',
  description:
    'Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope.',
  default: true,
} as const;

export const ONTOINDEX_SUPER_TOOLS: ToolDefinition[] = [
  {
    name: 'gn_explore',
    description:
      'Concept-level discovery: given a free-text query, returns a structured ExploreReport with top processes, top symbols (with optional skeletons and citation paths), cluster info, and suggested entry points.\n\nUse as the first tool when exploring an unfamiliar concept or feature area.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        query: {
          type: 'string',
          description: 'Free-text concept or feature query (e.g. "auth flow", "worker-pool").',
        },
        depth: {
          type: 'string',
          enum: ['shallow', 'balanced', 'deep'],
          description:
            'Controls how many top symbols are returned. shallow=3, balanced=5 (default), deep=10.',
          default: 'balanced',
        },
        qualityMode: {
          type: 'string',
          enum: ['fast', 'balanced', 'thorough'],
          description: 'Search quality vs speed trade-off. Default: balanced.',
          default: 'balanced',
        },
        includeSkeletons: {
          type: 'boolean',
          description: 'Include file skeletons for each top symbol. Default: true.',
          default: true,
        },
        includeCitations: {
          type: 'boolean',
          description: 'Include graph-path citation edges for each top symbol. Default: true.',
          default: true,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'gn_explain_module',
    description:
      'File/module overview: given a file path, returns exported symbols, cluster membership, co-changed files, last-commit date, and file stats — all in one call.\n\nUse when you need to understand what a file does and how it fits into the codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        filePath: {
          type: 'string',
          description:
            'Relative or absolute path to the file (e.g. "ontoindex/src/core/search/per-intent-ensemble.ts").',
        },
        includeSkeleton: {
          type: 'boolean',
          description: 'Include a text skeleton of the file. Default: true.',
          default: true,
        },
        includePublicAPI: {
          type: 'boolean',
          description: 'Include the list of exported symbols. Default: true.',
          default: true,
        },
        includeCoChange: {
          type: 'boolean',
          description: 'Include co-changed file partners from git history. Default: true.',
          default: true,
        },
        recentTouchDays: {
          type: 'number',
          description: 'Window in days for "recently touched" classification. Default: 30.',
          default: 30,
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'gn_find_related',
    description:
      'Symbol-level neighborhood: given a symbol name or canonical nodeId, returns callers, callees, co-changed files, cluster siblings, and optionally cross-repo references.\n\nUse to explore the blast radius or call graph around a specific function or class.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        symbol: {
          type: 'string',
          description:
            'Canonical nodeId (e.g. "Function:mergeWithRRF") or fuzzy symbol name (e.g. "mergeWithRRF").',
        },
        includeCallers: {
          type: 'boolean',
          description: 'Include upstream callers. Default: true.',
          default: true,
        },
        includeCallees: {
          type: 'boolean',
          description: 'Include downstream callees. Default: true.',
          default: true,
        },
        includeCoChanged: {
          type: 'boolean',
          description: 'Include co-changed file partners. Default: true.',
          default: true,
        },
        includeClusterSiblings: {
          type: 'boolean',
          description: 'Include other symbols in the same Leiden community. Default: true.',
          default: true,
        },
        includeCrossRepo: {
          type: 'boolean',
          description: 'Include cross-repo references (requires group config). Default: false.',
          default: false,
        },
        maxItemsPerCategory: {
          type: 'number',
          description: 'Maximum items returned per category (callers, callees, etc). Default: 10.',
          default: 10,
        },
      },
      required: ['symbol'],
    },
  },
  // ---------------------------------------------------------------------------
  // Phase 2 W2d — Safety super-functions
  // ---------------------------------------------------------------------------
  {
    name: 'gn_safe_edit_check',
    description:
      'Pre-edit risk synthesis: resolves a symbol, computes blast radius (callers, callees, processes, clusters), test coverage likelihood, and co-change recency, then emits a SAFE / CAUTION / DANGEROUS / BLOCKED verdict with a recommended tool and suggested next steps.\n\nRun this before modifying any symbol to avoid surprise regressions.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        symbol: {
          type: 'string',
          description:
            'Canonical nodeId (e.g. "Function:mergeWithRRF") or fuzzy symbol name (e.g. "mergeWithRRF").',
        },
        intent: {
          type: 'string',
          enum: ['rename', 'modify-body', 'delete', 'general'],
          description: 'Type of edit planned. Influences verdict thresholds. Default: general.',
          default: 'general',
        },
        force: {
          type: 'boolean',
          description:
            'Bypass BLOCKED verdict guards. Use only when you have confirmed the risk manually. Default: false.',
          default: false,
        },
        docsEvidence: {
          type: 'boolean',
          description:
            'Opt in to advisory Markdown docs evidence for related requirements, API specs, and route drift. Does not affect verdict/risk scoring. Default: false.',
          default: false,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'gn_can_delete',
    description:
      'Dead-code safety check: resolves a symbol, then checks callers, test-file imports, cross-repo references, and co-change recency to synthesise a DELETE-SAFE / CAUTION / DO-NOT-DELETE verdict.\n\nRun before removing a symbol to confirm it has no live dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        symbol: {
          type: 'string',
          description:
            'Canonical nodeId (e.g. "Function:mergeWithRRF") or fuzzy symbol name (e.g. "mergeWithRRF").',
        },
        includeCrossRepo: {
          type: 'boolean',
          description: 'Check cross-repo references (requires group config). Default: false.',
          default: false,
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'gn_pre_commit_audit',
    description:
      'Ship-readiness verdict: diffs the working tree, identifies changed symbols, runs per-symbol impact analysis, and emits READY / REVIEW / DO-NOT-COMMIT with a per-file breakdown and any unexpected symbol warnings.\n\nRun before every commit to catch high-risk changes before they land.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        scope: {
          type: 'string',
          enum: ['staged', 'unstaged', 'all', 'branch'],
          description:
            'Which changes to audit. staged = git diff --cached; unstaged = git diff; all = both; branch = all commits since main. Default: staged.',
          default: 'staged',
        },
        expectedSymbols: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Symbols you intended to change. Unexpected changed symbols outside this list are flagged as warnings.',
        },
        docsEvidence: {
          type: 'boolean',
          description:
            'Opt in to advisory Markdown docs evidence for related requirements, API specs, and route drift. Does not affect verdict/risk scoring. Default: false.',
          default: false,
        },
      },
      required: [],
    },
  },
  // ---------------------------------------------------------------------------
  // Phase 3 W3d — Write / lifecycle super-functions
  // ---------------------------------------------------------------------------
  {
    name: 'gn_safe_refactor',
    description:
      'Single WRITE dispatcher for atomic refactor operations (rename, modify-body, extract, move). Wraps each operation with symbol resolution, pre-edit safety check (via gn_safe_edit_check), dry-run preview, optional apply, and post-write verification guidance (gn_verify_diff / gn_test_gap).\n\nDefaults to dryRun: true — pass dryRun: false to actually apply changes.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        intent: {
          type: 'string',
          enum: ['rename', 'modify-body', 'extract', 'move', 'split-function', 'convert-to-method'],
          description: 'Refactor operation to perform.',
        },
        symbol: {
          type: 'string',
          description:
            'Preferred symbol selector: canonical nodeId (e.g. "Function:mergeWithRRF") or fuzzy symbol name (e.g. "mergeWithRRF").',
        },
        target: {
          type: 'string',
          description:
            'Deprecated alias for symbol, preserved for callers migrating from facade-style target selectors.',
        },
        params: {
          type: 'object',
          description:
            'Operation-specific parameters: newName (rename/extract), newBody (modify-body), sourceLineRange (extract), targetFile (move/extract).',
        },
        dryRun: {
          type: 'boolean',
          description:
            'Preview changes without applying. Default: true. Pass false to apply changes.',
          default: true,
        },
        force: {
          type: 'boolean',
          description:
            'Override BLOCKED/DANGEROUS pre-check verdict. Use only after manual confirmation. Default: false.',
          default: false,
        },
        preChecks: {
          type: 'boolean',
          description: 'Run gn_safe_edit_check before proceeding. Default: true.',
          default: true,
        },
      },
      required: ['intent', 'params'],
    },
  },
  {
    name: 'gn_ensure_fresh',
    description:
      'Index lifecycle helper: reports whether the OntoIndex index is stale (indexed commit ≠ current HEAD), surfaces embeddings status, and optionally re-runs `ontoindex analyze` using the current CLI process when autoAnalyze: true is passed.\n\nThis is a READ-ONLY super-function by default (autoAnalyze defaults to false).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        withEmbeddings: {
          type: 'boolean',
          description: 'Also check and populate embeddings. Default: false.',
          default: false,
        },
        autoAnalyze: {
          type: 'boolean',
          description:
            'Automatically run ontoindex analyze when the index is stale. Default: false.',
          default: false,
        },
        killMcpForLock: {
          type: 'boolean',
          description:
            'Advisory only: report lock-release guidance before analyzing. OntoIndex will not terminate MCP processes. Default: false.',
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: 'gn_quality_mode',
    description:
      'Env-var preset switch: applies one of three named quality presets (fast / balanced / thorough) by setting or clearing ONTOINDEX_* environment variables on process.env. Changes take effect immediately for all subsequent tool calls in the same session.\n\nfast: clears all flags (fastest). balanced: enables INTENT_ENSEMBLE + CITATIONS. thorough: balanced + LSP_REFERENCES + VEC_POOL_MIN=3.',
    inputSchema: {
      type: 'object',
      properties: {
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
      },
      required: ['level'],
    },
  },
  // ---------------------------------------------------------------------------
  // Phase 4 W4d — PR blast-radius / diagnose / location-proposal super-functions
  // ---------------------------------------------------------------------------
  {
    name: 'gn_diff_impact',
    description:
      'PR blast-radius report: diffs the working tree (staged, branch, or an explicit commit range), finds symbols defined in each changed file, runs upstream/downstream impact analysis per symbol, aggregates HIGH-risk symbols, and optionally suggests reviewers from git history.\n\nUse before opening a PR or after a large feature branch to understand the full blast radius of your changes.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        commitRange: {
          type: 'string',
          description:
            'Explicit git commit range (e.g. "HEAD~5..HEAD", "main...feature"). Omit to use staged changes.',
        },
        scope: {
          type: 'string',
          enum: ['staged', 'commit-range', 'branch'],
          description:
            'Which changes to diff. staged = git diff --cached; branch = main...HEAD; commit-range requires commitRange param. Default: staged.',
          default: 'staged',
        },
        includeReviewers: {
          type: 'boolean',
          description: 'Suggest reviewers from git blame/log history. Default: true.',
          default: true,
        },
        docsEvidence: {
          type: 'boolean',
          description:
            'Opt in to advisory Markdown docs evidence for related requirements, API specs, and route drift. Does not affect risk reporting. Default: false.',
          default: false,
        },
      },
      required: [],
    },
  },
  // REV-5: MCP review exposure — ADR 0018 envelope aligned with `ontoindex review diff`
  {
    name: 'gn_review_diff',
    description:
      'Graph-aware diff review with ADR 0018 capability-response envelope.\n\nDiffs the working tree (staged, branch, or an explicit commit range), finds symbols defined in each changed file, runs upstream/downstream impact analysis per symbol, and returns the result in the same versioned envelope as `ontoindex review diff --json`.\n\nUse when you want the MCP response to be machine-readable and aligned with the CLI review contract. Use `gn_diff_impact` when you also need reviewer suggestions or docs evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        commitRange: {
          type: 'string',
          description:
            'Explicit git commit range (e.g. "HEAD~5..HEAD", "main...feature"). Omit to use staged changes.',
        },
        scope: {
          type: 'string',
          enum: ['staged', 'commit-range', 'branch'],
          description:
            'Which changes to diff. staged = git diff --cached; branch = main...HEAD; commit-range requires commitRange param. Default: staged.',
          default: 'staged',
        },
      },
      required: [],
    },
  },
  {
    name: 'gn_diagnose',
    description:
      'Read-only system-status report: checks index freshness, embeddings, LSP server availability, and ONTOINDEX_* environment variables, then synthesises a ranked recommendation list.\n\nUse when the OntoIndex index seems stale, searches return poor results, or you want a health snapshot before a long session.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        checkLsp: {
          type: 'boolean',
          description:
            'Probe whether typescript-language-server, pyright, and rust-analyzer are on PATH. Default: true.',
          default: true,
        },
        checkEmbeddings: {
          type: 'boolean',
          description: 'Check whether embeddings are populated. Default: true.',
          default: true,
        },
        checkIndexFreshness: {
          type: 'boolean',
          description: 'Check whether the index is stale vs the current HEAD. Default: true.',
          default: true,
        },
        checkToolContract: {
          type: 'boolean',
          description:
            'Check whether gn_help advertised tools match registered callable MCP tools. Default: true.',
          default: true,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: [],
    },
  },
  {
    name: 'gn_propose_location',
    description:
      'Where-to-add-new-code suggester: given a free-text intent description, uses semantic search to find the best-matching clusters, then proposes a directory, filename, and import pattern for the new code.\n\nUse before creating a new file to find the right location and naming convention.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        intent: {
          type: 'string',
          description:
            'Free-text description of the new code (e.g. "test feature handler", "auth middleware").',
        },
        language: {
          type: 'string',
          description:
            'Target language for the file extension suggestion (e.g. "python" → .py; anything else → .ts). Default: ts.',
        },
      },
      required: ['intent'],
    },
  },
  // ---------------------------------------------------------------------------
  // Phase 5 W5a — Discovery / self-help: gn_help
  // ---------------------------------------------------------------------------
  {
    name: 'gn_help',
    description:
      'Compact startup guide and MCP ergonomics review: lists super-functions, docs-aware workflows, setup steps, response-size limits, schema clarity notes, and recommended first calls for agents.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['overview', 'docs', 'editing', 'setup'],
          description:
            'Optional discovery focus. Current response is compact and includes all topics; use this to document caller intent.',
          default: 'overview',
        },
        mode: {
          type: 'string',
          enum: ['general', 'audit', 'refactor', 'query-projects'],
          description:
            'Optional agent mode. When supplied, filters advertised tools and workflow guidance to the specified mode and adds mode/modeDescription to the report.',
        },
        query: {
          type: 'string',
          description:
            'Optional free-text discovery query. Filters/ranks tools by registry intent/whenToUse/workflow tags.',
        },
        intent: {
          type: 'string',
          description:
            'Optional workflow-intent filter (e.g. "refactor", "audit", "docs", "release", "diagnose").',
        },
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
          description:
            'Optional evidence-class filter. By default, advisory_memory/runtime_diagnostic are excluded unless includeNonAuthoritativeEvidence=true.',
        },
        evidenceClasses: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional multi-value evidence-class filter (same vocabulary as evidenceClass).',
        },
        stability: {
          type: 'string',
          enum: ['stable', 'experimental', 'deprecated'],
          description: 'Optional stability filter for registry-backed discovery results.',
        },
        includeNonAuthoritativeEvidence: {
          type: 'boolean',
          description:
            'Include advisory_memory/runtime_diagnostic evidence classes in filtering. Defaults to false to preserve trust boundaries.',
          default: false,
        },
        limit: {
          type: 'number',
          description: 'Optional cap for filtered results (min 1, max 100).',
          minimum: 1,
          maximum: 100,
        },
        repo: {
          type: 'string',
          description:
            'Optional repository name or path. When supplied, adds lightweight readiness reminders (stale index, dirty worktree, missing embeddings/LSP/sidecar) to the report.',
        },
        legacyResponse: legacyResponseProperty,
      },
      required: [],
    },
  },
  {
    name: 'gn_docs',
    description:
      'Docs-specific safe agent reports over stabilized docs JSON contracts: trace requirements, check API drift, inspect docs context/readiness, and return compact MCP-safe metadata with skip reasons.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        action: {
          type: 'string',
          enum: ['trace', 'drift', 'context', 'readiness'],
          description: 'Docs report action. Default: readiness.',
          default: 'readiness',
        },
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
      required: [],
    },
  },
  {
    name: 'gn_tool_contract',
    description:
      'MCP tool contract preflight: compare gn_help advertised super-functions with the registered callable MCP frontier and report missing or extra tools before agents hit Unknown tool at runtime. When `mode` is supplied, also computes a mode-filtered frontier comparison and structural integrity checks.',
    inputSchema: {
      type: 'object',
      properties: {
        includeFacades: {
          type: 'boolean',
          description:
            'Include facade tools such as audit, inspect, impact, and search in callable output. Default: false.',
          default: false,
        },
        mode: {
          type: 'string',
          enum: ['general', 'audit', 'refactor', 'query-projects'],
          description:
            'Optional agent mode. When supplied, adds a mode-filtered frontier comparison (`modeFrontier`) to the report comparing gn_help({mode}) advertised tools against mode-discoverable callable tools.',
        },
      },
      required: [],
    },
  },
  {
    name: 'gn_audit_ingest',
    description:
      'Audit lifecycle ingest: parse a Markdown report or pasted findings into untrusted candidate findings at a locked target HEAD. Ingest never creates OPEN findings.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        report: {
          type: 'string',
          description: 'Audit report path. Alias for sourcePath.',
        },
        sourcePath: {
          type: 'string',
          description: 'Audit report path.',
        },
        sourceText: {
          type: 'string',
          description: 'Pasted audit report text.',
        },
        target: {
          type: 'string',
          description: 'Target git ref to lock. Alias for targetRef. Default: HEAD.',
          default: 'HEAD',
        },
        targetRef: {
          type: 'string',
          description: 'Target git ref to lock. Default: HEAD.',
          default: 'HEAD',
        },
        graphIndexId: {
          type: 'string',
          description: 'Optional graph index identity to attach to candidates.',
        },
        persist: {
          type: 'boolean',
          description: 'Persist ingest events to .ontoindex/audit. Default: true.',
          default: true,
        },
        maxFindings: {
          type: 'number',
          description: 'Maximum findings returned. Default: 25, max: 100.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
      },
      required: [],
    },
  },
  {
    name: 'gn_audit_verify',
    description:
      'Audit lifecycle verify: re-check candidate findings against fresh target HEAD evidence and classify unsupported or incomplete proof without promoting stale findings to OPEN.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: {
          type: 'string',
          description: 'Audit session id. Alias for sessionId.',
        },
        sessionId: {
          type: 'string',
          description: 'Audit session id.',
        },
        findingId: {
          type: 'string',
          description: 'Optional finding id filter.',
        },
        finding: {
          type: 'object',
          description: 'Inline lifecycle finding object to verify instead of loading a session.',
        },
        maxFindings: {
          type: 'number',
          description: 'Maximum findings verified in one response. Default: 25, max: 100.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
        maxEvidence: {
          type: 'number',
          description: 'Maximum evidence items per finding. Default: 25, max: 100.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
        persist: {
          type: 'boolean',
          description:
            'Persist verification/status events when a session is supplied. Default: true.',
          default: true,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: [],
    },
  },
  {
    name: 'gn_fix_history',
    description:
      'Audit lifecycle fix-history lookup: search git history at target HEAD for commits matching supplied fix or negative-evidence patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        targetHead: {
          type: 'string',
          description: 'Locked target commit to search from.',
        },
        path: {
          type: 'string',
          description: 'Repository-relative file path to search.',
        },
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Git -G patterns to search in history.',
        },
        limit: {
          type: 'number',
          description: 'Maximum commits returned. Default: 20, max: 100.',
          default: 20,
          minimum: 1,
          maximum: 100,
        },
      },
      required: ['targetHead', 'path'],
    },
  },
  {
    name: 'gn_audit_bundle',
    description:
      'Audit lifecycle bundle projection: group verified OPEN/PARTIAL findings into bounded implementation bundles. No dispatch prompts are generated.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: {
          type: 'string',
          description: 'Audit session id. Alias for sessionId.',
        },
        sessionId: {
          type: 'string',
          description: 'Audit session id.',
        },
        strategy: {
          type: 'string',
          enum: ['exact', 'symbol', 'root-cause', 'write-set', 'test-surface'],
          description: 'Dedupe strategy. Default: root-cause.',
          default: 'root-cause',
        },
        maxBundles: {
          type: 'number',
          description: 'Maximum bundles returned. Default: 25, max: 100.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
        persist: {
          type: 'boolean',
          description: 'Persist bundle events. Default: true.',
          default: true,
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'gn_audit_lint',
    description:
      'Audit lifecycle lint: report or bundle process checks for stale OPEN findings, line-only evidence, runtime-only claims, duplicates, tombstones, HOLD metadata, tests, and impact targets.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: {
          type: 'string',
          description: 'Audit session id. Alias for sessionId.',
        },
        sessionId: {
          type: 'string',
          description: 'Audit session id.',
        },
        scope: {
          type: 'string',
          enum: ['report', 'bundle', 'all'],
          description: 'Rule set to run. Default: report.',
          default: 'report',
        },
        advisory: {
          type: 'boolean',
          description: 'Recommend zero exit even when issues exist. Default: false.',
          default: false,
        },
        cursor: {
          type: 'string',
          description:
            'Opaque cursor returned by a previous lint response. Keeps deterministic page boundaries for follow-up pages.',
        },
        summary: {
          type: 'boolean',
          description:
            'Return lighter JSON that keeps status and warnings while omitting bulky per-item detail.',
          default: false,
        },
        minimal: {
          type: 'boolean',
          description: 'Return only the core result summary and next action.',
          default: false,
        },
        maxIssues: {
          type: 'number',
          description: 'Maximum lint issues returned. Default: 50, max: 100.',
          default: 50,
          minimum: 1,
          maximum: 100,
        },
        includeIgnored: {
          type: 'boolean',
          description:
            'Include findings whose target paths match repository ignore/generated policy. Default: false.',
          default: false,
        },
        persist: {
          type: 'boolean',
          description: 'Persist lint event when a session is supplied. Default: true.',
          default: true,
        },
      },
      required: [],
    },
  },
  {
    name: 'gn_audit_logic',
    description:
      'Systems-audit logic scan: run bounded deterministic anti-pattern rules for resources, fork safety, signals, TOCTOU, and concurrency. Findings are evidence only and do not directly change audit lifecycle status.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        path: {
          type: 'string',
          description: 'Repository-relative source path or snippet label to scan.',
        },
        source: {
          type: 'string',
          description: 'Optional source text to scan directly.',
        },
        category: {
          type: 'string',
          enum: ['resource-leaks', 'fork-safety', 'signals', 'toctou', 'concurrency'],
          description: 'Rule category to run. Omit to run all MVP categories.',
        },
        maxFindings: {
          type: 'number',
          description: 'Maximum findings returned. Default: 25, max: 100.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: [],
    },
  },
  {
    name: 'gn_audit_dedupe',
    description:
      'Audit lifecycle dedupe: group findings by exact fingerprint, symbol, root cause, write-set, or test surface so stale duplicate audit claims collapse before dispatch.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        strategy: {
          type: 'string',
          enum: ['exact', 'symbol', 'root-cause', 'write-set', 'test-surface'],
          description: 'Optional dedupe strategy filter.',
        },
        maxGroups: {
          type: 'number',
          description: 'Maximum groups returned. Default: 50.',
          default: 50,
          minimum: 1,
          maximum: 100,
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'gn_dispatch_prompt',
    description:
      'Audit lifecycle dispatch prompt generator: emit one concrete worker prompt for exactly one verified implementation bundle, with scope, non-scope, tests, impact checks, and stop conditions.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        bundleId: {
          type: 'string',
          description: 'Bundle id to dispatch. Required when the session has more than one bundle.',
        },
        redactionMode: {
          type: 'string',
          enum: ['none', 'paths', 'snippets', 'sensitive'],
          description: 'Prompt redaction policy. Default: sensitive.',
          default: 'sensitive',
        },
        forbidUnverifiedFindings: {
          type: 'boolean',
          description:
            'Reject bundles without fresh verified implementation findings. Default: true.',
          default: true,
        },
        allowRuntimeOnlyFindings: {
          type: 'boolean',
          description: 'Allow runtime-only findings to be dispatched. Default: false.',
          default: false,
        },
        persist: {
          type: 'boolean',
          description: 'Persist BundleDispatched event. Default: true.',
          default: true,
        },
        maxPromptChars: {
          type: 'number',
          description: 'Maximum prompt characters returned. Default: 20000.',
          default: 20000,
          minimum: 1,
          maximum: 100000,
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'gn_audit_tombstone_create',
    description:
      'Audit lifecycle tombstone creation: mark a resolved finding as tombstoned with negative/fix-proof evidence so future stale audit reports can be rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        findingId: { type: 'string', description: 'Finding id to tombstone.' },
        reason: {
          type: 'string',
          description: 'Why this finding must not be reopened without invariant failure.',
        },
        invariantId: { type: 'string', description: 'Optional fix invariant id.' },
        fixCommit: { type: 'string', description: 'Optional fix commit sha.' },
        persist: {
          type: 'boolean',
          description: 'Persist FindingTombstoned event. Default: true.',
          default: true,
        },
      },
      required: ['session', 'findingId', 'reason'],
    },
  },
  {
    name: 'gn_audit_session_start',
    description:
      'Manager-level audit session start: ingest findings and create the session lock that governs the rest of the audit loop.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        targetRef: {
          type: 'string',
          description: 'Target git ref to ingest against. Default: HEAD.',
        },
        sourcePath: { type: 'string', description: 'Markdown audit report path.' },
        pastedText: { type: 'string', description: 'Pasted audit report text.' },
        graphIndexId: {
          type: 'string',
          description: 'Optional graph index identity to attach to candidates.',
        },
        strictFresh: {
          type: 'boolean',
          description: 'Advisory manager preference for strict freshness handling. Default: true.',
          default: true,
        },
        persist: {
          type: 'boolean',
          description: 'Persist ingest events and session lock. Default: true.',
          default: true,
        },
        maxFindings: {
          type: 'number',
          description: 'Maximum findings returned. Default: 25.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
      },
      required: [],
    },
  },
  {
    name: 'gn_audit_session_verify',
    description:
      'Manager-level audit verify: refuse stale sessions, run fresh verification, and enforce repeated-finding tombstones before work can proceed.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        findingId: { type: 'string', description: 'Optional finding id filter.' },
        proofMode: {
          type: 'string',
          enum: ['heuristic', 'path-sensitive', 'resource-ledger', 'runtime-required'],
          description: 'Advisory proof-mode label for the manager loop.',
          default: 'heuristic',
        },
        maxFindings: {
          type: 'number',
          description: 'Maximum findings verified in one response. Default: 25.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
        maxEvidence: {
          type: 'number',
          description: 'Maximum evidence items per finding. Default: 25.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
        persist: {
          type: 'boolean',
          description: 'Persist verification and repeated-finding tombstone events. Default: true.',
          default: true,
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'gn_audit_session_dedupe',
    description:
      'Manager-level audit dedupe: refuse stale sessions, then collapse duplicates before implementation planning or dispatch.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        strategy: {
          type: 'string',
          enum: ['exact', 'symbol', 'root-cause', 'write-set', 'test-surface'],
          description: 'Dedupe strategy. Default: root-cause.',
          default: 'root-cause',
        },
        maxGroups: {
          type: 'number',
          description: 'Maximum groups returned. Default: 50.',
          default: 50,
          minimum: 1,
          maximum: 100,
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'gn_audit_session_bundle',
    description:
      'Manager-level audit bundle: run dedupe first, then project verified findings into implementation bundles with optional manager sizing limits.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        strategy: {
          type: 'string',
          enum: ['exact', 'symbol', 'root-cause', 'write-set', 'test-surface'],
          description: 'Bundle grouping strategy. Default: root-cause.',
          default: 'root-cause',
        },
        maxBundles: {
          type: 'number',
          description: 'Maximum bundles returned. Default: 25.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
        maxLoc: {
          type: 'number',
          description: 'Optional manager limit for estimated lines changed per bundle.',
        },
        maxFiles: {
          type: 'number',
          description: 'Optional manager limit for files touched per bundle.',
        },
        parallelism: {
          type: 'number',
          description: 'Requested manager parallelism hint. Default: 1.',
          default: 1,
          minimum: 1,
          maximum: 100,
        },
        persist: {
          type: 'boolean',
          description: 'Persist bundle events. Default: true.',
          default: true,
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'gn_audit_session_dispatch',
    description:
      'Manager-level audit dispatch: refuse stale sessions, unverified findings, HOLD/NEEDS-VERIFY statuses, and duplicate-only bundle children before generating a worker prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        bundleId: { type: 'string', description: 'Persisted bundle id to dispatch.' },
        redactionMode: {
          type: 'string',
          enum: ['none', 'paths', 'snippets', 'sensitive'],
          description: 'Prompt redaction policy. Default: sensitive.',
          default: 'sensitive',
        },
        maxPromptChars: {
          type: 'number',
          description: 'Maximum prompt characters returned. Default: 20000.',
          default: 20000,
          minimum: 1,
          maximum: 100000,
        },
        persist: {
          type: 'boolean',
          description: 'Persist BundleDispatched event. Default: true.',
          default: true,
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'gn_audit_session_review_worker',
    description:
      'Manager-level audit worker review: run scope guard and required-test checks against a persisted bundle after worker edits.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        bundleId: { type: 'string', description: 'Persisted bundle id under review.' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changed files from the implementation diff.',
        },
        changedSymbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changed symbols from the implementation diff.',
        },
        executedTests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tests the worker actually executed.',
        },
        requiredTests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override required tests for this review.',
        },
        persist: {
          type: 'boolean',
          description: 'Persist ScopeGuardEvaluated event. Default: true.',
          default: true,
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'gn_audit_session_lock',
    description:
      'Audit lifecycle session lock: create, load, or validate a hard audit session lock containing target HEAD, graph index/hash, OntoIndex version, and tombstone snapshot. Validation returns STALE_SESSION on drift.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        action: {
          type: 'string',
          enum: ['create', 'load', 'validate'],
          description: 'Lock operation. Default: validate.',
          default: 'validate',
        },
        currentHead: { type: 'string', description: 'Override current HEAD for validation tests.' },
        graphIndexId: {
          type: 'string',
          description: 'Override current graph index id for validation.',
        },
        graphHash: {
          type: 'string',
          description: 'Override current graph hash for creation/validation.',
        },
        ontoindexVersion: {
          type: 'string',
          description: 'Override OntoIndex version recorded in the lock.',
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'gn_audit_pr_marker_scan',
    description:
      'Audit lifecycle PR marker scan: inspect comments around evidence lines for PR-N, TODO, FIXME, follow-up, known limitation, and deferred markers before reflagging known debt as bugs.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        path: {
          type: 'string',
          description: 'Repository-relative source path or inline source label.',
        },
        sourceText: { type: 'string', description: 'Inline source text to scan.' },
        source: { type: 'string', description: 'Alias for inline source text.' },
        evidenceLine: {
          type: 'number',
          description: '1-based evidence line to scan around.',
          minimum: 1,
        },
        windowBefore: {
          type: 'number',
          description: 'Lines before evidence line. Default: 3.',
          default: 3,
          minimum: 0,
          maximum: 50,
        },
        windowAfter: {
          type: 'number',
          description: 'Lines after evidence line. Default: 3.',
          default: 3,
          minimum: 0,
          maximum: 50,
        },
      },
      required: ['evidenceLine'],
    },
  },
  {
    name: 'gn_audit_diff',
    description:
      'Audit lifecycle diff: compare two persisted audit sessions by finding fingerprint/id and report added, removed, status-changed, and unchanged findings.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        sessionA: { type: 'string', description: 'Previous audit session id.' },
        sessionB: { type: 'string', description: 'Current audit session id.' },
        maxEntries: {
          type: 'number',
          description: 'Maximum entries per diff bucket. Default: 100.',
          default: 100,
          minimum: 1,
          maximum: 500,
        },
      },
      required: ['sessionA', 'sessionB'],
    },
  },
  {
    name: 'gn_audit_replay',
    description:
      'Audit lifecycle replay planner: replay a session against a target HEAD by returning findings that need verify/reverify because status, target HEAD, or evidence freshness changed.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        targetHead: {
          type: 'string',
          description: 'Target HEAD to replay against. Default: current git HEAD.',
        },
        maxFindings: {
          type: 'number',
          description: 'Maximum replay findings returned. Default: 100.',
          default: 100,
          minimum: 1,
          maximum: 500,
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'gn_audit_export',
    description:
      'Audit lifecycle export: produce canonical JSON and/or generated Markdown from a persisted audit session so agents do not manually regenerate stale prose reports.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        format: {
          type: 'string',
          enum: ['json', 'markdown', 'both'],
          description: 'Export format. Default: json.',
          default: 'json',
        },
        maxFindings: {
          type: 'number',
          description: 'Maximum findings exported. Default: 500.',
          default: 500,
          minimum: 1,
          maximum: 500,
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'gn_scope_guard',
    description:
      'Audit lifecycle scope guard: compare an implementation diff summary against a bundle write-set, symbols, required tests, and neighboring bundles.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        bundleId: { type: 'string', description: 'Bundle id under review.' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changed files from the implementation diff.',
        },
        changedSymbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changed symbols from the implementation diff.',
        },
        executedTests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tests actually run by the worker.',
        },
        requiredTests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override required tests for this guard run.',
        },
        persist: {
          type: 'boolean',
          description: 'Persist ScopeGuardEvaluated event. Default: true.',
          default: true,
        },
      },
      required: ['session', 'bundleId'],
    },
  },
  {
    name: 'gn_bundle_conflicts',
    description:
      'Audit lifecycle bundle conflict detector: report file, symbol, test-surface, and write-set overlaps before parallel worker dispatch.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        bundleIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional bundle ids to filter conflict output.',
        },
        strategy: {
          type: 'string',
          enum: ['exact', 'symbol', 'root-cause', 'write-set', 'test-surface'],
          description: 'Bundle grouping strategy to evaluate. Default: root-cause.',
        },
        maxConflicts: {
          type: 'number',
          description: 'Maximum conflicts returned. Default: 50.',
          default: 50,
          minimum: 1,
          maximum: 100,
        },
      },
      required: ['session'],
    },
  },
  {
    name: 'gn_verify_diff',
    description:
      'Post-edit diff verification: compare expected files, symbols, and tests against actual changed files, changed symbols, impacted symbols, and executed tests.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        scope: {
          type: 'string',
          enum: ['unstaged', 'staged', 'all', 'compare'],
          description: 'Diff scope to inspect. Default: unstaged.',
          default: 'unstaged',
        },
        diffRef: {
          type: 'string',
          description: 'Optional compare base ref. When present, gn_verify_diff uses compare mode.',
        },
        baseRef: { type: 'string', description: 'Alias for diffRef.' },
        expectedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Expected changed files.',
        },
        expectedSymbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Expected changed symbols.',
        },
        expectedTests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Required executed tests.',
        },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional changed files override.',
        },
        changedSymbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional changed symbols override.',
        },
        executedTests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tests actually executed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'gn_test_gap',
    description:
      'Post-edit test evidence review: report changed production symbols that have no linked tests or executed test evidence. Filename-derived matches remain heuristic until richer test data is ingested.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        scope: {
          type: 'string',
          enum: ['unstaged', 'staged', 'all', 'compare'],
          description: 'Diff scope to inspect. Default: unstaged.',
          default: 'unstaged',
        },
        diffRef: {
          type: 'string',
          description: 'Optional compare base ref. When present, gn_test_gap uses compare mode.',
        },
        baseRef: { type: 'string', description: 'Alias for diffRef.' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional changed files override.',
        },
        changedSymbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional changed symbols override.',
        },
        executedTests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tests actually executed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'gn_worker_scope_review',
    description:
      'Write-through worker review: validate a bundle against changed files, changed symbols, impacted symbols, executed tests, and missing test evidence after worker edits.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        session: { type: 'string', description: 'Audit session id.' },
        sessionId: { type: 'string', description: 'Alias for session.' },
        bundleId: { type: 'string', description: 'Bundle id under review.' },
        commit: {
          type: 'string',
          description: 'Optional compare base ref or commit for diff collection.',
        },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changed files from the implementation diff.',
        },
        changedSymbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changed symbols from the implementation diff.',
        },
        executedTests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tests actually run by the worker.',
        },
        requiredTests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override required tests for this review.',
        },
      },
      required: ['session', 'bundleId'],
    },
  },
  {
    name: 'gn_resource_trace',
    description:
      'Systems-audit resource ownership trace: extract POSIX resource acquire/duplicate/handoff/release facts for fd, pid, pidfd, pipe, socket, fork, exec, and wait flows.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        path: { type: 'string', description: 'Repository-relative source path to read.' },
        sourceText: { type: 'string', description: 'Inline source text to analyze.' },
        source: { type: 'string', description: 'Alias for inline source text.' },
        processIdentity: {
          type: 'string',
          description: 'Process identity label. Default: process:local.',
        },
        maxRecords: {
          type: 'number',
          description: 'Maximum resource records returned. Default: 500.',
          default: 500,
          minimum: 1,
          maximum: 1000,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: [],
    },
  },
  {
    name: 'gn_path_verify',
    description:
      'Systems-audit shallow path verifier: for a trigger branch, verify required calls/patterns appear and forbidden calls/patterns do not appear in the bounded intra-procedural window.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        path: { type: 'string', description: 'Repository-relative source path to read.' },
        sourceText: { type: 'string', description: 'Inline source text to analyze.' },
        source: { type: 'string', description: 'Alias for inline source text.' },
        symbol: { type: 'string', description: 'Optional symbol under verification.' },
        when: {
          type: 'string',
          description: 'Trigger condition or branch pattern, e.g. fork() < 0.',
        },
        must: {
          type: 'array',
          items: { type: 'string' },
          description: 'Patterns that must appear after the trigger.',
        },
        mustNot: {
          type: 'array',
          items: { type: 'string' },
          description: 'Patterns that must not appear after the trigger.',
        },
        maxEvidence: {
          type: 'number',
          description: 'Maximum evidence lines returned. Default: 25.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: ['when'],
    },
  },
  {
    name: 'gn_test_suggestions',
    description:
      'Audit-to-test suggestion generator: propose the smallest test file/case/assertion shape for a verified finding, symbol, claim pattern, or risk invariant.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        findingId: { type: 'string', description: 'Optional finding id.' },
        symbol: { type: 'string', description: 'Symbol under test.' },
        path: { type: 'string', description: 'Preferred test file path.' },
        claimPattern: { type: 'string', description: 'Claim pattern or invariant under test.' },
        risk: { type: 'string', description: 'Risk category under test.' },
        legacyResponse: legacyResponseProperty,
      },
      required: [],
    },
  },
  {
    name: 'gn_trace_boundary',
    description:
      'Systems-audit resource boundary trace: trace FD/resource handoff across SCM_RIGHTS, pidfd_getfd, fork inheritance, and exec close-on-exec filtering without using FD number equality as identity proof.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        resource: {
          type: 'string',
          description: 'Resource kind to trace, for example fd or signal_mask.',
          default: 'fd',
        },
        start: {
          type: 'string',
          description: 'Starting symbol, file, or source-side handle label.',
        },
        end: {
          type: 'string',
          description: 'Optional expected destination symbol, file, or receiver label.',
        },
        mechanism: {
          type: 'string',
          enum: ['SCM_RIGHTS', 'pidfd_getfd', 'fork', 'exec'],
          description: 'Boundary handoff mechanism. Omit to infer from evidence.',
        },
        source: {
          type: 'string',
          description: 'Optional source text to trace directly.',
        },
        legacyResponse: legacyResponseProperty,
      },
      required: ['resource', 'start'],
    },
  },
  {
    name: 'gn_extract_fsm',
    description:
      'Systems-audit FSM extraction: map enum/state assignments, transition guards, and missing-state guard warnings from bounded source text or a source path.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        path: { type: 'string', description: 'Repository-relative source path to read.' },
        sourceText: { type: 'string', description: 'Inline source text to analyze.' },
        target: { type: 'string', description: 'Enum/state target, e.g. SidecarManager::State.' },
        enumName: { type: 'string', description: 'Optional enum name override.' },
        stateVariable: { type: 'string', description: 'State variable name to track.' },
        maxRecords: {
          type: 'number',
          description: 'Maximum states/transitions/warnings returned. Default: 50, max: 200.',
          default: 50,
          minimum: 1,
          maximum: 200,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: [],
    },
  },
  {
    name: 'gn_error_topology',
    description:
      'Systems-audit error topology: find errno/exception/error-return sources, checks, sinks, swallowed errors, and generic exit-code black holes.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        path: { type: 'string', description: 'Repository-relative source path to read.' },
        sourceText: { type: 'string', description: 'Inline source text to analyze.' },
        symbol: { type: 'string', description: 'Optional symbol under audit.' },
        maxRecords: {
          type: 'number',
          description: 'Maximum nodes/edges/findings returned. Default: 50, max: 200.',
          default: 50,
          minimum: 1,
          maximum: 200,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: [],
    },
  },
  {
    name: 'gn_concurrency_audit',
    description:
      'Systems-audit concurrency scan: identify locks, lock scopes, blocking or allocation work under locks, nested locks, and possible lock-order inversion.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        path: { type: 'string', description: 'Repository-relative source path to read.' },
        sourceText: { type: 'string', description: 'Inline source text to analyze.' },
        symbol: { type: 'string', description: 'Optional symbol under audit.' },
        maxFindings: {
          type: 'number',
          description: 'Maximum findings returned.',
          default: 50,
          minimum: 1,
          maximum: 200,
        },
        maxEvidence: {
          type: 'number',
          description: 'Maximum evidence records returned.',
          default: 100,
          minimum: 1,
          maximum: 200,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: [],
    },
  },
  {
    name: 'gn_pressure_impact',
    description:
      'Systems-audit pressure impact: model global quota/active-count/max-concurrent constraints and report ALL/global side-effect warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        path: { type: 'string', description: 'Repository-relative source path to read.' },
        sourceText: { type: 'string', description: 'Inline source text to analyze.' },
        symbol: { type: 'string', description: 'Optional symbol under audit.' },
        maxWarnings: {
          type: 'number',
          description: 'Maximum warnings returned.',
          default: 50,
          minimum: 1,
          maximum: 200,
        },
        maxEvidence: {
          type: 'number',
          description: 'Maximum evidence records returned.',
          default: 100,
          minimum: 1,
          maximum: 200,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: [],
    },
  },
  {
    name: 'gn_taint_trace',
    description:
      'Systems-audit taint trace: bounded source-to-sink data-flow heuristic with sanitizer detection and provenance-backed findings.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        path: { type: 'string', description: 'Repository-relative source path to read.' },
        sourceText: { type: 'string', description: 'Inline source text to analyze.' },
        source: { type: 'string', description: 'Untrusted source symbol/name.' },
        sourceName: { type: 'string', description: 'Alias for source symbol/name.' },
        sink: { type: 'string', description: 'Dangerous sink symbol/name.' },
        sinkName: { type: 'string', description: 'Alias for sink symbol/name.' },
        sanitizers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Known sanitizer function names.',
        },
        maxPaths: {
          type: 'number',
          description: 'Maximum taint paths returned. Default: 25, max: 100.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: ['source', 'sink'],
    },
  },
  {
    name: 'gn_abi_diff',
    description:
      'Systems-audit ABI diff: compare C++/Rust/JSON source payloads with TypeScript/JSON targets and flag precision, nullability, and field mismatches.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        sourceStruct: { type: 'string', description: 'Inline source struct or JSON payload.' },
        sourcePath: { type: 'string', description: 'Path to source struct or payload.' },
        targetInterface: {
          type: 'string',
          description: 'Inline target TypeScript interface or JSON payload.',
        },
        targetPath: { type: 'string', description: 'Path to target interface or payload.' },
        sourceLanguage: {
          type: 'string',
          enum: ['cpp', 'rust', 'json'],
          description: 'Source language hint.',
        },
        targetLanguage: {
          type: 'string',
          enum: ['typescript', 'json'],
          description: 'Target language hint.',
        },
        maxFindings: {
          type: 'number',
          description: 'Maximum findings returned. Default: 50, max: 100.',
          default: 50,
          minimum: 1,
          maximum: 100,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: [],
    },
  },
  {
    name: 'gn_simulate_fault',
    description:
      'Systems-audit semantic fault simulation: statically model a target call returning a chosen value and report likely branches, assignments, early returns, and bypass warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        path: { type: 'string', description: 'Repository-relative source path to read.' },
        sourceText: { type: 'string', description: 'Inline source text to analyze.' },
        target: { type: 'string', description: 'Target call to force, e.g. pidfd_open.' },
        targetCall: { type: 'string', description: 'Alias for target call.' },
        returnValue: { type: 'string', description: 'Injected return value.' },
        return_value: { type: 'string', description: 'Alias for injected return value.' },
        triggerPath: {
          type: 'array',
          items: { type: 'string' },
          description: 'Expected trigger path labels.',
        },
        maxBranches: {
          type: 'number',
          description: 'Maximum branches returned.',
          default: 20,
          minimum: 1,
          maximum: 200,
        },
        maxAssignments: {
          type: 'number',
          description: 'Maximum assignments returned.',
          default: 20,
          minimum: 1,
          maximum: 200,
        },
        maxEarlyReturns: {
          type: 'number',
          description: 'Maximum early returns returned.',
          default: 20,
          minimum: 1,
          maximum: 200,
        },
        legacyResponse: legacyResponseProperty,
      },
      required: ['target'],
    },
  },
  {
    name: 'gn_graph_walk',
    description:
      'Stateful graph traversal. Start a walk with a seed symbol, then step to explore neighbors based on a policy (follow-calls, follow-imports, expand-outward).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
        action: {
          type: 'string',
          description: 'Action to perform: start, step, or status.',
          enum: ['start', 'step', 'status'],
        },
        walkId: {
          type: 'string',
          description: 'ID of an active walk (required for step and status).',
        },
        seedSymbol: {
          type: 'string',
          description: 'Seed symbol to start the walk (required for start).',
        },
        navigationPolicy: {
          type: 'string',
          enum: ['follow-calls', 'follow-imports', 'expand-outward'],
          description: 'Policy for expansion. Default is follow-calls.',
          default: 'follow-calls',
        },
        maxSteps: {
          type: 'number',
          description: 'Maximum steps to allow. Default is 10, capped at 50.',
          default: 10,
          minimum: 1,
          maximum: 50,
        },
        maxFrontier: {
          type: 'number',
          description: 'Maximum queued frontier nodes. Default is 100, capped at 250.',
          default: 100,
          minimum: 1,
          maximum: 250,
        },
        maxExpansionPerStep: {
          type: 'number',
          description: 'Maximum neighbors read per step. Default is 5, capped at 25.',
          default: 5,
          minimum: 1,
          maximum: 25,
        },
      },
      required: ['action'],
    },
  },
];
