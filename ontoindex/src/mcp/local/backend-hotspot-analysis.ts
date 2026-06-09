/**
 * Hotspot Analysis MCP Tool
 *
 * Combines git history (churn, authors, co-change) with graph
 * structure (caller count per file) to surface high-risk files.
 *
 * Three metrics are supported:
 *   - churn_x_complexity: rank files by (commits in window * caller
 *     count). This is the default — it flags the files that change
 *     most often AND carry the most incoming dependencies.
 *   - change_coupling: file pairs that co-change frequently. A pair
 *     co-changing in more than 30% of the commits that touch either
 *     file is surfaced — these are the hidden couplings the call
 *     graph misses.
 *   - ownership: files ranked by distinct author count in the window
 *     plus recent activity, highlighting bus-factor risk.
 */
import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { normalizeLimit } from './tool-utils.js';
import { AnalysisResult } from 'ontoindex-shared';
import { collectGitCommits, type GitCommitRecord } from './backend-git-history.js';
import { computeCoupling, type HotspotCouplingEntry } from './backend-hotspot-coupling-kernel.js';
// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly id: string; readonly name: string; readonly repoPath: string };

type Metric = 'churn_x_complexity' | 'change_coupling' | 'ownership';

type CommitRecord = GitCommitRecord;

interface HotspotChurnEntry {
  file: string;
  commits: number;
  caller_count: number;
  score: number;
}

interface HotspotOwnershipEntry {
  file: string;
  author_count: number;
  commits: number;
  authors: string[];
  last_commit_days_ago: number;
  score: number;
}

type HotspotEntry = HotspotChurnEntry | HotspotCouplingEntry | HotspotOwnershipEntry;

interface HotspotResult {
  status: 'success' | 'error';
  tool: 'hotspot_analysis';
  repo: string;
  metric: Metric;
  since: string;
  total_commits: number;
  hotspot_count: number;
  hotspots: HotspotEntry[];
  error?: string;
  warnings?: string[];
}

async function callerCountsByFile(repoId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const rows = await executeParameterized(
      repoId,
      `
        MATCH (src)-[r:CodeRelation]->(tgt)
        WHERE r.type = 'CALLS' AND tgt.filePath IS NOT NULL
        RETURN tgt.filePath AS file, count(*) AS callerCount
      `,
      {},
    );
    for (const row of rows || []) {
      const file = row.file ?? row[0];
      const raw = row.callerCount ?? row[1];
      if (typeof file !== 'string') continue;
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(num)) counts.set(file, num);
    }
  } catch {
    // DB unreachable — fall back to an empty map. Churn×complexity
    // degrades to pure churn, which is still useful signal.
  }
  return counts;
}

function legacyErrorMessage(err: unknown): unknown {
  if (err == null) return String(err);
  if (typeof err === 'object' || typeof err === 'function') {
    return (err as { readonly message?: unknown }).message ?? String(err);
  }
  return String(err);
}

function computeChurn(commits: CommitRecord[], callers: Map<string, number>): HotspotChurnEntry[] {
  const churn = new Map<string, number>();
  for (const commit of commits) {
    for (const file of commit.files) {
      churn.set(file, (churn.get(file) ?? 0) + 1);
    }
  }
  const entries: HotspotChurnEntry[] = [];
  for (const [file, count] of churn) {
    const callerCount = callers.get(file) ?? 0;
    entries.push({
      file,
      commits: count,
      caller_count: callerCount,
      score: count * (callerCount + 1),
    });
  }
  entries.sort((a, b) => b.score - a.score || b.commits - a.commits);
  return entries;
}

function computeOwnership(commits: CommitRecord[]): HotspotOwnershipEntry[] {
  const fileState = new Map<string, { authors: Set<string>; commits: number; latest: number }>();
  for (const commit of commits) {
    for (const file of commit.files) {
      let entry = fileState.get(file);
      if (!entry) {
        entry = { authors: new Set(), commits: 0, latest: 0 };
        fileState.set(file, entry);
      }
      entry.authors.add(commit.author);
      entry.commits += 1;
      if (commit.timestamp > entry.latest) entry.latest = commit.timestamp;
    }
  }
  const now = Date.now();
  const entries: HotspotOwnershipEntry[] = [];
  for (const [file, state] of fileState) {
    const daysAgo = Math.max(0, Math.round((now - state.latest) / 86400000));
    const recency = 1 / (1 + daysAgo / 30);
    const score = state.authors.size + state.commits * 0.1 + recency;
    entries.push({
      file,
      author_count: state.authors.size,
      commits: state.commits,
      authors: Array.from(state.authors).sort(),
      last_commit_days_ago: daysAgo,
      score: Number(score.toFixed(3)),
    });
  }
  entries.sort((a, b) => b.score - a.score);
  return entries;
}

export async function runHotspotAnalysis(
  repo: RepoHandle,
  params: { metric?: string; limit?: number; since?: string },
): Promise<AnalysisResult & HotspotResult> {
  const start = Date.now();
  try {
    const rawMetric = (params?.metric ?? 'churn_x_complexity').toString();
    const metric: Metric =
      rawMetric === 'change_coupling'
        ? 'change_coupling'
        : rawMetric === 'ownership'
          ? 'ownership'
          : 'churn_x_complexity';
    const limit = normalizeLimit(params?.limit, 20, 1000);
    const since =
      typeof params?.since === 'string' && params!.since.length > 0 ? params!.since : '6 months';

    const history = await collectGitCommits(repo.repoPath, since);
    const commits = history.commits;
    let hotspots: HotspotEntry[];
    if (metric === 'churn_x_complexity') {
      const callers = await callerCountsByFile(repo.id);
      hotspots = computeChurn(commits, callers);
    } else if (metric === 'change_coupling') {
      hotspots = computeCoupling(commits);
    } else {
      hotspots = computeOwnership(commits);
    }

    const topHotspots = hotspots.slice(0, limit);
    const summary = `Found ${hotspots.length} hotspots using metric '${metric}'. Top ${topHotspots.length} ranked by score.`;

    return {
      status: 'success',
      tool: 'hotspot_analysis',
      repo: repo.name,
      metric,
      since,
      total_commits: commits.length,
      hotspot_count: hotspots.length,
      hotspots: topHotspots,
      warnings: history.warnings,
    } as AnalysisResult & HotspotResult;
  } catch (err) {
    return {
      status: 'error',
      tool: 'hotspot_analysis',
      repo: repo.name,
      metric: 'churn_x_complexity',
      since:
        typeof params?.since === 'string' && params.since.length > 0 ? params.since : '6 months',
      total_commits: 0,
      hotspot_count: 0,
      hotspots: [],
      error: `Hotspot analysis failed: ${legacyErrorMessage(err)}`,
      warnings: [],
    } as AnalysisResult & HotspotResult;
  }
}
