import type { QueryFreshnessStatus } from '../../runtime/query-diagnostics.js';
import type { RetrievalReplayMovementMetrics } from './replay-metrics.js';
import type { RetrievalReplayCaseV1 } from './replay-case.js';

export type RetrievalReplayVerdict = 'PASS' | 'WARN' | 'FAIL';

export interface RetrievalReplayVectorBackendComparison {
  baselineMedianMs: number;
  candidateMedianMs: number;
  expectedAnchorRegression?: boolean;
}

export interface RetrievalReplayVectorBackendGateResult extends RetrievalReplayVectorBackendComparison {
  medianSpeedup?: number;
  verdict: RetrievalReplayVerdict;
  reasons: string[];
}

export interface EvaluateRetrievalReplayGateInput {
  caseInput: RetrievalReplayCaseV1;
  metrics: RetrievalReplayMovementMetrics;
  indexFreshness?: QueryFreshnessStatus | string;
  missingCapabilities?: readonly string[];
  baselineInvalid?: boolean;
  baselineInvalidReasons?: readonly string[];
  vectorBackendComparison?: RetrievalReplayVectorBackendComparison;
}

export interface RetrievalReplayGateResult {
  verdict: RetrievalReplayVerdict;
  status: 'ok' | 'baseline_invalid';
  reasons: string[];
  vectorBackend?: RetrievalReplayVectorBackendGateResult;
}

export function evaluateRetrievalReplayGate(
  input: EvaluateRetrievalReplayGateInput,
): RetrievalReplayGateResult {
  const reasons: string[] = [];
  const missingCapabilities = new Set(input.missingCapabilities ?? []);
  const allowedDrift = new Set(input.caseInput.expected.allowedCapabilityDrift ?? []);
  const unexpectedMissingCapabilities = [...missingCapabilities].filter(
    (capability) => !allowedDrift.has(capability),
  );
  const freshness = normalizeFreshness(input.indexFreshness);
  const freshnessDrift = freshness !== undefined && freshness !== 'fresh';
  const movementFailReasons: string[] = [];
  const vectorBackend = evaluateVectorBackendComparison(input.vectorBackendComparison);

  const minimumJaccardAtK = input.caseInput.expected.minimumJaccardAtK ?? 0;
  if (input.metrics.jaccardAtK < minimumJaccardAtK) {
    const message = `jaccardAtK ${input.metrics.jaccardAtK} below minimum ${minimumJaccardAtK}`;
    movementFailReasons.push(message);
    reasons.push(message);
  }

  if (input.caseInput.expected.requireTop1Stable && !input.metrics.top1Stable) {
    const message = 'top1 changed';
    movementFailReasons.push(message);
    reasons.push(message);
  }

  if (input.metrics.missingExpected > 0) {
    const message = `missing ${input.metrics.missingExpected} expected identities in topK`;
    movementFailReasons.push(message);
    reasons.push(message);
  }

  if (unexpectedMissingCapabilities.length > 0) {
    reasons.push(`missing required capabilities: ${unexpectedMissingCapabilities.join(', ')}`);
  }

  if (vectorBackend?.reasons.length) {
    reasons.push(...vectorBackend.reasons);
  }

  if (freshnessDrift) {
    reasons.push(`index freshness is ${freshness}`);
  }

  if (input.baselineInvalid) {
    if (input.baselineInvalidReasons?.length) {
      reasons.unshift(...input.baselineInvalidReasons);
    }
    reasons.push('baseline_invalid: unable to compare against baseline snapshot assumptions');
    return {
      verdict:
        movementFailReasons.length > 0 || vectorBackend?.verdict === 'FAIL' ? 'FAIL' : 'WARN',
      status: 'baseline_invalid',
      reasons,
      vectorBackend,
    };
  }

  if (movementFailReasons.length > 0 || vectorBackend?.verdict === 'FAIL') {
    return {
      verdict: 'FAIL',
      status: 'ok',
      reasons,
      vectorBackend,
    };
  }

  if (
    unexpectedMissingCapabilities.length > 0 ||
    freshnessDrift ||
    vectorBackend?.verdict === 'WARN'
  ) {
    return {
      verdict: 'WARN',
      status: 'ok',
      reasons,
      vectorBackend,
    };
  }

  return {
    verdict: 'PASS',
    status: 'ok',
    reasons,
    vectorBackend,
  };
}

function normalizeFreshness(
  value?: string | QueryFreshnessStatus,
): QueryFreshnessStatus | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'fresh' ||
    normalized === 'stale' ||
    normalized === 'degraded' ||
    normalized === 'unknown' ||
    normalized === 'not-applicable'
  ) {
    return normalized;
  }
  return undefined;
}

function evaluateVectorBackendComparison(
  comparison?: RetrievalReplayVectorBackendComparison,
): RetrievalReplayVectorBackendGateResult | undefined {
  if (comparison === undefined) {
    return undefined;
  }

  const reasons: string[] = [];
  const baselineMedianMs = comparison.baselineMedianMs;
  const candidateMedianMs = comparison.candidateMedianMs;
  const expectedAnchorRegression = Boolean(comparison.expectedAnchorRegression);
  const validNumbers =
    Number.isFinite(baselineMedianMs) &&
    Number.isFinite(candidateMedianMs) &&
    baselineMedianMs > 0 &&
    candidateMedianMs > 0;

  if (!validNumbers) {
    reasons.push('vector backend comparison is incomplete');
    return {
      baselineMedianMs,
      candidateMedianMs,
      expectedAnchorRegression,
      verdict: 'WARN',
      reasons,
    };
  }

  const medianSpeedup = baselineMedianMs / candidateMedianMs;
  if (medianSpeedup < 2) {
    reasons.push(`vector backend median speedup ${medianSpeedup.toFixed(2)}x below minimum 2x`);
  }

  if (expectedAnchorRegression) {
    reasons.push('expected-anchor regression detected');
  }

  return {
    baselineMedianMs,
    candidateMedianMs,
    expectedAnchorRegression,
    medianSpeedup,
    verdict: reasons.length > 0 ? 'FAIL' : 'PASS',
    reasons,
  };
}
