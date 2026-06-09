/**
 * Cursor CLI Client for Wiki Generation
 *
 * Wrapper for the Cursor headless CLI (`agent` command).
 * Uses print mode for non-interactive LLM calls.
 *
 * Docs: https://cursor.com/docs/cli/headless
 */

import { spawn, execFileSync } from 'child_process';
import type { LLMResponse, CallLLMOptions } from './llm-client.js';

interface CursorConfig {
  model?: string;
  workingDirectory?: string;
}

function isVerbose(): boolean {
  return process.env.ONTOINDEX_VERBOSE === '1';
}

function verboseLog(...args: unknown[]): void {
  if (isVerbose()) {
    console.log('[cursor-cli]', ...args);
  }
}

let cachedCursorBin: string | null | undefined;

const parsePositiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const CURSOR_TIMEOUT_MS = parsePositiveIntEnv('ONTOINDEX_CURSOR_TIMEOUT_MS', 10 * 60_000);
const CURSOR_KILL_GRACE_MS = parsePositiveIntEnv('ONTOINDEX_CURSOR_KILL_GRACE_MS', 5_000);
const MAX_CURSOR_STDOUT_BYTES = parsePositiveIntEnv(
  'ONTOINDEX_CURSOR_MAX_STDOUT_BYTES',
  10 * 1024 * 1024,
);
const MAX_CURSOR_STDERR_BYTES = parsePositiveIntEnv(
  'ONTOINDEX_CURSOR_MAX_STDERR_BYTES',
  1024 * 1024,
);

function truncateForError(text: string, maxChars = 2000): string {
  return text.length <= maxChars ? text : `${text.slice(-maxChars)} [truncated]`;
}

/**
 * Detect if Cursor CLI is available in PATH.
 * Returns the binary name if found ('agent'), null otherwise.
 * Result is cached after the first call.
 */
export function detectCursorCLI(): string | null {
  if (cachedCursorBin !== undefined) return cachedCursorBin;
  try {
    execFileSync('agent', ['--version'], {
      stdio: 'ignore',
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    cachedCursorBin = 'agent';
  } catch {
    cachedCursorBin = null;
  }
  return cachedCursorBin;
}

/**
 * Resolve Cursor CLI configuration.
 * Model is optional - if not provided, Cursor CLI uses its default (auto).
 */
export function resolveCursorConfig(overrides?: Partial<CursorConfig>): CursorConfig {
  return {
    model: overrides?.model,
    workingDirectory: overrides?.workingDirectory,
  };
}

/**
 * Call the Cursor CLI in print mode.
 *
 * Uses `agent -p --output-format text` for clean non-streaming output.
 * The prompt is passed as the final CLI argument.
 */
export async function callCursorLLM(
  prompt: string,
  config: CursorConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  const cursorBin = detectCursorCLI();
  if (!cursorBin) {
    throw new Error(
      'Cursor CLI not found. Install it from https://cursor.com/docs/cli/installation',
    );
  }

  // Always use text format to get clean output without agent narration/thinking.
  // stream-json captures assistant messages which include "Let me explore..." narration
  // that pollutes the actual content when using thinking models.
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;

  const args = ['-p', '--output-format', 'text'];

  if (config.model) {
    args.push('--model', config.model);
  }

  // Add the prompt as the final argument
  args.push(fullPrompt);

  verboseLog(
    'Spawning:',
    cursorBin,
    args.slice(0, -1).join(' '),
    '[prompt length:',
    fullPrompt.length,
    'chars]',
  );
  verboseLog('Working directory:', config.workingDirectory || process.cwd());
  if (config.model) {
    verboseLog('Model:', config.model);
  } else {
    verboseLog('Model: auto (default)');
  }

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(cursorBin, args, {
      cwd: config.workingDirectory || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure non-interactive mode
        CI: '1',
      },
    });

    verboseLog('Process spawned with PID:', child.pid);

    const clearTimeoutTimer = () => {
      clearTimeout(timeoutTimer);
    };

    const clearKillTimer = () => {
      if (!killTimer) return;
      clearTimeout(killTimer);
      killTimer = null;
    };

    const terminateChild = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, CURSOR_KILL_GRACE_MS);
      if (typeof killTimer === 'object' && 'unref' in killTimer) {
        killTimer.unref();
      }
    };

    const finish = (err: Error | null, response?: LLMResponse) => {
      if (settled) return;
      settled = true;
      clearTimeoutTimer();
      if (err) {
        reject(err);
      } else {
        resolve(response ?? { content: '' });
      }
    };

    const timeoutTimer = setTimeout(() => {
      terminateChild();
      finish(new Error(`Cursor CLI timed out after ${CURSOR_TIMEOUT_MS}ms`));
    }, CURSOR_TIMEOUT_MS);
    if (typeof timeoutTimer === 'object' && 'unref' in timeoutTimer) {
      timeoutTimer.unref();
    }

    // Text mode - collect all output, report progress based on output size
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_CURSOR_STDOUT_BYTES) {
        terminateChild();
        finish(new Error(`Cursor CLI stdout exceeded ${MAX_CURSOR_STDOUT_BYTES} bytes`));
        return;
      }
      const chunkStr = chunk.toString();
      stdout += chunkStr;
      verboseLog(`[stdout] received ${chunkStr.length} chars, total: ${stdout.length}`);

      // Report progress if callback provided
      if (options?.onChunk) {
        options.onChunk(stdout.length);
      }
    });

    child.on('close', (code) => {
      clearKillTimer();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      verboseLog(`Process exited with code ${code} after ${elapsed}s`);
      verboseLog(`stdout length: ${stdout.length} chars`);

      if (code !== 0) {
        verboseLog('stderr:', stderr);
        finish(new Error(`Cursor CLI exited with code ${code}: ${truncateForError(stderr)}`));
        return;
      }
      finish(null, { content: stdout.trim() });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_CURSOR_STDERR_BYTES) {
        terminateChild();
        finish(new Error(`Cursor CLI stderr exceeded ${MAX_CURSOR_STDERR_BYTES} bytes`));
        return;
      }
      const chunkStr = chunk.toString();
      stderr += chunkStr;
      verboseLog('[stderr]', chunkStr.trim());
    });

    child.on('error', (err) => {
      verboseLog('Spawn error:', err.message);
      finish(new Error(`Failed to spawn Cursor CLI: ${err.message}`));
    });

    // Close stdin immediately since we pass prompt as argument
    child.stdin?.end();
  });
}
