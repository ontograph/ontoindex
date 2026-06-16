export const RECOVERABLE_RUNTIME_STATE_KINDS = [
  'repo-not-indexed',
  'wrong-repo-binding',
  'stale-index',
  'output-truncated',
  'analyze-failed-after-partial-run',
] as const;

export type RecoverableRuntimeStateKind = (typeof RECOVERABLE_RUNTIME_STATE_KINDS)[number];

export interface RecoverableRuntimeState {
  recoverable: true;
  kind: RecoverableRuntimeStateKind;
  reason: string;
  message: string;
  repairCommand: string;
  retryCommand?: string;
}

export type RecoverableRuntimeStateInput = Omit<RecoverableRuntimeState, 'recoverable'>;

export interface RecoverableRuntimeStateContext {
  freshnessStatus?: string;
  freshnessReason?: string | null;
  runtimeHealthState?: string;
  runtimeDegradedReason?: string | null;
  runtimeRepairCommand?: string | null;
}

export function createRecoverableRuntimeState(
  input: RecoverableRuntimeStateInput,
): RecoverableRuntimeState {
  return {
    recoverable: true,
    kind: input.kind,
    reason: input.reason.trim(),
    message: input.message.trim(),
    repairCommand: input.repairCommand.trim(),
    ...(input.retryCommand?.trim() ? { retryCommand: input.retryCommand.trim() } : {}),
  };
}

export function createRepoNotIndexedRecoverableState(
  options: {
    requestedRepo?: string;
    repairCommand?: string;
    retryCommand?: string;
  } = {},
): RecoverableRuntimeState {
  const requestedRepo = options.requestedRepo?.trim();
  const reason = requestedRepo
    ? `Repository "${requestedRepo}" is not indexed`
    : 'No indexed repositories are available';
  return createRecoverableRuntimeState({
    kind: 'repo-not-indexed',
    reason,
    message: `${reason}. Run \`ontoindex analyze\` and retry with a valid repo binding.`,
    repairCommand: options.repairCommand ?? 'ontoindex analyze',
    ...(options.retryCommand ? { retryCommand: options.retryCommand } : {}),
  });
}

export function createWrongRepoBindingRecoverableState(options: {
  repoSelector: string;
  resolvedRepoLabel: string;
  resolvedRepoPath: string;
  projectCwd: string;
  repairCommand?: string;
  retryCommand?: string;
}): RecoverableRuntimeState {
  const repoSelector = options.repoSelector.trim();
  const resolvedRepoLabel = options.resolvedRepoLabel.trim();
  const resolvedRepoPath = options.resolvedRepoPath.trim();
  const projectCwd = options.projectCwd.trim();
  const repairCommand =
    options.repairCommand ??
    `ontoindex mcp --project '${projectCwd.replace(/'/g, `'"'"'`)}' --repo '${repoSelector.replace(/'/g, `'"'"'`)}'`;

  return createRecoverableRuntimeState({
    kind: 'wrong-repo-binding',
    reason: `Repository binding "${repoSelector}" resolves to ${resolvedRepoLabel} -> ${resolvedRepoPath}, but the target project path is ${projectCwd}`,
    message: `Restart MCP with the intended project and repo binding.`,
    repairCommand,
    ...(options.retryCommand ? { retryCommand: options.retryCommand } : {}),
  });
}

export function createStaleIndexRecoverableState(
  options: {
    reason?: string | null;
    repairCommand?: string;
    retryCommand?: string;
  } = {},
): RecoverableRuntimeState {
  const reason = options.reason?.trim() || 'Indexed commit does not match the current commit';
  return createRecoverableRuntimeState({
    kind: 'stale-index',
    reason,
    message: `Refresh the index before retrying. Run \`ontoindex analyze\`.`,
    repairCommand: options.repairCommand ?? 'ontoindex analyze',
    ...(options.retryCommand ? { retryCommand: options.retryCommand } : {}),
  });
}

export function createOutputTruncatedRecoverableState(options: {
  reason?: string;
  retryCommand: string;
  repairCommand?: string;
  message?: string;
}): RecoverableRuntimeState {
  return createRecoverableRuntimeState({
    kind: 'output-truncated',
    reason: options.reason?.trim() || 'Response output was truncated by the shared budget',
    message:
      options.message?.trim() ||
      'Narrow the query or rerun with a smaller scope so the response fits the budget.',
    repairCommand: options.repairCommand ?? options.retryCommand,
    retryCommand: options.retryCommand,
  });
}

export function createAnalyzeFailedAfterPartialRunRecoverableState(
  options: {
    reason?: string | null;
    repairCommand?: string;
    retryCommand?: string;
  } = {},
): RecoverableRuntimeState {
  const reason = options.reason?.trim() || 'Analyze failed after a partial runtime run';
  return createRecoverableRuntimeState({
    kind: 'analyze-failed-after-partial-run',
    reason,
    message: `Repair the partial run before retrying. Run \`ontoindex analyze --force\`.`,
    repairCommand: options.repairCommand ?? 'ontoindex analyze --force',
    ...(options.retryCommand ? { retryCommand: options.retryCommand } : {}),
  });
}

export function deriveRecoverableRuntimeState(
  input: RecoverableRuntimeStateContext,
): RecoverableRuntimeState | null {
  if (input.runtimeHealthState === 'failed-after-partial-run') {
    return createAnalyzeFailedAfterPartialRunRecoverableState({
      reason: input.runtimeDegradedReason ?? input.freshnessReason ?? undefined,
      repairCommand: input.runtimeRepairCommand ?? 'ontoindex analyze --force',
    });
  }

  if (input.runtimeHealthState === 'stale' || input.freshnessStatus === 'stale') {
    return createStaleIndexRecoverableState({
      reason: input.runtimeDegradedReason ?? input.freshnessReason ?? undefined,
      repairCommand: input.runtimeRepairCommand ?? 'ontoindex analyze',
    });
  }

  return null;
}
