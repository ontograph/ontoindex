import { SIDECAR_MAX_CPU_PERCENT, SIDECAR_MAX_WORKER_COUNT } from './sidecar-throttle.js';

export type SidecarLaunchStatus = 'started' | 'rejected';

export type SidecarLaunchReason =
  | 'started'
  | 'worker-count-over-limit'
  | 'cpu-percent-over-limit'
  | 'invalid-command'
  | 'spawn-failed';

export type SidecarLaunchPlatform = NodeJS.Platform;

export interface SidecarSpawnedProcess {
  pid?: number;
}

export type SidecarSpawnFunction = (
  command: string,
  args: readonly string[],
  options?: SidecarSpawnOptions,
) => SidecarSpawnedProcess;

export interface SidecarSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  stdio?: 'ignore' | 'inherit' | 'pipe';
}

export interface SidecarCpuLimitOptions {
  available: boolean;
  command?: string;
}

export interface SidecarProcessLaunchOptions {
  command: string;
  args?: readonly string[];
  workerCount: number;
  cpuPercent: number;
  spawn: SidecarSpawnFunction;
  platform?: SidecarLaunchPlatform;
  niceValue?: number;
  cpulimit?: SidecarCpuLimitOptions;
  spawnOptions?: SidecarSpawnOptions;
}

export type SidecarProcessLaunchResult =
  | {
      status: 'started';
      started: true;
      command: string;
      args: readonly string[];
      pid: number | null;
      reason: 'started';
    }
  | {
      status: 'rejected';
      started: false;
      command: string;
      args: readonly string[];
      pid: null;
      reason: Exclude<SidecarLaunchReason, 'started'>;
      error?: string;
    };

export interface SidecarCommandSpec {
  command: string;
  args: readonly string[];
}

export function launchSidecarProcess(
  options: SidecarProcessLaunchOptions,
): SidecarProcessLaunchResult {
  const commandSpec = buildSidecarCommand(options);
  const rejection = validateSidecarLaunchOptions(options);
  if (rejection) {
    return {
      status: 'rejected',
      started: false,
      command: commandSpec.command,
      args: commandSpec.args,
      pid: null,
      reason: rejection,
    };
  }

  try {
    const child = options.spawn(commandSpec.command, commandSpec.args, {
      detached: false,
      stdio: 'ignore',
      ...options.spawnOptions,
    });
    return {
      status: 'started',
      started: true,
      command: commandSpec.command,
      args: commandSpec.args,
      pid: typeof child.pid === 'number' ? child.pid : null,
      reason: 'started',
    };
  } catch (error) {
    return {
      status: 'rejected',
      started: false,
      command: commandSpec.command,
      args: commandSpec.args,
      pid: null,
      reason: 'spawn-failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildSidecarCommand(options: {
  command: string;
  args?: readonly string[];
  cpuPercent: number;
  platform?: SidecarLaunchPlatform;
  niceValue?: number;
  cpulimit?: SidecarCpuLimitOptions;
}): SidecarCommandSpec {
  const baseArgs = [...(options.args ?? [])];
  const platform = options.platform ?? process.platform;
  const useNice = platform !== 'win32';
  const niceValue = options.niceValue ?? 19;
  const command = options.command;

  if (!useNice) {
    return { command, args: baseArgs };
  }

  const niceCommand = 'nice';
  const niceArgs = ['-n', String(niceValue), command, ...baseArgs];
  if (options.cpulimit?.available === true) {
    return {
      command: options.cpulimit.command ?? 'cpulimit',
      args: ['-l', String(options.cpuPercent), '--', niceCommand, ...niceArgs],
    };
  }

  return { command: niceCommand, args: niceArgs };
}

function validateSidecarLaunchOptions(
  options: SidecarProcessLaunchOptions,
): Exclude<SidecarLaunchReason, 'started' | 'spawn-failed'> | null {
  if (options.command.trim().length === 0) {
    return 'invalid-command';
  }
  if (options.workerCount > SIDECAR_MAX_WORKER_COUNT) {
    return 'worker-count-over-limit';
  }
  if (options.cpuPercent > SIDECAR_MAX_CPU_PERCENT) {
    return 'cpu-percent-over-limit';
  }
  return null;
}
