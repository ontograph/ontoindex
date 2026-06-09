import {
  buildSidecarCommand,
  type SidecarCommandSpec,
  type SidecarProcessLaunchOptions,
  type SidecarSpawnFunction,
} from './sidecar-process-launcher.js';
import { SIDECAR_MAX_CPU_PERCENT, SIDECAR_MAX_WORKER_COUNT } from './sidecar-throttle.js';

export const AXEL_ANALYZER_ID = 'axel';
export const AXEL_DEFAULT_ANALYZER_VERSION = '0.1.0';
export const AXEL_DEFAULT_CPU_PERCENT = SIDECAR_MAX_CPU_PERCENT;
export const AXEL_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const AXEL_MAX_TIMEOUT_MS = 30 * 60 * 1000;

export type AxelOutputMode = 'file' | 'stdout';
export type AxelOutputTarget = string | { kind: 'file'; path: string };
export type AxelStdoutMode = { kind: 'jsonl' };
export type AxelCancelPolicy = { kind: 'abort-signal'; reason: string };
export type AxelFailurePolicy = { kind: 'record-failed'; includeStderrTailBytes: number };

export interface AxelFileScope {
  filePath: string;
  fileHash: string;
}

export interface AxelLaunchContractInput {
  command: string;
  args?: readonly string[];
  repoRoot?: string;
  sourceIndexId?: string;
  sourceCommitHash?: string;
  repoId?: string;
  schemaVersion?: number;
  analyzerVersion?: string;
  outputMode?: AxelOutputMode;
  outputTarget?: AxelOutputTarget;
  stdoutMode?: AxelStdoutMode;
  fileScopes?: readonly AxelFileScope[];
  fileScope?: readonly AxelFileScope[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  envAllowlist?: readonly string[];
  workerCount?: number;
  cpuPercent?: number;
  timeoutMs?: number;
  cancel?: AxelCancelPolicy;
  failurePolicy?: AxelFailurePolicy;
}

export interface AxelLaunchContract {
  analyzerId: typeof AXEL_ANALYZER_ID;
  analyzerVersion: string;
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  workerCount: typeof SIDECAR_MAX_WORKER_COUNT;
  cpuPercent: number;
  timeoutMs: number;
  outputMode: AxelOutputMode;
  output: { mode: 'file'; path: string } | { mode: 'stdout'; format: AxelStdoutMode['kind'] };
  fileScope: readonly AxelFileScope[];
  policy: {
    timeoutMs: number;
    cancel?: AxelCancelPolicy;
    failure: AxelFailurePolicy;
  };
}

export interface AxelSidecarCommandInput extends AxelLaunchContractInput {
  platform?: NodeJS.Platform;
  niceValue?: number;
  cpulimit?: {
    available: boolean;
    command?: string;
  };
}

export interface AxelSidecarLaunchOptionsInput {
  spawn: SidecarSpawnFunction;
  platform?: NodeJS.Platform;
  niceValue?: number;
  cpulimit?: {
    available: boolean;
    command?: string;
  };
}

export function createAxelLaunchContract(input: AxelLaunchContractInput): AxelLaunchContract {
  const command = requireNonBlank(input.command, 'command');
  const output = resolveOutput(input);
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
  const contract: AxelLaunchContract = {
    analyzerId: AXEL_ANALYZER_ID,
    analyzerVersion: input.analyzerVersion ?? AXEL_DEFAULT_ANALYZER_VERSION,
    command,
    args: buildAxelArgs(input, output),
    workerCount: normalizeWorkerCount(input.workerCount),
    cpuPercent: normalizeCpuPercent(input.cpuPercent),
    timeoutMs,
    outputMode: output.mode,
    output,
    fileScope: normalizeFileScopes(input),
    policy: {
      timeoutMs,
      failure: normalizeFailurePolicy(input.failurePolicy),
    },
  };

  if (input.cancel !== undefined) {
    contract.policy.cancel = {
      kind: 'abort-signal',
      reason: requireNonBlank(input.cancel.reason, 'cancel.reason'),
    };
  }
  if (input.cwd !== undefined) {
    contract.cwd = requireNonBlank(input.cwd, 'cwd');
  }
  if (input.env !== undefined) {
    contract.env = filterEnv(input.env, input.envAllowlist);
  }
  return contract;
}

export function buildAxelSidecarCommand(input: AxelSidecarCommandInput): SidecarCommandSpec {
  const contract = createAxelLaunchContract(input);
  return buildSidecarCommand({
    command: contract.command,
    args: contract.args,
    cpuPercent: contract.cpuPercent,
    platform: input.platform,
    niceValue: input.niceValue,
    cpulimit: input.cpulimit,
  });
}

export function toSidecarProcessLaunchOptions(
  contract: AxelLaunchContract,
  input: AxelSidecarLaunchOptionsInput,
): SidecarProcessLaunchOptions {
  return {
    command: contract.command,
    args: contract.args,
    workerCount: contract.workerCount,
    cpuPercent: contract.cpuPercent,
    spawn: input.spawn,
    platform: input.platform,
    niceValue: input.niceValue,
    cpulimit: input.cpulimit,
    spawnOptions: {
      cwd: contract.cwd,
      env: contract.env,
      detached: false,
      stdio: contract.outputMode === 'stdout' ? 'pipe' : 'ignore',
    },
  };
}

function buildAxelArgs(
  input: AxelLaunchContractInput,
  output: AxelLaunchContract['output'],
): readonly string[] {
  const args = [
    ...(input.args ?? []),
    '--repo-root',
    requireNonBlank(input.repoRoot ?? '.', 'repoRoot'),
    '--source-index-id',
    requireNonBlank(input.sourceIndexId ?? 'unknown-index', 'sourceIndexId'),
    '--source-commit-hash',
    requireNonBlank(input.sourceCommitHash ?? 'unknown-commit', 'sourceCommitHash'),
    '--repo-id',
    requireNonBlank(input.repoId ?? 'unknown-repo', 'repoId'),
    '--schema-version',
    String(normalizeSchemaVersion(input.schemaVersion ?? 1)),
    '--output-mode',
    output.mode,
  ];

  if (output.mode === 'file') {
    args.push('--output-target', output.path);
  }

  for (const fileScope of normalizeFileScopes(input)) {
    args.push(
      '--file-scope',
      `${requireNonBlank(fileScope.filePath, 'fileScope.filePath')}=${requireNonBlank(
        fileScope.fileHash,
        'fileScope.fileHash',
      )}`,
    );
  }

  return args;
}

function resolveOutput(input: AxelLaunchContractInput): AxelLaunchContract['output'] {
  if (input.outputTarget !== undefined && input.stdoutMode !== undefined) {
    throw new Error('outputTarget and stdoutMode are mutually exclusive');
  }
  if (input.outputMode === 'file' && input.stdoutMode !== undefined) {
    throw new Error('outputMode file and stdoutMode are mutually exclusive');
  }
  if (input.outputMode === 'stdout' && input.outputTarget !== undefined) {
    throw new Error('outputMode stdout and outputTarget are mutually exclusive');
  }

  if (input.outputTarget !== undefined || input.outputMode === 'file') {
    const outputTarget = input.outputTarget;
    if (outputTarget === undefined) {
      throw new Error('outputTarget is required when outputMode is file');
    }
    return {
      mode: 'file',
      path:
        typeof outputTarget === 'string'
          ? requireNonBlank(outputTarget, 'outputTarget')
          : requireNonBlank(outputTarget.path, 'outputTarget.path'),
    };
  }

  if (input.stdoutMode !== undefined || input.outputMode === 'stdout') {
    return { mode: 'stdout', format: input.stdoutMode?.kind ?? 'jsonl' };
  }

  throw new Error('explicit outputTarget or stdoutMode is required');
}

function normalizeFileScopes(input: AxelLaunchContractInput): readonly AxelFileScope[] {
  return [...(input.fileScopes ?? input.fileScope ?? [])].sort(compareFileScopes);
}

function normalizeWorkerCount(
  workerCount = SIDECAR_MAX_WORKER_COUNT,
): typeof SIDECAR_MAX_WORKER_COUNT {
  if (workerCount !== SIDECAR_MAX_WORKER_COUNT) {
    throw new Error(`workerCount must be ${SIDECAR_MAX_WORKER_COUNT}`);
  }
  return SIDECAR_MAX_WORKER_COUNT;
}

function normalizeCpuPercent(cpuPercent = AXEL_DEFAULT_CPU_PERCENT): number {
  if (!Number.isFinite(cpuPercent) || cpuPercent <= 0) {
    throw new Error('cpuPercent must be a finite number greater than 0');
  }
  if (cpuPercent > SIDECAR_MAX_CPU_PERCENT) {
    throw new Error(`cpuPercent must be less than or equal to ${SIDECAR_MAX_CPU_PERCENT}`);
  }
  return cpuPercent;
}

function normalizeTimeoutMs(timeoutMs = AXEL_DEFAULT_TIMEOUT_MS): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive integer');
  }
  if (timeoutMs > AXEL_MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be less than or equal to ${AXEL_MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function normalizeSchemaVersion(schemaVersion: number): number {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
    throw new Error('schemaVersion must be a non-negative integer');
  }
  return schemaVersion;
}

function normalizeFailurePolicy(failurePolicy?: AxelFailurePolicy): AxelFailurePolicy {
  if (failurePolicy === undefined) {
    return { kind: 'record-failed', includeStderrTailBytes: 4096 };
  }
  if (
    !Number.isInteger(failurePolicy.includeStderrTailBytes) ||
    failurePolicy.includeStderrTailBytes < 0
  ) {
    throw new Error('failurePolicy.includeStderrTailBytes must be a non-negative integer');
  }
  return {
    kind: 'record-failed',
    includeStderrTailBytes: failurePolicy.includeStderrTailBytes,
  };
}

function filterEnv(
  env: Readonly<Record<string, string>>,
  allowlist: readonly string[] = Object.keys(env),
): Readonly<Record<string, string>> {
  const filtered: Record<string, string> = {};
  for (const key of allowlist) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      filtered[key] = env[key];
    }
  }
  return filtered;
}

function requireNonBlank(input: string | undefined, fieldName: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return input;
}

function compareFileScopes(left: AxelFileScope, right: AxelFileScope): number {
  return left.filePath.localeCompare(right.filePath) || left.fileHash.localeCompare(right.fileHash);
}
