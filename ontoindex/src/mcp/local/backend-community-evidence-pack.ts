import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { CommunityEvidencePackParams } from './tool-params.js';

interface SymbolInfo {
  uid: string;
  name: string;
  kind: string;
  filePath: string;
  citationCount: number;
}

interface ProcessInfo {
  id: string;
  label: string;
  stepCount: number;
}

interface ConceptInfo {
  conceptId: string;
  label: string;
  sourceDocuments: string[];
}

interface CommunityEvidencePackResult {
  status: 'success';
  communityId: string;
  symbols: SymbolInfo[];
  processes: ProcessInfo[];
  concepts: ConceptInfo[];
  citationDensity: number;
  emptyResult: boolean;
  truncationState: {
    symbols: boolean;
    processes: boolean;
    concepts: boolean;
  };
}

interface CommunityEvidencePackError {
  status: 'error';
  communityId: string;
  error: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function normalizeLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value || 0);
}

function trimToLimit<T>(rows: T[], limit: number): { items: T[]; truncated: boolean } {
  return {
    items: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}

export async function runCommunityEvidencePack(
  repo: { id: string; name: string },
  params: CommunityEvidencePackParams,
): Promise<CommunityEvidencePackResult | CommunityEvidencePackError> {
  const communityId = params.community_id || 'default';
  const limit = normalizeLimit(params.limit);
  const rowLimit = limit + 1;

  try {
    const symbolRows = (await executeParameterized(
      repo.id,
      `
      MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE c.id = $communityId OR c.label = $communityId OR c.heuristicLabel = $communityId
      OPTIONAL MATCH (doc:File)-[r:CodeRelation {type: 'MENTIONS'}]->(n)
      RETURN n.id AS uid, n.name AS name, labels(n)[0] AS kind, n.filePath AS filePath, count(r) AS citationCount
      ORDER BY citationCount DESC, n.filePath ASC, n.name ASC, n.id ASC
      LIMIT $rowLimit
    `,
      { communityId, rowLimit },
    )) as any[];

    const processRows = (await executeParameterized(
      repo.id,
      `
      MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE c.id = $communityId OR c.label = $communityId OR c.heuristicLabel = $communityId
      MATCH (n)-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
      RETURN DISTINCT p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.stepCount AS stepCount
      ORDER BY p.stepCount DESC, p.label ASC, p.heuristicLabel ASC, p.id ASC
      LIMIT $rowLimit
    `,
      { communityId, rowLimit },
    )) as any[];

    const conceptRows = (await executeParameterized(
      repo.id,
      `
      MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE c.id = $communityId OR c.label = $communityId OR c.heuristicLabel = $communityId
      MATCH (concept:Concept)-[:CodeRelation {type: 'EXPLAINED_BY'}]->(n)
      OPTIONAL MATCH (concept)-[:CodeRelation {type: 'EXPLAINED_BY'}]->(doc:File)
      RETURN DISTINCT concept.id AS conceptId, concept.name AS label, doc.filePath AS docPath
      ORDER BY concept.name ASC, concept.id ASC, doc.filePath ASC
      LIMIT $rowLimit
    `,
      { communityId, rowLimit },
    )) as any[];

    const trimmedSymbols = trimToLimit(symbolRows, limit);
    const trimmedProcesses = trimToLimit(processRows, limit);
    const trimmedConceptRows = trimToLimit(conceptRows, limit);

    const symbols: SymbolInfo[] = trimmedSymbols.items.map((row) => ({
      uid: asString(row.uid),
      name: asString(row.name),
      kind: asString(row.kind),
      filePath: asString(row.filePath),
      citationCount: asNumber(row.citationCount),
    }));

    const processes: ProcessInfo[] = trimmedProcesses.items.map((row) => ({
      id: asString(row.id),
      label: asString(row.label) || asString(row.heuristicLabel),
      stepCount: asNumber(row.stepCount),
    }));

    const conceptMap = new Map<string, ConceptInfo>();
    for (const row of trimmedConceptRows.items) {
      const conceptId = asString(row.conceptId);
      if (!conceptId) continue;
      const existing = conceptMap.get(conceptId);
      if (!existing) {
        conceptMap.set(conceptId, {
          conceptId,
          label: asString(row.label) || conceptId,
          sourceDocuments: [],
        });
      }
      const docPath = asString(row.docPath);
      if (docPath) {
        const concept = conceptMap.get(conceptId)!;
        if (!concept.sourceDocuments.includes(docPath)) {
          concept.sourceDocuments.push(docPath);
        }
      }
    }
    const concepts = [...conceptMap.values()].map((concept) => ({
      ...concept,
      sourceDocuments: [...concept.sourceDocuments].sort(),
    }));

    const totalCitations = symbols.reduce((acc, s) => acc + s.citationCount, 0);
    const citationDensity = symbols.length > 0 ? totalCitations / symbols.length : 0;
    const emptyResult = symbols.length === 0 && processes.length === 0 && concepts.length === 0;

    return {
      status: 'success',
      communityId,
      symbols,
      processes,
      concepts,
      citationDensity,
      emptyResult,
      truncationState: {
        symbols: trimmedSymbols.truncated,
        processes: trimmedProcesses.truncated,
        concepts: trimmedConceptRows.truncated,
      },
    };
  } catch (err: any) {
    return {
      status: 'error',
      communityId,
      error: `Failed to generate community evidence pack: ${err.message}`,
    };
  }
}
