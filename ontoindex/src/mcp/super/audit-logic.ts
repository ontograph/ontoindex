import fs from 'node:fs/promises';
import path from 'node:path';

import { createEnvelopeFromLegacy } from '../shared/response-envelope.js';
import { resolveTargetContext } from '../shared/target-context.js';
import {
  runSystemsRuleEngine,
  type SystemsRuleCategory,
  type SystemsRuleEngineReport,
  type SystemsRuleFact,
} from '../../core/systems-audit/systems-rule-engine.js';

export interface AuditLogicParams {
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
): Promise<SystemsRuleEngineReport | Record<string, unknown>> {
  const warnings: string[] = [];
  let source = params.source;

  if (!source && params.path) {
    try {
      source = await fs.readFile(resolveInputPath(repoId, params.path), 'utf8');
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

function resolveInputPath(repoId: string, inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath;
  if (path.isAbsolute(repoId)) return path.join(repoId, inputPath);
  return inputPath;
}
