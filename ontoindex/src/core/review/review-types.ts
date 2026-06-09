/**
 * Shared types for the graph-aware diff review core.
 *
 * Used by `diff-review.ts` (the shared builder), `gn_diff_impact` (MCP super-function),
 * and `detectChanges` (MCP local backend) to ensure a single canonical representation of
 * changed-file symbols and their blast-radius risk.
 *
 * REV-3 additions: process/community enrichment sections.
 * These fields are optional so callers that do not query the graph remain compatible.
 * Missing data is represented by `processesAvailable: false` / `communitiesAvailable: false`
 * in `GraphSections`, never silently omitted.
 */

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

export type ReviewRisk = 'LOW' | 'MEDIUM' | 'HIGH';

/** Classify an upstream caller count into a risk tier. */
export function classifyReviewRisk(upstreamCount: number): ReviewRisk {
  if (upstreamCount > 50) return 'HIGH';
  if (upstreamCount >= 10) return 'MEDIUM';
  return 'LOW';
}

// ---------------------------------------------------------------------------
// Shared symbol shape
// ---------------------------------------------------------------------------

/**
 * Canonical shape of a symbol entry found in a changed file.
 * Fields are `unknown` because graph query rows carry untyped values at runtime.
 * Both the DEFINES-based path (diff-review) and hunk-overlap path (detect-changes) produce this shape.
 */
export interface ChangedFileSymbol {
  id: unknown;
  name: unknown;
  type: unknown;
  filePath: unknown;
}

// ---------------------------------------------------------------------------
// Review result types (used by diff-review builder and gn_diff_impact)
// ---------------------------------------------------------------------------

export interface ReviewSymbolImpact {
  upstreamCount: number;
  downstreamCount: number;
  risk: ReviewRisk;
  /**
   * True when `upstreamCount` comes from a cheap single-hop direct count
   * rather than the authoritative impact kernel traversal.
   */
  heuristic: boolean;
}

export interface ReviewSymbol {
  nodeId: string;
  name: string;
  impact: ReviewSymbolImpact;
}

export interface ReviewFile {
  path: string;
  addedLines: number;
  removedLines: number;
  changedSymbols: ReviewSymbol[];
}

export interface DiffReviewResult {
  reviewedFiles: ReviewFile[];
  totalSymbolsChanged: number;
  highRiskSymbols: string[];
  warnings: string[];
  /** REV-3: Execution flows that contain at least one changed symbol. Optional; absent means not queried. */
  affectedProcesses?: AffectedProcess[];
  /** REV-3: Community clusters that contain at least one changed symbol. Optional; absent means not queried. */
  affectedCommunities?: AffectedCommunity[];
  /**
   * REV-3: Human-readable risk hints derived from cross-community edges and public API exposure.
   * These are ranking aids only — they never trim or replace complete impact counts.
   */
  crossCommunityRiskReasons?: string[];
  /**
   * REV-3: Availability flags so consumers can distinguish "no results" from "not queried".
   * Present whenever an attempt to fetch processes/communities was made.
   */
  graphSections?: GraphSections;
}

// ---------------------------------------------------------------------------
// REV-3: Process / community enrichment types
// ---------------------------------------------------------------------------

/** A process/execution flow that contains at least one changed symbol as a step. */
export interface AffectedProcess {
  id: string;
  name: string;
  processType: string;
  changedStepCount: number;
}

/** A community/cluster that contains at least one changed symbol. */
export interface AffectedCommunity {
  id: string;
  name: string;
  changedSymbolCount: number;
}

/**
 * Availability flags for the optional process/community sections.
 * `true`  = the data was queried and the result (possibly empty) is in the corresponding array.
 * `false` = the data could not be fetched (index absent, query error, etc.).
 */
export interface GraphSections {
  processesAvailable: boolean;
  communitiesAvailable: boolean;
}
