import { describe, expect, it } from 'vitest';

import {
  createAnalyzeFailedAfterPartialRunRecoverableState,
  createOutputTruncatedRecoverableState,
  createRepoNotIndexedRecoverableState,
  createStaleIndexRecoverableState,
  createWrongRepoBindingRecoverableState,
  deriveRecoverableRuntimeState,
} from '../../src/mcp/shared/recoverable-runtime-state.js';

describe('recoverable runtime state helpers', () => {
  it('builds a repo-not-indexed state', () => {
    expect(createRepoNotIndexedRecoverableState({ requestedRepo: 'ontoindex' })).toEqual({
      recoverable: true,
      kind: 'repo-not-indexed',
      reason: 'Repository "ontoindex" is not indexed',
      message:
        'Repository "ontoindex" is not indexed. Run `ontoindex analyze` and retry with a valid repo binding.',
      repairCommand: 'ontoindex analyze',
    });
  });

  it('builds a wrong-repo-binding state', () => {
    expect(
      createWrongRepoBindingRecoverableState({
        repoSelector: 'codex',
        resolvedRepoLabel: 'fixture',
        resolvedRepoPath: '/repo/fixture',
        projectCwd: '/repo/worktree',
      }),
    ).toEqual({
      recoverable: true,
      kind: 'wrong-repo-binding',
      reason:
        'Repository binding "codex" resolves to fixture -> /repo/fixture, but the target project path is /repo/worktree',
      message: 'Restart MCP with the intended project and repo binding.',
      repairCommand: "ontoindex mcp --project '/repo/worktree' --repo 'codex'",
    });
  });

  it('builds a stale-index state', () => {
    expect(
      createStaleIndexRecoverableState({
        reason: 'current commit does not match indexed commit',
        repairCommand: 'ontoindex analyze',
      }),
    ).toEqual({
      recoverable: true,
      kind: 'stale-index',
      reason: 'current commit does not match indexed commit',
      message: 'Refresh the index before retrying. Run `ontoindex analyze`.',
      repairCommand: 'ontoindex analyze',
    });
  });

  it('builds an output-truncated state', () => {
    expect(
      createOutputTruncatedRecoverableState({
        retryCommand: 'Re-run gn_review_diff with a narrower commit range or diff scope.',
      }),
    ).toEqual({
      recoverable: true,
      kind: 'output-truncated',
      reason: 'Response output was truncated by the shared budget',
      message: 'Narrow the query or rerun with a smaller scope so the response fits the budget.',
      repairCommand: 'Re-run gn_review_diff with a narrower commit range or diff scope.',
      retryCommand: 'Re-run gn_review_diff with a narrower commit range or diff scope.',
    });
  });

  it('builds an analyze-failed-after-partial-run state', () => {
    expect(
      createAnalyzeFailedAfterPartialRunRecoverableState({
        reason: 'analysis checkpoint recorded a failed run',
      }),
    ).toEqual({
      recoverable: true,
      kind: 'analyze-failed-after-partial-run',
      reason: 'analysis checkpoint recorded a failed run',
      message: 'Repair the partial run before retrying. Run `ontoindex analyze --force`.',
      repairCommand: 'ontoindex analyze --force',
    });
  });

  it('derives a stale-index state from runtime health context', () => {
    expect(
      deriveRecoverableRuntimeState({
        freshnessStatus: 'stale',
        freshnessReason: 'indexedHead != targetHead',
        runtimeHealthState: 'stale',
        runtimeDegradedReason: 'current commit does not match indexed commit',
        runtimeRepairCommand: 'ontoindex analyze',
      }),
    ).toEqual({
      recoverable: true,
      kind: 'stale-index',
      reason: 'current commit does not match indexed commit',
      message: 'Refresh the index before retrying. Run `ontoindex analyze`.',
      repairCommand: 'ontoindex analyze',
    });
  });
});
