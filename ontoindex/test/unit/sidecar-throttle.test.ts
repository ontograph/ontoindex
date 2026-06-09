import { describe, expect, it } from 'vitest';
import {
  decideSidecarThrottle,
  SIDECAR_MAX_CPU_PERCENT,
  SIDECAR_MAX_WORKER_COUNT,
} from '../../src/core/ingestion/enrichment/index.js';

describe('sidecar CPU throttle contract', () => {
  it('keeps a 28-core host capped to one worker', () => {
    const decision = decideSidecarThrottle({
      logicalCpuCount: 28,
      observedCpuPercent: 5,
      workerCount: 2,
    });

    expect(decision).toMatchObject({
      action: 'stop',
      reason: 'worker-count-over-limit',
      maxCpuPercent: SIDECAR_MAX_CPU_PERCENT,
      maxWorkerCount: SIDECAR_MAX_WORKER_COUNT,
      logicalCpuCount: 28,
      observedCpuPercent: 5,
      workerCount: 2,
      errors: [],
    });
  });

  it('continues when one worker stays within the aggregate CPU budget', () => {
    const decision = decideSidecarThrottle({
      logicalCpuCount: 28,
      observedCpuPercent: 9.5,
      workerCount: 1,
    });

    expect(decision).toMatchObject({
      action: 'continue',
      reason: 'within-budget',
      maxCpuPercent: 10,
      maxWorkerCount: 1,
      foregroundActive: false,
      errors: [],
    });
  });

  it('throttles when observed CPU is over the 10 percent budget', () => {
    const decision = decideSidecarThrottle({
      logicalCpuCount: 28,
      observedCpuPercent: 12,
      workerCount: 1,
    });

    expect(decision).toMatchObject({
      action: 'throttle',
      reason: 'cpu-over-budget',
      errors: [],
    });
  });

  it('pauses on a small host when one busy worker exceeds 10 percent aggregate CPU', () => {
    const decision = decideSidecarThrottle({
      logicalCpuCount: 4,
      observedCpuPercent: 25,
      workerCount: 1,
    });

    expect(decision).toMatchObject({
      action: 'pause',
      reason: 'cpu-over-budget',
      maxCpuPercent: 10,
      maxWorkerCount: 1,
      logicalCpuCount: 4,
      workerCount: 1,
      errors: [],
    });
  });

  it('pauses instead of competing with active foreground work', () => {
    const decision = decideSidecarThrottle({
      logicalCpuCount: 28,
      observedCpuPercent: 4,
      workerCount: 1,
      foregroundActive: true,
    });

    expect(decision).toMatchObject({
      action: 'pause',
      reason: 'foreground-active',
      foregroundActive: true,
      errors: [],
    });
  });

  it('stops on invalid inputs with serializable validation errors', () => {
    const decision = decideSidecarThrottle({
      logicalCpuCount: 0,
      observedCpuPercent: Number.NaN,
      workerCount: -1,
    });

    expect(decision).toMatchObject({
      action: 'stop',
      reason: 'invalid-input',
      maxCpuPercent: 10,
      maxWorkerCount: 1,
      logicalCpuCount: 0,
      observedCpuPercent: null,
      workerCount: -1,
      foregroundActive: false,
    });
    expect(decision.errors).toEqual([
      'logicalCpuCount must be a finite number greater than or equal to 1',
      'observedCpuPercent must be a finite number greater than or equal to 0',
      'workerCount must be an integer greater than or equal to 0',
    ]);
  });

  it('returns JSON-roundtrippable decisions for valid input', () => {
    const decision = decideSidecarThrottle({
      logicalCpuCount: 16,
      observedCpuPercent: 7,
      workerCount: 1,
    });

    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });

  it('returns JSON-roundtrippable decisions for invalid input', () => {
    const decision = decideSidecarThrottle({
      logicalCpuCount: Number.NaN,
      observedCpuPercent: Number.POSITIVE_INFINITY,
      workerCount: Number.NaN,
    });

    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });
});
