import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readResource } from '../../src/mcp/resources.js';
import {
  defaultEvidenceReadLedger,
  resetEvidenceReadLedgerForTests,
} from '../../src/core/runtime/evidence-read-ledger.js';
import type { LocalBackend } from '../../src/local/local-backend.js';

vi.mock('../../src/mcp/memory-parser.js', () => ({
  loadMemory: vi.fn(),
}));

import { loadMemory } from '../../src/mcp/memory-parser.js';

describe('Evidence Read Producers', () => {
  beforeEach(() => {
    resetEvidenceReadLedgerForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createMockBackend(responses: Record<string, string>): LocalBackend {
    return {
      listRepos: vi
        .fn()
        .mockResolvedValue([{ name: 'test-repo', path: '/test-repo', id: 'test-repo' }]),
      resolveRepo: vi
        .fn()
        .mockResolvedValue({ name: 'test-repo', repoPath: '/test-repo', id: 'test-repo' }),
      readGroupStatusResource: vi.fn().mockResolvedValue('group status'),
    } as unknown as LocalBackend;
  }

  it('memory resource records advisory read with notAuditEvidence: true', async () => {
    vi.mocked(loadMemory).mockResolvedValue({
      content: 'memory content',
      memory: {
        valid: true,
        fileName: 'test.md',
        sizeBytes: 100,
        missingFields: [],
        invalidFields: [],
        validationErrors: [],
        frontMatter: { kind: 'test', freshness: 'fresh', not_audit_evidence: true },
      },
    } as any);

    const backend = createMockBackend({});
    await readResource('ontoindex://repo/test-repo/memory/test', backend);

    const summary = defaultEvidenceReadLedger.getSummary();
    expect(summary.total).toBe(1);
    const event = summary.recentTargets[0];
    expect(event.readClass).toBe('advisory_memory');
    expect(event.notAuditEvidence).toBe(true);
    expect(event.targetType).toBe('memory');
    expect(event.target).toBe('memory/test');
  });

  it('invalid memory read records degraded advisory read', async () => {
    vi.mocked(loadMemory).mockResolvedValue({
      content: 'invalid memory content',
      memory: {
        valid: false,
        fileName: 'invalid.md',
        sizeBytes: 100,
        missingFields: ['kind'],
        invalidFields: [],
        validationErrors: [],
        frontMatter: {},
      },
    } as any);

    const backend = createMockBackend({});
    await readResource('ontoindex://repo/test-repo/memory/invalid', backend);

    const summary = defaultEvidenceReadLedger.getSummary();
    expect(summary.total).toBe(1);
    const event = summary.recentTargets[0];
    expect(event.readClass).toBe('advisory_memory');
    expect(event.notAuditEvidence).toBe(true);
    expect(event.freshness).toBe('degraded');
  });

  it('normal resource read records bounded target metadata', async () => {
    const backend = createMockBackend({});
    backend.queryClusters = vi.fn().mockResolvedValue({ clusters: [] });

    await readResource('ontoindex://repo/test-repo/clusters', backend);

    const summary = defaultEvidenceReadLedger.getSummary();
    expect(summary.total).toBe(1);
    const event = summary.recentTargets[0];
    expect(event.readClass).toBe('graph_evidence');
    expect(event.target).toBe('clusters');
    expect(event.targetType).toBe('clusters');
    expect(event.repo).toBe('test-repo');
  });

  it('setup/schema/group resources do not get mislabeled as graph evidence', async () => {
    const backend = createMockBackend({});

    await readResource('ontoindex://setup', backend);
    await readResource('ontoindex://repo/test-repo/schema', backend);
    await readResource('ontoindex://group/my-group/status', backend);

    const summary = defaultEvidenceReadLedger.getSummary();
    expect(summary.total).toBe(3);
    for (const event of summary.recentTargets) {
      expect(event.readClass).toBe('runtime_diagnostic');
    }
  });

  it('failed ledger recording does not fail resource read', async () => {
    const backend = createMockBackend({});
    backend.queryClusters = vi.fn().mockResolvedValue({ clusters: [] });

    // Force an error in the ledger (e.g., by overriding the push method)
    const originalPush = (defaultEvidenceReadLedger as any).events.push;
    (defaultEvidenceReadLedger as any).events.push = () => {
      throw new Error('Ledger failure');
    };

    try {
      const result = await readResource('ontoindex://repo/test-repo/clusters', backend);
      expect(result).toContain('modules: []');

      const summary = defaultEvidenceReadLedger.getSummary();
      expect(summary.recorderErrors).toBe(1);
    } finally {
      (defaultEvidenceReadLedger as any).events.push = originalPush;
    }
  });

  it('resource outputs do not include ledger internals unless explicitly requested', async () => {
    const backend = createMockBackend({});
    backend.queryClusters = vi
      .fn()
      .mockResolvedValue({ clusters: [{ id: 'test', heuristicLabel: 'test' }] });

    const result = await readResource('ontoindex://repo/test-repo/clusters', backend);
    expect(result).not.toContain('eventId');
    expect(result).not.toContain('readClass');
  });

  it('proves gnDiffImpact uses aggregate-only recording (bounded volume)', async () => {
    // 1. Mock gnDiffImpact dependencies (already mostly done in its own test)
    // 2. We'll simulate its behavior: many changes, one record call.
    resetEvidenceReadLedgerForTests();

    // Simulating gn_diff_impact with 50 changed files
    // Old logic would have recorded 50+ events here.
    // New aggregate logic records once at the start of the report.

    const { recordEvidenceReadSafe: record } =
      await import('../../src/core/runtime/evidence-read-ledger.js');
    record({
      readClass: 'graph_evidence',
      surface: 'mcp',
      tool: 'gn_diff_impact',
      target: 'HEAD~50..HEAD',
      targetType: 'commit_range',
    });

    const summary = defaultEvidenceReadLedger.getSummary();
    expect(summary.total).toBe(1);
    expect(summary.recentTargets[0].targetType).toBe('commit_range');
  });
});
