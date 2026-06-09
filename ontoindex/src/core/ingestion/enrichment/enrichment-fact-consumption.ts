import {
  decideEnrichmentReadPolicy,
  type EnrichmentReadPolicyDecision,
  type EnrichmentReadPolicyOptions,
  type EnrichmentReadPolicyReason,
} from './enrichment-read-policy.js';
import type { EnrichmentFact, EnrichmentRecord, EnrichmentSnapshot } from './enrichment-record.js';

export type EnrichmentFactConsumptionRejectionReason =
  | EnrichmentReadPolicyReason
  | 'fact-consumption-opt-in-required';

export interface EnrichmentFactConsumptionOptions extends Partial<EnrichmentReadPolicyOptions> {
  consumeFacts?: boolean;
}

export interface UsedEnrichmentRecord {
  record: EnrichmentRecord;
  facts: EnrichmentFact[];
  decision: EnrichmentReadPolicyDecision;
}

export interface RejectedEnrichmentRecord {
  record: EnrichmentRecord;
  reason: EnrichmentFactConsumptionRejectionReason;
  decision: EnrichmentReadPolicyDecision;
  factCount: number;
}

export interface VisibleEnrichmentRecordSummary {
  analyzerId: string;
  analyzerVersion: string;
  filePath: string;
  status: EnrichmentRecord['status'];
  confidence?: number;
  partial: boolean;
  factCount: number;
  used: boolean;
  rejectionReason?: EnrichmentFactConsumptionRejectionReason;
  readPolicyReason: EnrichmentReadPolicyReason;
  freshnessReason: EnrichmentReadPolicyDecision['freshness']['reason'];
}

export interface EnrichmentFactConsumptionSummary {
  visibleRecordCount: number;
  usedRecordCount: number;
  usedFactCount: number;
  rejectedRecordCount: number;
  partialRecordCount: number;
  rejectionReasons: Partial<Record<EnrichmentFactConsumptionRejectionReason, number>>;
}

export interface EnrichmentFactConsumptionResult {
  usedRecords: UsedEnrichmentRecord[];
  facts: EnrichmentFact[];
  rejectedRecords: RejectedEnrichmentRecord[];
  visibleRecords: VisibleEnrichmentRecordSummary[];
  summary: EnrichmentFactConsumptionSummary;
}

export function consumeEnrichmentFacts(
  records: readonly EnrichmentRecord[],
  snapshot: EnrichmentSnapshot,
  options: EnrichmentFactConsumptionOptions = {},
): EnrichmentFactConsumptionResult {
  const consumeFacts = options.consumeFacts === true;
  const policyOptions: Partial<EnrichmentReadPolicyOptions> = {
    minConfidence: options.minConfidence,
    completeness: options.completeness,
    safety: options.safety,
    allowLowConfidence: options.allowLowConfidence,
    allowSafetyCriticalImpact: options.allowSafetyCriticalImpact,
  };
  const usedRecords: UsedEnrichmentRecord[] = [];
  const facts: EnrichmentFact[] = [];
  const rejectedRecords: RejectedEnrichmentRecord[] = [];
  const visibleRecords: VisibleEnrichmentRecordSummary[] = [];
  const rejectionReasons: Partial<Record<EnrichmentFactConsumptionRejectionReason, number>> = {};
  let partialRecordCount = 0;

  for (const record of records) {
    const decision = decideEnrichmentReadPolicy(record, snapshot, policyOptions);
    const used = consumeFacts && decision.used;
    const rejectionReason = used
      ? undefined
      : decision.used
        ? 'fact-consumption-opt-in-required'
        : decision.reason;

    if (decision.partial) {
      partialRecordCount += 1;
    }

    if (used) {
      const recordFacts = [...record.records];
      usedRecords.push({ record, facts: recordFacts, decision });
      facts.push(...recordFacts);
    } else {
      rejectedRecords.push({
        record,
        reason: rejectionReason,
        decision,
        factCount: record.records.length,
      });
      rejectionReasons[rejectionReason] = (rejectionReasons[rejectionReason] ?? 0) + 1;
    }

    if (decision.visible) {
      const visible: VisibleEnrichmentRecordSummary = {
        analyzerId: record.analyzerId,
        analyzerVersion: record.analyzerVersion,
        filePath: record.filePath,
        status: record.status,
        partial: decision.partial,
        factCount: record.records.length,
        used,
        rejectionReason,
        readPolicyReason: decision.reason,
        freshnessReason: decision.freshness.reason,
      };
      if (record.confidence !== undefined) {
        visible.confidence = record.confidence;
      }
      visibleRecords.push(visible);
    }
  }

  return {
    usedRecords,
    facts,
    rejectedRecords,
    visibleRecords,
    summary: {
      visibleRecordCount: visibleRecords.length,
      usedRecordCount: usedRecords.length,
      usedFactCount: facts.length,
      rejectedRecordCount: rejectedRecords.length,
      partialRecordCount,
      rejectionReasons,
    },
  };
}
