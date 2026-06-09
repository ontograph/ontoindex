export type AuditFreshnessPolicyMode = 'strict' | 'advisory' | 'explicit-stale';

export type AuditFreshnessPolicyReason =
  | 'stale-evidence'
  | 'target-head-mismatch'
  | 'dirty-worktree';

export interface AuditFreshnessPolicyInput {
  mode?: AuditFreshnessPolicyMode;
  targetHead: string;
  currentHead?: string | null;
  indexedHead?: string | null;
  evidenceTargetHead?: string | null;
  dirtyWorktree?: boolean | null;
}

export interface AuditFreshnessPolicyDecision {
  mode: AuditFreshnessPolicyMode;
  sourceFresh: boolean;
  graphStale: boolean;
  dispatchable: boolean;
  allowOpen: boolean;
  errorCode?: 'STALE_INDEX_ERROR';
  recommendedStatus?: 'NEEDS-REVERIFY' | 'NEEDS-VERIFY';
  reasonCodes: AuditFreshnessPolicyReason[];
  warnings: string[];
}

export function evaluateFreshnessGatePolicy(
  input: AuditFreshnessPolicyInput,
): AuditFreshnessPolicyDecision {
  const mode = input.mode ?? 'advisory';
  const targetHead = normalizeHead(input.targetHead);
  const currentHead = normalizeHead(input.currentHead);
  const indexedHead = normalizeHead(input.indexedHead);
  const evidenceTargetHead = normalizeHead(input.evidenceTargetHead);
  const explicitStale = mode === 'explicit-stale';
  const sourceHeadMismatch =
    (currentHead !== null && currentHead !== targetHead) ||
    (evidenceTargetHead !== null && evidenceTargetHead !== targetHead);
  const dirtyWorktree = input.dirtyWorktree === true;
  const graphStale = explicitStale || (indexedHead !== null && indexedHead !== targetHead);
  const sourceFresh = !explicitStale && !sourceHeadMismatch && !dirtyWorktree;
  const strictBlock = mode === 'strict' && (!sourceFresh || graphStale);
  const nonDispatchable = explicitStale || strictBlock;
  const reasonCodes = freshnessReasonCodes({
    explicitStale,
    sourceHeadMismatch,
    dirtyWorktree,
    graphStale,
  });

  return {
    mode,
    sourceFresh,
    graphStale,
    dispatchable: !nonDispatchable,
    allowOpen: !nonDispatchable,
    ...(nonDispatchable ? { errorCode: 'STALE_INDEX_ERROR' as const } : {}),
    ...(nonDispatchable ? { recommendedStatus: 'NEEDS-REVERIFY' as const } : {}),
    reasonCodes,
    warnings: freshnessWarnings({
      mode,
      targetHead,
      currentHead,
      indexedHead,
      evidenceTargetHead,
      dirtyWorktree,
      explicitStale,
      graphStale,
    }),
  };
}

export function projectStatusForFreshnessGate<TStatus extends string>(
  status: TStatus,
  decision: Pick<AuditFreshnessPolicyDecision, 'allowOpen' | 'recommendedStatus'>,
): TStatus | 'NEEDS-REVERIFY' | 'NEEDS-VERIFY' {
  if (status !== 'OPEN' || decision.allowOpen) return status;
  return decision.recommendedStatus ?? 'NEEDS-REVERIFY';
}

export function freshnessGateErrorMessage(
  decision: Pick<AuditFreshnessPolicyDecision, 'errorCode' | 'warnings'>,
): string {
  const detail = decision.warnings.length > 0 ? ` ${decision.warnings.join(' ')}` : '';
  return `${decision.errorCode ?? 'STALE_INDEX_ERROR'}: audit output is not dispatchable.${detail}`;
}

function freshnessReasonCodes(input: {
  explicitStale: boolean;
  sourceHeadMismatch: boolean;
  dirtyWorktree: boolean;
  graphStale: boolean;
}): AuditFreshnessPolicyReason[] {
  const reasonCodes = new Set<AuditFreshnessPolicyReason>();
  if (input.explicitStale || input.graphStale) reasonCodes.add('stale-evidence');
  if (input.sourceHeadMismatch || input.graphStale) reasonCodes.add('target-head-mismatch');
  if (input.dirtyWorktree) reasonCodes.add('dirty-worktree');
  return [...reasonCodes];
}

function freshnessWarnings(input: {
  mode: AuditFreshnessPolicyMode;
  targetHead: string;
  currentHead: string | null;
  indexedHead: string | null;
  evidenceTargetHead: string | null;
  dirtyWorktree: boolean;
  explicitStale: boolean;
  graphStale: boolean;
}): string[] {
  const warnings: string[] = [];
  if (input.explicitStale) {
    warnings.push('Freshness policy mode explicitly marks this output stale.');
  }
  if (input.currentHead !== null && input.currentHead !== input.targetHead) {
    warnings.push(
      `Current HEAD ${short(input.currentHead)} does not match target HEAD ${short(input.targetHead)}.`,
    );
  }
  if (input.evidenceTargetHead !== null && input.evidenceTargetHead !== input.targetHead) {
    warnings.push(
      `Evidence target HEAD ${short(input.evidenceTargetHead)} does not match target HEAD ${short(input.targetHead)}.`,
    );
  }
  if (input.indexedHead !== null && input.indexedHead !== input.targetHead) {
    warnings.push(
      `Indexed graph HEAD ${short(input.indexedHead)} does not match target HEAD ${short(input.targetHead)}.`,
    );
  }
  if (input.dirtyWorktree) {
    warnings.push('Filesystem source evidence is from a dirty worktree.');
  }
  if (input.mode === 'advisory' && input.graphStale) {
    warnings.push('Advisory mode reports stale graph evidence without blocking output.');
  }
  return warnings;
}

function normalizeHead(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function short(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
