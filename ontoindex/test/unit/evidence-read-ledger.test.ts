import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import {
  createEmptyEvidenceReadClassCounts,
  EVIDENCE_READ_CLASSES,
  EvidenceReadLedger,
  NON_AUTHORITATIVE_EVIDENCE_READ_CLASSES,
  recordEvidenceReadSafe,
  resetEvidenceReadLedgerForTests,
  defaultEvidenceReadLedger,
  hashSessionId,
  mapMemoryFreshness,
  sanitizeTarget,
  summarizeBasedOnReads,
} from '../../src/core/runtime/evidence-read-ledger.js';

describe('EvidenceReadLedger', () => {
  beforeEach(() => {
    resetEvidenceReadLedgerForTests();
  });

  it('exports the single ADR 0026 evidence-class vocabulary', () => {
    expect(EVIDENCE_READ_CLASSES).toEqual([
      'graph_evidence',
      'docs_evidence',
      'audit_evidence',
      'advisory_memory',
      'runtime_diagnostic',
      'unknown',
    ]);
    expect(NON_AUTHORITATIVE_EVIDENCE_READ_CLASSES).toEqual([
      'advisory_memory',
      'runtime_diagnostic',
    ]);
    expect(createEmptyEvidenceReadClassCounts()).toEqual({
      graph_evidence: 0,
      docs_evidence: 0,
      audit_evidence: 0,
      advisory_memory: 0,
      runtime_diagnostic: 0,
      unknown: 0,
    });
  });

  it('appends events and returns summaries', () => {
    const ledger = new EvidenceReadLedger();
    ledger.record({
      readClass: 'graph_evidence',
      surface: 'backend-search',
      target: 'my-target',
      targetType: 'symbol',
      repo: 'my-repo',
    });

    const summary = ledger.getSummary();
    expect(summary.total).toBe(1);
    expect(summary.byClass.graph_evidence).toBe(1);
    expect(summary.bySurface['backend-search']).toBe(1);
    expect(summary.byRepo['my-repo']).toBe(1);
    expect(summary.recentTargets.length).toBe(1);
    expect(summary.recentTargets[0].readClass).toBe('graph_evidence');
  });

  it('evicts oldest events at capacity', () => {
    const ledger = new EvidenceReadLedger(5); // Small capacity for test
    for (let i = 0; i < 7; i++) {
      ledger.record({
        readClass: 'unknown',
        surface: 'test',
        target: `target-${i}`,
        targetType: 'file',
      });
    }

    const summary = ledger.getSummary();
    expect(summary.total).toBe(5);
    expect(summary.droppedOverCap).toBe(2);
    // Should have evicted target-0 and target-1
    expect(summary.recentTargets[0].target).toBe('target-2');
    expect(summary.recentTargets[4].target).toBe('target-6');
  });

  it('supports repo filtering in summaries', () => {
    const ledger = new EvidenceReadLedger();
    ledger.record({
      readClass: 'graph_evidence',
      surface: 's1',
      target: 't1',
      targetType: 'f',
      repo: 'repo-a',
    });
    ledger.record({
      readClass: 'docs_evidence',
      surface: 's2',
      target: 't2',
      targetType: 'f',
      repo: 'repo-b',
    });

    const fullSummary = ledger.getSummary();
    expect(fullSummary.total).toBe(2);

    const repoASummary = ledger.getSummary({ repo: 'repo-a' });
    expect(repoASummary.total).toBe(1);
    expect(repoASummary.byClass.graph_evidence).toBe(1);
    expect(repoASummary.byClass.docs_evidence).toBe(0);

    const basedOnA = summarizeBasedOnReads({ ledger, repo: 'repo-a' });
    expect(basedOnA.graph_evidence).toBe(1);
    expect(basedOnA.docs_evidence).toBe(0);
  });

  it('event IDs do not include session IDs', () => {
    const ledger = new EvidenceReadLedger();
    ledger.record({
      readClass: 'docs_evidence',
      surface: 'test',
      target: 'test',
      targetType: 'test',
      sessionId: 'my-super-secret-session-id',
    });

    const event = ledger.getSummary().recentTargets[0];
    expect(event.eventId).toBeTypeOf('number');
    expect(event.sessionIdHash).not.toContain('my-super-secret-session-id');
    expect(event.sessionIdHash).toBe(hashSessionId('my-super-secret-session-id'));
  });

  it('target length is capped', () => {
    const longTarget = 'a'.repeat(300);
    const sanitized = sanitizeTarget(longTarget);
    expect(sanitized.length).toBe(256);
    expect(sanitized.endsWith('...')).toBe(true);
  });

  it('absolute paths are redacted to basename', () => {
    const absolute = path.resolve('/secret/path/to/my/file.ts');
    const sanitized = sanitizeTarget(absolute);
    expect(sanitized).toBe('[ABSOLUTE_PATH]:file.ts');
  });

  it('memory freshness maps correctly', () => {
    expect(mapMemoryFreshness('fresh')).toEqual({ freshness: 'fresh', memoryFreshness: 'fresh' });
    expect(mapMemoryFreshness('stale-index')).toEqual({
      freshness: 'stale',
      memoryFreshness: 'stale-index',
    });
    expect(mapMemoryFreshness('invalid')).toEqual({
      freshness: 'degraded',
      memoryFreshness: 'unknown',
    });
  });

  it('recordEvidenceReadSafe is fail-open (suppresses errors)', () => {
    // Spy on the record method of the default instance and make it throw
    const spy = vi.spyOn(defaultEvidenceReadLedger, 'record').mockImplementation(() => {
      throw new Error('Simulated failure');
    });

    // This should NOT throw
    expect(() => {
      recordEvidenceReadSafe({
        readClass: 'unknown',
        surface: 'test',
        target: 'test',
        targetType: 'test',
      });
    }).not.toThrow();

    expect(spy).toHaveBeenCalled();
    // We can't easily check recorderErrors on the default ledger if we mocked the implementation
    // to just throw, unless we call the original or mock it to increment.
    spy.mockRestore();
  });

  it('summaries exclude sensitive details', () => {
    const ledger = new EvidenceReadLedger();
    ledger.record({
      readClass: 'graph_evidence',
      surface: 'test',
      target: 'secret-content',
      targetType: 'test',
      isSensitive: true,
    });

    const summary = ledger.getSummary();
    expect(summary.recentTargets[0].target).toBe('[REDACTED]');

    const json = JSON.stringify(summary);
    expect(json).not.toContain('secret-content');
  });
});
