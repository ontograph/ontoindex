export interface CouplingCommitRecord {
  readonly files: readonly string[];
}

export interface HotspotCouplingEntry {
  file_a: string;
  file_b: string;
  co_changes: number;
  commits_a: number;
  commits_b: number;
  coupling_ratio: number;
}

const MAX_COUPLING_FILES_PER_COMMIT = 300;
const MAX_COUPLING_PAIRS = 200_000;

export function computeCoupling(commits: readonly CouplingCommitRecord[]): HotspotCouplingEntry[] {
  const fileCommits = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (const commit of commits) {
    const unique = Array.from(new Set(commit.files)).sort();
    if (unique.length > MAX_COUPLING_FILES_PER_COMMIT) continue;
    for (const file of unique) {
      fileCommits.set(file, (fileCommits.get(file) ?? 0) + 1);
    }
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = `${unique[i]}\x00${unique[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        if (pairCounts.size >= MAX_COUPLING_PAIRS) break;
      }
      if (pairCounts.size >= MAX_COUPLING_PAIRS) break;
    }
    if (pairCounts.size >= MAX_COUPLING_PAIRS) break;
  }
  const entries: HotspotCouplingEntry[] = [];
  for (const [key, co] of pairCounts) {
    const [a, b] = key.split('\x00');
    const ca = fileCommits.get(a) ?? 0;
    const cb = fileCommits.get(b) ?? 0;
    const denom = Math.min(ca, cb);
    if (denom === 0) continue;
    const ratio = co / denom;
    if (ratio <= 0.3) continue;
    entries.push({
      file_a: a,
      file_b: b,
      co_changes: co,
      commits_a: ca,
      commits_b: cb,
      coupling_ratio: Number(ratio.toFixed(3)),
    });
  }
  entries.sort((x, y) => y.coupling_ratio - x.coupling_ratio || y.co_changes - x.co_changes);
  return entries;
}
