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
  parseCgroupCpuStat,
  cgroupCpuDelta,
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
const cpuEvidence = (cpuSeconds = 0.1) => ({
  cpuSeconds,
  before: { userUsec: 10_000_000, systemUsec: 20_000_000 },
  after: { userUsec: 10_000_000 + Math.round((cpuSeconds * 1e6) / 2), systemUsec: 20_000_000 },
  final: { userUsec: 10_000_000 + Math.round(cpuSeconds * 1e6), systemUsec: 20_000_000 },
});
const budget = (phase = 'warm', workload = 'clean', sample = valid(), extras = {}) =>
  evaluateBudgets({
    phase,
    workload,
    summary: summarize([sample]),
    artifactBytes: 0,
    cpuSources: ['terminal-interval'],
    cpuEvidence: [cpuEvidence(sample.cpuSeconds)],
    ...extras,
  });

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
  it.each(
    [
      undefined,
      [],
      ['terminal-interval'],
      ['terminal-interval', 'sampled'],
      ['sampled', 'sampled'],
      ['gnu-time', 'gnu-time'],
      new Array(2),
      'terminal-interval',
    ].map((cpuSources) => ({ cpuSources })),
  )(
    'rejects warm CPU provenance $cpuSources despite compliant numeric metrics',
    ({ cpuSources }) => {
      const summary = summarize([valid(), valid()]);
      const result = evaluateBudgets({
        phase: 'warm',
        workload: 'clean',
        summary,
        artifactBytes: 0,
        cpuSources,
        cpuEvidence: [cpuEvidence(), cpuEvidence()],
      });
      expect(result).toEqual({
        pass: false,
        failures: [
          {
            budget: 'warmCpuAccounting',
            limit: 'terminal-interval accounting for every warm sample',
            observed: { sampleCount: 2, cpuSources: cpuSources ?? null },
          },
        ],
      });
    },
  );
  it('rejects absent provenance and empty warm summaries', () => {
    const summary = summarize([valid()]);
    expect(
      evaluateBudgets({ phase: 'warm', workload: 'clean', summary, artifactBytes: 0 }).failures.map(
        (failure) => failure.budget,
      ),
    ).toEqual(['warmCpuAccounting']);
    expect(
      budget('warm', 'clean', valid(), {
        summary: { ...summary, count: 0 },
        cpuSources: [],
      }).failures.map((failure) => failure.budget),
    ).toEqual(['warmCpuAccounting']);
  });
  it('accepts complete interval provenance while retaining the numeric warm CPU limit', () => {
    expect(budget().pass).toBe(true);
    expect(budget('warm', 'clean', { ...valid(), cpuSeconds: 1 }).pass).toBe(true);
    expect(budget('warm', 'clean', { ...valid(), cpuSeconds: 1.1 })).toEqual({
      pass: false,
      failures: [{ budget: 'warmCpuSeconds', limit: 1, observed: 1.1 }],
    });
    expect(
      budget('warm', 'clean', valid(), {
        summary: summarize([valid(), valid()]),
        cpuSources: ['terminal-interval', 'terminal-interval'],
        cpuEvidence: [cpuEvidence(), cpuEvidence()],
      }).pass,
    ).toBe(true);
  });
  it.each(
    [
      undefined,
      [],
      new Array(1),
      [cpuEvidence(), cpuEvidence()],
      [{ ...cpuEvidence(), after: undefined }],
      [{ ...cpuEvidence(), final: undefined }],
      [{ ...cpuEvidence(), cpuSeconds: 0.2 }],
      [{ ...cpuEvidence(), cpuSeconds: undefined }],
    ].map((evidence) => ({ evidence })),
  )(
    'rejects absent, incomplete or inconsistent CPU evidence $evidence despite terminal labels',
    ({ evidence }) => {
      expect(budget('warm', 'clean', valid(), { cpuEvidence: evidence })).toEqual({
        pass: false,
        failures: [
          {
            budget: 'warmCpuAccounting',
            limit: 'terminal-interval accounting for every warm sample',
            observed: { sampleCount: 1, cpuSources: ['terminal-interval'] },
          },
        ],
      });
    },
  );
  it.each(['before', 'after', 'final'] as const)(
    'rejects invalid %s counter components',
    (snapshot) => {
      for (const component of ['userUsec', 'systemUsec'] as const) {
        for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
          const evidence = cpuEvidence();
          evidence[snapshot][component] = value;
          expect(
            budget('warm', 'clean', valid(), { cpuEvidence: [evidence] }).failures.map(
              (failure) => failure.budget,
            ),
          ).toEqual(['warmCpuAccounting']);
        }
      }
    },
  );
  it.each([
    ['after', 'before', 'userUsec'],
    ['after', 'before', 'systemUsec'],
    ['final', 'after', 'userUsec'],
    ['final', 'after', 'systemUsec'],
  ] as const)(
    'rejects %s regressing from %s in %s despite increasing total CPU',
    (later, earlier, component) => {
      const evidence = cpuEvidence();
      evidence[later][component] = evidence[earlier][component] - 1;
      const other = component === 'userUsec' ? 'systemUsec' : 'userUsec';
      evidence[later][other] = evidence[earlier][other] + 1_000_000;
      expect(
        budget('warm', 'clean', valid(), { cpuEvidence: [evidence] }).failures.map(
          (failure) => failure.budget,
        ),
      ).toEqual(['warmCpuAccounting']);
    },
  );
  it('charges CPU through the final empty-scope snapshot', () => {
    expect(budget('warm', 'clean', { ...valid(), cpuSeconds: 1 }).pass).toBe(true);
    const evidence = cpuEvidence();
    const cpuSeconds = cgroupCpuDelta(evidence.before, evidence.after).cpuSeconds;
    expect(
      budget(
        'warm',
        'clean',
        { ...valid(), cpuSeconds },
        {
          cpuEvidence: [{ ...evidence, cpuSeconds }],
        },
      ),
    ).toEqual({
      pass: false,
      failures: [
        {
          budget: 'warmCpuAccounting',
          limit: 'terminal-interval accounting for every warm sample',
          observed: { sampleCount: 1, cpuSources: ['terminal-interval'] },
        },
      ],
    });
  });
  it('requires the CPU p95 to agree with the evidence for every sample', () => {
    const samples = [valid(), { ...valid(), cpuSeconds: 0.4 }];
    const extras = {
      summary: summarize(samples),
      cpuSources: ['terminal-interval', 'terminal-interval'],
      cpuEvidence: samples.map((sample) => cpuEvidence(sample.cpuSeconds)),
    };
    expect(budget('warm', 'clean', valid(), extras).pass).toBe(true);
    expect(
      budget('warm', 'clean', valid(), {
        ...extras,
        summary: { ...extras.summary, cpuSeconds: { median: 0.25, p95: 0.1 } },
      }).failures.map((failure) => failure.budget),
    ).toEqual(['warmCpuAccounting']);
  });
  it('allows only floating-point tolerance when matching interval CPU', () => {
    expect(
      budget('warm', 'clean', valid(), {
        cpuEvidence: [{ ...cpuEvidence(), cpuSeconds: 0.1 + 5e-10 }],
      }).pass,
    ).toBe(true);
    expect(
      budget('warm', 'clean', valid(), {
        cpuEvidence: [{ ...cpuEvidence(), cpuSeconds: 0.1 + 2e-9 }],
      }).failures.map((failure) => failure.budget),
    ).toEqual(['warmCpuAccounting']);
  });
  it.each([undefined, [], ['sampled'], ['gnu-time']].map((cpuSources) => ({ cpuSources })))(
    'leaves cold budgets unchanged for CPU provenance $cpuSources',
    ({ cpuSources }) =>
      expect(budget('cold', 'dirty', valid(), { cpuSources, cpuEvidence: undefined }).pass).toBe(
        true,
      ),
  );
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
  it('parses cgroup CPU counters while accepting unknown keys and whitespace', () => {
    expect(
      parseCgroupCpuStat(
        'usage_usec 9999999\n\tsystem_usec\t750000\nuser_usec 1250000\nfuture_counter 7\n',
      ),
    ).toEqual({ userUsec: 1250000, systemUsec: 750000 });
    expect(parseCgroupCpuStat('user_usec 0\nsystem_usec 0')).toEqual({
      userUsec: 0,
      systemUsec: 0,
    });
    expect(parseCgroupCpuStat(`user_usec ${Number.MAX_SAFE_INTEGER}\nsystem_usec 0`)).toEqual({
      userUsec: Number.MAX_SAFE_INTEGER,
      systemUsec: 0,
    });
  });
  it.each([
    '',
    'usage_usec 10',
    'user_usec 1',
    'system_usec 1',
    'user_usec 1\nuser_usec 2\nsystem_usec 3',
    'user_usec 1\nsystem_usec 2\nsystem_usec 3',
    'user_usec\nsystem_usec 1',
    'user_usec 1 2\nsystem_usec 1',
    ...['-1', '0.5', 'NaN', 'Infinity', '-Infinity', '9007199254740992'].flatMap((value) => [
      `user_usec ${value}\nsystem_usec 1`,
      `user_usec 1\nsystem_usec ${value}`,
    ]),
  ])('rejects missing, duplicate or invalid cgroup CPU counters %j', (text) => {
    expect(() => parseCgroupCpuStat(text)).toThrow();
  });
  it('excludes the baseline and converts each interval counter from microseconds', () => {
    expect(
      cgroupCpuDelta(
        parseCgroupCpuStat('user_usec 10000000\nsystem_usec 20000000'),
        parseCgroupCpuStat('user_usec 11250000\nsystem_usec 20750000'),
      ),
    ).toEqual({ userSeconds: 1.25, systemSeconds: 0.75, cpuSeconds: 2 });
  });
  it.each([
    [
      { userUsec: 0, systemUsec: 0 },
      { userUsec: 0, systemUsec: 0 },
    ],
    [
      { userUsec: 100, systemUsec: 200 },
      { userUsec: 100, systemUsec: 200 },
    ],
  ])('accepts an unchanged cgroup CPU interval %j to %j', (before, after) => {
    expect(cgroupCpuDelta(before, after)).toEqual({
      userSeconds: 0,
      systemSeconds: 0,
      cpuSeconds: 0,
    });
  });
  it.each([
    [
      { userUsec: 100, systemUsec: 200 },
      { userUsec: 99, systemUsec: 1000 },
    ],
    [
      { userUsec: 100, systemUsec: 200 },
      { userUsec: 1000, systemUsec: 199 },
    ],
  ])(
    'rejects either counter regressing even when the total increases %j to %j',
    (before, after) => {
      expect(() => cgroupCpuDelta(before, after)).toThrow();
    },
  );
  it.each([
    null,
    undefined,
    {},
    { userUsec: 0 },
    { systemUsec: 0 },
    ...[-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].flatMap((value) => [
      { userUsec: value, systemUsec: 0 },
      { userUsec: 0, systemUsec: value },
    ]),
  ])('rejects invalid direct cgroup snapshots in either position %j', (snapshot) => {
    const zero = { userUsec: 0, systemUsec: 0 };
    expect(() => cgroupCpuDelta(snapshot, zero)).toThrow();
    expect(() => cgroupCpuDelta(zero, snapshot)).toThrow();
  });
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
