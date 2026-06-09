import { describe, expect, it } from 'vitest';
import {
  AXEL_ANALYZER_ID,
  AXEL_DEFAULT_ANALYZER_VERSION,
  AXEL_DEFAULT_TIMEOUT_MS,
  buildAxelSidecarCommand,
  createAxelLaunchContract,
} from '../../src/core/ingestion/enrichment/index.js';

const baseInput = {
  command: '/opt/axel/bin/axel-analyzer',
  args: ['analyze'],
  repoRoot: '/workspace/repo',
  sourceIndexId: 'index-1',
  sourceCommitHash: 'abc123',
  repoId: 'repo-1',
  schemaVersion: 1,
  stdoutMode: { kind: 'jsonl' },
} as const;

describe('Axel launch contract', () => {
  it('builds deterministic argv for repo/index/commit/schema/stdout output', () => {
    const contract = createAxelLaunchContract(baseInput);

    expect(contract).toEqual({
      analyzerId: AXEL_ANALYZER_ID,
      analyzerVersion: AXEL_DEFAULT_ANALYZER_VERSION,
      command: baseInput.command,
      args: [
        'analyze',
        '--repo-root',
        '/workspace/repo',
        '--source-index-id',
        'index-1',
        '--source-commit-hash',
        'abc123',
        '--repo-id',
        'repo-1',
        '--schema-version',
        '1',
        '--output-mode',
        'stdout',
      ],
      workerCount: 1,
      cpuPercent: 10,
      timeoutMs: AXEL_DEFAULT_TIMEOUT_MS,
      outputMode: 'stdout',
      output: { mode: 'stdout', format: 'jsonl' },
      fileScope: [],
      policy: {
        timeoutMs: AXEL_DEFAULT_TIMEOUT_MS,
        failure: { kind: 'record-failed', includeStderrTailBytes: 4096 },
      },
    });
  });

  it('builds deterministic argv for file output targets', () => {
    const contract = createAxelLaunchContract({
      ...baseInput,
      outputMode: 'file',
      outputTarget: '/tmp/axel-output.jsonl',
      stdoutMode: undefined,
    });

    expect(contract.args).toEqual([
      'analyze',
      '--repo-root',
      '/workspace/repo',
      '--source-index-id',
      'index-1',
      '--source-commit-hash',
      'abc123',
      '--repo-id',
      'repo-1',
      '--schema-version',
      '1',
      '--output-mode',
      'file',
      '--output-target',
      '/tmp/axel-output.jsonl',
    ]);
  });

  it('includes file scope args deterministically', () => {
    const contract = createAxelLaunchContract({
      ...baseInput,
      fileScopes: [
        { filePath: 'src/z.ts', fileHash: 'hash-z' },
        { filePath: 'src/a.ts', fileHash: 'hash-b' },
        { filePath: 'src/a.ts', fileHash: 'hash-a' },
      ],
    });

    expect(contract.args.slice(-6)).toEqual([
      '--file-scope',
      'src/a.ts=hash-a',
      '--file-scope',
      'src/a.ts=hash-b',
      '--file-scope',
      'src/z.ts=hash-z',
    ]);
  });

  it('rejects blank command and invalid timeout/cpu', () => {
    expect(() => createAxelLaunchContract({ ...baseInput, command: '  ' })).toThrow(
      'command must be a non-empty string',
    );
    expect(() => createAxelLaunchContract({ ...baseInput, timeoutMs: 0 })).toThrow(
      'timeoutMs must be a positive integer',
    );
    expect(() => createAxelLaunchContract({ ...baseInput, timeoutMs: 30 * 60 * 1000 + 1 })).toThrow(
      'timeoutMs must be less than or equal to 1800000',
    );
    expect(() => createAxelLaunchContract({ ...baseInput, cpuPercent: 0 })).toThrow(
      'cpuPercent must be a finite number greater than 0',
    );
    expect(() => createAxelLaunchContract({ ...baseInput, cpuPercent: 11 })).toThrow(
      'cpuPercent must be less than or equal to 10',
    );
  });

  it('uses one worker and 10 percent CPU by default', () => {
    const contract = createAxelLaunchContract(baseInput);

    expect(contract.workerCount).toBe(1);
    expect(contract.cpuPercent).toBe(10);
  });

  it('copies only explicitly supplied env into the contract', () => {
    const env = { AXEL_MODE: 'test' };
    const contract = createAxelLaunchContract({ ...baseInput, env });
    env.AXEL_MODE = 'changed';

    expect(contract.env).toEqual({ AXEL_MODE: 'test' });
  });

  it('can be passed through sidecar command wrapping with nice and cpulimit', () => {
    const command = buildAxelSidecarCommand({
      ...baseInput,
      cpuPercent: 8,
      platform: 'linux',
      cpulimit: { available: true },
    });

    expect(command).toEqual({
      command: 'cpulimit',
      args: [
        '-l',
        '8',
        '--',
        'nice',
        '-n',
        '19',
        '/opt/axel/bin/axel-analyzer',
        'analyze',
        '--repo-root',
        '/workspace/repo',
        '--source-index-id',
        'index-1',
        '--source-commit-hash',
        'abc123',
        '--repo-id',
        'repo-1',
        '--schema-version',
        '1',
        '--output-mode',
        'stdout',
      ],
    });
  });
});
