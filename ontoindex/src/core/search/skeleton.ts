import { executeParameterized } from '../lbug/pool-adapter.js';

interface SkeletonQueryRow {
  readonly [field: string]: unknown;
  readonly [index: number]: unknown;
  readonly name?: string;
  readonly type?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface SymbolSkeleton {
  name: string;
  type: string;
  startLine: number;
  endLine: number;
}

/**
 * Generate a concise skeleton of a file's exported symbols.
 */
export async function getFileSkeleton(
  repoId: string,
  filePath: string,
  depth?: number,
): Promise<string> {
  try {
    const query = `
      MATCH (n)
      WHERE n.filePath = $filePath 
        AND labels(n)[0] IN ['Function', 'Method', 'Class', 'Interface']
        AND (n.isExported = true OR n.isExported IS NULL)
      RETURN n.name AS name, labels(n)[0] AS type, n.startLine AS startLine, n.endLine AS endLine
      ORDER BY n.startLine ASC
    `;

    const rows = await executeParameterized<SkeletonQueryRow>(repoId, query, { filePath });
    if (rows.length === 0) return '';

    const lines = rows.map((r) => {
      const typeValue = r.type || r[1];
      if (typeof typeValue !== 'string') {
        throw new TypeError('Skeleton query row is missing a symbol type');
      }
      const type = typeValue.toLowerCase();
      const name = r.name || r[0];
      return `  - ${type} ${name} (lines ${r.startLine}-${r.endLine})`;
    });

    return `Symbols in ${filePath}:\n${lines.join('\n')}`;
  } catch (err) {
    return '';
  }
}
