import { z } from 'zod';
import type { RegistryEntry } from '../../storage/repo-manager.js';
import { RETRIEVAL_POLICY_NAMES } from '../../core/ingestion/enrichment/index.js';
import { CONTEXT_NEIGHBORHOOD_MODES } from './backend-context-neighborhood.js';

/**
 * Repository Handle — internal representation of an indexed repo.
 */
export interface RepoHandle {
  id: string; // unique key = repo name (basename)
  name: string;
  repoPath: string;
  path: string; // alias for repoPath
  storagePath: string;
  lbugPath: string;
  indexedAt: string;
  lastCommit: string;
  stats?: RegistryEntry['stats'];
}

/**
 * Typed Parameters for Local Backend Tools
 *
 * Defines interfaces and Zod schemas for all MCP tools handled by LocalBackend.
 * These correspond to the inputSchema definitions in mcp/tools.ts.
 */

export const BaseRepoSchema = z.object({
  repo: z.string().optional(),
});

export interface BaseRepoParams extends z.input<typeof BaseRepoSchema> {}

export const QuerySchema = BaseRepoSchema.extend({
  query: z.string(),
  typed_query: z.boolean().default(false),
  task_context: z.string().optional(),
  goal: z.string().optional(),
  limit: z.number().min(1).max(100).default(5),
  max_symbols: z.number().min(1).max(200).default(10),
  include_content: z.boolean().default(false),
  consume_enrichment_facts: z.boolean().default(false),
  include_passive_related_facts: z.boolean().default(false),
  include_markdown_context: z.boolean().default(false),
  include_markdown_ppr: z.boolean().default(false),
  allow_low_confidence: z.boolean().default(false),
  retrieval_policy: z.enum(RETRIEVAL_POLICY_NAMES).optional(),
});

export interface QueryParams extends z.input<typeof QuerySchema> {}

export const CypherSchema = BaseRepoSchema.extend({
  query: z.string(),
});

export interface CypherParams extends z.input<typeof CypherSchema> {}

export const ContextSchema = BaseRepoSchema.extend({
  name: z.string().optional(),
  uid: z.string().optional(),
  file_path: z.string().optional(),
  kind: z.string().optional(),
  include_content: z.boolean().default(false),
  consume_enrichment_facts: z.boolean().default(false),
  include_passive_related_facts: z.boolean().default(false),
  include_markdown_context: z.boolean().default(false),
  include_markdown_ppr: z.boolean().default(false),
  allow_low_confidence: z.boolean().default(false),
  retrieval_policy: z.enum(RETRIEVAL_POLICY_NAMES).optional(),
  neighborhood_mode: z.enum(CONTEXT_NEIGHBORHOOD_MODES).optional(),
  route: z.string().optional(),
  process_id: z.string().optional(),
  requirement_id: z.string().optional(),
  api_doc_id: z.string().optional(),
  doc_path: z.string().optional(),
  depth: z.number().min(1).max(3).optional(),
  limit: z.number().min(1).max(100).optional(),
  maxCandidates: z.number().min(1).max(20).optional(),
});

export interface ContextParams extends z.input<typeof ContextSchema> {}

export const DetectChangesSchema = BaseRepoSchema.extend({
  scope: z.enum(['unstaged', 'staged', 'all', 'compare']).default('unstaged'),
  base_ref: z.string().optional(),
});

export interface DetectChangesParams extends z.input<typeof DetectChangesSchema> {}

export const CycleDetectSchema = BaseRepoSchema.extend({
  edge_types: z.array(z.string()).default(['IMPORTS', 'CALLS']),
  min_cycle_length: z.number().min(1).max(1000).default(2),
  file_filter: z.string().optional(),
  limit: z.number().min(1).max(200).default(30),
});

export interface CycleDetectParams extends z.input<typeof CycleDetectSchema> {}

export const CouplingMatrixSchema = BaseRepoSchema.extend({
  min_symbols: z.number().min(0).max(100000).default(5),
  flag_threshold: z.number().min(0).max(1).default(0.8),
  include_cross_edges: z.boolean().default(false),
});

export interface CouplingMatrixParams extends z.input<typeof CouplingMatrixSchema> {}

export const MigrationProgressSchema = BaseRepoSchema.extend({
  old_pattern: z.string(),
  new_pattern: z.string(),
  file_glob: z.string().optional(),
  exclude_patterns: z.array(z.string()).optional(),
  label: z.string().optional(),
});

export interface MigrationProgressParams extends z.input<typeof MigrationProgressSchema> {}

export const BoundaryViolationsSchema = BaseRepoSchema.extend({
  rules: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        label: z.string().optional(),
        forbidden_edge_types: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  rules_file: z.string().optional(),
  limit_per_rule: z.number().min(1).max(200).default(20),
});

export interface BoundaryViolationsParams extends z.input<typeof BoundaryViolationsSchema> {}

export const TypeCoverageSchema = BaseRepoSchema.extend({
  patterns: z.array(z.string()).optional(),
  file_glob: z.string().optional(),
  min_caller_count: z.number().min(0).max(100000).default(0),
  limit: z.number().min(1).max(500).default(50),
});

export interface TypeCoverageParams extends z.input<typeof TypeCoverageSchema> {}

export const RenameSchema = BaseRepoSchema.extend({
  symbol_name: z.string().optional(),
  symbol_uid: z.string().optional(),
  new_name: z.string(),
  file_path: z.string().optional(),
  dry_run: z.boolean().default(true),
});

export interface RenameParams extends z.input<typeof RenameSchema> {}

export const RenameByUidSchema = BaseRepoSchema.extend({
  uid: z.string(),
  new_name: z.string(),
  dry_run: z.boolean().default(true),
  confirm: z.boolean().default(false),
});

export interface RenameByUidParams extends z.input<typeof RenameByUidSchema> {}

export const ImpactSchema = BaseRepoSchema.extend({
  target: z.string(),
  target_uid: z.string().optional(),
  direction: z.enum(['upstream', 'downstream']),
  file_path: z.string().optional(),
  kind: z.string().optional(),
  maxDepth: z.number().min(1).max(32).default(3),
  crossDepth: z.number().min(1).max(32).default(1),
  relationTypes: z.array(z.string()).optional(),
  includeTests: z.boolean().default(false),
  minConfidence: z.number().min(0).max(1).default(0),
  service: z.string().min(1).optional(),
  subgroup: z.string().optional(),
  timeoutMs: z.number().min(1).max(3600000).optional(),
  timeout: z.number().min(1).max(3600000).optional(),
  consume_enrichment_facts: z.boolean().default(false),
  allow_low_confidence: z.boolean().default(false),
  allow_safety_critical_enrichment: z.boolean().default(false),
});

export interface ImpactParams extends z.input<typeof ImpactSchema> {}

export const ImpactBatchSchema = BaseRepoSchema.extend({
  targets: z.array(z.string()),
  direction: z.enum(['upstream', 'downstream']),
  maxDepth: z.number().min(1).max(32).default(3),
  relationTypes: z.array(z.string()).optional(),
  includeTests: z.boolean().default(false),
  minConfidence: z.number().min(0).max(1).default(0.7),
});

export interface ImpactBatchParams extends z.input<typeof ImpactBatchSchema> {}

export const RouteMapSchema = BaseRepoSchema.extend({
  route: z.string().optional(),
});

export interface RouteMapParams extends z.input<typeof RouteMapSchema> {}

export const ToolMapSchema = BaseRepoSchema.extend({
  tool: z.string().optional(),
});

export interface ToolMapParams extends z.input<typeof ToolMapSchema> {}

export const ShapeCheckSchema = BaseRepoSchema.extend({
  route: z.string().optional(),
});

export interface ShapeCheckParams extends z.input<typeof ShapeCheckSchema> {}

export const ApiImpactSchema = BaseRepoSchema.extend({
  route: z.string().optional(),
  file: z.string().optional(),
});

export interface ApiImpactParams extends z.input<typeof ApiImpactSchema> {}

export const RepomapSchema = BaseRepoSchema.extend({
  focus: z.array(z.string()),
  token_budget: z.number().default(4000),
  format: z.enum(['signatures', 'outline', 'full', 'compressed']).default('signatures'),
});

export interface RepomapParams extends z.input<typeof RepomapSchema> {}

export const AnalysisCatalogSchema = BaseRepoSchema.extend({
  kind: z.enum(['library', 'query', 'model']).optional(),
  tier: z.enum(['stable', 'experimental']).optional(),
  id: z.string().optional(),
  target: z.string().optional(),
});

export interface AnalysisCatalogParams extends z.input<typeof AnalysisCatalogSchema> {}

export const RouteIntentSchema = BaseRepoSchema.extend({
  query: z.string(),
});

export interface RouteIntentParams extends z.input<typeof RouteIntentSchema> {}

export const SessionSchema = BaseRepoSchema.extend({
  action: z.enum(['get', 'set', 'list']),
  session_id: z.string(),
  key: z.string().optional(),
  value: z.string().optional(),
});

export interface SessionParams extends z.input<typeof SessionSchema> {}

export const AuditRerunSchema = BaseRepoSchema.extend({
  audit_file: z.string(),
});

export interface AuditRerunParams extends z.input<typeof AuditRerunSchema> {}

export const BuildResidueAuditSchema = BaseRepoSchema.extend({
  forbidden_domains: z.array(z.string()).optional(),
});

export interface BuildResidueAuditParams extends z.input<typeof BuildResidueAuditSchema> {}

export const CrossDocDriftSchema = BaseRepoSchema.extend({
  plan_files: z.array(z.string()).optional(),
  audit_files: z.array(z.string()).optional(),
});

export interface CrossDocDriftParams extends z.input<typeof CrossDocDriftSchema> {}

export const EvidencePackSchema = BaseRepoSchema.extend({
  targets: z.array(z.string()),
  include_snippet: z.boolean().default(true),
  context_lines: z.number().default(3),
});

export interface EvidencePackParams extends z.input<typeof EvidencePackSchema> {}

export const IpcTraceSchema = BaseRepoSchema.extend({
  symbol_name: z.string(),
});

export interface IpcTraceParams extends z.input<typeof IpcTraceSchema> {}

export const RequirementsTraceSchema = BaseRepoSchema.extend({
  ids: z.array(z.string()).optional(),
  id_pattern: z.string().default('[A-Z]{2,}-\\d+'),
});

export interface RequirementsTraceParams extends z.input<typeof RequirementsTraceSchema> {}

export const VerificationGapSchema = BaseRepoSchema.extend({
  base_ref: z.string().default('HEAD~1'),
});

export interface VerificationGapParams extends z.input<typeof VerificationGapSchema> {}

export const OverviewSchema = BaseRepoSchema.extend({
  showClusters: z.boolean().optional(),
  showProcesses: z.boolean().optional(),
  limit: z.number().optional(),
});

export interface OverviewParams extends z.input<typeof OverviewSchema> {}

export const PatternAuditSchema = BaseRepoSchema.extend({
  patterns: z.array(z.string()).optional(),
});

export interface PatternAuditParams extends z.input<typeof PatternAuditSchema> {}

export const AuditReportSchema = BaseRepoSchema.extend({
  annotate: z.boolean().optional(),
  since: z.string().optional(),
  force: z.boolean().optional(),
});

export interface AuditReportParams extends z.input<typeof AuditReportSchema> {}

export const HotspotAnalysisSchema = BaseRepoSchema.extend({
  metric: z
    .enum(['churn_x_complexity', 'change_coupling', 'ownership'])
    .default('churn_x_complexity'),
  limit: z.number().default(20),
  since: z.string().default('6 months'),
});

export interface HotspotAnalysisParams extends z.input<typeof HotspotAnalysisSchema> {}

export const GraphDiffSchema = BaseRepoSchema.extend({
  limit: z.number().default(50),
});

export interface GraphDiffParams extends z.input<typeof GraphDiffSchema> {}

export const TechDebtSchema = BaseRepoSchema.extend({
  limit: z.number().default(20),
  min_lines: z.number().default(10),
  since: z.string().default('6 months'),
});

export interface TechDebtParams extends z.input<typeof TechDebtSchema> {}

export const DeadCodeSchema = BaseRepoSchema.extend({
  include_tests: z.boolean().default(true),
  include_exported: z.boolean().default(true),
  verify: z.boolean().default(true),
  limit: z.number().default(200),
  min_stale_days: z.number().optional(),
  exclude_patterns: z.array(z.string()).optional(),
  includeIgnored: z.boolean().optional(),
});

export interface DeadCodeParams extends z.input<typeof DeadCodeSchema> {}

export const CommunityEvidencePackSchema = BaseRepoSchema.extend({
  community_id: z.string().optional(),
  limit: z.number().default(100),
});

export interface CommunityEvidencePackParams extends z.input<typeof CommunityEvidencePackSchema> {}

export const SandboxSchema = BaseRepoSchema.extend({
  action: z.enum(['stage', 'apply']).default('stage'),
  confirm: z.boolean().default(false),
  payload: z.unknown().optional(),
});

export interface SandboxParams extends z.input<typeof SandboxSchema> {}

export const ReplaceSymbolSchema = BaseRepoSchema.extend({
  uid: z.string(),
  new_body: z.string().optional(),
  dry_run: z.boolean().optional(),
  confirm: z.boolean().optional(),
});

export interface ReplaceSymbolParams extends z.input<typeof ReplaceSymbolSchema> {}

export const GetSymbolInfoSchema = BaseRepoSchema.extend({
  uid: z.string(),
});

export interface GetSymbolInfoParams extends z.input<typeof GetSymbolInfoSchema> {}

export const UpdateSymbolBodySchema = BaseRepoSchema.extend({
  uid: z.string(),
  new_body: z.string(),
  dry_run: z.boolean().default(true),
  confirm: z.boolean().default(false),
});

export interface UpdateSymbolBodyParams extends z.input<typeof UpdateSymbolBodySchema> {}

export const ExtractFunctionSchema = BaseRepoSchema.extend({
  uid: z.string(),
  new_name: z.string(),
  target_file: z.string().optional(),
  dry_run: z.boolean().default(true),
  confirm: z.boolean().default(false),
});

export interface ExtractFunctionParams extends z.input<typeof ExtractFunctionSchema> {}

export const MoveSymbolSchema = BaseRepoSchema.extend({
  uid: z.string(),
  target_file: z.string(),
  dry_run: z.boolean().default(true),
  confirm: z.boolean().default(false),
});

export interface MoveSymbolParams extends z.input<typeof MoveSymbolSchema> {}

export const DocsMcpSchema = BaseRepoSchema.extend({
  action: z.enum(['trace', 'drift', 'context', 'readiness']).default('readiness'),
  id: z.string().optional(),
  includeMemories: z.boolean().optional(),
  maxItems: z.number().min(1).max(100).optional(),
  limit: z.number().min(1).max(100).optional(),
  cursor: z.string().optional(),
  summary: z.boolean().optional(),
  minimal: z.boolean().optional(),
  maxCandidatesPerFact: z.number().min(1).max(20).optional(),
  format: z.enum(['json', 'inline', 'both']).default('json').optional(),
  maxTokens: z.number().min(80).max(4000).optional(),
  maxEvidenceItems: z.number().min(1).max(50).optional(),
});

export interface DocsMcpParams extends z.input<typeof DocsMcpSchema> {}

export const TOOL_SCHEMAS: Record<string, z.ZodObject> = {
  query: QuerySchema,
  cypher: CypherSchema,
  context: ContextSchema,
  detect_changes: DetectChangesSchema,
  cycle_detect: CycleDetectSchema,
  coupling_matrix: CouplingMatrixSchema,
  migration_progress: MigrationProgressSchema,
  boundary_violations: BoundaryViolationsSchema,
  type_coverage: TypeCoverageSchema,
  rename: RenameSchema,
  rename_symbol: RenameByUidSchema,
  search: QuerySchema,
  explore: ContextSchema,
  overview: OverviewSchema,
  route_map: RouteMapSchema,
  shape_check: ShapeCheckSchema,
  tool_map: ToolMapSchema,
  api_impact: ApiImpactSchema,
  repomap: RepomapSchema,
  route: RouteIntentSchema,
  analysis_catalog: AnalysisCatalogSchema,
  session: SessionSchema,
  pattern_audit: PatternAuditSchema,
  audit_report: AuditReportSchema,
  audit_rerun: AuditRerunSchema,
  build_residue_audit: BuildResidueAuditSchema,
  cross_doc_drift: CrossDocDriftSchema,
  evidence_pack: EvidencePackSchema,
  ipc_trace: IpcTraceSchema,
  requirements_trace: RequirementsTraceSchema,
  community_evidence_pack: CommunityEvidencePackSchema,
  impact_batch: ImpactBatchSchema,
  hotspot_analysis: HotspotAnalysisSchema,
  graph_diff: GraphDiffSchema,
  tech_debt: TechDebtSchema,
  dead_code: DeadCodeSchema,
  sandbox: SandboxSchema,
  replace_symbol: ReplaceSymbolSchema,
  get_symbol_info: GetSymbolInfoSchema,
  update_symbol_body: UpdateSymbolBodySchema,
  extract_function: ExtractFunctionSchema,
  move_symbol: MoveSymbolSchema,
  impact: ImpactSchema,
  verification_gap: VerificationGapSchema,
  docs: DocsMcpSchema,
};
