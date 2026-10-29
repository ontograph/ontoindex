import type { LocalBackend } from '../local/local-backend.js';
import { withPreparedSuperRead, type SuperTool } from '../super/names.js';
import { isAutomaticWorkspaceEnabled } from '../local/backend-overlay.js';
import { ONTOINDEX_FACADE_TOOLS } from './tool-definitions.js';
import { parseTypedQueryDocument } from '../../core/search/typed-query-document.js';
import { getMcpStartupProfileFromEnv, getPublicToolRegistry } from '../shared/tool-registry.js';
import { attachWorkspaceSearchWarning } from '../shared/workspace-search-warning.js';
import {
  attachRepoScopeIdentity,
  attachRepoScopeIdentityToError,
  createGlobalTargetContext,
} from '../shared/response-envelope.js';

const CANONICAL_NODE_ID_RE = /^[A-Z]\w+:/;

export type FacadeTool =
  | 'discover'
  | 'search'
  | 'inspect'
  | 'impact'
  | 'audit'
  | 'refactor'
  | 'manage'
  | 'docs';

/**
 * Dispatch layer for M-1 facade tools.
 * Routes a high-level facade call to the corresponding internal handler.
 */
export async function dispatchFacade(
  tool: FacadeTool,
  action: string,
  args: Record<string, unknown>,
  backend: LocalBackend,
): Promise<unknown> {
  args = normalizeFacadeArgs(tool, action, args);
  if (tool === 'discover' && action === 'tools' && args.codebase !== true) {
    const startupProfile = getMcpStartupProfileFromEnv();
    const tools = getPublicToolRegistry({ includeFacades: true, startupProfile }).map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      description: entry.definition.description,
    }));
    const recommendedTools = tools.filter((entry) => entry.kind === 'facade');
    const compatibilityTools = tools.filter((entry) => entry.kind === 'super');

    return {
      version: 1,
      source: 'mcp-frontier',
      startupProfile,
      targetContext: createGlobalTargetContext(
        'discover/tools does not require repository resolution',
      ),
      count: tools.length,
      tools,
      recommendedTools,
      compatibilityTools,
      recommendedCount: recommendedTools.length,
      compatibilityCount: compatibilityTools.length,
      codebaseToolsHint:
        'Use the recommended facade tools first; pass codebase: true to discover tools implemented by the indexed repository graph.',
    };
  }

  const superTool = getAuditFacadeSuperTool(tool, action);
  if (superTool) {
    if (superTool === 'gn_ensure_fresh') {
      const { dispatchSuper } = await import('../super/dispatch.js');
      return dispatchSuper(superTool, args, typeof args.repo === 'string' ? args.repo : '');
    }
    const repo = await backend.resolveRepo(typeof args.repo === 'string' ? args.repo : undefined);
    const { dispatchSuper } = await import('../super/dispatch.js');
    try {
      const superResult = await withPreparedSuperRead(
        superTool,
        args,
        repo,
        backend,
        {
          automaticWorkspace: isAutomaticWorkspaceEnabled(),
          committedRead: args.read_mode === 'committed',
        },
        () =>
          superTool === 'gn_audit_logic'
            ? dispatchSuper(superTool, args, repo.id, undefined, { repoPath: repo.repoPath })
            : superTool === 'gn_test_gap' || superTool === 'gn_verify_diff'
              ? dispatchSuper(superTool, args, repo.id, undefined, undefined, backend)
              : superTool === 'gn_safe_refactor'
                ? dispatchSuper(superTool, args, repo.id, {
                    repoPath: repo.repoPath,
                    callTool: backend.callTool.bind(backend),
                  })
                : dispatchSuper(superTool, args, repo.id),
      );
      const result = attachRepoScopeIdentity(superResult, repo);
      return tool === 'inspect' && (action === 'explore' || action === 'related')
        ? await attachWorkspaceSearchWarning(result, args, repo.id)
        : result;
    } catch (error) {
      throw attachRepoScopeIdentityToError(
        error instanceof Error ? error : new Error(String(error)),
        repo,
      );
    }
  }

  const method = getInternalMethod(tool, action);
  return backend.callTool(method, args);
}

function getAuditFacadeSuperTool(tool: FacadeTool, action: string): SuperTool | null {
  if (tool === 'impact' && action === 'diff_impact') return 'gn_diff_impact';
  if (tool === 'refactor' && action === 'safe_refactor') return 'gn_safe_refactor';
  if (tool === 'inspect' && action === 'module') return 'gn_explain_module';
  if (tool === 'inspect' && action === 'related') return 'gn_find_related';
  if (tool === 'inspect' && action === 'explore') return 'gn_explore';
  if (tool === 'manage' && action === 'ensure_fresh') return 'gn_ensure_fresh';
  if (tool === 'manage' && action === 'analyze_job') return 'gn_analyze_job';
  if (tool === 'inspect' && action === 'graph_walk') return 'gn_graph_walk';
  if (tool === 'inspect' && action === 'propose_location') return 'gn_propose_location';
  if (tool !== 'audit') return null;
  switch (action) {
    case 'review_diff':
      return 'gn_review_diff';
    case 'pre_commit_audit':
      return 'gn_pre_commit_audit';
    case 'ingest':
      return 'gn_audit_ingest';
    case 'verify':
      return 'gn_audit_verify';
    case 'tombstone_create':
      return 'gn_audit_tombstone_create';
    case 'safe_edit_check':
      return 'gn_safe_edit_check';
    case 'can_delete':
      return 'gn_can_delete';
    case 'dedupe':
      return 'gn_audit_dedupe';
    case 'lint':
      return 'gn_audit_lint';
    case 'bundle':
      return 'gn_audit_bundle';
    case 'bundle_conflicts':
      return 'gn_bundle_conflicts';
    case 'scope_guard':
      return 'gn_scope_guard';
    case 'dispatch_prompt':
      return 'gn_dispatch_prompt';
    case 'diff':
      return 'gn_audit_diff';
    case 'export':
      return 'gn_audit_export';
    case 'replay':
      return 'gn_audit_replay';
    case 'pr_marker_scan':
      return 'gn_audit_pr_marker_scan';
    case 'fix_history':
      return 'gn_fix_history';
    case 'session_start':
      return 'gn_audit_session_start';
    case 'session_lock':
      return 'gn_audit_session_lock';
    case 'session_verify':
      return 'gn_audit_session_verify';
    case 'session_dedupe':
      return 'gn_audit_session_dedupe';
    case 'session_bundle':
      return 'gn_audit_session_bundle';
    case 'session_dispatch':
      return 'gn_audit_session_dispatch';
    case 'session_review_worker':
      return 'gn_audit_session_review_worker';
    case 'verify_diff':
      return 'gn_verify_diff';
    case 'test_gap':
      return 'gn_test_gap';
    case 'worker_scope_review':
      return 'gn_worker_scope_review';
    case 'logic':
      return 'gn_audit_logic';
    case 'trace_boundary':
      return 'gn_trace_boundary';
    case 'resource_trace':
      return 'gn_resource_trace';
    case 'path_verify':
      return 'gn_path_verify';
    case 'test_suggestions':
      return 'gn_test_suggestions';
    case 'extract_fsm':
      return 'gn_extract_fsm';
    case 'error_topology':
      return 'gn_error_topology';
    case 'concurrency':
      return 'gn_concurrency_audit';
    case 'pressure':
      return 'gn_pressure_impact';
    case 'taint':
      return 'gn_taint_trace';
    case 'abi':
      return 'gn_abi_diff';
    case 'simulate_fault':
      return 'gn_simulate_fault';
    default:
      return null;
  }
}

function normalizeFacadeArgs(
  tool: FacadeTool,
  action: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...args };
  if (normalized.lock_action !== undefined && (tool !== 'audit' || action !== 'session_lock')) {
    throw new Error('lock_action is only supported for audit(action: "session_lock").');
  }
  if (tool === 'audit' && action === 'session_lock') {
    const lockAction = normalized.lock_action;
    if (
      lockAction !== undefined &&
      lockAction !== 'create' &&
      lockAction !== 'load' &&
      lockAction !== 'validate'
    ) {
      throw new Error(
        'audit(action: "session_lock") requires lock_action: "create" | "load" | "validate" when supplied.',
      );
    }
    if (lockAction === undefined) delete normalized.action;
    else normalized.action = lockAction;
    delete normalized.lock_action;
  }
  if (normalized.walk_action !== undefined && (tool !== 'inspect' || action !== 'graph_walk')) {
    throw new Error('walk_action is only supported for inspect(action: "graph_walk").');
  }
  if (tool === 'inspect' && action === 'graph_walk') {
    const walkAction = normalized.walk_action;
    if (walkAction !== 'start' && walkAction !== 'step' && walkAction !== 'status') {
      throw new Error(
        'inspect(action: "graph_walk") requires walk_action: "start" | "step" | "status".',
      );
    }
    normalized.action = walkAction;
    delete normalized.walk_action;
  }
  if (normalized.job_action !== undefined && (tool !== 'manage' || action !== 'analyze_job')) {
    throw new Error('job_action is only supported for manage(action: "analyze_job").');
  }
  if (tool === 'manage' && action === 'analyze_job') {
    const jobAction = normalized.job_action === undefined ? 'status' : normalized.job_action;
    if (jobAction !== 'status' && jobAction !== 'cancel') {
      throw new Error('manage(action: "analyze_job") requires job_action: "status" | "cancel".');
    }
    if (typeof normalized.jobId !== 'string' || normalized.jobId.length === 0) {
      throw new Error('manage(action: "analyze_job") requires jobId.');
    }
    normalized.action = jobAction;
    delete normalized.job_action;
  }
  const target = typeof normalized.target === 'string' ? normalized.target : undefined;

  if (tool === 'manage' && action === 'session') {
    const operation = normalized.operation;
    if (operation !== 'get' && operation !== 'set' && operation !== 'list') {
      throw new Error('manage(action: "session") requires operation: "get" | "set" | "list".');
    }
    normalized.action = operation;
    delete normalized.operation;
  }

  if (tool === 'refactor' && action === 'sandbox') {
    const operation = normalized.operation ?? 'stage';
    if (operation !== 'stage' && operation !== 'apply') {
      throw new Error('refactor(action: "sandbox") requires operation: "stage" | "apply".');
    }
    normalized.action = operation;
    delete normalized.operation;
  }

  if (
    tool === 'search' &&
    action === 'semantic' &&
    normalized.typed_query === true &&
    typeof normalized.query === 'string' &&
    normalized.typedQuery === undefined
  ) {
    normalized.typedQuery = parseTypedQueryDocument(normalized.query);
  }

  if (tool === 'inspect' && target) {
    if (action === 'context' && !normalized.name && !normalized.uid) normalized.name = target;
    if (action === 'evidence' && !normalized.targets) normalized.targets = [target];
    if (action === 'shape' && !normalized.route) normalized.route = target;
    if (action === 'ipc' && !normalized.symbol_name) normalized.symbol_name = target;
  }

  if (tool === 'impact') {
    if (action === 'symbol' && !normalized.direction) normalized.direction = 'upstream';
    if (action === 'batch' && target && !normalized.targets) normalized.targets = [target];
    if (action === 'route' && target && !normalized.route) normalized.route = target;
  }

  if (tool === 'refactor' && target) {
    if (action === 'rename' && !normalized.symbol_name && !normalized.symbol_uid) {
      if (CANONICAL_NODE_ID_RE.test(target)) normalized.symbol_uid = target;
      else normalized.symbol_name = target;
    }
    if (action === 'replace' && !normalized.uid) normalized.uid = target;
  }

  if (tool === 'docs' && !normalized.action) {
    normalized.action = action;
  }

  // Super handlers own validation and bounds for their arguments.
  if (getAuditFacadeSuperTool(tool, action)) return normalized;

  const properties = ONTOINDEX_FACADE_TOOLS.find((definition) => definition.name === tool)
    ?.inputSchema.properties;
  for (const [key, schema] of Object.entries(properties ?? {})) {
    // Discovery handlers own limits; preserve extras on existing discovery actions.
    if (tool === 'discover') break;
    if (tool === 'inspect' && key === 'depth' && action === 'explore') continue;
    if (
      schema.type !== 'number' &&
      schema.type !== 'integer' &&
      !(tool === 'inspect' && key === 'depth')
    )
      continue;
    const value = normalized[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      delete normalized[key];
      continue;
    }
    normalized[key] = Math.min(
      schema.maximum ?? Infinity,
      Math.max(schema.minimum ?? -Infinity, value),
    );
  }

  return normalized;
}

/**
 * Maps a facade tool + action to an internal tool method name.
 */
function getInternalMethod(tool: FacadeTool, action: string): string {
  switch (tool) {
    case 'discover':
      switch (action) {
        case 'help':
          return 'gn_help';
        case 'tool_contract':
          return 'gn_tool_contract';
        case 'repos':
          return 'list_repos';
        case 'routes':
          return 'route_map';
        case 'tools':
          return 'tool_map';
        case 'packs':
          return 'analysis_catalog';
        case 'groups':
          return 'group_list';
        case 'sync':
          return 'group_sync';
        default:
          break;
      }
      break;

    case 'search':
      switch (action) {
        case 'semantic':
          return 'query';
        case 'cypher':
          return 'cypher';
        case 'repomap':
          return 'repomap';
        default:
          break;
      }
      break;

    case 'inspect':
      switch (action) {
        case 'context':
          return 'context';
        case 'evidence':
          return 'evidence_pack';
        case 'shape':
          return 'shape_check';
        case 'ipc':
          return 'ipc_trace';
        default:
          break;
      }
      break;

    case 'impact':
      switch (action) {
        case 'symbol':
          return 'impact';
        case 'batch':
          return 'impact_batch';
        case 'route':
          return 'api_impact';
        case 'diff':
          return 'detect_changes';
        default:
          break;
      }
      break;

    case 'audit':
      switch (action) {
        case 'report':
          return 'audit_report';
        case 'dead_code':
          return 'dead_code';
        case 'tech_debt':
          return 'tech_debt';
        case 'hotspots':
          return 'hotspot_analysis';
        case 'cycles':
          return 'cycle_detect';
        case 'coupling':
          return 'coupling_matrix';
        case 'violations':
          return 'boundary_violations';
        case 'coverage':
          return 'verification_gap';
        case 'migration':
          return 'migration_progress';
        case 'drift':
          return 'cross_doc_drift';
        case 'build':
          return 'build_residue_audit';
        case 'graph_diff':
          return 'graph_diff';
        case 'requirements':
          return 'requirements_trace';
        case 'patterns':
          return 'pattern_audit';
        case 'rerun':
          return 'audit_rerun';
        default:
          break;
      }
      break;

    case 'refactor':
      switch (action) {
        case 'rename':
          return 'rename';
        case 'replace':
          return 'replace_symbol';
        case 'sandbox':
          return 'sandbox';
        default:
          break;
      }
      break;

    case 'manage':
      switch (action) {
        case 'quality_mode':
          return 'gn_quality_mode';
        case 'diagnose':
          return 'gn_diagnose';
        case 'session':
          return 'session';
        case 'route_map':
          return 'route_map';
        default:
          break;
      }
      break;

    case 'docs':
      switch (action) {
        case 'trace':
        case 'drift':
        case 'context':
        case 'readiness':
          return 'docs';
        default:
          break;
      }
      break;
  }

  throw new Error(`Unknown facade action: ${tool}/${action}`);
}
