#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const usage = `Usage:
  npm run bench:semantic-ann -- [options]

Options:
  --fixture <path>        Path to a JSON fixture with nodes and query vectors.
  --nodes <n>             Synthetic corpus size when no fixture is provided. Defaults to 4096.
  --dimensions <n>        Synthetic vector dimensionality. Defaults to 64.
  --query-count <n>       Synthetic query count when no fixture is provided. Defaults to 128.
  --k <n>                 Requested top-K for recall metrics. Defaults to 5.
  --ef <list>             Comma-separated frontier widths. Defaults to 16,32,64.
  --seed <n>              Deterministic seed for synthetic vectors. Defaults to 1337.
  --min-recall-at-1 <n>   Minimum recall@1 threshold [0..1] required for each ef run.
  --min-recall-at-5 <n>   Minimum recall@5 threshold [0..1] required for each ef run.
  --max-latency-ms <n>    Maximum latency threshold in ms required for each ef run.
  --max-visited <n>       Maximum visited candidate threshold required for each ef run.
  --label <name>          Label shown in output. Defaults to "synthetic-bench".
  --adapter <name>        Search adapter. Use "synthetic" (default) or future semanticFrontierSearch.
  --dry-run               Print resolved configuration and exit.
  --help, -h              Show this help.
`;

const DEFAULTS = {
  label: 'synthetic-bench',
  nodes: 4096,
  dimensions: 64,
  queryCount: 128,
  k: 5,
  ef: [16, 32, 64],
  seed: 1337,
  minRecallAt1: null,
  minRecallAt5: null,
  maxLatencyMs: null,
  maxVisited: null,
  adapter: 'synthetic',
};

function parseArgs(argv) {
  const opts = {
    fixture: '',
    dryRun: false,
    nodes: DEFAULTS.nodes,
    dimensions: DEFAULTS.dimensions,
    queryCount: DEFAULTS.queryCount,
    k: DEFAULTS.k,
    ef: [...DEFAULTS.ef],
    seed: DEFAULTS.seed,
    minRecallAt1: DEFAULTS.minRecallAt1,
    minRecallAt5: DEFAULTS.minRecallAt5,
    maxLatencyMs: DEFAULTS.maxLatencyMs,
    maxVisited: DEFAULTS.maxVisited,
    label: '',
    adapter: DEFAULTS.adapter,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--fixture':
        opts.fixture = requireValue(argv, ++i, arg);
        break;
      case '--nodes':
        opts.nodes = parsePositiveInt(requireValue(argv, ++i, arg), '--nodes');
        break;
      case '--dimensions':
        opts.dimensions = parsePositiveInt(requireValue(argv, ++i, arg), '--dimensions');
        break;
      case '--query-count':
        opts.queryCount = parsePositiveInt(requireValue(argv, ++i, arg), '--query-count');
        break;
      case '--k':
        opts.k = parseNonNegativeInt(requireValue(argv, ++i, arg), '--k');
        break;
      case '--ef':
        opts.ef = parseEfList(requireValue(argv, ++i, arg));
        break;
      case '--seed':
        opts.seed = parseSeed(requireValue(argv, ++i, arg), '--seed');
        break;
      case '--min-recall-at-1':
        opts.minRecallAt1 = parseRecallThreshold(requireValue(argv, ++i, arg), '--min-recall-at-1');
        break;
      case '--min-recall-at-5':
        opts.minRecallAt5 = parseRecallThreshold(requireValue(argv, ++i, arg), '--min-recall-at-5');
        break;
      case '--max-latency-ms':
        opts.maxLatencyMs = parsePositiveNumber(requireValue(argv, ++i, arg), '--max-latency-ms');
        break;
      case '--max-visited':
        opts.maxVisited = parsePositiveInt(requireValue(argv, ++i, arg), '--max-visited');
        break;
      case '--label':
        opts.label = requireValue(argv, ++i, arg);
        break;
      case '--adapter':
        opts.adapter = requireValue(argv, ++i, arg);
        break;
      case '--dry-run':
        opts.dryRun = true;
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

  if (opts.k <= 0) {
    throw new Error('--k must be greater than 0');
  }

  if (opts.adapter !== 'synthetic') {
    throw new Error(`Unknown adapter: ${opts.adapter}`);
  }

  return opts;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be an integer > 0`);
  }
  return parsed;
}

function parseNonNegativeInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be an integer > 0`);
  }
  return parsed;
}

function parsePositiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return parsed;
}

function parseRecallThreshold(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be a number between 0 and 1`);
  }
  return parsed;
}

function parseEfList(value) {
  const parts = value.split(',').map((valuePart) => valuePart.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('--ef requires at least one integer');
  }

  const parsed = parts.map((part) => parsePositiveInt(part, '--ef'));
  const uniq = [...new Set(parsed)];
  uniq.sort((a, b) => a - b);
  return uniq;
}

function parseSeed(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a finite number`);
  }
  return parsed;
}

async function loadCorpusConfig(opts) {
  if (!opts.fixture) {
    return createSyntheticCorpus({
      nodes: opts.nodes,
      dimensions: opts.dimensions,
      queryCount: opts.queryCount,
      seed: opts.seed,
    });
  }

  const fixturePath = path.resolve(opts.fixture);
  const raw = await fs.readFile(fixturePath, 'utf8').catch((error) => {
    throw new Error(`Unable to read fixture ${fixturePath}: ${error.message}`);
  });

  let fixture;
  try {
    fixture = JSON.parse(raw);
  } catch {
    throw new Error(`Malformed fixture JSON at ${fixturePath}`);
  }

  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new Error(`Malformed fixture at ${fixturePath}: expected object`);
  }

  if (Array.isArray(fixture.nodes) && Array.isArray(fixture.queries)) {
    return normalizeFixtureCorpus(fixture, fixturePath);
  }

  if (Number.isFinite(fixture.embeddedNodes) && Number.isFinite(fixture.queryCount)) {
    return createSyntheticCorpus({
      nodes: parsePositiveInt(String(fixture.embeddedNodes), 'fixture.embeddedNodes'),
      dimensions: parsePositiveInt(
        String(fixture.dimensions || opts.dimensions),
        'fixture.dimensions',
      ),
      queryCount: parsePositiveInt(String(fixture.queryCount), 'fixture.queryCount'),
      seed: Number.isFinite(fixture.seed) ? parseSeed(String(fixture.seed), 'fixture.seed') : opts.seed,
      label: fixture.label || path.basename(fixturePath),
    });
  }

  throw new Error(
    `Malformed fixture at ${fixturePath}: provide {nodes,queries} or {embeddedNodes,queryCount}.`,
  );
}

function normalizeFixtureCorpus(fixture, fixturePath) {
  const rawNodes = fixture.nodes ?? [];
  const rawQueries = fixture.queries ?? [];

  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new Error(`Malformed fixture ${fixturePath}: nodes must be a non-empty array`);
  }
  if (!Array.isArray(rawQueries) || rawQueries.length === 0) {
    throw new Error(`Malformed fixture ${fixturePath}: queries must be a non-empty array`);
  }

  const nodes = rawNodes.map((entry, index) =>
    normalizePoint(entry, index, `fixture.nodes[${index}]`, 'node'),
  );
  const queries = rawQueries.map((entry, index) =>
    normalizePoint(entry, index, `fixture.queries[${index}]`, 'query'),
  );

  const dimension = nodes[0].vector.length;
  validateDimensionConsistency(nodes, dimension, fixturePath, 'node');
  validateDimensionConsistency(queries, dimension, fixturePath, 'query');

  return {
    label: fixture.label || fixture.repo || path.basename(fixturePath),
    k: Number.isFinite(fixture.k) ? fixture.k : undefined,
    nodes,
    queries,
    dimensions: dimension,
    embeddedNodes: nodes.length,
  };
}

function validateDimensionConsistency(records, expectedDimension, fixturePath, kind) {
  for (let index = 1; index < records.length; index++) {
    if (records[index].vector.length !== expectedDimension) {
      throw new Error(
        `Malformed fixture ${fixturePath}: ${kind} vector at index ${index} must have dimension ${expectedDimension}`,
      );
    }
  }
}

function normalizePoint(entry, index, pathLabel, fallbackPrefix) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Malformed ${pathLabel}: expected object`);
  }

  if (!Array.isArray(entry.vector)) {
    throw new Error(`Malformed ${pathLabel}: missing vector`);
  }
  if (entry.vector.length === 0) {
    throw new Error(`Malformed ${pathLabel}: vector must not be empty`);
  }

  const vector = entry.vector.map((value, valueIndex) => {
    if (!Number.isFinite(Number(value))) {
      throw new Error(
        `Malformed ${pathLabel}: vector[${valueIndex}] must be a finite number`,
      );
    }
    return Number(value);
  });

  const normalized = normalizeVector(vector);
  const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `${fallbackPrefix}-${index}`;

  return {
    id,
    vector: normalized,
  };
}

function createSyntheticCorpus({ nodes, dimensions, queryCount, seed, label = DEFAULTS.label }) {
  const nodeGenerator = createPrng(seed ^ 0x9e3779b9);
  const queryGenerator = createPrng(seed ^ 0x85ebca6b);

  const nodeRecords = Array.from({ length: nodes }, (_, index) => ({
    id: `node-${index}`,
    vector: normalizeVector(generateRandomVector(dimensions, nodeGenerator)),
  }));

  const queryRecords = Array.from({ length: queryCount }, (_, index) => ({
    id: `query-${index}`,
    vector: normalizeVector(generateRandomVector(dimensions, queryGenerator)),
  }));

  return {
    label,
    nodes: nodeRecords,
    queries: queryRecords,
    dimensions,
    embeddedNodes: nodeRecords.length,
    synthetic: true,
  };
}

function generateRandomVector(dimensions, nextRandom) {
  const vector = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    vector[i] = nextRandom() * 2 - 1;
  }
  return vector;
}

function normalizeVector(vector) {
  let magnitude = 0;
  for (const component of vector) {
    magnitude += component * component;
  }
  if (magnitude === 0) {
    return vector.slice();
  }
  const scale = 1 / Math.sqrt(magnitude);
  return vector.map((component) => component * scale);
}

function cosineSimilarity(a, b) {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function exactNearestNeighbors(nodes, queryVector, k) {
  const ranked = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    ranked[i] = {
      id: nodes[i].id,
      score: cosineSimilarity(queryVector, nodes[i].vector),
    };
  }
  ranked.sort((left, right) => right.score - left.score);
  return ranked.slice(0, k);
}

function resolveFrontierAdapter(name) {
  if (!name || name === 'synthetic') {
    return runSyntheticFrontierSearch;
  }
  throw new Error(`Unknown adapter ${name}; expected "synthetic" for now.`);
}

function runSemanticFrontierSearch(params, adapterName = 'synthetic') {
  const adapter = resolveFrontierAdapter(adapterName);
  return adapter(params);
}

function runSyntheticFrontierSearch({ queryVector, nodes, topK, ef, seed, queryId }) {
  if (nodes.length <= ef) {
    const exact = exactNearestNeighbors(nodes, queryVector, topK);
    return {
      queryId,
      topK,
      ef,
      visited: nodes.length,
      results: exact,
      fallbackReason: 'exact',
      seedUsed: seed,
      latencyMs: 0,
    };
  }

  const requested = Math.min(nodes.length, Math.max(topK, ef));
  const rng = createPrng(seed ^ (queryId.charCodeAt(0) << 16));
  const reservoir = [];
  for (let i = 0; i < nodes.length; i++) {
    if (reservoir.length < requested) {
      reservoir.push(i);
      continue;
    }
    const randomIndex = Math.floor(rng() * (i + 1));
    if (randomIndex < requested) {
      reservoir[randomIndex] = i;
    }
  }

  const sampled = reservoir.map((nodeIndex) => ({
    id: nodes[nodeIndex].id,
    score: cosineSimilarity(queryVector, nodes[nodeIndex].vector),
  }));
  sampled.sort((left, right) => right.score - left.score);

  return {
    queryId,
    topK,
    ef,
    visited: requested,
    results: sampled.slice(0, topK),
    fallbackReason: 'synthetic-frontier',
    seedUsed: seed,
    latencyMs: 0,
  };
}

function runBenchmark(corpus, opts) {
  const effectiveK = Math.min(opts.k, corpus.nodes.length);
  const exactK = Math.max(5, effectiveK);
  const exactGold = new Array(corpus.queries.length);
  const startedExact = performance.now();
  for (let i = 0; i < corpus.queries.length; i++) {
    exactGold[i] = exactNearestNeighbors(corpus.nodes, corpus.queries[i].vector, exactK);
  }
  const exactMs = performance.now() - startedExact;

  const rows = [];
  for (const ef of opts.ef) {
    let visitedTotal = 0;
    let recallAt1 = 0;
    let recallAt5 = 0;
    let latencyTotal = 0;
    let exactComparisons = 0;
    const fallbackReasons = new Map();

    for (let i = 0; i < corpus.queries.length; i++) {
      const query = corpus.queries[i];
      const querySeed = mixSeed(opts.seed, i, ef, effectiveK, corpus.label);
      const baseline = exactGold[i];
      const start = performance.now();
      const frontierResult = runSemanticFrontierSearch(
        {
        queryId: query.id,
        queryVector: query.vector,
        nodes: corpus.nodes,
        topK: effectiveK,
        ef,
        seed: querySeed,
        },
        opts.adapter,
      );
      const latency = performance.now() - start;

      visitedTotal += frontierResult.visited;
      latencyTotal += latency;
      exactComparisons += corpus.nodes.length;
      fallbackReasons.set(frontierResult.fallbackReason, (fallbackReasons.get(frontierResult.fallbackReason) ?? 0) + 1);
      if (frontierResult.results[0]?.id === baseline[0]?.id) {
        recallAt1++;
      }
      if (hasRecallAtK(frontierResult.results, baseline, 5)) {
        recallAt5++;
      }
    }

    rows.push({
      embeddedNodes: corpus.nodes.length,
      k: effectiveK,
      ef,
      visited: Math.round(visitedTotal / corpus.queries.length),
      latencyMs: roundToThree(latencyTotal / corpus.queries.length),
      speedup: roundToThree(exactComparisons / visitedTotal),
      'recall@1': roundToThree(recallAt1 / corpus.queries.length),
      'recall@5': roundToThree(recallAt5 / corpus.queries.length),
      fallbackReason: fallbackReasonFromMap(fallbackReasons),
    });
  }

  return {
    rows,
    metadata: {
      label: opts.label || corpus.label,
      queryCount: corpus.queries.length,
      dimensions: corpus.dimensions || corpus.nodes[0].vector.length,
      exactOracleMs: roundToThree(exactMs),
    },
  };
}

function normalizeThresholds(opts) {
  return {
    minRecallAt1: opts.minRecallAt1 ?? null,
    minRecallAt5: opts.minRecallAt5 ?? null,
    maxLatencyMs: opts.maxLatencyMs ?? null,
    maxVisited: opts.maxVisited ?? null,
  };
}

function evaluateThresholds(rows, thresholds) {
  const epsilon = 1e-9;
  const checks = rows.map((row) => {
    const failures = [];

    if (thresholds.minRecallAt1 !== null && row['recall@1'] + epsilon < thresholds.minRecallAt1) {
      failures.push({
        metric: 'minRecallAt1',
        actual: row['recall@1'],
        threshold: thresholds.minRecallAt1,
      });
    }

    if (thresholds.minRecallAt5 !== null && row['recall@5'] + epsilon < thresholds.minRecallAt5) {
      failures.push({
        metric: 'minRecallAt5',
        actual: row['recall@5'],
        threshold: thresholds.minRecallAt5,
      });
    }

    if (thresholds.maxLatencyMs !== null && row.latencyMs > thresholds.maxLatencyMs) {
      failures.push({
        metric: 'maxLatencyMs',
        actual: row.latencyMs,
        threshold: thresholds.maxLatencyMs,
      });
    }

    if (thresholds.maxVisited !== null && row.visited > thresholds.maxVisited) {
      failures.push({
        metric: 'maxVisited',
        actual: row.visited,
        threshold: thresholds.maxVisited,
      });
    }

    return {
      ef: row.ef,
      passed: failures.length === 0,
      failures,
    };
  });

  return {
    thresholds,
    checks,
    passed: checks.every((entry) => entry.passed),
    totalRows: checks.length,
    failedRows: checks.filter((entry) => !entry.passed).length,
  };
}

function fallbackReasonFromMap(reasons) {
  if (reasons.size === 1) return [...reasons.keys()][0];
  const entries = [...reasons.entries()].map(([reason, count]) => `${reason}(${count})`);
  return entries.join(', ');
}

function hasRecallAtK(annResults, exactResults, k) {
  const exactSet = new Set(exactResults.slice(0, k).map((entry) => entry.id));
  for (let i = 0; i < annResults.length; i++) {
    if (exactSet.has(annResults[i].id)) return true;
  }
  return false;
}

function mixSeed(seed, queryIndex, ef, k, salt) {
  let mixed = (seed >>> 0) + 0x9e3779b9 + (queryIndex << 6) + (queryIndex << 2) + (ef << 1) + k;
  for (let i = 0; i < salt.length; i++) {
    mixed ^= salt.charCodeAt(i);
    mixed = Math.imul(mixed, 0x85ebca6b);
  }
  return mixed >>> 0;
}

function createPrng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function roundToThree(value) {
  return Math.round(value * 1000) / 1000;
}

function printHelpAndExit() {
  console.log(usage);
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  const corpus = await loadCorpusConfig(opts);
  const effectiveLabel = opts.label || corpus.label || DEFAULTS.label;
  const effectiveKFromFixture = Number.isFinite(corpus.k) && Number.isFinite(opts.k) ? Math.min(opts.k, corpus.k) : opts.k;
  const effectiveK = Number.isFinite(effectiveKFromFixture) ? effectiveKFromFixture : opts.k;
  const configForRun = {
    ...opts,
    k: effectiveK,
    thresholds: normalizeThresholds(opts),
    label: effectiveLabel,
  };

  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        {
          label: effectiveLabel,
          fixture: opts.fixture || null,
          synthetic: !opts.fixture,
          nodes: corpus.nodes.length,
          dimensions: corpus.nodes[0].vector.length,
          queryCount: corpus.queries.length,
          k: effectiveK,
          ef: opts.ef,
          seed: opts.seed,
          adapter: opts.adapter,
        },
        null,
        2,
      ),
    );
    return;
  }

  const { rows, metadata } = runBenchmark(corpus, configForRun);
  const thresholdReport = evaluateThresholds(rows, configForRun.thresholds);
  const payload = {
    benchmark: 'semantic-ann',
    label: metadata.label,
    corpus: {
      embeddedNodes: corpus.nodes.length,
      queryCount: metadata.queryCount,
      dimensions: metadata.dimensions,
      source: opts.fixture ? 'fixture' : 'synthetic',
    },
    thresholds: thresholdReport.thresholds,
    requested: {
      k: configForRun.k,
      ef: configForRun.ef,
      adapter: configForRun.adapter,
      seed: configForRun.seed,
    },
    thresholdChecks: thresholdReport.checks,
    thresholdSummary: {
      passed: thresholdReport.passed,
      totalRows: thresholdReport.totalRows,
      failedRows: thresholdReport.failedRows,
    },
    metrics: rows,
    exactOracleMs: metadata.exactOracleMs,
  };

  if (!thresholdReport.passed) {
    process.exitCode = 1;
  }

  console.log(JSON.stringify(payload, null, 2));
}

function printErrorAndUsage(error) {
  console.error(error instanceof Error ? error.message : String(error));
  printHelpAndExit();
}

try {
  await run();
} catch (error) {
  printErrorAndUsage(error);
  process.exitCode = 1;
}
