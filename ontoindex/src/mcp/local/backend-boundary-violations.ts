import fs from 'fs/promises';
import path from 'path';
import { minimatch } from 'minimatch';
import { normalizeLimit } from './tool-utils.js';
import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { AnalysisResult, DiagnosticFinding } from 'ontoindex-shared';

type RepoHandle = { readonly id: string; readonly name: string; readonly repoPath: string };

/**
 * Maps internal BoundaryEdgeRow to normalized DiagnosticFinding (Phase D).
 */
function mapViolationsToFindings(
  rows: BoundaryEdgeRow[],
  rules: NormalizedRule[],
): DiagnosticFinding[] {
  return rows.map((r) => {
    const ruleId = (r as any).ruleId;
    const rule = rules.find((rule) => rule.id === ruleId);
    const sourcePath = (r as any).sourcePath;
    const targetPath = (r as any).targetPath;

    return {
      ruleId: `GNV-${ruleId.replace('rule_', '').padStart(3, '0')}`,
      ruleName: rule?.label || 'Boundary Violation',
      severity: 'critical',
      confidence: 1.0,
      message: `Boundary violation: '${r.sourceName}' (${sourcePath}) calls '${r.targetName}' (${targetPath}), violating rule: ${rule?.from} -> ${rule?.to}.`,
      location: {
        filePath: sourcePath,
        symbolName: r.sourceName || undefined,
      },
      properties: {
        ...r,
      },
      suggestion: 'Remove the illegal dependency or update the boundary rules.',
    };
  });
}

interface BoundaryEdgeRow {
  sourceId: string | null;
  sourceName: string | null;
  sourceFilePath: string | null;
  targetId: string | null;
  targetName: string | null;
  targetFilePath: string | null;
  edgeType: string | null;
}

interface RawRule {
  from?: unknown;
  to?: unknown;
  label?: unknown;
  forbidden_edge_types?: unknown;
}

interface NormalizedRule {
  id: string;
  from: string;
  to: string;
  label: string;
  forbidden_edge_types: string[];
}

interface BoundaryViolationsResult {
  status: 'success' | 'error';
  tool: 'boundary_violations';
  repo: string;
  limit_per_rule: number;
  violations: Array<{
    rule_id: string;
    rule_label: string;
    edge_type: string;
    source_file: string;
    target_file: string;
    source_symbol?: string;
    target_symbol?: string;
  }>;
  clean_rules: string[];
  summary: {
    rules_checked: number;
    rules_clean: number;
    rules_violated: number;
    total_violations: number;
  };
  error?: string;
}

const DEFAULT_EDGE_TYPES = ['CALLS', 'IMPORTS'];

function formatCaughtError(err: unknown): string {
  const message = err == null ? undefined : (err as { readonly message?: unknown }).message;
  return `${message ?? String(err)}`;
}

function normalizeRule(raw: RawRule, index: number): NormalizedRule {
  const from = typeof raw.from === 'string' ? raw.from.trim() : '';
  const to = typeof raw.to === 'string' ? raw.to.trim() : '';
  if (!from || !to) throw new Error(`Rule ${index + 1} must include non-empty from and to globs`);
  const edgeTypes = Array.isArray(raw.forbidden_edge_types)
    ? Array.from(
        new Set(
          raw.forbidden_edge_types
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        ),
      )
    : DEFAULT_EDGE_TYPES.slice();
  if (edgeTypes.length === 0) {
    throw new Error(`Rule ${index + 1} must include at least one forbidden edge type`);
  }
  const label =
    typeof raw.label === 'string' && raw.label.trim().length > 0
      ? raw.label.trim()
      : `${from} -> ${to}`;
  return { id: `rule_${index + 1}`, from, to, label, forbidden_edge_types: edgeTypes };
}

async function loadRules(
  repo: RepoHandle,
  params: { rules?: unknown; rules_file?: unknown },
): Promise<NormalizedRule[]> {
  if (Array.isArray(params.rules)) {
    return params.rules.map((rule, index) => normalizeRule((rule ?? {}) as RawRule, index));
  }
  if (typeof params.rules_file === 'string' && params.rules_file.trim().length > 0) {
    const rulesFile = path.isAbsolute(params.rules_file)
      ? params.rules_file
      : path.join(repo.repoPath, params.rules_file);
    const raw = JSON.parse(await fs.readFile(rulesFile, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('rules_file must contain a JSON array');
    return raw.map((rule, index) => normalizeRule((rule ?? {}) as RawRule, index));
  }
  throw new Error('Provide either rules or rules_file');
}

export async function runBoundaryViolations(
  repo: RepoHandle,
  params: { rules?: unknown; rules_file?: unknown; limit_per_rule?: number },
): Promise<AnalysisResult> {
  const start = Date.now();
  const limitPerRule = normalizeLimit(params?.limit_per_rule, 20, 200);

  try {
    const rules = await loadRules(repo, params);
    const edgeTypes = Array.from(new Set(rules.flatMap((rule) => rule.forbidden_edge_types)));
    const rows = (await executeParameterized(
      repo.id,
      `
      MATCH (src)-[r:CodeRelation]->(dst)
      WHERE r.type IN $edgeTypes AND src.filePath IS NOT NULL AND dst.filePath IS NOT NULL
      RETURN
        src.id AS sourceId,
        src.name AS sourceName,
        src.filePath AS sourceFilePath,
        dst.id AS targetId,
        dst.name AS targetName,
        dst.filePath AS targetFilePath,
        r.type AS edgeType
      `,
      { edgeTypes },
    )) as BoundaryEdgeRow[];

    const matchedViolations: BoundaryEdgeRow[] = [];
    const cleanRules: string[] = [];
    let violatedRulesCount = 0;

    for (const rule of rules) {
      const matched = rows
        .filter((row) => {
          const sourceFile = row.sourceFilePath?.replace(/\\/g, '/');
          const targetFile = row.targetFilePath?.replace(/\\/g, '/');
          const edgeType = row.edgeType ?? '';
          if (!sourceFile || !targetFile) return false;
          if (!rule.forbidden_edge_types.includes(edgeType)) return false;
          return (
            minimatch(sourceFile, rule.from, { dot: true }) &&
            minimatch(targetFile, rule.to, { dot: true })
          );
        })
        .slice(0, limitPerRule)
        .map((row) => ({
          ...row,
          ruleId: rule.id,
          sourcePath: row.sourceFilePath!.replace(/\\/g, '/'),
          targetPath: row.targetFilePath!.replace(/\\/g, '/'),
        }));

      if (matched.length === 0) {
        cleanRules.push(rule.label);
      } else {
        violatedRulesCount += 1;
        matchedViolations.push(...(matched as any));
      }
    }

    const violations = matchedViolations.map((row: any) => ({
      rule_id: row.ruleId,
      rule_label: rules.find((rule) => rule.id === row.ruleId)?.label ?? row.ruleId,
      edge_type: row.edgeType ?? '',
      source_file: row.sourcePath,
      target_file: row.targetPath,
      ...(row.sourceName ? { source_symbol: row.sourceName } : {}),
      ...(row.targetName ? { target_symbol: row.targetName } : {}),
    }));
    const legacySummary = {
      rules_checked: rules.length,
      rules_clean: cleanRules.length,
      rules_violated: violatedRulesCount,
      total_violations: matchedViolations.length,
    };
    const summary = `Executed ${rules.length} boundary rules. Found ${matchedViolations.length} total violations across ${violatedRulesCount} rules. ${cleanRules.length} rules are clean.`;

    return {
      status: 'success',
      tool: 'boundary_violations',
      repo: repo.name,
      limit_per_rule: limitPerRule,
      violations,
      clean_rules: cleanRules,
      summary: legacySummary,
      findings: mapViolationsToFindings(matchedViolations as any, rules),
      stats: {
        totalFindings: matchedViolations.length,
        durationMs: Date.now() - start,
        rulesChecked: rules.length,
        rulesClean: cleanRules.length,
        rulesViolated: violatedRulesCount,
      },
      warnings: cleanRules.length > 0 ? [`Rules passed: ${cleanRules.join(', ')}`] : [],
    } as unknown as AnalysisResult & BoundaryViolationsResult;
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'boundary_violations',
      repo: repo.name,
      limit_per_rule: limitPerRule,
      violations: [],
      clean_rules: [],
      summary: {
        rules_checked: 0,
        rules_clean: 0,
        rules_violated: 0,
        total_violations: 0,
      },
      error: `Boundary violation analysis failed: ${formatCaughtError(err)}`,
      findings: [],
      stats: { totalFindings: 0, durationMs: Date.now() - start },
      errors: [`Boundary violation analysis failed: ${formatCaughtError(err)}`],
    } as unknown as AnalysisResult & BoundaryViolationsResult;
  }
}
