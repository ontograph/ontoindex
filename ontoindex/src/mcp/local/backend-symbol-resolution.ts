import { executeParameterized } from '../../core/lbug/pool-adapter.js';

interface SymbolResolutionRepoHandle {
  id: string;
}

interface CandidateWithType {
  id: string;
  type: string;
}

interface CandidateForScoring {
  kind: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  content?: string;
}

interface ResolutionHints {
  file_path?: string;
  kind?: string;
}

interface ResolutionQuery {
  uid?: string;
  name?: string;
  include_content?: boolean;
}

interface ResolvedSymbol {
  id: string;
  name: string;
  type: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content?: string;
}

interface AmbiguousSymbol extends ResolvedSymbol {
  score: number;
}

type SymbolResolutionOutcome =
  | {
      kind: 'ok';
      symbol: ResolvedSymbol;
      resolvedLabel: string;
    }
  | {
      kind: 'ambiguous';
      candidates: AmbiguousSymbol[];
    }
  | { kind: 'not_found' };

type QueryRow = Record<string, unknown> | readonly unknown[];

function rowValue(row: QueryRow, key: string, index: number): unknown {
  const keyedValue = (row as Record<string, unknown>)[key];
  if (keyedValue != null) return keyedValue;
  return Array.isArray(row) ? row[index] : row[String(index)];
}

/**
 * Patch the `type` field on candidates whose `labels(n)[0]` projection
 * came back empty — a known LadybugDB behaviour for several node types.
 */
export async function enrichCandidateLabels(
  repo: SymbolResolutionRepoHandle,
  candidates: CandidateWithType[],
): Promise<void> {
  const ids = candidates.filter((c) => c.type === '' && c.id).map((c) => c.id);
  if (ids.length === 0) return;
  try {
    const rows = await executeParameterized(
      repo.id,
      `
      MATCH (n:\`Class\`) WHERE n.id IN $ids RETURN n.id AS id, 'Class' AS label
      UNION ALL
      MATCH (n:\`Interface\`) WHERE n.id IN $ids RETURN n.id AS id, 'Interface' AS label
      UNION ALL
      MATCH (n:\`Function\`) WHERE n.id IN $ids RETURN n.id AS id, 'Function' AS label
      UNION ALL
      MATCH (n:\`Method\`) WHERE n.id IN $ids RETURN n.id AS id, 'Method' AS label
      UNION ALL
      MATCH (n:\`Constructor\`) WHERE n.id IN $ids RETURN n.id AS id, 'Constructor' AS label
      `,
      { ids },
    );
    const labelById = new Map<string, string>();
    for (const r of rows as QueryRow[]) {
      const id = rowValue(r, 'id', 0) as string;
      const label = rowValue(r, 'label', 1) as string;
      if (id && label && !labelById.has(id)) labelById.set(id, label);
    }
    for (const c of candidates) {
      if (c.type === '' && labelById.has(c.id)) c.type = labelById.get(c.id) as string;
    }
  } catch {
    /* best-effort — downstream resolvers still work without the label */
  }
}

/**
 * Score a symbol candidate for disambiguation ranking.
 */
function scoreCandidate(c: CandidateForScoring, hints: ResolutionHints): number {
  let s = 0.5;
  if (hints.file_path && c.filePath && typeof c.filePath === 'string') {
    if (c.filePath.toLowerCase().includes(hints.file_path.toLowerCase())) {
      s += 0.4;
    }
  }
  if (hints.kind && c.kind === hints.kind) {
    s += 0.2;
  }
  if (!hints.kind) {
    const priority: Record<string, number> = {
      Class: 5,
      Interface: 4,
      Function: 3,
      Method: 2,
      Constructor: 1,
    };
    s += (priority[c.kind] ?? 0) * 0.02;
  }
  s += definitionScore(c);
  return Math.min(1.0, s);
}

function definitionScore(c: CandidateForScoring): number {
  const content = c.content?.trim();
  if (content) {
    const compact = content.replace(/\s+/g, ' ');
    const hasBody = /{|=>/.test(content) || /\)\s*:\s*\n\s+\S/.test(content);
    const declarationOnly =
      compact.endsWith(';') && !content.includes('{') && !content.includes('=>');
    const stubOnly =
      /\bpass\b|\.\.\.|not implemented|unimplemented!?/.test(compact) && !content.includes('{');
    if (declarationOnly || stubOnly) return -0.12;
    if (hasBody) return 0.12;
  }
  if (typeof c.startLine === 'number' && typeof c.endLine === 'number' && c.endLine > c.startLine) {
    return 0.06;
  }
  return 0;
}

function parseSymbolRow(r: QueryRow, include_content?: boolean): ResolvedSymbol {
  return {
    id: rowValue(r, 'id', 0) as string,
    name: rowValue(r, 'name', 1) as string,
    type: (rowValue(r, 'type', 2) ?? '') as string,
    filePath: rowValue(r, 'filePath', 3) as string,
    startLine: rowValue(r, 'startLine', 4) as number,
    endLine: rowValue(r, 'endLine', 5) as number,
    ...(include_content ? { content: rowValue(r, 'content', 6) as string | undefined } : {}),
  };
}

/**
 * Shared symbol resolver used by `context` and `impact`.
 *
 * Preserves the #480 Class/Constructor preference: when the only
 * ambiguity is between a Class and its own Constructor (same name,
 * same filePath), the Class wins silently.
 */
export async function resolveSymbolCandidates(
  repo: SymbolResolutionRepoHandle,
  query: ResolutionQuery,
  hints: ResolutionHints,
): Promise<SymbolResolutionOutcome> {
  const { uid, name, include_content } = query;
  const selectClause = `n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`;

  if (uid) {
    const rows = await executeParameterized(
      repo.id,
      `MATCH (n {id: $uid}) RETURN ${selectClause} LIMIT 1`,
      { uid },
    );
    if (rows.length === 0) return { kind: 'not_found' };
    const symbol = parseSymbolRow(rows[0], include_content);
    await enrichCandidateLabels(repo, [symbol]);
    return { kind: 'ok', symbol, resolvedLabel: symbol.type };
  }

  if (!name) return { kind: 'not_found' };

  const isQualified = name.includes('/') || name.includes(':');
  let whereClause: string;
  const queryParams: Record<string, unknown> = { symName: name };
  if (hints.file_path) {
    whereClause = `WHERE n.name = $symName AND n.filePath CONTAINS $filePath`;
    queryParams.filePath = hints.file_path;
  } else if (isQualified) {
    whereClause = `WHERE n.id = $symName OR n.name = $symName`;
  } else {
    whereClause = `WHERE n.name = $symName`;
  }

  const rows = await executeParameterized(
    repo.id,
    `MATCH (n) ${whereClause} RETURN ${selectClause} LIMIT 20`,
    queryParams,
  );

  if (rows.length === 0) return { kind: 'not_found' };

  const queryRows = rows as QueryRow[];
  const normalized: ResolvedSymbol[] = queryRows.map((r) => parseSymbolRow(r, include_content));

  await enrichCandidateLabels(repo, normalized);

  if (!hints.kind && normalized.length > 1) {
    const ambiguousType = normalized.some((s) => s.type === '' || s.type === 'Constructor');
    if (ambiguousType) {
      const candidateIds = normalized.map((s) => s.id).filter(Boolean);
      for (const label of ['Class', 'Interface']) {
        const labelRows = await executeParameterized(
          repo.id,
          `MATCH (n:\`${label}\`) WHERE n.id IN $candidateIds RETURN n.id AS id LIMIT 1`,
          { candidateIds },
        ).catch(() => []);
        if (labelRows.length > 0) {
          const preferredId = rowValue(labelRows[0] as QueryRow, 'id', 0);
          const preferred = normalized.find((s) => s.id === preferredId);
          if (preferred) {
            return {
              kind: 'ok',
              symbol: preferred,
              resolvedLabel: label,
            };
          }
        }
      }
    }
  }

  if (normalized.length === 1) {
    return {
      kind: 'ok',
      symbol: normalized[0],
      resolvedLabel: '',
    };
  }

  const scored: AmbiguousSymbol[] = normalized.map((s, index) => ({
    ...s,
    score: scoreCandidate(
      {
        kind: s.type,
        filePath: s.filePath || '',
        startLine: s.startLine,
        endLine: s.endLine,
        content: s.content ?? (rowValue(queryRows[index], 'content', 6) as string | undefined),
      },
      hints,
    ),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const fpA = (a.filePath || '').length;
    const fpB = (b.filePath || '').length;
    if (fpA !== fpB) return fpA - fpB;
    return String(a.id).localeCompare(String(b.id));
  });

  if (scored.length >= 2 && scored[0].score >= 0.95 && scored[0].score - scored[1].score > 0.09) {
    return { kind: 'ok', symbol: scored[0], resolvedLabel: scored[0].type };
  }

  return { kind: 'ambiguous', candidates: scored };
}
