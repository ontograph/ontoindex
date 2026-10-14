import { describe, expect, it, vi } from 'vitest';
import { createIdleTracker, resolveIdleExitMs } from '../../src/mcp/shared/idle-exit.js';

describe('resolveIdleExitMs', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['0', null],
    ['abc', null],
    ['59999', null],
    ['60000', 60000],
    ['86400000', 86400000],
    ['86400001', null],
    ['1.5e5', null],
    [' 120000 ', 120000],
  ])('parses %j as %j', (raw, expected) => {
    expect(resolveIdleExitMs(raw)).toBe(expected);
  });
});

describe('createIdleTracker', () => {
  it('blocks while busy without consuming the one-shot or resetting the idle clock', () => {
    let now = 0;
    let busy = true;
    const onIdle = vi.fn();
    const tracker = createIdleTracker({
      idleMs: 100,
      now: () => now,
      isBusy: () => busy,
      onIdle,
    });

    for (const time of [0, 99, 100, 500, 10_000]) {
      now = time;
      expect(tracker.check()).toBe(false);
      expect(onIdle).not.toHaveBeenCalled();
    }

    busy = false;
    expect(tracker.check()).toBe(true);
    expect(tracker.check()).toBe(false);
    now += 100;
    expect(tracker.check()).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('fires once after the idle interval with no activity', () => {
    let now = 0;
    const onIdle = vi.fn();
    const tracker = createIdleTracker({ idleMs: 100, now: () => now, onIdle });

    now = 99;
    expect(tracker.check()).toBe(false);
    now = 100;
    expect(tracker.check()).toBe(true);
    expect(tracker.check()).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('touch resets the idle clock', () => {
    let now = 0;
    const onIdle = vi.fn();
    const tracker = createIdleTracker({ idleMs: 100, now: () => now, onIdle });

    now = 80;
    tracker.touch();
    now = 179;
    expect(tracker.check()).toBe(false);
    now = 180;
    expect(tracker.check()).toBe(true);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('blocks idle while a request is in flight and restarts from end time', () => {
    let now = 0;
    const onIdle = vi.fn();
    const tracker = createIdleTracker({ idleMs: 100, now: () => now, onIdle });

    now = 90;
    tracker.begin();
    now = 500;
    expect(tracker.check()).toBe(false);
    tracker.end();
    now = 599;
    expect(tracker.check()).toBe(false);
    now = 600;
    expect(tracker.check()).toBe(true);
    expect(tracker.check()).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
