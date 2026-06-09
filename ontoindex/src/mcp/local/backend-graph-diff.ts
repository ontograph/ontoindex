/**
 * Graph Diff MCP Tool
 *
 * Compares the current LadybugDB dependency graph against the last
 * persisted snapshot (written by `ontoindex analyze`) and returns the
 * structural delta: edges that appeared, edges that disappeared, and
 * a best-effort flag for edges that cross community boundaries.
 *
 * The snapshot is the authoritative record of what the graph looked
 * like after the previous successful analyse run. If no snapshot has
 * been written yet the tool returns success with empty add/remove
 * sets and a note.
 *
 * The snapshot intentionally does not retain the per-edge relation
 * type — it collapses CALLS + IMPORTS into a single adjacency map.
 * We honour that limitation here: edge tuples are `(sourceId, targetId)`
 * and added edges carry their current relation type (known from the
 * live DB), while removed edges do not.
 */
import fs from 'fs/promises';
import path from 'path';
import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import type { LbugQueryRow } from '../../core/lbug/pool-adapter.js';
import {
  diffGraphEdgeSets,
  type CurrentEdge,
  type GraphDiffEdge,
  type SnapshotShape,
} from './backend-graph-diff-kernel.js';
import { normalizeLimit } from './tool-utils.js';
// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly id: string; readonly name: string; readonly storagePath: string };

type CurrentEdgeRow = LbugQueryRow & {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relType?: string;
  readonly sourceName?: string;
  readonly sourceFile?: string;
  readonly targetName?: string;
  readonly targetFile?: string;
  readonly sourceCommunity?: string | null;
  readonly targetCommunity?: string | null;
  readonly 0?: string;
  readonly 1?: string;
  readonly 2?: string;
  readonly 3?: string;
  readonly 4?: string;
  readonly 5?: string;
  readonly 6?: string;
  readonly 7?: string | null;
  readonly 8?: string | null;
};

interface GraphDiffResult {
  status: 'success' | 'error';
  tool: 'graph_diff';
  repo: string;
  snapshot_present: boolean;
  snapshot_saved_at?: string;
  snapshot_commit?: string;
  added_count: number;
  removed_count: number;
  cross_community_added_count: number;
  added: GraphDiffEdge[];
  removed: GraphDiffEdge[];
  note?: string;
  error?: string;
}

async function loadSnapshotFile(storagePath: string): Promise<SnapshotShape | null> {
  try {
    const raw = await fs.readFile(path.join(storagePath, 'snapshot.json'), 'utf8');
    return JSON.parse(raw) as SnapshotShape;
  } catch {
    return null;
  }
}

async function fetchCurrentEdges(repoId: string): Promise<CurrentEdge[]> {
  const rows = await executeParameterized<CurrentEdgeRow>(
    repoId,
    `
      MATCH (a)-[r:CodeRelation]->(b)
      WHERE r.type IN ['CALLS', 'IMPORTS']
      OPTIONAL MATCH (a)-[:CodeRelation {type: 'MEMBER_OF'}]->(ca:Community)
      OPTIONAL MATCH (b)-[:CodeRelation {type: 'MEMBER_OF'}]->(cb:Community)
      RETURN a.id AS sourceId, b.id AS targetId, r.type AS relType,
             a.name AS sourceName, a.filePath AS sourceFile,
             b.name AS targetName, b.filePath AS targetFile,
             ca.id AS sourceCommunity, cb.id AS targetCommunity
    `,
    {},
  );
  const edges: CurrentEdge[] = [];
  for (const row of rows || []) {
    const sourceId = row.sourceId ?? row[0];
    const targetId = row.targetId ?? row[1];
    if (typeof sourceId !== 'string' || typeof targetId !== 'string') continue;
    edges.push({
      sourceId,
      targetId,
      relType: String(row.relType ?? row[2] ?? 'CALLS'),
      sourceName: String(row.sourceName ?? row[3] ?? ''),
      sourceFile: String(row.sourceFile ?? row[4] ?? ''),
      targetName: String(row.targetName ?? row[5] ?? ''),
      targetFile: String(row.targetFile ?? row[6] ?? ''),
      sourceCommunity: row.sourceCommunity ?? row[7] ?? null,
      targetCommunity: row.targetCommunity ?? row[8] ?? null,
    });
  }
  return edges;
}

function legacyErrorMessage(err: unknown): unknown {
  if (err == null) return String(err);
  if (typeof err === 'object' || typeof err === 'function') {
    return (err as { readonly message?: unknown }).message ?? String(err);
  }
  return String(err);
}

export async function runGraphDiff(
  repo: RepoHandle,
  params: { limit?: number },
): Promise<GraphDiffResult> {
  const limit = normalizeLimit(params?.limit, 50, 5000);

  const snapshot = await loadSnapshotFile(repo.storagePath);

  // If no snapshot, nothing to diff against — return empty success.
  if (!snapshot) {
    return {
      status: 'success',
      tool: 'graph_diff',
      repo: repo.name,
      snapshot_present: false,
      added_count: 0,
      removed_count: 0,
      cross_community_added_count: 0,
      added: [],
      removed: [],
      note: 'No snapshot found. Run `ontoindex analyze` to capture one, then re-run this tool.',
    };
  }

  let currentEdges: CurrentEdge[];
  try {
    currentEdges = await fetchCurrentEdges(repo.id);
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'graph_diff',
      repo: repo.name,
      snapshot_present: true,
      snapshot_saved_at: snapshot.savedAt,
      snapshot_commit: snapshot.lastCommit,
      added_count: 0,
      removed_count: 0,
      cross_community_added_count: 0,
      added: [],
      removed: [],
      error: `Failed to query current edges: ${legacyErrorMessage(err)}`,
    };
  }

  const { added, removed, crossCommunityAddedCount } = diffGraphEdgeSets(snapshot, currentEdges);

  return {
    status: 'success',
    tool: 'graph_diff',
    repo: repo.name,
    snapshot_present: true,
    snapshot_saved_at: snapshot.savedAt,
    snapshot_commit: snapshot.lastCommit,
    added_count: added.length,
    removed_count: removed.length,
    cross_community_added_count: crossCommunityAddedCount,
    added: added.slice(0, limit),
    removed: removed.slice(0, limit),
  };
}
