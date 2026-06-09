export interface GraphDiffEdge {
  source_id: string;
  source_name?: string;
  source_file?: string;
  target_id: string;
  target_name?: string;
  target_file?: string;
  rel_type?: string;
  cross_community?: boolean;
}

export interface SnapshotShape {
  lastCommit?: string;
  savedAt?: string;
  calleesMap?: Record<string, string[]>;
  fileToSymbols?: Record<string, string[]>;
}

export interface CurrentEdge {
  sourceId: string;
  targetId: string;
  relType: string;
  sourceName: string;
  sourceFile: string;
  sourceCommunity: string | null;
  targetName: string;
  targetFile: string;
  targetCommunity: string | null;
}

export interface GraphDiffSets {
  added: GraphDiffEdge[];
  removed: GraphDiffEdge[];
  crossCommunityAddedCount: number;
}

export function buildSnapshotEdges(snapshot: SnapshotShape): Set<string> {
  const edges = new Set<string>();
  const callees = snapshot.calleesMap ?? {};
  for (const [sourceId, targetIds] of Object.entries(callees)) {
    if (!Array.isArray(targetIds)) continue;
    for (const targetId of targetIds) {
      edges.add(edgeKey(sourceId, targetId));
    }
  }
  return edges;
}

export function buildSnapshotFileIndex(snapshot: SnapshotShape): Map<string, string> {
  const index = new Map<string, string>();
  const fileToSymbols = snapshot.fileToSymbols ?? {};
  for (const [filePath, ids] of Object.entries(fileToSymbols)) {
    if (!Array.isArray(ids)) continue;
    for (const id of ids) index.set(id, filePath);
  }
  return index;
}

export function diffGraphEdgeSets(
  snapshot: SnapshotShape,
  currentEdges: readonly CurrentEdge[],
): GraphDiffSets {
  const snapshotEdges = buildSnapshotEdges(snapshot);
  const snapshotFileIndex = buildSnapshotFileIndex(snapshot);
  const currentEdgeKeys = new Set<string>();
  const currentByKey = new Map<string, CurrentEdge>();
  for (const edge of currentEdges) {
    const key = edgeKey(edge.sourceId, edge.targetId);
    currentEdgeKeys.add(key);
    currentByKey.set(key, edge);
  }

  const added: GraphDiffEdge[] = [];
  let crossCommunityAddedCount = 0;
  for (const [key, edge] of currentByKey) {
    if (snapshotEdges.has(key)) continue;
    const crossCommunity =
      edge.sourceCommunity !== null &&
      edge.targetCommunity !== null &&
      edge.sourceCommunity !== edge.targetCommunity;
    if (crossCommunity) crossCommunityAddedCount++;
    added.push({
      source_id: edge.sourceId,
      source_name: edge.sourceName || undefined,
      source_file: edge.sourceFile || undefined,
      target_id: edge.targetId,
      target_name: edge.targetName || undefined,
      target_file: edge.targetFile || undefined,
      rel_type: edge.relType,
      cross_community: crossCommunity || undefined,
    });
  }

  const removed: GraphDiffEdge[] = [];
  for (const key of snapshotEdges) {
    if (currentEdgeKeys.has(key)) continue;
    const [sourceId, targetId] = key.split('\x00');
    removed.push({
      source_id: sourceId,
      source_file: snapshotFileIndex.get(sourceId),
      target_id: targetId,
      target_file: snapshotFileIndex.get(targetId),
    });
  }

  added.sort(compareEdges);
  removed.sort(compareEdges);

  return { added, removed, crossCommunityAddedCount };
}

function edgeKey(sourceId: string, targetId: string): string {
  return `${sourceId}\x00${targetId}`;
}

function compareEdges(a: GraphDiffEdge, b: GraphDiffEdge): number {
  const sa = (a.source_file ?? '') + a.source_id;
  const sb = (b.source_file ?? '') + b.source_id;
  if (sa !== sb) return sa < sb ? -1 : 1;
  const ta = (a.target_file ?? '') + a.target_id;
  const tb = (b.target_file ?? '') + b.target_id;
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}
