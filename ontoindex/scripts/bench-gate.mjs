import fs from 'fs/promises';

const MAX_REGRESSION = 0.15;

function readBaseline(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('baseline must be an object');
  }
  if (
    typeof value.numerator !== 'string' ||
    value.numerator.length === 0 ||
    typeof value.control !== 'string' ||
    value.control.length === 0 ||
    value.numerator === value.control ||
    !Number.isFinite(value.ratio) ||
    value.ratio <= 0
  ) {
    throw new Error('baseline must define distinct numerator/control names and a positive ratio');
  }
  return value;
}

function readVitestResults(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.files) ||
    value.files.length === 0
  ) {
    throw new Error('current benchmark data must contain a non-empty files array');
  }

  const results = new Map();
  for (const file of value.files) {
    if (!file || !Array.isArray(file.groups)) {
      throw new Error('current benchmark file must contain a groups array');
    }
    for (const group of file.groups) {
      if (!group || !Array.isArray(group.benchmarks)) {
        throw new Error('current benchmark group must contain a benchmarks array');
      }
      for (const benchmark of group.benchmarks) {
        if (
          !benchmark ||
          typeof benchmark.name !== 'string' ||
          benchmark.name.length === 0 ||
          !Number.isFinite(benchmark.mean) ||
          benchmark.mean <= 0
        ) {
          throw new Error('current benchmark result must have a name and positive finite mean');
        }
        if (results.has(benchmark.name)) {
          throw new Error(`duplicate current benchmark result "${benchmark.name}"`);
        }
        results.set(benchmark.name, benchmark);
      }
    }
  }

  if (results.size === 0) throw new Error('current benchmark data contains no benchmark results');
  return results;
}

async function run() {
  const baselinePath = 'test/bench/baseline.json';
  const currentPath = 'test/bench/current.json';

  try {
    const baselineRaw = await fs.readFile(baselinePath, 'utf8');
    const baseline = readBaseline(JSON.parse(baselineRaw));

    const currentRaw = await fs.readFile(currentPath, 'utf8');
    const currentResults = readVitestResults(JSON.parse(currentRaw));

    const numerator = currentResults.get(baseline.numerator);
    const control = currentResults.get(baseline.control);
    if (!numerator) throw new Error(`missing current benchmark result "${baseline.numerator}"`);
    if (!control) throw new Error(`missing current benchmark result "${baseline.control}"`);

    const ratio = numerator.mean / control.mean;
    if (!Number.isFinite(ratio) || ratio <= 0)
      throw new Error('current benchmark ratio is invalid');
    const regression = (ratio - baseline.ratio) / baseline.ratio;
    const status = regression > MAX_REGRESSION ? 'FAIL' : 'PASS';
    console.log(
      `${status} ${baseline.numerator} / ${baseline.control}: ${baseline.ratio.toFixed(4)} -> ${ratio.toFixed(4)} (${(regression * 100).toFixed(1)}%)`,
    );

    if (regression > MAX_REGRESSION) {
      throw new Error('benchmark regression detected (> 15%)');
    } else {
      console.log('\nPerformance within acceptable limits.');
    }
  } catch (error) {
    console.error(`Error running bench-gate: ${error.message}`);
    process.exitCode = 1;
  }
}

run();
