import { describe, expect, it } from 'vitest';
import {
  attachRepoScopeIdentity,
  createGlobalTargetContext,
  createCapabilityResponseEnvelope,
  createEnvelopeFromLegacy,
  deriveEnvelopeFreshness,
  findDirtyResultPaths,
  mergeRuntimeHealthFreshness,
  wrapRepoScopeIdentity,
  type CapabilityResponseFreshness,
} from '../../src/mcp/shared/response-envelope.js';
import {
  createOutputTruncatedRecoverableState,
  createStaleIndexRecoverableState,
} from '../../src/mcp/shared/recoverable-runtime-state.js';
import type { TargetContext } from '../../src/mcp/shared/target-context.js';
import { resolveTargetContext } from '../../src/mcp/shared/target-context.js';

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

describe('response envelope Git context freshness', () => {
  const knownContext: TargetContext = {
    version: 1,
    status: 'ok',
    repoKey: 'fixture',
    repoLabel: 'Fixture',
    repoPath: '/repo/fixture',
    targetRef: 'HEAD',
    targetHead: 'abc123',
    currentHead: 'abc123',
    indexedHead: 'abc123',
    dirtyWorktree: false,
    dirtyFileCount: 0,
    changedSinceIndex: false,
    snapshotMode: 'committed-head',
    qualityMode: 'balanced',
    scopeConfidence: 'high',
    embeddings: { status: 'unknown' },
    lsp: { status: 'unknown' },
    sidecar: { status: 'unknown' },
    policy: { status: 'unknown' },
    warnings: [],
  };
  it.each([
    ['ok', false, 'dirty', false],
    ['success', false, 'dirty', false],
    ['ok', true, 'dirty', true],
    ['error', false, 'dirty', true],
    ['ok', false, 'untrusted', true],
  ] as const)(
    'keeps runtime advice for status=%s diagnostics=%s runtime=%s',
    (status, diagnosticsRequested, freshnessState, retained) => {
      const targetContext: TargetContext = {
        ...knownContext,
        dirtyWorktree: true,
        graphAuthority: {
          state: 'authoritative',
          reason: 'validated workspace',
          capability: 'workspace-graph',
          generationId: 'workspace-1',
          manifestDigest: 'digest',
          coverage: 'complete',
        },
      };
      const envelope = createEnvelopeFromLegacy({
        legacy: { version: 1, findings: [] },
        tool: 'fixture',
        status,
        diagnosticsRequested,
        targetContext,
        runtimeHealth: {
          freshnessState,
          degradedReason: 'runtime reason',
          repairCommand: 'ontoindex analyze',
          repairAction: {
            tool: 'ontoindex',
            command: 'analyze',
            args: [],
            reason: 'runtime reason',
          },
        },
      });
      expect(envelope.targetContext).toBe(targetContext);
      expect(envelope.freshness.runtimeHealthState).toBe(freshnessState);
      expect(envelope.freshness.runtimeRepairCommand).toBe(
        retained ? 'ontoindex analyze' : undefined,
      );
    },
  );

  it.each(['gn_diagnose', 'gn_ensure_fresh'])(
    'preserves dirty repair advice for %s without an explicit diagnostic option',
    (tool) => {
      const targetContext: TargetContext = {
        ...knownContext,
        dirtyWorktree: true,
        graphAuthority: {
          state: 'authoritative',
          reason: 'validated workspace',
          capability: 'workspace-graph',
          generationId: 'workspace-1',
          manifestDigest: 'digest',
          coverage: 'complete',
        },
      };
      const envelope = createEnvelopeFromLegacy({
        legacy: { version: 1 },
        tool,
        status: 'ok',
        targetContext,
        runtimeHealth: {
          freshnessState: 'dirty',
          degradedReason: 'dirty reason',
          repairCommand: 'ontoindex analyze',
        },
      });
      expect(envelope.freshness.runtimeHealthState).toBe('dirty');
      expect(envelope.freshness.runtimeRepairCommand).toBe('ontoindex analyze');
    },
  );

  const unknownCases: [string, Partial<TargetContext>][] = [
    ['missing current commit', { currentHead: undefined }],
    ['missing target commit', { targetHead: undefined }],
    ['missing indexed commit', { indexedHead: undefined }],
    ['unknown worktree status', { dirtyWorktree: null, dirtyFileCount: null }],
    ['unknown snapshot mode', { snapshotMode: 'unknown' }],
  ];

  it.each(unknownCases)('keeps legacy fallback non-actionable with %s', (_label, change) => {
    const targetContext = { ...knownContext, ...change };
    const envelope = createEnvelopeFromLegacy({
      legacy: { version: 1, findings: [] },
      tool: 'fixture-tool',
      status: 'ok',
      targetContext,
    });

    expect(envelope.freshness).toEqual({
      status: 'degraded',
      actionable: false,
      reason: 'git context unavailable',
      targetHead: targetContext.targetHead,
      currentHead: targetContext.currentHead,
      indexedHead: targetContext.indexedHead,
      snapshotMode: targetContext.snapshotMode,
      repoLabel: 'Fixture',
      repoPath: '/repo/fixture',
      indexedCommit: targetContext.indexedHead,
      headCommit: targetContext.currentHead,
      isStale: false,
      dirtyFileCount: targetContext.dirtyFileCount,
      scopeConfidence: 'high',
    });
  });

  it.each([
    ['known clean checkout', {}],
    [
      'aligned historical target',
      {
        targetRef: 'HEAD~1',
        targetHead: 'historical',
        indexedHead: 'historical',
        snapshotMode: 'diff-ref',
      },
    ],
  ] satisfies [string, Partial<TargetContext>][])('keeps %s actionable', (_label, change) => {
    expect(deriveEnvelopeFreshness({ ...knownContext, ...change })).toMatchObject({
      status: 'fresh',
      actionable: true,
      reason: 'target context aligned',
    });
  });

  it.each([
    ['unresolved target', { status: 'no-index' }, 'unknown', 'target-context:no-index'],
    ['stale index', { indexedHead: 'old-commit' }, 'stale', 'indexedHead != targetHead'],
    ['dirty checkout', { dirtyWorktree: true }, 'degraded', 'dirty-worktree-overlay'],
  ] satisfies [string, Partial<TargetContext>, string, string][])(
    'preserves %s precedence with unknown snapshot mode',
    (_label, change, status, reason) => {
      expect(
        deriveEnvelopeFreshness({
          ...knownContext,
          ...change,
          snapshotMode: 'unknown',
        }),
      ).toMatchObject({ status, actionable: false, reason });
    },
  );

  it.each(unknownCases)('preserves authoritative decisions with %s', (_label, change) => {
    const targetContext: TargetContext = {
      ...knownContext,
      ...change,
      graphAuthority: {
        state: 'authoritative',
        reason: 'current source manifest matches indexed generation',
        generationId: 'generation-1',
        manifestDigest: 'manifest-1',
        coverage: 'complete',
      },
    };
    const currentTargetKnown = Boolean(targetContext.currentHead && targetContext.targetHead);

    expect(deriveEnvelopeFreshness(targetContext)).toMatchObject({
      status: currentTargetKnown ? 'fresh' : 'degraded',
      actionable: currentTargetKnown,
      reason: currentTargetKnown
        ? 'current source manifest matches indexed generation'
        : 'target commit unavailable for graph authority',
      graphAuthorityState: 'authoritative',
      graphGenerationId: 'generation-1',
      graphManifestDigest: 'manifest-1',
    });
  });

  it.each(['review', 'degraded'] as const)(
    'keeps %s graph authority non-actionable with unknown Git context',
    (state) => {
      expect(
        deriveEnvelopeFreshness({
          ...knownContext,
          indexedHead: undefined,
          dirtyWorktree: null,
          snapshotMode: 'unknown',
          graphAuthority: { state, reason: 'graph authority unavailable' },
        }),
      ).toMatchObject({
        status: state === 'review' ? 'stale' : 'degraded',
        actionable: false,
        reason: 'graph authority unavailable',
        graphAuthorityState: state,
      });
    },
  );

  it('preserves explicit freshness overrides and global context', () => {
    expect(
      deriveEnvelopeFreshness(
        { ...knownContext, dirtyWorktree: null },
        { status: 'unknown', actionable: false, reason: 'explicit override' },
      ),
    ).toMatchObject({ status: 'unknown', actionable: false, reason: 'explicit override' });
    expect(deriveEnvelopeFreshness(createGlobalTargetContext('global'))).toEqual({
      status: 'not-applicable',
      actionable: true,
      reason: 'global',
      scopeConfidence: 'unknown',
    });
  });
});

describe('dirty result paths', () => {
  it('finds dirty paths nested in results and ignores clean ones', () => {
    const results = {
      definitions: [{ filePath: 'src/a.ts' }, { filePath: 'src/clean.ts' }],
      nested: { items: [{ path: 'src\\b.ts' }], note: 'src/c.ts' },
    };
    expect(findDirtyResultPaths(results, ['src/a.ts', 'src/b.ts', 'src/c.ts'])).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('returns nothing when there are no dirty paths', () => {
    expect(findDirtyResultPaths({ filePath: 'src/a.ts' }, [])).toEqual([]);
  });

  it('adds freshness.dirtyResultPaths only when results touch dirty files', () => {
    const base = createGlobalTargetContext('fixture');
    const targetContext = {
      ...base,
      dirtyWorkspace: {
        state: 'dirty-file' as const,
        fileCount: 1,
        sourceFileCount: 1,
        stagedSourceFileCount: 0,
        unstagedSourceFileCount: 1,
        untrackedSourceFileCount: 0,
        unknownGraphCoverageCount: 0,
        dirtyPaths: ['src/a.ts'],
      },
    };
    const freshness: CapabilityResponseFreshness = {
      status: 'fresh',
      actionable: true,
      reason: 'ok',
    };
    const make = (results: Record<string, unknown>) =>
      createCapabilityResponseEnvelope({
        tool: 't',
        version: 1,
        status: 'ok',
        targetContext: targetContext as never,
        freshness,
        results,
      });
    expect(make({ filePath: 'src/a.ts' }).freshness.dirtyResultPaths).toEqual(['src/a.ts']);
    const clean = { file: 'src/other.ts' };
    const dirty = { path: 'src/a.ts', stale: false, label: 'kept' };
    const results = { nested: [dirty], clean };
    const marked = make(results);
    expect(marked.results).toEqual({ nested: [{ ...dirty, stale: true }], clean });
    expect(marked.results.clean).toBe(clean);
    expect(dirty.stale).toBe(false);
    expect(make(clean).results).toBe(clean);
    const legacy = createEnvelopeFromLegacy({
      legacy: { nested: [dirty] },
      tool: 't',
      status: 'ok',
      targetContext,
      freshness,
    });
    expect(legacy.results.nested).toEqual([{ ...dirty, stale: true }]);
    // Repository contexts do not contain the global scope discriminator.
    const repositoryContext = {
      ...targetContext,
      targetHead: 'same',
      currentHead: 'same',
      graphAuthority: { state: 'authoritative' },
    };
    Reflect.deleteProperty(repositoryContext, 'scope');
    expect(
      createCapabilityResponseEnvelope({
        tool: 't',
        version: 1,
        status: 'ok',
        freshness,
        results,
        targetContext: repositoryContext as never,
      }).results,
    ).toBe(results);
    const cycle: Record<string, unknown> = { file: 'src/a.ts' };
    cycle.self = cycle;
    const markedCycle = make(cycle).results;
    expect(markedCycle.stale).toBe(true);
    expect(markedCycle.self).toBe(markedCycle);
    expect(cycle.stale).toBeUndefined();
    const wide = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i]));
    expect(make(wide).warnings).toContain(
      'Dirty result scan truncated at 5000 nodes/edges; additional dirty entries may be unmarked.',
    );
    let deep: Record<string, unknown> = { file: 'src/a.ts' };
    for (let i = 0; i < 10_000; i++) deep = { child: deep };
    expect(make(deep).warnings).toHaveLength(1);
    expect(make({ filePath: 'src/other.ts' }).freshness.dirtyResultPaths).toBeUndefined();
  });

  it('marks dirty paths beyond the serialized fifty-path cap as stale', async () => {
    const status = Array.from({ length: 60 }, (_, i) => ` M src/f${i}.ts`).join('\n') + '\n';
    const context = await resolveTargetContext(
      { repo: 'fixture' },
      {
        readRegistry: async () => [
          {
            name: 'fixture',
            path: '/repo/fixture',
            storagePath: '/repo/fixture/.ontoindex',
            indexedAt: 'graph-index-1',
            lastCommit: 'abc123def456abc123def456abc123def456abc1',
            stats: { embeddings: 0 },
          },
        ],
        execGit: async (_cwd, args) => {
          const key = args.join(' ');
          if (key === 'rev-parse --abbrev-ref HEAD') return 'main\n';
          if (key === 'rev-parse HEAD') return 'abc123def456abc123def456abc123def456abc1\n';
          if (key === 'status --porcelain=v1 --untracked-files=all') return status;
          return 'abc123def456abc123def456abc123def456abc1\n';
        },
      },
    );
    const envelope = createCapabilityResponseEnvelope({
      tool: 'fixture',
      version: 1,
      status: 'ok',
      targetContext: context,
      freshness: deriveEnvelopeFreshness(context),
      results: {
        beyondCap: { filePath: 'src/f59.ts' },
        clean: { filePath: 'src/clean.ts' },
      },
    });
    expect(envelope.results).toEqual({
      beyondCap: { filePath: 'src/f59.ts', stale: true },
      clean: { filePath: 'src/clean.ts' },
    });
    expect(envelope.freshness.dirtyResultPaths).toEqual(['src/f59.ts']);
  });
});
