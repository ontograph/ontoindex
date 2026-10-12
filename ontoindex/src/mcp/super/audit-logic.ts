import fs from 'node:fs/promises';
import path from 'node:path';

import { createEnvelopeFromLegacy } from '../shared/response-envelope.js';
import { resolveTargetContext } from '../shared/target-context.js';
import { resolveContainedRealPath } from '../local/path-util.js';
import {
  runSystemsRuleEngine,
  type SystemsRuleCategory,
  type SystemsRuleEngineReport,
  type SystemsRuleFact,
} from '../../core/systems-audit/systems-rule-engine.js';

export interface AuditLogicParams {
  repo?: string;
  path?: string;
  category?: SystemsRuleCategory;
  categories?: SystemsRuleCategory[];
  source?: string;
  facts?: SystemsRuleFact[];
  maxFindings?: number;
  legacyResponse?: boolean;
}

export async function gnAuditLogic(
  repoId: string,
  params: AuditLogicParams,
  context?: { repoPath: string },
): Promise<SystemsRuleEngineReport | Record<string, unknown>> {
  const warnings: string[] = [];
  let source = params.source;

  if (source === undefined && params.path) {
    const repoRoot = await resolveAuditRepoRoot(repoId, params, context);
    const resolvedPath = await resolveContainedRealPath(repoRoot, params.path);
    try {
      source = await fs.readFile(resolvedPath, 'utf8');
    } catch (error) {
      warnings.push(
        `could not read path: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const baseReport = runSystemsRuleEngine({
    source,
    filePath: params.path,
    facts: params.facts,
    categories: params.categories ?? (params.category ? [params.category] : undefined),
    maxFindings: params.maxFindings,
  });

  const report: SystemsRuleEngineReport = {
    ...baseReport,
    status: warnings.length > 0 ? 'partial' : baseReport.status,
    warnings: [...baseReport.warnings, ...warnings],
    skipReasons:
      source || params.facts?.length
        ? baseReport.skipReasons
        : ['no source or systems facts supplied'],
  };
  if (params.legacyResponse !== false) {
    return report;
  }

  const targetContext = await resolveTargetContext({ repo: repoId });
  return createEnvelopeFromLegacy({
    legacy: report as unknown as Record<string, unknown>,
    tool: 'gn_audit_logic',
    status: report.status,
    targetContext,
    capabilitiesUsed: ['systems-rule-engine'],
    nextTools: ['gn_resource_trace', 'gn_trace_boundary', 'gn_test_suggestions'],
    evidence: report.findings,
  });
}

async function resolveAuditRepoRoot(
  repoId: string,
  params: AuditLogicParams,
  context?: { repoPath: string },
): Promise<string> {
  if (context?.repoPath) return context.repoPath;
  const explicitRepo = params.repo ?? repoId;
  if (path.isAbsolute(explicitRepo)) return explicitRepo;
  const targetContext = await resolveTargetContext({ repo: explicitRepo });
  if (!targetContext.repoPath)
    throw new Error(`Unable to resolve repository root for ${explicitRepo}`);
  return targetContext.repoPath;
}
