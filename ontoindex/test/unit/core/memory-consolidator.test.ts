import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AuthoritativeMemoryDeniedError,
  ConsolidatedMemoryManager,
} from '../../../src/core/runtime/memory-consolidator.js';
import { LocalAuditEventStore } from '../../../src/core/audit-lifecycle/audit-event-store.js';

vi.mock('../../../src/core/audit-lifecycle/audit-event-store.js');

vi.mock('../../../src/core/audit-lifecycle/pr-marker-scan.js', () => ({
  scanPrMarkersNearPath: vi.fn().mockResolvedValue({
    markers: [{ kind: 'TODO', text: 'fix this', line: 10 }],
  }),
}));

describe('ConsolidatedMemoryManager', () => {
  const repoRoot = '.vitest-memory-test';

  beforeEach(async () => {
    await mkdir(repoRoot, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('consolidates audit findings and PR markers', async () => {
    const manager = new ConsolidatedMemoryManager(repoRoot);

    // Mock store class
    const mockLoad = vi.fn().mockResolvedValue({
      events: [
        {
          id: 'e1',
          type: 'FindingCandidateCreated',
          finding: {
            id: 'f1',
            sessionId: 's1',
            title: 'Test Finding',
            fingerprint: 'fp1',
            status: 'OPEN',
            evidence: [{ data: { path: 'src/app.ts', line: 10 } }],
          },
          occurredAt: new Date().toISOString(),
        } as any,
      ],
    });

    (LocalAuditEventStore as any).mockImplementation(function () {
      return { load: mockLoad };
    });

    const memory = await manager.consolidate();

    expect(memory.auditFindings.open).toHaveLength(1);
    expect(memory.trust).toMatchObject({
      evidenceClass: 'advisory_memory',
      authority: 'advisory',
      requestedAuthority: 'advisory',
      freshness: 'unknown',
      notAuditEvidence: true,
    });
    expect(memory.trust.warnings).toContain(
      'Consolidated memory is advisory context only and is not authoritative graph, docs, or audit evidence.',
    );
    expect(memory.prMarkers).toHaveLength(1);
    expect(memory.prMarkers[0].markers[0].kind).toBe('TODO');

    const persisted = JSON.parse(
      await readFile(join(repoRoot, '.ontoindex', 'memory', 'consolidated-memory.json'), 'utf8'),
    );
    expect(persisted.trust).toMatchObject({
      evidenceClass: 'advisory_memory',
      authority: 'advisory',
      requestedAuthority: 'advisory',
      notAuditEvidence: true,
    });

    const summary = await manager.getSummary();
    expect(summary).toMatchObject({
      auditFindings: { openCount: 1, partialCount: 0 },
      trust: {
        evidenceClass: 'advisory_memory',
        authority: 'advisory',
        requestedAuthority: 'advisory',
        freshness: 'unknown',
        notAuditEvidence: true,
      },
      prMarkerCount: 1,
    });
  });

  it('downgrades advisory memory freshness when audit sessions or evidence are stale', async () => {
    const manager = new ConsolidatedMemoryManager(repoRoot);
    const mockLoad = vi.fn().mockResolvedValue({
      events: [
        {
          id: 'e-session',
          type: 'AuditIngested',
          session: {
            id: 's1',
            targetRepo: 'repo',
            targetHead: 'head-old',
            sourceHash: 'sha256:source',
            graphIndexId: 'index-old',
            verifierVersion: 'verifier-a',
            sidecarStateHash: 'sidecar-old',
            createdAt: '2026-05-17T10:00:00.000Z',
            snapshotMode: 'dirty-worktree-overlay',
            changedFiles: ['src/app.ts'],
            changedSymbols: [],
            staleWarnings: ['dirty checkout after target HEAD lock'],
            metadata: {},
          },
          occurredAt: '2026-05-17T10:00:00.000Z',
        },
        {
          id: 'e-finding',
          type: 'FindingCandidateCreated',
          finding: {
            id: 'f1',
            sessionId: 's1',
            title: 'Test Finding',
            fingerprint: 'fp1',
            status: 'OPEN',
            evidence: [
              {
                data: { path: 'src/app.ts', line: 10 },
                graphStale: true,
                staleWarnings: ['indexed head does not match target head'],
              },
            ],
            metadata: {},
          },
          occurredAt: '2026-05-17T10:00:01.000Z',
        },
      ],
    });

    (LocalAuditEventStore as any).mockImplementation(function () {
      return { load: mockLoad };
    });

    const memory = await manager.consolidate();

    expect(memory.trust).toMatchObject({
      evidenceClass: 'advisory_memory',
      authority: 'advisory',
      requestedAuthority: 'advisory',
      freshness: 'stale-index',
      notAuditEvidence: true,
    });
    expect(memory.trust.warnings).toContain(
      'Audit projection includes stale session or evidence metadata; reverify before acting.',
    );
  });

  it.each([
    {
      name: 'missing freshness signal',
      options: { mode: 'authoritative' as const },
      reason: 'missing-freshness-signal',
    },
    {
      name: 'stale freshness signal',
      options: {
        mode: 'authoritative' as const,
        authority: {
          source: 'local-freshness-signal' as const,
          freshness: {
            state: 'stale' as const,
            checkedAt: '2026-05-17T10:00:00.000Z',
            warnings: ['Target HEAD is stale.'],
          },
        },
      },
      reason: 'stale-target-context',
    },
    {
      name: 'unknown freshness signal',
      options: {
        mode: 'authoritative' as const,
        authority: {
          source: 'local-freshness-signal' as const,
          freshness: {
            state: 'unknown' as const,
            checkedAt: '2026-05-17T10:00:00.000Z',
          },
        },
      },
      reason: 'stale-target-context',
    },
  ])('denies authoritative memory when $name is supplied', async ({ options, reason }) => {
    const manager = new ConsolidatedMemoryManager(repoRoot);
    const mockLoad = vi.fn().mockResolvedValue({ events: [] });

    (LocalAuditEventStore as any).mockImplementation(function () {
      return { load: mockLoad };
    });

    await expect(manager.consolidate(options)).rejects.toMatchObject({
      name: 'AuthoritativeMemoryDeniedError',
      reason,
    } satisfies Partial<AuthoritativeMemoryDeniedError>);
    await expect(
      readFile(join(repoRoot, '.ontoindex', 'memory', 'consolidated-memory.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('allows authoritative memory when explicit fresh authority inputs are supplied', async () => {
    const manager = new ConsolidatedMemoryManager(repoRoot);
    const mockLoad = vi.fn().mockResolvedValue({
      events: [
        {
          id: 'e-session',
          type: 'AuditIngested',
          session: {
            id: 's1',
            targetRepo: 'repo',
            targetHead: 'head-fresh',
            sourceHash: 'sha256:source',
            graphIndexId: 'index-fresh',
            verifierVersion: 'verifier-a',
            sidecarStateHash: 'sidecar-fresh',
            createdAt: '2026-05-17T10:00:00.000Z',
            snapshotMode: 'committed-head',
            changedFiles: [],
            changedSymbols: [],
            staleWarnings: [],
            metadata: {},
          },
          occurredAt: '2026-05-17T10:00:00.000Z',
        },
        {
          id: 'e-finding',
          type: 'FindingCandidateCreated',
          finding: {
            id: 'f1',
            sessionId: 's1',
            title: 'Fresh Finding',
            fingerprint: 'fp1',
            status: 'OPEN',
            evidence: [
              {
                id: 'ev1',
                kind: 'code',
                targetHead: 'head-fresh',
                graphIndexId: 'index-fresh',
                verifierVersion: 'verifier-a',
                sidecarStateHash: 'sidecar-fresh',
                sourceFresh: true,
                graphStale: false,
                staleWarnings: [],
                data: { path: 'src/app.ts', line: 10 },
              },
            ],
            metadata: {},
          },
          occurredAt: '2026-05-17T10:00:01.000Z',
        },
      ],
    });

    (LocalAuditEventStore as any).mockImplementation(function () {
      return { load: mockLoad };
    });

    const memory = await manager.consolidate({
      mode: 'authoritative',
      authority: {
        source: 'explicit-fresh-target-context',
        freshness: {
          state: 'clean',
          checkedAt: '2026-05-17T10:00:02.000Z',
          warnings: [],
        },
      },
    });

    expect(memory.trust).toMatchObject({
      evidenceClass: 'authoritative_memory',
      authority: 'authoritative',
      requestedAuthority: 'authoritative',
      freshness: 'fresh',
      notAuditEvidence: false,
      authoritySource: 'explicit-fresh-target-context',
      freshnessSignal: {
        state: 'clean',
        checkedAt: '2026-05-17T10:00:02.000Z',
        warnings: [],
      },
      warnings: [],
    });

    const persisted = JSON.parse(
      await readFile(join(repoRoot, '.ontoindex', 'memory', 'consolidated-memory.json'), 'utf8'),
    );
    expect(persisted.trust).toMatchObject({
      evidenceClass: 'authoritative_memory',
      authority: 'authoritative',
      requestedAuthority: 'authoritative',
      freshness: 'fresh',
      notAuditEvidence: false,
    });
  });

  it('returns null summary when no memory exists', async () => {
    const manager = new ConsolidatedMemoryManager(repoRoot);
    const summary = await manager.getSummary();
    expect(summary).toBeNull();
  });
});
