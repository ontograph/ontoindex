/**
 * gn_help — super-function discovery tool (Phase 5 W5a).
 *
 * A synchronous facade that returns a structured HelpReport listing all
 * registered super-functions with intent, category, and "when to use" text.
 * No external primitives are called — pure static data.
 *
 * Intended as the first call a 3rd-party agent makes when discovering the
 * gn_* surface.
 */

import {
  createEnvelopeFromLegacy,
  createGlobalTargetContext,
  type CapabilityResponseEnvelope,
} from '../shared/response-envelope.js';
import {
  type ContractStatus,
  getCallableToolNames,
  getMcpStartupProfileFromEnv,
  getMcpStartupProfileToolReport,
  getPublicToolRegistry,
  isToolDiscoverableInMode,
  type AgentMode,
  MCP_STARTUP_PROFILE_ENV,
  type McpStartupProfile,
  type PublicToolRegistryEntry,
  type ToolPermissionProfile,
} from '../shared/tool-registry.js';
import {
  EVIDENCE_READ_CLASSES,
  NON_AUTHORITATIVE_EVIDENCE_READ_CLASSES,
  type EvidenceReadClass,
} from '../../core/runtime/evidence-read-ledger.js';
import {
  recommendEvidenceGapNextSteps,
  type EvidenceGapCondition,
  type EvidenceGapNextStep,
  type EvidenceGapNextStepIssue,
} from '../../core/recommendations/evidence-gap-next-steps.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SuperFunctionEntry {
  name: string;
  category:
    | 'discovery'
    | 'docs'
    | 'safety'
    | 'refactor'
    | 'lifecycle'
    | 'audit'
    | 'systems-audit'
    | 'pr-review'
    | 'self-help';
  intent: string;
  whenToUse: string;
  contractStatus: ContractStatus;
  workflowIntents: readonly string[];
  producesEvidenceClasses: readonly EvidenceReadClass[];
  permissionProfile?: ToolPermissionProfile;
  auditAuthority: boolean;
  advisoryOnly: boolean;
}

export type StartupProfileName = McpStartupProfile;

export interface StartupProfileState {
  activeProfile: StartupProfileName;
  source: 'default' | 'env' | 'env-invalid-default';
  envVar: 'ONTOINDEX_MCP_STARTUP_PROFILE';
  invalidProfile?: string;
  advertisedCount: number;
  hiddenButCallableCount: number;
  fullPublicCount: number;
  facadesIncluded: boolean;
  enforcementMode: 'advertise_only';
  compatibilityMode: boolean;
  advertised: string[];
  hiddenButCallable: string[];
  integrationNote: string;
}

export interface ErgonomicsReview {
  toolCount: {
    superFunctions: number;
    docsAwareTools: string[];
  };
  setupSteps: string[];
  responseSize: {
    compactByDefault: boolean;
    boundedTools: string[];
    defaultDocsItems: number;
    maxDocsItems: number;
    stalePartialAmbiguousVisible: boolean;
  };
  schemaClarityNotes: string[];
  codebaseMemoryStyleComparison: string[];
  recommendedChanges: string[];
  workflowPrompts: Record<'docsTrace' | 'apiDrift' | 'editReadiness' | 'setupHelp', string>;
}

export interface EvidenceExpansionHelp {
  evidenceGaps: EvidenceGapCondition[];
  nextSteps: EvidenceGapNextStep[];
  nextTools: string[];
  nonToolActions: string[];
  issues: EvidenceGapNextStepIssue[];
  validation: {
    callableToolSource: 'public-tool-registry';
    publicCallable: boolean;
  };
}

export interface HelpReport {
  version: 1;
  /** When a mode was requested, the filtered agent mode. */
  mode?: AgentMode;
  /** Human-readable description of the requested mode. */
  modeDescription?: string;
  superFunctions: SuperFunctionEntry[];
  appliedFilters?: {
    query?: string;
    intent?: string[];
    evidenceClass?: EvidenceReadClass[];
    stability?: ContractStatus[];
    includeNonAuthoritativeEvidence?: boolean;
    limit?: number;
  };
  recommendedWorkflow: string[];
  primitivesAsEscapeHatch: string;
  ergonomicsReview: ErgonomicsReview;
  /** Deterministic ADR 0028 next steps for common evidence gaps. */
  evidenceExpansion: EvidenceExpansionHelp;
  /** Lightweight readiness reminders. Present only when `repo` is supplied. */
  readinessNotes?: string[];
  /** ADR 0027 startup-profile state for the advertised MCP surface. */
  startupProfile: StartupProfileState;
  /** Consolidated project memory (B12). */
  consolidatedMemory?: Record<string, unknown>;
}

export interface HelpParams {
  repo?: string;
  topic?: 'overview' | 'docs' | 'editing' | 'setup';
  /** Filter tools and workflow guidance to a specific agent mode. */
  mode?: AgentMode;
  /** Free-text discovery filter (name/intent/whenToUse/workflow intents). */
  query?: string;
  /** Workflow intent tags (string or string[]). */
  intent?: string | string[];
  /** Evidence class filter (alias to evidenceClasses for single-value calls). */
  evidenceClass?: EvidenceReadClass | EvidenceReadClass[];
  /** Evidence class filter. */
  evidenceClasses?: EvidenceReadClass[];
  /** Stability filter. */
  stability?: ContractStatus | ContractStatus[];
  /**
   * Include non-authoritative evidence classes in filtering.
   * Defaults to false to preserve ADR trust boundaries.
   */
  includeNonAuthoritativeEvidence?: boolean;
  /**
   * Include consolidated episodic memories (B12).
   * Defaults to false. Requires `repo` to be supplied.
   */
  includeMemories?: boolean;
  /** Optional cap for filtered results (bounded and deterministic). */
  limit?: number;
  legacyResponse?: boolean;
}

// ---------------------------------------------------------------------------
// Mode metadata
// ---------------------------------------------------------------------------

const MODE_DESCRIPTIONS: Record<AgentMode, string> = {
  general: 'General exploration, editing, docs, and session setup',
  audit: 'Audit lifecycle: ingest findings, verify, dedupe, bundle, dispatch, and worker review',
  refactor: 'Safe refactor operations: rename, extract, move, and modify with impact analysis',
  'query-projects':
    'Read-only discovery: explore repos and groups, query symbols, inspect context and impact — no edits or write operations',
};

const MODE_WORKFLOWS: Record<AgentMode, string[]> = {
  general: [
    '0. Set quality once: gn_quality_mode({level: "balanced"})',
    '0b. Check docs readiness when docs/code trace matters: gn_docs({action: "readiness"})',
    '1. Discover: gn_explore({query: "..."})',
    '2. Zoom: gn_find_related({symbol: "..."})',
    '3. Understand file: gn_explain_module({filePath: "..."})',
    '4. Pre-edit safety: gn_safe_edit_check({symbol: "..."})',
    '7. Apply edit: gn_safe_refactor({intent, symbol, params})',
    '8. Pre-commit: gn_pre_commit_audit({scope: "staged"})',
    '9. Local diff review (CLI): `ontoindex review diff --base main` — local-only, no hosted credentials; run `ontoindex analyze` first for full graph results',
    '9a. MCP blast-radius: gn_diff_impact({commitRange: "main...HEAD"}) — MCP surface; hosted PR adapter is a later Phase 6 feature',
    '10. Self-help: gn_diagnose({}) when troubleshooting',
  ],
  audit: [
    '0a. Check tool contract when using audit/system tools: gn_tool_contract({})',
    '0b. Check docs readiness when docs/code trace matters: gn_docs({action: "readiness"})',
    '5. Manager audit loop: gn_audit_session_start({sourcePath: "..."}) -> gn_audit_session_verify({session: "..."}) -> gn_audit_session_dedupe({session: "..."}) -> gn_audit_session_bundle({session: "..."})',
    '5a. Manager dispatch/review: gn_audit_session_dispatch({session: "...", bundleId: "..."}) -> worker edits -> gn_audit_session_review_worker({session: "...", bundleId: "..."})',
    '5b. Primitive escape hatch: gn_audit_ingest({sourcePath: "..."}) -> gn_audit_session_lock({session: "...", action: "create"}) -> gn_audit_verify({session: "..."}) -> gn_audit_dedupe({session: "..."}) -> gn_audit_bundle({session: "..."})',
    '5c. Avoid stale repeats: gn_audit_pr_marker_scan({path: "...", evidenceLine: 42}) -> gn_audit_replay({session: "..."}) or gn_audit_diff({sessionA: "...", sessionB: "..."}) -> gn_audit_export({session: "...", format: "both"})',
    '6. Systems evidence: gn_audit_logic({path: "..."}) or gn_resource_trace({path: "..."}) or gn_extract_fsm({path: "...", stateVariable: "state"})',
    '6a. Boundary/runtime reasoning: gn_trace_boundary({resource: "fd", start: "..."}) or gn_simulate_fault({target: "pidfd_open", returnValue: "-1"})',
    '10. Self-help: gn_diagnose({}) when troubleshooting',
  ],
  refactor: [
    '0. Set quality once: gn_quality_mode({level: "balanced"})',
    '1. Discover: gn_explore({query: "..."})',
    '2. Zoom: gn_find_related({symbol: "..."})',
    '3. Understand file: gn_explain_module({filePath: "..."})',
    '4. Pre-edit safety: gn_safe_edit_check({symbol: "..."})',
    '7. Apply edit: gn_safe_refactor({intent, symbol, params})',
    '8. Pre-commit: gn_pre_commit_audit({scope: "staged"})',
    '10. Self-help: gn_diagnose({}) when troubleshooting',
  ],
  'query-projects': [
    '0. Set quality once: gn_quality_mode({level: "balanced"})',
    '1. Discover repos or groups: discover({action: "repos"}) or discover({action: "groups"})',
    '2. Explore concepts: gn_explore({query: "..."})',
    '3. Find related symbols: gn_find_related({symbol: "..."})',
    '4. Understand a file: gn_explain_module({filePath: "..."})',
    '5. Query impact (read-only): impact({target: "..."}) or gn_docs({action: "readiness"})',
    '6. Search across the graph: search({query: "..."})',
    '7. Inspect symbol context: inspect({name: "..."})',
    '8. Self-help: gn_diagnose({}) when troubleshooting',
  ],
};

// Readiness notes emitted when `repo` is supplied (static guidance, no I/O).
const REPO_READINESS_NOTES: string[] = [
  'Run gn_diagnose({repo: "<repo>"}) to check index freshness, embeddings, and LSP availability.',
  'Run gn_ensure_fresh({repo: "<repo>"}) before retrieval-heavy operations if the repo was recently edited.',
  'If docs sidecar is missing, stale, or partial, run `ontoindex docs refresh` or `ontoindex analyze --markdown-sidecar` before relying on docs evidence.',
  'If embeddings are missing or stale, re-index with: ontoindex analyze --embeddings',
  'If the worktree is dirty, commit or stash changes before running ontoindex analyze to avoid partial-graph results.',
  'If LSP or sidecar features are absent, verify language server configuration and re-run ontoindex analyze.',
];

const STARTUP_PROFILE_INTEGRATION_NOTE =
  'Computed from registry startup-profile helpers; MCP dispatch remains advertise-only during ADR 0027 migration.';

const HELP_EVIDENCE_GAP_CONDITIONS: readonly EvidenceGapCondition[] = [
  'stale_index',
  'tool_contract_drift',
  'docs_only_code_behavior_claim',
];

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function gnHelp(params?: HelpParams & { legacyResponse?: true }): HelpReport;
export function gnHelp(
  params: HelpParams & { legacyResponse: false },
): CapabilityResponseEnvelope<Record<string, unknown>>;
export function gnHelp(
  params: HelpParams,
): HelpReport | CapabilityResponseEnvelope<Record<string, unknown>>;
export function gnHelp(
  params: HelpParams = {},
): HelpReport | CapabilityResponseEnvelope<Record<string, unknown>> {
  const { mode, repo } = params;
  const includeNonAuthoritativeEvidence = params.includeNonAuthoritativeEvidence === true;

  const allSuperEntries = getPublicToolRegistry({
    includeFacades: false,
  });

  const allSuperFunctions: SuperFunctionEntry[] = allSuperEntries.map((entry) =>
    mapToSuperFunctionEntry(entry),
  );

  let superFunctions = mode
    ? allSuperFunctions.filter((entry) => isToolDiscoverableInMode(entry.name, mode))
    : allSuperFunctions;

  const requestedStability = normalizeStabilityFilter(params.stability);
  if (requestedStability.length > 0) {
    const allowed = new Set(requestedStability);
    superFunctions = superFunctions.filter((entry) => allowed.has(entry.contractStatus));
  }

  const requestedIntents = normalizeIntentFilter(params.intent);
  if (requestedIntents.length > 0) {
    superFunctions = superFunctions.filter((entry) => matchesIntentFilter(entry, requestedIntents));
  }

  const requestedEvidenceClasses = normalizeEvidenceClassFilter(
    params,
    includeNonAuthoritativeEvidence,
  );
  const evidenceFilterRequested = hasEvidenceClassFilter(params);
  if (evidenceFilterRequested && requestedEvidenceClasses.length === 0) {
    superFunctions = [];
  } else if (requestedEvidenceClasses.length > 0) {
    const requested = new Set(requestedEvidenceClasses);
    superFunctions = superFunctions.filter((entry) =>
      entry.producesEvidenceClasses.some((evidenceClass) => requested.has(evidenceClass)),
    );
  }

  const query = normalizeQuery(params.query);
  if (query) {
    const ranked = superFunctions
      .map((entry) => ({ entry, score: scoreQueryMatch(entry, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    superFunctions = ranked.map((item) => item.entry);
  }

  const boundedLimit = normalizeLimit(params.limit);
  if (boundedLimit !== undefined) {
    superFunctions = superFunctions.slice(0, boundedLimit);
  }

  const recommendedWorkflow = mode
    ? MODE_WORKFLOWS[mode]
    : [
        '0. Set quality once: gn_quality_mode({level: "balanced"})',
        '0a. Check tool contract when using audit/system tools: gn_tool_contract({})',
        '0b. Check docs readiness when docs/code trace matters: gn_docs({action: "readiness"})',
        '1. Discover: gn_explore({query: "..."})',
        '2. Zoom: gn_find_related({symbol: "..."})',
        '3. Understand file: gn_explain_module({filePath: "..."})',
        '4. Pre-edit safety: gn_safe_edit_check({symbol: "..."})',
        '5. Manager audit loop: gn_audit_session_start({sourcePath: "..."}) -> gn_audit_session_verify({session: "..."}) -> gn_audit_session_dedupe({session: "..."}) -> gn_audit_session_bundle({session: "..."})',
        '5a. Manager dispatch/review: gn_audit_session_dispatch({session: "...", bundleId: "..."}) -> worker edits -> gn_audit_session_review_worker({session: "...", bundleId: "..."})',
        '5b. Primitive escape hatch: gn_audit_ingest({sourcePath: "..."}) -> gn_audit_session_lock({session: "...", action: "create"}) -> gn_audit_verify({session: "..."}) -> gn_audit_dedupe({session: "..."}) -> gn_audit_bundle({session: "..."})',
        '5c. Avoid stale repeats: gn_audit_pr_marker_scan({path: "...", evidenceLine: 42}) -> gn_audit_replay({session: "..."}) or gn_audit_diff({sessionA: "...", sessionB: "..."}) -> gn_audit_export({session: "...", format: "both"})',
        '6. Systems evidence: gn_audit_logic({path: "..."}) or gn_resource_trace({path: "..."}) or gn_extract_fsm({path: "...", stateVariable: "state"})',
        '6a. Boundary/runtime reasoning: gn_trace_boundary({resource: "fd", start: "..."}) or gn_simulate_fault({target: "pidfd_open", returnValue: "-1"})',
        '7. Apply edit: gn_safe_refactor({intent, symbol, params})',
        '8. Pre-commit: gn_pre_commit_audit({scope: "staged"})',
        '9. Local diff review (CLI): `ontoindex review diff --base main` — local-only, no hosted credentials; run `ontoindex analyze` first for full graph results',
        '9a. MCP blast-radius: gn_diff_impact({commitRange: "main...HEAD"}) — MCP surface; hosted PR adapter is a later Phase 6 feature',
        '10. Self-help: gn_diagnose({}) when troubleshooting',
      ];

  const evidenceExpansion = buildEvidenceExpansionHelp();

  const report: HelpReport = {
    version: 1,
    ...(mode !== undefined ? { mode, modeDescription: MODE_DESCRIPTIONS[mode] } : {}),
    superFunctions,
    ...((query ||
      requestedIntents.length > 0 ||
      requestedEvidenceClasses.length > 0 ||
      requestedStability.length > 0 ||
      boundedLimit !== undefined) && {
      appliedFilters: {
        ...(query ? { query: params.query?.trim() } : {}),
        ...(requestedIntents.length > 0 ? { intent: requestedIntents } : {}),
        ...(requestedEvidenceClasses.length > 0 ? { evidenceClass: requestedEvidenceClasses } : {}),
        ...(requestedStability.length > 0 ? { stability: requestedStability } : {}),
        ...(params.includeNonAuthoritativeEvidence !== undefined
          ? { includeNonAuthoritativeEvidence }
          : {}),
        ...(boundedLimit !== undefined ? { limit: boundedLimit } : {}),
      },
    }),
    recommendedWorkflow,
    primitivesAsEscapeHatch:
      'Existing ontoindex_* tools (query, context, impact, rename, etc.) remain available as escape hatch for power users. Super-functions wrap them with auto-env-vars + verdicts + safety wrappers.',
    ergonomicsReview: {
      toolCount: {
        superFunctions: allSuperFunctions.length,
        docsAwareTools: ['gn_docs', 'search', 'inspect', 'context', 'query'],
      },
      setupSteps: [
        'Call gn_help({}) once to choose the smallest workflow.',
        'Call gn_quality_mode({level: "balanced"}) once per session.',
        'For docs/code work, call gn_docs({action: "readiness"}) before trace or drift.',
      ],
      responseSize: {
        compactByDefault: true,
        boundedTools: ['gn_docs', 'search.limit', 'inspect.limit', 'repomap.token_budget'],
        defaultDocsItems: 25,
        maxDocsItems: 100,
        stalePartialAmbiguousVisible: true,
      },
      schemaClarityNotes: [
        'gn_docs exposes typed actions instead of raw docs graph query strings.',
        'Docs trace and drift keep sidecar status, skip reasons, truncation, and candidate counts in compact output.',
        'Facade aliases let common inspect/impact calls use target without learning backend parameter names.',
      ],
      codebaseMemoryStyleComparison: [
        'Research-only comparison: prefer a small setup/help entrypoint, bounded context modes, and explicit stale/partial state.',
        'No runtime dependency or migration to Codebase-Memory-style storage is required.',
      ],
      recommendedChanges: [
        'Prefer gn_docs for requirement trace, API drift, docs context, and docs readiness questions; use includeMemories only for advisory context/readiness.',
        'Keep Markdown enrichment opt-ins explicit on search/inspect to avoid surprising response growth.',
        'Use lower defaults with schema maximums so agents can ask for more only when needed.',
      ],
      workflowPrompts: {
        docsTrace: 'Which requirement implements REQ-1? -> gn_docs({action: "trace", id: "REQ-1"})',
        apiDrift: 'Do docs and code disagree on routes? -> gn_docs({action: "drift"})',
        editReadiness:
          'Is it safe to edit parseDocs()? -> gn_safe_edit_check({symbol: "parseDocs"})',
        setupHelp:
          'How should I start this session? -> gn_help({}) then gn_quality_mode({level: "balanced"})',
      },
    },
    evidenceExpansion,
    ...(repo !== undefined ? { readinessNotes: REPO_READINESS_NOTES } : {}),
    startupProfile: getStartupProfileState(),
  };

  if (params.legacyResponse !== false) {
    return report;
  }

  return createEnvelopeFromLegacy({
    legacy: report as unknown as Record<string, unknown>,
    tool: 'gn_help',
    status: 'ok',
    targetContext: createGlobalTargetContext('gn_help is global by default'),
    capabilitiesUsed: ['tool-registry'],
    nextTools: uniqueStrings([
      'gn_quality_mode',
      'gn_explore',
      'gn_diagnose',
      ...evidenceExpansion.nextTools,
    ]),
  });
}

export function getStartupProfileState(): StartupProfileState {
  const rawProfile = process.env[MCP_STARTUP_PROFILE_ENV]?.trim();
  const activeProfile = getMcpStartupProfileFromEnv();
  const source: StartupProfileState['source'] =
    rawProfile === undefined || rawProfile.length === 0
      ? 'default'
      : activeProfile === rawProfile.toLowerCase()
        ? 'env'
        : 'env-invalid-default';
  const registryReport = getMcpStartupProfileToolReport({
    includeFacades: true,
    startupProfile: activeProfile,
  });
  const advertised = sortedToolNames(
    getPublicToolRegistry({ includeFacades: true, startupProfile: activeProfile }),
  );
  const hiddenButCallable = [...registryReport.hiddenToolNames].sort();

  return {
    activeProfile,
    source,
    envVar: MCP_STARTUP_PROFILE_ENV,
    ...(source === 'env-invalid-default' && rawProfile ? { invalidProfile: rawProfile } : {}),
    advertisedCount: registryReport.advertisedToolCount,
    hiddenButCallableCount: registryReport.hiddenButCallableToolCount,
    fullPublicCount: registryReport.fullPublicToolCount,
    facadesIncluded: registryReport.includesFacades,
    enforcementMode: registryReport.enforcement,
    compatibilityMode: hiddenButCallable.length > 0,
    advertised,
    hiddenButCallable,
    integrationNote: STARTUP_PROFILE_INTEGRATION_NOTE,
  };
}

function sortedToolNames(entries: readonly PublicToolRegistryEntry[]): string[] {
  return Array.from(new Set(entries.map((entry) => entry.name))).sort();
}

function buildEvidenceExpansionHelp(): EvidenceExpansionHelp {
  const recommendations = recommendEvidenceGapNextSteps(HELP_EVIDENCE_GAP_CONDITIONS, {
    callableToolNames: getCallableToolNames({ includeFacades: true }),
  });

  return {
    evidenceGaps: [...HELP_EVIDENCE_GAP_CONDITIONS],
    nextSteps: recommendations.nextSteps,
    nextTools: recommendations.nextTools,
    nonToolActions: recommendations.nonToolActions,
    issues: recommendations.issues,
    validation: {
      callableToolSource: 'public-tool-registry',
      publicCallable: recommendations.issues.every((issue) => issue.field !== 'nextTools'),
    },
  };
}

function mapToSuperFunctionEntry(entry: PublicToolRegistryEntry): SuperFunctionEntry {
  return {
    name: entry.name,
    category: entry.category,
    intent: entry.intent,
    whenToUse: entry.whenToUse,
    contractStatus: entry.contractStatus,
    workflowIntents: entry.workflowIntents,
    producesEvidenceClasses: entry.producesEvidenceClasses,
    permissionProfile: entry.permissionProfile,
    auditAuthority: entry.auditAuthority,
    advisoryOnly: entry.advisoryOnly,
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function normalizeIntentFilter(intent?: string | string[]): string[] {
  const values = Array.isArray(intent) ? intent : intent ? [intent] : [];
  return Array.from(
    new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)),
  ).sort();
}

function normalizeEvidenceClassFilter(
  params: HelpParams,
  includeNonAuthoritativeEvidence: boolean,
): EvidenceReadClass[] {
  const values = [
    ...(Array.isArray(params.evidenceClass)
      ? params.evidenceClass
      : params.evidenceClass
        ? [params.evidenceClass]
        : []),
    ...(params.evidenceClasses ?? []),
  ];
  const filtered = Array.from(
    new Set(values.filter((value): value is EvidenceReadClass => EVIDENCE_CLASS_SET.has(value))),
  ).sort();

  if (includeNonAuthoritativeEvidence) {
    return filtered;
  }
  return filtered.filter((value) => !NON_AUTHORITATIVE_EVIDENCE_CLASSES.has(value));
}

function normalizeStabilityFilter(stability?: ContractStatus | ContractStatus[]): ContractStatus[] {
  const values = Array.isArray(stability) ? stability : stability ? [stability] : [];
  return Array.from(
    new Set(values.filter((value): value is ContractStatus => STABILITY_SET.has(value))),
  ).sort();
}

function normalizeQuery(query?: string): string[] | undefined {
  if (!query || query.trim().length === 0) return undefined;
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((token) => token.length >= 2);
  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    if (token.endsWith('ly') && token.length > 4) {
      expanded.add(token.slice(0, -2));
    }
  }
  return expanded.size > 0 ? Array.from(expanded).sort() : undefined;
}

function normalizeLimit(limit?: number): number | undefined {
  if (limit === undefined || !Number.isFinite(limit)) return undefined;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

function matchesIntentFilter(
  entry: SuperFunctionEntry,
  requestedIntents: readonly string[],
): boolean {
  const searchable = [
    entry.name.toLowerCase(),
    entry.category.toLowerCase(),
    entry.intent.toLowerCase(),
    entry.whenToUse.toLowerCase(),
    ...entry.workflowIntents.map((value) => value.toLowerCase()),
  ];
  return requestedIntents.some(
    (needle) =>
      entry.workflowIntents.includes(needle) ||
      searchable.some((candidate) => candidate.includes(needle)),
  );
}

function scoreQueryMatch(entry: SuperFunctionEntry, queryTokens: readonly string[]): number {
  const name = entry.name.toLowerCase();
  const intent = entry.intent.toLowerCase();
  const whenToUse = entry.whenToUse.toLowerCase();
  const category = entry.category.toLowerCase();
  const workflowIntents = entry.workflowIntents.map((value) => value.toLowerCase());
  let score = 0;
  for (const token of queryTokens) {
    if (name.includes(token)) score += 6;
    if (workflowIntents.some((value) => value.includes(token))) score += 5;
    if (intent.includes(token)) score += 4;
    if (whenToUse.includes(token)) score += 3;
    if (category.includes(token)) score += 2;
  }
  return score;
}

const EVIDENCE_CLASS_SET = new Set<EvidenceReadClass>(EVIDENCE_READ_CLASSES);

const NON_AUTHORITATIVE_EVIDENCE_CLASSES = new Set<EvidenceReadClass>(
  NON_AUTHORITATIVE_EVIDENCE_READ_CLASSES,
);

const STABILITY_SET = new Set<ContractStatus>(['stable', 'experimental', 'deprecated']);

function hasEvidenceClassFilter(params: HelpParams): boolean {
  if (Array.isArray(params.evidenceClass)) return params.evidenceClass.length > 0;
  if (params.evidenceClass) return true;
  if (Array.isArray(params.evidenceClasses)) return params.evidenceClasses.length > 0;
  return false;
}
