#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(packageRoot, '..');

const usage = `Usage:
  npm run bench:large -- --repo <path> [--label <name>] [--mode analyze|force-analyze|status]

Options:
  --repo <path>          Repository to benchmark. Defaults to current directory.
  --label <name>         Label used in output filenames. Defaults to repo basename.
  --mode <mode>          analyze, force-analyze, or status. Defaults to analyze.
  --cli <source|built>   Use live TypeScript source or built dist CLI. Defaults to source.
  --write-agents-md      Allow analyze to update AGENTS.md/CLAUDE.md. Defaults to disabled.
  --output-dir <path>    Defaults to docs/plans/benchmarks.
  --sample-ms <n>        RSS sampling interval. Defaults to 1000.
  --timeout-ms <n>       Kill benchmark after this many ms. Defaults to 0, disabled.
  --max-peak-rss-mib <n> Fail if peak process-tree RSS exceeds this many MiB. Opt-in.
  --run-id <id>          Stable run id for output filenames.
  --scenario-manifest <path>  Run pinned scenarios from a strict JSON manifest instead of a single repo.
  --list-scenarios       With --scenario-manifest, print parsed scenarios and exit without running.
  --dry-run              Print the command and output paths without executing.
  --help                 Show this help.
`;

const SCENARIO_TOP_LEVEL_KEYS = new Set(['version', 'description', 'scenarios']);
const SCENARIO_KEYS = new Set([
  'id',
  'description',
  'repoPath',
  'repoIdentity',
  'commit',
  'mode',
  'cli',
  'timeoutMs',
  'maxPeakRssMiB',
  'graphQuality',
]);
const GRAPH_QUALITY_KEYS = new Set(['minTotalRelationships', 'minProvenance', 'minByType']);
const PROVENANCE_BANDS = new Set(['extracted', 'inferred', 'ambiguous']);
const SCENARIO_MODES = new Set(['analyze', 'force-analyze', 'status']);
const SCENARIO_CLIS = new Set(['source', 'built']);
// Rejects shell/command metacharacters so no declarative field can smuggle a command.
const UNSAFE_STRING = /[\n\r\t`$;|&<>]/;
// Metadata (description) may carry punctuation but never control characters.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function parseArgs(argv) {
  const opts = {
    repo: process.cwd(),
    label: '',
    mode: 'analyze',
    cli: 'source',
    outputDir: path.join(workspaceRoot, 'docs', 'plans', 'benchmarks'),
    sampleMs: 1000,
    timeoutMs: 0,
    maxPeakRssMib: null,
    runId: '',
    dryRun: false,
    writeAgentsMd: false,
    scenarioManifest: null,
    listScenarios: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--repo':
        opts.repo = argv[++i];
        break;
      case '--label':
        opts.label = argv[++i];
        break;
      case '--mode':
        opts.mode = argv[++i];
        break;
      case '--cli':
        opts.cli = argv[++i];
        break;
      case '--output-dir':
        opts.outputDir = argv[++i];
        break;
      case '--sample-ms':
        opts.sampleMs = Number(argv[++i]);
        break;
      case '--timeout-ms':
        opts.timeoutMs = Number(argv[++i]);
        break;
      case '--max-peak-rss-mib':
        opts.maxPeakRssMib = Number(argv[++i]);
        break;
      case '--run-id':
        opts.runId = argv[++i];
        break;
      case '--scenario-manifest':
        opts.scenarioManifest = argv[++i];
        break;
      case '--list-scenarios':
        opts.listScenarios = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--write-agents-md':
        opts.writeAgentsMd = true;
        break;
      case '--help':
      case '-h':
        console.log(usage);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['analyze', 'force-analyze', 'status'].includes(opts.mode)) {
    throw new Error(`Unsupported --mode "${opts.mode}"`);
  }
  if (!['source', 'built'].includes(opts.cli)) {
    throw new Error(`Unsupported --cli "${opts.cli}"`);
  }
  if (!Number.isFinite(opts.sampleMs) || opts.sampleMs < 100) {
    throw new Error('--sample-ms must be a number >= 100');
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0) {
    throw new Error('--timeout-ms must be a number >= 0');
  }
  if (
    opts.maxPeakRssMib !== null &&
    (!Number.isFinite(opts.maxPeakRssMib) || opts.maxPeakRssMib <= 0)
  ) {
    throw new Error('--max-peak-rss-mib must be a positive finite number');
  }

  opts.repo = path.resolve(opts.repo);
  opts.outputDir = path.resolve(opts.outputDir);
  opts.label = opts.label || path.basename(opts.repo);
  opts.runId =
    opts.runId || `${new Date().toISOString().slice(0, 10)}-${opts.mode}-${slug(opts.label)}`;
  return opts;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSafeString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Scenario field "${label}" must be a non-empty string`);
  }
  if (UNSAFE_STRING.test(value)) {
    throw new Error(`Scenario field "${label}" contains disallowed characters`);
  }
  return value;
}

function assertMetadataString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Scenario field "${label}" must be a non-empty string`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw new Error(`Scenario field "${label}" contains control characters`);
  }
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Scenario field "${label}" must be a positive integer`);
  }
  return value;
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Scenario field "${label}" must be a non-negative integer`);
  }
  return value;
}

function assertPositiveFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Scenario field "${label}" must be a positive finite number`);
  }
  return value;
}

function assertNoUnknownKeys(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown ${label} key "${key}"`);
    }
  }
}

function parseGraphQualityFloors(raw, scenarioId) {
  if (!isPlainObject(raw)) {
    throw new Error(`Scenario "${scenarioId}" graphQuality must be an object`);
  }
  assertNoUnknownKeys(raw, GRAPH_QUALITY_KEYS, 'graphQuality');
  if (!('minTotalRelationships' in raw)) {
    throw new Error(`Scenario "${scenarioId}" graphQuality requires minTotalRelationships`);
  }
  const floors = {
    minTotalRelationships: assertPositiveInteger(
      raw.minTotalRelationships,
      'graphQuality.minTotalRelationships',
    ),
  };

  if ('minProvenance' in raw) {
    if (!isPlainObject(raw.minProvenance)) {
      throw new Error(`Scenario "${scenarioId}" graphQuality.minProvenance must be an object`);
    }
    assertNoUnknownKeys(raw.minProvenance, PROVENANCE_BANDS, 'graphQuality.minProvenance');
    floors.minProvenance = {};
    for (const [band, value] of Object.entries(raw.minProvenance)) {
      floors.minProvenance[band] = assertNonNegativeInteger(
        value,
        `graphQuality.minProvenance.${band}`,
      );
    }
  }

  if ('minByType' in raw) {
    if (!isPlainObject(raw.minByType)) {
      throw new Error(`Scenario "${scenarioId}" graphQuality.minByType must be an object`);
    }
    floors.minByType = {};
    for (const [type, value] of Object.entries(raw.minByType)) {
      if (!/^[A-Z][A-Z_]*$/.test(type)) {
        throw new Error(
          `Scenario "${scenarioId}" graphQuality.minByType key "${type}" is not a relationship type`,
        );
      }
      floors.minByType[type] = assertNonNegativeInteger(value, `graphQuality.minByType.${type}`);
    }
  }

  if (!floors.minProvenance && !floors.minByType) {
    throw new Error(
      `Scenario "${scenarioId}" graphQuality requires at least one of minProvenance or minByType`,
    );
  }
  return floors;
}

function parseScenario(raw, seenIds) {
  if (!isPlainObject(raw)) {
    throw new Error('Each scenario must be an object');
  }
  const id = assertSafeString(raw.id, 'id');
  if (seenIds.has(id)) {
    throw new Error(`Duplicate scenario id "${id}"`);
  }
  seenIds.add(id);
  assertNoUnknownKeys(raw, SCENARIO_KEYS, `scenario "${id}"`);

  const commit = raw.commit;
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Scenario "${id}" commit must be an exact 40-character lowercase hex SHA`);
  }
  if (!SCENARIO_MODES.has(raw.mode)) {
    throw new Error(`Scenario "${id}" mode must be one of analyze, force-analyze, status`);
  }
  const cli = raw.cli === undefined ? 'source' : raw.cli;
  if (!SCENARIO_CLIS.has(cli)) {
    throw new Error(`Scenario "${id}" cli must be one of source, built`);
  }
  if (!('graphQuality' in raw)) {
    throw new Error(`Scenario "${id}" requires graphQuality floors`);
  }

  const scenario = {
    id,
    repoPath: assertSafeString(raw.repoPath, 'repoPath'),
    repoIdentity: assertSafeString(raw.repoIdentity, 'repoIdentity'),
    commit,
    mode: raw.mode,
    cli,
    timeoutMs: assertPositiveInteger(raw.timeoutMs, 'timeoutMs'),
    maxPeakRssMiB: assertPositiveFinite(raw.maxPeakRssMiB, 'maxPeakRssMiB'),
    graphQuality: parseGraphQualityFloors(raw.graphQuality, id),
  };
  if ('description' in raw) {
    scenario.description = assertMetadataString(raw.description, 'description');
  }
  return scenario;
}

function parseScenarioManifest(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Scenario manifest is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error('Scenario manifest must be a JSON object');
  }
  assertNoUnknownKeys(parsed, SCENARIO_TOP_LEVEL_KEYS, 'manifest');
  if (parsed.version !== 1) {
    throw new Error('Scenario manifest version must be 1');
  }
  if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
    throw new Error('Scenario manifest must declare a non-empty scenarios array');
  }

  const seenIds = new Set();
  const scenarios = parsed.scenarios.map((raw) => parseScenario(raw, seenIds));
  return { version: parsed.version, scenarios };
}

function normalizeRemoteIdentity(value) {
  if (typeof value !== 'string') return '';
  let s = value.trim();
  if (s.length === 0) return '';
  // scp-like ssh form: git@host:owner/repo(.git)
  const scp = s.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scp) s = `https://${scp[1]}/${scp[2]}`;
  s = s
    .replace(/^ssh:\/\//, 'https://')
    .replace(/^git:\/\//, 'https://')
    .replace(/^http:\/\//, 'https://');
  // Drop any user@ authority prefix from URL forms.
  s = s.replace(/^https:\/\/[^@/]+@/, 'https://');
  s = s.replace(/\.git$/, '').replace(/\/+$/, '');
  return s.toLowerCase();
}

function evaluateScenarioPreflight({
  repoPath,
  repoAvailable,
  expectedIdentity,
  actualIdentity,
  expectedCommit,
  actualCommit,
  dirty,
}) {
  if (!repoAvailable) {
    return {
      status: 'repo-unavailable',
      reason: `repository checkout unavailable at ${repoPath}; provision it before running`,
      repoPath,
    };
  }
  const wantIdentity = normalizeRemoteIdentity(expectedIdentity);
  const gotIdentity = normalizeRemoteIdentity(actualIdentity);
  if (wantIdentity !== gotIdentity) {
    return {
      status: 'identity-mismatch',
      reason: `checkout remote ${gotIdentity || '(none)'} does not match pinned identity ${wantIdentity}`,
      expectedIdentity: wantIdentity,
      actualIdentity: gotIdentity,
    };
  }
  if (dirty) {
    return { status: 'dirty', reason: 'working tree is dirty; refusing to run pinned scenario' };
  }
  if (!actualCommit) {
    return {
      status: 'commit-unavailable',
      reason: 'unable to resolve HEAD commit; failing closed',
      expectedCommit,
    };
  }
  if (actualCommit !== expectedCommit) {
    return {
      status: 'commit-mismatch',
      reason: `HEAD ${actualCommit} does not match pinned commit ${expectedCommit}`,
      expectedCommit,
      actualCommit,
    };
  }
  return { status: 'ok', commit: actualCommit };
}

function evaluateGraphQuality(distributions, floors) {
  if (!distributions) {
    return {
      status: 'unavailable',
      failures: [
        'relationship distributions unavailable; failing closed against graph-quality floors',
      ],
    };
  }
  const failures = [];
  if (distributions.totalRelationships < floors.minTotalRelationships) {
    failures.push(
      `total relationships ${distributions.totalRelationships} below floor ${floors.minTotalRelationships}`,
    );
  }
  for (const [band, min] of Object.entries(floors.minProvenance ?? {})) {
    const actual = distributions.byProvenance?.[band] ?? 0;
    if (actual < min) {
      failures.push(`provenance ${band} ${actual} below floor ${min}`);
    }
  }
  if (floors.minByType) {
    const typeCounts = new Map(
      (distributions.byType ?? []).map((entry) => [entry.type, entry.count]),
    );
    for (const [type, min] of Object.entries(floors.minByType)) {
      const actual = typeCounts.get(type) ?? 0;
      if (actual < min) {
        failures.push(`relationship type ${type} ${actual} below floor ${min}`);
      }
    }
  }
  return { status: failures.length ? 'failed' : 'pass', failures };
}

function scenarioToBenchmarkOptions(scenario, manifestDir, baseOpts) {
  return {
    repo: path.resolve(manifestDir, scenario.repoPath),
    label: scenario.repoIdentity,
    mode: scenario.mode,
    cli: scenario.cli,
    outputDir: baseOpts.outputDir,
    sampleMs: baseOpts.sampleMs,
    timeoutMs: scenario.timeoutMs,
    maxPeakRssMib: scenario.maxPeakRssMiB,
    runId: `${new Date().toISOString().slice(0, 10)}-${scenario.mode}-${slug(scenario.id)}`,
    dryRun: baseOpts.dryRun,
    writeAgentsMd: false,
    graphQuality: scenario.graphQuality,
  };
}

function listScenarioSummaries(scenarios, manifestDir) {
  return scenarios.map((scenario) => ({
    id: scenario.id,
    repoIdentity: scenario.repoIdentity,
    resolvedRepoPath: path.resolve(manifestDir, scenario.repoPath),
    commit: scenario.commit,
    mode: scenario.mode,
    cli: scenario.cli,
    timeoutMs: scenario.timeoutMs,
    maxPeakRssMiB: scenario.maxPeakRssMiB,
    graphQuality: scenario.graphQuality,
  }));
}

async function runScenarioManifest(opts) {
  const manifestPath = path.resolve(opts.scenarioManifest);
  const manifestDir = path.dirname(manifestPath);
  const rawText = await fs.readFile(manifestPath, 'utf8');
  const { scenarios } = parseScenarioManifest(rawText);

  if (opts.listScenarios) {
    console.log(JSON.stringify(listScenarioSummaries(scenarios, manifestDir), null, 2));
    return;
  }

  // Preflight and run every scenario, aggregating failures. One failing scenario
  // sets a nonzero exit code but does not abort the remaining scenarios.
  for (const scenario of scenarios) {
    const repo = path.resolve(manifestDir, scenario.repoPath);
    const preflight = evaluateScenarioPreflight({
      repoPath: repo,
      repoAvailable: isGitWorktree(repo),
      expectedIdentity: scenario.repoIdentity,
      actualIdentity: gitRemoteUrl(repo),
      expectedCommit: scenario.commit,
      actualCommit: git(['rev-parse', 'HEAD'], repo),
      dirty: gitHasChanges(repo),
    });
    if (preflight.status !== 'ok') {
      console.error(`[bench] scenario "${scenario.id}" preflight failed: ${preflight.reason}`);
      if (!process.exitCode) process.exitCode = 1;
      continue;
    }

    const benchmarkOpts = scenarioToBenchmarkOptions(scenario, manifestDir, opts);
    // runBenchmark evaluates graph-quality floors internally and persists the
    // outcome to JSON/Markdown before it returns; the runner consumes that.
    const record = await runBenchmark(benchmarkOpts);
    if (opts.dryRun || !record) continue;

    const quality = record.outcome.graphQuality;
    if (quality && quality.status !== 'pass') {
      console.error(
        `[bench] scenario "${scenario.id}" graph-quality gate ${quality.status}: ${quality.failures.join('; ')}`,
      );
      if (!process.exitCode) process.exitCode = 1;
    }
  }
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function gitHasChanges(cwd) {
  return git(['status', '--porcelain'], cwd).length > 0;
}

function isGitWorktree(cwd) {
  return git(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
}

function gitRemoteUrl(cwd) {
  return git(['config', '--get', 'remote.origin.url'], cwd);
}

function collectRelevantEnv() {
  const keys = [
    'ONTOINDEX_ANALYZE_TELEMETRY',
    'ONTOINDEX_MAX_WORKERS',
    'ONTOINDEX_SCAN_MAX_FILE_KB',
    'ONTOINDEX_LARGE_REPO_PARSE_MAX_FILE_KB',
    'ONTOINDEX_LARGE_REPO_PARSE_CAP_MIN_KB',
    'ONTOINDEX_PARSE_MAX_AST_NODES',
    'ONTOINDEX_PARSE_MAX_AST_DEPTH',
    'ONTOINDEX_PARSE_WORKER_ISOLATION',
    'ONTOINDEX_DISABLE_LARGE_REPO_PARSE',
    'ONTOINDEX_ENABLE_LARGE_REPO_PARSE',
  ];
  const env = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (env.ONTOINDEX_ANALYZE_TELEMETRY === undefined) {
    env.ONTOINDEX_ANALYZE_TELEMETRY = '1';
  }
  return env;
}

function renderRelevantEnv(env) {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return '';
  return entries.map(([key, value]) => `${key}=${value}`).join(', ');
}

function commandFor(opts) {
  const cli = path.join(packageRoot, 'dist', 'cli', 'index.js');
  const sourceCli = path.join(packageRoot, 'src', 'cli', 'index.ts');
  const hasBuiltCli = spawnSync('test', ['-f', cli]).status === 0;
  if (opts.cli === 'built' && !hasBuiltCli) {
    throw new Error(`Built CLI not found at ${cli}. Run npm run build or use --cli source.`);
  }
  const tsxLoader = path.join(packageRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
  const prefix =
    opts.cli === 'built'
      ? ['node', cli]
      : [
          'node',
          '--max-old-space-size=8192',
          '--stack-size=4096',
          '--import',
          tsxLoader,
          sourceCli,
        ];

  if (opts.mode === 'status') {
    return { cmd: prefix[0], args: [...prefix.slice(1), 'status'], cwd: opts.repo };
  }

  return {
    cmd: prefix[0],
    args: [
      ...prefix.slice(1),
      'analyze',
      opts.repo,
      ...(opts.mode === 'force-analyze' ? ['--force'] : []),
      ...(opts.writeAgentsMd ? [] : ['--skip-agents-md']),
    ],
    cwd: packageRoot,
  };
}

async function sampleProcessTreeMemory(rootPid) {
  if (process.platform !== 'linux') return null;
  const procEntries = await fs.readdir('/proc', { withFileTypes: true }).catch(() => []);
  const childrenByParent = new Map();
  const rssByPid = new Map();
  const commandByPid = new Map();

  await Promise.all(
    procEntries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name);
        try {
          const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
          const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] ?? 0);
          const rss = Number(status.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1] ?? 0);
          const command = status.match(/^Name:\s+(.+)$/m)?.[1]?.trim() ?? '';
          rssByPid.set(pid, rss);
          commandByPid.set(pid, command);
          const children = childrenByParent.get(ppid) ?? [];
          children.push(pid);
          childrenByParent.set(ppid, children);
        } catch {
          // Process exited between /proc listing and status read.
        }
      }),
  );

  let total = 0;
  const samples = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    const rssKiB = rssByPid.get(pid) ?? 0;
    total += rssKiB;
    samples.push({
      pid,
      rssKiB,
      command: commandByPid.get(pid) ?? '',
      isRoot: pid === rootPid,
    });
    stack.push(...(childrenByParent.get(pid) ?? []));
  }

  const childSamples = samples.filter((sample) => !sample.isRoot);
  childSamples.sort((a, b) => b.rssKiB - a.rssKiB);
  return {
    totalRssKiB: total,
    rootRssKiB: samples.find((sample) => sample.isRoot)?.rssKiB ?? 0,
    childRssKiB: childSamples.reduce((sum, sample) => sum + sample.rssKiB, 0),
    processCount: samples.length,
    childProcessCount: childSamples.length,
    maxChildRssKiB: childSamples[0]?.rssKiB ?? 0,
    topChildProcesses: childSamples.slice(0, 8),
  };
}

function terminateChildProcessTree(child, signal) {
  if (!child.pid) return;

  try {
    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }

    // The benchmarked CLI may spawn a wrapper process and parser workers.
    // Kill the process group so timeouts do not leave CPU-heavy descendants.
    process.kill(-child.pid, signal);
  } catch (err) {
    if (err?.code !== 'ESRCH') {
      child.kill(signal);
    }
  }
}

async function runBenchmark(opts) {
  const repoCommit = git(['rev-parse', 'HEAD'], opts.repo);
  const repoBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], opts.repo);
  const runnerCommit = git(['rev-parse', 'HEAD'], workspaceRoot);
  const repoDirty = gitHasChanges(opts.repo);
  const runnerDirty = gitHasChanges(workspaceRoot);
  const command = commandFor(opts);
  const relevantEnv = collectRelevantEnv();
  const markdownPath = path.join(opts.outputDir, `${opts.runId}.md`);
  const jsonPath = path.join(opts.outputDir, `${opts.runId}.json`);

  const record = {
    runId: opts.runId,
    date: new Date().toISOString(),
    repository: opts.label,
    repositoryPath: opts.repo,
    commitSha: repoCommit,
    branch: repoBranch,
    repositoryDirty: repoDirty,
    runnerCommitSha: runnerCommit,
    runnerDirty,
    mode: opts.mode,
    cli: opts.cli,
    maxPeakRssMib: opts.maxPeakRssMib,
    command: [command.cmd, ...command.args].join(' '),
    cwd: command.cwd,
    relevantEnv,
    environment: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpuCount: os.cpus().length,
      ramBytes: os.totalmem(),
      node: process.version,
    },
    outcome: {
      result: 'not-run',
      exitCode: null,
      signal: null,
      totalWallMs: 0,
      peakRssKiB: null,
      peakRootRssKiB: null,
      peakChildRssKiB: null,
      peakChildProcessRssKiB: null,
      peakProcessCount: null,
      peakChildProcessCount: null,
      topChildProcessesByRss: [],
      throughput: null,
      telemetry: [],
      phaseTimings: [],
      parsePlan: null,
      scanDegradedFiles: [],
      parseChunks: [],
      parseSubBatches: [],
      parseWorkerResults: [],
      parseDegradedFiles: [],
      lbugSteps: [],
      ftsIndexSteps: [],
      slowestFiles: [],
      slowestExtractors: [],
      stdoutTail: '',
      stderrTail: '',
    },
  };

  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        {
          command: record.command,
          cwd: command.cwd,
          markdownPath,
          jsonPath,
          maxPeakRssMib: opts.maxPeakRssMib,
        },
        null,
        2,
      ),
    );
    return;
  }

  await fs.mkdir(opts.outputDir, { recursive: true });
  const started = performance.now();
  const child = spawn(command.cmd, command.args, {
    cwd: command.cwd,
    env: {
      ...process.env,
      ONTOINDEX_ANALYZE_TELEMETRY: process.env.ONTOINDEX_ANALYZE_TELEMETRY ?? '1',
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let peakMemory = null;
  let stdout = '';
  let stderr = '';
  let telemetryBuffer = '';
  const telemetry = [];
  const append = (current, chunk) => (current + chunk.toString()).slice(-20_000);
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout = append(stdout, text);
    telemetryBuffer = collectTelemetryEvents(`${telemetryBuffer}${text}`, telemetry);
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr = append(stderr, chunk);
    process.stderr.write(chunk);
  });

  const sampler = setInterval(async () => {
    const sample = await sampleProcessTreeMemory(child.pid);
    if (sample !== null) peakMemory = mergePeakMemory(peakMemory, sample);
  }, opts.sampleMs);

  let timeout;
  let forceTimeout;
  if (opts.timeoutMs > 0) {
    timeout = setTimeout(() => {
      terminateChildProcessTree(child, 'SIGTERM');
      forceTimeout = setTimeout(() => terminateChildProcessTree(child, 'SIGKILL'), 30_000);
    }, opts.timeoutMs);
  }

  const exit = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  telemetryBuffer = collectTelemetryEvents(`${telemetryBuffer}\n`, telemetry);
  clearInterval(sampler);
  clearTimeout(timeout);
  clearTimeout(forceTimeout);

  const finalMemory = await sampleProcessTreeMemory(child.pid);
  if (finalMemory !== null) peakMemory = mergePeakMemory(peakMemory, finalMemory);

  const telemetrySummary = summarizeTelemetry(telemetry);
  const throughput = summarizeThroughput(
    telemetrySummary.parsePlan,
    telemetrySummary.phaseTimings,
    telemetrySummary.parseWorkerResults,
  );

  record.outcome = {
    result: exit.code === 0 ? 'success' : 'failure',
    exitCode: exit.code,
    signal: exit.signal,
    totalWallMs: Math.round(performance.now() - started),
    peakRssKiB: peakMemory?.totalRssKiB || null,
    peakRootRssKiB: peakMemory?.rootRssKiB || null,
    peakChildRssKiB: peakMemory?.childRssKiB || null,
    peakChildProcessRssKiB: peakMemory?.maxChildRssKiB || null,
    peakProcessCount: peakMemory?.processCount || null,
    peakChildProcessCount: peakMemory?.childProcessCount || null,
    topChildProcessesByRss: peakMemory?.topChildProcesses ?? [],
    throughput,
    ...telemetrySummary,
    stdoutTail: stdout,
    stderrTail: stderr,
  };

  const peakRssThreshold = evaluatePeakRssThreshold(record.outcome.peakRssKiB, opts.maxPeakRssMib);
  record.outcome.peakRssThreshold = peakRssThreshold;

  // Evaluate graph-quality floors before persisting so the JSON/Markdown reports
  // record the outcome even when the gate fails closed.
  const graphQuality = opts.graphQuality
    ? evaluateGraphQuality(record.outcome.relationshipDistributions, opts.graphQuality)
    : null;
  if (graphQuality) record.outcome.graphQuality = graphQuality;

  await fs.writeFile(jsonPath, JSON.stringify(record, null, 2) + '\n');
  await fs.writeFile(markdownPath, renderMarkdown(record));
  console.log(`\n[bench] wrote ${markdownPath}`);
  console.log(`[bench] wrote ${jsonPath}`);

  if (exit.code !== 0) process.exitCode = exit.code ?? 1;

  if (peakRssThreshold.status === 'exceeded' || peakRssThreshold.status === 'rss-unavailable') {
    console.error(`[bench] peak-RSS threshold failure: ${peakRssThreshold.reason}`);
    if (!process.exitCode) process.exitCode = 1;
  }

  if (graphQuality && graphQuality.status !== 'pass') {
    console.error(
      `[bench] graph-quality gate ${graphQuality.status}: ${graphQuality.failures.join('; ')}`,
    );
    if (!process.exitCode) process.exitCode = 1;
  }

  return record;
}

function evaluatePeakRssThreshold(peakRssKiB, maxPeakRssMib) {
  if (maxPeakRssMib === null || maxPeakRssMib === undefined) {
    return { requested: false, status: 'not-requested' };
  }
  const peakRssMib = Number.isFinite(peakRssKiB) && peakRssKiB > 0 ? peakRssKiB / 1024 : null;
  if (peakRssMib === null) {
    return {
      requested: true,
      status: 'rss-unavailable',
      maxPeakRssMib,
      peakRssMib: null,
      reason: `peak RSS unavailable; failing closed against threshold ${maxPeakRssMib} MiB`,
    };
  }
  if (peakRssMib > maxPeakRssMib) {
    return {
      requested: true,
      status: 'exceeded',
      maxPeakRssMib,
      peakRssMib: round(peakRssMib, 2),
      reason: `peak RSS ${round(peakRssMib, 2)} MiB exceeded threshold ${maxPeakRssMib} MiB`,
    };
  }
  return {
    requested: true,
    status: 'within',
    maxPeakRssMib,
    peakRssMib: round(peakRssMib, 2),
  };
}

function mergePeakMemory(current, sample) {
  if (!current || sample.totalRssKiB > current.totalRssKiB) return sample;
  return {
    ...current,
    rootRssKiB: Math.max(current.rootRssKiB, sample.rootRssKiB),
    childRssKiB: Math.max(current.childRssKiB, sample.childRssKiB),
    processCount: Math.max(current.processCount, sample.processCount),
    childProcessCount: Math.max(current.childProcessCount, sample.childProcessCount),
    maxChildRssKiB: Math.max(current.maxChildRssKiB, sample.maxChildRssKiB),
    topChildProcesses: mergeTopChildProcesses(current.topChildProcesses, sample.topChildProcesses),
  };
}

function mergeTopChildProcesses(current, next) {
  const byPid = new Map();
  for (const sample of [...(current ?? []), ...(next ?? [])]) {
    const existing = byPid.get(sample.pid);
    if (!existing || sample.rssKiB > existing.rssKiB) byPid.set(sample.pid, sample);
  }
  return [...byPid.values()].sort((a, b) => b.rssKiB - a.rssKiB).slice(0, 8);
}

function renderMarkdown(record) {
  const phaseRows = renderPhaseRows(record.outcome.phaseTimings);
  const parsePlan = record.outcome.parsePlan;
  return `# Benchmark Result: ${record.runId}

## Run Metadata

- Date: ${record.date}
- Repository: ${record.repository}
- Repository path: ${record.repositoryPath}
- Commit SHA: ${record.commitSha}
- Branch: ${record.branch}
- Repository dirty: ${record.repositoryDirty}
- OntoIndex runner commit SHA: ${record.runnerCommitSha}
- OntoIndex runner dirty: ${record.runnerDirty}
- Machine: ${record.environment.cpu} (${record.environment.cpuCount} logical CPUs)
- OS: ${record.environment.os}
- RAM: ${formatBytes(record.environment.ramBytes)}
- Node version: ${record.environment.node}

## Command

\`\`\`bash
${record.command}
\`\`\`

## Configuration

- Mode: ${record.mode}
- CLI: ${record.cli}
- Working directory: ${record.cwd}
- Worker count: ${parsePlan?.workerPoolSize ?? ''}
- Chunk byte budget: ${parsePlan?.chunkByteBudget ?? ''}
- Initial batch size: ${parsePlan?.subBatchSize ?? ''}
- Timeout:
- Relevant env vars: ${renderRelevantEnv(record.relevantEnv)}

## Outcome

- Result: ${record.outcome.result}
- Exit code: ${record.outcome.exitCode}
- Signal: ${record.outcome.signal ?? ''}
- Total wall time: ${record.outcome.totalWallMs} ms
- Failure phase:
- Failure file:
- Failure language:
- Peak RSS: ${record.outcome.peakRssKiB ? `${record.outcome.peakRssKiB} KiB` : 'unavailable'}
- Peak root RSS: ${record.outcome.peakRootRssKiB ? `${record.outcome.peakRootRssKiB} KiB` : 'unavailable'}
- Peak child RSS: ${record.outcome.peakChildRssKiB ? `${record.outcome.peakChildRssKiB} KiB` : 'unavailable'}
- Peak child process RSS: ${record.outcome.peakChildProcessRssKiB ? `${record.outcome.peakChildProcessRssKiB} KiB` : 'unavailable'}
- Peak process count: ${record.outcome.peakProcessCount ?? 'unavailable'}
- Peak child process count: ${record.outcome.peakChildProcessCount ?? 'unavailable'}
- Peak RSS threshold: ${renderPeakRssThreshold(record.maxPeakRssMib, record.outcome.peakRssThreshold)}
- GC events: ${record.outcome.gcSummary?.count ?? 'unavailable'}
- GC time: ${Number.isFinite(record.outcome.gcSummary?.durationMs) ? formatMs(record.outcome.gcSummary.durationMs) : 'unavailable'}
- Top child processes by RSS: ${renderTopChildProcesses(record.outcome.topChildProcessesByRss)}
- Scan degraded files: ${renderDegradedSummary(record.outcome.scanDegradedFiles)}

## Phase Timings

| Phase | Duration | Notes |
|------|----------|-------|
${phaseRows || '| unavailable | | no phase telemetry captured |'}

## Parse Telemetry

- Files: ${parsePlan?.totalParseableFiles ?? ''}
- Bytes: ${parsePlan?.totalParseableBytes ?? ''}
- Chunks: ${parsePlan?.chunkCount ?? ''}
- Worker pool: ${parsePlan?.usedWorkerPool ?? ''}
- Sub-batch size: ${parsePlan?.subBatchSize ?? ''}
- Chunk summary: ${renderChunkSummary(record.outcome.parseChunks)}
- Latest sub-batches: ${renderSubBatchSummary(record.outcome.parseSubBatches)}
- Worker result summary: ${renderWorkerResultSummary(record.outcome.parseWorkerResults)}
- Degraded files: ${renderDegradedSummary(record.outcome.parseDegradedFiles)}
- Parse throughput: ${renderThroughput(record.outcome.throughput)}

## Cross-File Telemetry

- Plan: ${renderCrossFilePlan(record.outcome.crossFilePlan)}
- Slowest files: ${renderSlowestCrossFileFiles(record.outcome.slowCrossFileFiles)}

## Relationship Distributions

${renderRelationshipDistributions(record.outcome.relationshipDistributions)}

## Graph Quality

${renderGraphQuality(record.outcome.graphQuality)}

## LadybugDB Telemetry

- Step summary: ${renderLbugStepSummary(record.outcome.lbugSteps ?? [])}
- Slowest COPY steps: ${renderSlowestLbugSteps(record.outcome.lbugSteps ?? [])}

## FTS Telemetry

- Index summary: ${renderFtsIndexSummary(record.outcome.ftsIndexSteps ?? [])}
- Slowest indexes: ${renderSlowestFtsIndexes(record.outcome.ftsIndexSteps ?? [])}

## Output Tail

### stdout

\`\`\`text
${record.outcome.stdoutTail.trim()}
\`\`\`

### stderr

\`\`\`text
${record.outcome.stderrTail.trim()}
\`\`\`

## Observations

-

## Follow-up Actions

-
`;
}

function collectTelemetryEvents(text, telemetry) {
  const normalized = text.replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const remainder = lines.pop() ?? '';

  for (const line of lines) {
    const match = line.match(/\[ontoindex:telemetry\]\s+(\{.*\})/);
    if (!match) continue;
    try {
      telemetry.push(JSON.parse(match[1]));
    } catch {
      // Keep benchmark execution resilient even if one diagnostic line is partial.
    }
  }

  return remainder.slice(-10_000);
}

function summarizeTelemetry(telemetry) {
  const phaseStarts = new Map();
  const phaseTimings = [];
  for (const event of telemetry) {
    if (event.event === 'phase-start' && event.phaseName) {
      phaseStarts.set(event.phaseName, event);
      continue;
    }
    if (event.event !== 'phase-end') continue;
    const phaseStart = phaseStarts.get(event.phaseName);
    phaseTimings.push({
      phaseName: event.phaseName,
      durationMs: event.durationMs,
      rssBytes: event.rssBytes,
      heapUsedBytes: event.heapUsedBytes,
      graphNodes: event.graphNodes,
      graphRelationships: event.graphRelationships,
      gcCount: metricDelta(event.gcCount, phaseStart?.gcCount),
      gcDurationMs: metricDelta(event.gcDurationMs, phaseStart?.gcDurationMs),
    });
  }

  return {
    telemetry,
    phaseTimings,
    gcSummary: summarizeGc(telemetry),
    parsePlan: telemetry.find((event) => event.event === 'parse-plan') ?? null,
    parseChunks: telemetry.filter((event) => event.event === 'parse-chunk-end'),
    scanDegradedFiles: telemetry.filter((event) => event.event === 'scan-degraded-files'),
    parseSubBatches: telemetry.filter((event) => event.event === 'parse-sub-batch-start'),
    parseWorkerResults: telemetry.filter((event) => event.event === 'parse-worker-result'),
    parseDegradedFiles: telemetry.filter((event) => event.event === 'parse-degraded-files'),
    crossFilePlan: telemetry.find((event) => event.event === 'cross-file-plan') ?? null,
    slowCrossFileFiles:
      telemetry.find((event) => event.event === 'cross-file-slowest-files')?.slowCrossFileFiles ??
      [],
    lbugSteps: telemetry.filter((event) => event.event === 'lbug-step'),
    ftsIndexSteps: telemetry.filter(
      (event) =>
        event.event === 'fts-index-start' ||
        event.event === 'fts-index-end' ||
        event.event === 'fts-index-skip',
    ),
    slowestFiles: telemetry.find((event) => event.event === 'parse-slowest-files')?.slowFiles ?? [],
    slowestExtractors:
      telemetry.find((event) => event.event === 'parse-slowest-extractors')?.slowExtractors ?? [],
    relationshipDistributions:
      telemetry.find((event) => event.event === 'relationship-distributions')
        ?.relationshipDistributions ?? null,
  };
}

function summarizeGc(telemetry) {
  let lastGcEvent = null;
  for (const event of telemetry) {
    if (
      event.gcAvailable === true ||
      Number.isFinite(event.gcCount) ||
      Number.isFinite(event.gcDurationMs)
    ) {
      lastGcEvent = event;
    }
  }
  if (!lastGcEvent) return null;
  return {
    available: lastGcEvent.gcAvailable === true,
    count: Number.isFinite(lastGcEvent.gcCount) ? lastGcEvent.gcCount : null,
    durationMs: Number.isFinite(lastGcEvent.gcDurationMs) ? lastGcEvent.gcDurationMs : null,
  };
}

function metricDelta(end, start) {
  if (!Number.isFinite(end)) return null;
  if (!Number.isFinite(start)) return end;
  return round(Math.max(0, end - start), 2);
}

function summarizeThroughput(parsePlan, phaseTimings, parseWorkerResults) {
  if (!parsePlan) return null;
  const parsePhase = phaseTimings.find((phase) => phase.phaseName === 'parse');
  const parseSeconds = parsePhase?.durationMs ? parsePhase.durationMs / 1000 : null;
  const totalFiles = parsePlan.totalParseableFiles;
  const totalBytes = parsePlan.totalParseableBytes;
  const resultCounts = sumWorkerResultCounts(parseWorkerResults);
  return {
    parseFilesPerSec:
      parseSeconds && Number.isFinite(totalFiles) ? round(totalFiles / parseSeconds, 2) : null,
    parseMiBPerSec:
      parseSeconds && Number.isFinite(totalBytes)
        ? round(totalBytes / 1024 / 1024 / parseSeconds, 2)
        : null,
    parseSymbolsPerSec:
      parseSeconds && Number.isFinite(resultCounts.symbols)
        ? round(resultCounts.symbols / parseSeconds, 2)
        : null,
    parseCallsPerSec:
      parseSeconds && Number.isFinite(resultCounts.calls)
        ? round(resultCounts.calls / parseSeconds, 2)
        : null,
  };
}

function sumWorkerResultCounts(parseWorkerResults) {
  const totals = {};
  for (const event of parseWorkerResults ?? []) {
    for (const [key, count] of Object.entries(event.resultCounts ?? {})) {
      totals[key] = (totals[key] ?? 0) + count;
    }
  }
  return totals;
}

function renderPhaseRows(phaseTimings) {
  return phaseTimings
    .map((phase) => {
      const notes = [
        phase.rssBytes ? `RSS ${formatBytes(phase.rssBytes)}` : '',
        phase.heapUsedBytes ? `heap ${formatBytes(phase.heapUsedBytes)}` : '',
        Number.isFinite(phase.gcDurationMs) && phase.gcDurationMs > 0
          ? `GC ${formatMs(phase.gcDurationMs)}`
          : '',
        Number.isFinite(phase.gcCount) && phase.gcCount > 0 ? `${phase.gcCount} GC events` : '',
        Number.isFinite(phase.graphNodes) ? `${phase.graphNodes} nodes` : '',
        Number.isFinite(phase.graphRelationships) ? `${phase.graphRelationships} edges` : '',
      ]
        .filter(Boolean)
        .join('; ');
      return `| ${phase.phaseName} | ${formatMs(phase.durationMs)} | ${notes} |`;
    })
    .join('\n');
}

function renderChunkSummary(chunks) {
  if (!chunks.length) return '';
  return chunks
    .map(
      (chunk) =>
        `${chunk.chunkIndex}/${chunk.chunkCount}: ${chunk.chunkFiles} files, ${formatBytes(chunk.chunkBytes)}, ${formatMs(chunk.durationMs)}, RSS ${formatBytes(chunk.rssBytes)}`,
    )
    .join('; ');
}

function renderSubBatchSummary(subBatches) {
  if (!subBatches.length) return '';
  return subBatches
    .slice(-8)
    .map(
      (event) =>
        `chunk ${event.chunkIndex}/${event.chunkCount}, worker ${event.workerIndex}, sub-batch ${event.subBatchIndex}: ${formatBytes(event.payloadBytes)} ${event.firstFilePath ?? '?'} .. ${event.lastFilePath ?? '?'}`,
    )
    .join('; ');
}

function renderWorkerResultSummary(results) {
  if (!results.length) return '';
  return results
    .slice(-8)
    .map((event) => {
      const counts = event.resultCounts
        ? Object.entries(event.resultCounts)
            .filter(([, count]) => count > 0)
            .slice(0, 5)
            .map(([key, count]) => `${key}:${count}`)
            .join(', ')
        : '';
      return `chunk ${event.chunkIndex}/${event.chunkCount}, worker ${event.workerIndex}: ${formatBytes(event.resultBytes)}${counts ? ` (${counts})` : ''}`;
    })
    .join('; ');
}

function renderDegradedSummary(events) {
  if (!events.length) return '';
  const total = events.reduce((sum, event) => sum + (event.chunkFiles ?? 0), 0);
  const last = events[events.length - 1];
  return `${total} files across ${events.length} chunk event(s); last reason: ${last.degradedReason ?? 'unknown'}`;
}

function renderRelationshipDistributions(distributions) {
  if (!distributions) return '- unavailable';
  const { totalRelationships, byType, byProvenance } = distributions;
  const typeRows =
    byType && byType.length
      ? byType.map((entry) => `  - ${entry.type}: ${entry.count}`).join('\n')
      : '  - none';
  return `- Total relationships: ${totalRelationships}
- By provenance: extracted ${byProvenance.extracted}, inferred ${byProvenance.inferred}, ambiguous ${byProvenance.ambiguous}
- By type:
${typeRows}`;
}

function renderGraphQuality(quality) {
  if (!quality) return '- not evaluated';
  if (quality.status === 'pass') return '- Status: pass';
  const failures = (quality.failures ?? []).map((failure) => `  - ${failure}`).join('\n');
  return `- Status: ${quality.status}\n- Failures:\n${failures || '  - none'}`;
}

function renderTopChildProcesses(processes) {
  if (!processes?.length) return '';
  return processes
    .map((sample) => `${sample.pid}:${sample.command || 'unknown'} ${sample.rssKiB} KiB`)
    .join('; ');
}

function renderPeakRssThreshold(maxPeakRssMib, threshold) {
  if (maxPeakRssMib === null || maxPeakRssMib === undefined) return 'not requested';
  if (!threshold) return `${maxPeakRssMib} MiB (not evaluated)`;
  if (threshold.status === 'rss-unavailable') {
    return `${maxPeakRssMib} MiB threshold; peak RSS unavailable (failed closed)`;
  }
  const observed = Number.isFinite(threshold.peakRssMib)
    ? `${threshold.peakRssMib} MiB`
    : 'unavailable';
  const label = threshold.status === 'exceeded' ? 'exceeded' : 'within';
  return `${observed} vs ${maxPeakRssMib} MiB (${label})`;
}

function renderThroughput(throughput) {
  if (!throughput) return '';
  return [
    Number.isFinite(throughput.parseFilesPerSec) ? `${throughput.parseFilesPerSec} files/sec` : '',
    Number.isFinite(throughput.parseMiBPerSec) ? `${throughput.parseMiBPerSec} MiB/sec` : '',
    Number.isFinite(throughput.parseSymbolsPerSec)
      ? `${throughput.parseSymbolsPerSec} symbols/sec`
      : '',
    Number.isFinite(throughput.parseCallsPerSec) ? `${throughput.parseCallsPerSec} calls/sec` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function renderCrossFilePlan(plan) {
  if (!plan) return '';
  return [
    Number.isFinite(plan.crossFileFilesWithGaps)
      ? `${plan.crossFileFilesWithGaps} files with seedable gaps`
      : '',
    Number.isFinite(plan.crossFileGapRatio)
      ? `${(plan.crossFileGapRatio * 100).toFixed(1)}% gap ratio`
      : '',
    Number.isFinite(plan.crossFileLevelCount) ? `${plan.crossFileLevelCount} import levels` : '',
    Number.isFinite(plan.crossFileCycleCount) ? `${plan.crossFileCycleCount} cyclic files` : '',
    Number.isFinite(plan.crossFileMaxReprocess) ? `cap ${plan.crossFileMaxReprocess} files` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function renderSlowestCrossFileFiles(files) {
  if (!files?.length) return '';
  return files
    .map(
      (file) =>
        `${file.filePath} (${file.language ?? 'unknown'}): ${formatMs(file.durationMs)}, seeded ${file.seededBindings ?? 0}, returns ${file.importedReturnTypes ?? 0}, raw returns ${file.importedRawReturnTypes ?? 0}`,
    )
    .join('; ');
}

function renderFtsIndexSummary(steps) {
  if (!steps.length) return '';
  const completed = steps.filter((step) => step.event === 'fts-index-end');
  const skipped = steps.filter((step) => step.event === 'fts-index-skip');
  const completedRows = completed.reduce((sum, step) => sum + (step.rowCount ?? 0), 0);
  const skippedLabels = skipped.map((step) => `${step.table}:${step.reason ?? 'skipped'}`);
  return [
    `${completed.length} built (${completedRows} rows)`,
    skipped.length ? `${skipped.length} skipped (${skippedLabels.join(', ')})` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function renderSlowestFtsIndexes(steps) {
  const completed = steps
    .filter((step) => step.event === 'fts-index-end' && Number.isFinite(step.durationMs))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 8);
  if (!completed.length) return '';
  return completed
    .map(
      (step) =>
        `${step.table}:${step.indexName} ${step.rowCount ?? 0} rows [${(step.properties ?? []).join(',')}] in ${formatMs(step.durationMs)}`,
    )
    .join('; ');
}

function renderLbugStepSummary(steps) {
  if (!steps.length) return '';
  const lastByEvent = new Map();
  for (const step of steps) lastByEvent.set(step.lbugEvent ?? step.event, step);
  return [...lastByEvent.values()]
    .map((step) => {
      const event = step.lbugEvent ?? step.event;
      if (event === 'csv-end') {
        return `CSV ${formatMs(step.durationMs)} (${step.nodeFileCount ?? 0} node files)`;
      }
      if (event === 'rel-split-end') {
        return `relationship split ${formatMs(step.durationMs)} (${step.rows ?? 0} rows, ${step.relationshipPairCount ?? 0} pairs)`;
      }
      if (event === 'node-copy-end') {
        return `last node ${step.table}: ${step.rows ?? 0} rows in ${formatMs(step.durationMs)}`;
      }
      if (event === 'edge-copy-end') {
        return `last edge ${step.fromLabel}->${step.toLabel}: ${step.rows ?? 0} rows in ${formatMs(step.durationMs)}`;
      }
      return event;
    })
    .join('; ');
}

function renderSlowestLbugSteps(steps) {
  const completed = steps
    .filter((step) => Number.isFinite(step.durationMs))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 8);
  if (!completed.length) return '';
  return completed
    .map((step) => {
      const event = step.lbugEvent ?? step.event;
      if (event === 'node-copy-end') {
        return `${step.table}: ${step.rows ?? 0} rows, ${formatMs(step.durationMs)}`;
      }
      if (event === 'edge-copy-end') {
        return `${step.fromLabel}->${step.toLabel}: ${step.rows ?? 0} rows, ${formatMs(step.durationMs)}`;
      }
      return `${event}: ${formatMs(step.durationMs)}`;
    })
    .join('; ');
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) {
    return `${gib.toFixed(2)} GiB`;
  }
  const mib = bytes / 1024 / 1024;
  if (mib >= 1) {
    return `${mib.toFixed(1)} MiB`;
  }
  const kib = bytes / 1024;
  return `${kib.toFixed(1)} KiB`;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export {
  parseArgs,
  runBenchmark,
  runScenarioManifest,
  renderMarkdown,
  evaluatePeakRssThreshold,
  summarizeTelemetry,
  renderRelationshipDistributions,
  renderGraphQuality,
  parseScenarioManifest,
  evaluateScenarioPreflight,
  normalizeRemoteIdentity,
  evaluateGraphQuality,
  scenarioToBenchmarkOptions,
  listScenarioSummaries,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.scenarioManifest) {
      await runScenarioManifest(opts);
    } else {
      await runBenchmark(opts);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    process.exit(1);
  }
}
