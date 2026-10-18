// Measures normal read preparation (ONTOINDEX_AUTO_WORKSPACE=1) through a real stdio MCP server.
// Contract: .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md, "Validation and measurement contract".
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BUDGETS,
  evaluateBudgets,
  parseGnuTime,
  parseProcStat,
  parseVmRssKb,
  processTreeRssBytes,
  summarize,
  validateSample,
} from './overlay-benchmark-stats.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const STDERR_LIMIT = 16 * 1024 ** 2;
export const EXTRA_CASES = ['config', 'contention', 'parity'];
/** A tracked resolver configuration that the snapshot must treat as an input. */
const CONFIG_FILE = 'ontoindex/tsconfig.json';
const BUSY_RETRY_MS = 500;
const BUSY_ANSWER =
  /already running|Cannot safely recover|recovering the analyze lock|build started by this server is still running|is currently being rebuilt/i;
const CALL_TIMEOUT_MS = 300_000;
const SAMPLE_MS = 20;
const NATIVE_ERROR =
  /Buffer manager exception|Unable to allocate|buffer pool is full|SIGSEGV|Segmentation fault/i;
export const usage = `Usage: node scripts/overlay-benchmark.mjs --automatic --output <file> [--pilot]
  [--sizes 0,1,50,51|none] [--extras config,contention,parity|none] [--repetitions 20] [--repo <path>] [--cli <path>]
--pilot measures one cold size-1 read. --output writes the artifact plus <file>.raw/ references.
Needs a built CLI, GNU time at /usr/bin/time and Linux /proc.`;

export function parseAutomaticArgs(argv) {
  const opts = {
    sizes: [0, 1, 50, 51],
    extras: ['config', 'contention', 'parity'],
    repetitions: 20,
    pilot: false,
    output: null,
    repo: null,
    cli: path.resolve(scriptDir, '../dist/cli/index.js'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--automatic') continue;
    if (arg === '--pilot') {
      opts.pilot = true;
      continue;
    }
    if (!['--sizes', '--extras', '--repetitions', '--output', '--repo', '--cli'].includes(arg))
      throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--extras') {
      const names = value === 'none' ? [] : value.split(',');
      if (names.some((n) => !EXTRA_CASES.includes(n)) || new Set(names).size !== names.length)
        throw new Error(`--extras must be unique names from ${EXTRA_CASES.join(',')} or none`);
      opts.extras = names;
    } else if (arg === '--sizes') {
      if (value === 'none') opts.sizes = [];
      else if (!/^\d+(,\d+)*$/.test(value))
        throw new Error('--sizes must be comma-separated integers or none');
      else opts.sizes = value.split(',').map(Number);
      if (opts.sizes.some((n) => n > 51) || new Set(opts.sizes).size !== opts.sizes.length)
        throw new Error('--sizes must be unique integers from 0 to 51');
    } else if (arg === '--repetitions') {
      if (!/^[1-9]\d*$/.test(value)) throw new Error('--repetitions must be a positive integer');
      opts.repetitions = Number(value);
    } else opts[arg.slice(2)] = path.resolve(value);
  }
  if (!opts.output) throw new Error('--output is required');
  if (opts.pilot) {
    opts.sizes = [1];
    opts.extras = [];
    opts.repetitions = 1;
  }
  return opts;
}

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });

function readProcessTable() {
  const records = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const { pid, ppid } = parseProcStat(fs.readFileSync(`/proc/${entry}/stat`, 'utf8'));
      records.push({ pid, ppid, rssKb: 0 });
    } catch {
      /* process exited while scanning */
    }
  }
  return records;
}

function treeMembers(records, root) {
  const members = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of records)
      if (members.has(r.ppid) && !members.has(r.pid)) {
        members.add(r.pid);
        grew = true;
      }
  }
  return members;
}

function sampleTree(root, state) {
  const table = readProcessTable();
  const members = treeMembers(table, root);
  for (const r of table) {
    if (!members.has(r.pid)) continue;
    state.seen.add(r.pid);
    try {
      r.rssKb = parseVmRssKb(fs.readFileSync(`/proc/${r.pid}/status`, 'utf8')) ?? 0;
    } catch {
      /* exited */
    }
  }
  const bytes = processTreeRssBytes(
    table.filter((r) => members.has(r.pid)),
    root,
  );
  state.peak = Math.max(state.peak, bytes);
  const now = performance.now();
  state.maxGapMs = Math.max(state.maxGapMs, now - state.last);
  state.last = now;
  state.count++;
}

function treeCpuTicks(root) {
  const table = readProcessTable();
  let ticks = 0;
  for (const pid of treeMembers(table, root)) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ticks += Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]);
    } catch {
      /* exited */
    }
  }
  return ticks / Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const generations = (repo) => {
  try {
    return fs
      .readdirSync(path.join(repo, '.ontoindex', 'overlay'))
      .filter((n) => n !== 'CURRENT' && !n.startsWith('.'));
  } catch {
    return [];
  }
};

async function loadSdk() {
  const base = path.resolve(scriptDir, '../node_modules/@modelcontextprotocol/sdk/dist/esm/client');
  const { Client } = await import(pathToFileURL(path.join(base, 'index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(path.join(base, 'stdio.js')).href);
  return { Client, StdioClientTransport };
}

/** One sample: a fresh server process, optionally an untimed preparation read, one timed read. */
export async function runSample(
  ctx,
  {
    size,
    phase,
    symbol,
    rawDir,
    label,
    caseName,
    expectWorkspace,
    retryBusy,
    buildsBefore,
    barrier,
    flagOff,
  },
) {
  const { Client, StdioClientTransport } = ctx.sdk;
  const timeFile = path.join(ctx.temp, `time-${label}.txt`);
  // The benchmark corpus may exceed the default build gate; the gate has its own tests.
  const env = {
    ...ctx.env,
    ONTOINDEX_AUTO_WORKSPACE: '1',
    ONTOINDEX_WORKSPACE_MAX_FILES: String(ctx.maxFiles),
  };
  // The compatible baseline for the clean-gate budget: the same read with the feature off.
  if (flagOff) delete env.ONTOINDEX_AUTO_WORKSPACE;
  const transport = new StdioClientTransport({
    command: '/usr/bin/time',
    args: ['-f', '%x %U %S', '-o', timeFile, process.execPath, ctx.cli, 'mcp'],
    env,
    cwd: ctx.clone,
    stderr: 'pipe',
  });
  let stderrBytes = 0,
    stderrTruncated = false,
    stderrText = '';
  transport.stderr?.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > STDERR_LIMIT) stderrTruncated = true;
    else stderrText += chunk.toString('utf8');
  });
  const client = new Client({ name: 'adw-benchmark', version: '1' });
  const before = buildsBefore ?? new Set(generations(ctx.clone));
  await client.connect(transport);
  const root = transport.pid;
  const state = { peak: 0, seen: new Set(), count: 0, maxGapMs: 0, last: performance.now() };
  const timer = setInterval(() => sampleTree(root, state), SAMPLE_MS);
  const request = {
    name: 'inspect',
    arguments: { action: 'context', repo: ctx.repoName, target: symbol },
  };
  let busyRetries = 0;
  const call = async () => {
    const started = performance.now();
    for (;;) {
      // The SDK default is 60 s, the same as the server's wait limit; the harness must see the server's answer.
      const response = await client.callTool(request, undefined, { timeout: CALL_TIMEOUT_MS });
      const text = (response.content ?? []).map((c) => c.text ?? '').join('');
      // The server's retryable code is not part of the MCP text, so match the message a client sees.
      const busy = !!response.isError && BUSY_ANSWER.test(text);
      // A second client that finds the build owned elsewhere retries, as a real client would.
      if (busy && retryBusy && performance.now() - started < CALL_TIMEOUT_MS) {
        busyRetries++;
        await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
        continue;
      }
      return { ms: performance.now() - started, text, isError: !!response.isError };
    }
  };
  let cpuBefore = 0;
  if (phase === 'warm') {
    await call();
    cpuBefore = treeCpuTicks(root);
  }
  const measured = await call();
  const cpuSampled = phase === 'warm' ? treeCpuTicks(root) - cpuBefore : undefined;
  clearInterval(timer);
  // Contending clients stay up until every peer has its answer, so one's exit is not another's leftover.
  if (barrier) await barrier();
  const closeStart = performance.now();
  await client.close();
  const deadline = Date.now() + 10_000;
  while (alive(root) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  const cleanupMs = performance.now() - closeStart;
  const reaped = ![...state.seen].some(alive);
  const built = generations(ctx.clone).filter((n) => !before.has(n)).length;
  const leftovers = [
    path.join(ctx.clone, '.ontoindex', 'workspace-inputs'),
    path.join(ctx.clone, '.ontoindex', 'workspace-build.owner.json'),
  ].flatMap((p) => {
    try {
      return fs.statSync(p).isDirectory() ? fs.readdirSync(p) : [p];
    } catch {
      return [];
    }
  });
  let exit = { code: null, signal: 'unknown' },
    cpuSeconds = NaN;
  try {
    const last = fs.readFileSync(timeFile, 'utf8').trim().split(/\r?\n/).at(-1).split(/\s+/);
    exit = { code: Number(last[0]), signal: null };
    cpuSeconds = parseGnuTime(`${last[1]} ${last[2]}`).cpuSeconds;
  } catch {
    /* leaves NaN, which validateSample rejects */
  }
  if (phase === 'warm') cpuSeconds = cpuSampled;
  const wantsWorkspace = expectWorkspace ?? size > 0;
  const evidenceOk =
    !measured.isError &&
    /"status":\s*"found"/.test(measured.text) &&
    (wantsWorkspace
      ? /"source":\s*"workspace-graph"/.test(measured.text)
      : !/"source":\s*"workspace-graph"/.test(measured.text));
  fs.writeFileSync(path.join(rawDir, `${label}.request.json`), JSON.stringify(request));
  fs.writeFileSync(path.join(rawDir, `${label}.response.txt`), measured.text);
  fs.writeFileSync(path.join(rawDir, `${label}.stderr.txt`), stderrText);
  return {
    sample: {
      latencyMs: measured.ms,
      cpuSeconds,
      peakRssBytes: state.peak,
      responseBytes: Buffer.byteLength(measured.text),
      buildCount: built,
      cleanupMs,
      exit,
      childrenReaped: reaped && leftovers.length === 0,
      stderrBytes,
      stderrTruncated,
      nativeError: NATIVE_ERROR.test(stderrText),
    },
    meta: {
      label,
      size,
      case: caseName ?? `size-${size}`,
      flagOff: !!flagOff,
      phase,
      busyRetries,
      evidenceOk,
      leftovers,
      cpuSource: phase === 'warm' ? 'sampled' : 'gnu-time',
      rssSamples: state.count,
      maxSampleGapMs: Math.round(state.maxGapMs),
      processesSeen: state.seen.size,
    },
  };
}

/** The instrument must reject missing or failed measurements, not average over them. */
export function selfCheck() {
  const good = {
    latencyMs: 1,
    cpuSeconds: 1,
    peakRssBytes: 1,
    responseBytes: 1,
    buildCount: 0,
    cleanupMs: 1,
    exit: { code: 0, signal: null },
    childrenReaped: true,
    stderrBytes: 0,
    stderrTruncated: false,
    nativeError: false,
  };
  const bad = {
    missingMetric: { ...good, cpuSeconds: undefined },
    nonZeroExit: { ...good, exit: { code: 1, signal: null } },
    unreapedChild: { ...good, childrenReaped: false },
    truncatedStderr: { ...good, stderrTruncated: true },
    nativeError: { ...good, nativeError: true },
  };
  const results = Object.fromEntries(
    Object.entries(bad).map(([k, s]) => [k, !validateSample(s).ok]),
  );
  let summarizeRejects = false;
  try {
    summarize([good, bad.missingMetric]);
  } catch {
    summarizeRejects = true;
  }
  return {
    goodAccepted: validateSample(good).ok,
    rejected: results,
    summarizeRejects,
    pass: validateSample(good).ok && summarizeRejects && Object.values(results).every(Boolean),
  };
}

function pickSymbol(clone, files) {
  for (const f of files) {
    const m = /export (?:async )?function (\w+)/.exec(fs.readFileSync(path.join(clone, f), 'utf8'));
    if (m) return m[1];
  }
  throw new Error('No exported function found in the selected files');
}

/** The context answer without the trailing next-step hint, reduced to what parity compares. */
export function contextFingerprint(text) {
  const body = text.split('\n---\n')[0];
  const answer = JSON.parse(body);
  const uids = (group) => (group?.calls ?? []).map((c) => c.uid).sort();
  return {
    status: answer.status,
    symbol: answer.symbol?.uid ?? null,
    incoming: uids(answer.incoming),
    outgoing: uids(answer.outgoing),
  };
}

/** Differences between a working-tree answer and a full-graph reference for the same bytes. */
export function diffFingerprints(actual, reference) {
  const out = [];
  if (actual.status !== reference.status)
    out.push(`status ${actual.status} != ${reference.status}`);
  if (actual.symbol !== reference.symbol)
    out.push(`symbol ${actual.symbol} != ${reference.symbol}`);
  for (const side of ['incoming', 'outgoing']) {
    const have = new Set(actual[side]);
    const want = new Set(reference[side]);
    const missing = [...want].filter((u) => !have.has(u));
    const extra = [...have].filter((u) => !want.has(u));
    if (missing.length) out.push(`${side} missing ${missing.slice(0, 5).join(', ')}`);
    if (extra.length) out.push(`${side} extra ${extra.slice(0, 5).join(', ')}`);
  }
  return out;
}

const PARITY_PROBE = 'adwParityProbe';

export async function runAutomatic(opts) {
  if (process.platform !== 'linux') throw new Error('Automatic benchmark needs Linux /proc');
  fs.accessSync('/usr/bin/time', fs.constants.X_OK);
  if (!fs.statSync(opts.cli).isFile())
    throw new Error(`Built CLI missing at ${opts.cli}; run npm run build or pass --cli`);
  const checks = selfCheck();
  if (!checks.pass) throw new Error(`Instrument self-check failed: ${JSON.stringify(checks)}`);
  const repo = git(
    ['rev-parse', '--show-toplevel'],
    opts.repo || path.resolve(scriptDir, '..'),
  ).trim();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-adw-benchmark-'));
  const rawDir = `${opts.output}.raw`;
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });
  try {
    const clone = path.join(temp, 'repo');
    git(
      ['clone', '-q', '--no-hardlinks', '--depth', '1', '--', pathToFileURL(repo).href, clone],
      temp,
    );
    const commit = git(['rev-parse', 'HEAD'], clone).trim();
    const repoName = `adwbench${process.pid}`;
    const env = { ...process.env, ONTOINDEX_HOME: path.join(temp, 'home') };
    for (const key of Object.keys(env)) if (key.startsWith('ONTOINDEX_EMBEDDING_')) delete env[key];
    execFileSync(
      process.execPath,
      [opts.cli, 'analyze', clone, '--skip-agents-md', '--name', repoName],
      { cwd: clone, env, stdio: 'pipe' },
    );
    const eligible = git(['ls-files', '-z'], clone)
      .split('\0')
      .filter(
        (f) =>
          /\.ts$/.test(f) &&
          !/\.d\.ts$|(^|\/)(tests?|__tests__|fixtures?|dist|node_modules|\.[^/]+)(\/|$)|\.(test|spec)\.ts$/i.test(
            f,
          ) &&
          fs.statSync(path.join(clone, f)).size <= 128 * 1024,
      )
      .sort();
    const largest = Math.max(...opts.sizes);
    if (eligible.length < largest)
      throw new Error(`Only ${eligible.length} eligible .ts files; ${largest} required`);
    const symbol = pickSymbol(clone, eligible);
    const indexedFiles =
      JSON.parse(fs.readFileSync(path.join(clone, '.ontoindex', 'meta.json'), 'utf8')).stats
        ?.files ?? 0;
    const ctx = {
      temp,
      clone,
      env,
      cli: opts.cli,
      repoName,
      maxFiles: Math.max(indexedFiles + 100, 1600),
      sdk: await loadSdk(),
    };
    const machine = {
      hostname: os.hostname(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      loadAverageStart: os.loadavg(),
      node: process.version,
    };
    const workloads = [];
    const accept = (samples, metas, { sample, meta }, label, index) => {
      if (!meta.evidenceOk)
        throw new Error(
          `Sample ${meta.label} did not return the expected evidence (stale or failed answer); see ${rawDir}`,
        );
      const verdict = validateSample(sample);
      if (!verdict.ok)
        throw new Error(
          `Sample ${meta.label} invalid: ${verdict.reasons.join(', ')}; see ${rawDir}`,
        );
      samples.push(sample);
      metas.push(meta);
      console.error(
        `${label} ${index}/${opts.repetitions}: ${sample.latencyMs.toFixed(0)} ms, ${(sample.peakRssBytes / 1024 ** 2).toFixed(0)} MB, builds ${sample.buildCount}`,
      );
    };
    const overlayBytesNow = () => {
      const overlayDir = path.join(clone, '.ontoindex', 'overlay');
      return fs.existsSync(overlayDir)
        ? Number(execFileSync('du', ['-sb', overlayDir], { encoding: 'utf8' }).split('\t')[0])
        : 0;
    };
    const coldReset = () =>
      fs.rmSync(path.join(clone, '.ontoindex', 'overlay'), { recursive: true, force: true });
    for (const size of opts.sizes) {
      const edited = eligible.slice(0, size);
      for (const f of edited)
        fs.appendFileSync(path.join(clone, f), '\n// adw benchmark dirty edit\n');
      const phases = opts.pilot ? ['cold'] : ['cold', 'warm'];
      try {
        for (const phase of phases) {
          const samples = [],
            metas = [],
            baselineSamples = [],
            baselineMetas = [];
          for (let i = 0; i < opts.repetitions; i++) {
            if (phase === 'cold') coldReset();
            // Clean workload: alternate a flag-off read and a flag-on read so load drift hits both.
            if (size === 0)
              accept(
                baselineSamples,
                baselineMetas,
                await runSample(ctx, {
                  size,
                  phase,
                  symbol,
                  rawDir,
                  label: `s${size}-${phase}-baseline-${i}`,
                  flagOff: true,
                }),
                `size ${size} ${phase} baseline`,
                i + 1,
              );
            accept(
              samples,
              metas,
              await runSample(ctx, {
                size,
                phase,
                symbol,
                rawDir,
                label: `s${size}-${phase}-${i}`,
              }),
              `size ${size} ${phase}`,
              i + 1,
            );
          }
          const summary = summarize(samples);
          const baseline = baselineSamples.length ? summarize(baselineSamples) : undefined;
          const overlayBytes = overlayBytesNow();
          workloads.push({
            size,
            phase,
            workload: size === 0 ? 'clean' : 'dirty',
            summary,
            ...(baseline
              ? { baseline: { summary: baseline, samples: baselineSamples, metas: baselineMetas } }
              : {}),
            artifactBytes: overlayBytes,
            budgets: evaluateBudgets({
              phase,
              workload: size === 0 ? 'clean' : 'dirty',
              summary,
              artifactBytes: overlayBytes,
              baselineP95Ms: baseline?.latency.p95,
            }),
            samples,
            metas,
          });
        }
      } finally {
        if (edited.length) git(['checkout', '--', ...edited], clone);
      }
    }
    const extraWorkload = (name, phase, samples, metas, extra = {}) => {
      const summary = summarize(samples);
      const artifactBytes = overlayBytesNow();
      workloads.push({
        size: null,
        case: name,
        phase,
        workload: 'dirty',
        summary,
        artifactBytes,
        budgets: evaluateBudgets({ phase, workload: 'dirty', summary, artifactBytes }),
        ...extra,
        samples,
        metas,
      });
    };

    if (opts.extras.includes('config')) {
      // Whitespace-only edit of a tracked resolver configuration and nothing else: the planner
      // reports it as a configuration change, which selects a full working-tree graph.
      const configPath = path.join(clone, CONFIG_FILE);
      if (!fs.existsSync(configPath)) throw new Error(`${CONFIG_FILE} missing from the corpus`);
      fs.appendFileSync(configPath, '\n\n');
      try {
        for (const phase of opts.pilot ? ['cold'] : ['cold', 'warm']) {
          const samples = [],
            metas = [];
          for (let i = 0; i < opts.repetitions; i++) {
            if (phase === 'cold') coldReset();
            accept(
              samples,
              metas,
              await runSample(ctx, {
                size: 0,
                phase,
                symbol,
                rawDir,
                label: `config-${phase}-${i}`,
                caseName: 'config',
                expectWorkspace: true,
              }),
              `config ${phase}`,
              i + 1,
            );
          }
          extraWorkload('config', phase, samples, metas);
        }
      } finally {
        git(['checkout', '--', CONFIG_FILE], clone);
      }
    }

    if (opts.extras.includes('contention')) {
      // Two clients start together on one dirty tree with no generation: one must build, the
      // other must wait or join, and exactly one generation may result.
      const edited = eligible.slice(0, 1);
      for (const f of edited)
        fs.appendFileSync(path.join(clone, f), '\n// adw benchmark dirty edit\n');
      try {
        const samples = [],
          metas = [],
          writers = [];
        for (let i = 0; i < opts.repetitions; i++) {
          coldReset();
          const known = new Set(generations(clone));
          let arrived = 0;
          let release;
          const gate = new Promise((resolve) => (release = resolve));
          const barrier = async () => {
            if (++arrived === 2) release();
            await gate;
          };
          const pair = await Promise.all(
            ['a', 'b'].map((who) =>
              runSample(ctx, {
                size: 1,
                phase: 'cold',
                symbol,
                rawDir,
                label: `contention-${i}-${who}`,
                caseName: 'contention',
                expectWorkspace: true,
                retryBusy: true,
                buildsBefore: known,
                barrier,
              }),
            ),
          );
          const created = generations(clone).filter((n) => !known.has(n)).length;
          if (created !== 1) {
            const names = generations(clone).filter((n) => !known.has(n));
            fs.writeFileSync(
              path.join(rawDir, `contention-${i}.generations.json`),
              JSON.stringify({
                names,
                answers: pair.map((r) => ({
                  label: r.meta.label,
                  evidenceOk: r.meta.evidenceOk,
                  busyRetries: r.meta.busyRetries,
                  builds: r.sample.buildCount,
                  latencyMs: r.sample.latencyMs,
                })),
              }),
            );
            throw new Error(
              `Contention round ${i + 1} created ${created} generations (${names.join(', ')}), expected exactly one writer; see ${rawDir}`,
            );
          }
          writers.push(created);
          pair.forEach((result, who) =>
            accept(samples, metas, result, `contention ${who ? 'b' : 'a'}`, i + 1),
          );
        }
        extraWorkload('contention', 'cold', samples, metas, {
          rounds: opts.repetitions,
          writersPerRound: writers,
        });
      } finally {
        if (edited.length) git(['checkout', '--', ...edited], clone);
      }
    }
    if (opts.extras.includes('parity')) {
      // Semantic edit: a new exported function that calls the probed symbol. The working-tree
      // answer must equal a full analyze of the same bytes, including the new caller.
      const target = eligible.find((f) =>
        new RegExp(`export (?:async )?function ${symbol}\\b`).test(
          fs.readFileSync(path.join(clone, f), 'utf8'),
        ),
      );
      if (!target) throw new Error(`No file exports ${symbol} for the parity edit`);
      const probe = `\nexport function ${PARITY_PROBE}(...args: Parameters<typeof ${symbol}>) {\n  return ${symbol}(...args);\n}\n`;
      const refRoot = path.join(temp, 'reference');
      fs.mkdirSync(refRoot);
      const refClone = path.join(refRoot, 'repo');
      git(['clone', '-q', '--no-hardlinks', '--', clone, refClone], refRoot);
      fs.appendFileSync(path.join(refClone, target), probe);
      git(['add', '-A'], refClone);
      git(
        [
          '-c',
          'user.name=adw',
          '-c',
          'user.email=adw@example.invalid',
          'commit',
          '-q',
          '-m',
          'parity',
        ],
        refClone,
      );
      const refName = `${repoName}ref`;
      const refEnv = { ...env, ONTOINDEX_HOME: path.join(temp, 'ref-home') };
      execFileSync(
        process.execPath,
        [opts.cli, 'analyze', refClone, '--skip-agents-md', '--name', refName],
        { cwd: refClone, env: refEnv, stdio: 'pipe' },
      );
      const reference = await runSample(
        { ...ctx, clone: refClone, env: refEnv, repoName: refName },
        {
          size: 0,
          phase: 'cold',
          symbol,
          rawDir,
          label: 'parity-reference',
          caseName: 'parity-reference',
          expectWorkspace: false,
          flagOff: true,
        },
      );
      if (!reference.meta.evidenceOk)
        throw new Error(`Parity reference did not answer; see ${rawDir}`);
      const referencePrint = contextFingerprint(
        fs.readFileSync(path.join(rawDir, 'parity-reference.response.txt'), 'utf8'),
      );
      if (!referencePrint.incoming.some((uid) => uid.includes(PARITY_PROBE)))
        throw new Error(
          `Parity reference does not show the new caller ${PARITY_PROBE}; the edit is not exercising the graph`,
        );
      fs.appendFileSync(path.join(clone, target), probe);
      const samples = [],
        metas = [],
        differences = [];
      try {
        for (let i = 0; i < opts.repetitions; i++) {
          coldReset();
          const label = `parity-${i}`;
          const result = await runSample(ctx, {
            size: 1,
            phase: 'cold',
            symbol,
            rawDir,
            label,
            caseName: 'parity',
            expectWorkspace: true,
          });
          accept(samples, metas, result, 'parity', i + 1);
          const diff = diffFingerprints(
            contextFingerprint(fs.readFileSync(path.join(rawDir, `${label}.response.txt`), 'utf8')),
            referencePrint,
          );
          differences.push(diff);
          if (diff.length) throw new Error(`Parity round ${i + 1} differs: ${diff.join('; ')}`);
        }
      } finally {
        git(['checkout', '--', target], clone);
      }
      extraWorkload('parity', 'cold', samples, metas, {
        reference: referencePrint,
        differencesPerRound: differences,
      });
    }
    machine.loadAverageEnd = os.loadavg();
    const artifact = {
      mode: opts.pilot ? 'pilot' : 'matrix',
      commit,
      cli: opts.cli,
      machine,
      repetitions: opts.repetitions,
      extras: opts.extras,
      eligibleFiles: eligible.length,
      indexedFiles: JSON.parse(fs.readFileSync(path.join(clone, '.ontoindex', 'meta.json'), 'utf8'))
        .stats?.files,
      budgetsDeclared: { ...BUDGETS, cleanGateOverheadMs: 'max(100, 0.25 * baselineP95)' },
      selfCheck: checks,
      workloads,
      caveats: [
        'The build file gate (ONTOINDEX_WORKSPACE_MAX_FILES) is raised for the run when the corpus exceeds it.',
        'Cold: fresh server process and no matching workspace generation; OS caches are not flushed.',
        'Warm CPU is sampled from /proc deltas, not terminal GNU time, so it cannot prove the CPU ceiling.',
        'Process-tree RSS is sampled every 20 ms where the scan keeps up (see maxSampleGapMs); it is not an exact native peak.',
        'Contention: two server processes read one dirty clone together; each retries a retryable workspace_busy answer every 500 ms. The invariant checked is exactly one new generation per round; lock exclusivity itself is not observed.',
        'Clean-gate overhead compares size 0 against a flag-off read of the same clean tree, alternated per repetition. No same-input full-graph parity check.',
      ],
    };
    fs.writeFileSync(opts.output, JSON.stringify(artifact, null, 2));
    return artifact;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
