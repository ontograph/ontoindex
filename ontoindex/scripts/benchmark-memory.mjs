import fs from 'node:fs/promises';

export async function sampleProcessTreeMemory(rootPid) {
  if (process.platform !== 'linux') return null;
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) return null;
  const entries = (await fs.readdir('/proc', { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && /^\d+$/.test(entry.name),
  );
  const processes = new Map();
  const childrenByParent = new Map();
  let next = 0;
  const reads = await Promise.allSettled(
    Array.from({ length: Math.min(16, entries.length) }, async () => {
      while (next < entries.length) {
        const pid = Number(entries[next++].name);
        let status;
        try {
          status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
        } catch (error) {
          if (error?.code === 'ENOENT' || error?.code === 'ESRCH') continue;
          throw error;
        }
        const ppid = status.match(/^PPid:\s+(\d+)/m)?.[1];
        const rss = status.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1];
        if (ppid === undefined) throw new Error(`Invalid process ancestry in /proc/${pid}/status`);
        processes.set(pid, {
          pid,
          rssKiB: rss === undefined ? null : Number(rss),
          state: status.match(/^State:\s+(\S)/m)?.[1],
          command: status.match(/^Name:\s+(.+)$/m)?.[1]?.trim() ?? '',
          isRoot: pid === rootPid,
        });
        const children = childrenByParent.get(Number(ppid)) ?? [];
        children.push(pid);
        childrenByParent.set(Number(ppid), children);
      }
    }),
  );
  const failure = reads.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  const root = processes.get(rootPid);
  if (!root || root.state === 'Z' || root.state === 'X') return null;
  if (!Number.isFinite(root.rssKiB) || root.rssKiB <= 0)
    throw new Error(`Incomplete RSS data for root process ${rootPid}`);
  const samples = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const sample = processes.get(pid);
    if (!sample || !Number.isFinite(sample.rssKiB))
      throw new Error(`Incomplete RSS data for process ${pid}`);
    const { state, ...memory } = sample;
    samples.push(memory);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }
  const children = samples.filter((sample) => !sample.isRoot).sort((a, b) => b.rssKiB - a.rssKiB);
  const childRssKiB = children.reduce((total, sample) => total + sample.rssKiB, 0);
  return {
    totalRssKiB: root.rssKiB + childRssKiB,
    rootRssKiB: root.rssKiB,
    childRssKiB,
    processCount: samples.length,
    childProcessCount: children.length,
    maxChildRssKiB: children[0]?.rssKiB ?? 0,
    topChildProcesses: children.slice(0, 8),
  };
}

export function mergePeakMemory(current, sample) {
  if (!current) return sample;
  return {
    ...(sample.totalRssKiB > current.totalRssKiB ? sample : current),
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

export function startMemorySampling(
  pid,
  { sampleMs = 1000, sample = sampleProcessTreeMemory } = {},
) {
  if (!Number.isInteger(sampleMs) || sampleMs < 100 || sampleMs > 60000) {
    throw new Error('--sample-ms must be an integer from 100 through 60000');
  }
  const result = {
    method: 'linux-proc-process-tree-rss',
    sampleMs,
    sampleCount: 0,
    failedSamples: 0,
    peakMemory: null,
  };
  let stopped = false;
  let timer;
  let inFlight;
  const scan = async () => {
    try {
      const memory = await sample(pid);
      if (memory !== null) {
        if (!Number.isFinite(memory?.totalRssKiB) || memory.totalRssKiB <= 0) {
          result.failedSamples++;
        } else {
          result.sampleCount++;
          result.peakMemory = mergePeakMemory(result.peakMemory, memory);
        }
      }
    } catch {
      result.failedSamples++;
    }
    if (!stopped)
      timer = setTimeout(() => {
        inFlight = scan();
      }, sampleMs);
  };
  inFlight = scan();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
      return result;
    },
  };
}
