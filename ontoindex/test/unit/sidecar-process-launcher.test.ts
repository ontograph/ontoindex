import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  buildSidecarCommand,
  launchSidecarProcess,
  type SidecarSpawnFunction,
} from '../../src/core/ingestion/enrichment/index.js';

describe('sidecar process launcher', () => {
  it('handles asynchronous ENOENT without an unhandled child error', async () => {
    const result = await launchSidecarProcess({
      command: '/definitely-missing-ontoindex-sidecar',
      workerCount: 1,
      cpuPercent: 10,
      platform: 'win32',
      spawn: (command, args, options) => spawn(command, [...args], options),
    });
    expect(result).toMatchObject({ status: 'rejected', reason: 'spawn-failed' });
    expect(result).toHaveProperty('error', expect.stringContaining('ENOENT'));
  });

  it('confirms a real successful spawn', async () => {
    const result = await launchSidecarProcess({
      command: process.execPath,
      args: ['-e', ''],
      workerCount: 1,
      cpuPercent: 10,
      platform: 'win32',
      spawn: (command, args, options) => spawn(command, [...args], options),
    });
    expect(result).toMatchObject({ status: 'started', started: true });
  });

  it('retains only the bounded stderr tail in a spawn failure', async () => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    const pending = launchSidecarProcess({
      command: 'node',
      workerCount: 1,
      cpuPercent: 10,
      spawn: () => child,
    });
    child.stderr.emit('data', Buffer.from('discarded-prefix' + 'x'.repeat(4096)));
    child.emit('error', new Error('spawn failed'));
    const result = await pending;
    expect(result).toHaveProperty('error', 'spawn failed\n' + 'x'.repeat(4096));
  });
  it('constructs a nice-wrapped command on POSIX', async () => {
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

  it('constructs an optional cpulimit wrapper outside nice when available', async () => {
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

  it('rejects worker counts over the one-worker contract', async () => {
    const calls: string[] = [];
    const result = await launchSidecarProcess({
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

  it('rejects CPU percentages over the 10 percent contract', async () => {
    const calls: string[] = [];
    const result = await launchSidecarProcess({
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

  it('returns a structured spawn failure without throwing', async () => {
    const result = await launchSidecarProcess({
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

  it('starts exactly one injected spawn call and returns pid', async () => {
    const calls: string[] = [];
    const result = await launchSidecarProcess({
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
