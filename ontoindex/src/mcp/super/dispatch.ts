/**
 * Super-Function Dispatch (Phase 1 W1d + Phase 2 W2d + Phase 3 W3d + Phase 4 W4d)
 *
 * Switch-dispatches incoming MCP tool calls to the corresponding
 * super-function implementation.  Mirrors the dispatchFacade() pattern
 * used for the public facade tools.
 *
 * Phase 2 W2d adds: gn_safe_edit_check, gn_can_delete, gn_pre_commit_audit.
 * Phase 3 W3d adds: gn_safe_refactor, gn_ensure_fresh, gn_quality_mode.
 * Phase 4 W4d adds: gn_diff_impact, gn_diagnose, gn_propose_location.
 * Phase 5 W5a adds: gn_help.
 * REV-5 adds: gn_review_diff.
 */

import type { SuperTool } from './names.js';
import type { ExploreParams } from './explore.js';
import type { ExplainModuleParams } from './explain-module.js';
import type { FindRelatedParams } from './find-related.js';
import type { SafeEditCheckParams } from './safe-edit-check.js';
import type { CanDeleteParams } from './can-delete.js';
import type { PreCommitAuditParams } from './pre-commit-audit.js';
import type { SafeRefactorParams } from './safe-refactor.js';
import type { EnsureFreshParams } from './ensure-fresh.js';
import type { QualityModeParams } from './quality-mode.js';
import type { DiffImpactParams, ReviewDiffParams } from './diff-impact.js';
import type { DiagnoseParams } from './diagnose.js';
import type { ProposeLocationParams } from './propose-location.js';
import type { ToolContractParams } from './tool-contract.js';
import type { HelpParams } from './help.js';
import type { GraphWalkParams } from './graph-walk.js';
import type { DocsMcpParams } from './docs.js';
import type { AuditIngestParams } from './audit-ingest.js';
import type { AuditVerifyParams } from './audit-verify.js';
import type { FixHistoryParams } from './fix-history.js';
import type { AuditBundleParams } from './audit-bundle.js';
import type { AuditLintParams } from './audit-lint.js';
import {
  type AuditDedupeParams,
  type AuditDispatchPromptParams,
  type AuditScopeGuardParams,
  type AuditTombstoneCreateParams,
  type BundleConflictsParams,
} from './audit-advanced.js';
import {
  type AuditExportParams,
  type AuditDiffParams,
  type AuditPrMarkerScanParams,
  type AuditReplayParams,
  type AuditSessionBundleParams,
  type AuditSessionDedupeParams,
  type AuditSessionDispatchParams,
  type AuditSessionLockParams,
  type AuditSessionReviewWorkerParams,
  type AuditSessionStartParams,
  type AuditSessionVerifyParams,
} from './audit-session-tools.js';
import type { AuditLogicParams } from './audit-logic.js';
import type { TraceBoundaryParams } from './trace-boundary.js';
import {
  type PathVerifyParams,
  type ResourceTraceParams,
  type TestSuggestionsParams,
} from './systems-public.js';
import {
  type AbiDiffMcpParams,
  type ConcurrencyAuditMcpParams,
  type ErrorTopologyMcpParams,
  type ExtractFsmParams,
  type PressureImpactMcpParams,
  type SimulateFaultMcpParams,
  type TaintTraceMcpParams,
} from './systems-analyzers.js';
import {
  type TestGapParams,
  type VerifyDiffParams,
  type WorkerScopeReviewParams,
} from './write-through-verification.js';

export { SUPER_NAMES, type SuperTool } from './names.js';

/**
 * Dispatch an incoming MCP tool call to the appropriate super-function.
 *
 * @param name     - Tool name (must be a member of SUPER_NAMES).
 * @param params   - Raw params object from the MCP request.
 * @param repoId   - Repository identifier resolved from the `repo` param.
 * @returns        - The super-function report (serialised to JSON by the caller).
 */
export async function dispatchSuper(
  name: SuperTool,
  params: Record<string, unknown>,
  repoId: string,
): Promise<unknown> {
  switch (name) {
    case 'gn_explore': {
      const { gnExplore } = await import('./explore.js');
      return gnExplore(repoId, params as unknown as ExploreParams);
    }

    case 'gn_explain_module': {
      const { gnExplainModule } = await import('./explain-module.js');
      return gnExplainModule(repoId, params as unknown as ExplainModuleParams);
    }

    case 'gn_find_related': {
      const { gnFindRelated } = await import('./find-related.js');
      return gnFindRelated(repoId, params as unknown as FindRelatedParams);
    }

    case 'gn_safe_edit_check': {
      const { gnSafeEditCheck } = await import('./safe-edit-check.js');
      return gnSafeEditCheck(repoId, params as unknown as SafeEditCheckParams);
    }

    case 'gn_can_delete': {
      const { gnCanDelete } = await import('./can-delete.js');
      return gnCanDelete(repoId, params as unknown as CanDeleteParams);
    }

    case 'gn_pre_commit_audit': {
      const { gnPreCommitAudit } = await import('./pre-commit-audit.js');
      return gnPreCommitAudit(repoId, params as unknown as PreCommitAuditParams);
    }

    case 'gn_safe_refactor': {
      const { gnSafeRefactor } = await import('./safe-refactor.js');
      return gnSafeRefactor(repoId, params as unknown as SafeRefactorParams);
    }

    case 'gn_ensure_fresh': {
      const { gnEnsureFresh } = await import('./ensure-fresh.js');
      return gnEnsureFresh(repoId, params as unknown as EnsureFreshParams);
    }

    case 'gn_quality_mode': {
      const { gnQualityMode } = await import('./quality-mode.js');
      return gnQualityMode(params as unknown as QualityModeParams);
    }

    case 'gn_diff_impact': {
      const { gnDiffImpact } = await import('./diff-impact.js');
      return gnDiffImpact(repoId, params as unknown as DiffImpactParams);
    }

    case 'gn_review_diff': {
      const { gnReviewDiff } = await import('./diff-impact.js');
      return gnReviewDiff(repoId, params as unknown as ReviewDiffParams);
    }

    case 'gn_diagnose': {
      const { gnDiagnose } = await import('./diagnose.js');
      return gnDiagnose(repoId, params as unknown as DiagnoseParams);
    }

    case 'gn_propose_location': {
      const { gnProposeLocation } = await import('./propose-location.js');
      return gnProposeLocation(repoId, params as unknown as ProposeLocationParams);
    }

    case 'gn_tool_contract': {
      const { gnToolContract } = await import('./tool-contract.js');
      return gnToolContract(params as unknown as ToolContractParams);
    }

    case 'gn_docs': {
      const { gnDocs } = await import('./docs.js');
      return gnDocs(repoId, params as unknown as DocsMcpParams);
    }

    case 'gn_audit_ingest': {
      const { gnAuditIngest } = await import('./audit-ingest.js');
      return gnAuditIngest(repoId, params as unknown as AuditIngestParams);
    }

    case 'gn_audit_verify': {
      const { gnAuditVerify } = await import('./audit-verify.js');
      return gnAuditVerify(repoId, params as unknown as AuditVerifyParams);
    }

    case 'gn_fix_history': {
      const { gnFixHistory } = await import('./fix-history.js');
      return gnFixHistory(repoId, params as unknown as FixHistoryParams);
    }

    case 'gn_audit_bundle': {
      const { gnAuditBundle } = await import('./audit-bundle.js');
      return gnAuditBundle(repoId, params as unknown as AuditBundleParams);
    }

    case 'gn_audit_lint': {
      const { gnAuditLint } = await import('./audit-lint.js');
      return gnAuditLint(repoId, params as unknown as AuditLintParams);
    }

    case 'gn_audit_dedupe': {
      const { gnAuditDedupe } = await import('./audit-advanced.js');
      return gnAuditDedupe(repoId, params as unknown as AuditDedupeParams);
    }

    case 'gn_dispatch_prompt': {
      const { gnDispatchPrompt } = await import('./audit-advanced.js');
      return gnDispatchPrompt(repoId, params as unknown as AuditDispatchPromptParams);
    }

    case 'gn_audit_tombstone_create': {
      const { gnAuditTombstoneCreate } = await import('./audit-advanced.js');
      return gnAuditTombstoneCreate(repoId, params as unknown as AuditTombstoneCreateParams);
    }

    case 'gn_audit_session_start': {
      const { gnAuditSessionStart } = await import('./audit-session-tools.js');
      return gnAuditSessionStart(repoId, params as unknown as AuditSessionStartParams);
    }

    case 'gn_audit_session_verify': {
      const { gnAuditSessionVerify } = await import('./audit-session-tools.js');
      return gnAuditSessionVerify(repoId, params as unknown as AuditSessionVerifyParams);
    }

    case 'gn_audit_session_dedupe': {
      const { gnAuditSessionDedupe } = await import('./audit-session-tools.js');
      return gnAuditSessionDedupe(repoId, params as unknown as AuditSessionDedupeParams);
    }

    case 'gn_audit_session_bundle': {
      const { gnAuditSessionBundle } = await import('./audit-session-tools.js');
      return gnAuditSessionBundle(repoId, params as unknown as AuditSessionBundleParams);
    }

    case 'gn_audit_session_dispatch': {
      const { gnAuditSessionDispatch } = await import('./audit-session-tools.js');
      return gnAuditSessionDispatch(repoId, params as unknown as AuditSessionDispatchParams);
    }

    case 'gn_audit_session_review_worker': {
      const { gnAuditSessionReviewWorker } = await import('./audit-session-tools.js');
      return gnAuditSessionReviewWorker(
        repoId,
        params as unknown as AuditSessionReviewWorkerParams,
      );
    }

    case 'gn_audit_session_lock': {
      const { gnAuditSessionLock } = await import('./audit-session-tools.js');
      return gnAuditSessionLock(repoId, params as unknown as AuditSessionLockParams);
    }

    case 'gn_audit_pr_marker_scan': {
      const { gnAuditPrMarkerScan } = await import('./audit-session-tools.js');
      return gnAuditPrMarkerScan(repoId, params as unknown as AuditPrMarkerScanParams);
    }

    case 'gn_audit_diff': {
      const { gnAuditDiff } = await import('./audit-session-tools.js');
      return gnAuditDiff(repoId, params as unknown as AuditDiffParams);
    }

    case 'gn_audit_replay': {
      const { gnAuditReplay } = await import('./audit-session-tools.js');
      return gnAuditReplay(repoId, params as unknown as AuditReplayParams);
    }

    case 'gn_audit_export': {
      const { gnAuditExport } = await import('./audit-session-tools.js');
      return gnAuditExport(repoId, params as unknown as AuditExportParams);
    }

    case 'gn_scope_guard': {
      const { gnScopeGuard } = await import('./audit-advanced.js');
      return gnScopeGuard(repoId, params as unknown as AuditScopeGuardParams);
    }

    case 'gn_bundle_conflicts': {
      const { gnBundleConflicts } = await import('./audit-advanced.js');
      return gnBundleConflicts(repoId, params as unknown as BundleConflictsParams);
    }

    case 'gn_audit_logic': {
      const { gnAuditLogic } = await import('./audit-logic.js');
      return gnAuditLogic(repoId, params as unknown as AuditLogicParams);
    }

    case 'gn_trace_boundary': {
      const { gnTraceBoundary } = await import('./trace-boundary.js');
      return gnTraceBoundary(repoId, params as unknown as TraceBoundaryParams);
    }

    case 'gn_resource_trace': {
      const { gnResourceTrace } = await import('./systems-public.js');
      return gnResourceTrace(repoId, params as unknown as ResourceTraceParams);
    }

    case 'gn_path_verify': {
      const { gnPathVerify } = await import('./systems-public.js');
      return gnPathVerify(repoId, params as unknown as PathVerifyParams);
    }

    case 'gn_test_suggestions': {
      const { gnTestSuggestions } = await import('./systems-public.js');
      return gnTestSuggestions(repoId, params as unknown as TestSuggestionsParams);
    }

    case 'gn_extract_fsm': {
      const { gnExtractFsm } = await import('./systems-analyzers.js');
      return gnExtractFsm(repoId, params as unknown as ExtractFsmParams);
    }

    case 'gn_error_topology': {
      const { gnErrorTopology } = await import('./systems-analyzers.js');
      return gnErrorTopology(repoId, params as unknown as ErrorTopologyMcpParams);
    }

    case 'gn_concurrency_audit': {
      const { gnConcurrencyAudit } = await import('./systems-analyzers.js');
      return gnConcurrencyAudit(repoId, params as unknown as ConcurrencyAuditMcpParams);
    }

    case 'gn_pressure_impact': {
      const { gnPressureImpact } = await import('./systems-analyzers.js');
      return gnPressureImpact(repoId, params as unknown as PressureImpactMcpParams);
    }

    case 'gn_taint_trace': {
      const { gnTaintTrace } = await import('./systems-analyzers.js');
      return gnTaintTrace(repoId, params as unknown as TaintTraceMcpParams);
    }

    case 'gn_abi_diff': {
      const { gnAbiDiff } = await import('./systems-analyzers.js');
      return gnAbiDiff(repoId, params as unknown as AbiDiffMcpParams);
    }

    case 'gn_simulate_fault': {
      const { gnSimulateFault } = await import('./systems-analyzers.js');
      return gnSimulateFault(repoId, params as unknown as SimulateFaultMcpParams);
    }

    case 'gn_verify_diff': {
      const { gnVerifyDiff } = await import('./write-through-verification.js');
      return gnVerifyDiff(repoId, params as unknown as VerifyDiffParams);
    }

    case 'gn_test_gap': {
      const { gnTestGap } = await import('./write-through-verification.js');
      return gnTestGap(repoId, params as unknown as TestGapParams);
    }

    case 'gn_worker_scope_review': {
      const { gnWorkerScopeReview } = await import('./write-through-verification.js');
      return gnWorkerScopeReview(repoId, params as unknown as WorkerScopeReviewParams);
    }

    case 'gn_help': {
      const { gnHelp } = await import('./help.js');
      return gnHelp(params as unknown as HelpParams);
    }

    case 'gn_graph_walk': {
      const { gnGraphWalk } = await import('./graph-walk.js');
      return gnGraphWalk(repoId, params as unknown as GraphWalkParams);
    }

    default: {
      // TypeScript exhaustiveness guard — should never reach here at runtime.
      const exhaustive: never = name;
      throw new Error(`Unknown super-function tool: ${exhaustive}`);
    }
  }
}
