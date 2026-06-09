import { describe, expect, it, vi } from 'vitest';
import {
  createAxelLaunchContract,
  toSidecarProcessLaunchOptions,
} from '../../src/core/ingestion/enrichment/axel-launch-contract.js';
import {
  launchSidecarProcess,
  type SidecarSpawnFunction,
} from '../../src/core/ingestion/enrichment/index.js';

const unsortedFileScope = [
  { filePath: 'src/zeta.ts', fileHash: 'sha256:zeta' },
  { filePath: 'src/alpha.ts', fileHash: 'sha256:alpha' },
  { filePath: 'src/middle.ts', fileHash: 'sha256:middle' },
] as const;

describe('Axel launch contract edge cases', () => {
  it('includes only explicitly allowlisted env keys without leaking process.env', () => {
    const priorPath = process.env.PATH;
    process.env.AXEL_SECRET_FROM_PROCESS = 'must-not-leak';

    const contract = createAxelLaunchContract({
      command: 'node',
      args: ['axel.js'],
      fileScope: unsortedFileScope,
      env: {
        AXEL_ALLOWED_TOKEN: 'token-value',
        AXEL_DENIED_TOKEN: 'denied-value',
      },
      envAllowlist: ['AXEL_ALLOWED_TOKEN'],
      outputTarget: { kind: 'file', path: '/tmp/ontoindex-axel.jsonl' },
      workerCount: 1,
      cpuPercent: 10,
    });

    expect(contract.env).toEqual({ AXEL_ALLOWED_TOKEN: 'token-value' });
    expect(contract.env).not.toHaveProperty('AXEL_DENIED_TOKEN');
    expect(contract.env).not.toHaveProperty('AXEL_SECRET_FROM_PROCESS');
    expect(contract.env).not.toHaveProperty('PATH', priorPath);

    delete process.env.AXEL_SECRET_FROM_PROCESS;
  });

  it('uses deterministic file scope ordering by file path', () => {
    const contract = createAxelLaunchContract({
      command: 'node',
      args: ['axel.js'],
      fileScope: unsortedFileScope,
      env: {},
      envAllowlist: [],
      outputTarget: { kind: 'file', path: '/tmp/ontoindex-axel.jsonl' },
      workerCount: 1,
      cpuPercent: 10,
    });

    expect(contract.fileScope.map((file) => file.filePath)).toEqual([
      'src/alpha.ts',
      'src/middle.ts',
      'src/zeta.ts',
    ]);
  });

  it('requires an explicit output mode and rejects file/stdout ambiguity', () => {
    expect(() =>
      createAxelLaunchContract({
        command: 'node',
        args: ['axel.js'],
        fileScope: unsortedFileScope,
        env: {},
        envAllowlist: [],
        workerCount: 1,
        cpuPercent: 10,
      }),
    ).toThrow(/output/i);

    expect(() =>
      createAxelLaunchContract({
        command: 'node',
        args: ['axel.js'],
        fileScope: unsortedFileScope,
        env: {},
        envAllowlist: [],
        outputTarget: { kind: 'file', path: '/tmp/ontoindex-axel.jsonl' },
        stdoutMode: { kind: 'jsonl' },
        workerCount: 1,
        cpuPercent: 10,
      }),
    ).toThrow(/output|stdout|mutually exclusive/i);

    expect(
      createAxelLaunchContract({
        command: 'node',
        args: ['axel.js'],
        fileScope: unsortedFileScope,
        env: {},
        envAllowlist: [],
        stdoutMode: { kind: 'jsonl' },
        workerCount: 1,
        cpuPercent: 10,
      }).output,
    ).toEqual({ mode: 'stdout', format: 'jsonl' });
  });

  it('represents timeout, cancel, and failure policy without spawning', () => {
    const spawn = vi.fn<SidecarSpawnFunction>();

    const contract = createAxelLaunchContract({
      command: 'node',
      args: ['axel.js'],
      fileScope: unsortedFileScope,
      env: {},
      envAllowlist: [],
      outputTarget: { kind: 'file', path: '/tmp/ontoindex-axel.jsonl' },
      timeoutMs: 30_000,
      cancel: { kind: 'abort-signal', reason: 'user-request' },
      failurePolicy: { kind: 'record-failed', includeStderrTailBytes: 4096 },
      workerCount: 1,
      cpuPercent: 10,
    });

    expect(contract.policy).toEqual({
      timeoutMs: 30_000,
      cancel: { kind: 'abort-signal', reason: 'user-request' },
      failure: { kind: 'record-failed', includeStderrTailBytes: 4096 },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('adapts to launchSidecarProcess with injected spawn and strict worker/cpu limits', () => {
    const calls: string[] = [];
    const spawn = recordSpawn(calls, 4321);
    const contract = createAxelLaunchContract({
      command: 'node',
      args: ['axel.js'],
      fileScope: unsortedFileScope,
      env: { AXEL_ALLOWED_TOKEN: 'token-value' },
      envAllowlist: ['AXEL_ALLOWED_TOKEN'],
      outputTarget: { kind: 'file', path: '/tmp/ontoindex-axel.jsonl' },
      workerCount: 1,
      cpuPercent: 10,
    });

    const launchOptions = toSidecarProcessLaunchOptions(contract, {
      spawn,
      platform: 'linux',
    });

    expect(launchOptions.workerCount).toBe(1);
    expect(launchOptions.cpuPercent).toBeLessThanOrEqual(10);
    expect(launchOptions.spawn).toBe(spawn);
    expect(launchOptions.spawnOptions?.env).toEqual({ AXEL_ALLOWED_TOKEN: 'token-value' });

    const result = launchSidecarProcess(launchOptions);

    expect(result).toMatchObject({ status: 'started', started: true, pid: 4321 });
    expect(calls[0]).toContain('nice -n 19 node axel.js');
    expect(launchOptions.args).toContain('--output-target');
    expect(launchOptions.args).toContain('/tmp/ontoindex-axel.jsonl');
    expect(launchOptions.args).toContain('--file-scope');
  });
});

function recordSpawn(calls: string[], pid: number): SidecarSpawnFunction {
  return (command, args) => {
    calls.push([command, ...args].join(' '));
    return { pid };
  };
}
