import fs from 'node:fs/promises';

import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import {
  getSidecarStorePath,
  loadSidecarStoreState,
  type EnrichmentRecord,
} from '../../core/ingestion/enrichment/index.js';

export const CONTEXT_NEIGHBORHOOD_MODES = [
  'symbol-neighborhood',
  'route-neighborhood',
  'process-neighborhood',
  'requirement-neighborhood',
  'api-doc-neighborhood',
] as const;

export type ContextNeighborhoodMode = (typeof CONTEXT_NEIGHBORHOOD_MODES)[number];

export interface ContextNeighborhoodParams {
  name?: string;
  uid?: string;
  file_path?: string;
  kind?: string;
  route?: string;
  process_id?: string;
  requirement_id?: string;
  api_doc_id?: string;
  doc_path?: string;
  neighborhood_mode?: ContextNeighborhoodMode;
  depth?: number;
  limit?: number;
  maxCandidates?: number;
}

interface ContextNeighborhoodRepo {
  id: string;
  repoPath: string;
  storagePath: string;
  indexedAt?: string;
  lastCommit?: string;
}

type QueryRow = Record<string, unknown> & { readonly [index: number]: unknown };

const MAX_DEPTH = 3;
const MAX_LIMIT = 100;
const MAX_CANDIDATES = 20;

export async function runContextNeighborhood(
  repo: ContextNeighborhoodRepo,
  params: ContextNeighborhoodParams,
): Promise<Record<string, unknown>> {
  const mode = params.neighborhood_mode;
  if (!mode || !(CONTEXT_NEIGHBORHOOD_MODES as readonly string[]).includes(mode)) {
    return {
      status: 'unresolved',
      diagnostics: [`unknown or missing neighborhood_mode: ${String(mode)}`],
    };
  }

  const depth = clampInt(params.depth, 1, MAX_DEPTH, 1);
  const limit = clampInt(params.limit, 1, MAX_LIMIT, 25);
  const maxCandidates = clampInt(params.maxCandidates, 1, MAX_CANDIDATES, 5);
  const diagnostics: string[] = [];
  const records = await loadSidecarRecords(repo, diagnostics);
  const identity = resolveIdentity(params, mode, records, maxCandidates);
  for (const diagnostic of arrayValue(identity.diagnostics)) {
    if (typeof diagnostic === 'string') diagnostics.push(diagnostic);
  }
  const docsEvidence = docsEvidenceForMode(records, mode, identity, limit, repo.lastCommit);
  const graph = await graphNeighborhood(repo.id, mode, identity, depth, limit, diagnostics);
  const freshness = freshnessFor(records, repo.lastCommit);
  const status =
    identity.status === 'unresolved'
      ? 'unresolved'
      : identity.status === 'ambiguous'
        ? 'ambiguous'
        : 'ok';

  return {
    version: 1,
    status,
    mode,
    sourcePlane: docsEvidence.length > 0 ? 'graph+markdown-docs-sidecar' : 'graph',
    identity,
    nodes: graph.nodes,
    edges: graph.edges,
    docsEvidence,
    inclusionReason: inclusionReason(mode),
    freshness,
    limits: {
      depth,
      limit,
      maxCandidates,
      truncated:
        graph.nodes.length >= limit ||
        graph.edges.length >= limit ||
        docsEvidence.length >= limit ||
        identity.status === 'ambiguous',
    },
    diagnostics,
  };
}

function resolveIdentity(
  params: ContextNeighborhoodParams,
  mode: ContextNeighborhoodMode,
  records: readonly EnrichmentRecord[],
  maxCandidates: number,
): Record<string, unknown> {
  if (params.uid) return { status: 'resolved', type: 'symbol', id: params.uid };
  if (params.route) return { status: 'resolved', type: 'route', id: params.route };
  if (params.process_id) return { status: 'resolved', type: 'process', id: params.process_id };
  if (params.requirement_id) {
    return resolveDocsIdentity('requirement', params.requirement_id, records, maxCandidates);
  }
  if (params.api_doc_id)
    return resolveDocsIdentity('api-doc', params.api_doc_id, records, maxCandidates);
  if (params.doc_path) return resolveDocPathIdentity(params.doc_path, records);
  if (params.name) {
    return {
      status: 'resolved',
      type: mode === 'process-neighborhood' ? 'process' : 'symbol',
      id: params.name,
      filePath: params.file_path,
      kind: params.kind,
    };
  }
  return { status: 'unresolved', type: mode, diagnostics: ['no graph or docs identity provided'] };
}

function resolveDocsIdentity(
  type: 'requirement' | 'api-doc',
  id: string,
  records: readonly EnrichmentRecord[],
  maxCandidates: number,
): Record<string, unknown> {
  const resolutions = records
    .flatMap((record) => record.records)
    .filter((fact) => fact.kind === 'markdown-doc-resolution' && fact.factKey === id);
  const ambiguous = resolutions.find((fact) => fact.status === 'ambiguous');
  if (ambiguous) {
    return {
      status: 'ambiguous',
      type,
      id,
      candidates: arrayValue(ambiguous.candidates).slice(0, maxCandidates),
      candidateCount: arrayValue(ambiguous.candidates).length,
      reasons: arrayValue(ambiguous.reasons),
    };
  }
  const resolved = resolutions.find((fact) => fact.status === 'resolved');
  if (resolved?.targetGraphIdentity) {
    return { status: 'resolved', type, id, target: resolved.targetGraphIdentity };
  }
  const fact = records
    .flatMap((record) => record.records)
    .find((candidate) => docsIdentityFactMatches(candidate, type, id));
  if (fact) return { status: 'resolved', type, id };
  return {
    status: 'unresolved',
    type,
    id,
    diagnostics: [`${type} identity not found in docs sidecar: ${id}`],
  };
}

function resolveDocPathIdentity(
  docPath: string,
  records: readonly EnrichmentRecord[],
): Record<string, unknown> {
  const found = records.some(
    (record) =>
      record.filePath === docPath ||
      record.records.some((fact) => typeof fact.docPath === 'string' && fact.docPath === docPath),
  );
  if (found) return { status: 'resolved', type: 'doc', id: docPath };
  return {
    status: 'unresolved',
    type: 'doc',
    id: docPath,
    diagnostics: [`doc identity not found in docs sidecar: ${docPath}`],
  };
}

function docsIdentityFactMatches(
  fact: Record<string, unknown>,
  type: 'requirement' | 'api-doc',
  id: string,
): boolean {
  if (type === 'requirement') {
    return (
      (fact.kind === 'markdown-requirement' || fact.kind === 'markdown-acceptance-criterion') &&
      (fact.requirementId === id || fact.normalizedKey === id)
    );
  }
  return (
    fact.kind === 'markdown-api-spec' &&
    (fact.routeKey === id || fact.normalizedKey === id || fact.docPath === id)
  );
}

async function graphNeighborhood(
  repoId: string,
  mode: ContextNeighborhoodMode,
  identity: Record<string, unknown>,
  depth: number,
  limit: number,
  diagnostics: string[],
): Promise<{ nodes: unknown[]; edges: unknown[] }> {
  const seed = graphSeed(identity);
  if (!seed) return { nodes: [], edges: [] };
  try {
    const rows = await executeParameterized<QueryRow>(
      repoId,
      `
      MATCH path = (seed)-[r:CodeRelation*1..${depth}]-(node)
      WHERE seed.id = $seed OR seed.name = $seed
      UNWIND relationships(path) AS rel
      WITH DISTINCT startNode(rel) AS source, endNode(rel) AS target, rel
      RETURN source.id AS sourceId, source.name AS sourceName, labels(source)[0] AS sourceKind,
             source.filePath AS sourceFilePath, target.id AS targetId, target.name AS targetName,
             labels(target)[0] AS targetKind, target.filePath AS targetFilePath, rel.type AS type
      LIMIT $limit
      `,
      { seed, limit },
    );
    return rowsToNeighborhood(rows, mode, seed, limit);
  } catch (error) {
    diagnostics.push(`graph neighborhood unavailable: ${(error as Error).message}`);
    return { nodes: [], edges: [] };
  }
}

function rowsToNeighborhood(
  rows: readonly QueryRow[],
  mode: ContextNeighborhoodMode,
  seed: string,
  limit: number,
): { nodes: unknown[]; edges: unknown[] } {
  const nodes = new Map<string, Record<string, unknown>>();
  const edges: unknown[] = [];
  for (const row of rows) {
    const sourceId = rowString(row, 'sourceId', 0);
    const targetId = rowString(row, 'targetId', 4);
    if (sourceId) {
      nodes.set(sourceId, {
        id: sourceId,
        name: rowString(row, 'sourceName', 1),
        kind: rowString(row, 'sourceKind', 2),
        filePath: rowString(row, 'sourceFilePath', 3),
        sourcePlane: 'graph',
        inclusionReason: sourceId === seed ? 'seed' : inclusionReason(mode),
      });
    }
    if (targetId) {
      nodes.set(targetId, {
        id: targetId,
        name: rowString(row, 'targetName', 5),
        kind: rowString(row, 'targetKind', 6),
        filePath: rowString(row, 'targetFilePath', 7),
        sourcePlane: 'graph',
        inclusionReason: targetId === seed ? 'seed' : inclusionReason(mode),
      });
    }
    edges.push({
      source: sourceId,
      target: targetId,
      type: rowString(row, 'type', 8),
      sourcePlane: 'graph',
      inclusionReason: inclusionReason(mode),
    });
  }
  return { nodes: [...nodes.values()].slice(0, limit), edges: edges.slice(0, limit) };
}

function docsEvidenceForMode(
  records: readonly EnrichmentRecord[],
  mode: ContextNeighborhoodMode,
  identity: Record<string, unknown>,
  limit: number,
  currentCommit: string | undefined,
): unknown[] {
  if (mode !== 'requirement-neighborhood' && mode !== 'api-doc-neighborhood') return [];
  const expectedKinds =
    mode === 'requirement-neighborhood'
      ? new Set(['markdown-requirement', 'markdown-acceptance-criterion'])
      : new Set(['markdown-api-spec']);
  const id = String(identity.id ?? '');
  return records
    .flatMap((record) =>
      record.records
        .filter((fact) => expectedKinds.has(String(fact.kind)))
        .filter((fact) => docsFactMatches(fact, id, mode))
        .map((fact) => ({
          kind: fact.kind,
          docPath: fact.docPath ?? record.filePath,
          sourcePlane: 'markdown-docs-sidecar',
          inclusionReason: inclusionReason(mode),
          status: record.status,
          freshness: evidenceFreshness(record, currentCommit),
          lineSpan: fact.lineSpan,
          headingPath: fact.headingPath,
          requirementId: fact.requirementId,
          routeKey: fact.routeKey,
          method: fact.method,
          path: fact.path,
          evidence: fact.evidence,
        })),
    )
    .slice(0, limit);
}

function docsFactMatches(
  fact: Record<string, unknown>,
  id: string,
  mode: ContextNeighborhoodMode,
): boolean {
  if (!id) return true;
  if (mode === 'requirement-neighborhood') {
    return fact.requirementId === id || fact.normalizedKey === id;
  }
  return fact.routeKey === id || fact.normalizedKey === id || fact.docPath === id;
}

async function loadSidecarRecords(
  repo: ContextNeighborhoodRepo,
  diagnostics: string[],
): Promise<EnrichmentRecord[]> {
  const storePath = getSidecarStorePath(repo.storagePath);
  try {
    await fs.access(storePath);
    const state = await loadSidecarStoreState(storePath);
    return state.enrichments;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') diagnostics.push('sidecar-missing');
    else diagnostics.push(`sidecar-unreadable: ${(error as Error).message}`);
    return [];
  }
}

function freshnessFor(
  records: readonly EnrichmentRecord[],
  currentCommit: string | undefined,
): unknown {
  if (records.length === 0)
    return { status: 'missing', degraded: true, degradedReasons: ['sidecar-missing'] };
  const stale = records.filter(
    (record) =>
      currentCommit && record.sourceCommitHash && record.sourceCommitHash !== currentCommit,
  );
  return {
    status: stale.length > 0 ? 'stale' : 'fresh',
    degraded: stale.length > 0,
    degradedReasons: stale.length > 0 ? ['source-commit-mismatch'] : [],
  };
}

function evidenceFreshness(
  record: EnrichmentRecord,
  currentCommit: string | undefined,
): Record<string, unknown> {
  const degradedReasons: string[] = [];
  if (record.status !== 'complete') degradedReasons.push(`record-${record.status}`);
  if (record.sourceCommitHash === undefined) degradedReasons.push('source-commit-unknown');
  if (currentCommit && record.sourceCommitHash && record.sourceCommitHash !== currentCommit) {
    degradedReasons.push('source-commit-mismatch');
  }
  return {
    status:
      record.status === 'complete' && !degradedReasons.includes('source-commit-mismatch')
        ? 'fresh'
        : record.status === 'complete'
          ? 'stale'
          : record.status,
    degraded: degradedReasons.length > 0,
    degradedReasons,
    sourceCommitHash: record.sourceCommitHash,
    recordStatus: record.status,
  };
}

function graphSeed(identity: Record<string, unknown>): string | undefined {
  const target = identity.target;
  if (isRecord(target) && typeof target.id === 'string') return target.id;
  return typeof identity.id === 'string' ? identity.id : undefined;
}

function rowString(row: QueryRow, key: string, index: number): string {
  const value = row[key] ?? row[index] ?? row[String(index)];
  return typeof value === 'string' ? value : '';
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(Math.max(value, min), max)
    : fallback;
}

function inclusionReason(mode: ContextNeighborhoodMode): string {
  return mode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
