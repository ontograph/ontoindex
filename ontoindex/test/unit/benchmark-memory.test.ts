import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mergePeakMemory,
  sampleProcessTreeMemory,
  startMemorySampling,
} from '../../scripts/benchmark-memory.mjs';

function memory(totalRssKiB = 100, overrides = {}) {
  return {
    totalRssKiB,
    rootRssKiB: 60,
    childRssKiB: 40,
    processCount: 2,
    childProcessCount: 1,
    maxChildRssKiB: 40,
    topChildProcesses: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockProc(statuses: Record<number, string | Error>) {
  vi.spyOn(fs, 'readdir').mockResolvedValue(
    Object.keys(statuses).map((name) => ({
      name,
      isDirectory: () => true,
    })) as any,
  );
  vi.spyOn(fs, 'readFile').mockImplementation(async (filename) => {
    const pid = Number(String(filename).match(/^\/proc\/(\d+)\/status$/)?.[1]);
    const status = statuses[pid];
    if (status instanceof Error) throw status;
    if (status === undefined) throw new Error(`Unexpected status read: ${filename}`);
    return status;
  });
}

function procStatus(parent: number, rss: number | null, state = 'S') {
  return (
    `Name:\tfixture\nState:\t${state} (fixture)\nPPid:\t${parent}\n` +
    (rss === null ? '' : `VmRSS:\t${rss} kB\n`)
  );
}

describe.skipIf(process.platform !== 'linux')('Linux process-tree RSS extraction', () => {
  it('sums the root and transitive descendants while excluding unrelated processes', async () => {
    mockProc({
      100: procStatus(1, 100),
      101: procStatus(100, 50),
      102: procStatus(101, 25),
      200: procStatus(1, 9999),
    });
    expect(await sampleProcessTreeMemory(100)).toEqual({
      totalRssKiB: 175,
      rootRssKiB: 100,
      childRssKiB: 75,
      processCount: 3,
      childProcessCount: 2,
      maxChildRssKiB: 50,
      topChildProcesses: [
        { pid: 101, rssKiB: 50, command: 'fixture', isRoot: false },
        { pid: 102, rssKiB: 25, command: 'fixture', isRoot: false },
      ],
    });
  });

  it('returns unavailable when the root has disappeared', async () => {
    mockProc({ 101: procStatus(100, 50) });
    expect(await sampleProcessTreeMemory(100)).toBeNull();
  });

  it('rejects missing RSS for a live root', async () => {
    mockProc({ 100: procStatus(1, null) });
    await expect(sampleProcessTreeMemory(100)).rejects.toThrow(
      /Incomplete RSS data for root process 100/,
    );
  });

  it.each(['Z', 'X'])('returns unavailable when the root is in state %s', async (state) => {
    mockProc({ 100: procStatus(1, null, state) });
    expect(await sampleProcessTreeMemory(100)).toBeNull();
  });

  it('rejects incomplete descendant RSS instead of undercounting the tree', async () => {
    mockProc({ 100: procStatus(1, 100), 101: procStatus(100, null) });
    await expect(sampleProcessTreeMemory(100)).rejects.toThrow(
      /Incomplete RSS data for process 101/,
    );
  });

  it('propagates permission errors while ignoring processes that vanish during enumeration', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mockProc({ 100: procStatus(1, 100), 101: denied });
    await expect(sampleProcessTreeMemory(100)).rejects.toBe(denied);
    vi.restoreAllMocks();
    mockProc({
      100: procStatus(1, 100),
      101: Object.assign(new Error('gone'), { code: 'ENOENT' }),
    });
    expect(await sampleProcessTreeMemory(100)).toMatchObject({ totalRssKiB: 100, processCount: 1 });
  });
});

describe('benchmark memory sampling lifecycle', () => {
  it('starts immediately, serializes slow scans, and drains the active scan on stop', async () => {
    vi.useFakeTimers();
    let resolveSample!: (value: ReturnType<typeof memory>) => void;
    const sample = vi.fn(
      () =>
        new Promise<ReturnType<typeof memory>>((resolve) => {
          resolveSample = resolve;
        }),
    );
    const sampler = startMemorySampling(123, { sampleMs: 100, sample });
    expect(typeof sampler.stop).toBe('function');
    await Promise.resolve();
    expect(sample).toHaveBeenCalledExactlyOnceWith(123);
    await vi.advanceTimersByTimeAsync(500);
    expect(sample).toHaveBeenCalledTimes(1);
    const stopped = vi.fn();
    const result = sampler.stop().then((report: unknown) => {
      stopped();
      return report;
    });
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    resolveSample(memory());
    expect(await result).toEqual({
      method: 'linux-proc-process-tree-rss',
      sampleMs: 100,
      sampleCount: 1,
      failedSamples: 0,
      peakMemory: memory(),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it('collects subsequent scans and preserves independent process-tree peaks', async () => {
    vi.useFakeTimers();
    const sample = vi
      .fn()
      .mockResolvedValueOnce(memory(100, { rootRssKiB: 90, childRssKiB: 10 }))
      .mockResolvedValue(memory(120, { rootRssKiB: 20, childRssKiB: 100, maxChildRssKiB: 100 }));
    const sampler = startMemorySampling(123, { sampleMs: 100, sample });
    await vi.advanceTimersByTimeAsync(100);
    const report = await sampler.stop();
    expect(sample).toHaveBeenCalledTimes(2);
    expect(report.sampleCount).toBe(2);
    expect(report.peakMemory).toMatchObject({ totalRssKiB: 120, rootRssKiB: 90, childRssKiB: 100 });
  });

  it('keeps absent observations unavailable and records scan failures', async () => {
    vi.useFakeTimers();
    const sample = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('proc unavailable'))
      .mockResolvedValue(null);
    const sampler = startMemorySampling(123, { sampleMs: 100, sample });
    await vi.advanceTimersByTimeAsync(100);
    expect(await sampler.stop()).toEqual({
      method: 'linux-proc-process-tree-rss',
      sampleMs: 100,
      sampleCount: 0,
      failedSamples: 1,
      peakMemory: null,
    });
  });
});

it('merges each memory component independently when aggregate RSS rises', () => {
  const first = memory(100, {
    rootRssKiB: 90,
    childRssKiB: 10,
    processCount: 5,
    childProcessCount: 4,
    maxChildRssKiB: 70,
    topChildProcesses: [{ pid: 2, rssKiB: 70, command: 'old', isRoot: false }],
  });
  const next = memory(120, {
    rootRssKiB: 20,
    childRssKiB: 100,
    maxChildRssKiB: 60,
    topChildProcesses: [{ pid: 2, rssKiB: 60, command: 'new', isRoot: false }],
  });
  expect(mergePeakMemory(first, next)).toEqual({ ...first, totalRssKiB: 120, childRssKiB: 100 });
});
