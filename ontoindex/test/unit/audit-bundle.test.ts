import { describe, expect, it } from 'vitest';

import {
  buildAuditBundleProjection,
  buildAuditBundleProjectionFromEvents,
  detectBundleConflicts,
} from '../../src/core/audit-lifecycle/audit-bundle.js';
import { buildFindingDedupeProjection } from '../../src/core/audit-lifecycle/finding-dedupe.js';
import type { AuditEvent } from '../../src/core/audit-lifecycle/audit-event-store.js';
import type {
  AuditFinding,
  AuditFindingStatus,
  AuditSession,
} from '../../src/core/audit-lifecycle/audit-session.js';

const session: AuditSession = {
  id: 'session-1',
  targetRepo: 'repo-a',
  targetHead: 'abc123',
  sourceHash: 'sha256:source',
  graphIndexId: 'index-1',
  verifierVersion: 'verifier-1',
  sidecarStateHash: 'sha256:sidecar',
  createdAt: '2026-05-17T00:00:00.000Z',
  metadata: {},
};

describe('audit bundle projection', () => {
  it('groups duplicate root causes while preserving addressable finding ids', () => {
    const findings = [
      finding('finding-a', {
        rootCauseId: 'rc-fd-cloexec',
        rootCauseTitle: 'Pipe descriptors cross exec boundary',
      }),
      finding('finding-b', {
        rootCauseId: 'rc-fd-cloexec',
        files: ['src/process.cpp'],
        symbols: ['spawnChild'],
        tests: ['test/process.test.ts'],
      }),
    ];

    const dedupe = buildFindingDedupeProjection(findings);
    const rootCauseGroup = dedupe.groups.find((group) => group.strategy === 'root-cause');

    expect(rootCauseGroup).toMatchObject({
      findingIds: ['finding-a', 'finding-b'],
      rootCause: {
        id: expect.stringMatching(/^root-cause:/),
        title: 'Pipe descriptors cross exec boundary',
      },
    });
    expect(dedupe.findingToGroups['finding-a']).toContain(rootCauseGroup?.id);
  });

  it('excludes non-implementation statuses from default bundles', () => {
    const projection = buildAuditBundleProjection(session, [
      finding('open-1', { rootCauseId: 'rc-open' }),
      finding('partial-1', { status: 'PARTIAL', rootCauseId: 'rc-partial' }),
      finding('resolved-1', { status: 'RESOLVED-ALREADY', rootCauseId: 'rc-resolved' }),
      finding('false-positive-1', { status: 'FALSE-POSITIVE', rootCauseId: 'rc-fp' }),
      finding('hold-1', { status: 'HOLD', rootCauseId: 'rc-hold' }),
      finding('needs-verify-1', { status: 'NEEDS-VERIFY', rootCauseId: 'rc-needs' }),
      finding('needs-reverify-1', { status: 'NEEDS-REVERIFY', rootCauseId: 'rc-reverify' }),
    ]);

    expect(projection.bundles.flatMap((bundle) => bundle.findingIds).sort()).toEqual([
      'open-1',
      'partial-1',
    ]);
    expect(projection.excludedFindingIds).toEqual([
      'false-positive-1',
      'hold-1',
      'needs-reverify-1',
      'needs-verify-1',
      'resolved-1',
    ]);
  });

  it('builds reproducible bundle scope with files, symbols, tests, loc, non-scope, and stops', () => {
    const projection = buildAuditBundleProjection(
      session,
      [
        finding('finding-a', {
          rootCauseId: 'rc-fd-cloexec',
          files: ['src/process.cpp'],
          symbols: ['spawnChild'],
          tests: ['test/process.test.ts'],
          writeSet: ['src/process.cpp', 'src/process.h'],
          estimatedLoc: 12,
          nonScope: ['Do not edit MCP surfaces'],
          stopConditions: ['Stop if graph targetHead differs from abc123'],
        }),
        finding('finding-b', {
          rootCauseId: 'rc-fd-cloexec',
          files: ['src/process.h'],
          symbols: ['ProcessConfig'],
          tests: ['test/process.test.ts'],
          writeSet: ['src/process.h'],
          estimatedLoc: 8,
          stopConditions: ['Stop if runtime evidence is required'],
        }),
      ],
      { createdAt: '2026-05-17T01:00:00.000Z' },
    );

    expect(projection.bundles).toHaveLength(1);
    expect(projection.bundles[0]).toMatchObject({
      sessionId: 'session-1',
      findingIds: ['finding-a', 'finding-b'],
      duplicateFindingIds: ['finding-b'],
      files: ['src/process.cpp', 'src/process.h'],
      symbols: ['ProcessConfig', 'spawnChild'],
      tests: ['test/process.test.ts'],
      writeSet: ['src/process.cpp', 'src/process.h'],
      estimatedLoc: 20,
      nonScope: ['Do not edit MCP surfaces'],
      stopConditions: [
        'Stop if graph targetHead differs from abc123',
        'Stop if runtime evidence is required',
      ],
      createdAt: '2026-05-17T01:00:00.000Z',
    });
  });

  it('detects conflicts by file, symbol, test surface, and write set', () => {
    const projection = buildAuditBundleProjection(session, [
      finding('finding-a', {
        rootCauseId: 'rc-a',
        files: ['src/shared.ts'],
        symbols: ['sharedSymbol'],
        tests: ['test/shared.test.ts'],
        writeSet: ['src/shared.ts'],
      }),
      finding('finding-b', {
        rootCauseId: 'rc-b',
        files: ['src/shared.ts'],
        symbols: ['sharedSymbol'],
        tests: ['test/shared.test.ts'],
        writeSet: ['src/shared.ts'],
      }),
    ]);

    expect(projection.conflicts.map((conflict) => conflict.kind).sort()).toEqual([
      'file',
      'symbol',
      'test-surface',
      'write-set',
    ]);
    expect(projection.bundles.every((bundle) => bundle.conflicts.length === 4)).toBe(true);
    expect(detectBundleConflicts(projection.bundles)).toEqual(projection.conflicts);
  });

  it('rebuilds bundle projection from an event log deterministically', () => {
    const events: AuditEvent[] = [
      {
        id: 'evt-1',
        type: 'AuditIngested',
        occurredAt: '2026-05-17T00:00:00.000Z',
        sessionId: 'session-1',
        session,
      },
      candidateEvent('evt-2', finding('finding-b', { rootCauseId: 'rc-shared' })),
      candidateEvent('evt-3', finding('finding-a', { rootCauseId: 'rc-shared' })),
    ];

    const first = buildAuditBundleProjectionFromEvents(events, 'session-1', {
      createdAt: '2026-05-17T01:00:00.000Z',
    });
    const second = buildAuditBundleProjectionFromEvents(
      [...events].reverse().reverse(),
      'session-1',
      {
        createdAt: '2026-05-17T01:00:00.000Z',
      },
    );

    expect(first).toEqual(second);
    expect(first.bundles[0]?.findingIds).toEqual(['finding-a', 'finding-b']);
  });

  it('carries snapshot mode and stale warnings into bundle outputs', () => {
    const projection = buildAuditBundleProjection(
      {
        ...session,
        snapshotMode: 'dirty-worktree-overlay',
        changedFiles: ['src/process.cpp'],
        changedSymbols: ['spawnChild'],
        staleWarnings: ['Graph impact is stale; filesystem evidence is fresh.'],
      },
      [finding('open-1', { rootCauseId: 'rc-open' })],
    );

    expect(projection).toMatchObject({
      snapshotMode: 'dirty-worktree-overlay',
      staleWarnings: ['Graph impact is stale; filesystem evidence is fresh.'],
      sessionSnapshot: {
        mode: 'dirty-worktree-overlay',
        changedFiles: ['src/process.cpp'],
        changedSymbols: ['spawnChild'],
      },
    });
    expect(projection.bundles[0]).toMatchObject({
      snapshotMode: 'dirty-worktree-overlay',
      staleWarnings: ['Graph impact is stale; filesystem evidence is fresh.'],
      sessionSnapshot: {
        mode: 'dirty-worktree-overlay',
        changedFiles: ['src/process.cpp'],
        changedSymbols: ['spawnChild'],
      },
    });
  });
});

function finding(
  id: string,
  metadata: Record<string, unknown> & { status?: AuditFindingStatus } = {},
): AuditFinding {
  const { status = 'OPEN', ...rest } = metadata;
  return {
    id,
    sessionId: 'session-1',
    title: `Finding ${id}`,
    fingerprint: `fingerprint-${id}`,
    status,
    evidence: [],
    metadata: {
      files: ['src/process.cpp'],
      symbols: ['spawnChild'],
      tests: ['test/process.test.ts'],
      writeSet: ['src/process.cpp'],
      estimatedLoc: 5,
      ...rest,
    },
  };
}

function candidateEvent(id: string, auditFinding: AuditFinding): AuditEvent {
  return {
    id,
    type: 'FindingCandidateCreated',
    occurredAt: '2026-05-17T00:00:01.000Z',
    sessionId: auditFinding.sessionId,
    findingId: auditFinding.id,
    finding: auditFinding,
  };
}
