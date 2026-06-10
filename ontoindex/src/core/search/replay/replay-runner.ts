import {
  computeRetrievalReplayMovementMetrics,
  type ComputeRetrievalReplayMovementMetricsInput,
  type RetrievalReplayMovementMetrics,
} from './replay-metrics.js';
import {
  evaluateRetrievalReplayGate,
  type RetrievalReplayGateResult,
  type RetrievalReplayVerdict,
} from './replay-gate.js';
import type { QueryFreshnessStatus } from '../../runtime/query-diagnostics.js';
import {
  RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION,
  type RetrievalReplayCaseV1,
  type RetrievalReplayQualityMode,
} from './replay-case.js';
import type { RetrievalReplayIdentity } from './result-identity.js';

export interface RetrievalReplayExecutorRun {
  identities: readonly RetrievalReplayIdentity[];
  latencyMs?: number;
  repoPath?: string;
  indexedHead?: string;
  currentHead?: string;
  indexFreshness?: QueryFreshnessStatus | string;
  sidecarFreshness?: QueryFreshnessStatus | string;
  embeddingFreshness?: QueryFreshnessStatus | string;
  qualityMode?: RetrievalReplayQualityMode;
  enabledCapabilities?: readonly string[];
  missingCapabilities?: readonly string[];
  baselineInvalid?: boolean;
  baselineInvalidReason?: string;
  baselineElapsedMs?: number;
  warnings?: readonly string[];
}

export interface RetrievalReplayExecutor {
  run(caseInput: RetrievalReplayCaseV1): Promise<RetrievalReplayExecutorRun>;
}

export interface ReplayCaseReport {
  caseId: string;
  caseSchemaVersion: typeof RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION;
  repoPath?: string;
  indexedHead?: string;
  currentHead?: string;
  indexFreshness?: QueryFreshnessStatus | string;
  qualityMode?: RetrievalReplayQualityMode;
  enabledCapabilities: string[];
  missingCapabilities: string[];
  sidecarFreshness?: QueryFreshnessStatus | string;
  embeddingFreshness?: QueryFreshnessStatus | string;
  baselineInvalid: boolean;
  baselineInvalidReasons: string[];
  metrics: RetrievalReplayMovementMetrics;
  verdict: RetrievalReplayVerdict;
  gate: RetrievalReplayGateResult;
  gateReasons: string[];
  warnings: string[];
  error?: string;
}

export interface RetrievalReplayReport {
  generatedAt: number;
  cases: ReplayCaseReport[];
}

export interface ReplayCasesInput {
  cases: readonly RetrievalReplayCaseV1[];
  executor: RetrievalReplayExecutor;
  now?: () => number;
}

export async function replayRetrievalCases(input: ReplayCasesInput): Promise<RetrievalReplayReport> {
  const now = input.now ?? (() => Date.now());
  const generatedAt = now();

  const cases = await Promise.all(
    input.cases.map(async (replayCase) => executeReplayCase(replayCase, input.executor, now)),
  );

  return {
    generatedAt,
    cases,
  };
}

async function executeReplayCase(
  replayCase: RetrievalReplayCaseV1,
  executor: RetrievalReplayExecutor,
  now: () => number,
): Promise<ReplayCaseReport> {
  const runStartedAt = now();
  const runResult = await runReplayCase(replayCase, executor);
  const elapsedMs =
    runResult.elapsedMs ?? Math.max(0, now() - runStartedAt);
  const metricsInput: ComputeRetrievalReplayMovementMetricsInput = {
    caseInput: replayCase,
    actual: runResult.identities,
    elapsedMs,
    baselineElapsedMs: runResult.baselineElapsedMs,
    enabledCapabilities: runResult.enabledCapabilities,
    missingCapabilities: runResult.missingCapabilities,
    indexFreshness: runResult.indexFreshness,
    warnings: runResult.warnings,
  };
  const movementMetrics = computeRetrievalReplayMovementMetrics(metricsInput);
  const gate = evaluateRetrievalReplayGate({
    caseInput: replayCase,
    metrics: movementMetrics,
    indexFreshness: runResult.indexFreshness,
    missingCapabilities: runResult.missingCapabilities,
    baselineInvalid: runResult.baselineInvalid,
    baselineInvalidReasons: runResult.baselineInvalidReason ? [runResult.baselineInvalidReason] : [],
  });

  const enabledCapabilities = [...new Set(runResult.enabledCapabilities ?? [])];
  const missingCapabilities = [...new Set(runResult.missingCapabilities ?? [])];
  const baselineInvalidReasons = [
    ...(runResult.baselineInvalidReason ? [runResult.baselineInvalidReason] : []),
  ];

  const verdict: RetrievalReplayVerdict = runResult.error ? 'FAIL' : gate.verdict;
  const warnings = mergeWarnings(runResult.warnings, movementMetrics.warnings, gate.reasons);

  return {
    caseId: replayCase.id,
    caseSchemaVersion: RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION,
    repoPath: runResult.repoPath,
    indexedHead: runResult.indexedHead,
    currentHead: runResult.currentHead,
    indexFreshness: runResult.indexFreshness,
    qualityMode: runResult.qualityMode,
    enabledCapabilities,
    missingCapabilities,
    sidecarFreshness: runResult.sidecarFreshness,
    embeddingFreshness: runResult.embeddingFreshness,
    baselineInvalid: Boolean(runResult.baselineInvalid),
    baselineInvalidReasons,
    metrics: movementMetrics,
    verdict,
    gate,
    gateReasons: gate.reasons,
    warnings,
    error: runResult.error,
  };
}

async function runReplayCase(
  replayCase: RetrievalReplayCaseV1,
  executor: RetrievalReplayExecutor,
): Promise<ReplayCaseExecutionResult> {
  try {
    const run = await executor.run(replayCase);
    return {
      identities: run.identities ?? [],
      elapsedMs: run.latencyMs,
      ...run,
      error: undefined,
    };
  } catch (error: unknown) {
    return {
      identities: [],
      error: error instanceof Error ? error.message : String(error),
      warnings: [`executor error: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

interface ReplayCaseExecutionResult extends RetrievalReplayExecutorRun {
  elapsedMs?: number;
  error?: string;
}

function mergeWarnings(
  ...parts: Array<readonly string[] | undefined | null | string>
): string[] {
  const values: string[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      values.push(part);
      continue;
    }
    if (!part) {
      continue;
    }
    values.push(...part);
  }
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}
