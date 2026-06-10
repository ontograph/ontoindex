export type SymbolFirstWorkflowIntent =
  | 'read'
  | 'modify'
  | 'rename'
  | 'delete'
  | 'review'
  | 'audit';

export type SymbolFirstWorkflowVerdict =
  | 'SAFE'
  | 'CAUTION'
  | 'DANGEROUS'
  | 'BLOCKED';

export type SymbolFirstWorkflowCoverageLikelihood =
  | 'UNKNOWN'
  | 'HIGH'
  | 'MEDIUM'
  | 'LOW'
  | 'NONE';

export interface SymbolFirstWorkflowTarget {
  kind: string;
  name: string;
  filePath?: string;
  symbolUid?: string;
  line?: number;
}

export interface SymbolFirstWorkflowEvidence {
  upstreamCallerCount?: number;
  downstreamDependencyCount?: number;
  processCount?: number;
  coChangeCount?: number;
  exported?: boolean;
  staleIndex?: boolean;
  dirtyWorktree?: boolean;
  lspReady?: boolean;
  testCoverageLikelihood?: string;
}

export interface SymbolFirstWorkflowEvidenceNormalized {
  upstreamCallerCount: number;
  downstreamDependencyCount: number;
  processCount: number;
  coChangeCount: number;
  exported: boolean;
  staleIndex: boolean;
  dirtyWorktree: boolean;
  lspReady: boolean;
  testCoverageLikelihood: SymbolFirstWorkflowCoverageLikelihood;
}

export interface SymbolFirstWorkflowActionNames {
  manualPatchWithGuard?: string;
  rename?: string;
  reviewOnly?: string;
  changedScopeVerification?: string;
  diffVerification?: string;
  testGapReview?: string;
}

export interface SymbolFirstWorkflowPlanInput {
  target: {
    kind: string;
    name: string;
    filePath?: string;
    symbolUid?: string;
    line?: number;
  };
  intent: SymbolFirstWorkflowIntent | string;
  evidence?: SymbolFirstWorkflowEvidence;
  advisoryOnly?: boolean;
  actionNames?: SymbolFirstWorkflowActionNames;
  metadata?: unknown;
}

export type SymbolFirstWorkflowStepKind = 'required-read' | 'verification';

export interface SymbolFirstWorkflowStep {
  kind: SymbolFirstWorkflowStepKind;
  action: string;
  reason: string;
  target: string;
}

export interface SymbolFirstWorkflowAction {
  kind: 'recommended-action';
  action: string;
  reason: string;
}

export interface SymbolFirstWorkflowBlocker {
  code: string;
  message: string;
}

export interface SymbolFirstWorkflowWarning {
  code: string;
  message: string;
}

export interface SymbolFirstWorkflowScoreContribution {
  factor: string;
  value: string | number | boolean;
  delta: number;
  reason: string;
}

export interface SymbolFirstWorkflowScoreTrace {
  totalRisk: number;
  contributions: SymbolFirstWorkflowScoreContribution[];
}

export interface SymbolFirstWorkflowPlan {
  target: SymbolFirstWorkflowTarget;
  intent: SymbolFirstWorkflowIntent;
  verdict: SymbolFirstWorkflowVerdict;
  requiredReads: SymbolFirstWorkflowStep[];
  recommendedAction: SymbolFirstWorkflowAction;
  verificationSteps: SymbolFirstWorkflowStep[];
  blockers: SymbolFirstWorkflowBlocker[];
  warnings: SymbolFirstWorkflowWarning[];
  scoreTrace: SymbolFirstWorkflowScoreTrace;
  evidence: SymbolFirstWorkflowEvidenceNormalized;
  metadata?: unknown;
}

const SUPPORTED_INTENTS: readonly SymbolFirstWorkflowIntent[] = [
  'read',
  'modify',
  'rename',
  'delete',
  'review',
  'audit',
];

const INTENT_SET = new Set<string>(SUPPORTED_INTENTS);

const COVERAGE_LIKELIHOOD = new Set<string>([
  'UNKNOWN',
  'HIGH',
  'MEDIUM',
  'LOW',
  'NONE',
]);

const ACTION_NAME_DEFAULTS = {
  manualPatchWithGuard: 'manual_patch_with_guard',
  rename: 'rename',
  reviewOnly: 'review_only',
  changedScopeVerification: 'verify_changed_scope',
  diffVerification: 'verify_diff',
  testGapReview: 'review_test_gap',
} as const;

const READ_TARGET_CONTEXT = 'target_context';
const READ_UPSTREAM = 'upstream_context';
const READ_DOWNSTREAM = 'downstream_context';
const READ_PROCESS_CONTEXT = 'process_context';

const HIGH_UPSTREAM_COUNT = 12;
const HIGH_PROCESS_COUNT = 4;
const HIGH_COCHANGE_COUNT = 10;
const HIGH_DOWNSTREAM_COUNT = 12;

const MIN_RISK_FOR_CAUTION = 3;
const MIN_RISK_FOR_DANGER = 7;

export function buildSymbolFirstWorkflowPlan(input: SymbolFirstWorkflowPlanInput): SymbolFirstWorkflowPlan {
  const target = normalizeTarget(input.target);
  const intent = normalizeIntent(input.intent);
  const evidence = normalizeEvidence(input.evidence ?? {});
  const actionNames = normalizeActionNames(input.actionNames);
  const advisoryOnly = input.advisoryOnly === true;
  const recommendedAction = chooseRecommendedAction(intent, actionNames);

  const requiredReads: SymbolFirstWorkflowStep[] = [];
  const verificationSteps: SymbolFirstWorkflowStep[] = [];
  const blockers: SymbolFirstWorkflowBlocker[] = [];
  const warnings: SymbolFirstWorkflowWarning[] = [];
  const contributions: SymbolFirstWorkflowScoreContribution[] = [];
  const targetDescriptor = formatTarget(target);

  requiredReads.push({
    kind: 'required-read',
    action: READ_TARGET_CONTEXT,
    reason: `Read ${target.kind} target context`,
    target: targetDescriptor,
  });

  const needsUpstreamReads = intent === 'modify' || intent === 'rename' || intent === 'delete';
  if (needsUpstreamReads) {
    requiredReads.push({
      kind: 'required-read',
      action: READ_UPSTREAM,
      reason: `Check upstream callers (${evidence.upstreamCallerCount})`,
      target: targetDescriptor,
    });
  }

  const needsDownstreamReads = intent === 'delete' || intent === 'review';
  if (needsDownstreamReads) {
    requiredReads.push({
      kind: 'required-read',
      action: READ_DOWNSTREAM,
      reason: `Check downstream dependents (${evidence.downstreamDependencyCount})`,
      target: targetDescriptor,
    });
  }

  if (evidence.processCount > 0) {
    requiredReads.push({
      kind: 'required-read',
      action: READ_PROCESS_CONTEXT,
      reason: `Inspect ${evidence.processCount} process participation context`,
      target: targetDescriptor,
    });
  }

  const freshnessBlockers = collectFreshnessBlockers(evidence, advisoryOnly);
  blockers.push(...freshnessBlockers.blockers);
  contributions.push(...freshnessBlockers.contributions);
  if (freshnessBlockers.isFreshnessBlocking) {
    return buildPlan({
      target,
      intent,
      evidence,
      recommendedAction,
      requiredReads,
      verificationSteps,
      blockers,
      warnings,
      scoreTrace: {
        totalRisk: sumContributions(contributions),
        contributions,
      },
      metadata: input.metadata,
      verdict: 'BLOCKED',
    });
  }

  addContribution(
    evidence.exported,
    2,
    'exported_symbol',
    `target exported = ${evidence.exported}`,
    contributions,
  );

  addContribution(
    evidence.upstreamCallerCount >= HIGH_UPSTREAM_COUNT,
    3,
    'high_upstream_count',
    `upstreamCallerCount = ${evidence.upstreamCallerCount}`,
    contributions,
  );

  addContribution(
    evidence.processCount >= HIGH_PROCESS_COUNT,
    3,
    'high_process_count',
    `processCount = ${evidence.processCount}`,
    contributions,
  );

  addContribution(
    evidence.coChangeCount >= HIGH_COCHANGE_COUNT,
    2,
    'high_co_change_count',
    `coChangeCount = ${evidence.coChangeCount}`,
    contributions,
  );

  addContribution(
    needsDownstreamReads && evidence.downstreamDependencyCount >= HIGH_DOWNSTREAM_COUNT,
    2,
    'high_downstream_count',
    `downstreamDependencyCount = ${evidence.downstreamDependencyCount}`,
    contributions,
  );

  const isCoverageWeak = isWeakCoverage(evidence.testCoverageLikelihood);
  addContribution(
    isCoverageWeak && isDestructiveIntent(intent),
    3,
    'weak_coverage_for_destructive_intent',
    `testCoverageLikelihood = ${evidence.testCoverageLikelihood}`,
    contributions,
  );

  addContribution(
    !evidence.lspReady,
    1,
    'optional_lsp_readiness_missing',
    'optional lsp readiness not confirmed',
    contributions,
  );

  const hasHighRadius =
    evidence.exported ||
    evidence.upstreamCallerCount >= HIGH_UPSTREAM_COUNT ||
    evidence.processCount >= HIGH_PROCESS_COUNT ||
    evidence.coChangeCount >= HIGH_COCHANGE_COUNT ||
    (needsDownstreamReads && evidence.downstreamDependencyCount >= HIGH_DOWNSTREAM_COUNT);

  const totalRisk = sumContributions(contributions);

  if (isDestructiveIntent(intent) && isCoverageWeak && hasHighRadius) {
    warnings.push({
      code: 'missing_coverage_on_broad_destructive_edit',
      message:
        'modify/rename/delete with broad blast radius requires stronger coverage evidence before edit.',
    });
  } else if (isCoverageWeak && isDestructiveIntent(intent)) {
    warnings.push({
      code: 'weak_coverage_for_destructive_intent',
      message: 'Destructive intent has weak coverage support.',
    });
  }

  if (isDestructiveIntent(intent) && !evidence.lspReady) {
    warnings.push({
      code: 'missing_optional_lsp_readiness',
      message: 'LSP rename/readiness checks are unavailable; proceed with caution.',
    });
  } else if (!evidence.lspReady && intent === 'review') {
    warnings.push({
      code: 'missing_optional_lsp_readiness',
      message: 'LSP context is unavailable while building the review plan.',
    });
  } else if (!evidence.lspReady && intent === 'audit') {
    warnings.push({
      code: 'missing_optional_lsp_readiness',
      message: 'LSP context is unavailable while building the audit plan.',
    });
  }

  if (isEditIntent(intent)) {
    verificationSteps.push({
      kind: 'verification',
      action: actionNames.changedScopeVerification,
      reason: `Check changed scope before ${intent}`,
      target: targetDescriptor,
    });
    verificationSteps.push({
      kind: 'verification',
      action: actionNames.diffVerification,
      reason: 'Verify edit diff before applying changes',
      target: targetDescriptor,
    });
  }

  if (isCoverageWeak) {
    verificationSteps.push({
      kind: 'verification',
      action: actionNames.testGapReview,
      reason: 'Review test-gap coverage before continuing',
      target: targetDescriptor,
    });
  }

  const verdict = decideVerdict({
    intent,
    totalRisk,
    hasHighRadius,
    isCoverageWeak,
    blockers,
    evidence,
  });

  return buildPlan({
    target,
    intent,
    evidence,
    recommendedAction,
    requiredReads,
    verificationSteps,
    blockers,
    warnings,
    scoreTrace: {
      totalRisk,
      contributions,
    },
    metadata: input.metadata,
    verdict,
  });
}

function buildPlan({
  target,
  intent,
  evidence,
  requiredReads,
  verificationSteps,
  blockers,
  warnings,
  scoreTrace,
  metadata,
  verdict,
  recommendedAction,
}: {
  target: SymbolFirstWorkflowTarget;
  intent: SymbolFirstWorkflowIntent;
  evidence: SymbolFirstWorkflowEvidenceNormalized;
  requiredReads: SymbolFirstWorkflowStep[];
  verificationSteps: SymbolFirstWorkflowStep[];
  blockers: SymbolFirstWorkflowBlocker[];
  warnings: SymbolFirstWorkflowWarning[];
  scoreTrace: SymbolFirstWorkflowScoreTrace;
  metadata: unknown;
  verdict?: SymbolFirstWorkflowVerdict;
  recommendedAction: SymbolFirstWorkflowAction;
}): SymbolFirstWorkflowPlan {
  return {
    target,
    intent,
    verdict: verdict ?? 'BLOCKED',
    requiredReads,
    recommendedAction,
    verificationSteps,
    blockers,
    warnings,
    scoreTrace,
    evidence,
    metadata,
  };
}

function chooseRecommendedAction(
  intent: SymbolFirstWorkflowIntent,
  actionNames: RequiredSymbolFirstWorkflowActionNames,
): SymbolFirstWorkflowAction {
  const reasonMap: Record<SymbolFirstWorkflowIntent, { action: string; reason: string }> = {
    read: {
      action: actionNames.reviewOnly,
      reason: 'Read-only intent should avoid modifying code.',
    },
    modify: {
      action: actionNames.manualPatchWithGuard,
      reason: 'Use guarded patch flow for body edits.',
    },
    rename: {
      action: actionNames.rename,
      reason: 'Use rename-specific update flow.',
    },
    delete: {
      action: actionNames.manualPatchWithGuard,
      reason: 'Use guarded patch flow and explicit deletion checks.',
    },
    review: {
      action: actionNames.reviewOnly,
      reason: 'Use review-only path for non-mutating actions.',
    },
    audit: {
      action: actionNames.reviewOnly,
      reason: 'Use review-only path for audit-focused workflows.',
    },
  };

  return {
    kind: 'recommended-action',
    action: reasonMap[intent].action,
    reason: reasonMap[intent].reason,
  };
}

function decideVerdict(params: {
  intent: SymbolFirstWorkflowIntent;
  totalRisk: number;
  hasHighRadius: boolean;
  isCoverageWeak: boolean;
  blockers: SymbolFirstWorkflowBlocker[];
  evidence: SymbolFirstWorkflowEvidenceNormalized;
}): SymbolFirstWorkflowVerdict {
  if (params.blockers.length > 0) {
    return 'BLOCKED';
  }

  if (params.intent === 'modify' || params.intent === 'rename' || params.intent === 'delete') {
    if (params.totalRisk >= MIN_RISK_FOR_DANGER || (params.hasHighRadius && params.isCoverageWeak)) {
      return 'DANGEROUS';
    }
    if (params.totalRisk >= MIN_RISK_FOR_CAUTION || !params.evidence.lspReady) {
      return 'CAUTION';
    }
    return 'SAFE';
  }

  if (params.totalRisk >= MIN_RISK_FOR_DANGER) {
    return 'DANGEROUS';
  }
  if (
    params.totalRisk >= MIN_RISK_FOR_CAUTION ||
    (params.isCoverageWeak && params.totalRisk > 0) ||
    !params.evidence.lspReady
  ) {
    return 'CAUTION';
  }

  return 'SAFE';
}

function collectFreshnessBlockers(
  evidence: SymbolFirstWorkflowEvidenceNormalized,
  advisoryOnly: boolean,
): { blockers: SymbolFirstWorkflowBlocker[]; contributions: SymbolFirstWorkflowScoreContribution[]; isFreshnessBlocking: boolean } {
  const blockers: SymbolFirstWorkflowBlocker[] = [];
  const contributions: SymbolFirstWorkflowScoreContribution[] = [];

  if (evidence.staleIndex) {
    const entry = {
      factor: 'stale_index',
      value: evidence.staleIndex,
      delta: evidence.staleIndex && !advisoryOnly ? 100 : 0,
      reason: 'Freshness required before planning edits',
    };
    contributions.push(entry);
    if (!advisoryOnly) {
      blockers.push({
        code: 'stale_index',
        message: 'Repository index is stale; plan is blocked by default.',
      });
    }
  }

  if (evidence.dirtyWorktree) {
    const entry = {
      factor: 'dirty_worktree',
      value: evidence.dirtyWorktree,
      delta: evidence.dirtyWorktree && !advisoryOnly ? 100 : 0,
      reason: 'Worktree state must be clean before edit planning.',
    };
    contributions.push(entry);
    if (!advisoryOnly) {
      blockers.push({
        code: 'dirty_worktree',
        message: 'Worktree has uncommitted changes; plan is blocked by default.',
      });
    }
  }

  return {
    blockers,
    contributions,
    isFreshnessBlocking: blockers.length > 0,
  };
}

function formatTarget(target: SymbolFirstWorkflowTarget): string {
  const base = `${target.kind}:${target.name}`;
  if (target.filePath) return `${base} @ ${target.filePath}`;
  if (target.symbolUid) return `${base} (${target.symbolUid})`;
  return base;
}

function addContribution(
  condition: boolean,
  delta: number,
  factor: string,
  reason: string,
  contributions: SymbolFirstWorkflowScoreContribution[],
): number {
  contributions.push({
    factor,
    value: condition ? 'enabled' : 'disabled',
    delta: condition ? delta : 0,
    reason,
  });
  return condition ? delta : 0;
}

function isDestructiveIntent(intent: SymbolFirstWorkflowIntent): boolean {
  return intent === 'modify' || intent === 'rename' || intent === 'delete';
}

function isEditIntent(intent: SymbolFirstWorkflowIntent): boolean {
  return intent === 'modify' || intent === 'rename' || intent === 'delete';
}

function isWeakCoverage(coverage: SymbolFirstWorkflowCoverageLikelihood): boolean {
  return coverage === 'UNKNOWN' || coverage === 'LOW' || coverage === 'NONE';
}

function normalizeIntent(rawIntent: SymbolFirstWorkflowIntent | string): SymbolFirstWorkflowIntent {
  const normalized = typeof rawIntent === 'string' ? rawIntent.trim().toLowerCase() : '';
  if (!INTENT_SET.has(normalized)) {
    throw new Error(`unsupported symbol-first intent: ${String(rawIntent)}`);
  }
  return normalized as SymbolFirstWorkflowIntent;
}

function normalizeTarget(rawTarget: {
  kind: string;
  name: string;
  filePath?: string;
  symbolUid?: string;
  line?: number;
}): SymbolFirstWorkflowTarget {
  if (rawTarget === null || rawTarget === undefined) {
    throw new Error('target is required');
  }
  const kind = typeof rawTarget.kind === 'string' ? rawTarget.kind.trim() : '';
  const name = typeof rawTarget.name === 'string' ? rawTarget.name.trim() : '';

  if (!kind) throw new Error('target.kind must be a non-empty string');
  if (!name) throw new Error('target.name must be a non-empty string');

  const filePath =
    typeof rawTarget.filePath === 'string' && rawTarget.filePath.trim().length > 0
      ? rawTarget.filePath.trim()
      : undefined;

  const symbolUid =
    typeof rawTarget.symbolUid === 'string' && rawTarget.symbolUid.trim().length > 0
      ? rawTarget.symbolUid.trim()
      : undefined;

  const line =
    typeof rawTarget.line === 'number' && Number.isInteger(rawTarget.line) && rawTarget.line > 0
      ? rawTarget.line
      : undefined;

  return {
    kind,
    name,
    filePath,
    symbolUid,
    line,
  };
}

function normalizeActionNames(
  rawActionNames: SymbolFirstWorkflowActionNames | undefined,
): RequiredSymbolFirstWorkflowActionNames {
  return {
    manualPatchWithGuard: normalizeActionName(
      rawActionNames?.manualPatchWithGuard,
      ACTION_NAME_DEFAULTS.manualPatchWithGuard,
    ),
    rename: normalizeActionName(rawActionNames?.rename, ACTION_NAME_DEFAULTS.rename),
    reviewOnly: normalizeActionName(rawActionNames?.reviewOnly, ACTION_NAME_DEFAULTS.reviewOnly),
    changedScopeVerification: normalizeActionName(
      rawActionNames?.changedScopeVerification,
      ACTION_NAME_DEFAULTS.changedScopeVerification,
    ),
    diffVerification: normalizeActionName(
      rawActionNames?.diffVerification,
      ACTION_NAME_DEFAULTS.diffVerification,
    ),
    testGapReview: normalizeActionName(
      rawActionNames?.testGapReview,
      ACTION_NAME_DEFAULTS.testGapReview,
    ),
  };
}

function normalizeActionName(rawActionName: string | undefined, fallback: string): string {
  if (typeof rawActionName === 'string') {
    const normalized = rawActionName.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return fallback;
}

interface RequiredSymbolFirstWorkflowActionNames {
  manualPatchWithGuard: string;
  rename: string;
  reviewOnly: string;
  changedScopeVerification: string;
  diffVerification: string;
  testGapReview: string;
}

function normalizeEvidence(rawEvidence: SymbolFirstWorkflowEvidence): SymbolFirstWorkflowEvidenceNormalized {
  const normalizedEvidenceLikelihood = normalizeCoverageLikelihood(rawEvidence.testCoverageLikelihood);
  return {
    upstreamCallerCount: normalizeCount(rawEvidence.upstreamCallerCount, 'upstreamCallerCount'),
    downstreamDependencyCount: normalizeCount(rawEvidence.downstreamDependencyCount, 'downstreamDependencyCount'),
    processCount: normalizeCount(rawEvidence.processCount, 'processCount'),
    coChangeCount: normalizeCount(rawEvidence.coChangeCount, 'coChangeCount'),
    exported: rawEvidence.exported === true,
    staleIndex: rawEvidence.staleIndex === true,
    dirtyWorktree: rawEvidence.dirtyWorktree === true,
    lspReady: rawEvidence.lspReady === true ? true : false,
    testCoverageLikelihood: normalizedEvidenceLikelihood,
  };
}

function normalizeCoverageLikelihood(rawCoverage: string | undefined): SymbolFirstWorkflowCoverageLikelihood {
  const normalized = typeof rawCoverage === 'string' ? rawCoverage.trim().toUpperCase() : 'UNKNOWN';
  if (COVERAGE_LIKELIHOOD.has(normalized)) {
    return normalized as SymbolFirstWorkflowCoverageLikelihood;
  }
  return 'UNKNOWN';
}

function normalizeCount(rawCount: unknown, fieldName: string): number {
  if (rawCount === undefined) {
    return 0;
  }
  if (
    typeof rawCount !== 'number' ||
    !Number.isFinite(rawCount) ||
    !Number.isInteger(rawCount) ||
    rawCount < 0
  ) {
    throw new Error(`${fieldName} must be a finite non-negative integer`);
  }
  return rawCount;
}

function sumContributions(contributions: SymbolFirstWorkflowScoreContribution[]): number {
  return contributions.reduce((acc, entry) => acc + entry.delta, 0);
}
