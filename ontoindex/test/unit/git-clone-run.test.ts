import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

import { runGit } from '../../src/server/git-clone.js';

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('runGit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects without spawning when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(runGit(['pull'], undefined, { signal: controller.signal })).rejects.toThrow(
      'git operation aborted',
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('terminates a git process when the timeout expires', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const result = runGit(['clone', 'https://example.com/repo.git', '/tmp/repo'], undefined, {
      timeoutMs: 5,
    });
    await vi.advanceTimersByTimeAsync(5);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await expect(result).rejects.toThrow('git clone timed out after 5ms');
  });

  it('escalates to SIGKILL when a timed-out git process does not exit', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const result = runGit(['pull'], '/tmp/repo', { timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.killed = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('close', null, 'SIGKILL');
    await expect(result).rejects.toThrow('git pull timed out after 5ms');
  });

  it('terminates a running git process when the caller aborts', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    const controller = new AbortController();
    spawnMock.mockReturnValueOnce(child);

    const result = runGit(['pull'], '/tmp/repo', {
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await expect(result).rejects.toThrow('git pull aborted');
  });

  it('caps captured stderr before logging failed git output', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = runGit(['pull'], '/tmp/repo', { timeoutMs: 60_000 });
    child.stderr.emit('data', Buffer.from('a'.repeat(20_000)));
    child.stderr.emit('data', Buffer.from('tail'));
    child.emit('close', 1, null);

    await expect(result).rejects.toThrow('git pull failed');
    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain('tail');
    expect(logged.length).toBeLessThan(17_000);
  });
});
