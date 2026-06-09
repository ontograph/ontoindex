import {
  consumeEnrichmentFacts,
  type EnrichmentFactConsumptionOptions,
  type EnrichmentFactConsumptionResult,
} from './enrichment-fact-consumption.js';
import type { EnrichmentFact, EnrichmentRecord, EnrichmentSnapshot } from './enrichment-record.js';

export type AxelExposedFactKind =
  | 'domain-classification'
  | 'semantic-bridge'
  | 'architecture-drift'
  | 'orphan-anchor-suggestion';

export interface AxelFactExposureSummary {
  factCount: number;
  byKind: Partial<Record<AxelExposedFactKind, number>>;
  visibleRecordCount: number;
  usedRecordCount: number;
  rejectedRecordCount: number;
  partialRecordCount: number;
}

export interface AxelFactExposureResult {
  facts: EnrichmentFact[];
  summary: AxelFactExposureSummary;
  consumption: EnrichmentFactConsumptionResult;
}

const AXEL_FACT_KINDS = new Set<AxelExposedFactKind>([
  'domain-classification',
  'semantic-bridge',
  'architecture-drift',
  'orphan-anchor-suggestion',
]);

export function exposeAxelEnrichmentFacts(
  records: readonly EnrichmentRecord[],
  snapshot: EnrichmentSnapshot,
  options: EnrichmentFactConsumptionOptions = {},
): AxelFactExposureResult {
  const consumption = consumeEnrichmentFacts(records, snapshot, options);
  const facts = consumption.facts.filter(isAxelExposedFact);
  const byKind: Partial<Record<AxelExposedFactKind, number>> = {};

  for (const fact of facts) {
    byKind[fact.kind as AxelExposedFactKind] = (byKind[fact.kind as AxelExposedFactKind] ?? 0) + 1;
  }

  return {
    facts,
    summary: {
      factCount: facts.length,
      byKind,
      visibleRecordCount: consumption.summary.visibleRecordCount,
      usedRecordCount: consumption.summary.usedRecordCount,
      rejectedRecordCount: consumption.summary.rejectedRecordCount,
      partialRecordCount: consumption.summary.partialRecordCount,
    },
    consumption,
  };
}

function isAxelExposedFact(fact: EnrichmentFact): boolean {
  return AXEL_FACT_KINDS.has(fact.kind as AxelExposedFactKind);
}
