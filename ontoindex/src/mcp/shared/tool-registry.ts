import { ONTOINDEX_FACADE_TOOLS } from '../facade/tool-definitions.js';
import { ONTOINDEX_SUPER_TOOLS } from '../super/tool-definitions.js';
import type { ToolDefinition } from '../tools.js';
import type { EvidenceReadClass } from '../../core/runtime/evidence-read-ledger.js';

export type PublicToolKind = 'super' | 'facade';

// ---------------------------------------------------------------------------
// AgentMode — mode tag for mode-filtered registry access (SERENA-REV1)
// ---------------------------------------------------------------------------

export type AgentMode = 'general' | 'audit' | 'refactor' | 'query-projects';

export const ALL_AGENT_MODES: readonly AgentMode[] = [
  'general',
  'audit',
  'refactor',
  'query-projects',
];

/** Modes that permit write/mutation operations. */
const WRITE_AGENT_MODES: readonly AgentMode[] = ['general', 'audit', 'refactor'];

export type McpStartupProfile = 'core' | 'query' | 'audit' | 'refactor' | 'systems' | 'public-full';

export const ALL_MCP_STARTUP_PROFILES: readonly McpStartupProfile[] = [
  'core',
  'query',
  'audit',
  'refactor',
  'systems',
  'public-full',
];

export const DEFAULT_MCP_STARTUP_PROFILE: McpStartupProfile = 'public-full';
export const MCP_STARTUP_PROFILE_ENV = 'ONTOINDEX_MCP_STARTUP_PROFILE';

export interface McpStartupProfileToolReport {
  startupProfile: McpStartupProfile;
  enforcement: 'advertise_only';
  advertisedToolCount: number;
  hiddenButCallableToolCount: number;
  fullPublicToolCount: number;
  includesFacades: boolean;
  hiddenToolNames: readonly string[];
}

export type ContractStatus = 'stable' | 'experimental' | 'deprecated';
export type ToolVisibility = 'public' | 'internal';
export type ToolPermissionProfile =
  | 'read_only'
  | 'advisory'
  | 'write_dry_run'
  | 'write_apply'
  | 'release'
  | 'runtime_admin';
export type EvidenceFreshnessBehavior =
  | 'index_freshness_checked'
  | 'docs_policy_checked'
  | 'audit_target_locked'
  | 'memory_freshness_declared'
  | 'runtime_current'
  | 'not_declared';
export type EvidenceTruncationPolicy =
  | 'bounded_mcp_response'
  | 'caller_limited_response'
  | 'not_applicable';
export type EvidenceResponsePolicy = 'structured_response' | 'text_response';

export interface EvidenceSourceContractMetadata {
  evidenceClass: EvidenceReadClass;
  freshnessBehavior: EvidenceFreshnessBehavior;
  auditAuthority: boolean;
  provenanceFields: readonly string[];
  truncationPolicy: EvidenceTruncationPolicy;
  responsePolicy: EvidenceResponsePolicy;
  safeForBasedOnReads: boolean;
  advisoryOnly: boolean;
}

export interface PropertyMetadata {
  property: string;
  contractStatus: ContractStatus;
  owner?: string;
  defaultBehavior?: string;
  since?: string;
  replacement?: string;
}

export interface ActionMetadata {
  action: string;
  contractStatus: ContractStatus;
  structuredOutput: boolean;
  dispatchCategory?: string;
  owner?: string;
  defaultBehavior?: string;
  since?: string;
  replacement?: string;
}

export interface ToolContractMetadata {
  name: string;
  kind: PublicToolKind;
  /** Agent modes in which this tool is discoverable. */
  modes: readonly AgentMode[];
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
  visibility: ToolVisibility;
  structuredOutput: boolean;
  owner?: string;
  defaultBehavior?: string;
  replacement?: string;
  fallback?: string;
  /** Optional workflow-intent tags used by help/contract discovery filters. */
  workflowIntents?: readonly string[];
  /** Evidence classes this tool can emit. */
  producesEvidenceClasses?: readonly EvidenceReadClass[];
  /** Permission contract metadata (informational; not an enforcement gate). */
  permissionProfile?: ToolPermissionProfile;
  /** Whether this tool can contribute directly to audit/release status. */
  auditAuthority?: boolean;
  /** Advisory-only outputs are never authoritative by default. */
  advisoryOnly?: boolean;
  /** ADR 0028 per-evidence-class source metadata. */
  evidenceSources?: readonly EvidenceSourceContractMetadata[];
  properties?: PropertyMetadata[];
  /** Optional action-level metadata for facades. */
  actions?: ActionMetadata[];
}

// ---------------------------------------------------------------------------
// Backend fallback actions — callable but NOT part of public MCP discovery
// ---------------------------------------------------------------------------

/**
 * Tools discoverable in query-projects mode.
 * Strictly read-only: repo/group discovery plus query/context/impact surfaces.
 * No safety-check, edit, refactor, audit, or systems-audit tools.
 */
export const QUERY_PROJECTS_TOOL_NAMES: ReadonlySet<string> = new Set([
  'gn_explore',
  'gn_explain_module',
  'gn_find_related',
  'gn_docs',
  'gn_diagnose',
  'gn_help',
  'gn_tool_contract',
  'gn_ensure_fresh',
  'gn_quality_mode',
  // facade read-only surfaces
  'discover',
  'search',
  'inspect',
  'impact',
  'docs',
]);

/** Names of backend write actions that are accessible as direct tool calls but
 *  are intentionally excluded from the public advertised registry and from
 *  any mode-filtered discovery result. */
export const BACKEND_FALLBACK_ACTION_NAMES: ReadonlySet<string> = new Set([
  'rename_symbol',
  'update_symbol_body',
]);

// ---------------------------------------------------------------------------
// Public registry types
// ---------------------------------------------------------------------------

export interface PublicToolRegistryEntry {
  kind: PublicToolKind;
  name: string;
  callable: true;
  definition: ToolDefinition;
  modes: readonly AgentMode[];
  category: ToolContractMetadata['category'];
  intent: string;
  whenToUse: string;
  contractStatus: ContractStatus;
  visibility: ToolVisibility;
  structuredOutput: boolean;
  owner?: string;
  defaultBehavior?: string;
  replacement?: string;
  fallback?: string;
  workflowIntents: readonly string[];
  producesEvidenceClasses: readonly EvidenceReadClass[];
  permissionProfile?: ToolPermissionProfile;
  auditAuthority: boolean;
  advisoryOnly: boolean;
  evidenceSources: readonly EvidenceSourceContractMetadata[];
  properties?: PropertyMetadata[];
  actions?: ActionMetadata[];
}

export interface ToolNameOptions {
  includeFacades?: boolean;
  /** When provided, limit results to tools discoverable in this mode. */
  mode?: AgentMode;
  /** When provided, limit advertised results to this startup profile. */
  startupProfile?: McpStartupProfile;
}

const TOOL_METADATA_LIST: ToolContractMetadata[] = [
  // --- Public Super Tools ---
  {
    name: 'gn_graph_walk',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'discovery',
    intent: 'Iterative, agent-controlled graph exploration',
    whenToUse: 'Step-by-step neighbor discovery from a seed symbol',
    contractStatus: 'experimental',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_explore',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'discovery',
    intent: 'Help me understand this concept',
    whenToUse: 'First exploration of unfamiliar code',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_explain_module',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'discovery',
    intent: 'What does this file do?',
    whenToUse: 'Need overview of a specific file',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_find_related',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'discovery',
    intent: 'What is near this symbol?',
    whenToUse: 'Symbol-level neighborhood',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_safe_edit_check',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'safety',
    intent: 'Is it safe to edit this?',
    whenToUse: 'Before any edit (replaces ontoindex_impact)',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_can_delete',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'safety',
    intent: 'Can I delete this?',
    whenToUse: 'Dead-code check',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_pre_commit_audit',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'safety',
    intent: 'Is this commit ready to ship?',
    whenToUse: 'Before commit (replaces ontoindex_detect_changes)',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_safe_refactor',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'refactor',
    intent: 'Apply rename/extract/move/modify safely',
    whenToUse: 'Any refactor (single dispatcher for 6 atomic tools; defaults to dryRun:true)',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: false,
  },
  {
    name: 'gn_ensure_fresh',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Make sure the index is current',
    whenToUse: 'Before retrieval-heavy ops if repo edited recently',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_quality_mode',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Set retrieval quality preset',
    whenToUse: 'At session start (fast/balanced/thorough)',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: false,
  },
  {
    name: 'gn_diff_impact',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'pr-review',
    intent: 'What is the blast radius of these commits? (MCP surface)',
    whenToUse:
      'Commit-range or staged blast-radius analysis via MCP; pair with `ontoindex review diff` for local CLI review. Hosted PR adapter is a later Phase 6 feature.',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_review_diff',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'pr-review',
    intent: 'Return graph-aware diff review in the ADR 0018 envelope',
    whenToUse: 'Machine-readable local diff review aligned with ontoindex review diff --json',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_diagnose',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'self-help',
    intent: 'What is not optimal in my OntoIndex setup?',
    whenToUse: 'When something feels off; session-start health check',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_propose_location',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'self-help',
    intent: 'Where should I add new code for X?',
    whenToUse: 'When adding new code; cluster-aware placement suggestion',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_tool_contract',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'self-help',
    intent: 'Verify gn_help advertised tools match the registered callable MCP frontier',
    whenToUse: 'At session start or after Unknown tool errors to detect stale MCP/runtime drift',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_docs',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'docs',
    intent: 'Inspect docs trace, drift, context, or readiness',
    whenToUse:
      'When you need bounded docs evidence without raw graph queries; use includeMemories only for advisory context/readiness and never as trace/drift evidence.',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_ingest',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'audit',
    intent: 'Ingest an audit report as candidate findings',
    whenToUse: 'Before verifying or bundling audit findings; never emits OPEN',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_verify',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'audit',
    intent: 'Verify candidate findings against target HEAD',
    whenToUse: 'Before accepting OPEN or RESOLVED audit status',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_fix_history',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'audit',
    intent: 'Find commits that may have fixed a finding',
    whenToUse: 'When a finding may be stale or already resolved',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_bundle',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'audit',
    intent: 'Group verified findings into implementation bundles',
    whenToUse: 'After verification and linting, before implementation planning',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_lint',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'audit',
    intent: 'Check audit quality gates',
    whenToUse: 'Before accepting an audit report or bundle set',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_dedupe',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'audit',
    intent: 'Collapse duplicate findings by root cause, write-set, symbol, or test surface',
    whenToUse: 'Before bundling noisy audit reports or re-emitted stale claims',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_dispatch_prompt',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'audit',
    intent: 'Generate one concrete worker prompt for one verified bundle',
    whenToUse: 'After bundling and before assigning implementation work',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_tombstone_create',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'audit',
    intent: 'Record fixed findings that must not be reopened while invariants hold',
    whenToUse: 'After a verified fix or RESOLVED-ALREADY classification',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_session_start',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Start the governed manager loop by ingesting findings and creating a session lock',
    whenToUse: 'Preferred first step for customer-facing audit work',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_session_verify',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Verify a locked audit session and enforce repeated-finding tombstones before work',
    whenToUse: 'Preferred verification step in the manager loop',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_session_dedupe',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Collapse duplicates inside the locked manager loop',
    whenToUse: 'Before manager bundling or dispatch',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_session_bundle',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Run dedupe first, then create implementation bundles in the manager loop',
    whenToUse: 'Preferred bundling step before dispatch',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_session_dispatch',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Generate a worker prompt only for a persisted, dispatchable manager bundle',
    whenToUse: 'Preferred worker handoff path after manager bundling',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_session_review_worker',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Review worker edits with scope guard and required test checks',
    whenToUse: 'Preferred post-worker manager review step',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_session_lock',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Create or validate a hard HEAD/graph/tombstone lock for an audit session',
    whenToUse:
      'Before lifecycle work and whenever current HEAD or graph freshness may have drifted',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_pr_marker_scan',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'audit',
    intent: 'Find nearby PR/TODO/FIXME/follow-up/deferred markers around evidence',
    whenToUse:
      'Before reflagging code that may already be known deferred debt or decision-gated work',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_diff',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'audit',
    intent: 'Show semantic changes between two audit sessions',
    whenToUse: 'When comparing audit rounds or producing an audit changelog',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_replay',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'audit',
    intent: 'Plan re-verification of a prior session against a newer target HEAD',
    whenToUse: 'When avoiding regenerated stale Markdown audits after code has changed',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_export',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'audit',
    intent: 'Export canonical audit session JSON or generated Markdown',
    whenToUse: 'When producing audit artifacts without hand-written stale prose reports',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_verify_diff',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Compare expected scope against actual changed files, symbols, impact, and tests',
    whenToUse: 'After edits when detect_changes alone is too vague',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_test_gap',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Report changed production symbols with missing test evidence',
    whenToUse: 'After edits to confirm changed code still has linked or executed tests',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_worker_scope_review',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Run write-through review for a dispatched bundle after worker edits',
    whenToUse: 'Preferred explicit worker verification step after bundle edits',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_scope_guard',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'audit',
    intent: 'Check whether a worker stayed inside bundle scope',
    whenToUse: 'During manager review of an implementation diff',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_bundle_conflicts',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'audit',
    intent: 'Detect write-set, symbol, file, and test-surface conflicts between bundles',
    whenToUse: 'Before dispatching bundles in parallel',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_audit_logic',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'systems-audit',
    intent: 'Scan for systems anti-pattern evidence',
    whenToUse: 'When auditing resources, fork safety, signals, TOCTOU, or concurrency',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_resource_trace',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'systems-audit',
    intent: 'Trace POSIX resource ownership acquire/duplicate/release facts',
    whenToUse:
      'When proving or rejecting fd, pid, pidfd, pipe, socket, fork, exec, or wait lifecycle claims',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_path_verify',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'systems-audit',
    intent: 'Verify shallow branch/path invariants',
    whenToUse:
      'When a finding depends on a specific branch such as fork failure or MSG_CTRUNC handling',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_test_suggestions',
    kind: 'super',
    modes: WRITE_AGENT_MODES,
    category: 'systems-audit',
    intent: 'Suggest the smallest audit regression test shape',
    whenToUse: 'For a verified OPEN finding that needs test evidence before dispatch',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_trace_boundary',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'systems-audit',
    intent: 'Trace resource handoff across process boundaries',
    whenToUse: 'When following FD or process-boundary resource lifecycle evidence',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_extract_fsm',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'systems-audit',
    intent: 'Extract state machines from enums and state variables',
    whenToUse: 'When state transitions or missing guards are spread across a class/module',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_error_topology',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'systems-audit',
    intent: 'Map error sources, sinks, and swallowed failures',
    whenToUse: 'When auditing errno, exceptions, generic exits, or silent catch blocks',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_concurrency_audit',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'systems-audit',
    intent: 'Find lock-scope hazards and lock-order risks',
    whenToUse: 'When auditing mutex contention, blocking calls under locks, or inversion risk',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_pressure_impact',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'systems-audit',
    intent: 'Find global quota and saturation side effects',
    whenToUse: 'When a symbol changes active counts, quotas, or max-concurrent constraints',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_taint_trace',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'systems-audit',
    intent: 'Trace bounded untrusted source-to-sink data flow',
    whenToUse: 'When checking whether input reaches a dangerous sink without sanitization',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_abi_diff',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'systems-audit',
    intent: 'Compare cross-language payload and interface shapes',
    whenToUse: 'When C++/Rust/JSON payloads may not match TypeScript/JSON consumers',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_simulate_fault',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'systems-audit',
    intent: 'Simulate a target call returning a fault value',
    whenToUse: 'When reasoning about ENOSYS, failure returns, bypasses, and fallback paths',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
  },
  {
    name: 'gn_help',
    kind: 'super',
    modes: ALL_AGENT_MODES,
    category: 'self-help',
    intent: 'List all super-functions',
    whenToUse: 'First call when discovering the surface',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: false,
  },

  // --- Public Facade Tools ---
  {
    name: 'discover',
    kind: 'facade',
    modes: ALL_AGENT_MODES,
    category: 'discovery',
    intent: 'Discover repositories, routes, tools, and analysis packs',
    whenToUse: 'When you need to find high-level project components or capabilities',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: false,
    actions: [
      { action: 'repos', contractStatus: 'stable', structuredOutput: false },
      { action: 'routes', contractStatus: 'stable', structuredOutput: false },
      { action: 'tools', contractStatus: 'stable', structuredOutput: false },
      { action: 'packs', contractStatus: 'stable', structuredOutput: false },
      { action: 'groups', contractStatus: 'stable', structuredOutput: false },
      { action: 'sync', contractStatus: 'stable', structuredOutput: false },
    ],
  },
  {
    name: 'search',
    kind: 'facade',
    modes: ALL_AGENT_MODES,
    category: 'discovery',
    intent: 'Search the knowledge graph using semantic, Cypher, or repomap queries',
    whenToUse: 'When you need to find specific symbols, patterns, or files via the graph',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
    actions: [
      { action: 'semantic', contractStatus: 'stable', structuredOutput: true },
      { action: 'cypher', contractStatus: 'stable', structuredOutput: false },
      { action: 'repomap', contractStatus: 'stable', structuredOutput: false },
    ],
  },
  {
    name: 'inspect',
    kind: 'facade',
    modes: ALL_AGENT_MODES,
    category: 'discovery',
    intent: 'Inspect symbol context, evidence packs, API shapes, or IPC traces',
    whenToUse: 'When you need deep context or evidence for a specific symbol or route',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
    actions: [
      { action: 'context', contractStatus: 'stable', structuredOutput: true },
      { action: 'evidence', contractStatus: 'stable', structuredOutput: false },
      { action: 'shape', contractStatus: 'stable', structuredOutput: false },
      { action: 'ipc', contractStatus: 'stable', structuredOutput: false },
    ],
  },
  {
    name: 'impact',
    kind: 'facade',
    modes: ALL_AGENT_MODES,
    category: 'discovery',
    intent: 'Analyze impact of changes on symbols, routes, or batches of symbols',
    whenToUse: 'When checking the blast radius of a change (pre-edit or post-edit)',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
    actions: [
      { action: 'symbol', contractStatus: 'stable', structuredOutput: true },
      { action: 'batch', contractStatus: 'stable', structuredOutput: true },
      { action: 'route', contractStatus: 'stable', structuredOutput: true },
      { action: 'diff', contractStatus: 'stable', structuredOutput: true },
    ],
  },
  {
    name: 'audit',
    kind: 'facade',
    modes: WRITE_AGENT_MODES,
    category: 'audit',
    intent: 'Run architectural audits, session workflows, and systems-audit checks',
    whenToUse: 'Primary entry point for the audit lifecycle and systems reasoning',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
    actions: [
      {
        action: 'report',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'dead_code',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'tech_debt',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'hotspots',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'cycles',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'coupling',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'violations',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'coverage',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'migration',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'drift',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'build',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'graph_diff',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'requirements',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'patterns',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'rerun',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'audit',
      },
      {
        action: 'session_start',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'lifecycle',
      },
      {
        action: 'session_verify',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'lifecycle',
      },
      {
        action: 'session_dedupe',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'lifecycle',
      },
      {
        action: 'session_bundle',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'lifecycle',
      },
      {
        action: 'session_dispatch',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'lifecycle',
      },
      {
        action: 'session_review_worker',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'lifecycle',
      },
      {
        action: 'verify_diff',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'lifecycle',
      },
      {
        action: 'test_gap',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'lifecycle',
      },
      {
        action: 'worker_scope_review',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'lifecycle',
      },
      {
        action: 'logic',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'systems-audit',
      },
      {
        action: 'trace_boundary',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'systems-audit',
      },
      {
        action: 'resource_trace',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'systems-audit',
      },
      {
        action: 'path_verify',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'systems-audit',
      },
      {
        action: 'test_suggestions',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'systems-audit',
      },
      {
        action: 'extract_fsm',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'systems-audit',
      },
      {
        action: 'error_topology',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'systems-audit',
      },
      {
        action: 'concurrency',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'systems-audit',
      },
      {
        action: 'pressure',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'systems-audit',
      },
      {
        action: 'taint',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'systems-audit',
      },
      {
        action: 'abi',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'systems-audit',
      },
      {
        action: 'simulate_fault',
        contractStatus: 'stable',
        structuredOutput: true,
        dispatchCategory: 'systems-audit',
      },
    ],
  },
  {
    name: 'refactor',
    kind: 'facade',
    modes: WRITE_AGENT_MODES,
    category: 'refactor',
    intent: 'Perform safe refactoring: rename symbols, replace bodies, or stage in sandbox',
    whenToUse: 'When applying code changes through the refactoring engine',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: false,
    actions: [
      { action: 'rename', contractStatus: 'stable', structuredOutput: false },
      { action: 'replace', contractStatus: 'stable', structuredOutput: false },
      { action: 'sandbox', contractStatus: 'stable', structuredOutput: false },
    ],
  },
  {
    name: 'manage',
    kind: 'facade',
    modes: WRITE_AGENT_MODES,
    category: 'lifecycle',
    intent: 'Manage OntoIndex sessions and internal route maps',
    whenToUse: 'When performing administrative session or route management',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: false,
    actions: [
      { action: 'session', contractStatus: 'stable', structuredOutput: false },
      { action: 'route_map', contractStatus: 'stable', structuredOutput: false },
    ],
  },
  {
    name: 'docs',
    kind: 'facade',
    modes: ALL_AGENT_MODES,
    category: 'docs',
    intent: 'Docs-specific safe agent reports for trace, drift, context, and readiness',
    whenToUse: 'When reasoning about requirements and documentation coverage',
    contractStatus: 'stable',
    visibility: 'public',
    structuredOutput: true,
    actions: [
      { action: 'trace', contractStatus: 'stable', structuredOutput: true },
      { action: 'drift', contractStatus: 'stable', structuredOutput: true },
      { action: 'context', contractStatus: 'stable', structuredOutput: true },
      { action: 'readiness', contractStatus: 'stable', structuredOutput: true },
    ],
    properties: [
      {
        property: 'includeMemories',
        contractStatus: 'experimental',
        owner: 'Serena Phase 2',
        defaultBehavior: 'Omitted from response unless true',
      },
      {
        property: 'limit',
        contractStatus: 'stable',
        replacement: 'maxItems',
        owner: 'MCP Consistency',
        defaultBehavior: 'Alias for maxItems',
      },
    ],
  },
];

const TOOL_METADATA_MAP: Map<string, ToolContractMetadata> = new Map(
  TOOL_METADATA_LIST.map((m) => [m.name, m]),
);

const EVIDENCE_SOURCE_BASE_METADATA: Record<
  EvidenceReadClass,
  Omit<
    EvidenceSourceContractMetadata,
    'evidenceClass' | 'auditAuthority' | 'responsePolicy' | 'advisoryOnly'
  > & { advisoryOnly: boolean }
> = {
  graph_evidence: {
    freshnessBehavior: 'index_freshness_checked',
    provenanceFields: ['repo', 'commit', 'symbol', 'file', 'lineRange', 'indexFreshness'],
    truncationPolicy: 'bounded_mcp_response',
    safeForBasedOnReads: true,
    advisoryOnly: false,
  },
  docs_evidence: {
    freshnessBehavior: 'docs_policy_checked',
    provenanceFields: ['repo', 'path', 'commit', 'section', 'freshness'],
    truncationPolicy: 'caller_limited_response',
    safeForBasedOnReads: true,
    advisoryOnly: false,
  },
  audit_evidence: {
    freshnessBehavior: 'audit_target_locked',
    provenanceFields: ['sessionId', 'findingId', 'targetHead', 'verificationStatus'],
    truncationPolicy: 'bounded_mcp_response',
    safeForBasedOnReads: true,
    advisoryOnly: false,
  },
  advisory_memory: {
    freshnessBehavior: 'memory_freshness_declared',
    provenanceFields: ['memoryId', 'memoryFreshness', 'notAuditEvidence'],
    truncationPolicy: 'caller_limited_response',
    safeForBasedOnReads: false,
    advisoryOnly: true,
  },
  runtime_diagnostic: {
    freshnessBehavior: 'runtime_current',
    provenanceFields: ['processId', 'moduleUrl', 'nodeVersion', 'processStartTime'],
    truncationPolicy: 'bounded_mcp_response',
    safeForBasedOnReads: false,
    advisoryOnly: true,
  },
  unknown: {
    freshnessBehavior: 'not_declared',
    provenanceFields: [],
    truncationPolicy: 'not_applicable',
    safeForBasedOnReads: false,
    advisoryOnly: true,
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const REPO_OPTIONAL_SUPER_TOOL_NAMES = new Set([
  'gn_help',
  'gn_tool_contract',
  'gn_quality_mode',
  'gn_diagnose',
]);

const CORE_PROFILE_SUPER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'gn_help',
  'gn_tool_contract',
  'gn_diagnose',
  'gn_ensure_fresh',
  'gn_quality_mode',
]);

const AUDIT_PROFILE_CATEGORIES: ReadonlySet<ToolContractMetadata['category']> = new Set([
  'audit',
  'lifecycle',
  'pr-review',
  'safety',
  'systems-audit',
]);

const REFACTOR_PROFILE_CATEGORIES: ReadonlySet<ToolContractMetadata['category']> = new Set([
  'lifecycle',
  'pr-review',
  'refactor',
  'safety',
]);

const REFACTOR_PROFILE_EXTRA_TOOL_NAMES: ReadonlySet<string> = new Set(['gn_propose_location']);

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function parseMcpStartupProfile(value: string | null | undefined): McpStartupProfile {
  if (value === undefined || value === null) {
    return DEFAULT_MCP_STARTUP_PROFILE;
  }

  const normalized = value.trim().toLowerCase();
  if ((ALL_MCP_STARTUP_PROFILES as readonly string[]).includes(normalized)) {
    return normalized as McpStartupProfile;
  }

  return DEFAULT_MCP_STARTUP_PROFILE;
}

export function getMcpStartupProfileFromEnv(
  env: Record<string, string | undefined> = process.env,
): McpStartupProfile {
  return parseMcpStartupProfile(env[MCP_STARTUP_PROFILE_ENV]);
}

/** Return the modes in which a named tool is discoverable.  Returns [] for
 *  unknown names (including backend fallback actions). */
export function getToolModes(name: string): readonly AgentMode[] {
  return TOOL_METADATA_MAP.get(name)?.modes ?? [];
}

/** Return true if the named tool is discoverable in the given mode. */
export function isToolDiscoverableInMode(name: string, mode: AgentMode): boolean {
  return (TOOL_METADATA_MAP.get(name)?.modes ?? []).includes(mode);
}

export function getPublicToolRegistry(
  options: ToolNameOptions = { includeFacades: true },
): PublicToolRegistryEntry[] {
  const includeFacades = options.includeFacades !== false;
  const entries = [
    ...ONTOINDEX_SUPER_TOOLS.map((definition) => registryEntry('super', definition)),
    ...(includeFacades
      ? ONTOINDEX_FACADE_TOOLS.map((definition) => registryEntry('facade', definition))
      : []),
  ].filter((e): e is PublicToolRegistryEntry => Boolean(e));

  const modeFiltered =
    options.mode === undefined
      ? entries
      : entries.filter((entry) => isToolDiscoverableInMode(entry.name, options.mode as AgentMode));
  return filterToolRegistryByStartupProfile(modeFiltered, options.startupProfile);
}

export function getPublicToolDefinitions(
  options: ToolNameOptions = { includeFacades: true },
): ToolDefinition[] {
  return getPublicToolRegistry(options).map((entry) => entry.definition);
}

export function getHiddenStartupProfileToolNames(options: ToolNameOptions = {}): string[] {
  const includeFacades = options.includeFacades !== false;
  const fullPublic = getPublicToolRegistry({
    includeFacades,
    mode: options.mode,
    startupProfile: 'public-full',
  });
  const advertised = new Set(
    getPublicToolRegistry({
      includeFacades,
      mode: options.mode,
      startupProfile: options.startupProfile,
    }).map((entry) => entry.name),
  );

  return sortedUnique(
    fullPublic.filter((entry) => !advertised.has(entry.name)).map((entry) => entry.name),
  );
}

export function getMcpStartupProfileToolReport(
  options: ToolNameOptions = {},
): McpStartupProfileToolReport {
  const startupProfile = options.startupProfile ?? DEFAULT_MCP_STARTUP_PROFILE;
  const includeFacades = options.includeFacades !== false;
  const fullPublicToolCount = getPublicToolRegistry({
    includeFacades,
    mode: options.mode,
    startupProfile: 'public-full',
  }).length;
  const advertisedToolCount = getPublicToolRegistry({
    includeFacades,
    mode: options.mode,
    startupProfile,
  }).length;
  const hiddenToolNames = getHiddenStartupProfileToolNames({
    includeFacades,
    mode: options.mode,
    startupProfile,
  });

  return {
    startupProfile,
    enforcement: 'advertise_only',
    advertisedToolCount,
    hiddenButCallableToolCount: hiddenToolNames.length,
    fullPublicToolCount,
    includesFacades: includeFacades,
    hiddenToolNames,
  };
}

export function getRegisteredSuperToolNames(): string[] {
  return sortedUnique(ONTOINDEX_SUPER_TOOLS.map((tool) => tool.name));
}

export function getRegisteredFacadeToolNames(): string[] {
  return sortedUnique(ONTOINDEX_FACADE_TOOLS.map((tool) => tool.name));
}

export function getCallableToolNames(options: ToolNameOptions = {}): string[] {
  return sortedUnique(
    getPublicToolRegistry({
      includeFacades: options.includeFacades === true,
      mode: options.mode,
    }).map((entry) => entry.name),
  );
}

export function isRepoOptionalSuperToolName(name: string): boolean {
  return REPO_OPTIONAL_SUPER_TOOL_NAMES.has(name);
}

export function filterRegisteredSuperMetadata<T extends { name: string }>(
  entries: readonly T[],
): T[] {
  const registered = new Set(getRegisteredSuperToolNames());
  return entries.filter((entry) => registered.has(entry.name));
}

function registryEntry(
  kind: PublicToolKind,
  definition: ToolDefinition,
): PublicToolRegistryEntry | undefined {
  const metadata = TOOL_METADATA_MAP.get(definition.name);
  if (!metadata || metadata.kind !== kind) {
    return undefined;
  }
  const workflowIntents = inferWorkflowIntents(metadata);
  const producesEvidenceClasses = inferProducesEvidenceClasses(metadata);
  const permissionProfile = inferPermissionProfile(metadata);
  const advisoryOnly = inferAdvisoryOnly(metadata, producesEvidenceClasses, permissionProfile);
  const auditAuthority = inferAuditAuthority(metadata, producesEvidenceClasses, advisoryOnly);
  const evidenceSources = inferEvidenceSources(
    metadata,
    producesEvidenceClasses,
    auditAuthority,
    advisoryOnly,
  );
  return {
    kind,
    name: definition.name,
    callable: true,
    definition,
    modes: metadata.modes,
    category: metadata.category,
    intent: metadata.intent,
    whenToUse: metadata.whenToUse,
    contractStatus: metadata.contractStatus,
    visibility: metadata.visibility,
    structuredOutput: metadata.structuredOutput,
    owner: metadata.owner,
    defaultBehavior: metadata.defaultBehavior,
    replacement: metadata.replacement,
    fallback: metadata.fallback,
    workflowIntents,
    producesEvidenceClasses,
    permissionProfile,
    auditAuthority,
    advisoryOnly,
    evidenceSources,
    properties: metadata.properties,
    actions: metadata.actions,
  };
}

function filterToolRegistryByStartupProfile(
  entries: PublicToolRegistryEntry[],
  profile: McpStartupProfile | undefined,
): PublicToolRegistryEntry[] {
  const startupProfile = profile ?? DEFAULT_MCP_STARTUP_PROFILE;
  if (startupProfile === 'public-full') {
    return entries;
  }
  return entries.filter((entry) => isDiscoverableInStartupProfile(entry, startupProfile));
}

function isDiscoverableInStartupProfile(
  entry: PublicToolRegistryEntry,
  profile: McpStartupProfile,
): boolean {
  if (isCoreStartupProfileEntry(entry)) {
    return true;
  }

  switch (profile) {
    case 'core':
      return false;
    case 'query':
      return isToolDiscoverableInMode(entry.name, 'query-projects');
    case 'audit':
      return entry.modes.includes('audit') && AUDIT_PROFILE_CATEGORIES.has(entry.category);
    case 'refactor':
      return (
        REFACTOR_PROFILE_EXTRA_TOOL_NAMES.has(entry.name) ||
        (entry.modes.includes('refactor') && REFACTOR_PROFILE_CATEGORIES.has(entry.category))
      );
    case 'systems':
      return entry.category === 'systems-audit';
    case 'public-full':
      return true;
  }
}

function isCoreStartupProfileEntry(entry: PublicToolRegistryEntry): boolean {
  return entry.kind === 'facade' || CORE_PROFILE_SUPER_TOOL_NAMES.has(entry.name);
}

function inferWorkflowIntents(metadata: ToolContractMetadata): readonly string[] {
  if (metadata.workflowIntents && metadata.workflowIntents.length > 0) {
    return sortedUnique(metadata.workflowIntents.map((value) => value.toLowerCase()));
  }
  const byCategory: Record<ToolContractMetadata['category'], string[]> = {
    discovery: ['explore', 'query'],
    docs: ['docs', 'readiness'],
    safety: ['edit', 'release'],
    refactor: ['edit', 'refactor'],
    lifecycle: ['lifecycle', 'setup'],
    audit: ['audit', 'verify'],
    'systems-audit': ['audit', 'diagnose'],
    'pr-review': ['review', 'release'],
    'self-help': ['diagnose', 'setup'],
  };
  return byCategory[metadata.category];
}

function inferProducesEvidenceClasses(
  metadata: ToolContractMetadata,
): readonly EvidenceReadClass[] {
  if (metadata.producesEvidenceClasses && metadata.producesEvidenceClasses.length > 0) {
    return sortedUnique(metadata.producesEvidenceClasses) as EvidenceReadClass[];
  }
  const evidence = new Set<EvidenceReadClass>();

  switch (metadata.category) {
    case 'docs':
      evidence.add('docs_evidence');
      break;
    case 'self-help':
      evidence.add('runtime_diagnostic');
      break;
    case 'audit':
    case 'systems-audit':
      evidence.add('audit_evidence');
      evidence.add('graph_evidence');
      break;
    case 'lifecycle':
      if (metadata.name.startsWith('gn_audit_session_')) {
        evidence.add('audit_evidence');
      } else {
        evidence.add('graph_evidence');
      }
      break;
    case 'safety':
      evidence.add('graph_evidence');
      evidence.add('audit_evidence');
      break;
    case 'pr-review':
      evidence.add('graph_evidence');
      break;
    case 'refactor':
    case 'discovery':
      evidence.add('graph_evidence');
      break;
    default:
      evidence.add('unknown');
  }

  if (metadata.name === 'gn_docs' || metadata.name === 'docs') {
    evidence.add('advisory_memory');
  }
  if (metadata.name === 'gn_diagnose') {
    evidence.add('runtime_diagnostic');
  }

  if (evidence.size === 0) {
    evidence.add('unknown');
  }

  return Array.from(evidence).sort();
}

function inferPermissionProfile(metadata: ToolContractMetadata): ToolPermissionProfile {
  if (metadata.permissionProfile) {
    return metadata.permissionProfile;
  }
  const isWriteOnlyMode = metadata.modes.every((mode) => mode !== 'query-projects');
  if (
    metadata.name === 'gn_pre_commit_audit' ||
    metadata.name === 'gn_audit_session_dispatch' ||
    metadata.name === 'gn_dispatch_prompt'
  ) {
    return 'release';
  }
  if (metadata.name === 'gn_quality_mode' || metadata.name === 'gn_diagnose') {
    return 'runtime_admin';
  }
  if (metadata.name === 'gn_safe_refactor' || metadata.name === 'refactor') {
    return 'write_apply';
  }
  if (isWriteOnlyMode && metadata.category !== 'safety') {
    return 'write_apply';
  }
  if (metadata.category === 'safety' || metadata.category === 'pr-review') {
    return 'advisory';
  }
  return 'read_only';
}

function inferAdvisoryOnly(
  metadata: ToolContractMetadata,
  evidenceClasses: readonly EvidenceReadClass[],
  permissionProfile: ToolPermissionProfile,
): boolean {
  if (metadata.advisoryOnly !== undefined) {
    return metadata.advisoryOnly;
  }
  if (permissionProfile === 'advisory') {
    return true;
  }
  if (
    evidenceClasses.includes('advisory_memory') ||
    evidenceClasses.includes('runtime_diagnostic')
  ) {
    return true;
  }
  return false;
}

function inferAuditAuthority(
  metadata: ToolContractMetadata,
  evidenceClasses: readonly EvidenceReadClass[],
  advisoryOnly: boolean,
): boolean {
  if (metadata.auditAuthority !== undefined) {
    return metadata.auditAuthority;
  }
  if (advisoryOnly) {
    return false;
  }
  return (
    evidenceClasses.includes('audit_evidence') && !evidenceClasses.includes('runtime_diagnostic')
  );
}

function inferEvidenceSources(
  metadata: ToolContractMetadata,
  evidenceClasses: readonly EvidenceReadClass[],
  auditAuthority: boolean,
  advisoryOnly: boolean,
): readonly EvidenceSourceContractMetadata[] {
  if (metadata.evidenceSources && metadata.evidenceSources.length > 0) {
    return sortEvidenceSources(metadata.evidenceSources);
  }

  const responsePolicy: EvidenceResponsePolicy = metadata.structuredOutput
    ? 'structured_response'
    : 'text_response';

  return sortEvidenceSources(
    evidenceClasses.map((evidenceClass) => {
      const base = EVIDENCE_SOURCE_BASE_METADATA[evidenceClass];
      const sourceAdvisoryOnly = advisoryOnly || base.advisoryOnly;
      return {
        evidenceClass,
        freshnessBehavior: base.freshnessBehavior,
        auditAuthority: sourceAdvisoryOnly
          ? false
          : sourceAuditAuthority(evidenceClass, auditAuthority),
        provenanceFields: base.provenanceFields,
        truncationPolicy: base.truncationPolicy,
        responsePolicy,
        safeForBasedOnReads: base.safeForBasedOnReads,
        advisoryOnly: sourceAdvisoryOnly,
      };
    }),
  );
}

function sourceAuditAuthority(evidenceClass: EvidenceReadClass, auditAuthority: boolean): boolean {
  if (
    evidenceClass === 'docs_evidence' ||
    evidenceClass === 'advisory_memory' ||
    evidenceClass === 'runtime_diagnostic' ||
    evidenceClass === 'unknown'
  ) {
    return false;
  }
  return auditAuthority;
}

function sortEvidenceSources(
  evidenceSources: readonly EvidenceSourceContractMetadata[],
): EvidenceSourceContractMetadata[] {
  return [...evidenceSources].sort((a, b) => a.evidenceClass.localeCompare(b.evidenceClass));
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}
