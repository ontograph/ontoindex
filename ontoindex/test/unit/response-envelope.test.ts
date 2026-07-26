import { describe, expect, it } from 'vitest';
import {
  attachRepoScopeIdentity,
  createGlobalTargetContext,
  createCapabilityResponseEnvelope,
  createEnvelopeFromLegacy,
  mergeRuntimeHealthFreshness,
  wrapRepoScopeIdentity,
  type CapabilityResponseFreshness,
} from '../../src/mcp/shared/response-envelope.js';
import {
  createOutputTruncatedRecoverableState,
  createStaleIndexRecoverableState,
} from '../../src/mcp/shared/recoverable-runtime-state.js';

describe('response envelope repo identity', () => {
  const repo = {
    id: 'repo-1',
    name: 'fixture',
    repoPath: '/repo/fixture',
  };

  it('adds compact repo identity to legacy object responses', () => {
    const result = attachRepoScopeIdentity({ findings: [] }, repo);
    expect(result).toEqual({
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
      findings: [],
    });
  });

  it('preserves explicit targetContext envelopes', () => {
    const targetContext = createGlobalTargetContext('global');
    const result = attachRepoScopeIdentity({ targetContext, tools: [] }, repo);
    expect(result).toEqual({ targetContext, tools: [] });
  });

  it('preserves arrays and scalars by default', () => {
    const items = [{ name: 'fixture' }];
    expect(attachRepoScopeIdentity(items, repo)).toBe(items);
    expect(attachRepoScopeIdentity('ok', repo)).toBe('ok');
  });

  it('wraps arrays and scalars with an explicit envelope opt-in', () => {
    expect(wrapRepoScopeIdentity([{ name: 'fixture' }], repo)).toEqual({
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
      result: [{ name: 'fixture' }],
    });
    expect(wrapRepoScopeIdentity('ok', repo)).toEqual({
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
      result: 'ok',
    });
  });

  it('merges runtime health metadata without dropping freshness fields', () => {
    const freshness: CapabilityResponseFreshness = {
      status: 'fresh',
      actionable: true,
      reason: 'target context aligned',
      targetHead: 'abc123def456',
      currentHead: 'abc123def456',
      indexedHead: 'abc123def456',
      snapshotMode: 'committed-head',
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
      indexedCommit: 'abc123def456',
      headCommit: 'abc123def456',
      isStale: false,
      dirtyFileCount: 0,
      scopeConfidence: 'high',
    };

    expect(
      mergeRuntimeHealthFreshness(freshness, {
        freshnessState: 'dirty',
        degradedReason: 'dirty worktree contains uncommitted changes',
        repairCommand: 'commit, stash, or clean the worktree, then rerun ontoindex analyze',
        repairAction: {
          tool: 'ontoindex',
          command: 'analyze',
          args: [],
          reason: 'analyze after the worktree is clean',
        },
      }),
    ).toEqual({
      ...freshness,
      runtimeHealthState: 'dirty',
      runtimeDegradedReason: 'dirty worktree contains uncommitted changes',
      runtimeRepairCommand: 'commit, stash, or clean the worktree, then rerun ontoindex analyze',
      runtimeRepairAction: {
        tool: 'ontoindex',
        command: 'analyze',
        args: [],
        reason: 'analyze after the worktree is clean',
      },
    });
  });

  it('threads runtime health through capability envelopes', () => {
    const freshness: CapabilityResponseFreshness = {
      status: 'fresh',
      actionable: true,
      reason: 'target context aligned',
    };

    const envelope = createCapabilityResponseEnvelope({
      tool: 'fixture-tool',
      version: 1,
      status: 'ok',
      targetContext: createGlobalTargetContext('fixture'),
      freshness,
      runtimeHealth: {
        freshnessState: 'stale',
        degradedReason: 'current commit does not match indexed commit',
        repairCommand: 'ontoindex analyze',
        repairAction: {
          tool: 'ontoindex',
          command: 'analyze',
          args: [],
          reason: 'refresh the stale index',
        },
      },
      results: { ok: true },
    });

    expect(envelope.freshness).toEqual({
      ...freshness,
      runtimeHealthState: 'stale',
      runtimeDegradedReason: 'current commit does not match indexed commit',
      runtimeRepairCommand: 'ontoindex analyze',
      runtimeRepairAction: {
        tool: 'ontoindex',
        command: 'analyze',
        args: [],
        reason: 'refresh the stale index',
      },
    });
  });

  it('derives recoverable state for stale runtime health in capability envelopes', () => {
    const envelope = createCapabilityResponseEnvelope({
      tool: 'fixture-tool',
      version: 1,
      status: 'degraded',
      targetContext: createGlobalTargetContext('fixture'),
      freshness: {
        status: 'stale',
        actionable: false,
        reason: 'indexedHead != targetHead',
      },
      runtimeHealth: {
        freshnessState: 'stale',
        degradedReason: 'current commit does not match indexed commit',
        repairCommand: 'ontoindex analyze',
        repairAction: {
          tool: 'ontoindex',
          command: 'analyze',
          args: [],
          reason: 'refresh the stale index',
        },
      },
      results: { ok: true },
    });

    expect(envelope.recoverable).toEqual(
      createStaleIndexRecoverableState({
        reason: 'current commit does not match indexed commit',
        repairCommand: 'ontoindex analyze',
      }),
    );
  });

  it('preserves explicit recoverable state on legacy envelopes', () => {
    const recoverable = createOutputTruncatedRecoverableState({
      retryCommand: 'Re-run gn_review_diff with a narrower commit range or diff scope.',
    });

    const envelope = createEnvelopeFromLegacy({
      legacy: { version: 1, warnings: [] },
      tool: 'fixture-tool',
      status: 'degraded',
      targetContext: createGlobalTargetContext('fixture'),
      recoverable,
    });

    expect(envelope.recoverable).toEqual(recoverable);
  });
});
