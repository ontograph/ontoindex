import {
  decideEnrichmentFreshness,
  type EnrichmentFreshnessDecision,
  type EnrichmentRecord,
  type EnrichmentSnapshot,
} from './enrichment-record.js';

export type EnrichmentCompletenessPolicy = 'allow-partial' | 'require-complete';
export type EnrichmentSafetyPolicy = 'standard' | 'safety-critical-impact';

export type EnrichmentReadPolicyReason =
  | 'fresh-complete'
  | 'fresh-partial'
  | 'fresh-partial-rejected'
  | 'stale-rejected'
  | 'status-rejected'
  | 'low-confidence-rejected'
  | 'safety-critical-opt-in-required';

export interface EnrichmentReadPolicyOptions {
  minConfidence: number;
  completeness: EnrichmentCompletenessPolicy;
  safety: EnrichmentSafetyPolicy;
  allowLowConfidence?: boolean;
  allowSafetyCriticalImpact?: boolean;
}

export interface EnrichmentReadPolicyDecision {
  used: boolean;
  reason: EnrichmentReadPolicyReason;
  status: EnrichmentRecord['status'];
  freshness: EnrichmentFreshnessDecision;
  confidence?: number;
  minConfidence: number;
  partial: boolean;
  visible: boolean;
}

const DEFAULT_OPTIONS: EnrichmentReadPolicyOptions = {
  minConfidence: 0.8,
  completeness: 'allow-partial',
  safety: 'standard',
};

export function decideEnrichmentReadPolicy(
  record: EnrichmentRecord,
  snapshot: EnrichmentSnapshot,
  options: Partial<EnrichmentReadPolicyOptions> = {},
): EnrichmentReadPolicyDecision {
  const policy = normalizeOptions(options);
  const freshness = decideEnrichmentFreshness(record, snapshot);
  const partial = record.status === 'partial';
  const metadata = {
    status: record.status,
    freshness,
    confidence: record.confidence,
    minConfidence: policy.minConfidence,
    partial,
    visible: true,
  };

  if (!freshness.usable) {
    return {
      ...metadata,
      used: false,
      reason: freshness.reason === 'status-unusable' ? 'status-rejected' : 'stale-rejected',
    };
  }

  if (policy.safety === 'safety-critical-impact' && !policy.allowSafetyCriticalImpact) {
    return { ...metadata, used: false, reason: 'safety-critical-opt-in-required' };
  }

  if (
    partial &&
    (policy.completeness === 'require-complete' || policy.safety === 'safety-critical-impact')
  ) {
    return { ...metadata, used: false, reason: 'fresh-partial-rejected' };
  }

  const lowConfidence = record.confidence === undefined || record.confidence < policy.minConfidence;
  if (lowConfidence && !policy.allowLowConfidence) {
    return { ...metadata, used: false, reason: 'low-confidence-rejected' };
  }

  return { ...metadata, used: true, reason: partial ? 'fresh-partial' : 'fresh-complete' };
}

function normalizeOptions(
  options: Partial<EnrichmentReadPolicyOptions>,
): EnrichmentReadPolicyOptions {
  const minConfidence = options.minConfidence ?? DEFAULT_OPTIONS.minConfidence;
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error('minConfidence must be a finite number from 0 to 1');
  }

  return {
    minConfidence,
    completeness: options.completeness ?? DEFAULT_OPTIONS.completeness,
    safety: options.safety ?? DEFAULT_OPTIONS.safety,
    allowLowConfidence: options.allowLowConfidence,
    allowSafetyCriticalImpact: options.allowSafetyCriticalImpact,
  };
}
