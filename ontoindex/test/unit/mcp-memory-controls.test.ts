import { afterEach, describe, expect, it, vi } from 'vitest';
import { readOnlyBufferManagerBytes } from '../../src/core/lbug/pool-adapter.js';
import {
  MIN_IDLE_EXIT_MS,
  readIdleExitMs,
  shouldExitForIdle,
  startIdleExitTimer,
} from '../../src/mcp/idle-exit.js';
import { buildProcessMemory } from '../../src/mcp/super/diagnose.js';

const MB = 1024 * 1024;

describe('ONTOINDEX_LBUG_BUFFER_POOL_MB', () => {
  it('keeps the LadybugDB default when unset, zero, or invalid', () => {
    expect(readOnlyBufferManagerBytes({})).toBe(0);
    expect(readOnlyBufferManagerBytes({ ONTOINDEX_LBUG_BUFFER_POOL_MB: '0' })).toBe(0);
    expect(readOnlyBufferManagerBytes({ ONTOINDEX_LBUG_BUFFER_POOL_MB: 'lots' })).toBe(0);
  });

  it('converts megabytes to bytes with a 16 MB floor', () => {
    expect(readOnlyBufferManagerBytes({ ONTOINDEX_LBUG_BUFFER_POOL_MB: '64' })).toBe(64 * MB);
    expect(readOnlyBufferManagerBytes({ ONTOINDEX_LBUG_BUFFER_POOL_MB: '1' })).toBe(16 * MB);
  });
});

describe('ONTOINDEX_MCP_IDLE_EXIT_MS', () => {
  afterEach(() => vi.useRealTimers());

  it('is off unless set to a positive number, and never below one minute', () => {
    expect(readIdleExitMs({})).toBeNull();
    expect(readIdleExitMs({ ONTOINDEX_MCP_IDLE_EXIT_MS: '0' })).toBeNull();
    expect(readIdleExitMs({ ONTOINDEX_MCP_IDLE_EXIT_MS: 'soon' })).toBeNull();
    expect(readIdleExitMs({ ONTOINDEX_MCP_IDLE_EXIT_MS: '1000' })).toBe(MIN_IDLE_EXIT_MS);
    expect(readIdleExitMs({ ONTOINDEX_MCP_IDLE_EXIT_MS: '600000' })).toBe(600_000);
  });

  it('exits only when idle long enough with no request in flight and no open pool', () => {
    const probe = (inFlight: number, openPools: number, lastActivity: number) => ({
      inFlight: () => inFlight,
      openPools: () => openPools,
      lastActivity: () => lastActivity,
    });
    expect(shouldExitForIdle(probe(0, 0, 0), 60_000, 60_000)).toBe(true);
    expect(shouldExitForIdle(probe(0, 0, 1), 60_000, 60_000)).toBe(false);
    expect(shouldExitForIdle(probe(1, 0, 0), 60_000, 120_000)).toBe(false);
    expect(shouldExitForIdle(probe(0, 1, 0), 60_000, 120_000)).toBe(false);
  });

  it('calls exit once after the idle period', () => {
    vi.useFakeTimers();
    let now = 0;
    const exit = vi.fn();
    startIdleExitTimer(
      { inFlight: () => 0, openPools: () => 0, lastActivity: () => 0 },
      60_000,
      exit,
      () => now,
    );
    now = 30_000;
    vi.advanceTimersByTime(30_000);
    expect(exit).not.toHaveBeenCalled();
    now = 60_000;
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(60_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('gn_diagnose processMemory', () => {
  it('splits heap from native memory and reports the memory settings', () => {
    const report = buildProcessMemory(
      { rss: 600 * MB, heapUsed: 32 * MB, heapTotal: 36 * MB, external: 2 * MB, arrayBuffers: 0 },
      { ONTOINDEX_LBUG_BUFFER_POOL_MB: '64', ONTOINDEX_MCP_IDLE_EXIT_MS: '600000' },
      0,
    );
    expect(report).toEqual({
      rssMB: 600,
      heapUsedMB: 32,
      heapTotalMB: 36,
      externalMB: 2,
      nativeMB: 564,
      openRepositoryPools: 0,
      bufferPoolMB: 64,
      idleExitMs: 600_000,
    });
  });
});
