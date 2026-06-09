import { describe, expect, it } from 'vitest';
import {
  createAxelEnrichmentQueueRequest,
  createAxelRunnerExecutor,
  createSidecarRequest,
  type SidecarSpawnFunction,
} from '../../src/core/ingestion/enrichment/index.js';

const requestInput = {
  enabled: true,
  repoId: 'repo-1',
  sourceIndexId: 'index-1',
  scopeHash: 'scope-1',
  requestedAt: '2026-05-13T10:00:00.000Z',
} as const;

describe('Axel runner executor', () => {
  it('launches an Axel request through injected spawn and returns running', async () => {
    const calls: string[] = [];
    const request = createQueuedRequest();
    const executor = createAxelRunnerExecutor({
      command: 'node',
      args: ['axel.js'],
      repoRoot: '/repo',
      sourceCommitHash: 'abc123',
      schemaVersion: 1,
      outputTarget: { kind: 'file', path: '/tmp/axel.jsonl' },
      fileScope: [{ filePath: 'src/a.ts', fileHash: 'sha256:a' }],
      spawn: recordSpawn(calls, 1234),
      platform: 'linux',
    });

    await expect(executor(request, { heartbeat: async () => true })).resolves.toEqual({
      status: 'running',
    });
    expect(calls[0]).toContain('nice -n 19 node axel.js');
    expect(calls[0]).toContain('--source-index-id index-1');
    expect(calls[0]).toContain('--repo-id repo-1');
    expect(calls[0]).toContain('--output-target /tmp/axel.jsonl');
    expect(calls[0]).toContain('--file-scope src/a.ts=sha256:a');
  });

  it('rejects non-Axel queued work before spawning', async () => {
    const calls: string[] = [];
    const executor = createAxelRunnerExecutor({
      command: 'node',
      stdoutMode: { kind: 'jsonl' },
      spawn: recordSpawn(calls, 1234),
    });
    const request = createSidecarRequest({
      repoId: 'repo-1',
      sourceIndexId: 'index-1',
      analyzerId: 'other',
      analyzerVersion: '1.0.0',
      purpose: 'architecture-enrichment',
      scopeHash: 'scope-1',
      priority: 'background-remainder',
      requestedAt: '2026-05-13T10:00:00.000Z',
    });

    await expect(executor(request, { heartbeat: async () => true })).rejects.toThrow(
      'Axel runner received non-Axel request: other',
    );
    expect(calls).toEqual([]);
  });

  it('turns spawn rejection into executor failure', async () => {
    const request = createQueuedRequest();
    const executor = createAxelRunnerExecutor({
      command: 'node',
      stdoutMode: { kind: 'jsonl' },
      spawn: (() => {
        throw new Error('spawn denied');
      }) as SidecarSpawnFunction,
    });

    await expect(executor(request, { heartbeat: async () => true })).rejects.toThrow(
      'Axel sidecar launch rejected: spawn-failed: spawn denied',
    );
  });
});

function createQueuedRequest() {
  const decision = createAxelEnrichmentQueueRequest(requestInput);
  if (!decision.queued) throw new Error('expected queued Axel request');
  return createSidecarRequest(decision.request);
}

function recordSpawn(calls: string[], pid: number): SidecarSpawnFunction {
  return (command, args) => {
    calls.push([command, ...args].join(' '));
    return { pid };
  };
}
