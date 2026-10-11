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
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  stderr?: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown } | null;
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
  stdio?: 'ignore' | 'inherit' | 'pipe' | ['ignore', 'ignore', 'pipe'];
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

export async function launchSidecarProcess(
  options: SidecarProcessLaunchOptions,
): Promise<SidecarProcessLaunchResult> {
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
      stdio: ['ignore', 'ignore', 'pipe'],
      ...options.spawnOptions,
    });
    let stderrTail = Buffer.alloc(0);
    child.stderr?.on('data', (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrTail = Buffer.concat([stderrTail, data.subarray(-4096)]).subarray(-4096);
    });
    if (child.on) {
      await new Promise<void>((resolve, reject) => {
        // Keep the error listener attached after spawn so later errors are handled too.
        child.on!('error', (error: Error) => {
          reject(
            new Error(`${error.message}${stderrTail.length ? `\n${stderrTail.toString()}` : ''}`),
          );
        });
        child.on!('spawn', resolve);
      });
    }
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
