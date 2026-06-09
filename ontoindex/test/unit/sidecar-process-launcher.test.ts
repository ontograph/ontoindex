import { describe, expect, it } from 'vitest';
import {
  buildSidecarCommand,
  launchSidecarProcess,
  type SidecarSpawnFunction,
} from '../../src/core/ingestion/enrichment/index.js';

describe('sidecar process launcher', () => {
  it('constructs a nice-wrapped command on POSIX', () => {
    const command = buildSidecarCommand({
      command: 'node',
      args: ['sidecar.js', '--once'],
      cpuPercent: 10,
      platform: 'linux',
    });

    expect(command).toEqual({
      command: 'nice',
      args: ['-n', '19', 'node', 'sidecar.js', '--once'],
    });
  });

  it('constructs an optional cpulimit wrapper outside nice when available', () => {
    const command = buildSidecarCommand({
      command: 'node',
      args: ['sidecar.js'],
      cpuPercent: 8,
      platform: 'darwin',
      cpulimit: { available: true },
    });

    expect(command).toEqual({
      command: 'cpulimit',
      args: ['-l', '8', '--', 'nice', '-n', '19', 'node', 'sidecar.js'],
    });
  });

  it('rejects worker counts over the one-worker contract', () => {
    const calls: string[] = [];
    const result = launchSidecarProcess({
      command: 'node',
      args: ['sidecar.js'],
      workerCount: 2,
      cpuPercent: 10,
      platform: 'linux',
      spawn: recordSpawn(calls),
    });

    expect(result).toMatchObject({
      status: 'rejected',
      started: false,
      command: 'nice',
      args: ['-n', '19', 'node', 'sidecar.js'],
      pid: null,
      reason: 'worker-count-over-limit',
    });
    expect(calls).toEqual([]);
  });

  it('rejects CPU percentages over the 10 percent contract', () => {
    const calls: string[] = [];
    const result = launchSidecarProcess({
      command: 'node',
      args: ['sidecar.js'],
      workerCount: 1,
      cpuPercent: 11,
      platform: 'linux',
      spawn: recordSpawn(calls),
    });

    expect(result).toMatchObject({
      status: 'rejected',
      started: false,
      command: 'nice',
      args: ['-n', '19', 'node', 'sidecar.js'],
      pid: null,
      reason: 'cpu-percent-over-limit',
    });
    expect(calls).toEqual([]);
  });

  it('returns a structured spawn failure without throwing', () => {
    const result = launchSidecarProcess({
      command: 'node',
      args: ['sidecar.js'],
      workerCount: 1,
      cpuPercent: 10,
      platform: 'linux',
      spawn: () => {
        throw new Error('spawn denied');
      },
    });

    expect(result).toMatchObject({
      status: 'rejected',
      started: false,
      command: 'nice',
      args: ['-n', '19', 'node', 'sidecar.js'],
      pid: null,
      reason: 'spawn-failed',
      error: 'spawn denied',
    });
  });

  it('starts exactly one injected spawn call and returns pid', () => {
    const calls: string[] = [];
    const result = launchSidecarProcess({
      command: 'node',
      args: ['sidecar.js'],
      workerCount: 1,
      cpuPercent: 10,
      platform: 'linux',
      spawn: recordSpawn(calls, 1234),
    });

    expect(result).toEqual({
      status: 'started',
      started: true,
      command: 'nice',
      args: ['-n', '19', 'node', 'sidecar.js'],
      pid: 1234,
      reason: 'started',
    });
    expect(calls).toEqual(['nice -n 19 node sidecar.js']);
  });
});

function recordSpawn(calls: string[], pid = 100): SidecarSpawnFunction {
  return (command, args) => {
    calls.push([command, ...args].join(' '));
    return { pid };
  };
}
