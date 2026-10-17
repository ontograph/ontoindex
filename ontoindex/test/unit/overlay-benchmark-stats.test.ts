import { describe, expect, it } from 'vitest';
import {
  median,
  nearestRankP95,
  REQUIRED_METRICS,
  validateSample,
  summarize,
  BUDGETS,
  evaluateBudgets,
  parseProcStat,
  parseVmRssKb,
  processTreeRssBytes,
  parseGnuTime,
} from '../../scripts/overlay-benchmark-stats.mjs';

const valid = () => ({
  latencyMs: 100,
  cpuSeconds: 0.1,
  peakRssBytes: 1024,
  responseBytes: 20,
  buildCount: 0,
  cleanupMs: 10,
  exit: { code: 0, signal: null },
  childrenReaped: true,
  stderrBytes: 0,
  stderrTruncated: false,
  nativeError: false,
});
const budget = (phase = 'warm', workload = 'clean', sample = valid(), extras = {}) =>
  evaluateBudgets({ phase, workload, summary: summarize([sample]), artifactBytes: 0, ...extras });

describe('benchmark statistics', () => {
  it('averages positions 10 and 11 for twenty samples without mutating input', () => {
    const values = Array.from({ length: 20 }, (_, i) => 20 - i);
    expect(median(values)).toBe(10.5);
    expect(values[0]).toBe(20);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4])).toBe(4);
  });
  it('uses position nineteen for the nearest-rank p95 of twenty samples', () => {
    expect(nearestRankP95(Array.from({ length: 20 }, (_, i) => 20 - i))).toBe(19);
    expect(nearestRankP95([1])).toBe(1);
  });
  it.each([[], [NaN], [Infinity], [-Infinity]])(
    'rejects empty and non-finite statistics %j',
    (values) => {
      expect(() => median(values)).toThrow();
      expect(() => nearestRankP95(values)).toThrow();
    },
  );
  it('validates a complete successful sample', () =>
    expect(validateSample(valid())).toEqual({ ok: true }));
  it.each(REQUIRED_METRICS)('rejects missing, negative and non-finite %s', (metric) => {
    for (const value of [undefined, -1, NaN, Infinity, '1'])
      expect(validateSample({ ...valid(), [metric]: value }).ok).toBe(false);
  });
  it.each([
    { exit: { code: 1, signal: null } },
    { exit: { code: 0, signal: 'SIGTERM' } },
    { childrenReaped: false },
    { stderrTruncated: true },
    { stderrBytes: undefined },
    { stderrBytes: NaN },
    { stderrBytes: 16 * 1024 ** 2 + 1 },
    { nativeError: true },
  ])('rejects invalid accounting %j', (change) =>
    expect(validateSample({ ...valid(), ...change }).ok).toBe(false),
  );
  it('never throws for absent or unreadable samples', () => {
    expect(validateSample(null).ok).toBe(false);
    expect(
      validateSample(
        new Proxy(
          {},
          {
            get() {
              throw new Error('bad');
            },
          },
        ),
      ).ok,
    ).toBe(false);
  });
  it('summarizes every metric and rejects any invalid sample', () => {
    expect(summarize([valid(), { ...valid(), latencyMs: 200, buildCount: 2 }])).toEqual({
      count: 2,
      latency: { median: 150, p95: 200 },
      cpuSeconds: { median: 0.1, p95: 0.1 },
      peakRssBytes: { median: 1024, p95: 1024, max: 1024 },
      responseBytes: { median: 20, p95: 20 },
      buildCount: { min: 0, max: 2, total: 2 },
      cleanupMs: { median: 10, p95: 10, max: 10 },
    });
    expect(() => summarize([valid(), { ...valid(), nativeError: true }])).toThrow();
    expect(() => summarize([])).toThrow();
    expect(() => summarize([valid(), undefined])).toThrow();
    expect(() => summarize(new Array(1))).toThrow();
  });
});

describe('shipping budgets', () => {
  it('accepts compliant samples and exact limits', () => {
    expect(budget().pass).toBe(true);
    expect(
      budget(
        'cold',
        'dirty',
        {
          ...valid(),
          latencyMs: 55000,
          cpuSeconds: 300,
          peakRssBytes: BUDGETS.peakRssBytes,
          cleanupMs: 5000,
        },
        { artifactBytes: BUDGETS.artifactBytes },
      ).pass,
    ).toBe(true);
    expect(BUDGETS.cleanGateOverheadMs(800)).toBe(200);
    expect(BUDGETS.cleanGateOverheadMs(100)).toBe(100);
  });
  it.each([
    ['warmP95Ms', 'warm', 'dirty', { latencyMs: 1001 }, {}],
    ['dirtyColdP95Ms', 'cold', 'dirty', { latencyMs: 55001 }, {}],
    ['peakRssBytes', 'cold', 'dirty', { peakRssBytes: BUDGETS.peakRssBytes + 1 }, {}],
    ['coldCpuSeconds', 'cold', 'dirty', { cpuSeconds: 301 }, {}],
    ['warmCpuSeconds', 'warm', 'dirty', { cpuSeconds: 1.1 }, {}],
    ['artifactBytes', 'cold', 'dirty', {}, { artifactBytes: BUDGETS.artifactBytes + 1 }],
    ['cleanupMs', 'cold', 'dirty', { cleanupMs: 5001 }, {}],
    ['buildCount', 'cold', 'clean', { buildCount: 1 }, {}],
    ['buildCount', 'warm', 'dirty', { buildCount: 1 }, {}],
    ['cleanGateOverheadMs', 'cold', 'clean', { latencyMs: 1001 }, { baselineP95Ms: 800 }],
  ])('reports %s without relaxing its limit', (name, phase, workload, change, extras) => {
    const result = budget(phase, workload, { ...valid(), ...change }, extras);
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].budget).toBe(name);
    expect(result.failures[0].observed).toBeGreaterThan(result.failures[0].limit);
  });
  it('allows a faster clean baseline and cold dirty builds', () => {
    expect(budget('cold', 'clean', valid(), { baselineP95Ms: 800 }).pass).toBe(true);
    expect(budget('cold', 'dirty', { ...valid(), buildCount: 1 }).pass).toBe(true);
  });
});

describe('Linux process accounting', () => {
  it('parses stat after the last closing parenthesis', () =>
    expect(parseProcStat('123 (a) (b) S 42 0 0')).toEqual({ pid: 123, ppid: 42 }));
  it('rejects malformed proc stat', () => expect(() => parseProcStat('garbage')).toThrow());
  it('extracts VmRSS or returns null', () => {
    expect(parseVmRssKb('Name: foo\nVmRSS:  123 kB\nThreads: 1')).toBe(123);
    expect(parseVmRssKb('Name: foo')).toBeNull();
  });
  it('sums descendants once despite cycles and excludes unrelated processes', () => {
    expect(
      processTreeRssBytes(
        [
          { pid: 1, ppid: 3, rssKb: 10 },
          { pid: 2, ppid: 1, rssKb: 20 },
          { pid: 3, ppid: 2, rssKb: 30 },
          { pid: 4, ppid: 0, rssKb: 999 },
        ],
        1,
      ),
    ).toBe(60 * 1024);
  });
  it('parses terminal GNU time accounting', () =>
    expect(parseGnuTime('diagnostic\n1.25 0.75\n')).toEqual({
      userSeconds: 1.25,
      systemSeconds: 0.75,
      cpuSeconds: 2,
    }));
  it.each(['', 'diagnostic', '1', '1 2 3', '-1 2', 'NaN 2', 'Infinity 0'])(
    'rejects missing or invalid terminal CPU accounting %j',
    (text) => expect(() => parseGnuTime(text)).toThrow(),
  );
});
