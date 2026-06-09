import {
  AXEL_ANALYZER_ID,
  createAxelLaunchContract,
  toSidecarProcessLaunchOptions,
  type AxelFileScope,
  type AxelLaunchContractInput,
  type AxelOutputTarget,
  type AxelSidecarLaunchOptionsInput,
  type AxelStdoutMode,
} from './axel-launch-contract.js';
import { launchSidecarProcess } from './sidecar-process-launcher.js';
import type { SidecarEnrichmentRequest } from './sidecar-request-pool.js';
import type { SidecarRunnerCallbacks, SidecarRunnerExecutionResult } from './sidecar-runner.js';

export interface AxelRunnerExecutorOptions
  extends
    Pick<
      AxelLaunchContractInput,
      | 'command'
      | 'args'
      | 'repoRoot'
      | 'sourceCommitHash'
      | 'schemaVersion'
      | 'cwd'
      | 'env'
      | 'envAllowlist'
    >,
    AxelSidecarLaunchOptionsInput {
  outputTarget?: AxelOutputTarget;
  stdoutMode?: AxelStdoutMode;
  fileScope?: readonly AxelFileScope[];
}

export function createAxelRunnerExecutor(
  options: AxelRunnerExecutorOptions,
): SidecarRunnerCallbacks['executeRequest'] {
  return async (request) => launchAxelForQueuedRequest(request, options);
}

export async function launchAxelForQueuedRequest(
  request: SidecarEnrichmentRequest,
  options: AxelRunnerExecutorOptions,
): Promise<SidecarRunnerExecutionResult> {
  assertAxelRequest(request);
  const contract = createAxelLaunchContract({
    ...options,
    repoId: request.repoId,
    sourceIndexId: request.sourceIndexId,
    analyzerVersion: request.analyzerVersion,
    fileScope: options.fileScope,
  });
  const result = launchSidecarProcess(toSidecarProcessLaunchOptions(contract, options));

  if (result.status === 'rejected') {
    throw new Error(
      result.error
        ? `Axel sidecar launch rejected: ${result.reason}: ${result.error}`
        : `Axel sidecar launch rejected: ${result.reason}`,
    );
  }

  return { status: 'running' };
}

function assertAxelRequest(request: SidecarEnrichmentRequest): void {
  if (request.analyzerId !== AXEL_ANALYZER_ID) {
    throw new Error(`Axel runner received non-Axel request: ${request.analyzerId}`);
  }
  if (request.purpose !== 'architecture-enrichment') {
    throw new Error(`Axel runner received unsupported purpose: ${request.purpose}`);
  }
}
