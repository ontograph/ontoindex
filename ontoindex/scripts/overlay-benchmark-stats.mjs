export const REQUIRED_METRICS = Object.freeze([
  'latencyMs',
  'cpuSeconds',
  'peakRssBytes',
  'responseBytes',
  'buildCount',
  'cleanupMs',
]);

function sortedSamples(samples) {
  if (
    !Array.isArray(samples) ||
    !samples.length ||
    Array.from(samples).some((value) => !Number.isFinite(value))
  ) {
    throw new Error('Samples must contain finite numbers and must not be empty');
  }
  return [...samples].sort((a, b) => a - b);
}

export function median(samples) {
  const sorted = sortedSamples(samples);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
}

export function nearestRankP95(samples) {
  const sorted = sortedSamples(samples);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

export function validateSample(sample) {
  const reasons = [];
  try {
    for (const metric of REQUIRED_METRICS) {
      if (!Number.isFinite(sample?.[metric]) || sample[metric] < 0)
        reasons.push(`Invalid ${metric}`);
    }
    if (sample?.exit?.code !== 0 || sample?.exit?.signal !== null)
      reasons.push('Unsuccessful exit');
    if (sample?.childrenReaped !== true) reasons.push('Children not reaped');
    if (
      !Number.isFinite(sample?.stderrBytes) ||
      sample.stderrBytes < 0 ||
      sample.stderrBytes > 16 * 1024 ** 2 ||
      sample.stderrTruncated === true
    )
      reasons.push('Invalid or truncated stderr');
    if (sample?.nativeError === true) reasons.push('Native error');
  } catch {
    reasons.push('Unreadable sample');
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

export function summarize(samples) {
  if (!Array.isArray(samples) || !samples.length) throw new Error('Missing samples');
  Array.from(samples).forEach((sample, index) => {
    const result = validateSample(sample);
    if (!result.ok) throw new Error(`Invalid sample ${index}: ${result.reasons.join(', ')}`);
  });
  const stats = (metric) => {
    const values = samples.map((sample) => sample[metric]);
    return { median: median(values), p95: nearestRankP95(values) };
  };
  const maximum = (metric) => Math.max(...samples.map((sample) => sample[metric]));
  const builds = samples.map((sample) => sample.buildCount);
  return {
    count: samples.length,
    latency: stats('latencyMs'),
    cpuSeconds: stats('cpuSeconds'),
    peakRssBytes: { ...stats('peakRssBytes'), max: maximum('peakRssBytes') },
    responseBytes: stats('responseBytes'),
    buildCount: {
      min: Math.min(...builds),
      max: Math.max(...builds),
      total: builds.reduce((sum, value) => sum + value, 0),
    },
    cleanupMs: { ...stats('cleanupMs'), max: maximum('cleanupMs') },
  };
}

export const BUDGETS = Object.freeze({
  warmP95Ms: 1000,
  dirtyColdP95Ms: 55000,
  peakRssBytes: 4 * 1024 ** 3,
  coldCpuSeconds: 300,
  warmCpuSeconds: 1,
  artifactBytes: 2 * 1024 ** 3,
  cleanupMs: 5000,
  cleanGateOverheadMs: (baselineP95) => Math.max(100, 0.25 * baselineP95),
});

export function evaluateBudgets({ phase, workload, summary, artifactBytes, baselineP95Ms }) {
  const failures = [];
  const check = (budget, limit, observed) => {
    if (!Number.isFinite(observed) || observed < 0 || observed > limit)
      failures.push({ budget, limit, observed });
  };
  if (phase !== 'cold' && phase !== 'warm') throw new Error('Invalid phase');
  if (workload !== 'clean' && workload !== 'dirty') throw new Error('Invalid workload');
  if (phase === 'warm') check('warmP95Ms', BUDGETS.warmP95Ms, summary.latency.p95);
  if (phase === 'cold' && workload === 'dirty')
    check('dirtyColdP95Ms', BUDGETS.dirtyColdP95Ms, summary.latency.p95);
  check('peakRssBytes', BUDGETS.peakRssBytes, summary.peakRssBytes.max);
  const cpuBudget = phase === 'cold' ? 'coldCpuSeconds' : 'warmCpuSeconds';
  check(cpuBudget, BUDGETS[cpuBudget], summary.cpuSeconds.p95);
  check('artifactBytes', BUDGETS.artifactBytes, artifactBytes);
  check('cleanupMs', BUDGETS.cleanupMs, summary.cleanupMs.max);
  if (workload === 'clean' || phase === 'warm') check('buildCount', 0, summary.buildCount.total);
  if (typeof baselineP95Ms === 'number' && workload === 'clean') {
    const observed = summary.latency.p95 - baselineP95Ms;
    const limit = BUDGETS.cleanGateOverheadMs(baselineP95Ms);
    if (!Number.isFinite(observed) || !Number.isFinite(limit) || observed > limit)
      failures.push({ budget: 'cleanGateOverheadMs', limit, observed });
  }
  return { pass: failures.length === 0, failures };
}

export function parseProcStat(text) {
  const end = text.lastIndexOf(')');
  const pid = Number(text.slice(0, text.indexOf(' ')));
  const fields = text
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  if (end < 0 || !Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0)
    throw new Error('Invalid proc stat');
  return { pid, ppid };
}

export function parseVmRssKb(text) {
  const match = /^VmRSS:\s*(\d+)\s+kB\s*$/m.exec(text);
  return match ? Number(match[1]) : null;
}

export function processTreeRssBytes(records, rootPid) {
  const visited = new Set();
  const pending = [rootPid];
  let rssKb = 0;
  while (pending.length) {
    const pid = pending.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);
    const record = records.find((record) => record.pid === pid);
    if (record) rssKb += record.rssKb;
    for (const child of records) if (child.ppid === pid) pending.push(child.pid);
  }
  return rssKb * 1024;
}

export function parseGnuTime(text) {
  const line = text.trim().split(/\r?\n/).at(-1);
  const fields = line?.trim().split(/\s+/) ?? [];
  if (
    fields.length !== 2 ||
    fields.some(
      (field) => !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(field) || !Number.isFinite(Number(field)),
    )
  )
    throw new Error('Missing or invalid terminal CPU accounting');
  const [userSeconds, systemSeconds] = fields.map(Number);
  return { userSeconds, systemSeconds, cpuSeconds: userSeconds + systemSeconds };
}
