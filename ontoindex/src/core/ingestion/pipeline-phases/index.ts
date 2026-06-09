/**
 * Pipeline Phases — barrel export.
 *
 * Exports all phases, the runner, types, and shared utilities
 * for the ingestion pipeline.
 */

// ── Phase exports (in dependency order) ────────────────────────────────────

export { scanPhase, type ScanOutput } from './scan.js';
export { gitMiningPhase } from './git-mining.js';
export { structurePhase, type StructureOutput } from './structure.js';
export { markdownPhase, type MarkdownOutput } from './markdown.js';
export { cobolPhase, type CobolOutput } from './cobol.js';
export { parsePhase, type ParseOutput } from './parse.js';
export {
  optionalPrecisionPhase,
  type OptionalPrecisionAnalyzerOptions,
  type OptionalPrecisionOutput,
} from './optional-precision.js';
export { routesPhase, type RoutesOutput } from './routes.js';
export { toolsPhase, type ToolsOutput } from './tools.js';
export { ormPhase, type ORMOutput } from './orm.js';
export { crossFilePhase, type CrossFileOutput } from './cross-file.js';
export { pageRankPhase } from './pagerank.js';
export { mroPhase, type MROOutput } from './mro.js';
export { communitiesPhase, type CommunitiesOutput } from './communities.js';
export { conceptsPhase } from './concepts.js';
export { processesPhase, type ProcessesOutput } from './processes.js';
export { summaryTreePhase, type SummaryTreeOutput } from './summary-tree.js';

// ── Infrastructure ─────────────────────────────────────────────────────────

export { runPipeline } from './runner.js';
export type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
export { getPhaseOutput } from './types.js';
