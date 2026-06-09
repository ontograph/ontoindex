import type { LocalBackend } from '../local/local-backend.js';
import type { SuperTool } from '../super/names.js';
import { parseTypedQueryDocument } from '../../core/search/typed-query-document.js';

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
  const superTool = getAuditFacadeSuperTool(tool, action);
  if (superTool) {
    const repo = await backend.resolveRepo(typeof args.repo === 'string' ? args.repo : undefined);
    const { dispatchSuper } = await import('../super/dispatch.js');
    return dispatchSuper(superTool, args, repo.id);
  }

  const method = getInternalMethod(tool, action);
  return backend.callTool(method, normalizeFacadeArgs(tool, action, args));
}

function getAuditFacadeSuperTool(tool: FacadeTool, action: string): SuperTool | null {
  if (tool !== 'audit') return null;
  switch (action) {
    case 'session_start':
      return 'gn_audit_session_start';
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
  const target = typeof normalized.target === 'string' ? normalized.target : undefined;

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

  return normalized;
}

/**
 * Maps a facade tool + action to an internal tool method name.
 */
function getInternalMethod(tool: FacadeTool, action: string): string {
  switch (tool) {
    case 'discover':
      switch (action) {
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
