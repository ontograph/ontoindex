import { scanAuditPatterns } from './scan-engine.js';
import type { AuditResponse, AuditRequirementItem } from 'ontoindex-shared';
import path from 'path';
import { walkRepositoryPaths } from '../core/ingestion/filesystem-walker.js';
import { executeParameterized } from '../core/lbug/pool-adapter.js';
import type { LbugQueryRow } from '../core/lbug/pool-adapter.js';

interface RequirementsTraceOptions {
  repoId?: string;
  repoPath: string;
  ids?: string[];
  idPattern?: string; // Regex pattern to find IDs, e.g. "REQ-\\d+"
}

type CountRow = LbugQueryRow & {
  readonly hits: number;
  readonly 0?: number;
};

/**
 * Map requirement IDs to code/test evidence.
 */
export async function auditRequirementsTrace(
  options: RequirementsTraceOptions,
): Promise<AuditResponse> {
  const { repoId, repoPath, ids, idPattern = '[A-Z]{2,}-\\d+' } = options;

  // 1. Get all source/test files
  const scannedFiles = await walkRepositoryPaths(repoPath);
  const files = scannedFiles
    .filter((f) => {
      const p = f.path.toLowerCase();
      return (
        p.endsWith('.js') ||
        p.endsWith('.ts') ||
        p.endsWith('.tsx') ||
        p.endsWith('.jsx') ||
        p.endsWith('.cc') ||
        p.endsWith('.cpp') ||
        p.endsWith('.h')
      );
    })
    .map((f) => path.join(repoPath, f.path));

  if (files.length === 0) {
    return { summary: 'No source files found to trace requirements', items: [] };
  }

  // 2. Prepare scan patterns
  // If specific IDs provided, look for them. Otherwise, use the general pattern.
  const patterns =
    ids && ids.length > 0
      ? ids.map((id) => ({ id, kind: 'literal' as const, expression: id }))
      : [{ id: 'discovered_id', kind: 'regex' as const, expression: idPattern }];

  // 3. Run scan
  const scanResult = await scanAuditPatterns({
    files,
    patterns,
  });

  // 4. Group by ID and collect evidence locations
  const itemMap = new Map<
    string,
    AuditRequirementItem & { locations: { file: string; line: number; isStructural: boolean }[] }
  >();

  for (const hit of scanResult.hits) {
    const id = hit.pattern_id === 'discovered_id' ? hit.match_text : hit.pattern_id;
    const relFile = path.relative(repoPath, hit.file);

    let item = itemMap.get(id);
    if (!item) {
      item = {
        id,
        status: 'missing',
        confidence: 'high',
        evidence: [],
        reason: '',
        locations: [],
      };
      itemMap.set(id, item);
    }

    // Check if this location is "structural" (inside a function/class/method)
    // We use a small window (line - 1 to line + 1) to catch IDs in decorators or JSDoc just above the symbol
    let isStructural = false;
    if (repoId) {
      try {
        const structuralNodes = await executeParameterized<CountRow>(
          repoId,
          `MATCH (n) 
           WHERE n.filePath = $file 
           AND (
             (n.startLine <= $line AND n.endLine >= $line) OR
             (n.startLine = $line + 1)
           )
           AND (labels(n)[0] IN ['Function', 'Method', 'Class', 'Struct', 'Interface'] OR labels(n)[0] = '')
           RETURN count(n) as hits`,
          { file: relFile, line: hit.line },
        );
        if (
          structuralNodes.length > 0 &&
          (structuralNodes[0].hits > 0 || structuralNodes[0][0] > 0)
        ) {
          isStructural = true;
        }
      } catch (e) {}
    }

    const evidenceStr = `${relFile}:${hit.line}`;
    if (!item.evidence!.includes(evidenceStr)) {
      item.evidence!.push(evidenceStr);
      item.locations.push({ file: relFile, line: hit.line, isStructural });
    }
  }

  // 5. Classify status based on structural evidence
  for (const item of itemMap.values()) {
    const hasTest = item.locations.some(
      (loc) =>
        loc.file.includes('.test.') || loc.file.includes('.spec.') || loc.file.startsWith('test/'),
    );

    // Implementation requires the ID to be found inside a structural code node
    const hasStructuralImpl = item.locations.some(
      (loc) =>
        loc.isStructural &&
        !loc.file.includes('.test.') &&
        !loc.file.includes('.spec.') &&
        !loc.file.startsWith('test/'),
    );

    const hasAnyImpl = item.locations.some(
      (loc) =>
        !loc.file.includes('.test.') &&
        !loc.file.includes('.spec.') &&
        !loc.file.startsWith('test/'),
    );

    if (hasStructuralImpl && hasTest) {
      item.status = 'implemented';
      item.reason = 'Implementation (in code structure) and test evidence found.';
    } else if (hasStructuralImpl) {
      item.status = 'partial';
      item.reason = 'Implementation found in code structure, but no test evidence detected.';
    } else if (hasAnyImpl && hasTest) {
      item.status = 'partial';
      item.reason =
        'Test evidence found and requirement mentioned in source, but implementation site is not a formal code structure (e.g., global constant or comment only).';
    } else if (hasAnyImpl) {
      item.status = 'partial';
      item.reason =
        'Requirement mentioned in source files, but not within a formal code structure.';
    } else if (hasTest) {
      item.status = 'partial';
      item.reason = 'Test evidence found, but no implementation detected in source files.';
    }
  }

  // Handle explicitly requested IDs that were not found
  if (ids) {
    for (const requestedId of ids) {
      if (!itemMap.has(requestedId)) {
        itemMap.set(requestedId, {
          id: requestedId,
          status: 'missing',
          confidence: 'high',
          evidence: [],
          locations: [],
          reason: 'No matches found in codebase.',
        });
      }
    }
  }

  const items = Array.from(itemMap.values());

  return {
    summary: `Traced ${items.length} requirements across the codebase`,
    items,
  };
}
