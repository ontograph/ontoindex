import { afterEach, describe, expect, it } from 'vitest';
import {
  getDefaultMaxWorkerCount,
  resolveMaxWorkerCount,
} from '../../src/core/ingestion/workers/worker-pool.js';

describe('worker pool CPU cap configuration', () => {
  const originalMaxWorkers = process.env.ONTOINDEX_MAX_WORKERS;

  afterEach(() => {
    if (originalMaxWorkers === undefined) {
      delete process.env.ONTOINDEX_MAX_WORKERS;
    } else {
      process.env.ONTOINDEX_MAX_WORKERS = originalMaxWorkers;
    }
  });

  it('defaults to 25% of logical CPUs when ONTOINDEX_MAX_WORKERS is unset', () => {
    delete process.env.ONTOINDEX_MAX_WORKERS;
    expect(getDefaultMaxWorkerCount(28)).toBe(7);
    expect(getDefaultMaxWorkerCount(16)).toBe(4);
    expect(getDefaultMaxWorkerCount(8)).toBe(2);
  });

  it('keeps at least one worker on small machines', () => {
    expect(getDefaultMaxWorkerCount(4)).toBe(1);
    expect(getDefaultMaxWorkerCount(2)).toBe(1);
    expect(getDefaultMaxWorkerCount(1)).toBe(1);
  });

  it('uses configured worker count only when it is a positive integer', () => {
    delete process.env.ONTOINDEX_MAX_WORKERS;
    expect(resolveMaxWorkerCount(28, undefined)).toBe(7);
    expect(resolveMaxWorkerCount(28, '')).toBe(7);
    expect(resolveMaxWorkerCount(28, 'not-a-number')).toBe(7);
    expect(resolveMaxWorkerCount(28, '0')).toBe(7);
    expect(resolveMaxWorkerCount(28, '-1')).toBe(7);
    expect(resolveMaxWorkerCount(28, '12')).toBe(12);
  });
});
