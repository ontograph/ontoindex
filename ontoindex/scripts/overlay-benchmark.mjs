#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const maxSourceBytes = 128 * 1024;
const usage = `Usage: node scripts/overlay-benchmark.mjs [--sizes 1,10,25,50] [--repo <path>] [--cli <path>]

Benchmarks a disposable local clone; the source checkout and index are never modified.
Cold means the first overlay build at each size, not a flushed OS cache.
Warm median is the midpoint of two subsequent builds in fresh CLI processes.
`;

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.signal}`);
  }
  return result.stdout;
}

function parseArgs(argv) {
  const opts = {
    sizes: [1, 10, 25, 50],
    repo: null,
    cli: path.resolve(scriptDir, '../dist/cli/index.js'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return null;
    if (!['--sizes', '--repo', '--cli'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--sizes') {
      if (!/^\d+(,\d+)*$/.test(value)) throw new Error('--sizes must be comma-separated integers');
      opts.sizes = value.split(',').map(Number);
      if (opts.sizes.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 50)) {
        throw new Error('--sizes must contain integers from 1 to 50 (the CLI overlay limit)');
      }
      if (new Set(opts.sizes).size !== opts.sizes.length)
        throw new Error('--sizes contains duplicates');
    } else {
      opts[arg.slice(2)] = path.resolve(value);
    }
  }
  return opts;
}

async function sourceFiles(repo) {
  const files = git(['ls-files', '-z'], repo).split('\0').filter(Boolean).sort();
  const selected = [];
  for (const file of files) {
    if (
      !file.endsWith('.ts') ||
      file.endsWith('.d.ts') ||
      /(^|\/)(\.[^/]+|tests?|__tests__|fixtures?|__fixtures__|__mocks__|suite|dist|build|node_modules)(\/|$)/i.test(
        file,
      ) ||
      /\.(test|spec|bench)\.ts$/i.test(file)
    )
      continue;
    const stat = await fs.lstat(path.join(repo, file));
    if (stat.isFile() && stat.size <= maxSourceBytes) selected.push(file);
  }
  return selected;
}

async function directoryBytes(dir) {
  let bytes = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(file);
    else if (entry.isFile()) bytes += (await fs.stat(file)).size;
  }
  return bytes;
}

async function analyze(cli, repo, env, overlay, signal) {
  const args = [cli, 'analyze', repo, '--skip-agents-md'];
  if (overlay) args.push('--dirty-overlay');
  const start = process.hrtime.bigint();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let childError;
    const abort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (error) => {
      childError = error;
    });
    child.on('close', (code, childSignal) => {
      signal.removeEventListener('abort', abort);
      if (childError) reject(childError);
      else if (code !== 0)
        reject(
          new Error(
            `analyze${overlay ? ' --dirty-overlay' : ''} failed (${childSignal || code}):\n${output.slice(-16000)}`,
          ),
        );
      else resolve({ ms: Number(process.hrtime.bigint() - start) / 1e6, output });
    });
  });
  signal.throwIfAborted();
  const counts = overlay
    ? /Dirty overlay built:\s*([\d,]+) file\(s\),\s*([\d,]+) nodes,\s*([\d,]+) edges/.exec(
        result.output,
      )
    : /([\d,]+) nodes\s*\|\s*([\d,]+) edges/.exec(result.output);
  if (!counts) throw new Error(`Missing CLI graph counts:\n${result.output.slice(-16000)}`);
  const numbers = counts.slice(1).map((value) => Number(value.replaceAll(',', '')));
  return overlay
    ? { ms: result.ms, files: numbers[0], nodes: numbers[1], edges: numbers[2] }
    : { ms: result.ms, nodes: numbers[0], edges: numbers[1] };
}

async function main() {
  if (process.argv.includes('--automatic')) {
    const automatic = await import('./overlay-benchmark-automatic.mjs');
    if (process.argv.includes('--help') || process.argv.includes('-h'))
      return console.log(automatic.usage);
    const artifact = await automatic.runAutomatic(
      automatic.parseAutomaticArgs(process.argv.slice(2)),
    );
    const failed = artifact.workloads.filter((w) => !w.budgets.pass);
    console.error(
      failed.length
        ? `Budget failures: ${JSON.stringify(failed.map((w) => ({ size: w.size, phase: w.phase, failures: w.budgets.failures })))}`
        : 'All declared budgets passed.',
    );
    process.exitCode = failed.length ? 2 : 0;
    return;
  }
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.log(usage);
    return;
  }
  try {
    if (!(await fs.stat(opts.cli)).isFile()) throw new Error('not a file');
  } catch (error) {
    throw new Error(
      `Built CLI missing or unreadable at ${opts.cli}; run npm run build in ontoindex/ or pass --cli <path>. (${error.message})`,
    );
  }
  const repo = git(
    ['rev-parse', '--show-toplevel'],
    opts.repo || path.resolve(scriptDir, '..'),
  ).trim();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-overlay-benchmark-'));
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Benchmark interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const clone = path.join(temp, 'repo');
    git(['clone', '--no-hardlinks', '--depth', '1', '--', pathToFileURL(repo).href, clone], temp);
    const commit = git(['rev-parse', 'HEAD'], clone).trim();
    const files = await sourceFiles(clone);
    const largest = Math.max(...opts.sizes);
    if (files.length < largest)
      throw new Error(`Only ${files.length} eligible tracked .ts files; ${largest} required`);
    const env = { ...process.env, ONTOINDEX_HOME: path.join(temp, 'home') };
    for (const key of Object.keys(env)) {
      if (key.startsWith('ONTOINDEX_EMBEDDING_')) delete env[key];
    }
    const machine = {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      loadAverageStart: os.loadavg(),
    };
    console.error(`Baseline analyze: ${commit} (embeddings disabled, temporary clone)`);
    const baseline = await analyze(opts.cli, clone, env, false, controller.signal);
    console.error(
      `Baseline: ${baseline.ms.toFixed(1)} ms; ${baseline.nodes} nodes, ${baseline.edges} edges`,
    );
    const results = [];
    const overlayDir = path.join(clone, '.ontoindex', 'overlay');
    for (const size of opts.sizes) {
      controller.signal.throwIfAborted();
      const selected = files.slice(0, size);
      await fs.rm(overlayDir, { recursive: true, force: true });
      try {
        for (const file of selected) {
          await fs.appendFile(
            path.join(clone, file),
            '\n// ontoindex overlay benchmark: harmless dirty edit\n',
          );
        }
        const runs = [];
        for (let run = 0; run < 3; run++) {
          console.error(`${size} dirty files: ${run === 0 ? 'cold' : `warm ${run}`} build`);
          const measured = await analyze(opts.cli, clone, env, true, controller.signal);
          if (measured.files !== size)
            throw new Error(`Expected ${size} overlay files, CLI reported ${measured.files}`);
          const { resolveOverlayDbPath } = await import(
            pathToFileURL(path.resolve(path.dirname(opts.cli), '../mcp/local/backend-overlay.js'))
              .href
          );
          const overlayDbPath = await resolveOverlayDbPath(path.dirname(overlayDir));
          if (!overlayDbPath) throw new Error('CLI did not publish an overlay CURRENT generation');
          runs.push({
            ...measured,
            overlayDbPath,
            overlayBytes: await directoryBytes(path.dirname(overlayDbPath)),
          });
        }
        const warm = runs
          .slice(1)
          .map((run) => run.ms)
          .sort((a, b) => a - b);
        results.push({
          size,
          coldMs: runs[0].ms,
          warmMedianMs: (warm[0] + warm[1]) / 2,
          warmMinMs: warm[0],
          warmMaxMs: warm[1],
          nodes: runs[2].nodes,
          edges: runs[2].edges,
          overlayBytes: runs[2].overlayBytes,
          sourceFiles: selected,
          runs,
        });
      } finally {
        git(['checkout', '--', ...selected], clone);
      }
    }
    machine.loadAverageEnd = os.loadavg();
    console.error(
      '\nFiles  Cold ms  Warm median ms  Warm min ms  Warm max ms  Nodes  Edges  Overlay bytes',
    );
    for (const row of results) {
      console.error(
        `${row.size}  ${row.coldMs.toFixed(1)}  ${row.warmMedianMs.toFixed(1)}  ${row.warmMinMs.toFixed(1)}  ${row.warmMaxMs.toFixed(1)}  ${row.nodes}  ${row.edges}  ${row.overlayBytes}`,
      );
    }
    console.error(
      'Cold = first build per size (OS caches not flushed). Warm = two repeat builds; shared-host load can dominate timings. Overlay bytes = logical file sizes, not allocated disk blocks.',
    );
    console.log(
      JSON.stringify(
        {
          machine,
          nodeVersion: process.version,
          commit,
          cli: opts.cli,
          baselineMs: baseline.ms,
          baseline,
          maxSourceBytes,
          results,
          caveats: [
            'Local clone contains committed HEAD only; the CLI is the supplied host build.',
            'Cold is first build per size, not cold OS caches; every run starts a fresh CLI process.',
            'Warm median uses two samples (their midpoint); see min/max and individual runs.',
            'Overlay bytes are logical file sizes; .ts files over 128 KiB, declarations and tests are excluded.',
            'No CPU, memory or filesystem isolation from other host jobs.',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

main().catch((error) => {
  console.error(`Overlay benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
