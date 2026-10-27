import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../scripts/large-codebase-benchmark.mjs';
import {
  canonicalGraphValue,
  evaluateWorkspacePair,
  runWorkspacePairBenchmark,
} from '../../scripts/workspace-pair-benchmark.mjs';

function validLegs(): any[] {
  return ['full', 'capture', 'replay'].map((kind) => ({
    kind,
    elapsedMs: 10,
    base: {
      capability: 'workspace-graph',
      coverage: 'complete',
      parseErrorCount: 0,
      buildTimings: { parseMode: kind === 'replay' ? 'retained-replay' : 'full' },
      manifestDigest: 'a'.repeat(64),
      parserIdentity: 'b'.repeat(64),
      configurationDigest: 'd'.repeat(64),
      head: 'c'.repeat(40),
      baseGenerationId: 'committed-generation',
    },
    graph: {
      nodes: ['Function:src/main.ts:entry', 'Function:src/util.ts:helper'],
      edges: [
        JSON.stringify(['Function:src/main.ts:entry', 'Function:src/util.ts:helper', 'CALLS']),
      ],
    },
    candidateComplete: kind !== 'full',
  }));
}

function publishedSnapshot(generation = 'generation-3', base = validLegs()[2].base): any {
  return {
    usable: true,
    capability: 'workspace-graph',
    coverage: 'complete',
    generation,
    manifestDigest: base.manifestDigest,
    baseGenerationId: base.baseGenerationId,
    currentHead: base.head,
    parseErrorPaths: new Set(),
    uncoveredPaths: new Set(),
  };
}

function memoryReport(totalRssKiB = 1024): any {
  return {
    method: 'linux-proc-process-tree-rss',
    sampleMs: 100,
    sampleCount: 1,
    failedSamples: 0,
    peakMemory: {
      totalRssKiB,
      rootRssKiB: totalRssKiB,
      childRssKiB: 0,
      processCount: 1,
      childProcessCount: 0,
      maxChildRssKiB: 0,
      topChildProcesses: [],
    },
  };
}

async function publishedFixture(root: string) {
  const repo = path.join(root, 'repo');
  const storagePath = path.join(repo, '.ontoindex');
  const current = path.join(storagePath, 'overlay', 'CURRENT');
  await fs.mkdir(repo);
  let builds = 0;
  let locked = false;
  const release = vi.fn(async () => {
    locked = false;
  });
  const evictOverlayState = vi.fn();
  const getOverlaySnapshot = vi.fn(async () => {
    expect(locked).toBe(true);
    expect(evictOverlayState).toHaveBeenCalled();
    expect(await fs.readFile(current, 'utf8')).toBe('generation-3');
    return publishedSnapshot();
  });
  const superviseWorkspaceBuild = vi.fn(async (options: any) => {
    options.onSpawn(1234);
    const leg = validLegs()[builds % 3];
    const name = `generation-${++builds}`;
    const directory = path.join(storagePath, 'overlay', name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'base.json'), JSON.stringify(leg.base));
    await fs.writeFile(current, name);
  });
  return {
    current,
    release,
    opts: {
      repo,
      cli: 'built',
      pairs: 2,
      timeoutMs: 1000,
      outputDir: path.join(root, 'reports'),
      runId: 'published',
      dryRun: false,
    },
    deps: {
      startMemorySampling: vi.fn(() => ({ stop: vi.fn(async () => memoryReport()) })),
      acquireAnalyzeLock: async () => {
        locked = true;
        return { release };
      },
      getStoragePaths: () => ({ storagePath }),
      superviseWorkspaceBuild,
      verifyScopeRetentionCandidate: async () => ({
        coverage: { complete: true },
        retention: {
          inputEvidence: { complete: true, parserCodeIdentity: 'b'.repeat(64) },
          graphNodesCaptured: true,
          graphRelationshipsCaptured: true,
        },
      }),
      readGraph: async () => validLegs()[0].graph,
      evictOverlayState,
      getOverlaySnapshot,
    },
  };
}

describe('published generation validation', () => {
  it('validates the evicted production snapshot under the lock without starting another child', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-published-'));
    const previousExitCode = process.exitCode;
    try {
      const fixture = await publishedFixture(root);
      const record = await runWorkspacePairBenchmark({ ...fixture.opts, pairs: 1 }, fixture.deps);
      expect(record.outcome).toEqual({ result: 'passed', exitCode: 0 });
      expect(fixture.deps.superviseWorkspaceBuild).toHaveBeenCalledTimes(3);
      expect(fixture.deps.getOverlaySnapshot).toHaveBeenCalledTimes(1);
      expect(fixture.release).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(fixture.current, 'utf8')).toBe('generation-3');
      expect(record.pairs[0].reuse).toMatchObject({
        method: 'getOverlaySnapshot',
        generation: 'generation-3',
        manifestDigest: 'a'.repeat(64),
        baseGenerationId: 'committed-generation',
        currentHead: 'c'.repeat(40),
      });
      const elapsedMs = record.pairs[0].reuse.elapsedMs;
      expect(Number.isFinite(elapsedMs)).toBe(true);
      expect(elapsedMs).toBeGreaterThanOrEqual(0);
      expect(record.summary.publishedValidationMs).toEqual({
        median: elapsedMs,
        min: elapsedMs,
        max: elapsedMs,
      });
      const persisted = JSON.parse(await fs.readFile(record.artifacts.jsonPath, 'utf8'));
      expect(persisted.pairs[0].reuse).toEqual(record.pairs[0].reuse);
      expect(persisted.summary.publishedValidationMs).toEqual(record.summary.publishedValidationMs);
      expect(await fs.readFile(record.artifacts.markdownPath, 'utf8')).toMatch(
        /published.*validation/i,
      );
    } finally {
      process.exitCode = previousExitCode;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['unusable', { usable: false }],
    ['partial coverage', { coverage: 'partial' }],
    ['wrong capability', { capability: 'symbols' }],
    ['missing capability', { capability: undefined }],
    ['missing generation', { generation: undefined }],
    ['different generation', { generation: 'another-generation' }],
    ['missing manifest', { manifestDigest: undefined }],
    ['different manifest', { manifestDigest: 'e'.repeat(64) }],
    ['missing committed base', { baseGenerationId: undefined }],
    ['different committed base', { baseGenerationId: 'another-base' }],
    ['missing HEAD', { currentHead: undefined }],
    ['different HEAD', { currentHead: 'e'.repeat(40) }],
    ['parse errors', { parseErrorPaths: new Set(['src/broken.ts']) }],
    ['uncovered paths', { uncoveredPaths: new Set(['src/missing.ts']) }],
  ])('rejects %s and stops before another pair', async (_label, patch) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-published-reject-'));
    const previousExitCode = process.exitCode;
    try {
      const fixture = await publishedFixture(root);
      fixture.deps.getOverlaySnapshot.mockResolvedValue({ ...publishedSnapshot(), ...patch });
      const record = await runWorkspacePairBenchmark(fixture.opts, fixture.deps);
      expect(record.outcome).toEqual({ result: 'failed', exitCode: 1 });
      expect(fixture.deps.superviseWorkspaceBuild).toHaveBeenCalledTimes(3);
      expect(fixture.release).toHaveBeenCalledTimes(1);
      expect(record.pairs).toHaveLength(1);
      expect(record.pairs[0].evaluation.passed).toBe(false);
      expect(record.summary.publishedValidationMs).toBeNull();
      expect(JSON.parse(await fs.readFile(record.artifacts.jsonPath, 'utf8')).outcome).toEqual(
        record.outcome,
      );
    } finally {
      process.exitCode = previousExitCode;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(['pointer changes', 'probe throws'])(
    'persists failure when %s and releases the lock',
    async (mode) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-published-failure-'));
      const previousExitCode = process.exitCode;
      try {
        const fixture = await publishedFixture(root);
        fixture.deps.getOverlaySnapshot.mockImplementation(async () => {
          if (mode === 'probe throws') throw new Error('production probe failed');
          await fs.writeFile(fixture.current, 'replacement-generation');
          return publishedSnapshot();
        });
        const record = await runWorkspacePairBenchmark(fixture.opts, fixture.deps);
        expect(record.outcome).toEqual({ result: 'failed', exitCode: 1 });
        expect(record.error).toMatch(
          mode === 'probe throws' ? /production probe failed/ : /generation|CURRENT|pointer/i,
        );
        expect(fixture.release).toHaveBeenCalledTimes(1);
        expect(fixture.deps.superviseWorkspaceBuild).toHaveBeenCalledTimes(3);
        expect(record.pairs).toHaveLength(1);
        expect(JSON.parse(await fs.readFile(record.artifacts.jsonPath, 'utf8')).outcome).toEqual(
          record.outcome,
        );
      } finally {
        process.exitCode = previousExitCode;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('workspace pair evidence gates', () => {
  it('accepts full/full/replay only when identity and graph content agree', () => {
    expect(evaluateWorkspacePair(validLegs())).toEqual({ passed: true, failures: [] });
  });

  it('compares graph content independently of node and relationship order', () => {
    const legs = validLegs();
    for (const leg of legs) leg.graph.edges.push(JSON.stringify(['a', 'b', 'IMPORTS']));
    legs[2].graph.nodes.reverse();
    legs[2].graph.edges.reverse();
    expect(evaluateWorkspacePair(legs)).toEqual({ passed: true, failures: [] });
  });

  it.each([
    [
      'missing parse mode',
      (legs: any[]) => {
        delete legs[2].base.buildTimings.parseMode;
      },
    ],
    [
      'unknown parse mode',
      (legs: any[]) => {
        legs[2].base.buildTimings.parseMode = 'cached';
      },
    ],
    [
      'capture accidentally replays',
      (legs: any[]) => {
        legs[1].base.buildTimings.parseMode = 'retained-replay';
      },
    ],
    [
      'replay silently falls back',
      (legs: any[]) => {
        legs[2].base.buildTimings.parseMode = 'full';
      },
    ],
    [
      'incomplete coverage',
      (legs: any[]) => {
        legs[1].base.coverage = 'partial';
      },
    ],
    [
      'parse errors',
      (legs: any[]) => {
        legs[0].base.parseErrorCount = 1;
      },
    ],
    [
      'missing error evidence',
      (legs: any[]) => {
        delete legs[2].base.parseErrorCount;
      },
    ],
    [
      'wrong capability',
      (legs: any[]) => {
        legs[2].base.capability = 'committed';
      },
    ],
    [
      'incomplete capture',
      (legs: any[]) => {
        legs[1].candidateComplete = false;
      },
    ],
    [
      'incomplete replay candidate',
      (legs: any[]) => {
        legs[2].candidateComplete = false;
      },
    ],
    [
      'different manifest',
      (legs: any[]) => {
        legs[2].base.manifestDigest = 'd'.repeat(64);
      },
    ],
    [
      'different parser',
      (legs: any[]) => {
        legs[2].base.parserIdentity = 'd'.repeat(64);
      },
    ],
    [
      'different configuration',
      (legs: any[]) => {
        legs[2].base.configurationDigest = 'e'.repeat(64);
      },
    ],
    [
      'missing configuration',
      (legs: any[]) => {
        for (const leg of legs) delete leg.base.configurationDigest;
      },
    ],
    [
      'different commit',
      (legs: any[]) => {
        legs[1].base.head = 'd'.repeat(40);
      },
    ],
    [
      'different committed generation',
      (legs: any[]) => {
        legs[2].base.baseGenerationId = 'other';
      },
    ],
    [
      'missing identity in every leg',
      (legs: any[]) => {
        for (const leg of legs) delete leg.base.parserIdentity;
      },
    ],
    [
      'empty graph',
      (legs: any[]) => {
        legs[1].graph.nodes = [];
      },
    ],
    [
      'unavailable elapsed time',
      (legs: any[]) => {
        legs[1].elapsedMs = NaN;
      },
    ],
    [
      'equal node counts with different IDs',
      (legs: any[]) => {
        legs[2].graph.nodes[0] = 'Function:src/other.ts:entry';
      },
    ],
    [
      'equal edge counts with different tuples',
      (legs: any[]) => {
        legs[2].graph.edges[0] = JSON.stringify(['x', 'y', 'CALLS']);
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const legs = validLegs();
    mutate(legs);
    const result = evaluateWorkspacePair(legs);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it('rejects a missing leg', () => {
    expect(evaluateWorkspacePair(validLegs().slice(0, 2)).passed).toBe(false);
  });
});

describe('workspace graph canonical values', () => {
  it('ignores object key order at every depth while retaining nested semantic metadata keys', () => {
    expect(
      canonicalGraphValue({
        content: { _id: 'semantic', range: { start: 1, end: 2 } },
        id: 'entry',
      }),
    ).toBe(
      canonicalGraphValue({
        id: 'entry',
        content: { range: { end: 2, start: 1 }, _id: 'semantic' },
      }),
    );
    expect(canonicalGraphValue({ content: { _id: 'semantic' } })).not.toBe(
      canonicalGraphValue({ content: { _id: 'changed' } }),
    );
  });

  it('preserves array order and multiplicity', () => {
    expect(canonicalGraphValue(['a', 'b'])).not.toBe(canonicalGraphValue(['b', 'a']));
    expect(canonicalGraphValue(['a', 'a'])).not.toBe(canonicalGraphValue(['a']));
  });

  it('represents bigint losslessly and distinguishes it from strings, numbers, and objects', () => {
    const value = 9007199254740993n;
    const representations = [
      value,
      value - 1n,
      String(value),
      Number(value),
      { $bigint: String(value) },
    ].map((item) => canonicalGraphValue({ value: item }));
    expect(new Set(representations).size).toBe(representations.length);
    expect(canonicalGraphValue({ value })).toBe(canonicalGraphValue({ value: 9007199254740993n }));
  });

  it('retains duplicate nodes and relationships in graph parity', () => {
    for (const collection of ['nodes', 'edges']) {
      const legs = validLegs();
      legs[2].graph[collection].push(legs[2].graph[collection][0]);
      expect(evaluateWorkspacePair(legs).failures).toContain('replay graph parity mismatch');
    }
  });
});

describe('workspace pair CLI options', () => {
  it('defaults to one pair', () => {
    expect(parseArgs(['--mode', 'workspace-pair', '--cli', 'built']).pairs).toBe(1);
  });

  it.each([1, 2, 3, 4, 5])('accepts %i pair(s)', (pairs) => {
    expect(
      parseArgs(['--mode', 'workspace-pair', '--cli', 'built', '--pairs', String(pairs)]).pairs,
    ).toBe(pairs);
  });

  it.each(['0', '-1', '6', '1.5', 'NaN', 'Infinity', ''])(
    'rejects invalid pair count %j',
    (pairs) => {
      expect(() =>
        parseArgs(['--mode', 'workspace-pair', '--cli', 'built', '--pairs', pairs]),
      ).toThrow();
    },
  );

  it('rejects an omitted pair count', () => {
    expect(() => parseArgs(['--mode', 'workspace-pair', '--cli', 'built', '--pairs'])).toThrow();
  });

  it('requires the compiled CLI', () => {
    expect(() => parseArgs(['--mode', 'workspace-pair', '--cli', 'source'])).toThrow();
  });

  it('rejects pair counts for another mode', () => {
    expect(() => parseArgs(['--mode', 'analyze', '--pairs', '2'])).toThrow();
  });

  it('accepts an RSS ceiling and sampling interval', () => {
    expect(
      parseArgs([
        '--mode',
        'workspace-pair',
        '--cli',
        'built',
        '--max-peak-rss-mib',
        '512',
        '--sample-ms',
        '100',
      ]),
    ).toMatchObject({ maxPeakRssMib: 512, sampleMs: 100 });
  });
});

describe('workspace pair sampled memory', () => {
  it('samples exactly once per spawned leg and persists the full sampler report', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-pair-rss-'));
    const previousExitCode = process.exitCode;
    try {
      const fixture = await publishedFixture(root);
      const report = memoryReport();
      const stop = vi.fn(async () => report);
      fixture.deps.startMemorySampling.mockReturnValue({ stop });
      const record = await runWorkspacePairBenchmark(
        { ...fixture.opts, pairs: 1, sampleMs: 100, maxPeakRssMib: 1 },
        fixture.deps,
      );
      expect(record.outcome).toEqual({ result: 'passed', exitCode: 0 });
      expect(fixture.deps.startMemorySampling).toHaveBeenCalledTimes(3);
      for (const [pid, options] of fixture.deps.startMemorySampling.mock.calls as any[]) {
        expect(pid).toBe(1234);
        expect(options).toMatchObject({ sampleMs: 100 });
      }
      expect(stop).toHaveBeenCalledTimes(3);
      expect(record.pairs[0].legs.map((leg: any) => leg.memory)).toEqual([report, report, report]);
      const persisted = JSON.parse(await fs.readFile(record.artifacts.jsonPath, 'utf8'));
      expect(persisted.pairs[0].legs.map((leg: any) => leg.memory)).toEqual([
        report,
        report,
        report,
      ]);
    } finally {
      process.exitCode = previousExitCode;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['over ceiling', memoryReport(2048)],
    ['unavailable', { ...memoryReport(), sampleCount: 0, peakMemory: null }],
    ['failed scan', { ...memoryReport(), failedSamples: 1 }],
  ])('fails closed and preserves evidence when sampled RSS is %s', async (_label, report) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-pair-rss-failed-'));
    const previousExitCode = process.exitCode;
    try {
      const fixture = await publishedFixture(root);
      const stop = vi.fn(async () => report);
      fixture.deps.startMemorySampling.mockReturnValue({ stop });
      const record = await runWorkspacePairBenchmark(
        { ...fixture.opts, maxPeakRssMib: 1, sampleMs: 100 },
        fixture.deps,
      );
      expect(record.outcome).toEqual({ result: 'failed', exitCode: 1 });
      expect(record.pairs).toHaveLength(1);
      expect(fixture.release).toHaveBeenCalledTimes(1);
      expect(fixture.deps.superviseWorkspaceBuild).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(record.pairs[0].failedLeg).toMatchObject({ kind: 'full', memory: report });
      const persisted = JSON.parse(await fs.readFile(record.artifacts.jsonPath, 'utf8'));
      expect(persisted.outcome).toEqual(record.outcome);
      expect(persisted.pairs[0].failedLeg.memory).toEqual(report);
    } finally {
      process.exitCode = previousExitCode;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([0, -1, NaN, Infinity])(
    'rejects an invalid direct RSS ceiling %s',
    async (maxPeakRssMib) => {
      await expect(
        runWorkspacePairBenchmark({ cli: 'built', maxPeakRssMib, runId: 'invalid' }),
      ).rejects.toThrow();
    },
  );

  it.each([99, 100.5, 60001, NaN, Infinity])(
    'rejects an invalid direct sampling interval %s',
    async (sampleMs) => {
      await expect(
        runWorkspacePairBenchmark({ cli: 'built', sampleMs, runId: 'invalid' }),
      ).rejects.toThrow();
    },
  );
});

it('persists a failed child result, releases its lock, and never starts a subsequent leg', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-pair-failure-'));
  const previousExitCode = process.exitCode;
  const release = vi.fn(async () => {});
  const stop = vi.fn(async () => memoryReport());
  const superviseWorkspaceBuild = vi.fn(async (options: any) => {
    options.onSpawn(1234);
    throw new Error('fixture child failed');
  });
  try {
    await fs.mkdir(path.join(root, 'repo'));
    const record = await runWorkspacePairBenchmark(
      {
        repo: path.join(root, 'repo'),
        cli: 'built',
        pairs: 2,
        timeoutMs: 1000,
        maxPeakRssMib: null,
        outputDir: path.join(root, 'reports'),
        runId: 'failure',
        label: 'failure-fixture',
        dryRun: false,
      },
      {
        acquireAnalyzeLock: vi.fn(async () => ({ release })),
        getStoragePaths: () => ({ storagePath: path.join(root, '.ontoindex') }),
        superviseWorkspaceBuild,
        startMemorySampling: vi.fn(() => ({ stop })),
        verifyScopeRetentionCandidate: vi.fn(),
        readGraph: vi.fn(),
      },
    );
    expect(superviseWorkspaceBuild).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(record.outcome).toMatchObject({ result: 'failed', exitCode: 1 });
    expect(record.pairs[0].legs).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(record.pairs[0].failedLeg.memory).toEqual(memoryReport());
    const persisted = JSON.parse(await fs.readFile(record.artifacts.jsonPath, 'utf8'));
    expect(persisted.outcome).toEqual(record.outcome);
    expect(JSON.stringify(persisted)).toContain('fixture child failed');
    expect(await fs.readFile(record.artifacts.markdownPath, 'utf8')).toContain(
      'fixture child failed',
    );
  } finally {
    process.exitCode = previousExitCode;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('does not acquire a lock, start children, or create report paths during dry run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-pair-dry-'));
  const acquireAnalyzeLock = vi.fn();
  const superviseWorkspaceBuild = vi.fn();
  const getOverlaySnapshot = vi.fn();
  const evictOverlayState = vi.fn();
  try {
    const record = await runWorkspacePairBenchmark(
      {
        repo: root,
        cli: 'built',
        pairs: 1,
        outputDir: path.join(root, 'absent'),
        runId: 'dry',
        dryRun: true,
      },
      { acquireAnalyzeLock, superviseWorkspaceBuild, getOverlaySnapshot, evictOverlayState },
    );
    expect(record.outcome.result).toBe('not-run');
    expect(acquireAnalyzeLock).not.toHaveBeenCalled();
    expect(superviseWorkspaceBuild).not.toHaveBeenCalled();
    expect(getOverlaySnapshot).not.toHaveBeenCalled();
    expect(evictOverlayState).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each(['json', 'md'])(
  'preserves an existing %s artifact and refuses to start children',
  async (extension) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-pair-collision-'));
    const acquireAnalyzeLock = vi.fn();
    const superviseWorkspaceBuild = vi.fn();
    const filename = path.join(root, `existing.${extension}`);
    try {
      await fs.mkdir(path.join(root, 'repo'));
      await fs.writeFile(filename, 'existing evidence\n');
      await expect(
        runWorkspacePairBenchmark(
          {
            repo: path.join(root, 'repo'),
            cli: 'built',
            pairs: 1,
            outputDir: root,
            runId: 'existing',
            dryRun: false,
          },
          { acquireAnalyzeLock, superviseWorkspaceBuild },
        ),
      ).rejects.toThrow();
      expect(await fs.readFile(filename, 'utf8')).toBe('existing evidence\n');
      expect((await fs.readdir(root)).sort()).toEqual([`existing.${extension}`, 'repo']);
      expect(acquireAnalyzeLock).not.toHaveBeenCalled();
      expect(superviseWorkspaceBuild).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it('rejects an output symlink alias that would write reports inside the source repository', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-pair-output-alias-'));
  const repo = path.join(root, 'repo');
  const acquireAnalyzeLock = vi.fn();
  const superviseWorkspaceBuild = vi.fn();
  try {
    await fs.mkdir(repo);
    await fs.symlink(repo, path.join(root, 'reports'), 'dir');
    await expect(
      runWorkspacePairBenchmark(
        {
          repo,
          cli: 'built',
          pairs: 1,
          outputDir: path.join(root, 'reports'),
          runId: 'alias',
          dryRun: false,
        },
        { acquireAnalyzeLock, superviseWorkspaceBuild },
      ),
    ).rejects.toThrow();
    expect(await fs.readdir(repo)).toEqual([]);
    expect(acquireAnalyzeLock).not.toHaveBeenCalled();
    expect(superviseWorkspaceBuild).not.toHaveBeenCalled();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('rejects identity drift between otherwise individually valid pairs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-pair-drift-'));
  const repo = path.join(root, 'repo');
  const storagePath = path.join(repo, '.ontoindex');
  const previousExitCode = process.exitCode;
  let builds = 0;
  try {
    await fs.mkdir(repo);
    const record = await runWorkspacePairBenchmark(
      {
        repo,
        cli: 'built',
        pairs: 2,
        timeoutMs: 1000,
        outputDir: path.join(root, 'reports'),
        runId: 'drift',
        dryRun: false,
      },
      {
        acquireAnalyzeLock: async () => ({ release: async () => {} }),
        getStoragePaths: () => ({ storagePath }),
        superviseWorkspaceBuild: async () => {
          const leg = validLegs()[builds % 3];
          if (builds >= 3) leg.base.manifestDigest = 'e'.repeat(64);
          const name = `generation-${++builds}`;
          const directory = path.join(storagePath, 'overlay', name);
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(path.join(directory, 'base.json'), JSON.stringify(leg.base));
          await fs.writeFile(path.join(storagePath, 'overlay', 'CURRENT'), name);
        },
        verifyScopeRetentionCandidate: async () => ({
          coverage: { complete: true },
          retention: {
            inputEvidence: { complete: true, parserCodeIdentity: 'b'.repeat(64) },
            graphNodesCaptured: true,
            graphRelationshipsCaptured: true,
          },
        }),
        readGraph: async () => validLegs()[0].graph,
        getOverlaySnapshot: async () => publishedSnapshot(`generation-${builds}`),
        evictOverlayState: vi.fn(),
      },
    );
    expect(builds).toBeGreaterThan(3);
    expect(record.outcome).toMatchObject({ result: 'failed', exitCode: 1 });
    expect(JSON.stringify(record)).toMatch(/identity|manifestDigest|changed|drift/i);
  } finally {
    process.exitCode = previousExitCode;
    await fs.rm(root, { recursive: true, force: true });
  }
});
