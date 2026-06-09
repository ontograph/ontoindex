import { describe, it, expect, beforeEach } from 'vitest';
import { EvidenceReadLedger } from '../../src/core/runtime/evidence-read-ledger.js';

describe('Hot Producer Performance Gate', () => {
  let ledger: EvidenceReadLedger;

  beforeEach(() => {
    ledger = new EvidenceReadLedger(1000);
  });

  it('measures individual candidate recording overhead', () => {
    const candidateCount = 100;
    const start = performance.now();

    for (let i = 0; i < candidateCount; i++) {
      ledger.record({
        readClass: 'graph_evidence',
        surface: 'backend-search',
        target: `symbol:${i}`,
        targetType: 'nodeId',
        repo: 'test-repo',
      });
    }

    const end = performance.now();
    const duration = end - start;
    const summary = ledger.getSummary();

    console.log(`Individual Recording: ${candidateCount} events took ${duration.toFixed(3)}ms`);
    expect(summary.total).toBe(candidateCount);
    // Assertion: 100 events should take less than 2ms (safety budget)
    expect(duration).toBeLessThan(2.0);
  });

  it('measures aggregate recording overhead', () => {
    const candidateCount = 100;
    const start = performance.now();

    ledger.record({
      readClass: 'graph_evidence',
      surface: 'backend-search',
      target: `batch:100 symbols`,
      targetType: 'search_query',
      repo: 'test-repo',
    });

    const end = performance.now();
    const duration = end - start;
    const summary = ledger.getSummary();

    console.log(`Aggregate Recording: 1 event (100 candidates) took ${duration.toFixed(3)}ms`);
    expect(summary.total).toBe(1);
    // Assertion: Aggregate recording should be negligible (< 0.2ms)
    expect(duration).toBeLessThan(0.2);
  });
  it('checks memory growth for large batches', () => {
    const batchCount = 100;
    const candidatesPerBatch = 50;

    const start = performance.now();
    for (let i = 0; i < batchCount; i++) {
      for (let j = 0; j < candidatesPerBatch; j++) {
        ledger.record({
          readClass: 'graph_evidence',
          surface: 'backend-search',
          target: `repo/path/to/some/file/with/long/name/and/more/text/to/test/memory/${i}/${j}`,
          targetType: 'nodeId',
        });
      }
    }
    const end = performance.now();
    const duration = end - start;
    const summary = ledger.getSummary();

    console.log(
      `Large Load: ${batchCount * candidatesPerBatch} events took ${duration.toFixed(3)}ms`,
    );
    console.log(`Dropped over cap: ${summary.droppedOverCap}`);
    expect(summary.total).toBe(1000); // capped
  });
});
