import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDebouncedWatcher } from '../../src/cli/watch.js';

function makeWatchHarness() {
  let onChange: ((eventType: string, filename: string) => void) | undefined;
  const close = vi.fn();
  const watchImpl = vi.fn((_root: string, _options: unknown, listener: typeof onChange) => {
    onChange = listener;
    return { close } as never;
  });
  return {
    emit(filename: string) {
      onChange?.('change', filename);
    },
    close,
    watchImpl,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createDebouncedWatcher', () => {
  it('coalesces ten rapid events into one refresh after the debounce window', async () => {
    vi.useFakeTimers();
    const events = makeWatchHarness();
    const refresh = vi.fn(async () => {});
    const watcher = createDebouncedWatcher({
      root: '/repo',
      debounceMs: 100,
      isLockHeld: () => false,
      refresh,
      watchImpl: events.watchImpl,
    });
    watcher.start();

    for (let i = 0; i < 10; i++) events.emit(`src/file-${i}.ts`);
    await vi.advanceTimersByTimeAsync(99);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('skips and logs a refresh when the lock is held without queuing another', async () => {
    vi.useFakeTimers();
    const events = makeWatchHarness();
    const refresh = vi.fn(async () => {});
    const log = vi.fn();
    const watcher = createDebouncedWatcher({
      root: '/repo',
      debounceMs: 100,
      isLockHeld: () => true,
      refresh,
      log,
      watchImpl: events.watchImpl,
    });
    watcher.start();

    events.emit('src/file.ts');
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);
    expect(refresh).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('lock is held'));
    watcher.stop();
  });

  it.each(['node_modules/pkg/index.ts', 'dist/output.js', '.git/index'])(
    'ignores changes under %s',
    async (filename) => {
      vi.useFakeTimers();
      const events = makeWatchHarness();
      const refresh = vi.fn(async () => {});
      const watcher = createDebouncedWatcher({
        root: '/repo',
        debounceMs: 100,
        isLockHeld: () => false,
        refresh,
        watchImpl: events.watchImpl,
      });
      watcher.start();

      events.emit(filename);
      await vi.advanceTimersByTimeAsync(200);
      expect(refresh).not.toHaveBeenCalled();
      watcher.stop();
    },
  );

  it('logs refresh rejection and continues handling later changes', async () => {
    vi.useFakeTimers();
    const events = makeWatchHarness();
    const refresh = vi.fn().mockRejectedValueOnce(new Error('refresh failed')).mockResolvedValue();
    const log = vi.fn();
    const watcher = createDebouncedWatcher({
      root: '/repo',
      debounceMs: 100,
      isLockHeld: () => false,
      refresh,
      log,
      watchImpl: events.watchImpl,
    });
    watcher.start();

    events.emit('src/first.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(log).toHaveBeenCalledWith('Watcher refresh failed: refresh failed');
    events.emit('src/second.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('coalesces changes during a refresh into one non-overlapping follow-up', async () => {
    vi.useFakeTimers();
    const events = makeWatchHarness();
    let finishFirst!: () => void;
    let active = 0;
    let maxActive = 0;
    const refresh = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (refresh.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
      active--;
    });
    const watcher = createDebouncedWatcher({
      root: '/repo',
      debounceMs: 100,
      isLockHeld: () => false,
      refresh,
      watchImpl: events.watchImpl,
    });
    watcher.start();

    events.emit('src/initial.ts');
    await vi.advanceTimersByTimeAsync(100);
    events.emit('src/change-1.ts');
    events.emit('src/change-2.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);

    finishFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    watcher.stop();
  });

  it('clears a pending debounce timer on stop', async () => {
    vi.useFakeTimers();
    const events = makeWatchHarness();
    const refresh = vi.fn(async () => {});
    const watcher = createDebouncedWatcher({
      root: '/repo',
      debounceMs: 100,
      isLockHeld: () => false,
      refresh,
      watchImpl: events.watchImpl,
    });
    watcher.start();

    events.emit('src/file.ts');
    watcher.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).not.toHaveBeenCalled();
    expect(events.close).toHaveBeenCalledTimes(1);
  });
});
