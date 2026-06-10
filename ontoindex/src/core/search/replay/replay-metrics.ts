import type { QueryFreshnessStatus } from '../../runtime/query-diagnostics.js';
import {
  isReplayIdentityStrictMatch,
  normalizeReplayIdentity,
  type RetrievalReplayIdentity,
  toReplayIdentityKey,
} from './result-identity.js';
import type { RetrievalReplayCaseV1 } from './replay-case.js';

export interface RetrievalReplayMovementMetrics {
  jaccardAtK: number;
  top1Stable: boolean;
  rankDelta: number;
  missingExpected: number;
  newUnexpected: number;
  capabilityDrift: boolean;
  freshnessDrift: boolean;
  latencyDeltaMs: number;
  warnings: string[];
}

export interface ComputeRetrievalReplayMovementMetricsInput {
  caseInput: RetrievalReplayCaseV1;
  actual: readonly RetrievalReplayIdentity[];
  elapsedMs: number;
  baselineElapsedMs?: number;
  enabledCapabilities?: readonly string[];
  missingCapabilities?: readonly string[];
  indexFreshness?: QueryFreshnessStatus | string;
  warnings?: readonly string[];
}

export function computeRetrievalReplayMovementMetrics(
  input: ComputeRetrievalReplayMovementMetricsInput,
): RetrievalReplayMovementMetrics {
  const warnings = [...(input.warnings ?? [])];

  const topK = Math.max(1, input.caseInput.expected.topK);
  const expected = input.caseInput.expected.identities
    .slice(0, topK)
    .map((identity) => normalizeReplayIdentity(identity));
  const actual = input.actual.slice(0, topK).map((identity) => normalizeReplayIdentity(identity));

  let missingExpected = 0;
  let rankDelta = 0;
  const matchedActual = new Set<number>();

  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
    const expectedIdentity = expected[expectedIndex];
    const actualIndex = findStrictMatchIndex(actual, expectedIdentity, matchedActual);
    const expectedRank = expectedIndex + 1;

    if (actualIndex < 0) {
      missingExpected += 1;
      rankDelta += Math.abs(topK + 1 - expectedRank);
      continue;
    }

    matchedActual.add(actualIndex);
    rankDelta += Math.abs(actualIndex + 1 - expectedRank);
  }

  const top1Stable = expected.length > 0 && actual.length > 0
    ? isReplayIdentityStrictMatch(actual[0], expected[0])
    : expected.length === 0 && actual.length === 0;

  const expectedKeys = new Set(expected.map(toReplayIdentityKey));
  const actualKeys = new Set(actual.map(toReplayIdentityKey));
  const intersectionCount = [...actualKeys].filter((key) => expectedKeys.has(key)).length;
  const unionCount = new Set([...actualKeys, ...expectedKeys]).size;
  const jaccardAtK = unionCount === 0 ? 1 : intersectionCount / unionCount;

  const newUnexpected = actualKeys.size - intersectionCount;

  const missingCapabilities = new Set(input.missingCapabilities ?? []);
  const allowedDrift = new Set(input.caseInput.expected.allowedCapabilityDrift ?? []);
  const unexpectedMissingCapabilities = [...missingCapabilities].filter(
    (capability) => !allowedDrift.has(capability),
  );

  const capabilityDrift = unexpectedMissingCapabilities.length > 0;
  if (capabilityDrift) {
    warnings.push(`missing required capabilities: ${unexpectedMissingCapabilities.sort().join(', ')}`);
  }

  const freshness = normalizeFreshness(input.indexFreshness);
  const freshnessDrift = freshness !== undefined && freshness !== 'fresh';
  if (freshnessDrift) {
    warnings.push(`index freshness drift: ${freshness}`);
  }

  let latencyDeltaMs = 0;
  if (input.baselineElapsedMs === undefined) {
    warnings.push('baseline latency not supplied; latencyDeltaMs reported as 0');
  } else {
    latencyDeltaMs = input.elapsedMs - input.baselineElapsedMs;
  }

  return {
    jaccardAtK,
    top1Stable,
    rankDelta,
    missingExpected,
    newUnexpected,
    capabilityDrift,
    freshnessDrift,
    latencyDeltaMs,
    warnings: [...new Set(warnings)].sort(),
  };
}

function findStrictMatchIndex(
  candidates: readonly RetrievalReplayIdentity[],
  expected: RetrievalReplayIdentity,
  usedIndices: Set<number>,
): number {
  for (let index = 0; index < candidates.length; index += 1) {
    if (usedIndices.has(index)) {
      continue;
    }
    if (isReplayIdentityStrictMatch(candidates[index], expected)) {
      return index;
    }
  }
  return -1;
}

function normalizeFreshness(
  freshness?: QueryFreshnessStatus | string,
): QueryFreshnessStatus | undefined {
  if (typeof freshness !== 'string') {
    return undefined;
  }
  const normalized = freshness.trim().toLowerCase();
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
