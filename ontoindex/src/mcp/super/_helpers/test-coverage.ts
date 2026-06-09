/**
 * _helpers/test-coverage.ts — shared test-coverage extractor (Phase 2 W2-helper).
 *
 * Used by gn_safe_edit_check (W2a), gn_can_delete (W2b), and
 * gn_pre_commit_audit (W2c).  Pure read-only facade — no side effects.
 */

import { executeParameterized } from '../../../core/lbug/pool-adapter.js';

type CoverageRow = Record<string, unknown> & { [index: number]: unknown };

function rowString(row: CoverageRow, key: string, index: number): string {
  return (row[key] ?? row[index] ?? '') as string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TestCoverageResult {
  coveringTests: string[];
  likelihoodOfCoverage: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
}

/**
 * Find test files that import (directly or transitively via co-change) the
 * file containing the named symbol.
 *
 * Algorithm:
 * 1. Find files that IMPORT the symbol's file and match test/spec naming.
 *    Classify: 3+ → HIGH, 1-2 → MEDIUM.
 * 2. If none found, check for CO_CHANGED_WITH relationships between the
 *    symbol's file and a test-named file → LOW.
 * 3. Otherwise → NONE.
 *
 * Best-effort — errors return NONE + a warning string rather than throwing.
 */
export async function findTestFiles(
  repoId: string,
  symbolFilePath: string,
  _symbolName: string,
): Promise<TestCoverageResult> {
  // --- Step 1: direct IMPORTS from test-named files -----------------------
  let coveringTests: string[] = [];
  try {
    const rows = (await executeParameterized(
      repoId,
      `MATCH (t:File)-[r:CodeRelation {type: 'IMPORTS'}]->(target:File {filePath: $symbolPath})
       WHERE t.filePath =~ '.*test.*' OR t.filePath =~ '.*spec.*'
       RETURN t.filePath AS testPath`,
      { symbolPath: symbolFilePath },
    )) as CoverageRow[];
    coveringTests = rows.map((row) => rowString(row, 'testPath', 0)).filter(Boolean);
  } catch {
    // Cypher error — fall through to NONE
    return { coveringTests: [], likelihoodOfCoverage: 'NONE' };
  }

  if (coveringTests.length >= 3) {
    return { coveringTests, likelihoodOfCoverage: 'HIGH' };
  }
  if (coveringTests.length >= 1) {
    return { coveringTests, likelihoodOfCoverage: 'MEDIUM' };
  }

  // --- Step 2: co-change with test-named files ----------------------------
  try {
    const coRows = (await executeParameterized(
      repoId,
      `MATCH (f:File {filePath: $symbolPath})-[r:CodeRelation {type: 'CO_CHANGED_WITH'}]-(other:File)
       WHERE other.filePath =~ '.*test.*' OR other.filePath =~ '.*spec.*'
       RETURN other.filePath AS coPath
       LIMIT 5`,
      { symbolPath: symbolFilePath },
    )) as CoverageRow[];
    const coTestFiles = coRows.map((row) => rowString(row, 'coPath', 0)).filter(Boolean);
    if (coTestFiles.length > 0) {
      return { coveringTests: coTestFiles, likelihoodOfCoverage: 'LOW' };
    }
  } catch {
    // best-effort — ignore
  }

  return { coveringTests: [], likelihoodOfCoverage: 'NONE' };
}
