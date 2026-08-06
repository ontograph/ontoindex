import { describe, expect, it } from 'vitest';
import {
  attachRepoScopeIdentity,
  createGlobalTargetContext,
  createCapabilityResponseEnvelope,
  createEnvelopeFromLegacy,
  deriveEnvelopeFreshness,
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

  it('keeps an authoritative dirty source snapshot actionable', () => {
    const freshness = deriveEnvelopeFreshness({
      version: 1,
      status: 'ok',
      repoKey: 'fixture',
      repoPath: '/repo/fixture',
      targetRef: 'HEAD',
      targetHead: 'abc123',
      currentHead: 'abc123',
      indexedHead: 'abc123',
      graphAuthority: {
        state: 'authoritative',
        reason: 'current source manifest matches indexed generation',
        generationId: 'generation-1',
        manifestDigest: 'manifest-1',
        coverage: 'complete',
      },
      dirtyWorktree: true,
      dirtyFileCount: 1,
      changedSinceIndex: true,
      snapshotMode: 'dirty-worktree-overlay',
      qualityMode: 'balanced',
      embeddings: { status: 'unknown' },
      lsp: { status: 'unknown' },
      sidecar: { status: 'unknown' },
      policy: { status: 'unknown' },
      warnings: [],
    });

    expect(freshness).toMatchObject({
      status: 'fresh',
      actionable: true,
      reason: 'current source manifest matches indexed generation',
      graphAuthorityState: 'authoritative',
      graphGenerationId: 'generation-1',
      graphManifestDigest: 'manifest-1',
      dirtyFileCount: 1,
      snapshotMode: 'dirty-worktree-overlay',
    });
  });

  it('does not promote an authoritative current checkout for a different target ref', () => {
    const freshness = deriveEnvelopeFreshness({
      version: 1,
      status: 'ok',
      repoKey: 'fixture',
      repoPath: '/repo/fixture',
      targetRef: 'HEAD~1',
      targetHead: 'historical-commit',
      currentHead: 'current-commit',
      indexedHead: 'current-commit',
      graphAuthority: {
        state: 'authoritative',
        reason: 'current source manifest matches indexed generation',
        generationId: 'generation-1',
        manifestDigest: 'manifest-1',
        coverage: 'complete',
      },
      dirtyWorktree: false,
      dirtyFileCount: 0,
      changedSinceIndex: false,
      snapshotMode: 'diff-ref',
      qualityMode: 'balanced',
      embeddings: { status: 'unknown' },
      lsp: { status: 'unknown' },
      sidecar: { status: 'unknown' },
      policy: { status: 'unknown' },
      warnings: [],
    });

    expect(freshness).toMatchObject({
      status: 'stale',
      actionable: false,
      reason: 'graph authority describes current checkout, not requested target ref',
      graphAuthorityState: 'authoritative',
    });
  });

  it('does not promote authority when target commit identity is unavailable', () => {
    const freshness = deriveEnvelopeFreshness({
      version: 1,
      status: 'ok',
      repoKey: 'fixture',
      repoPath: '/repo/fixture',
      targetRef: 'HEAD',
      graphAuthority: {
        state: 'authoritative',
        reason: 'current source manifest matches indexed generation',
        coverage: 'complete',
      },
      dirtyWorktree: false,
      changedSinceIndex: null,
      snapshotMode: 'unknown',
      qualityMode: 'balanced',
      embeddings: { status: 'unknown' },
      lsp: { status: 'unknown' },
      sidecar: { status: 'unknown' },
      policy: { status: 'unknown' },
      warnings: [],
    });

    expect(freshness).toMatchObject({
      status: 'degraded',
      actionable: false,
      reason: 'target commit unavailable for graph authority',
    });
  });

  it.each([
    ['legacy dirty index', undefined, 'degraded'],
    [
      'post-index source change',
      {
        state: 'review' as const,
        reason: 'current source manifest does not match indexed manifest',
        generationId: 'generation-1',
        manifestDigest: 'manifest-1',
        coverage: 'complete' as const,
      },
      'stale',
    ],
  ] as const)('keeps %s non-actionable', (_label, graphAuthority, expectedStatus) => {
    const freshness = deriveEnvelopeFreshness({
      version: 1,
      status: 'ok',
      repoKey: 'fixture',
      repoPath: '/repo/fixture',
      targetRef: 'HEAD',
      targetHead: 'abc123',
      currentHead: 'abc123',
      indexedHead: 'abc123',
      ...(graphAuthority ? { graphAuthority } : {}),
      dirtyWorktree: true,
      dirtyFileCount: 1,
      changedSinceIndex: true,
      snapshotMode: 'dirty-worktree-overlay',
      qualityMode: 'balanced',
      embeddings: { status: 'unknown' },
      lsp: { status: 'unknown' },
      sidecar: { status: 'unknown' },
      policy: { status: 'unknown' },
      warnings: [],
    });

    expect(freshness.status).toBe(expectedStatus);
    expect(freshness.actionable).toBe(false);
    expect(freshness.dirtyFileCount).toBe(1);
  });
});
