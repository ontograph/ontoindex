export interface QueryBudgetSnapshot {
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
  maxCandidates?: number;
  timeoutMs?: number;
  elapsedMs?: number;
  emitted?: number;
  truncated: boolean;
  truncatedReasons: string[];
  degradedReasons: string[];
  fallback?: string;
  steps?: QueryBudgetStepSnapshot[];
  tokenCost?: QueryTokenCostSnapshot;
}

export interface QueryBudgetStepSnapshot {
  name: string;
  elapsedMs?: number;
  emitted?: number;
  limit?: number;
  truncated?: boolean;
  tokenCost?: QueryTokenCostSnapshot;
}

export type QueryTokenCostStatus = 'available' | 'unknown' | 'unavailable';

export interface QueryTokenUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  source?: string;
}

export interface QueryTokenPricingSnapshot {
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  currency: 'USD';
  source?: string;
  model?: string;
}

export interface QueryTokenCostSnapshot {
  status: QueryTokenCostStatus;
  reason: string;
  usage?: QueryTokenUsageSnapshot;
  pricing?: QueryTokenPricingSnapshot;
  costUsd?: number;
  warnings: string[];
}

export interface QueryTokenUsageSnapshotInput {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  source?: string;
}

export interface QueryTokenPricingSnapshotInput {
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  source?: string;
  model?: string;
}

export interface QueryTokenCostSnapshotInput {
  status?: QueryTokenCostStatus;
  reason?: string;
  usage?: QueryTokenUsageSnapshotInput;
  pricing?: QueryTokenPricingSnapshotInput;
  costUsd?: number;
  warnings?: readonly string[];
}

export interface QueryBudgetSnapshotInput {
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
  maxCandidates?: number;
  timeoutMs?: number;
  elapsedMs?: number;
  emitted?: number;
  truncated?: boolean;
  truncatedReasons?: readonly string[];
  degradedReasons?: readonly string[];
  fallback?: string;
  steps?: readonly QueryBudgetStepSnapshot[];
  tokenCost?: QueryTokenCostSnapshotInput;
}

export interface QueryBudgetElapsedInput {
  startedAtMs: number;
  finishedAtMs?: number;
  now?: () => number;
}

export function createQueryBudgetSnapshot(
  input: QueryBudgetSnapshotInput = {},
): QueryBudgetSnapshot {
  const truncatedReasons = compactUniqueStrings(input.truncatedReasons ?? []);
  const degradedReasons = compactUniqueStrings(input.degradedReasons ?? []);
  const steps = compactSteps(input.steps ?? []);
  const truncated =
    input.truncated === true ||
    truncatedReasons.length > 0 ||
    steps.some((step) => step.truncated === true);

  return compactSnapshot({
    maxDepth: compactNonNegativeInteger(input.maxDepth),
    maxNodes: compactNonNegativeInteger(input.maxNodes),
    maxEdges: compactNonNegativeInteger(input.maxEdges),
    maxCandidates: compactNonNegativeInteger(input.maxCandidates),
    timeoutMs: compactNonNegativeInteger(input.timeoutMs),
    elapsedMs: compactNonNegativeInteger(input.elapsedMs),
    emitted: compactNonNegativeInteger(input.emitted),
    truncated,
    truncatedReasons,
    degradedReasons,
    fallback: compactString(input.fallback),
    ...(steps.length > 0 ? { steps } : {}),
    ...(input.tokenCost ? { tokenCost: createQueryTokenCostSnapshot(input.tokenCost) } : {}),
  });
}

export function updateQueryBudgetSnapshot(
  snapshot: QueryBudgetSnapshot,
  input: QueryBudgetSnapshotInput,
): QueryBudgetSnapshot {
  return createQueryBudgetSnapshot({
    ...snapshot,
    ...input,
    truncatedReasons: [...snapshot.truncatedReasons, ...(input.truncatedReasons ?? [])],
    degradedReasons: [...snapshot.degradedReasons, ...(input.degradedReasons ?? [])],
    steps: [...(snapshot.steps ?? []), ...(input.steps ?? [])],
    tokenCost: input.tokenCost ?? snapshot.tokenCost,
  });
}

export function createQueryTokenCostSnapshot(
  input: QueryTokenCostSnapshotInput = {},
): QueryTokenCostSnapshot {
  const usage = compactTokenUsage(input.usage);
  const pricing = compactTokenPricing(input.pricing);
  const computedCostUsd = computeTokenCostUsd(usage, pricing);
  const costUsd = compactNonNegativeNumber(input.costUsd) ?? computedCostUsd;
  const status =
    input.status ??
    (costUsd !== undefined ? 'available' : usage || pricing ? 'unknown' : 'unavailable');
  const reason =
    compactString(input.reason) ?? deriveTokenCostReason(status, usage, pricing, costUsd);
  const warnings = compactUniqueStrings([
    ...(input.warnings ?? []),
    ...(status === 'available' ? [] : [`Token/USD cost ${status}: ${reason}.`]),
  ]);

  return compactSnapshot({
    status,
    reason,
    ...(usage ? { usage } : {}),
    ...(pricing ? { pricing } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    warnings,
  }) as QueryTokenCostSnapshot;
}

export function addQueryBudgetTruncatedReason(
  snapshot: QueryBudgetSnapshot,
  reason: string,
): QueryBudgetSnapshot {
  return updateQueryBudgetSnapshot(snapshot, {
    truncated: true,
    truncatedReasons: [reason],
  });
}

export function addQueryBudgetDegradedReason(
  snapshot: QueryBudgetSnapshot,
  reason: string,
): QueryBudgetSnapshot {
  return updateQueryBudgetSnapshot(snapshot, {
    degradedReasons: [reason],
  });
}

export function setQueryBudgetFallback(
  snapshot: QueryBudgetSnapshot,
  fallback: string,
): QueryBudgetSnapshot {
  return updateQueryBudgetSnapshot(snapshot, { fallback });
}

export function addQueryBudgetStep(
  snapshot: QueryBudgetSnapshot,
  step: QueryBudgetStepSnapshot,
): QueryBudgetSnapshot {
  return updateQueryBudgetSnapshot(snapshot, { steps: [step] });
}

export function finishQueryBudgetSnapshot(
  snapshot: QueryBudgetSnapshot,
  input: QueryBudgetElapsedInput,
): QueryBudgetSnapshot {
  const finishedAtMs = input.finishedAtMs ?? input.now?.() ?? Date.now();
  return updateQueryBudgetSnapshot(snapshot, {
    elapsedMs: Math.max(0, finishedAtMs - input.startedAtMs),
  });
}

function compactSnapshot<T extends Record<string, unknown>>(snapshot: T): T {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) => value !== undefined),
  ) as T;
}

function compactSteps(steps: readonly QueryBudgetStepSnapshot[]): QueryBudgetStepSnapshot[] {
  return steps.map(compactStep);
}

function compactStep(step: QueryBudgetStepSnapshot): QueryBudgetStepSnapshot {
  const name = compactString(step.name);
  if (!name) throw new Error('Query budget step requires a name');

  const compacted: QueryBudgetStepSnapshot = { name };
  const elapsedMs = compactNonNegativeInteger(step.elapsedMs);
  const emitted = compactNonNegativeInteger(step.emitted);
  const limit = compactNonNegativeInteger(step.limit);
  const tokenCost = step.tokenCost ? createQueryTokenCostSnapshot(step.tokenCost) : undefined;
  if (elapsedMs !== undefined) compacted.elapsedMs = elapsedMs;
  if (emitted !== undefined) compacted.emitted = emitted;
  if (limit !== undefined) compacted.limit = limit;
  if (step.truncated === true) compacted.truncated = true;
  if (tokenCost) compacted.tokenCost = tokenCost;
  return compacted;
}

function compactUniqueStrings(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map(compactString).filter((value): value is string => Boolean(value))),
  );
}

function compactString(value: string | undefined): string | undefined {
  const compacted = value?.trim();
  return compacted ? compacted : undefined;
}

function compactNonNegativeInteger(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function compactNonNegativeNumber(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function compactTokenUsage(
  usage: QueryTokenUsageSnapshotInput | undefined,
): QueryTokenUsageSnapshot | undefined {
  if (!usage) return undefined;

  const inputTokens = compactNonNegativeInteger(usage.inputTokens);
  const outputTokens = compactNonNegativeInteger(usage.outputTokens);
  const totalTokens =
    compactNonNegativeInteger(usage.totalTokens) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  const source = compactString(usage.source);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    source === undefined
  ) {
    return undefined;
  }

  return compactSnapshot({
    inputTokens,
    outputTokens,
    totalTokens,
    source,
  }) as QueryTokenUsageSnapshot;
}

function compactTokenPricing(
  pricing: QueryTokenPricingSnapshotInput | undefined,
): QueryTokenPricingSnapshot | undefined {
  if (!pricing) return undefined;

  const inputUsdPerMillionTokens = compactNonNegativeNumber(pricing.inputUsdPerMillionTokens);
  const outputUsdPerMillionTokens = compactNonNegativeNumber(pricing.outputUsdPerMillionTokens);
  const source = compactString(pricing.source);
  const model = compactString(pricing.model);

  if (
    inputUsdPerMillionTokens === undefined &&
    outputUsdPerMillionTokens === undefined &&
    source === undefined &&
    model === undefined
  ) {
    return undefined;
  }

  return compactSnapshot({
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
    currency: 'USD',
    source,
    model,
  }) as QueryTokenPricingSnapshot;
}

function computeTokenCostUsd(
  usage: QueryTokenUsageSnapshot | undefined,
  pricing: QueryTokenPricingSnapshot | undefined,
): number | undefined {
  if (!usage || !pricing) return undefined;

  let cost = 0;
  let hasCostInput = false;
  if (usage.inputTokens !== undefined && pricing.inputUsdPerMillionTokens !== undefined) {
    cost += (usage.inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens;
    hasCostInput = true;
  }
  if (usage.outputTokens !== undefined && pricing.outputUsdPerMillionTokens !== undefined) {
    cost += (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens;
    hasCostInput = true;
  }

  return hasCostInput ? Number(cost.toFixed(12)) : undefined;
}

function deriveTokenCostReason(
  status: QueryTokenCostStatus,
  usage: QueryTokenUsageSnapshot | undefined,
  pricing: QueryTokenPricingSnapshot | undefined,
  costUsd: number | undefined,
): string {
  if (status === 'available' && costUsd !== undefined) return 'token-cost-computed-from-config';
  if (!usage && !pricing) return 'token-cost-metadata-not-supplied';
  if (!usage) return 'token-usage-not-supplied';
  if (!pricing) return 'pricing-not-configured';
  return 'insufficient-token-cost-input';
}
