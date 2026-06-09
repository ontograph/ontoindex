export const SIDECAR_MAX_CPU_PERCENT = 10;
export const SIDECAR_MAX_WORKER_COUNT = 1;

export type SidecarThrottleAction = 'continue' | 'throttle' | 'pause' | 'stop';

export type SidecarThrottleReason =
  | 'within-budget'
  | 'cpu-over-budget'
  | 'worker-count-over-limit'
  | 'foreground-active'
  | 'invalid-input';

export interface SidecarThrottleInput {
  logicalCpuCount: number;
  observedCpuPercent: number;
  workerCount: number;
  foregroundActive?: boolean;
}

export interface SidecarThrottleDecision {
  action: SidecarThrottleAction;
  reason: SidecarThrottleReason;
  maxCpuPercent: number;
  maxWorkerCount: number;
  observedCpuPercent: number | null;
  workerCount: number | null;
  logicalCpuCount: number | null;
  foregroundActive: boolean;
  errors: string[];
}

export function decideSidecarThrottle(input: SidecarThrottleInput): SidecarThrottleDecision {
  const errors = validateSidecarThrottleInput(input);
  const base = createDecisionBase(input, errors);

  if (errors.length > 0) {
    return {
      ...base,
      action: 'stop',
      reason: 'invalid-input',
    };
  }

  if (input.workerCount > SIDECAR_MAX_WORKER_COUNT) {
    return {
      ...base,
      action: 'stop',
      reason: 'worker-count-over-limit',
    };
  }

  if (input.foregroundActive === true && input.workerCount > 0) {
    return {
      ...base,
      action: 'pause',
      reason: 'foreground-active',
    };
  }

  if (input.observedCpuPercent > SIDECAR_MAX_CPU_PERCENT * 2) {
    return {
      ...base,
      action: 'pause',
      reason: 'cpu-over-budget',
    };
  }

  if (input.observedCpuPercent > SIDECAR_MAX_CPU_PERCENT) {
    return {
      ...base,
      action: 'throttle',
      reason: 'cpu-over-budget',
    };
  }

  return {
    ...base,
    action: 'continue',
    reason: 'within-budget',
  };
}

function validateSidecarThrottleInput(input: SidecarThrottleInput): string[] {
  const errors: string[] = [];

  if (!Number.isFinite(input.logicalCpuCount) || input.logicalCpuCount < 1) {
    errors.push('logicalCpuCount must be a finite number greater than or equal to 1');
  }

  if (!Number.isFinite(input.observedCpuPercent) || input.observedCpuPercent < 0) {
    errors.push('observedCpuPercent must be a finite number greater than or equal to 0');
  }

  if (!Number.isInteger(input.workerCount) || input.workerCount < 0) {
    errors.push('workerCount must be an integer greater than or equal to 0');
  }

  return errors;
}

function createDecisionBase(
  input: SidecarThrottleInput,
  errors: string[],
): Omit<SidecarThrottleDecision, 'action' | 'reason'> {
  return {
    maxCpuPercent: SIDECAR_MAX_CPU_PERCENT,
    maxWorkerCount: SIDECAR_MAX_WORKER_COUNT,
    observedCpuPercent: Number.isFinite(input.observedCpuPercent) ? input.observedCpuPercent : null,
    workerCount: Number.isFinite(input.workerCount) ? input.workerCount : null,
    logicalCpuCount: Number.isFinite(input.logicalCpuCount) ? input.logicalCpuCount : null,
    foregroundActive: input.foregroundActive === true,
    errors,
  };
}
