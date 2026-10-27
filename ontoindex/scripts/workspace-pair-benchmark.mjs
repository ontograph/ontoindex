import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { startMemorySampling } from './benchmark-memory.mjs';

const retention = { timeoutMs: 120000, maxBytes: 67108864 };
const kinds = ['full', 'capture', 'replay'];

export function evaluateWorkspacePair(legs) {
  const failures = [];
  if (!Array.isArray(legs) || legs.length !== 3) {
    return { passed: false, failures: ['Expected full, capture, and replay legs'] };
  }
  const normalizedGraph = (graph) => ({
    nodes: Array.isArray(graph?.nodes) ? [...graph.nodes].sort() : null,
    edges: Array.isArray(graph?.edges) ? [...graph.edges].sort() : null,
  });
  for (const [index, leg] of legs.entries()) {
    const base = leg?.base;
    if (leg?.kind !== kinds[index]) failures.push(`Unexpected leg order at ${index}`);
    if (!Number.isFinite(leg?.elapsedMs) || leg.elapsedMs < 0)
      failures.push(`${kinds[index]} elapsed time unavailable`);
    if (
      base?.capability !== 'workspace-graph' ||
      base?.coverage !== 'complete' ||
      base?.parseErrorCount !== 0
    ) {
      failures.push(`${kinds[index]} requires complete workspace coverage and zero parse errors`);
    }
    if (base?.buildTimings?.parseMode !== (index === 2 ? 'retained-replay' : 'full')) {
      failures.push(`${kinds[index]} parse mode mismatch (fallback refused)`);
    }
    for (const field of ['manifestDigest', 'parserIdentity', 'head']) {
      if (typeof base?.[field] !== 'string' || !base[field])
        failures.push(`${kinds[index]} missing ${field}`);
    }
    if (
      !/^[a-f0-9]{64}$/.test(base?.manifestDigest ?? '') ||
      !/^[a-f0-9]{64}$/.test(base?.parserIdentity ?? '') ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base?.head ?? '')
    )
      failures.push(`${kinds[index]} invalid source/parser/commit identity`);
    if (
      !Object.hasOwn(base ?? {}, 'configurationDigest') ||
      (base.configurationDigest !== null && !/^[a-f0-9]{64}$/.test(base.configurationDigest))
    ) {
      failures.push(`${kinds[index]} missing or invalid configurationDigest`);
    }
    if (
      base?.baseGenerationId !== null &&
      (typeof base?.baseGenerationId !== 'string' || !base.baseGenerationId)
    ) {
      failures.push(`${kinds[index]} missing baseGenerationId`);
    }
    if (
      !Array.isArray(leg?.graph?.nodes) ||
      leg.graph.nodes.length === 0 ||
      !Array.isArray(leg?.graph?.edges) ||
      leg.graph.edges.length === 0 ||
      !leg.graph.nodes.every((value) => typeof value === 'string') ||
      !leg.graph.edges.every((value) => typeof value === 'string')
    ) {
      failures.push(`${kinds[index]} graph is empty or unavailable`);
    }
    if (index > 0 && leg?.candidateComplete !== true)
      failures.push(`${kinds[index]} candidate incomplete`);
    if (index > 0) {
      for (const field of [
        'manifestDigest',
        'parserIdentity',
        'head',
        'baseGenerationId',
        'configurationDigest',
      ]) {
        if (base?.[field] !== legs[0]?.base?.[field])
          failures.push(`${kinds[index]} ${field} mismatch`);
      }
      if (!isDeepStrictEqual(normalizedGraph(leg?.graph), normalizedGraph(legs[0]?.graph)))
        failures.push(`${kinds[index]} graph parity mismatch`);
    }
  }
  return { passed: failures.length === 0, failures };
}

export function canonicalGraphValue(value, omittedRootKeys = []) {
  const ancestors = new Set();
  const encode = (current, root = false) => {
    if (current === null) return ['null'];
    switch (typeof current) {
      case 'string':
      case 'boolean':
        return [typeof current, current];
      case 'bigint':
        return ['bigint', current.toString()];
      case 'number':
        if (!Number.isFinite(current)) throw new TypeError('Non-finite graph number');
        return ['number', Object.is(current, -0) ? '-0' : current];
      case 'object':
        break;
      default:
        throw new TypeError(`Unsupported graph value: ${typeof current}`);
    }
    if (ancestors.has(current)) throw new TypeError('Cyclic graph value');
    ancestors.add(current);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Array.isArray(current)) {
        if (Reflect.ownKeys(descriptors).length !== current.length + 1)
          throw new TypeError('Invalid graph array');
        return [
          'array',
          Array.from({ length: current.length }, (_, index) => {
            const descriptor = descriptors[index];
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
              throw new TypeError('Invalid graph array entry');
            return encode(descriptor.value);
          }),
        ];
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('Unsupported graph object');
      return [
        'object',
        Reflect.ownKeys(descriptors)
          .filter((key) => !(root && omittedRootKeys.includes(key)))
          .sort()
          .map((key) => {
            const descriptor = descriptors[key];
            if (
              typeof key !== 'string' ||
              !descriptor.enumerable ||
              !Object.hasOwn(descriptor, 'value')
            ) {
              throw new TypeError('Unsupported graph property');
            }
            return [key, encode(descriptor.value)];
          }),
      ];
    } finally {
      ancestors.delete(current);
    }
  };
  return JSON.stringify(encode(value, true));
}

export async function readGraph(file) {
  const { default: lbug } = await import('@ladybugdb/core');
  const database = new lbug.Database(file, 0, true, true, 2 ** 32);
  let connection;
  try {
    connection = new lbug.Connection(database);
    const query = async (cypher) => {
      const response = await connection.query(cypher);
      const results = Array.isArray(response) ? response : [response];
      try {
        return await results[0].getAll();
      } finally {
        for (const result of results) result.close();
      }
    };
    return {
      nodes: (await query('MATCH (n) RETURN n AS node'))
        .map((row) => canonicalGraphValue(row.node, ['_id']))
        .sort(),
      edges: (
        await query('MATCH (a)-[r]->(b) RETURN a.id AS source, r AS relationship, b.id AS target')
      )
        .map((row) =>
          canonicalGraphValue({
            source: row.source,
            target: row.target,
            relationship: canonicalGraphValue(row.relationship, ['_id', '_src', '_dst']),
          }),
        )
        .sort(),
    };
  } finally {
    try {
      await connection?.close();
    } finally {
      await database.close();
    }
  }
}

function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
  };
}

function markdown(record) {
  return (
    `# Workspace pair benchmark: ${record.repository}\n\nRun: ${record.runId}\n\nResult: ${record.outcome.result}\n\n` +
    '| Pair | Leg | Whole child ms | Sampled peak RSS MiB | Parse mode | Coverage |\n| --- | --- | ---: | ---: | --- | --- |\n' +
    record.pairs
      .flatMap((pair, index) =>
        pair.legs.map(
          (leg) =>
            `| ${index + 1} | ${leg.kind} | ${leg.elapsedMs.toFixed(2)} | ${leg.memory?.peakMemory ? (leg.memory.peakMemory.totalRssKiB / 1024).toFixed(2) : 'unavailable'} | ${leg.base.buildTimings?.parseMode} | ${leg.base.coverage} |`,
        ),
      )
      .join('\n') +
    '\n\nPublished-generation validation (getOverlaySnapshot only):\n\n' +
    '| Pair | Validation ms | Generation |\n| --- | ---: | --- |\n' +
    record.pairs
      .flatMap((pair, index) =>
        pair.reuse
          ? [`| ${index + 1} | ${pair.reuse.elapsedMs.toFixed(2)} | ${pair.reuse.generation} |`]
          : [],
      )
      .join('\n') +
    `\n\nSummary (elapsed values in milliseconds; sampledPeakRssMib in MiB):\n\n\`\`\`json\n${JSON.stringify(record.summary, null, 2)}\n\`\`\`\n\n` +
    record.limitations.map((item) => `- ${item}`).join('\n') +
    (record.error ? `\n\nFailure: ${record.error}\n` : '\n')
  );
}

export async function runWorkspacePairBenchmark(opts, deps = {}) {
  const pairs = opts.pairs ?? 1;
  const timeoutMs = opts.timeoutMs || 120000;
  const sampleMs = opts.sampleMs ?? 1000;
  if (opts.cli !== 'built') throw new Error('workspace-pair requires --cli built');
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 5)
    throw new Error('--pairs must be an integer from 1 through 5');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error('--timeout-ms must be a positive integer');
  if (!Number.isInteger(sampleMs) || sampleMs < 100 || sampleMs > 60000)
    throw new Error('--sample-ms must be an integer from 100 through 60000');
  if (
    opts.maxPeakRssMib != null &&
    (!Number.isFinite(opts.maxPeakRssMib) || opts.maxPeakRssMib <= 0)
  ) {
    throw new Error('--max-peak-rss-mib must be a positive finite number');
  }
  if (typeof opts.runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(opts.runId)) {
    throw new Error('workspace-pair requires a safe run-id filename');
  }
  const repo = await fs.realpath(opts.repo);
  let outputDirectory = path.resolve(opts.outputDir);
  const artifacts = {
    jsonPath: path.join(outputDirectory, `${opts.runId}.json`),
    markdownPath: path.join(outputDirectory, `${opts.runId}.md`),
  };
  const record = {
    runId: opts.runId,
    mode: 'workspace-pair',
    cli: 'built',
    repository: opts.label ?? path.basename(repo),
    repositoryPath: repo,
    date: new Date().toISOString(),
    pairs: [],
    artifacts,
    summary: null,
    runtime: { node: process.version, workers: 4 },
    sampleMs,
    maxPeakRssMib: opts.maxPeakRssMib ?? null,
    outcome: { result: 'not-run', exitCode: null },
    limitations: [
      'Fixed full → capture → replay order with warm operating-system caches; no general speed claim.',
      'Sampled peak RSS uses Linux /proc process-tree scans; it may miss between-sample peaks, scans are non-atomic and shared pages may be counted more than once.',
      'RSS is unavailable when no valid positive sample is captured; sampling errors or missing samples fail a requested RSS ceiling.',
      'Published-generation validation measures getOverlaySnapshot only, excluding lock wait and CLI/MCP query overhead.',
      'Overlay state is evicted before validation; operating-system and database digest caches are not cleared.',
      'Whole child elapsed includes startup, capture, pipeline, storage, publication and shutdown; metadata phase times are separate.',
    ],
  };
  if (opts.dryRun) {
    console.log(JSON.stringify({ ...record, pairCount: pairs, timeoutMs }, null, 2));
    return record;
  }
  await fs.mkdir(outputDirectory, { recursive: true });
  outputDirectory = await fs.realpath(outputDirectory);
  // Report reservations must not become inputs between paired builds, including through aliases.
  const relativeOutput = path.relative(repo, outputDirectory);
  if (
    relativeOutput === '' ||
    (!relativeOutput.startsWith(`..${path.sep}`) &&
      relativeOutput !== '..' &&
      !path.isAbsolute(relativeOutput))
  ) {
    throw new Error('workspace-pair --output-dir must be outside the benchmark repository');
  }
  artifacts.jsonPath = path.join(outputDirectory, `${opts.runId}.json`);
  artifacts.markdownPath = path.join(outputDirectory, `${opts.runId}.md`);
  // Reserve both names before any build, refusing prior evidence rather than overwriting it.
  const reservations = [];
  try {
    for (const filename of Object.values(artifacts))
      reservations.push([filename, await fs.open(filename, 'wx')]);
  } catch (error) {
    for (const [filename, handle] of reservations) {
      await handle.close();
      await fs.unlink(filename);
    }
    throw error;
  }
  let lock;
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Workspace pair benchmark interrupted'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const acquireAnalyzeLock =
      deps.acquireAnalyzeLock ?? (await import('../dist/cli/analyze.js')).acquireAnalyzeLock;
    const getStoragePaths =
      deps.getStoragePaths ?? (await import('../dist/storage/repo-manager.js')).getStoragePaths;
    const superviseWorkspaceBuild =
      deps.superviseWorkspaceBuild ??
      (await import('../dist/mcp/local/workspace-build-supervisor.js')).superviseWorkspaceBuild;
    const verifyScopeRetentionCandidate =
      deps.verifyScopeRetentionCandidate ??
      (await import('../dist/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js'))
        .verifyScopeRetentionCandidate;
    const graphReader = deps.readGraph ?? readGraph;
    const sampleMemory = deps.startMemorySampling ?? startMemorySampling;
    const getOverlaySnapshot =
      deps.getOverlaySnapshot ??
      (await import('../dist/mcp/local/backend-overlay.js')).getOverlaySnapshot;
    const evictOverlayState =
      deps.evictOverlayState ??
      (await import('../dist/mcp/local/backend-overlay.js')).evictOverlayState;
    const { storagePath } = getStoragePaths(repo);
    lock = await acquireAnalyzeLock(repo);
    const generations = new Set();
    for (let index = 0; index < pairs; index++) {
      const pair = { legs: [], evaluation: null };
      record.pairs.push(pair);
      for (const kind of kinds) {
        if (controller.signal.aborted) throw new Error('Workspace pair benchmark interrupted');
        const args = [
          fileURLToPath(new URL('../dist/core/workspace-build-child.js', import.meta.url)),
          repo,
        ];
        if (kind !== 'full') args.push('--scope-retention', JSON.stringify(retention));
        const start = performance.now();
        let sampler;
        let elapsedMs;
        let memory;
        let buildError;
        try {
          await superviseWorkspaceBuild({
            command: process.execPath,
            args,
            cwd: repo,
            storagePath,
            timeoutMs,
            signal: controller.signal,
            env: { ...process.env, ONTOINDEX_MAX_WORKERS: '4' },
            onSpawn: (pid) => {
              sampler = sampleMemory(pid, { sampleMs });
            },
          });
        } catch (error) {
          buildError = error;
        } finally {
          elapsedMs = performance.now() - start;
          try {
            memory = sampler
              ? await sampler.stop()
              : {
                  method: 'linux-proc-process-tree-rss',
                  sampleMs,
                  sampleCount: 0,
                  failedSamples: 0,
                  peakMemory: null,
                };
          } catch (error) {
            memory = {
              method: 'linux-proc-process-tree-rss',
              sampleMs,
              sampleCount: 0,
              failedSamples: 1,
              peakMemory: null,
            };
          }
        }
        pair.failedLeg = { kind, elapsedMs, memory };
        if (buildError) throw buildError;
        if (opts.maxPeakRssMib != null) {
          if (
            !(memory.sampleCount > 0) ||
            memory.failedSamples > 0 ||
            !Number.isFinite(memory.peakMemory?.totalRssKiB) ||
            memory.peakMemory.totalRssKiB <= 0
          ) {
            throw new Error(
              `${kind} sampled peak RSS unavailable or sampling failed; failing closed against RSS ceiling`,
            );
          }
          if (memory.peakMemory.totalRssKiB / 1024 > opts.maxPeakRssMib) {
            throw new Error(
              `${kind} sampled peak RSS exceeded threshold ${opts.maxPeakRssMib} MiB`,
            );
          }
        }
        const name = (
          await fs.readFile(path.join(storagePath, 'overlay', 'CURRENT'), 'utf8')
        ).trim();
        if (!name || path.basename(name) !== name || name === '.' || name === '..')
          throw new Error('Invalid generation pointer');
        if (generations.has(name))
          throw new Error('Workspace child did not publish a new generation');
        generations.add(name);
        const directory = path.join(storagePath, 'overlay', name);
        const base = JSON.parse(await fs.readFile(path.join(directory, 'base.json'), 'utf8'));
        const firstBase = record.pairs[0]?.legs[0]?.base;
        if (firstBase)
          for (const field of [
            'manifestDigest',
            'parserIdentity',
            'head',
            'baseGenerationId',
            'configurationDigest',
          ]) {
            if (base[field] !== firstBase[field]) throw new Error(`Cross-sample ${field} mismatch`);
          }
        let candidateComplete = false;
        if (kind !== 'full') {
          const manifest = await verifyScopeRetentionCandidate(
            directory,
            {
              identity: {
                sourceManifestDigest: base.manifestDigest,
                targetCommit: base.head,
                baseGenerationId: base.baseGenerationId,
              },
              parserCodeIdentity: base.parserIdentity,
            },
            { deadline: Date.now() + retention.timeoutMs, signal: controller.signal },
          );
          candidateComplete =
            manifest.coverage?.complete === true &&
            manifest.retention?.inputEvidence?.complete === true &&
            manifest.retention?.inputEvidence?.parserCodeIdentity === base.parserIdentity &&
            manifest.retention?.graphNodesCaptured === true &&
            manifest.retention?.graphRelationshipsCaptured === true;
        }
        const graph = await graphReader(path.join(directory, 'lbug'));
        pair.legs.push({
          kind,
          elapsedMs,
          memory,
          base,
          graph,
          candidateComplete,
          generation: name,
        });
        delete pair.failedLeg;
      }
      pair.evaluation = evaluateWorkspacePair(pair.legs);
      if (!pair.evaluation.passed) throw new Error(pair.evaluation.failures.join('; '));
      try {
        if (controller.signal.aborted) throw new Error('Workspace pair benchmark interrupted');
        const replay = pair.legs[2];
        const pointerPath = path.join(storagePath, 'overlay', 'CURRENT');
        const before = (await fs.readFile(pointerPath, 'utf8')).trim();
        if (before !== replay.generation)
          throw new Error('Published validation CURRENT differs from replay generation');
        evictOverlayState(repo);
        if (controller.signal.aborted) throw new Error('Workspace pair benchmark interrupted');
        const start = performance.now();
        const snapshot = await getOverlaySnapshot({ id: repo, repoPath: repo, storagePath });
        const elapsedMs = performance.now() - start;
        if (controller.signal.aborted) throw new Error('Workspace pair benchmark interrupted');
        const after = (await fs.readFile(pointerPath, 'utf8')).trim();
        if (after !== replay.generation)
          throw new Error('Published validation CURRENT changed from replay generation');
        if (
          snapshot?.usable !== true ||
          snapshot.capability !== 'workspace-graph' ||
          snapshot.coverage !== 'complete' ||
          !(snapshot.parseErrorPaths instanceof Set) ||
          snapshot.parseErrorPaths.size !== 0 ||
          !(snapshot.uncoveredPaths instanceof Set) ||
          snapshot.uncoveredPaths.size !== 0
        ) {
          throw new Error(
            `Published validation requires usable complete workspace coverage and zero parse errors or uncovered paths: ${snapshot?.reason ?? 'invalid snapshot'}`,
          );
        }
        for (const [field, expected] of Object.entries({
          generation: replay.generation,
          manifestDigest: replay.base.manifestDigest,
          baseGenerationId: replay.base.baseGenerationId,
          currentHead: replay.base.head,
        })) {
          if (snapshot[field] !== expected)
            throw new Error(`Published validation ${field} mismatch`);
        }
        pair.reuse = {
          method: 'getOverlaySnapshot',
          elapsedMs,
          generation: snapshot.generation,
          manifestDigest: snapshot.manifestDigest,
          baseGenerationId: snapshot.baseGenerationId,
          currentHead: snapshot.currentHead,
        };
      } catch (error) {
        pair.evaluation.passed = false;
        pair.evaluation.failures.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
    record.outcome = { result: 'passed', exitCode: 0 };
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    record.outcome = { result: 'failed', exitCode: 1 };
  } finally {
    try {
      await lock?.release();
    } catch (error) {
      record.error = String(error);
      record.outcome = { result: 'failed', exitCode: 1 };
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    const accepted = record.pairs.filter((pair) => pair.evaluation?.passed);
    record.summary = Object.fromEntries(
      kinds.map((kind) => [
        kind,
        summarize(accepted.map((pair) => pair.legs.find((leg) => leg.kind === kind).elapsedMs)),
      ]),
    );
    record.summary.captureOverheadMs = summarize(
      accepted.map((pair) => pair.legs[1].elapsedMs - pair.legs[0].elapsedMs),
    );
    record.summary.publishedValidationMs = summarize(
      accepted.filter((pair) => pair.reuse).map((pair) => pair.reuse.elapsedMs),
    );
    record.summary.sampledPeakRssMib = Object.fromEntries(
      kinds.map((kind) => [
        kind,
        summarize(
          accepted
            .map(
              (pair) => pair.legs.find((leg) => leg.kind === kind).memory?.peakMemory?.totalRssKiB,
            )
            .filter((value) => Number.isFinite(value) && value > 0)
            .map((value) => value / 1024),
        ),
      ]),
    );
    // Keep exact arrays in memory for equality; persist compact fingerprints and counts.
    for (const pair of record.pairs)
      for (const leg of pair.legs) {
        leg.graph = Object.fromEntries(
          Object.entries(leg.graph).map(([family, values]) => [
            family,
            {
              count: values.length,
              sha256: createHash('sha256').update(JSON.stringify(values)).digest('hex'),
            },
          ]),
        );
      }
    try {
      await reservations[0][1].writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await reservations[1][1].writeFile(markdown(record));
    } finally {
      for (const [, handle] of reservations) await handle.close();
    }
  }
  if (record.outcome.exitCode !== 0) process.exitCode = 1;
  console.log(`Workspace pair benchmark: ${record.outcome.result}; ${artifacts.jsonPath}`);
  return record;
}
