import { estimateJsonTokens } from './search-token-budget.js';

export interface EnrichmentTokenBudgetReport {
  max_tokens: number;
  remaining_before: number;
  estimated_tokens: number;
  related_docs_kept: number;
  related_docs_dropped: number;
  related_chunks_kept: number;
  related_chunks_dropped: number;
  visible_records_dropped: number;
  facts_dropped: number;
  mention_targets_dropped: number;
  truncated: boolean;
  over_budget: boolean;
}

const ARRAY_KEYS = [
  'relatedDocs',
  'relatedChunks',
  'visibleRecords',
  'facts',
  'mentionTargets',
] as const;
type ArrayKey = (typeof ARRAY_KEYS)[number];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function applyEnrichmentTokenBudget<T>(result: T, maxTokens: number): T {
  if (!isObjectRecord(result) || !isObjectRecord(result.enrichment)) return result;

  const enrichment = result.enrichment;
  if (!ARRAY_KEYS.some((key) => Array.isArray(enrichment[key]))) return result;

  const primary = { ...result };
  delete primary.enrichment;

  const core = { ...enrichment };
  for (const key of ARRAY_KEYS) delete core[key];

  const remainingBefore = maxTokens - estimateJsonTokens(primary) - estimateJsonTokens(core);
  let remaining = remainingBefore;
  const sourceArrays = Object.fromEntries(
    ARRAY_KEYS.map((key) => [key, Array.isArray(enrichment[key]) ? [...enrichment[key]] : []]),
  ) as Record<ArrayKey, unknown[]>;
  const kept = {} as Record<ArrayKey, unknown[]>;

  for (const key of ARRAY_KEYS) {
    const items: unknown[] = [];
    for (const item of sourceArrays[key]) {
      const itemCost = estimateJsonTokens(item) + 1;
      const cost = key === 'relatedDocs' ? itemCost * 2 : itemCost;
      if (remaining < 0 || cost > remaining) break;
      items.push(item);
      remaining -= cost;
    }
    kept[key] = items;
  }

  const outputEnrichment: Record<string, unknown> = {
    ...enrichment,
    ...Object.fromEntries(
      ARRAY_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(enrichment, key)).map(
        (key) => [key, kept[key]],
      ),
    ),
  };
  const estimatedOutput = {
    ...primary,
    enrichment: outputEnrichment,
    relatedDocs: kept.relatedDocs,
  };
  const estimatedTokens = estimateJsonTokens(estimatedOutput);
  const relatedDocsDropped = sourceArrays.relatedDocs.length - kept.relatedDocs.length;
  const relatedChunksDropped = sourceArrays.relatedChunks.length - kept.relatedChunks.length;
  const visibleRecordsDropped = sourceArrays.visibleRecords.length - kept.visibleRecords.length;
  const factsDropped = sourceArrays.facts.length - kept.facts.length;
  const mentionTargetsDropped = sourceArrays.mentionTargets.length - kept.mentionTargets.length;
  const report: EnrichmentTokenBudgetReport = {
    max_tokens: maxTokens,
    remaining_before: remainingBefore,
    estimated_tokens: estimatedTokens,
    related_docs_kept: kept.relatedDocs.length,
    related_docs_dropped: relatedDocsDropped,
    related_chunks_kept: kept.relatedChunks.length,
    related_chunks_dropped: relatedChunksDropped,
    visible_records_dropped: visibleRecordsDropped,
    facts_dropped: factsDropped,
    mention_targets_dropped: mentionTargetsDropped,
    truncated:
      relatedDocsDropped > 0 ||
      relatedChunksDropped > 0 ||
      visibleRecordsDropped > 0 ||
      factsDropped > 0 ||
      mentionTargetsDropped > 0,
    over_budget: estimatedTokens > maxTokens,
  };

  outputEnrichment.budget = report;
  return { ...primary, enrichment: outputEnrichment } as T;
}
