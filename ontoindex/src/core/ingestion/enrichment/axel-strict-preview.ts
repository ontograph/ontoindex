import { exposeAxelEnrichmentFacts, type AxelFactExposureResult } from './axel-fact-exposure.js';
import type { EnrichmentFact, EnrichmentRecord, EnrichmentSnapshot } from './enrichment-record.js';
import type { EnrichmentFactConsumptionOptions } from './enrichment-fact-consumption.js';

export type AxelStrictPreviewFindingKind = 'architecture-drift' | 'orphan-anchor-suggestion';

export interface AxelStrictPreviewFinding {
  kind: AxelStrictPreviewFindingKind;
  fact: EnrichmentFact;
}

export interface AxelStrictPreviewResult {
  findings: AxelStrictPreviewFinding[];
  summary: {
    findingCount: number;
    architectureDriftCount: number;
    orphanAnchorSuggestionCount: number;
    factCount: number;
    rejectedRecordCount: number;
  };
  exposure: AxelFactExposureResult;
}

export function previewAxelStrictFindings(
  records: readonly EnrichmentRecord[],
  snapshot: EnrichmentSnapshot,
  options: EnrichmentFactConsumptionOptions = {},
): AxelStrictPreviewResult {
  const exposure = exposeAxelEnrichmentFacts(records, snapshot, {
    ...options,
    consumeFacts: true,
  });
  const findings = exposure.facts.filter(isStrictPreviewFact).map((fact) => ({
    kind: fact.kind as AxelStrictPreviewFindingKind,
    fact,
  }));
  const architectureDriftCount = findings.filter(
    (finding) => finding.kind === 'architecture-drift',
  ).length;
  const orphanAnchorSuggestionCount = findings.filter(
    (finding) => finding.kind === 'orphan-anchor-suggestion',
  ).length;

  return {
    findings,
    summary: {
      findingCount: findings.length,
      architectureDriftCount,
      orphanAnchorSuggestionCount,
      factCount: exposure.summary.factCount,
      rejectedRecordCount: exposure.summary.rejectedRecordCount,
    },
    exposure,
  };
}

function isStrictPreviewFact(fact: EnrichmentFact): boolean {
  return fact.kind === 'architecture-drift' || fact.kind === 'orphan-anchor-suggestion';
}
