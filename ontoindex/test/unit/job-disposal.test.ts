import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { JobManager } from '../../src/server/analyze-job.js';

function childProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => true) as any;
  return child;
}

describe('JobManager disposal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('latches synchronously and reuses the promise even inside cancellation handlers', async () => {
    const manager = new JobManager();
    const job = manager.createJob({ repoPath: '/repo' });
    let reentered: Promise<void> | undefined;
    manager.registerCancelHandler(job.id, () => {
      expect(manager.shuttingDown).toBe(true);
      expect(job.status).toBe('failed');
      reentered = manager.dispose();
    });
    const disposed = manager.dispose();
    expect(reentered).toBe(disposed);
    expect(manager.dispose()).toBe(disposed);
    expect(() => manager.createJob({ repoPath: '/late' })).toThrow('shutting down');
    manager.updateJob(job.id, { status: 'analyzing' });
    expect(job.status).toBe('failed');
    await disposed;
  });

  it('publishes cancellation before synchronous child exit and waits through escalation', async () => {
    vi.useFakeTimers();
    const manager = new JobManager();
    const job = manager.createJob({ repoPath: '/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });
    const child = childProcess();
    const cleanup = vi.fn();
    child.kill = vi.fn((signal) => {
      expect(job.progress.phase).toBe('cancelling');
      if (signal === 'SIGKILL') child.emit('exit', null, signal);
      return true;
    }) as any;
    manager.registerChild(job.id, child, { processGroup: true, onTerminalExit: cleanup });
    const disposed = manager.dispose();
    const finished = vi.fn();
    void disposed.then(finished);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(finished).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(26);
    await disposed;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(job.error).toBe('Server shutdown');
  });

  it('preserves previous cancellation reason and its original escalation deadline', async () => {
    vi.useFakeTimers();
    const manager = new JobManager();
    const job = manager.createJob({ repoPath: '/repo' });
    const child = childProcess();
    child.kill = vi.fn((signal) => {
      if (signal === 'SIGKILL') child.emit('exit', null, signal);
      return true;
    }) as any;
    manager.registerChild(job.id, child, { killGraceMs: 200 });
    manager.cancelJob(job.id, 'Cancelled by user');
    await vi.advanceTimersByTimeAsync(100);
    const disposed = manager.dispose();
    await vi.advanceTimersByTimeAsync(125);
    await disposed;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(job.error).toBe('Cancelled by user');
  });

  it('isolates throwing abort handlers and waits for work finally cleanup', async () => {
    vi.useFakeTimers();
    const manager = new JobManager();
    const first = manager.createJob({ repoPath: '/first' });
    const second = manager.createJob({ repoPath: '/second' });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const abort = vi.fn();
    manager.registerCancelHandler(first.id, () => {
      throw new Error('abort failed');
    });
    manager.registerCancelHandler(second.id, abort);
    let finish!: () => void;
    const cleanup = vi.fn();
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    }).finally(cleanup);
    manager.trackWork(work);
    const disposed = manager.dispose();
    const finished = vi.fn();
    void disposed.then(finished);
    await vi.advanceTimersByTimeAsync(100);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(finished).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(25);
    await disposed;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cancels a late child even after its job became terminal', async () => {
    vi.useFakeTimers();
    const manager = new JobManager();
    const job = manager.createJob({ repoPath: '/repo' });
    const disposed = manager.dispose();
    const child = childProcess();
    const cleanup = vi.fn();
    manager.registerChild(job.id, child, { onTerminalExit: cleanup });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(25);
    expect(cleanup).not.toHaveBeenCalled();
    child.emit('exit', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(25);
    await disposed;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects an unconfirmed drain without invoking terminal cleanup or dropping tracking', async () => {
    vi.useFakeTimers();
    const manager = new JobManager();
    const job = manager.createJob({ repoPath: '/repo' });
    const child = childProcess();
    const cleanup = vi.fn();
    manager.registerChild(job.id, child, { processGroup: true, onTerminalExit: cleanup });
    const disposed = manager.dispose();
    const rejected = expect(disposed).rejects.toThrow('could not confirm cleanup');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(manager.dispose()).toBe(disposed);
    expect(job.progress.phase).toBe('cancelling');
    expect(cleanup).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(25);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('keeps group ownership until descendants stop after the immediate child exits', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();
    const manager = new JobManager();
    const job = manager.createJob({ repoPath: '/repo' });
    const child = childProcess();
    Object.defineProperty(child, 'pid', { value: 424242 });
    let alive = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation((_, signal) => {
      if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    const cleanup = vi.fn();
    manager.registerChild(job.id, child, { processGroup: true, onTerminalExit: cleanup });
    const disposed = manager.dispose();
    child.emit('exit', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kill).toHaveBeenCalledWith(-424242, 'SIGKILL');
    expect(cleanup).not.toHaveBeenCalled();
    expect(job.status).toBe('queued');
    alive = false;
    await vi.advanceTimersByTimeAsync(50);
    await disposed;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(job.status).toBe('failed');
  });

  it('bounds final ledger persistence by the shutdown deadline', async () => {
    vi.useFakeTimers();
    const manager = new JobManager();
    vi.spyOn(manager as any, 'saveLedger').mockReturnValue(new Promise(() => {}));
    const disposed = manager.dispose();
    const rejected = expect(disposed).rejects.toThrow('ledger flush exceeded');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(manager.dispose()).toBe(disposed);
  });
});
