import { isCobolFile, isJclFile } from '../../core/ingestion/cobol-processor.js';

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Graph coordinates are zero-based except for the non-tree-sitter ingesters. */
export function sourceLine(line: number, filePath: string, kind?: unknown): number {
  return kind === 'Section' ||
    /\.(md|mdx|markdown)$/i.test(filePath) ||
    isCobolFile(filePath) ||
    isJclFile(filePath)
    ? line
    : line + 1;
}

function symbol(value: unknown): unknown {
  if (!isRow(value) || typeof value.filePath !== 'string') return value;
  const result = { ...value };
  for (const key of ['startLine', 'endLine', 'line']) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) {
      result[key] = sourceLine(value[key], value.filePath, value.type ?? value.kind);
    }
  }
  if (Array.isArray(value.citations)) {
    result.citations = value.citations.map((citation) => {
      if (!isRow(citation) || !isRow(citation.lineSpan)) return citation;
      const lineSpan = { ...citation.lineSpan };
      for (const key of ['start', 'end']) {
        if (typeof lineSpan[key] === 'number' && Number.isFinite(lineSpan[key])) {
          lineSpan[key] = sourceLine(
            lineSpan[key],
            value.filePath as string,
            value.type ?? value.kind,
          );
        }
      }
      return { ...citation, lineSpan };
    });
  }
  return result;
}

function mapRows(row: Row, key: string): Row {
  return Array.isArray(row[key]) ? { ...row, [key]: row[key].map(symbol) } : row;
}

function impactSymbols(result: unknown): unknown {
  if (!isRow(result)) return result;
  let projected = mapRows(result, 'candidates');
  if (isRow(result.sourceIdentity)) {
    projected = { ...projected, sourceIdentity: symbol(result.sourceIdentity) };
  }
  return isRow(result.target) ? { ...projected, target: symbol(result.target) } : projected;
}

function impact(result: unknown): unknown {
  const projected = impactSymbols(result);
  return isRow(projected) && isRow(projected.local)
    ? { ...projected, local: impactSymbols(projected.local) }
    : projected;
}

function context(result: Row): Row {
  const projected = mapRows(result, 'candidates');
  return isRow(result.symbol) ? { ...projected, symbol: symbol(result.symbol) } : projected;
}

/** Project only public navigation routes, once, before response paging. */
export function projectResponseSourceLines(
  tool: string,
  action: unknown,
  result: unknown,
): unknown {
  if (!isRow(result)) return result;
  const rowKeys: Record<string, string> = {
    'search/repomap': 'symbols',
    'audit/dead_code': 'entries',
    'audit/tech_debt': 'symbols',
  };
  const rowKey = rowKeys[`${tool}/${String(action)}`];
  if (rowKey) {
    const projected = mapRows(result, rowKey);
    return tool === 'audit' && action === 'tech_debt' && Array.isArray(result.findings)
      ? {
          ...projected,
          findings: result.findings.map((finding) =>
            isRow(finding) ? { ...finding, location: symbol(finding.location) } : finding,
          ),
        }
      : projected;
  }
  if (
    ((tool === 'audit' && action === 'pre_commit_audit') || tool === 'gn_pre_commit_audit') &&
    Array.isArray(result.evidence)
  ) {
    return {
      ...result,
      evidence: result.evidence.map((entry) =>
        isRow(entry) && entry.kind === 'symbol' ? symbol(entry) : entry,
      ),
    };
  }
  if (tool === 'search' && action === 'semantic') {
    let projected = mapRows(mapRows(result, 'definitions'), 'process_symbols');
    if (Array.isArray(result.processes)) {
      projected = {
        ...projected,
        processes: result.processes.map((process) =>
          isRow(process) ? mapRows(process, 'symbols') : process,
        ),
      };
    }
    if (isRow(result.structured_retrieval)) {
      projected = {
        ...projected,
        structured_retrieval: mapRows(mapRows(result.structured_retrieval, 'candidates'), 'rows'),
      };
    }
    return projected;
  }
  if (tool === 'inspect' && action === 'context') {
    const projected = context(result);
    return Array.isArray(result.results)
      ? {
          ...projected,
          results: result.results.map((entry) =>
            isRow(entry) && isRow(entry.payload) && !('error' in entry.payload)
              ? { ...entry, payload: context(entry.payload) }
              : entry,
          ),
        }
      : projected;
  }
  if (tool === 'impact' && action === 'symbol') return impact(result);
  if (tool === 'impact' && action === 'batch' && Array.isArray(result.perSymbol)) {
    return {
      ...result,
      perSymbol: result.perSymbol.map((entry) =>
        isRow(entry) ? { ...entry, result: impact(entry.result) } : entry,
      ),
    };
  }
  return result;
}
