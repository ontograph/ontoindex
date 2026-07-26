import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseArgs,
  runBenchmark,
  evaluatePeakRssThreshold,
  summarizeTelemetry,
  renderRelationshipDistributions,
  parseScenarioManifest,
  evaluateScenarioPreflight,
  normalizeRemoteIdentity,
  evaluateGraphQuality,
  scenarioToBenchmarkOptions,
  listScenarioSummaries,
  runScenarioManifest,
} from '../../scripts/large-codebase-benchmark.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const builtCli = path.join(repoRoot, 'dist/cli/index.js');
const tempDirs: string[] = [];

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const ENTIRE_GRAPH_REMOTE = 'https://github.com/entireio/entire-graph';

function validScenario(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'entire-graph',
    description: 'Pinned independent entire-graph scenario.',
    repoPath: '../../entire-graph',
    repoIdentity: ENTIRE_GRAPH_REMOTE,
    commit: COMMIT_A,
    mode: 'force-analyze',
    cli: 'source',
    timeoutMs: 1000,
    maxPeakRssMiB: 512,
    graphQuality: {
      minTotalRelationships: 100,
      minProvenance: { extracted: 10 },
      minByType: { CALLS: 5 },
    },
    ...overrides,
  };
}

function manifest(scenarios: unknown[]): string {
  return JSON.stringify({ version: 1, scenarios });
}

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rss-repo-'));
  tempDirs.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function makeGitRepoWithRemote(remoteUrl: string): { dir: string; commit: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-scenario-repo-'));
  tempDirs.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
  spawnSync(
    'git',
    ['-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '--allow-empty', '-q', '-m', 'seed'],
    { cwd: dir },
  );
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
  }).stdout.trim();
  return { dir, commit };
}

function makeOutputDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rss-out-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('scenario manifest parsing', () => {
  it('parses a valid single-scenario manifest into a deterministic shape', () => {
    const { version, scenarios } = parseScenarioManifest(manifest([validScenario()]));
    expect(version).toBe(1);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].commit).toBe(COMMIT_A);
    expect(scenarios[0].mode).toBe('force-analyze');
    expect(scenarios[0].graphQuality.minTotalRelationships).toBe(100);
  });

  it('preserves declared scenario order', () => {
    const a = validScenario({ id: 'a' });
    const b = validScenario({ id: 'b' });
    const c = validScenario({ id: 'c' });
    const { scenarios } = parseScenarioManifest(manifest([a, b, c]));
    expect(scenarios.map((s: { id: string }) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseScenarioManifest('{ not json')).toThrow(/not valid JSON/);
  });

  it('rejects an unsupported manifest version', () => {
    expect(() =>
      parseScenarioManifest(JSON.stringify({ version: 2, scenarios: [validScenario()] })),
    ).toThrow(/version must be 1/);
  });

  it('rejects an empty scenarios array', () => {
    expect(() => parseScenarioManifest(JSON.stringify({ version: 1, scenarios: [] }))).toThrow(
      /non-empty scenarios array/,
    );
  });

  it('rejects unknown top-level keys', () => {
    expect(() =>
      parseScenarioManifest(JSON.stringify({ version: 1, scenarios: [validScenario()], extra: 1 })),
    ).toThrow(/Unknown manifest key "extra"/);
  });

  it('rejects unknown scenario keys', () => {
    expect(() => parseScenarioManifest(manifest([validScenario({ command: 'rm -rf /' })]))).toThrow(
      /Unknown scenario "entire-graph" key "command"/,
    );
  });

  it('rejects duplicate scenario ids', () => {
    expect(() =>
      parseScenarioManifest(manifest([validScenario({ id: 'dup' }), validScenario({ id: 'dup' })])),
    ).toThrow(/Duplicate scenario id "dup"/);
  });

  it('rejects a commit that is not an exact 40-char hex SHA', () => {
    for (const commit of ['abc', COMMIT_A.toUpperCase(), COMMIT_A + '0', 'g'.repeat(40)]) {
      expect(() => parseScenarioManifest(manifest([validScenario({ commit })]))).toThrow(
        /40-character lowercase hex SHA/,
      );
    }
  });

  it('rejects an unsupported mode', () => {
    expect(() => parseScenarioManifest(manifest([validScenario({ mode: 'benchmark' })]))).toThrow(
      /mode must be one of/,
    );
  });

  it('rejects an unsupported cli', () => {
    expect(() => parseScenarioManifest(manifest([validScenario({ cli: 'python' })]))).toThrow(
      /cli must be one of/,
    );
  });

  it('rejects non-positive timeouts and peak-RSS limits', () => {
    expect(() => parseScenarioManifest(manifest([validScenario({ timeoutMs: 0 })]))).toThrow(
      /timeoutMs" must be a positive integer/,
    );
    expect(() => parseScenarioManifest(manifest([validScenario({ maxPeakRssMiB: -1 })]))).toThrow(
      /maxPeakRssMiB" must be a positive finite number/,
    );
  });

  it('rejects command-like characters in path-bearing fields', () => {
    expect(() =>
      parseScenarioManifest(manifest([validScenario({ repoPath: '..; rm -rf /' })])),
    ).toThrow(/repoPath" contains disallowed characters/);
  });

  it('requires graphQuality floors with at least one detailed floor', () => {
    const missing = validScenario();
    delete (missing as Record<string, unknown>).graphQuality;
    expect(() => parseScenarioManifest(manifest([missing]))).toThrow(
      /requires graphQuality floors/,
    );
    expect(() =>
      parseScenarioManifest(
        manifest([validScenario({ graphQuality: { minTotalRelationships: 10 } })]),
      ),
    ).toThrow(/at least one of minProvenance or minByType/);
  });

  it('rejects unknown provenance bands and malformed relationship-type keys', () => {
    expect(() =>
      parseScenarioManifest(
        manifest([
          validScenario({
            graphQuality: { minTotalRelationships: 10, minProvenance: { guessed: 1 } },
          }),
        ]),
      ),
    ).toThrow(/Unknown graphQuality.minProvenance key "guessed"/);
    expect(() =>
      parseScenarioManifest(
        manifest([
          validScenario({ graphQuality: { minTotalRelationships: 10, minByType: { calls: 1 } } }),
        ]),
      ),
    ).toThrow(/minByType key "calls" is not a relationship type/);
  });
});

describe('remote identity normalization', () => {
  it('normalizes https, ssh scp-like, git, and .git/trailing-slash forms to one canonical value', () => {
    const canonical = 'https://github.com/entireio/entire-graph';
    expect(normalizeRemoteIdentity('https://github.com/entireio/entire-graph')).toBe(canonical);
    expect(normalizeRemoteIdentity('https://github.com/entireio/entire-graph.git')).toBe(canonical);
    expect(normalizeRemoteIdentity('https://github.com/entireio/entire-graph/')).toBe(canonical);
    expect(normalizeRemoteIdentity('git@github.com:entireio/entire-graph.git')).toBe(canonical);
    expect(normalizeRemoteIdentity('ssh://git@github.com/entireio/entire-graph.git')).toBe(
      canonical,
    );
    expect(normalizeRemoteIdentity('git://github.com/entireio/entire-graph')).toBe(canonical);
    expect(normalizeRemoteIdentity('https://token@github.com/entireio/entire-graph')).toBe(
      canonical,
    );
  });

  it('distinguishes different repositories', () => {
    expect(normalizeRemoteIdentity('https://github.com/entireio/other')).not.toBe(
      normalizeRemoteIdentity('https://github.com/entireio/entire-graph'),
    );
  });

  it('treats empty/missing remotes as an empty identity', () => {
    expect(normalizeRemoteIdentity('')).toBe('');
    expect(normalizeRemoteIdentity(undefined)).toBe('');
  });
});

describe('scenario preflight', () => {
  const okArgs = {
    repoPath: '/repo/entire-graph',
    repoAvailable: true,
    expectedIdentity: ENTIRE_GRAPH_REMOTE,
    actualIdentity: 'git@github.com:entireio/entire-graph.git',
    expectedCommit: COMMIT_A,
    actualCommit: COMMIT_A,
    dirty: false,
  };

  it('passes when the checkout is present, identity matches, HEAD matches, and the tree is clean', () => {
    expect(evaluateScenarioPreflight(okArgs)).toEqual({ status: 'ok', commit: COMMIT_A });
  });

  it('fails closed when the checkout is unavailable before checking anything else', () => {
    const result = evaluateScenarioPreflight({ ...okArgs, repoAvailable: false });
    expect(result.status).toBe('repo-unavailable');
    expect(result.reason).toMatch(/checkout unavailable/);
  });

  it('fails when the checkout remote identity does not match the pinned repository', () => {
    const result = evaluateScenarioPreflight({
      ...okArgs,
      actualIdentity: 'https://github.com/someone/wrong-repo',
    });
    expect(result.status).toBe('identity-mismatch');
    expect(result.reason).toMatch(/does not match pinned identity/);
  });

  it('fails on a dirty tree once the checkout and identity are valid', () => {
    const result = evaluateScenarioPreflight({ ...okArgs, dirty: true });
    expect(result.status).toBe('dirty');
  });

  it('fails on a commit mismatch', () => {
    const result = evaluateScenarioPreflight({ ...okArgs, actualCommit: COMMIT_B });
    expect(result.status).toBe('commit-mismatch');
    expect(result.reason).toMatch(/does not match pinned commit/);
  });

  it('fails closed when HEAD is unavailable', () => {
    const result = evaluateScenarioPreflight({ ...okArgs, actualCommit: '' });
    expect(result.status).toBe('commit-unavailable');
  });
});

describe('graph-quality gate', () => {
  const floors = {
    minTotalRelationships: 100,
    minProvenance: { extracted: 10, inferred: 0, ambiguous: 0 },
    minByType: { CALLS: 5, CONTAINS: 3 },
  };
  const distributions = {
    totalRelationships: 200,
    byProvenance: { extracted: 50, inferred: 20, ambiguous: 5 },
    byType: [
      { type: 'CONTAINS', count: 120 },
      { type: 'CALLS', count: 40 },
    ],
  };

  it('passes when every floor is met', () => {
    expect(evaluateGraphQuality(distributions, floors)).toEqual({ status: 'pass', failures: [] });
  });

  it('fails when total relationships are below the floor', () => {
    const result = evaluateGraphQuality({ ...distributions, totalRelationships: 10 }, floors);
    expect(result.status).toBe('failed');
    expect(result.failures[0]).toMatch(/total relationships 10 below floor 100/);
  });

  it('fails when a provenance band is below the floor', () => {
    const result = evaluateGraphQuality(
      { ...distributions, byProvenance: { extracted: 1, inferred: 0, ambiguous: 0 } },
      floors,
    );
    expect(result.status).toBe('failed');
    expect(result.failures.join(' ')).toMatch(/provenance extracted 1 below floor 10/);
  });

  it('fails when a required relationship type is missing or too low', () => {
    const result = evaluateGraphQuality(
      { ...distributions, byType: [{ type: 'CONTAINS', count: 120 }] },
      floors,
    );
    expect(result.status).toBe('failed');
    expect(result.failures.join(' ')).toMatch(/relationship type CALLS 0 below floor 5/);
  });

  it('fails closed when distributions are unavailable', () => {
    const result = evaluateGraphQuality(null, floors);
    expect(result.status).toBe('unavailable');
    expect(result.failures[0]).toMatch(/distributions unavailable/);
  });
});

describe('scenario-to-options mapping and listing', () => {
  it('maps a scenario only onto fixed benchmark options', () => {
    const [scenario] = parseScenarioManifest(manifest([validScenario()])).scenarios;
    const opts = scenarioToBenchmarkOptions(scenario, '/repo/eval', {
      outputDir: '/out',
      sampleMs: 250,
      dryRun: true,
    });
    expect(opts.repo).toBe(path.resolve('/repo/eval', '../../entire-graph'));
    expect(opts.label).toBe(ENTIRE_GRAPH_REMOTE);
    expect(opts.mode).toBe('force-analyze');
    expect(opts.cli).toBe('source');
    expect(opts.timeoutMs).toBe(1000);
    expect(opts.maxPeakRssMib).toBe(512);
    expect(opts.writeAgentsMd).toBe(false);
    expect(opts.graphQuality.minTotalRelationships).toBe(100);
    expect(Object.keys(opts)).not.toContain('command');
  });

  it('summarizes scenarios with resolved repo paths', () => {
    const [scenario] = parseScenarioManifest(manifest([validScenario()])).scenarios;
    const [summary] = listScenarioSummaries([scenario], '/repo/eval');
    expect(summary.resolvedRepoPath).toBe(path.resolve('/repo/eval', '../../entire-graph'));
    expect(summary.commit).toBe(COMMIT_A);
  });
});

describe('checked-in benchmark scenario manifest', () => {
  it('parses the repository manifest and pins an exact commit', () => {
    const manifestPath = path.join(repoRoot, '..', 'eval', 'benchmark-scenarios.json');
    const { scenarios } = parseScenarioManifest(fs.readFileSync(manifestPath, 'utf8'));
    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) {
      expect(scenario.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(scenario.timeoutMs).toBeGreaterThan(0);
      expect(scenario.maxPeakRssMiB).toBeGreaterThan(0);
      expect(scenario.graphQuality.minTotalRelationships).toBeGreaterThan(0);
    }
  });

  it('targets an independent entire-graph checkout rather than this repository', () => {
    const manifestPath = path.join(repoRoot, '..', 'eval', 'benchmark-scenarios.json');
    const { scenarios } = parseScenarioManifest(fs.readFileSync(manifestPath, 'utf8'));
    const [scenario] = scenarios;
    // Not self-referential: identity is the external remote and the path escapes this repo root.
    expect(normalizeRemoteIdentity(scenario.repoIdentity)).toBe(ENTIRE_GRAPH_REMOTE);
    expect(scenario.commit).toBe('76eb362dfd436c9a5103140cdb34779d797b6885');
    const resolved = path.resolve(path.join(repoRoot, '..', 'eval'), scenario.repoPath);
    expect(resolved).not.toBe(repoRoot);
    expect(resolved.startsWith(path.resolve(repoRoot, '..'))).toBe(false);
  });
});

describe('direct single-repo CLI parsing is unchanged', () => {
  it('leaves scenario fields inert for a direct --repo invocation', () => {
    const opts = parseArgs(['--repo', '.', '--mode', 'status']);
    expect(opts.scenarioManifest).toBeNull();
    expect(opts.listScenarios).toBe(false);
    expect(opts.mode).toBe('status');
  });
});

describe('multi-scenario preflight aggregation', () => {
  it('continues past a failing scenario, flags exit code, and still processes later scenarios', async () => {
    const { dir: goodRepo, commit } = makeGitRepoWithRemote(ENTIRE_GRAPH_REMOTE);
    const missingRepo = path.join(os.tmpdir(), 'bench-missing-checkout-does-not-exist');
    const outputDir = makeOutputDir();
    const manifestDir = makeOutputDir();
    const manifestPath = path.join(manifestDir, 'scenarios.json');
    fs.writeFileSync(
      manifestPath,
      manifest([
        validScenario({ id: 'missing', repoPath: missingRepo }),
        validScenario({ id: 'good', repoPath: goodRepo, commit }),
      ]),
    );

    const errors: string[] = [];
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((value?: unknown) => {
      errors.push(String(value));
    });
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      logs.push(String(value));
    });

    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const opts = parseArgs([
        '--scenario-manifest',
        manifestPath,
        '--output-dir',
        outputDir,
        '--dry-run',
      ]);
      await runScenarioManifest(opts);

      // First scenario failed preflight (missing checkout) and set a nonzero exit code.
      expect(errors.join('\n')).toMatch(/scenario "missing" preflight failed/);
      expect(process.exitCode).not.toBe(0);
      // The runner did not abort: the second, valid scenario still reached dry-run output.
      expect(logs.join('\n')).toMatch(/"maxPeakRssMib": 512/);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

describe('persisted graph-quality outcome', () => {
  const hasBuiltCli = fs.existsSync(builtCli);
  const maybe = hasBuiltCli ? it : it.skip;

  maybe(
    'evaluates graph-quality inside runBenchmark and writes the outcome to JSON and Markdown before failing closed',
    async () => {
      const previousExitCode = process.exitCode;
      process.exitCode = 0;
      try {
        const outputDir = makeOutputDir();
        const opts = parseArgs([
          '--repo',
          makeGitRepo(),
          '--output-dir',
          outputDir,
          '--mode',
          'status',
          '--cli',
          'built',
          '--sample-ms',
          '100',
          '--run-id',
          'graph-quality-run',
        ]);
        // A status run produces no relationship distributions, so any floor fails closed.
        opts.graphQuality = { minTotalRelationships: 1 };
        await runBenchmark(opts);

        const jsonPath = path.join(outputDir, 'graph-quality-run.json');
        const markdownPath = path.join(outputDir, 'graph-quality-run.md');
        expect(fs.existsSync(jsonPath)).toBe(true);
        expect(fs.existsSync(markdownPath)).toBe(true);

        const record = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        expect(record.outcome.graphQuality.status).toBe('unavailable');
        expect(record.outcome.graphQuality.failures[0]).toMatch(/distributions unavailable/);

        const markdown = fs.readFileSync(markdownPath, 'utf8');
        expect(markdown).toContain('## Graph Quality');
        expect(markdown).toContain('Status: unavailable');

        expect(process.exitCode).not.toBe(0);
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );
});

describe('large-codebase-benchmark --max-peak-rss-mib parsing', () => {
  it('rejects zero, negative, and non-finite thresholds', () => {
    for (const value of ['0', '-10', 'abc']) {
      expect(() => parseArgs(['--max-peak-rss-mib', value])).toThrow(
        /--max-peak-rss-mib must be a positive finite number/,
      );
    }
  });

  it('accepts a positive finite threshold and defaults to null when omitted', () => {
    expect(parseArgs(['--max-peak-rss-mib', '512']).maxPeakRssMib).toBe(512);
    expect(parseArgs([]).maxPeakRssMib).toBeNull();
  });
});

describe('evaluatePeakRssThreshold', () => {
  it('reports not-requested when no threshold is supplied', () => {
    expect(evaluatePeakRssThreshold(2048, null)).toEqual({
      requested: false,
      status: 'not-requested',
    });
  });

  it('treats an equal boundary as within the threshold', () => {
    const result = evaluatePeakRssThreshold(1024, 1);
    expect(result.status).toBe('within');
    expect(result.peakRssMib).toBe(1);
  });

  it('flags a threshold that is exceeded', () => {
    const result = evaluatePeakRssThreshold(4096, 1);
    expect(result.status).toBe('exceeded');
    expect(result.peakRssMib).toBe(4);
    expect(result.reason).toMatch(/exceeded threshold 1 MiB/);
  });

  it('fails closed when RSS is unavailable and a threshold was requested', () => {
    const result = evaluatePeakRssThreshold(null, 256);
    expect(result.status).toBe('rss-unavailable');
    expect(result.reason).toMatch(/peak RSS unavailable/);
  });

  it('stays neutral when RSS is unavailable and no threshold was requested', () => {
    expect(evaluatePeakRssThreshold(null, null).status).toBe('not-requested');
  });
});

describe('relationship distributions in benchmark output', () => {
  it('extracts the distributions event in summarizeTelemetry', () => {
    const distributions = {
      totalRelationships: 3,
      byType: [
        { type: 'CALLS', count: 2 },
        { type: 'CONTAINS', count: 1 },
      ],
      byProvenance: { extracted: 1, inferred: 1, ambiguous: 1 },
    };
    const summary = summarizeTelemetry([
      { event: 'relationship-distributions', relationshipDistributions: distributions },
    ]);
    expect(summary.relationshipDistributions).toEqual(distributions);
  });

  it('defaults to null when no distributions event is present', () => {
    const summary = summarizeTelemetry([{ event: 'phase-start', phaseName: 'lbug' }]);
    expect(summary.relationshipDistributions).toBeNull();
  });

  it('renders the distributions with a bounded relation-type list', () => {
    const rendered = renderRelationshipDistributions({
      totalRelationships: 3,
      byType: [
        { type: 'CALLS', count: 2 },
        { type: 'CONTAINS', count: 1 },
      ],
      byProvenance: { extracted: 1, inferred: 1, ambiguous: 1 },
    });
    expect(rendered).toContain('Total relationships: 3');
    expect(rendered).toContain('extracted 1, inferred 1, ambiguous 1');
    expect(rendered).toContain('CALLS: 2');
    expect(rendered).toContain('CONTAINS: 1');
  });

  it('renders unavailable when distributions are missing', () => {
    expect(renderRelationshipDistributions(null)).toBe('- unavailable');
  });
});

describe('runBenchmark peak-RSS threshold reporting', () => {
  const hasBuiltCli = fs.existsSync(builtCli);
  const maybe = hasBuiltCli ? it : it.skip;

  it('includes the threshold in dry-run metadata', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      logs.push(String(value));
    });
    const opts = parseArgs([
      '--repo',
      makeGitRepo(),
      '--output-dir',
      makeOutputDir(),
      '--mode',
      'status',
      '--max-peak-rss-mib',
      '500',
      '--dry-run',
    ]);
    await runBenchmark(opts);
    const printed = JSON.parse(logs.join('\n'));
    expect(printed.maxPeakRssMib).toBe(500);
  });

  maybe(
    'writes JSON and Markdown reports before failing closed when a requested threshold fails',
    async () => {
      const previousExitCode = process.exitCode;
      process.exitCode = 0;
      try {
        const outputDir = makeOutputDir();
        const opts = parseArgs([
          '--repo',
          makeGitRepo(),
          '--output-dir',
          outputDir,
          '--mode',
          'status',
          '--cli',
          'built',
          '--sample-ms',
          '100',
          '--max-peak-rss-mib',
          '1',
          '--run-id',
          'fail-closed-run',
        ]);
        await runBenchmark(opts);

        const jsonPath = path.join(outputDir, 'fail-closed-run.json');
        const markdownPath = path.join(outputDir, 'fail-closed-run.md');
        expect(fs.existsSync(jsonPath)).toBe(true);
        expect(fs.existsSync(markdownPath)).toBe(true);

        const record = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        expect(record.maxPeakRssMib).toBe(1);
        // With a 1 MiB ceiling the run fails closed either because a captured
        // peak RSS exceeds it or because RSS sampling was unavailable.
        expect(['exceeded', 'rss-unavailable']).toContain(record.outcome.peakRssThreshold.status);
        expect(process.exitCode).not.toBe(0);
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );

  maybe('leaves behavior unchanged when no threshold is requested', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const outputDir = makeOutputDir();
      const opts = parseArgs([
        '--repo',
        makeGitRepo(),
        '--output-dir',
        outputDir,
        '--mode',
        'status',
        '--cli',
        'built',
        '--sample-ms',
        '100',
        '--run-id',
        'plain-run',
      ]);
      await runBenchmark(opts);

      const record = JSON.parse(fs.readFileSync(path.join(outputDir, 'plain-run.json'), 'utf8'));
      expect(record.maxPeakRssMib).toBeNull();
      expect(record.outcome.peakRssThreshold.status).toBe('not-requested');
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
